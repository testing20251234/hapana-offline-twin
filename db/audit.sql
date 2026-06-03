-- Append-only audit trail (migration: add_audit_log).
-- Written ONLY by SECURITY DEFINER triggers / log_action(); clients never write directly.
-- Active staff may READ it (Log screen). Wiping it is intentionally not exposed.

create table if not exists public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      uuid,                       -- auth.uid(); null = system/SQL
  actor_name text,                       -- snapshot of actor's name (durable)
  action     text not null,              -- event.create|port|verify|unport|update|delete · individual.* · staff.* · import.run
  entity     text,
  entity_id  text,
  detail     jsonb not null default '{}'
);
create index if not exists idx_audit_at on public.audit_log (at desc);
create index if not exists idx_audit_entity on public.audit_log (entity, entity_id);

create or replace function public.actor_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from public.profiles where id = auth.uid()), 'system');
$$;

-- Triggers: audit_events / audit_individuals / audit_profiles fire AFTER I/U/D and write one row each.
--  - events: create / port / verify / unport / update / delete (with from→to + payload + entered_by/ported_by)
--  - individuals: staff_created inserts + every update/delete (bulk checkin imports are NOT row-logged → see import.run)
--  - profiles: signup + role/active/super changes
-- (full bodies applied in migration add_audit_log; see Supabase migration history)

-- app-level actions (import.run) logged through this controlled RPC only
create or replace function public.log_action(p_action text, p_detail jsonb default '{}') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_active_staff() then raise exception 'not authorized'; end if;
  insert into public.audit_log(actor,actor_name,action,entity,entity_id,detail)
  values(auth.uid(),public.actor_name(),p_action,'app',null,coalesce(p_detail,'{}'::jsonb));
end $$;

alter table public.audit_log enable row level security;
create policy p_audit_read on public.audit_log for select using (public.is_active_staff());

revoke execute on function public.actor_name() from public, anon, authenticated;
revoke execute on function public.log_action(text,jsonb) from public, anon;
grant  execute on function public.log_action(text,jsonb) to authenticated;
-- audit_events/_individuals/_profiles likewise revoked from public/anon/authenticated.
