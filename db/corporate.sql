-- Corporate usage — LOCAL credit-pool domain for the offline twin.
-- Migration: add_corporate_usage (version 20260617151032). ISOLATED project escyonbsziqcqltceyxr.
-- Does NOT flow into Hapana; fully separate from the events/port pipeline (same pattern as hats).
--
-- NOTE: unlike the other db/*.sql mirrors, this file carries the FULL trigger/function/policy
-- bodies on purpose — the append-only + audit logic must be reconstructable from the repo, not
-- only from the live DB. This file is the canonical source; keep it == the migration.
--
-- Model:
--   kind 'topup' = admin adds credits to a company pool
--   kind 'usage' = staff deducts 1 credit for a named person + phone
--   balance       = Σ qty(topup,active) − Σ qty(usage,active) per company  (computed; never stored)
--
-- Append-only: rows are NEVER deleted/edited. Cancel = admin flips status (kept in the log).
--   * trg_corporate_guard (BEFORE UPDATE): blocks edits to EVERY business column; only the cancel
--     state (status + cancelled_by/at) may change; stamps/clears the cancel fields.
--   * trg_audit_corporate (AFTER I/U, SECURITY DEFINER): appends corporate.create|cancel|uncancel
--     to the admin-only audit_log (uses audit_log.actor uuid).
--   * No DELETE policy → rows cannot be removed via the API.
--   Both trigger funcs are SECURITY DEFINER with a fixed search_path and EXECUTE revoked from
--   public/anon/authenticated.

create table if not exists public.corporate_companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);
create index if not exists idx_corp_comp_name on public.corporate_companies (name);

create table if not exists public.corporate_transactions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.corporate_companies(id) on delete restrict,
  kind          text not null check (kind in ('topup','usage')),
  qty           int  not null default 1 check (qty > 0),
  person_name   text,                                          -- usage: who used the credit
  person_phone  text,                                          -- usage: their phone number
  note          text,
  status        text not null default 'active' check (status in ('active','cancelled')),
  entered_by    uuid not null references public.profiles(id),
  entered_at    timestamptz not null default now(),
  cancelled_by  uuid references public.profiles(id),
  cancelled_at  timestamptz,
  cancel_reason text
);
create index if not exists idx_corp_tx_company on public.corporate_transactions (company_id);
create index if not exists idx_corp_tx_status  on public.corporate_transactions (status);
create index if not exists idx_corp_tx_kind    on public.corporate_transactions (kind);

create or replace function public.trg_corporate_guard_fn()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if (new.company_id, new.kind, new.qty, new.person_name, new.person_phone, new.note,
        new.entered_by, new.entered_at)
       is distinct from
       (old.company_id, old.kind, old.qty, old.person_name, old.person_phone, old.note,
        old.entered_by, old.entered_at) then
      raise exception 'corporate_transactions are append-only — only cancel/uncancel allowed';
    end if;
    if old.status = 'active' and new.status = 'cancelled' then
      new.cancelled_by = auth.uid(); new.cancelled_at = now(); return new;
    elsif old.status = 'cancelled' and new.status = 'active' then
      new.cancelled_by = null; new.cancelled_at = null; return new;
    elsif old.status = new.status then
      return new;  -- true no-op (no business columns changed)
    end if;
    raise exception 'corporate_transactions are append-only — only cancel/uncancel allowed';
  end if;
  return new;
end;
$$;

create or replace function public.trg_audit_corporate_fn()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_detail jsonb;
  v_company_name text;
begin
  select name into v_company_name from public.corporate_companies
    where id = coalesce(new.company_id, old.company_id);
  if tg_op = 'INSERT' then
    v_action = 'corporate.create';
    v_detail = jsonb_build_object('company_name', v_company_name, 'kind', new.kind, 'qty', new.qty,
      'person_name', new.person_name, 'person_phone', new.person_phone, 'note', new.note);
  elsif tg_op = 'UPDATE' then
    if old.status = 'active' and new.status = 'cancelled' then v_action = 'corporate.cancel';
    elsif old.status = 'cancelled' and new.status = 'active' then v_action = 'corporate.uncancel';
    else return new; end if;
    v_detail = jsonb_build_object('company_name', v_company_name, 'kind', new.kind, 'qty', new.qty,
      'person_name', new.person_name, 'person_phone', new.person_phone, 'note', new.note, 'status', new.status);
  end if;
  insert into public.audit_log (actor, actor_name, action, detail, at)
  values (auth.uid(), (select name from public.profiles where id = auth.uid()), v_action, v_detail, now());
  return new;
end;
$$;

revoke all on function public.trg_corporate_guard_fn() from public, anon, authenticated;
revoke all on function public.trg_audit_corporate_fn() from public, anon, authenticated;

drop trigger if exists trg_corporate_guard on public.corporate_transactions;
create trigger trg_corporate_guard before update on public.corporate_transactions
  for each row execute function public.trg_corporate_guard_fn();

drop trigger if exists trg_audit_corporate on public.corporate_transactions;
create trigger trg_audit_corporate after insert or update on public.corporate_transactions
  for each row execute function public.trg_audit_corporate_fn();

alter table public.corporate_companies    enable row level security;
alter table public.corporate_transactions enable row level security;

-- active staff read all + insert usage; admin-only for topup, create company, cancel.
drop policy if exists p_corp_company_read   on public.corporate_companies;
create policy p_corp_company_read   on public.corporate_companies for select using (is_active_staff());
drop policy if exists p_corp_company_insert on public.corporate_companies;
create policy p_corp_company_insert on public.corporate_companies for insert with check (is_admin());

drop policy if exists p_corp_tx_read   on public.corporate_transactions;
create policy p_corp_tx_read   on public.corporate_transactions for select using (is_active_staff());
drop policy if exists p_corp_tx_insert on public.corporate_transactions;
create policy p_corp_tx_insert on public.corporate_transactions for insert
  with check (is_active_staff() and (kind = 'usage' or is_admin()) and entered_by = auth.uid());
drop policy if exists p_corp_tx_update on public.corporate_transactions;
create policy p_corp_tx_update on public.corporate_transactions for update using (is_admin()) with check (is_admin());
