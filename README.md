# Offline Hapana Twin

A parallel web app for Sauna Bath House staff to **capture customer events** (check-ins/credits,
package sales, new accounts) during downtime, then **port them into Hapana** through a maker-checker
worklist. Hapana stays the system of record; this is a fast capture + reconciliation layer.

Design spec lives in the private ops repo: `project-hapana-offline-twin/bedrock-spec-hapana-offline-twin.md`.

## Stack
- **Frontend**: single static `index.html` + `app.js` (vanilla JS, Supabase JS via CDN). No build step.
- **Backend**: Supabase (Postgres + Auth + RLS). Project `escyonbsziqcqltceyxr` (isolated — not the prod Stripe/attendance DBs).
- **Host**: GitHub Pages.

## How it works
1. **Daily import** (~21:10) — upload the full Hapana check-in CSV. Folds rows into a roster of
   `individuals`, keyed on the **Barcode** (the stable Hapana client id). Only-add-new; redacted rows skipped.
2. **Capture** (3 screens) — Check-in/use-credit (peak/off-peak = 1 credit), New customer, Add package.
   Each writes an `event` (a write-ahead log). Trust-only: no balance enforcement.
3. **Port worklist** (maker) — every unverified event, grouped by member, with the exact payload to
   re-enter in Hapana + checkboxes. All boxes ticked → `ported`.
4. **Verification** (checker) — a *different* staffer confirms each ported event → `verified`.
   Maker ≠ checker is enforced in the database.

## Roles
Supabase Auth (email/password). New signups are **inactive** until an admin activates them — so the
public URL is safe (inactive accounts see no data via RLS). Roles: `entry`, `verifier`, `both`.

## Local dev
Open `index.html` directly, or `python3 -m http.server`. Config (URL + publishable key) is inline in `index.html`.

## DB
- `db/schema.sql` — tables, RLS, maker-checker trigger.
- `db/seed_packages.sql` — catalogue snapshot of bedrock pricing (re-sync on price change).
- `tools/parse-roster.mjs` — CSV → roster SQL (offline backfill; output is gitignored — contains PII).

> Admin credentials are shared out-of-band, never committed.
