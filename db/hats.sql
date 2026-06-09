-- Sauna-hat inventory (migration: add_hat_inventory, 2026-06-09).
-- Append-only stock ledger for sauna hats. ISOLATED twin project escyonbsziqcqltceyxr.
-- Does NOT flow into Hapana; fully separate from the events/port pipeline.
-- Mirror only — DB is source of truth (Supabase migration history).
--
-- Model:
--   kind 'in'  = hats purchased into stock     (unit_price_cents = unit cost)
--   kind 'out' = hat given/sold to a customer  (unit_price_cents = sale price; member_price flag)
--   on hand    = Σ qty(in,active) − Σ qty(out,active)
--   individual_id = optional customer link (reuses the Barcode roster)
--
-- Cancel = staff "removes" a record. It is NEVER deleted/edited:
--   * trg_hat_guard (BEFORE UPDATE): blocks edits to every column except cancel state;
--     stamps cancelled_by/cancelled_at on active→cancelled; clears them on un-cancel.
--   * trg_audit_hat (AFTER I/U/D, SECURITY DEFINER): writes an append-only audit_log row
--     (hat.create | hat.cancel | hat.uncancel | hat.update | hat.delete) with actor + time.
--   * No DELETE policy → rows cannot be removed via the API (append-only at the RLS layer).
--   audit_log read is is_admin() only → who/when cancellation forensics are admin-only,
--   matching the staff-app-vs-admin-backend split the owner asked for.

-- Variants tracked via hat_type (migration: hat_inventory_add_type). Values are app-defined
-- (HAT_TYPES in app.js: burgundy_rose, saddle_brown) — no DB enum, so a new type needs no migration.
-- On-hand is computed PER hat_type.
create table if not exists public.hat_events (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('in','out')),
  hat_type         text,                                          -- variant key, e.g. burgundy_rose
  qty              int  not null default 1 check (qty > 0),
  unit_price_cents int,
  member_price     boolean not null default false,
  payment_method   text,
  individual_id    uuid references public.individuals(id) on delete set null,
  note             text,
  status           text not null default 'active' check (status in ('active','cancelled')),
  entered_by       uuid not null references public.profiles(id),
  entered_at       timestamptz not null default now(),
  cancelled_by     uuid references public.profiles(id),
  cancelled_at     timestamptz,
  cancel_reason    text
);
create index if not exists idx_hat_status on public.hat_events (status);
create index if not exists idx_hat_kind   on public.hat_events (kind);
create index if not exists idx_hat_indiv  on public.hat_events (individual_id);

-- trg_hat_guard (BEFORE UPDATE): immutability + cancel stamping. See migration for body.
-- trg_audit_hat (AFTER I/U/D, SECURITY DEFINER): append-only audit. See migration for body.
-- Both trigger funcs revoked from public/anon/authenticated.

-- RLS: active staff read + insert-own + flip cancel state. No delete policy = append-only.
-- p_hat_read   : select using is_active_staff()
-- p_hat_insert : insert with check is_active_staff() and entered_by = auth.uid()
-- p_hat_update : update using/with check is_active_staff()  (column locks enforced by trg_hat_guard)
