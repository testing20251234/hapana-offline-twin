/* Offline Hapana Twin — front-end logic.
   Spec: claude-code-test/project-hapana-offline-twin/bedrock-spec-hapana-offline-twin.md */
const sb = window.supabase.createClient(window.SUPA_URL, window.SUPA_KEY);
const state = { user: null, profile: null, packages: [], profilesMap: {} };
// Sauna hat — EXPERIMENTAL retail price (project-pricing/experimental-pricing.md, 2026-06-09). Editable per sale.
const HAT_STD_CENTS = 4500, HAT_MEM_CENTS = 3900;
// Hat variants. Add a row here (+ deploy) to introduce a new type.
const HAT_TYPES = [
  { key: 'burgundy_rose', label: 'Burgundy Rose' },
  { key: 'saddle_brown', label: 'Saddle Brown' },
];
const hatTypeLabel = k => (HAT_TYPES.find(t => t.key === k) || {}).label || k || '—';

/* ───────── helpers ───────── */
const $ = s => document.querySelector(s);
const fmt = c => '$' + ((c || 0) / 100).toFixed(2);
const digits = p => (p || '').replace(/\D/g, '') || null;
const norm = e => e ? e.trim().toLowerCase() : null;
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
function toast(msg, kind) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + (kind || '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.className = 'toast', 2600);
}
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

/* ───────── auth / boot ───────── */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await onAuthed(session.user); else showLogin();
}
sb.auth.onAuthStateChange((_e, session) => {
  if (session && (!state.user || state.user.id !== session.user.id)) onAuthed(session.user);
  if (!session && state.user) { state.user = null; showLogin(); }
});

function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }

async function onAuthed(user) {
  state.user = user;
  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  state.profile = profile;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#whoName').textContent = profile?.name || user.email;
  $('#whoRole').textContent = profile?.active ? profile.role : 'pending';

  if (!profile || !profile.active) {           // inactive: see nothing
    $('#nav').innerHTML = ''; $('#pendingBanner').classList.remove('hidden');
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    return;
  }
  $('#pendingBanner').classList.add('hidden');
  await loadProfilesMap();
  await loadPackages();
  renderNav(profile.role);
  navTo('checkin');
}

$('#liBtn').onclick = async () => {
  const email = $('#liEmail').value.trim(), pass = $('#liPass').value;
  const signup = $('#liBtn').dataset.mode === 'signup';
  $('#liMsg').textContent = ''; $('#liMsg').style.color = 'var(--muted)';
  if (!email || !pass) { $('#liMsg').textContent = 'Email and password required.'; return; }
  if (signup) {
    const name = $('#liNameInput').value.trim() || email.split('@')[0];
    const { error } = await sb.auth.signUp({ email, password: pass, options: { data: { name } } });
    if (error) { $('#liMsg').style.color = 'var(--bad)'; $('#liMsg').textContent = error.message; return; }
    $('#liMsg').style.color = 'var(--ok)';
    $('#liMsg').textContent = 'Account created. An admin must activate you (and confirm email if prompted).';
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) { $('#liMsg').style.color = 'var(--bad)'; $('#liMsg').textContent = error.message; }
  }
};
$('#liToggle').onclick = e => {
  e.preventDefault();
  const signup = $('#liBtn').dataset.mode !== 'signup';
  $('#liBtn').dataset.mode = signup ? 'signup' : '';
  $('#liBtn').textContent = signup ? 'Create account' : 'Sign in';
  $('#liName').classList.toggle('hidden', !signup);
  $('#liToggleTxt').textContent = signup ? 'Already have an account?' : 'New staff?';
  $('#liToggle').textContent = signup ? 'Sign in' : 'Create an account';
};
$('#logoutBtn').onclick = () => sb.auth.signOut();

async function loadProfilesMap() {
  const { data } = await sb.from('profiles').select('id,name,role');
  state.profilesMap = {}; (data || []).forEach(p => state.profilesMap[p.id] = p);
}
async function loadPackages() {
  const { data } = await sb.from('packages').select('*').eq('active', true).order('sort');
  state.packages = data || []; fillPackageSelect();
}

