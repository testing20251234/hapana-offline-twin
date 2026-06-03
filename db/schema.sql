-- Offline Hapana Twin — schema + RLS + maker-checker
-- Spec: claude-code-test/project-hapana-offline-twin/bedrock-spec-hapana-offline-twin.md
-- ISOLATED project escyonbsziqcqltceyxr — never touches prod Stripe/attendance DBs.

create extension if not exists pgcrypto with schema extensions;

-- ───────────────────────── profiles (staff) ─────────────────────────
-- New signups land inactive; an admin activates + assigns a role.
-- Inactive profiles see NOTHING (RLS gate), so public signup is safe.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  role       text not null default 'entry' check (role in ('entry','verifier','both')),
  active     boolean not null default false,
  is_super   boolean not null default false,   -- super: may self-verify (bypass maker≠checker)
  created_at timestamptz not null default now()
);

-- ───────────────────────── individuals (roster) ─────────────────────
create table if not exists public.individuals (
  id           uuid primary key default gen_random_uuid(),
  barcode      text unique,                 -- stable Hapana client id; null for staff-created
  first_name   text,
  last_name    text,
  full_name    text,
  email        text,
  email_norm   text,
  phone        text,
  phone_norm   text,
  birthday     date,
  origin       text not null default 'checkin_import' check (origin in ('checkin_import','staff_created')),
  hapana_state text not null default 'in_hapana'      check (hapana_state in ('in_hapana','new_local')),
  last_seen    timestamptz,
  merged_into  uuid references public.individuals(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_individuals_email on public.individuals (email_norm);
create index if not exists idx_individuals_phone on public.individuals (phone_norm);
create index if not exists idx_individuals_name  on public.individuals (lower(full_name));
create index if not exists idx_individuals_state on public.individuals (hapana_state);

-- ───────────────────────── packages (catalogue snapshot) ────────────
create table if not exists public.packages (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  category      text not null default 'SBH' check (category in ('SBH','RLT','HBOT','Promo')),
  standard_cents int,
  member_cents   int,
  active        boolean not null default true,
  sort          int not null default 0
);

-- ───────────────────────── events (write-ahead log) ─────────────────
create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  individual_id uuid not null references public.individuals(id) on delete cascade,
  type          text not null check (type in ('account_create','package_purchase','credit_consume')),
  payload       jsonb not null default '{}',
  entered_by    uuid not null references public.profiles(id),
  entered_at    timestamptz not null default now(),
  -- port state machine: pending -> ported -> verified
  port_status   text not null default 'pending' check (port_status in ('pending','ported','verified')),
  flags         jsonb not null default '{}',   -- per-type checkboxes, e.g. {account_created:true,...}
  ported_by     uuid references public.profiles(id),
  ported_at     timestamptz,
  verified_by   uuid references public.profiles(id),
  verified_at   timestamptz
);
create index if not exists idx_events_status on public.events (port_status);
create index if not exists idx_events_indiv  on public.events (individual_id);

-- ───────────────────────── helper predicates ────────────────────────
create or replace function public.is_active_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_verifier() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and active and role in ('verifier','both'));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and active and role = 'both');
$$;

-- ───────────────────────── auto-profile on signup ───────────────────
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, role, active)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
          'entry', false)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────── maker ≠ checker enforcement ──────────────
create or replace function public.enforce_maker_checker() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text; sup boolean; act boolean;
begin
  if new.port_status = 'verified' and old.port_status is distinct from 'verified' then
    select role, is_super, active into r, sup, act from public.profiles where id = auth.uid();
    if not coalesce(act, false) then
      raise exception 'Only an active staff member can verify';
    end if;
    -- super users may verify anything, including their own work
    if coalesce(sup, false) then
      new.verified_by := auth.uid(); new.verified_at := now();
      return new;
    end if;
    -- everyone else: must be a verifier AND must not be the maker
    if r is null or r not in ('verifier','both') then
      raise exception 'Only an active verifier can verify';
    end if;
    if auth.uid() = new.entered_by or auth.uid() = new.ported_by then
      raise exception 'Maker cannot be checker (you entered or ported this)';
    end if;
    new.verified_by := auth.uid();
    new.verified_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_maker_checker on public.events;
create trigger trg_maker_checker before update on public.events
  for each row execute function public.enforce_maker_checker();

-- trigger functions must never be callable via PostgREST RPC
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.enforce_maker_checker() from public, anon, authenticated;

-- ───────────────────────── RLS ──────────────────────────────────────
alter table public.profiles    enable row level security;
alter table public.individuals enable row level security;
alter table public.packages    enable row level security;
alter table public.events      enable row level security;

-- profiles: a user always sees their own row (to know if active); active staff see all; admin manages.
drop policy if exists p_profiles_self on public.profiles;
create policy p_profiles_self on public.profiles for select using (id = auth.uid() or public.is_active_staff());
drop policy if exists p_profiles_admin_upd on public.profiles;
create policy p_profiles_admin_upd on public.profiles for update using (public.is_admin()) with check (public.is_admin());

-- individuals: active staff full CRUD
drop policy if exists p_individuals_all on public.individuals;
create policy p_individuals_all on public.individuals for all using (public.is_active_staff()) with check (public.is_active_staff());

-- packages: active staff read; admin write
drop policy if exists p_packages_read on public.packages;
create policy p_packages_read on public.packages for select using (public.is_active_staff());
drop policy if exists p_packages_admin on public.packages;
create policy p_packages_admin on public.packages for all using (public.is_admin()) with check (public.is_admin());

-- events: active staff read/insert/update (verify transition further gated by trigger)
drop policy if exists p_events_read on public.events;
create policy p_events_read on public.events for select using (public.is_active_staff());
drop policy if exists p_events_insert on public.events;
create policy p_events_insert on public.events for insert with check (public.is_active_staff() and entered_by = auth.uid());
drop policy if exists p_events_update on public.events;
create policy p_events_update on public.events for update using (public.is_active_staff()) with check (public.is_active_staff());
