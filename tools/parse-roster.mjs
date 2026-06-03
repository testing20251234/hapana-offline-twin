#!/usr/bin/env node
// Parse a Hapana check-in CSV → unique individuals (Barcode-keyed) → SQL insert.
// Usage: node parse-roster.mjs <csv> > roster.sql
import fs from 'node:fs';

const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');

// Minimal RFC-4180-ish CSV parser (handles quoted fields w/ commas + quotes).
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCSV(raw);
const header = rows.shift().map(h => h.trim());
const idx = name => header.indexOf(name);
const iBar = idx('Barcode'), iFull = idx('Full Name'), iEmail = idx('Email'),
      iFirst = idx('First Name'), iLast = idx('Last Name'), iPhone = idx('Phone'),
      iDate = idx('Attendance Date');

function parseDate(s) {            // "DD/MM/YYYY HH:MM AM" (SG locale) -> ISO
  if (!s) return null;
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let [, d, mo, y, h, mi, ap] = m; h = +h;
  if (ap) { if (/pm/i.test(ap) && h < 12) h += 12; if (/am/i.test(ap) && h === 12) h = 0; }
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${mi}:00`;
}

const people = new Map();          // barcode -> record
for (const r of rows) {
  const barcode = (r[iBar] || '').trim();
  if (!barcode) continue;
  const full = (r[iFull] || '').trim();
  const email = (r[iEmail] || '').trim();
  if (full === 'Removed Removed' || email.startsWith('removed_client_')) continue; // skip redacted
  const last_seen = parseDate(r[iDate]);
  const rec = people.get(barcode) || {
    barcode, full,
    first: (r[iFirst] || '').trim(), last: (r[iLast] || '').trim(),
    email, phone: (r[iPhone] || '').trim(), last_seen,
  };
  if (last_seen && (!rec.last_seen || last_seen > rec.last_seen)) rec.last_seen = last_seen;
  people.set(barcode, rec);
}

const esc = v => v == null || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
const norm = e => e ? e.trim().toLowerCase() : null;
const digits = p => p ? p.replace(/\D/g, '') : null;

const vals = [...people.values()].map(p =>
  `(${esc(p.barcode)},${esc(p.first)},${esc(p.last)},${esc(p.full)},${esc(p.email)},${esc(norm(p.email))},${esc(p.phone)},${esc(digits(p.phone))},${p.last_seen ? `'${p.last_seen}'` : 'null'})`
);

console.log(`-- ${people.size} unique individuals from ${file.split('/').pop()}`);
console.log(`insert into public.individuals
  (barcode,first_name,last_name,full_name,email,email_norm,phone,phone_norm,last_seen)
values\n${vals.join(',\n')}\non conflict (barcode) do nothing;`);
console.error(`parsed ${rows.length} rows -> ${people.size} unique individuals`);