/* ───────── nav ───────── */
const SCREENS = [
  { id: 'checkin', label: 'Check-in' },
  { id: 'newcustomer', label: 'New customer' },
  { id: 'package', label: 'Add package' },
  { id: 'hats', label: 'Hats' },
  { id: 'import', label: 'Import' },
  { id: 'worklist', label: 'Worklist' },
  { id: 'verify', label: 'Verify', need: r => r === 'verifier' || r === 'both' },
  { id: 'staff', label: 'Staff', need: r => r === 'both' },
  { id: 'log', label: 'Log', need: r => r === 'both' },
];
function renderNav(role) {
  $('#nav').innerHTML = '';
  const canSee = s => !s.need || s.need(role) || (s.id === 'verify' && state.profile.is_super);
  SCREENS.filter(canSee).forEach(s => {
    const b = document.createElement('button');
    b.textContent = s.label; b.dataset.screen = s.id; b.onclick = () => navTo(s.id);
    $('#nav').appendChild(b);
  });
}
function navTo(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  $('#screen-' + id)?.classList.remove('hidden');
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.screen === id));
  if (id === 'hats') loadHats();
  if (id === 'worklist') loadWorklist();
  if (id === 'verify') loadVerify();
  if (id === 'staff') loadStaff();
  if (id === 'log') loadAuditLog();
}

/* ───────── search widget ───────── */
async function searchIndividuals(q) {
  q = q.replace(/[,%()]/g, ' ').trim();
  if (q.length < 2) return [];
  const { data, error } = await sb.from('individuals')
    .select('id,full_name,first_name,last_name,email,phone,barcode,hapana_state,birthday')
    .or(`full_name.ilike.%${q}%,email_norm.ilike.%${q}%,phone_norm.ilike.%${q}%`)
    .is('merged_into', null).limit(8);
  if (error) { toast(error.message, 'err'); return []; }
  return data || [];
}
function wireSearch(inputSel, resultsSel, onPick, emptyHtml) {
  const input = $(inputSel), box = $(resultsSel);
  const run = debounce(async () => {
    const rows = await searchIndividuals(input.value);
    if (!input.value.trim()) { box.innerHTML = ''; return; }
    if (!rows.length) { box.innerHTML = emptyHtml ? emptyHtml(input.value) : '<div class="results"><div class="item muted">No match.</div></div>'; wireEmpty(box); return; }
    box.innerHTML = '<div class="results">' + rows.map((r, i) =>
      `<div class="item" data-i="${i}"><span>${esc(r.full_name || (r.first_name + ' ' + r.last_name))}
        ${r.hapana_state === 'new_local' ? '<span class="pill new">new</span>' : ''}</span>
       <span class="muted small">${esc(r.phone || r.email || r.barcode || '')}</span></div>`).join('') + '</div>';
    box.querySelectorAll('.item').forEach(el => el.onclick = () => { onPick(rows[+el.dataset.i]); box.innerHTML = ''; });
  }, 220);
  input.oninput = run;
}
function wireEmpty(box) {
  const a = box.querySelector('[data-newcust]');
  if (a) a.onclick = e => { e.preventDefault(); const nm = a.dataset.newcust.split(' '); navTo('newcustomer'); $('#ncFirst').value = nm[0] || ''; $('#ncLast').value = nm.slice(1).join(' '); };
}
const newCustEmpty = q => `<div class="results"><div class="item">No match. <a href="#" data-newcust="${esc(q)}">Create “${esc(q)}” as new customer →</a></div></div>`;

/* ───────── events insert ───────── */
async function insertEvent(type, individual_id, payload) {
  const { error } = await sb.from('events').insert({ type, individual_id, payload, entered_by: state.user.id });
  if (error) { toast(error.message, 'err'); return false; }
  return true;
}

/* ───────── check-in / use credit ───────── */
wireSearch('#ciSearch', '#ciResults', person => renderCheckinSelected(person), newCustEmpty);
function renderCheckinSelected(p) {
  $('#ciSearch').value = '';
  $('#ciSelected').innerHTML = `<div class="selbox">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><b>${esc(p.full_name)}</b> ${p.hapana_state === 'new_local' ? '<span class="pill new">new local</span>' : ''}
        <div class="muted small">${esc(p.phone || '')} ${esc(p.email || '')}</div></div>
      <button class="ghost sm" id="ciClear">clear</button>
    </div>
    <div class="row" style="margin-top:.8rem">
      <button class="big-btn" data-ct="peak">Peak — use 1 credit</button>
      <button class="big-btn ghost" data-ct="offpeak">Off-Peak — use 1 credit</button>
    </div></div>`;
  $('#ciClear').onclick = () => $('#ciSelected').innerHTML = '';
  $('#ciSelected').querySelectorAll('[data-ct]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const ok = await insertEvent('credit_consume', p.id, { credit_type: b.dataset.ct, qty: 1 });
    if (ok) { toast(`Checked in — 1 ${b.dataset.ct} credit logged`, 'ok'); $('#ciSelected').innerHTML = ''; }
    else b.disabled = false;
  });
}

