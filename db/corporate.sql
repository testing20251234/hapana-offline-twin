-- Corporate usage (migration: add_corporate_usage, 2026-06-17).
-- Append-only credit ledger for corporate companies. ISOLATED twin project escyonbsziqcqltceyxr.
-- Does NOT flow into Hapana; fully separate from the events/port pipeline.
-- Mirror only — DB is source of truth (Supabase migration history).
--
-- Model:
--   kind 'topup' = admin adds credits to a company pool
--   kind 'usage' = staff deducts 1 credit for a named person + phone
--   balance       = Σ qty(topup,active) − Σ qty(usage,active) per company
--
-- Cancel = admin "removes" a record. It is NEVER deleted/edited:
--   * trg_corporate_guard (BEFORE UPDATE): blocks edits to every column except cancel state;
--     stamps cancelled_by/cancelled_at on active→cancelled; clears them on un-cancel.
--   * trg_audit_corporate (AFTER I/U/D, SECURITY DEFINER): writes an append-only audit_log row
--     (corporate.create | corporate.cancel | corporate.uncancel) with actor + time.
--   * No DELETE policy → rows cannot be removed via the API (append-only at the RLS layer).

create table if not exists public.corporate_companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);
create index if not exists idx_corp_comp_name on public.corporate_companies (name);

create table if not exists public.corporate_transactions (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.corporate_companies(id) on delete restrict,
  kind           text not null check (kind in ('topup','usage')),
  qty            int  not null default 1 check (qty > 0),
  person_name    text,                                          -- for usage: who used the credit
  person_phone   text,                                          -- for usage: their phone number
  note           text,
  status         text not null default 'active' check (status in ('active','cancelled')),
  entered_by     uuid not null references public.profiles(id),
  entered_at     timestamptz not null default now(),
  cancelled_by   uuid references public.profiles(id),
  cancelled_at   timestamptz,
  cancel_reason  text
);
create index if not exists idx_corp_tx_company on public.corporate_transactions (company_id);
create index if not exists idx_corp_tx_status  on public.corporate_transactions (status);
create index if not exists idx_corp_tx_kind    on public.corporate_transactions (kind);

-- trg_corporate_guard (BEFORE UPDATE): immutability + cancel stamping. See migration for body.
-- trg_audit_corporate (AFTER I/U/D, SECURITY DEFINER): append-only audit. See migration for body.
-- Both trigger funcs revoked from public/anon/authenticated.

-- RLS: active staff read all companies + insert usage. Admin-only for topup, create company, cancel.
-- p_corp_company_read   : select using is_active_staff()
-- p_corp_company_insert : insert with check is_admin()
-- p_corp_tx_read        : select using is_active_staff()
-- p_corp_tx_insert      : insert with check (is_active_staff() and (kind = 'usage' or is_admin())) and entered_by = auth.uid()
-- p_corp_tx_update      : update using/with check is_admin()  (column locks enforced by trg_corporate_guard)