/* ───────── new customer ───────── */
$('#ncSave').onclick = async () => {
  const first = $('#ncFirst').value.trim(), last = $('#ncLast').value.trim();
  if (!first && !last) { toast('Enter a name', 'err'); return; }
  const email = $('#ncEmail').value.trim(), phone = $('#ncPhone').value.trim(), bday = $('#ncBday').value || null;
  const full = (first + ' ' + last).trim();
  const { data, error } = await sb.from('individuals').insert({
    first_name: first, last_name: last, full_name: full, email, email_norm: norm(email),
    phone, phone_norm: digits(phone), birthday: bday, origin: 'staff_created', hapana_state: 'new_local'
  }).select('id').single();
  if (error) { toast(error.message, 'err'); return; }
  await insertEvent('account_create', data.id, { first_name: first, last_name: last, phone, email, birthday: bday });
  toast('Customer created → added to worklist', 'ok');
  ['#ncFirst', '#ncLast', '#ncPhone', '#ncEmail', '#ncBday'].forEach(s => $(s).value = '');
};

/* ───────── add package ───────── */
function fillPackageSelect() {
  const sel = $('#pkSelect'); if (!sel) return;
  const cats = [...new Set(state.packages.map(p => p.category))];
  sel.innerHTML = '<option value="">— choose —</option>' + cats.map(c =>
    `<optgroup label="${c}">` + state.packages.filter(p => p.category === c).map(p =>
      `<option value="${p.id}">${esc(p.name)} · ${fmt(p.standard_cents)}</option>`).join('') + '</optgroup>'
  ).join('') + '<option value="custom">— Custom / other —</option>';
}
let pkPerson = null, pkCustomName = null;
wireSearch('#pkSearch', '#pkResults', person => {
  pkPerson = person; $('#pkSearch').value = '';
  $('#pkSelected').classList.remove('hidden');
  $('#pkSelCard').innerHTML = `<b>${esc(person.full_name)}</b> ${person.hapana_state === 'new_local' ? '<span class="pill new">new local</span>' : ''}
    <div class="muted small">${esc(person.phone || '')} ${esc(person.email || '')}</div>`;
}, newCustEmpty);

function currentPkOption() { const o = $('#pkSelect').selectedOptions[0]; return o; }
function recalcPrice() {
  const v = $('#pkSelect').value;
  if ($('#pkFree').checked) { $('#pkPrice').value = '0.00'; $('#pkPrice').disabled = true; $('#pkMethod').disabled = true; $('#pkMember').disabled = true; return; }
  $('#pkPrice').disabled = false; $('#pkMethod').disabled = false; $('#pkMember').disabled = false;
  if (v === 'custom') { ensureCustomName(true); return; }
  ensureCustomName(false);
  const p = state.packages.find(x => x.id === v); if (!p) { $('#pkPrice').value = ''; return; }
  const cents = ($('#pkMember').checked && p.member_cents) ? p.member_cents : p.standard_cents;
  $('#pkPrice').value = (cents / 100).toFixed(2);
}
function ensureCustomName(show) {
  let inp = $('#pkCustomName');
  if (show && !inp) {
    inp = document.createElement('input'); inp.id = 'pkCustomName'; inp.placeholder = 'Custom package name';
    inp.style.marginTop = '.6rem'; $('#pkSelect').after(inp);
  }
  if (inp) inp.classList.toggle('hidden', !show);
}
$('#pkSelect').onchange = recalcPrice;
$('#pkMember').onchange = recalcPrice;
$('#pkFree').onchange = recalcPrice;
$('#pkSave').onclick = async () => {
  if (!pkPerson) { toast('Pick a member', 'err'); return; }
  const v = $('#pkSelect').value;
  let name = '';
  if (v === 'custom') name = ($('#pkCustomName')?.value || '').trim();
  else { const p = state.packages.find(x => x.id === v); name = p?.name || ''; }
  if (!name) { toast('Choose or name a package', 'err'); return; }
  const free = $('#pkFree').checked;
  const price_cents = free ? 0 : Math.round(parseFloat($('#pkPrice').value || '0') * 100);
  const payload = { name, price_cents, free, payment_method: free ? 'comp' : $('#pkMethod').value };
  const ok = await insertEvent('package_purchase', pkPerson.id, payload);
  if (ok) {
    toast('Package added → worklist', 'ok');
    pkPerson = null; $('#pkSelected').classList.add('hidden');
    $('#pkSelect').value = ''; $('#pkPrice').value = ''; $('#pkFree').checked = false; $('#pkMember').checked = false;
  }
};

/* ───────── sauna hats (local inventory — never ports to Hapana) ───────── */
function fillHatTypes() {
  const opts = HAT_TYPES.map(t => `<option value="${t.key}">${esc(t.label)}</option>`).join('');
  ['#hiType', '#hoType'].forEach(s => { const el = $(s); if (el) el.innerHTML = opts; });
}
fillHatTypes();
let hoPerson = null;
wireSearch('#hoSearch', '#hoResults', person => {
  hoPerson = person; $('#hoSearch').value = '';
  $('#hoSelected').innerHTML = `<div class="selbox" style="display:flex;justify-content:space-between;align-items:center">
    <div><b>${esc(person.full_name)}</b> ${person.hapana_state === 'new_local' ? '<span class="pill new">new local</span>' : ''}
      <div class="muted small">${esc(person.phone || '')} ${esc(person.email || '')}</div></div>
    <button class="ghost sm" id="hoClear">clear</button></div>`;
  $('#hoClear').onclick = () => { hoPerson = null; $('#hoSelected').innerHTML = ''; };
});
function hatRecalc() {
  if ($('#hoFree').checked) { $('#hoPrice').value = '0.00'; $('#hoPrice').disabled = true; $('#hoMethod').disabled = true; $('#hoMember').disabled = true; return; }
  $('#hoPrice').disabled = false; $('#hoMethod').disabled = false; $('#hoMember').disabled = false;
  $('#hoPrice').value = (($('#hoMember').checked ? HAT_MEM_CENTS : HAT_STD_CENTS) / 100).toFixed(2);
}
async function insertHat(row) {
  const { error } = await sb.from('hat_events').insert({ ...row, entered_by: state.user.id });
  if (error) { toast(error.message, 'err'); return false; }
  return true;
}
$('#hiSave').onclick = async () => {
  const qty = parseInt($('#hiQty').value || '1', 10);
  if (!(qty > 0)) { toast('Qty must be ≥ 1', 'err'); return; }
  const cost = $('#hiCost').value ? Math.round(parseFloat($('#hiCost').value) * 100) : null;
  const ok = await insertHat({ kind: 'in', hat_type: $('#hiType').value, qty, unit_price_cents: cost, note: $('#hiNote').value.trim() || null });
  if (ok) { toast(`Added ${qty} hat(s) to stock`, 'ok'); $('#hiQty').value = '1'; $('#hiCost').value = ''; $('#hiNote').value = ''; loadHats(); }
};
$('#hoSave').onclick = async () => {
  const qty = parseInt($('#hoQty').value || '1', 10);
  if (!(qty > 0)) { toast('Qty must be ≥ 1', 'err'); return; }
  const free = $('#hoFree').checked;
  const ok = await insertHat({
    kind: 'out', hat_type: $('#hoType').value, qty,
    unit_price_cents: free ? 0 : Math.round(parseFloat($('#hoPrice').value || '0') * 100),
    member_price: $('#hoMember').checked && !free,
    payment_method: free ? 'comp' : $('#hoMethod').value,
    individual_id: hoPerson ? hoPerson.id : null
  });
  if (ok) {
    toast(`Logged ${qty} hat(s) out`, 'ok');
    hoPerson = null; $('#hoSelected').innerHTML = '';
    $('#hoQty').value = '1'; $('#hoMember').checked = false; $('#hoFree').checked = false; hatRecalc();
    loadHats();
  }
};
$('#hoMember').onchange = hatRecalc;
$('#hoFree').onchange = hatRecalc;
$('#hatRefresh').onclick = e => { e.preventDefault(); loadHats(); };
async function setHatStatus(id, status) {
  const { error } = await sb.from('hat_events').update({ status }).eq('id', id);
  if (error) { toast(error.message, 'err'); return; }
  toast(status === 'cancelled' ? 'Record cancelled' : 'Record restored', 'ok');
  loadHats();
}
async function loadHats() {
  hatRecalc();
  const isAdmin = state.profile.role === 'both' || state.profile.is_super;
  $('#hatInCard')?.classList.toggle('hidden', !isAdmin);   // stock-in is admin-only (RLS-enforced too)
  const { data, error } = await sb.from('hat_events').select('*, individuals(full_name)').order('entered_at', { ascending: false }).limit(200);
  const body = $('#hatBody');
  if (error) { body.innerHTML = `<div class="card" style="color:var(--bad)">${esc(error.message)}</div>`; return; }
  // per-type on-hand (active rows only); include any legacy type not in HAT_TYPES
  const tot = {}; HAT_TYPES.forEach(t => tot[t.key] = { in: 0, out: 0 });
  data.forEach(r => { if (r.status === 'active') { (tot[r.hat_type] ||= { in: 0, out: 0 })[r.kind === 'in' ? 'in' : 'out'] += r.qty; } });
  let totalOnHand = 0;
  const cells = Object.keys(tot).map(k => { const oh = tot[k].in - tot[k].out; totalOnHand += oh; return `<div><b>${oh}</b><span class="muted small">${esc(hatTypeLabel(k))}</span></div>`; });
  $('#hatStat').innerHTML = `<div><b>${totalOnHand}</b><span class="muted small">total in stock</span></div>` + cells.join('');
  if (!data.length) { body.innerHTML = '<div class="card muted">No hat records yet. Add stock or log a hat out above.</div>'; return; }
  body.innerHTML = '<div class="card" style="padding:0;overflow-x:auto"><table><tr><th>When</th><th>Move</th><th>Type</th><th>Qty</th><th>Price</th><th>Customer</th><th>By</th><th></th></tr>' +
    data.map(r => {
      const cancelled = r.status === 'cancelled';
      const by = state.profilesMap[r.entered_by]?.name || '';
      const cust = r.individuals?.full_name ? esc(r.individuals.full_name) : '<span class="muted">—</span>';
      const kindPill = r.kind === 'in' ? '<span class="pill ok">＋ stock in</span>' : '<span class="pill">－ to customer</span>';
      const price = r.kind === 'in'
        ? (r.unit_price_cents != null ? `${fmt(r.unit_price_cents)} cost` : '<span class="muted">—</span>')
        : (r.payment_method === 'comp' ? 'FREE' : `${fmt(r.unit_price_cents)}${r.member_price ? ' <span class="muted small">mbr</span>' : ''}`);
      const cancelInfo = (cancelled && isAdmin)
        ? `<div class="muted small">cancelled by ${esc(state.profilesMap[r.cancelled_by]?.name || '—')}${r.cancelled_at ? ' · ' + new Date(r.cancelled_at).toLocaleString() : ''}</div>`
        : '';
      const canCancel = isAdmin || r.kind === 'out';   // staff cancel only sales; stock-in is admin-only
      const btn = !canCancel ? ''
        : cancelled
          ? `<button class="sm ghost" data-uncancel="${r.id}">un-cancel</button>`
          : `<button class="sm ghost" data-cancel="${r.id}">cancel</button>`;
      return `<tr style="${cancelled ? 'opacity:.5' : ''}">
        <td class="small muted" style="white-space:nowrap">${esc(new Date(r.entered_at).toLocaleString())}</td>
        <td>${kindPill}${cancelled ? ' <span class="pill new">cancelled</span>' : ''}${cancelInfo}</td>
        <td class="small">${esc(hatTypeLabel(r.hat_type))}</td>
        <td>${r.qty}</td><td class="small">${price}</td><td class="small">${cust}</td>
        <td class="small">${esc(by)}</td><td>${btn}</td></tr>`;
    }).join('') + '</table></div>';
  body.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { if (confirm('Cancel this hat record? It stays in the log (append-only); admins see who cancelled it.')) setHatStatus(b.dataset.cancel, 'cancelled'); });
  body.querySelectorAll('[data-uncancel]').forEach(b => b.onclick = () => setHatStatus(b.dataset.uncancel, 'active'));
}

/* ───────── import ───────── */
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function parseDate(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null; let [, d, mo, y, h, mi, ap] = m; h = +h;
  if (ap) { if (/pm/i.test(ap) && h < 12) h += 12; if (/am/i.test(ap) && h === 12) h = 0; }
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${mi}:00`;
}
$('#impFile').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  $('#impResult').innerHTML = '<span class="muted">Parsing…</span>';
  const text = await file.text();
  const rows = parseCSV(text); const header = rows.shift().map(h => h.trim());
  const ix = n => header.indexOf(n);
  const iBar = ix('Barcode'), iFull = ix('Full Name'), iEmail = ix('Email'),
    iFirst = ix('First Name'), iLast = ix('Last Name'), iPhone = ix('Phone'), iDate = ix('Attendance Date');
  if (iBar < 0) { $('#impResult').innerHTML = '<span style="color:var(--bad)">No “Barcode” column — is this a Hapana check-in export?</span>'; return; }
  const map = new Map(); let redacted = 0;
  for (const r of rows) {
    const barcode = (r[iBar] || '').trim(); if (!barcode) continue;
    const full = (r[iFull] || '').trim(), email = (r[iEmail] || '').trim();
    if (full === 'Removed Removed' || email.startsWith('removed_client_')) { redacted++; continue; }
    const ls = parseDate(r[iDate]);
    const rec = map.get(barcode) || { barcode, first_name: (r[iFirst] || '').trim(), last_name: (r[iLast] || '').trim(), full_name: full, email, email_norm: norm(email), phone: (r[iPhone] || '').trim(), phone_norm: digits(r[iPhone]), last_seen: ls, origin: 'checkin_import', hapana_state: 'in_hapana' };
    if (ls && (!rec.last_seen || ls > rec.last_seen)) rec.last_seen = ls;
    map.set(barcode, rec);
  }
  const unique = [...map.values()];
  const { count: before } = await sb.from('individuals').select('*', { count: 'exact', head: true });
  for (let i = 0; i < unique.length; i += 500) {
    const { error } = await sb.from('individuals').upsert(unique.slice(i, i + 500), { onConflict: 'barcode', ignoreDuplicates: true });
    if (error) { $('#impResult').innerHTML = `<span style="color:var(--bad)">${esc(error.message)}</span>`; return; }
  }
  const { count: after } = await sb.from('individuals').select('*', { count: 'exact', head: true });
  $('#impResult').innerHTML = `<div class="stat">
    <div><b>${rows.length}</b><span class="muted small">rows read</span></div>
    <div><b>${unique.length}</b><span class="muted small">unique members</span></div>
    <div><b>${after - before}</b><span class="muted small">newly added</span></div>
    <div><b>${redacted}</b><span class="muted small">redacted skipped</span></div></div>
    <p class="muted small">Existing members untouched. Roster now ${after}.</p>`;
  await sb.rpc('log_action', { p_action: 'import.run', p_detail: { rows: rows.length, unique: unique.length, added: after - before, redacted } });
  toast(`Import done — ${after - before} new`, 'ok');
  e.target.value = '';
};

/* ───────── worklist (maker) ───────── */
function requiredFlags(ev) {
  if (ev.type === 'account_create') return ['account_created'];
  if (ev.type === 'credit_consume') return ['credit_deducted'];
  if (ev.type === 'package_purchase') return ev.payload?.free ? ['package_done'] : ['package_done', 'payment_captured'];
  return [];
}
const FLAG_LABEL = { account_created: 'Account created in Hapana', package_done: 'Package assigned', payment_captured: 'Payment captured', credit_deducted: 'Credit deducted' };

async function loadWorklist() {
  const { data, error } = await sb.from('events').select('*, individuals(*)').eq('port_status', 'pending').order('entered_at');
  const body = $('#wlBody');
  if (error) { body.innerHTML = `<div class="card" style="color:var(--bad)">${esc(error.message)}</div>`; return; }
  const { count: portedCount } = await sb.from('events').select('*', { count: 'exact', head: true }).eq('port_status', 'ported');
  $('#wlToVerify').textContent = `awaiting verification (${portedCount || 0}) →`;
  if (!data.length) { body.innerHTML = '<div class="card muted">Nothing pending. 🎉 New captures show up here.</div>'; }
  else {
    const groups = {};
    data.forEach(ev => { (groups[ev.individual_id] ||= { ind: ev.individuals, evs: [] }).evs.push(ev); });
    body.innerHTML = Object.values(groups).map(renderWlGroup).join('');
    body.querySelectorAll('[data-ev]').forEach(cb => cb.onchange = () => toggleFlag(cb.dataset.ev, cb.dataset.flag, cb.checked));
  }
  $('#wlToVerify').onclick = e => { e.preventDefault(); navTo('verify'); };
}
function renderWlGroup(g) {
  const ind = g.ind; const isNew = ind.hapana_state === 'new_local';
  let lines = '';
  for (const ev of g.evs) {
    const f = ev.flags || {}; const by = state.profilesMap[ev.entered_by]?.name || '';
    const checks = requiredFlags(ev).map(fl =>
      `<label class="chk"><input type="checkbox" data-ev="${ev.id}" data-flag="${fl}" ${f[fl] ? 'checked' : ''}/> ${FLAG_LABEL[fl]}</label>`).join('');
    let detail = '';
    if (ev.type === 'account_create') {
      const p = ev.payload || {};
      detail = `<div class="payload"><b>Create in Hapana:</b> ${esc(p.first_name)} ${esc(p.last_name)}
        · ☎ ${esc(p.phone || '—')} · ✉ ${esc(p.email || '—')} · 🎂 ${esc(p.birthday || '—')}</div>`;
    } else if (ev.type === 'package_purchase') {
      const p = ev.payload || {};
      detail = `<div class="payload"><b>${p.free ? 'Comp package' : 'Assign package'}:</b> ${esc(p.name)}
        — ${p.free ? 'FREE' : fmt(p.price_cents)} ${p.free ? '' : '· ' + esc(p.payment_method)}</div>`;
    } else if (ev.type === 'credit_consume') {
      const p = ev.payload || {};
      detail = `<div class="payload"><b>Deduct credit:</b> ${esc(p.credit_type)} × ${p.qty || 1}</div>`;
    }
    lines += `<div class="wl-line"><div style="flex:1">${detail}<div class="muted small">by ${esc(by)}</div></div>
      <div style="display:flex;flex-direction:column;gap:.3rem">${checks}</div></div>`;
  }
  return `<div class="wl-group">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem">
      <h3>${esc(ind.full_name)} ${isNew ? '<span class="pill new">new account</span>' : '<span class="pill">in Hapana</span>'}</h3>
      <span class="muted small">${esc(ind.phone || '')} ${esc(ind.email || '')} ${ind.barcode ? '· #' + esc(ind.barcode) : ''}</span>
    </div>${lines}</div>`;
}
async function toggleFlag(evId, flag, checked) {
  const { data: ev } = await sb.from('events').select('*').eq('id', evId).single();
  const flags = { ...(ev.flags || {}), [flag]: checked };
  const done = requiredFlags(ev).every(f => flags[f]);
  const patch = { flags };
  if (done) { patch.port_status = 'ported'; patch.ported_by = state.user.id; patch.ported_at = new Date().toISOString(); }
  else { patch.port_status = 'pending'; patch.ported_by = null; patch.ported_at = null; }
  const { error } = await sb.from('events').update(patch).eq('id', evId);
  if (error) { toast(error.message, 'err'); return; }
  if (done) toast('Ported → ready for verification', 'ok');
  loadWorklist();
}

/* ───────── verify (checker) ───────── */
async function loadVerify() {
  const { data, error } = await sb.from('events').select('*, individuals(*)').eq('port_status', 'ported').order('ported_at');
  const body = $('#vfBody');
  if (error) { body.innerHTML = `<div class="card" style="color:var(--bad)">${esc(error.message)}</div>`; return; }
  if (!data.length) { body.innerHTML = '<div class="card muted">Nothing awaiting verification.</div>'; return; }
  body.innerHTML = data.map(ev => {
    const ind = ev.individuals, p = ev.payload || {};
    const own = ev.entered_by === state.user.id || ev.ported_by === state.user.id;
    const blocked = own && !state.profile.is_super;   // super users may self-verify
    let summary = ev.type === 'account_create' ? `New account · ${esc(p.first_name)} ${esc(p.last_name)}`
      : ev.type === 'package_purchase' ? `Package · ${esc(p.name)} ${p.free ? '(free)' : fmt(p.price_cents)}`
        : `Credit · ${esc(p.credit_type)} ×${p.qty || 1}`;
    const enteredBy = state.profilesMap[ev.entered_by]?.name || '';
    const portedBy = state.profilesMap[ev.ported_by]?.name || '';
    return `<div class="wl-group" style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
      <div><b>${esc(ind.full_name)}</b> — ${summary}
        <div class="muted small">entered by ${esc(enteredBy)} · ported by ${esc(portedBy)}</div></div>
      <button class="sm" data-vf="${ev.id}" ${blocked ? 'disabled title="you handled this — maker ≠ checker"' : ''}>${blocked ? 'your task' : (own ? 'Verify ✓ (self)' : 'Verify ✓')}</button>
    </div>`;
  }).join('');
  body.querySelectorAll('[data-vf]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const { error } = await sb.from('events').update({ port_status: 'verified' }).eq('id', b.dataset.vf);
    if (error) { toast(error.message, 'err'); b.disabled = false; } else { toast('Verified ✓', 'ok'); loadVerify(); }
  });
}

/* ───────── staff (admin) ───────── */
async function loadStaff() {
  const { data, error } = await sb.from('profiles').select('*').order('created_at');
  const body = $('#stBody');
  if (error) { body.innerHTML = `<span style="color:var(--bad)">${esc(error.message)}</span>`; return; }
  body.innerHTML = `<table><tr><th>Name</th><th>Role</th><th>Active</th></tr>` + data.map(p => `
    <tr><td>${esc(p.name)}${p.id === state.user.id ? ' <span class="muted small">(you)</span>' : ''}</td>
    <td><select data-role="${p.id}" style="max-width:140px">
      ${['entry', 'verifier', 'both'].map(r => `<option ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td><button class="sm ${p.active ? '' : 'ghost'}" data-active="${p.id}" data-on="${p.active}">${p.active ? 'active' : 'activate'}</button></td></tr>`).join('') + '</table>';
  body.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => {
    const { error } = await sb.from('profiles').update({ role: s.value }).eq('id', s.dataset.role);
    toast(error ? error.message : 'Role updated', error ? 'err' : 'ok');
  });
  body.querySelectorAll('[data-active]').forEach(b => b.onclick = async () => {
    const next = b.dataset.on !== 'true';
    const { error } = await sb.from('profiles').update({ active: next }).eq('id', b.dataset.active);
    if (error) toast(error.message, 'err'); else loadStaff();
  });
}

/* ───────── audit log (admin) ───────── */
function fmtDetail(a, d) {
  d = d || {};
  if (a.startsWith('event.')) {
    let s = d.type || '';
    const p = d.payload;
    if (p) {
      if (d.type === 'credit_consume') s += ` · ${p.credit_type} ×${p.qty || 1}`;
      else if (d.type === 'package_purchase') s += ` · ${esc(p.name || '')} ${p.free ? '(free)' : fmt(p.price_cents)}`;
      else if (d.type === 'account_create') s += ` · ${esc(((p.first_name || '') + ' ' + (p.last_name || '')).trim())}`;
    }
    if (d.from && d.to && d.from !== d.to) s += `  [${d.from}→${d.to}]`;
    return s;
  }
  if (a.startsWith('hat.')) {
    let s = esc(hatTypeLabel(d.hat_type)) + ' · ' + (d.kind === 'in' ? '＋in' : '－out') + ` ×${d.qty}`;
    if (d.payment_method === 'comp') s += ' · FREE';
    else if (d.unit_price_cents != null) s += ' · ' + fmt(d.unit_price_cents) + (d.member_price ? ' mbr' : '');
    if (d.customer) s += ' · ' + esc(d.customer);
    if (d.status === 'cancelled') s += '  [cancelled]';
    return s;
  }
  if (a === 'import.run') return `${d.added} new · ${d.rows} rows · ${d.unique} unique`;
  if (a.startsWith('individual.')) return esc(d.full_name || '') + (d.barcode ? ` · #${esc(d.barcode)}` : '');
  if (a === 'staff.update') return `${esc(d.name || '')} · role ${d.role_from}→${d.role_to} · active ${d.active_from}→${d.active_to}`;
  if (a === 'staff.signup') return `${esc(d.name || '')} · ${d.role}`;
  return esc(JSON.stringify(d));
}
async function loadAuditLog() {
  const { data, error } = await sb.from('audit_log').select('*').order('id', { ascending: false }).limit(300);
  const body = $('#logBody');
  if (error) { body.innerHTML = `<span style="color:var(--bad)">${esc(error.message)}</span>`; return; }
  if (!data.length) { body.innerHTML = '<span class="muted">No activity yet.</span>'; return; }
  body.innerHTML = `<table><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr>` +
    data.map(r => `<tr>
      <td class="small muted" style="white-space:nowrap">${esc(new Date(r.at).toLocaleString())}</td>
      <td>${esc(r.actor_name || 'system')}</td>
      <td><span class="pill">${esc(r.action)}</span></td>
      <td class="small">${fmtDetail(r.action, r.detail)}</td></tr>`).join('') + '</table>';
}
$('#logRefresh').onclick = e => { e.preventDefault(); loadAuditLog(); };

boot();
