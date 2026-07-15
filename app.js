// ============================================================================
// LEGEND RESERVATIONS — Host Stand & Management Console
// Vanilla HTML/CSS/JS + Supabase (auth, Postgres, RLS). No build step.
// ============================================================================

const SUPABASE_URL = 'https://bnjtoobxqfvosbvwnrie.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJuanRvb2J4cWZ2b3NidnducmllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTQ4MzksImV4cCI6MjA5OTU5MDgzOX0.2Zpknuae2DIhHhMLyKZ78kvId1RoT9a-M7oqxFTImuE';
const ADMIN_EMAIL = 'aerubio1@yahoo.com';
const APP_VERSION = '1.19';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Show the version on the login screen and in the app topbar. No index.html edits
// needed for future bumps — just change APP_VERSION above and re-upload app.js.
(function stampVersion(){
  const stamp = el => { if (el && !el.textContent.includes('· v')) el.textContent += ' · v' + APP_VERSION; };
  stamp(document.querySelector('.brand'));
  stamp(document.querySelector('.loginBox p'));
})();

let currentUser = null;
let currentStaff = null;
let _authMode = 'signin';

let state = {
  tab: 'reservations',
  resView: 'list',
  selectedDate: todayISO(),
  reservations: [],
  tables: [],
  areas: [],
  currentAreaId: '__all',
  editMode: false,
  serverView: false,
  serverSections: [],
  comboMembers: {},   // comboTableId -> [memberTableId, ...]
  memberOfCombos: {}, // memberTableId -> [comboTableId, ...]
  floorPlan: { background_image_url: null, canvas_width: 1200, canvas_height: 800 },
  guests: [],
  waitlist: [],
  staffList: [],
  servicePeriods: [],
  dashRange: 7,
};

// ============================================================================
// UTILITIES
// ============================================================================
function todayISO(){ return new Date().toISOString().slice(0,10); }
function uuid(){ return crypto.randomUUID(); }
function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(t){
  if(!t) return '';
  const [h,m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}
function fmtDateHuman(iso){
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
}
function minutesAgo(iso){
  if(!iso) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime())/60000));
}

// ============================================================================
// AVAILABILITY — capacity + time-overlap checking (soft vs hard table assignment)
// ============================================================================
function timeToMinutes(t){
  if (!t) return 0;
  const [h,m] = t.split(':').map(Number);
  return h*60 + m;
}
function rangesOverlap(startA, endA, startB, endB){
  return startA < endB && startB < endA;
}
// Active reservations already holding a specific table on a given date (DB is the
// ultimate source of truth via an exclusion constraint — this is for live UI feedback).
async function fetchDateReservations(dateStr, excludeId){
  // Includes Unassigned (table_id null) reservations too — simulateAvailability
  // needs the full picture to know how many of the fitting tables are already
  // spoken for by other pending bookings, not just ones with a table locked in.
  let q = sb.from('reservations')
    .select('id,table_id,reservation_time,duration_minutes,party_size')
    .eq('reservation_date', dateStr)
    .in('status', ['pending','confirmed','seated']);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q;
  return error ? [] : (data || []);
}

// ---- Per-area reservation bookability (weather-dependent / privately-rented areas) ----
// An area's `bookable` flag is the default; rows in area_availability_overrides flip it
// for one date — either all day, or scoped to a start_time/end_time window (e.g. block
// a rented-out Speakeasy from 6–10pm only, or open the Patio on a nice afternoon).
// Blocked areas are excluded from booking/availability only — the Floor Plan and
// manual seating still show every table, so walk-ins there stay trackable.
// Precedence when multiple overrides could apply at the same instant: a time-windowed
// override beats an all-day override for that area (so "closed all day, open 6-8pm"
// or "open all day, closed 6-8pm" both work as expected); ties broken by most recent.
async function getBlockedAreaIds(date, time){
  const blocked = new Set();
  if (!date) return blocked;
  const { data } = await sb.from('area_availability_overrides').select('*').eq('override_date', date).order('created_at');
  const t = time ? timeToMinutes(time) : null;
  const bestByArea = {};
  (data || []).forEach(o => {
    const isWindow = !!(o.start_time && o.end_time);
    if (isWindow){
      if (t === null) return; // no target time given — an all-day check ignores time-scoped overrides
      const os = timeToMinutes(o.start_time), oe = timeToMinutes(o.end_time);
      if (!(t >= os && t < oe)) return; // this window doesn't cover the target time
    }
    const prev = bestByArea[o.area_id];
    // Prefer a time-windowed match over an all-day one; otherwise last (most recent) wins.
    if (!prev || (isWindow && !prev.isWindow) || (isWindow === prev.isWindow)) {
      bestByArea[o.area_id] = { bookable: o.bookable, isWindow };
    }
  });
  state.areas.forEach(a => {
    const effective = bestByArea.hasOwnProperty(a.id) ? bestByArea[a.id].bookable : a.bookable;
    if (!effective) blocked.add(a.id);
  });
  return blocked;
}
function isTableBookable(t, blockedAreaIds){
  return !t.area_id || !blockedAreaIds.has(t.area_id);
}

// Simulates seating every other reservation that overlaps this time window (hard
// assignments first, then a greedy smallest-fit assignment for Unassigned ones)
// to figure out how many tables are genuinely still free for a NEW party — so a
// second unassigned 7-top at the same time correctly sees fewer options than the
// first one did, instead of every check being evaluated in isolation.
function simulateAvailability(dateReservations, time, duration, excludeId, blockedAreaIds){
  const blocked = blockedAreaIds || new Set();
  const start = timeToMinutes(time), end = start + (Number(duration)||90);
  const overlapping = dateReservations.filter(r => {
    if (excludeId && r.id === excludeId) return false;
    const rs = timeToMinutes(r.reservation_time), re = rs + (r.duration_minutes||90);
    return rangesOverlap(start, end, rs, re);
  });

  const consumed = new Set();
  overlapping.filter(r => r.table_id).forEach(r => {
    conflictingTableIds(r.table_id).forEach(id => consumed.add(id));
  });

  const fits = (t, partySize) => partySize >= t.min_party && partySize <= Math.min(t.max_party, t.seats);
  const unassigned = overlapping.filter(r => !r.table_id).sort((a,b) => b.party_size - a.party_size);
  unassigned.forEach(r => {
    const candidate = state.tables
      .filter(t => t.active && isTableBookable(t, blocked) && !consumed.has(t.id) && fits(t, r.party_size))
      .sort((a,b) => a.seats - b.seats)[0];
    if (candidate) conflictingTableIds(candidate.id).forEach(id => consumed.add(id));
  });

  return state.tables.filter(t => t.active && isTableBookable(t, blocked) && !consumed.has(t.id));
}
function tablesFittingParty(partySize, blockedAreaIds){
  const blocked = blockedAreaIds || new Set();
  // A table's actual seat count is always the hard ceiling, even if max_party
  // was set higher than seats by mistake when the table was configured.
  return state.tables.filter(t => t.active && isTableBookable(t, blocked) && partySize >= t.min_party && partySize <= Math.min(t.max_party, t.seats));
}

// ---- Auto-Assign: suggest tables for every still-Unassigned reservation on a date ----
// Best-fit-decreasing bin packing: biggest parties are placed first (they have the
// fewest valid tables/combos, so giving them first pick avoids painting the day into
// a corner where a party of 8 is left with nothing because 2-tops grabbed everything).
// A predefined table combination is only proposed when no single physical table is
// big enough on its own — combining tables is a fallback, never the first choice.
async function computeAutoAssignPlan(date){
  const dayReservations = state.reservations.filter(r => r.reservation_date === date && r.status !== 'cancelled');
  const targets = dayReservations
    .filter(r => !r.table_id && ['pending','confirmed'].includes(r.status))
    .slice()
    .sort((a,b) => b.party_size - a.party_size || a.reservation_time.localeCompare(b.reservation_time));

  // consumed[tableId] = minute ranges already spoken for on this date, seeded from
  // reservations that already have a hard table assignment, then grown as we plan.
  const consumed = {};
  const block = (tableId, start, end) => {
    conflictingTableIds(tableId).forEach(id => (consumed[id] = consumed[id] || []).push({ start, end }));
  };
  dayReservations.filter(r => r.table_id).forEach(r => {
    const start = timeToMinutes(r.reservation_time);
    block(r.table_id, start, start + (r.duration_minutes || 90));
  });
  const isFree = (tableId, start, end) => !(consumed[tableId] || []).some(iv => rangesOverlap(start, end, iv.start, iv.end));
  const fits = (t, partySize) => partySize >= t.min_party && partySize <= Math.min(t.max_party, t.seats);

  const plan = [];
  for (const r of targets){
    const start = timeToMinutes(r.reservation_time);
    const end = start + (r.duration_minutes || 90);
    const blockedAreaIds = await getBlockedAreaIds(r.reservation_date, r.reservation_time);
    const candidates = state.tables
      .filter(t => t.active && isTableBookable(t, blockedAreaIds) && fits(t, r.party_size) && isFree(t.id, start, end))
      .sort((a,b) => (a.is_combo === b.is_combo ? a.seats - b.seats : (a.is_combo ? 1 : -1))); // single tables before combos, then smallest-fit
    const chosen = candidates[0] || null;
    if (chosen) block(chosen.id, start, end);
    plan.push({ reservation: r, table: chosen });
  }
  return plan;
}
// ---- Table combinations: predefined pairs/groups that book as one unit ----
function buildComboMaps(rows){
  const members = {}, memberOf = {};
  rows.forEach(({combo_table_id, member_table_id}) => {
    (members[combo_table_id] ||= []).push(member_table_id);
    (memberOf[member_table_id] ||= []).push(combo_table_id);
  });
  state.comboMembers = members;
  state.memberOfCombos = memberOf;
}
async function reloadCombos(){
  const { data } = await sb.from('table_combo_members').select('*');
  buildComboMaps(data || []);
}
// A table and its combo partners can't be double-booked against each other —
// e.g. booking the "3+4" combo must also block Table 3 and Table 4 individually.
function conflictingTableIds(tableId){
  // Full transitive closure over the combo<->member graph: if two combos share
  // a physical table, the whole connected group is mutually exclusive, not just
  // each combo's immediate members (mirrors the DB trigger's recursive check).
  const ids = new Set([tableId]);
  const queue = [tableId];
  while (queue.length){
    const cur = queue.pop();
    const neighbors = [...(state.comboMembers[cur] || []), ...(state.memberOfCombos[cur] || [])];
    neighbors.forEach(n => { if (!ids.has(n)){ ids.add(n); queue.push(n); } });
  }
  return ids;
}

function isTableBusy(tableId, timeStr, durationMinutes, dateReservations){
  const start = timeToMinutes(timeStr), end = start + (Number(durationMinutes)||90);
  const conflictSet = conflictingTableIds(tableId);
  return dateReservations.some(r => {
    if (!conflictSet.has(r.table_id)) return false;
    const rStart = timeToMinutes(r.reservation_time);
    const rEnd = rStart + (r.duration_minutes||90);
    return rangesOverlap(start, end, rStart, rEnd);
  });
}
function guestName(g){
  if(!g) return 'Walk-in';
  return `${g.first_name||''} ${g.last_name||''}`.trim() || g.phone || 'Guest';
}
function guestById(id){ return state.guests.find(g => g.id === id); }
function tableById(id){ return state.tables.find(t => t.id === id); }
function tableDisplayLabel(t){
  if (!t?.is_combo) return t?.label || '';
  const members = (state.comboMembers[t.id] || []).map(id => tableById(id)?.label).filter(Boolean);
  return `🔗 ${t.label}${members.length ? ' ('+members.join(' + ')+')' : ''}`;
}
function setStatus(el, text, cls){
  el.textContent = text;
  el.className = 'sync-status' + (cls ? ' '+cls : '');
}

// ============================================================================
// AUTH
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  sb.auth.getSession().then(({data}) => {
    if (data.session?.user){ currentUser = data.session.user; onSignedIn(); }
  });
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY'){
      if (currentUser){ openAccountModal(); }
      return;
    }
    if (session?.user && !currentUser){ currentUser = session.user; onSignedIn(); }
    if (event === 'SIGNED_OUT'){ location.reload(); }
  });
});

window.switchAuthTab = function(mode){
  _authMode = mode;
  document.getElementById('tabSignIn').classList.toggle('active', mode==='signin');
  document.getElementById('tabRegister').classList.toggle('active', mode==='register');
  document.getElementById('authConfirmWrap').style.display = mode==='register' ? 'block' : 'none';
  document.getElementById('authSubmitBtn').textContent = mode==='signin' ? 'Sign In' : 'Request Access';
  document.getElementById('loginError').textContent = '';
};

window.submitAuth = async function(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const err = document.getElementById('loginError');
  err.style.color = 'var(--danger)'; err.textContent = '';
  if (!email || !password){ err.textContent = 'Enter email and password.'; return; }

  if (_authMode === 'register'){
    const confirm = document.getElementById('authConfirm').value;
    const name = document.getElementById('authName').value.trim();
    if (password !== confirm){ err.textContent = 'Passwords do not match.'; return; }
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error){ err.textContent = error.message; return; }
    if (data.user){
      await sb.from('staff').insert({ id: data.user.id, email, name: name || email, role:'host', active:false });
    }
    err.style.color = 'var(--success)';
    err.textContent = 'Request submitted! Ask an admin to approve your access, then sign in.';
  } else {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error){ err.textContent = 'Invalid email or password.'; return; }
    currentUser = data.user;
    onSignedIn();
  }
};

window.sendPasswordReset = async function(){
  const email = document.getElementById('authEmail').value.trim();
  const err = document.getElementById('loginError');
  if (!email){ err.style.color='var(--danger)'; err.textContent = 'Enter your email above first.'; return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split('#')[0] });
  err.style.color = error ? 'var(--danger)' : 'var(--success)';
  err.textContent = error ? error.message : 'Reset email sent — check your inbox.';
};

window.changePassword = async function(){
  const np = document.getElementById('newPwdInput').value;
  const cp = document.getElementById('confirmPwdInput').value;
  if (!np || np !== cp){ alert('Passwords do not match.'); return; }
  const { error } = await sb.auth.updateUser({ password: np });
  alert(error ? 'Error: '+error.message : 'Password updated.');
  if (!error){ document.getElementById('newPwdInput').value=''; document.getElementById('confirmPwdInput').value=''; }
};

window.signOut = async function(){
  await sb.auth.signOut();
};

async function onSignedIn(){
  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('pendingOverlay').classList.add('hidden');

  const isAdmin = currentUser.email === ADMIN_EMAIL;

  // Ensure a staff row exists for this user.
  let { data: staffRow } = await sb.from('staff').select('*').eq('id', currentUser.id).maybeSingle();
  if (!staffRow){
    await sb.from('staff').insert({ id: currentUser.id, email: currentUser.email, name: currentUser.email, role: isAdmin ? 'admin':'host', active: isAdmin });
    ({ data: staffRow } = await sb.from('staff').select('*').eq('id', currentUser.id).maybeSingle());
  }
  if (isAdmin && (!staffRow.active || staffRow.role !== 'admin')){
    await sb.from('staff').update({ active:true, role:'admin' }).eq('id', currentUser.id);
    ({ data: staffRow } = await sb.from('staff').select('*').eq('id', currentUser.id).maybeSingle());
  }
  currentStaff = staffRow;

  if (!currentStaff || !currentStaff.active){
    document.getElementById('pendingOverlay').classList.remove('hidden');
    return;
  }

  document.getElementById('app').classList.remove('hidden');
  document.getElementById('modalUserEmail').textContent = currentUser.email;
  document.getElementById('topbarName').textContent = currentStaff.name || currentUser.email.split('@')[0];
  setStatus(document.getElementById('syncStatus'), '☁ Synced', 'synced');

  await loadAll();
  render();
}

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadAll(){
  const statusEl = document.getElementById('syncStatus');
  setStatus(statusEl, '☁ Syncing…', '');
  try {
    const [tablesRes, areasRes, fpRes, ssRes, comboRes, guestsRes, waitlistRes, staffRes, spRes, resRes] = await Promise.all([
      sb.from('dining_tables').select('*').order('label'),
      sb.from('floor_areas').select('*').order('sort_order').order('created_at'),
      sb.from('floor_plan_settings').select('*').eq('id', true).maybeSingle(),
      sb.from('server_sections').select('*').order('sort_order').order('created_at'),
      sb.from('table_combo_members').select('*'),
      sb.from('guests').select('*').order('last_name'),
      sb.from('waitlist').select('*').eq('status','waiting').order('added_at'),
      sb.from('staff').select('*').order('created_at'),
      sb.from('service_periods').select('*').order('start_time'),
      sb.from('reservations').select('*').eq('reservation_date', state.selectedDate).order('reservation_time'),
    ]);
    state.tables = tablesRes.data || [];
    state.areas = areasRes.data || [];
    if (fpRes.data) state.floorPlan = fpRes.data;
    state.serverSections = ssRes.data || [];
    buildComboMaps(comboRes.data || []);
    state.guests = guestsRes.data || [];
    state.waitlist = waitlistRes.data || [];
    state.staffList = staffRes.data || [];
    state.servicePeriods = spRes.data || [];
    state.reservations = resRes.data || [];
    if (!state.currentAreaId) state.currentAreaId = '__all';
    setStatus(statusEl, '☁ Synced', 'synced');
  } catch(e){
    setStatus(statusEl, '⚠ Offline', 'error');
  }
}

async function reloadReservationsForDate(){
  const { data } = await sb.from('reservations').select('*').eq('reservation_date', state.selectedDate).order('reservation_time');
  state.reservations = data || [];
}

async function logActivity(action, entity_type, entity_id, details){
  try { await sb.from('activity_log').insert({ staff_id: currentStaff.id, action, entity_type, entity_id, details: details||{} }); } catch(e){}
}

// ============================================================================
// SHELL / TAB SWITCHING
// ============================================================================
window.setTab = function(tab){
  state.tab = tab;
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
};

function render(){
  const c = document.getElementById('content');
  if (state.tab === 'reservations') c.innerHTML = renderReservationsTab();
  else if (state.tab === 'floorplan') { c.innerHTML = renderFloorPlanTab(); fitFloorCanvasView(); }
  else if (state.tab === 'waitlist') c.innerHTML = renderWaitlistTab();
  else if (state.tab === 'guests') c.innerHTML = renderGuestsTab();
  else if (state.tab === 'dashboard') { c.innerHTML = renderDashboardTab(); loadDashboard(); }
  else if (state.tab === 'settings') c.innerHTML = renderSettingsTab();
}

// ============================================================================
// RESERVATIONS TAB
// ============================================================================
function renderReservationsTab(){
  const list = state.reservations.slice().sort((a,b) => a.reservation_time.localeCompare(b.reservation_time));
  const activeCount = list.filter(r => !['cancelled','no_show'].includes(r.status)).length;
  const covers = list.filter(r => ['confirmed','pending','seated','completed'].includes(r.status)).reduce((s,r) => s+r.party_size, 0);

  const header = `
  <div class="panel-header">
    <div>
      <h2 class="panel-title">Reservations</h2>
      <div class="panel-sub">${activeCount} reservations · ${covers} covers booked</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <div class="view-toggle">
        <button class="view-toggle-btn ${state.resView!=='timeline'?'active':''}" onclick="setResView('list')">📋 List</button>
        <button class="view-toggle-btn ${state.resView==='timeline'?'active':''}" onclick="setResView('timeline')">🕐 Timeline</button>
      </div>
      <input type="date" class="search-input" style="margin:0;width:auto" value="${state.selectedDate}" onchange="changeDate(this.value)"/>
      <button class="btn btn-secondary" onclick="changeDate(todayISO())">Today</button>
      <button class="btn btn-secondary" onclick="openAreaAvailabilityModal()">📅 Area Availability</button>
      <button class="btn btn-secondary" onclick="openAutoAssignModal()">🪄 Auto-Assign</button>
      <button class="btn btn-primary" onclick="openReservationModal()">+ New Reservation</button>
    </div>
  </div>`;

  if (state.resView === 'timeline') return header + renderReservationsTimeline(list);

  const items = list.length ? list.map(r => {
    const g = guestById(r.guest_id);
    const t = tableById(r.table_id);
    return `
    <div class="res-item status-${r.status}">
      <div class="res-time">${fmtTime(r.reservation_time)}</div>
      <div class="res-main">
        <div class="res-name">${esc(guestName(g))} ${g?.vip ? '<span class="badge badge-vip">VIP</span>' : ''} · ${r.party_size} guests</div>
        <div class="res-meta">
          <span class="badge badge-${r.status}">${r.status.replace('_',' ')}</span>
          ${t ? ` · Table ${esc(tableDisplayLabel(t))}` : ' · No table assigned'}
          ${r.special_requests ? ` · 📝 ${esc(r.special_requests)}` : ''}
          ${r.occasion ? ` · 🎉 ${esc(r.occasion)}` : ''}
        </div>
      </div>
      <div class="res-actions">
        ${resActionButtons(r)}
        <button class="btn btn-sm btn-secondary" onclick="openReservationModal('${r.id}')">Edit</button>
      </div>
    </div>`;
  }).join('') : `<div class="empty-state"><div class="empty-state-icon">📖</div>No reservations for this date yet.</div>`;

  return header + `<div class="res-list">${items}</div>`;
}

window.setResView = function(v){ state.resView = v; render(); };

// Per-day (and optionally per-time-window) override of an area's bookability, e.g.
// close the Patio for rain, or block the Speakeasy 6pm-11pm only for a rented-out
// private event while still allowing lunch reservations there earlier that day.
// Only affects the reservation/availability engine — Floor Plan & seating are untouched.
window.openAreaAvailabilityModal = async function(){
  document.getElementById('formModal').classList.remove('hidden');
  await renderAreaAvailabilityModal();
};

async function renderAreaAvailabilityModal(){
  const date = state.selectedDate;
  const { data } = await sb.from('area_availability_overrides').select('*').eq('override_date', date).order('start_time', { nullsFirst: true });
  const byArea = {};
  (data || []).forEach(o => { (byArea[o.area_id] = byArea[o.area_id] || []).push(o); });

  const rows = state.areas.map(a => {
    const overrides = byArea[a.id] || [];
    const overrideRows = overrides.map(o => `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding:6px 10px;background:var(--gray-bg,#f3f4f6);border-radius:6px;font-size:13px">
        <span>${o.start_time ? `🕐 ${fmtTime(o.start_time)}–${fmtTime(o.end_time)}` : '🌐 All day'} — ${o.bookable ? '✅ Open' : '⛔ Closed'}</span>
        <button type="button" class="linkBtn" style="color:var(--danger)" onclick="deleteAreaOverride('${o.id}')">Remove</button>
      </div>`).join('');

    return `
    <div class="card" style="margin-bottom:12px;padding:12px">
      <div><strong>${esc(a.name)}</strong> <span class="panel-sub" style="margin:0">— default: ${a.bookable ? 'Bookable' : 'Not bookable'}</span></div>
      ${overrideRows}
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
        <label style="font-size:12px;display:flex;align-items:center;gap:4px">
          <input type="radio" name="scope_${a.id}" value="allday" checked onchange="toggleOverrideScope('${a.id}')"/> All day
        </label>
        <label style="font-size:12px;display:flex;align-items:center;gap:4px">
          <input type="radio" name="scope_${a.id}" value="window" onchange="toggleOverrideScope('${a.id}')"/> Time window
        </label>
        <input type="time" class="modal-input" id="ovStart_${a.id}" style="width:110px;display:none;margin:0" value="18:00"/>
        <span id="ovDash_${a.id}" style="display:none">–</span>
        <input type="time" class="modal-input" id="ovEnd_${a.id}" style="width:110px;display:none;margin:0" value="22:00"/>
        <select class="modal-select" id="ovBookable_${a.id}" style="width:120px;margin:0">
          <option value="closed">⛔ Closed</option>
          <option value="open">✅ Open</option>
        </select>
        <button type="button" class="btn btn-sm btn-secondary" onclick="addAreaOverride('${a.id}')">+ Add</button>
      </div>
    </div>`;
  }).join('');

  document.getElementById('formModalBox').innerHTML = `
    <h3>Area Availability — ${date}</h3>
    <p class="panel-sub" style="margin-top:-4px">Override which areas are bookable on this date — all day, or just for a specific time window (e.g. Speakeasy closed 6-11pm for a private event, open the rest of the day). Tables in a closed window still show on the Floor Plan and can be seated as walk-ins — they just won't be offered when booking a reservation for that time.</p>
    ${state.areas.length ? rows : '<div class="empty-state">No areas defined yet.</div>'}
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Done</button>
    </div>`;
}

window.toggleOverrideScope = function(areaId){
  const isWindow = document.querySelector(`input[name="scope_${areaId}"]:checked`)?.value === 'window';
  ['ovStart_','ovDash_','ovEnd_'].forEach(prefix => {
    const el = document.getElementById(`${prefix}${areaId}`);
    if (el) el.style.display = isWindow ? '' : 'none';
  });
};

window.addAreaOverride = async function(areaId){
  const date = state.selectedDate;
  const isWindow = document.querySelector(`input[name="scope_${areaId}"]:checked`)?.value === 'window';
  const bookable = document.getElementById(`ovBookable_${areaId}`).value === 'open';
  const payload = { area_id: areaId, override_date: date, bookable, start_time: null, end_time: null };
  if (isWindow){
    const start = document.getElementById(`ovStart_${areaId}`).value;
    const end = document.getElementById(`ovEnd_${areaId}`).value;
    if (!start || !end || start >= end){ alert('Enter a valid start and end time (start before end).'); return; }
    payload.start_time = start;
    payload.end_time = end;
  }
  const { error } = await sb.from('area_availability_overrides').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
  await renderAreaAvailabilityModal();
  render();
};

window.deleteAreaOverride = async function(id){
  await sb.from('area_availability_overrides').delete().eq('id', id);
  await renderAreaAvailabilityModal();
  render();
};

// Auto-Assign review modal: nothing is written to the database until the hostess
// hits Apply, and each suggestion can be unchecked individually first. Any party
// whose proposed table is a combo shows the exact member table numbers being
// combined, both in the row itself and again in a callout, so it's never a surprise.
window.openAutoAssignModal = async function(){
  document.getElementById('formModal').classList.remove('hidden');
  document.getElementById('formModalBox').innerHTML = `<h3>Auto-Assign Tables</h3><p class="panel-sub">Working out the best fit…</p>`;
  const plan = await computeAutoAssignPlan(state.selectedDate);
  state._autoAssignPlan = plan;
  renderAutoAssignModal(plan);
};

function renderAutoAssignModal(plan){
  const placed = plan.filter(p => p.table);
  const unplaced = plan.filter(p => !p.table);
  const combosUsed = placed.filter(p => p.table.is_combo);

  const rows = plan.map((p, i) => {
    const g = guestById(p.reservation.guest_id);
    const r = p.reservation;
    if (!p.table){
      return `
      <div class="card-row" style="padding:8px 0;border-bottom:1px solid var(--border);opacity:.7">
        <div>
          <strong>${fmtTime(r.reservation_time)} · ${esc(guestName(g))}</strong> · ${r.party_size} guests
          <div class="panel-sub" style="margin:0;color:var(--warn)">⚠️ No table or combo currently fits/free — leave Unassigned or seat manually.</div>
        </div>
      </div>`;
    }
    const isCombo = p.table.is_combo;
    const memberLabels = isCombo ? (state.comboMembers[p.table.id] || []).map(id => tableById(id)?.label).filter(Boolean) : [];
    return `
    <div class="card-row" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
        <input type="checkbox" id="autoAssignChk_${i}" checked/>
        <div>
          <strong>${fmtTime(r.reservation_time)} · ${esc(guestName(g))}</strong> · ${r.party_size} guests
          <div class="panel-sub" style="margin:0">
            → ${esc(tableDisplayLabel(p.table))}
            ${isCombo ? `<span style="color:var(--warn);font-weight:700"> — combines tables ${memberLabels.map(esc).join(' + ')}</span>` : ''}
          </div>
        </div>
      </label>
    </div>`;
  }).join('');

  document.getElementById('formModalBox').innerHTML = `
    <h3>Auto-Assign Tables — ${state.selectedDate}</h3>
    <p class="panel-sub" style="margin-top:-4px">Suggested tables for every Unassigned reservation, largest parties placed first. Single tables are always preferred — a combo is only suggested when no one table is big enough. Nothing is saved until you hit Apply, and you can uncheck any row first.</p>
    ${combosUsed.length ? `<div class="panel-sub" style="background:#fff7ed;border-radius:8px;padding:8px 12px;color:#92400e;margin-bottom:10px">🔗 ${combosUsed.length} of these will physically combine tables — double-check those are actually pushed together before service: ${combosUsed.map(p => `${esc(guestName(guestById(p.reservation.guest_id)))} → ${(state.comboMembers[p.table.id]||[]).map(id=>esc(tableById(id)?.label||'?')).join(' + ')}`).join('; ')}.</div>` : ''}
    ${plan.length ? rows : '<div class="empty-state">No Unassigned reservations for this date.</div>'}
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      ${placed.length ? `<button class="modal-btn modal-btn-primary" onclick="applyAutoAssign()">Apply Selected (${placed.length})</button>` : ''}
    </div>`;
}

window.applyAutoAssign = async function(){
  const plan = state._autoAssignPlan || [];
  const toApply = plan.filter((p, i) => p.table && document.getElementById(`autoAssignChk_${i}`)?.checked);
  if (!toApply.length){ closeModal('formModal'); return; }
  let okCount = 0;
  const errors = [];
  for (const p of toApply){
    const { error } = await sb.from('reservations').update({ table_id: p.table.id }).eq('id', p.reservation.id);
    if (!error) okCount++;
    else errors.push(`${guestName(guestById(p.reservation.guest_id))}: ${error.message}`);
  }
  closeModal('formModal');
  await reloadReservationsForDate();
  render();
  let msg = `Assigned ${okCount} of ${toApply.length} reservation${toApply.length===1?'':'s'}.`;
  if (errors.length) msg += `\n\nFailed:\n${errors.slice(0,5).join('\n')}${errors.length>5?`\n…and ${errors.length-5} more`:''}`;
  alert(msg);
};

// ---- Timeline: tables as rows, time-of-day across the top, gap/conflict aware ----
function renderReservationsTimeline(list){
  const PX_PER_MIN = 2.2;
  const starts = state.servicePeriods.map(sp => timeToMinutes(sp.start_time));
  const ends = state.servicePeriods.map(sp => timeToMinutes(sp.end_time));
  const rangeStart = Math.max(0, (starts.length ? Math.min(...starts) : 10*60) - 30);
  const rangeEnd = Math.min(24*60, (ends.length ? Math.max(...ends) : 23*60) + 30);
  const totalW = (rangeEnd - rangeStart) * PX_PER_MIN;
  const x = min => (min - rangeStart) * PX_PER_MIN;

  const hourMarks = [];
  for (let m = Math.ceil(rangeStart/60)*60; m <= rangeEnd; m += 60) hourMarks.push(m);

  const tables = state.tables.filter(t => t.active).slice().sort((a,b) => (a.section||'').localeCompare(b.section||'') || a.label.localeCompare(b.label));
  const unassigned = list.filter(r => !r.table_id && !['cancelled'].includes(r.status));

  const nowMin = (() => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0,10);
    if (state.selectedDate !== todayStr) return null;
    return now.getHours()*60 + now.getMinutes();
  })();
  // Bars are laid out into vertical "lanes" within a row using greedy interval
  // scheduling, so multiple reservations that overlap in time (very common in the
  // Unassigned row, where several soft-assigned parties can share the same slot)
  // stack visibly instead of drawing exactly on top of one another and disappearing.
  const LANE_H = 32, LANE_GAP = 4, ROW_PAD = 7;
  function rowFor(label, sub, resForRow, highlight){
    const sorted = resForRow.slice().sort((a,b) => a.reservation_time.localeCompare(b.reservation_time));
    const laneEnds = [];
    const laned = sorted.map(r => {
      const start = timeToMinutes(r.reservation_time);
      const dur = r.duration_minutes || 90;
      const end = start + dur;
      let lane = laneEnds.findIndex(e => e <= start);
      if (lane === -1){ lane = laneEnds.length; laneEnds.push(end); } else laneEnds[lane] = end;
      return { r, start, dur, lane };
    });
    const laneCount = Math.max(1, laneEnds.length);
    const rowHeight = laneCount*LANE_H + (laneCount-1)*LANE_GAP + ROW_PAD*2;

    const bars = laned.map(({r,start,dur,lane}) => {
      const g = guestById(r.guest_id);
      const top = ROW_PAD + lane*(LANE_H+LANE_GAP);
      return `<div class="timeline-bar status-${r.status}" style="left:${x(start)}px;width:${Math.max(30,dur*PX_PER_MIN)}px;top:${top}px;height:${LANE_H}px" onclick="openReservationModal('${r.id}')" title="${esc(guestName(g))} · ${r.party_size}p · ${fmtTime(r.reservation_time)}">${fmtTime(r.reservation_time)} · ${esc(guestName(g))} · ${r.party_size}p</div>`;
    }).join('');
    const gaps = [];
    for (let i=0;i<sorted.length-1;i++){
      const aEnd = timeToMinutes(sorted[i].reservation_time) + (sorted[i].duration_minutes||90);
      const bStart = timeToMinutes(sorted[i+1].reservation_time);
      if (bStart - aEnd >= 0 && bStart - aEnd < 20){
        gaps.push(`<div class="timeline-tight-gap" style="left:${x(aEnd)}px;height:${rowHeight-8}px" title="Only ${bStart-aEnd} min to turn this table"></div>`);
      }
    }
    return `
    <div class="timeline-row${highlight?' timeline-row-highlight':''}" style="height:${rowHeight}px">
      <div class="timeline-row-label" style="height:${rowHeight}px">${esc(label)}${sub?`<span class="timeline-row-sub">${esc(sub)}</span>`:''}</div>
      <div class="timeline-row-track" style="width:${totalW}px;height:${rowHeight}px">${bars}${gaps.join('')}</div>
    </div>`;
  }

  // Unassigned goes first — it's the row a hostess needs most (parties still
  // needing a table) and previously sat buried below every table in the house.
  const rows = (unassigned.length ? rowFor(`⚠️ Unassigned`, `${unassigned.length} to seat`, unassigned, true) : '')
    + tables.map(t => rowFor(tableDisplayLabel(t), `${t.section||''} · ${t.seats} seats`, list.filter(r => r.table_id === t.id && r.status!=='cancelled'))).join('');

  const headerCells = hourMarks.map(m => `<div class="timeline-hour" style="width:${60*PX_PER_MIN}px">${fmtTime(String(Math.floor(m/60)).padStart(2,'0')+':00')}</div>`).join('');

  // "Now" line spans the full height of the grid — placed once on the shared
  // relatively-positioned wrapper so it isn't clipped to a single row.
  const LABEL_COL_W = 130;
  const nowLine = nowMin!=null && nowMin>=rangeStart && nowMin<=rangeEnd
    ? `<div class="timeline-now-line" style="left:${LABEL_COL_W + x(nowMin)}px" title="Now"></div>` : '';

  return `
  <div class="timeline-wrap">
    <div style="position:relative">
      <div class="timeline-header">
        <div class="timeline-corner"></div>
        <div class="timeline-header-hours">${headerCells}</div>
      </div>
      ${rows || '<div class="empty-state">No active tables to show.</div>'}
      ${nowLine}
    </div>
  </div>
  <div class="panel-sub" style="margin-top:8px">🟠 Dashed marker = less than 20 min to turn a table between reservations. Tap any bar to edit.</div>`;
}

function resActionButtons(r){
  const btns = [];
  if (r.status === 'pending') btns.push(`<button class="btn btn-sm btn-secondary" onclick="updateReservationStatus('${r.id}','confirmed')">Confirm</button>`);
  if (['pending','confirmed'].includes(r.status)) btns.push(`<button class="btn btn-sm btn-success" onclick="openSeatModal('${r.id}')">Seat</button>`);
  if (r.status === 'seated') btns.push(`<button class="btn btn-sm btn-secondary" onclick="updateReservationStatus('${r.id}','completed')">Complete</button>`);
  if (['pending','confirmed'].includes(r.status)) btns.push(`<button class="btn btn-sm btn-danger" onclick="updateReservationStatus('${r.id}','no_show')">No-Show</button>`);
  if (!['completed','cancelled','no_show'].includes(r.status)) btns.push(`<button class="btn btn-sm btn-danger" onclick="updateReservationStatus('${r.id}','cancelled')">Cancel</button>`);
  return btns.join('');
}

window.changeDate = async function(d){
  state.selectedDate = d;
  await reloadReservationsForDate();
  render();
};

window.updateReservationStatus = async function(id, status){
  const patch = { status };
  if (status === 'seated') patch.seated_at = new Date().toISOString();
  if (status === 'completed') patch.completed_at = new Date().toISOString();
  if (status === 'cancelled') patch.cancelled_at = new Date().toISOString();
  const { error } = await sb.from('reservations').update(patch).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await logActivity('status_change','reservation', id, {status});
  await reloadReservationsForDate();
  render();
};

window.openSeatModal = function(id){
  const r = state.reservations.find(x => x.id === id);
  const physicallyFree = state.tables.filter(t => t.active && ['available','reserved'].includes(t.status));
  const capFits = t => r.party_size >= t.min_party && r.party_size <= Math.min(t.max_party, t.seats);
  const fits = physicallyFree.filter(capFits);
  const tooSmallOrBig = physicallyFree.filter(t => !capFits(t));
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Seat Reservation</h3>
    <p class="modal-user-email">${esc(guestName(guestById(r.guest_id)))} · ${r.party_size} guests</p>
    <label class="field-label">Assign Table</label>
    <select class="modal-select" id="seatTableSelect">
      <option value="">No table / seat at bar</option>
      ${fits.map(t => `<option value="${t.id}" ${t.id===r.table_id?'selected':''}>✅ ${esc(tableDisplayLabel(t))} (${t.section}, seats ${t.seats})</option>`).join('')}
      ${tooSmallOrBig.map(t => `<option value="${t.id}" ${t.id===r.table_id?'selected':''}>⚠️ ${esc(tableDisplayLabel(t))} — seats ${t.min_party}-${t.max_party}, party is ${r.party_size}</option>`).join('')}
    </select>
    ${!fits.length ? `<div class="panel-sub" style="color:var(--warn)">No free table is sized right for ${r.party_size} guests — you can still pick one above, or seat with no table assigned.</div>` : ''}
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="confirmSeat('${id}')">Seat Now</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.confirmSeat = async function(id){
  const tableId = document.getElementById('seatTableSelect').value || null;
  const { error } = await sb.from('reservations').update({ status:'seated', seated_at: new Date().toISOString(), table_id: tableId }).eq('id', id);
  if (error){
    if (error.code === '23P01' || error.message?.includes('TABLE_COMBO_CONFLICT')) alert('That table was just taken for an overlapping reservation — pick a different table.');
    else alert('Error: '+error.message);
    return;
  }
  if (tableId){
    // Seating a combo also marks its member tables seated, so the floor plan
    // shows both physical tables occupied (combos don't get their own tile).
    const idsToMark = [tableId, ...(state.comboMembers[tableId] || [])];
    await sb.from('dining_tables').update({ status:'seated' }).in('id', idsToMark);
  }
  closeModal('formModal');
  await Promise.all([reloadReservationsForDate(), reloadTables()]);
  render();
};

window.openReservationModal = function(id){
  const r = id ? state.reservations.find(x => x.id === id) : null;
  const g = r ? guestById(r.guest_id) : null;
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${r ? 'Edit' : 'New'} Reservation</h3>
    <label class="field-label">Guest name</label>
    <input type="text" class="modal-input" id="resGuestName" placeholder="Search or add new guest" value="${esc(g ? guestName(g) : '')}" oninput="filterGuestSuggestions(this.value)" autocomplete="off"/>
    <div id="guestSuggestions"></div>
    <input type="hidden" id="resGuestId" value="${r?.guest_id || ''}"/>
    <input type="hidden" id="resId" value="${r?.id || ''}"/>
    <div class="formgrid">
      <div>
        <label class="field-label">Phone</label>
        <input type="tel" class="modal-input" id="resGuestPhone" value="${esc(g?.phone || '')}"/>
      </div>
      <div>
        <label class="field-label">Party size</label>
        <input type="number" min="1" class="modal-input" id="resPartySize" value="${r?.party_size || 2}" oninput="refreshAvailability()"/>
      </div>
    </div>
    <div class="formgrid">
      <div>
        <label class="field-label">Date</label>
        <input type="date" class="modal-input" id="resDate" value="${r?.reservation_date || state.selectedDate}" onchange="refreshAvailability()"/>
      </div>
      <div>
        <label class="field-label">Time</label>
        <input type="time" class="modal-input" id="resTime" value="${r?.reservation_time?.slice(0,5) || '18:00'}" onchange="refreshAvailability()"/>
      </div>
    </div>
    <div class="formgrid">
      <div>
        <label class="field-label">Duration (minutes)</label>
        <input type="number" min="15" step="15" class="modal-input" id="resDuration" value="${r?.duration_minutes || 90}" onchange="refreshAvailability()"/>
      </div>
      <div>
        <label class="field-label">Source</label>
        <select class="modal-select" id="resSource">
          ${['phone','walk-in','online','website','other'].map(s => `<option value="${s}" ${s===(r?.source||'phone')?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <label class="field-label">Table</label>
    <select class="modal-select" id="resTable" onchange="refreshAvailability()">
      <option value="">Unassigned — assign a table at seating (recommended)</option>
    </select>
    <div id="availabilityNote" class="panel-sub" style="margin:-4px 0 10px"></div>
    <label class="field-label">Occasion (optional)</label>
    <input type="text" class="modal-input" id="resOccasion" placeholder="Birthday, anniversary…" value="${esc(r?.occasion || '')}"/>
    <label class="field-label">Special requests / allergies</label>
    <textarea class="modal-textarea" id="resNotes">${esc(r?.special_requests || '')}</textarea>
    <div class="modal-actions">
      ${r ? `<button class="modal-btn modal-btn-danger" onclick="deleteReservation('${r.id}')">Delete</button>` : ''}
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveReservation(${r ? `'${r.id}'` : 'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
  refreshAvailability(r?.table_id || '');
};

window.waitlistFromReservationModal = function(){
  const name = document.getElementById('resGuestName')?.value.trim() || '';
  const phone = document.getElementById('resGuestPhone')?.value.trim() || '';
  const party = Number(document.getElementById('resPartySize')?.value) || 2;
  openWaitlistModal({ name, phone, party });
};

// Rebuilds the Table dropdown + status note based on current party size / date /
// time / duration, showing which tables actually fit and are free at that time.
window.refreshAvailability = async function(preserveSelection){
  const sel = document.getElementById('resTable');
  const noteEl = document.getElementById('availabilityNote');
  if (!sel) return;
  const partySize = Number(document.getElementById('resPartySize').value) || 1;
  const date = document.getElementById('resDate').value;
  const time = document.getElementById('resTime').value;
  const duration = Number(document.getElementById('resDuration').value) || 90;
  const currentVal = preserveSelection !== undefined ? preserveSelection : sel.value;
  const excludeId = document.getElementById('resId')?.value || null;

  const blockedAreaIds = date ? await getBlockedAreaIds(date, time) : new Set();
  const fitting = tablesFittingParty(partySize, blockedAreaIds);
  const dateReservations = date ? await fetchDateReservations(date, excludeId) : [];
  const stillFree = new Set(simulateAvailability(dateReservations, time, duration, excludeId, blockedAreaIds).map(t => t.id));
  const freeFitting = fitting.filter(t => stillFree.has(t.id));
  const busyFitting = fitting.filter(t => !stillFree.has(t.id));
  const blockedAreaNames = state.areas.filter(a => blockedAreaIds.has(a.id)).map(a => a.name);

  sel.innerHTML = `<option value="">Unassigned — assign a table at seating (recommended)</option>`
    + freeFitting.map(t => `<option value="${t.id}">✅ ${esc(tableDisplayLabel(t))} (${t.section||''}, seats ${t.seats})</option>`).join('')
    + busyFitting.map(t => `<option value="${t.id}">⛔ ${esc(tableDisplayLabel(t))} — reserved for another party at that time</option>`).join('');
  if ([...sel.options].some(o => o.value === currentVal)) sel.value = currentVal;

  const blockedNote = blockedAreaNames.length ? ` (${blockedAreaNames.join(', ')} not bookable this date)` : '';
  if (noteEl){
    if (!fitting.length){
      noteEl.style.color = 'var(--danger)';
      noteEl.textContent = `No bookable tables fit a party of ${partySize}${blockedNote}.`;
    } else if (!freeFitting.length){
      noteEl.style.color = 'var(--warn)';
      noteEl.innerHTML = `⚠️ Fully booked for a party of ${partySize} at that time${esc(blockedNote)}. <span class="linkBtn" style="cursor:pointer" onclick="waitlistFromReservationModal()">Add to Waitlist instead</span>`;
    } else {
      noteEl.style.color = 'var(--success)';
      noteEl.textContent = `${freeFitting.length} table${freeFitting.length===1?'':'s'} available for this party size at this time${blockedNote}.`;
    }
  }
};

window.filterGuestSuggestions = function(q){
  const el = document.getElementById('guestSuggestions');
  document.getElementById('resGuestId').value = '';
  if (!q || q.length < 2){ el.innerHTML=''; return; }
  const matches = state.guests.filter(g => guestName(g).toLowerCase().includes(q.toLowerCase()) || (g.phone||'').includes(q)).slice(0,5);
  el.innerHTML = matches.map(g => `<div class="guest-item" style="margin-bottom:4px" onclick="selectGuestSuggestion('${g.id}')">
      <span>${esc(guestName(g))} ${g.vip?'<span class=\"badge badge-vip\">VIP</span>':''}</span>
      <span style="color:var(--gray);font-size:12px">${esc(g.phone||'')}</span>
    </div>`).join('');
};
window.selectGuestSuggestion = function(id){
  const g = guestById(id);
  document.getElementById('resGuestId').value = id;
  document.getElementById('resGuestName').value = guestName(g);
  document.getElementById('resGuestPhone').value = g.phone || '';
  document.getElementById('guestSuggestions').innerHTML = '';
};

window.saveReservation = async function(id){
  const name = document.getElementById('resGuestName').value.trim();
  let guestId = document.getElementById('resGuestId').value || null;
  const phone = document.getElementById('resGuestPhone').value.trim();
  if (!guestId && name){
    const [first, ...rest] = name.split(' ');
    const { data, error } = await sb.from('guests').insert({ first_name: first, last_name: rest.join(' '), phone }).select().single();
    if (error){ alert('Error creating guest: '+error.message); return; }
    guestId = data.id;
    state.guests.push(data);
  } else if (guestId && phone){
    await sb.from('guests').update({ phone }).eq('id', guestId);
  }

  const tableId = document.getElementById('resTable').value || null;
  const partySize = Number(document.getElementById('resPartySize').value) || 1;
  const date = document.getElementById('resDate').value;
  const time = document.getElementById('resTime').value;
  const duration = Number(document.getElementById('resDuration').value) || 90;

  // Hard-assignment defense in depth: re-check the chosen table right before saving
  // (the DB exclusion constraint is the ultimate backstop for race conditions).
  if (tableId){
    const blockedAreaIds = await getBlockedAreaIds(date, time);
    const chosenTable = tableById(tableId);
    if (chosenTable && !isTableBookable(chosenTable, blockedAreaIds)){
      alert('That table is in an area not bookable for this date (weather-dependent or privately reserved) — pick a different table or leave it Unassigned.');
      refreshAvailability(tableId);
      return;
    }
    const dateReservations = await fetchDateReservations(date, id);
    if (isTableBusy(tableId, time, duration, dateReservations)){
      alert('That table just got booked for an overlapping time — pick a different table or leave it Unassigned.');
      refreshAvailability(tableId);
      return;
    }
  }

  const payload = {
    guest_id: guestId,
    party_size: partySize,
    reservation_date: date,
    reservation_time: time,
    duration_minutes: duration,
    table_id: tableId,
    source: document.getElementById('resSource').value,
    occasion: document.getElementById('resOccasion').value.trim() || null,
    special_requests: document.getElementById('resNotes').value.trim() || null,
  };
  if (!id){ payload.created_by = currentStaff.id; payload.status = 'pending'; }

  const { error } = id
    ? await sb.from('reservations').update(payload).eq('id', id)
    : await sb.from('reservations').insert(payload);
  if (error){
    if (error.code === '23P01' || error.message?.includes('TABLE_COMBO_CONFLICT')) alert('That table just got booked for an overlapping time — pick a different table or leave it Unassigned.');
    else alert('Error: '+error.message);
    return;
  }
  closeModal('formModal');
  await reloadReservationsForDate();
  render();
};

window.deleteReservation = async function(id){
  if (!confirm('Delete this reservation?')) return;
  await sb.from('reservations').delete().eq('id', id);
  closeModal('formModal');
  await reloadReservationsForDate();
  render();
};

// ============================================================================
// FLOOR PLAN TAB — drag & drop editor with per-area background sketches
// ============================================================================
async function reloadTables(){
  const { data } = await sb.from('dining_tables').select('*').order('label');
  state.tables = data || [];
}
async function reloadAreas(){
  const { data } = await sb.from('floor_areas').select('*').order('sort_order').order('created_at');
  state.areas = data || [];
  if (!['__all','__unassigned'].includes(state.currentAreaId) && !state.areas.find(a => a.id === state.currentAreaId)) state.currentAreaId = '__all';
}
async function reloadFloorPlanSettings(){
  const { data } = await sb.from('floor_plan_settings').select('*').eq('id', true).maybeSingle();
  if (data) state.floorPlan = data;
}
async function reloadServerSections(){
  const { data } = await sb.from('server_sections').select('*').order('sort_order').order('created_at');
  state.serverSections = data || [];
}
function currentArea(){ return state.areas.find(a => a.id === state.currentAreaId); }

function renderFloorPlanTab(){
  const activeRes = state.reservations.filter(r => r.status === 'seated');
  const area = currentArea();
  const unassignedCount = state.tables.filter(t => !t.area_id).length;
  const showingAll = state.currentAreaId === '__all';

  const areaTabs = `<span class="area-chip ${showingAll?'active':''}" onclick="switchArea('__all')">🗺️ All Areas</span>`
    + state.areas.map(a => `<span class="area-chip ${a.id===state.currentAreaId?'active':''}" onclick="switchArea('${a.id}')">${esc(a.name)}</span>`).join('')
    + (unassignedCount ? `<span class="area-chip ${state.currentAreaId==='__unassigned'?'active':''}" onclick="switchArea('__unassigned')">Unassigned (${unassignedCount})</span>` : '')
    + `<span class="area-chip-add" onclick="openAreaModal()">+ New Area</span>`;

  // Combos are a booking concept, not a physical spot on the floor — they don't
  // get their own tile (their member tables already represent them visually).
  const tablesInArea = (showingAll ? state.tables
    : state.currentAreaId === '__unassigned' ? state.tables.filter(t => !t.area_id)
    : state.tables.filter(t => t.area_id === state.currentAreaId)).filter(t => !t.is_combo);

  // One shared background/canvas for the whole restaurant — area chips just filter
  // which tables are shown/draggable, so everything stays lined up on the same sketch.
  const canvasW = state.floorPlan.canvas_width || 1200;
  const canvasH = state.floorPlan.canvas_height || 800;
  const bgStyle = state.floorPlan.background_image_url ? `background-image:url('${esc(state.floorPlan.background_image_url)}');background-size:100% 100%;background-position:center;` : '';

  const tableEls = tablesInArea.map(t => {
    const occ = activeRes.find(r => r.table_id === t.id);
    const dragAttr = state.editMode ? `onpointerdown="startDragTable(event,'${t.id}')"` : `onclick="cycleTableStatus('${t.id}')"`;
    const areaName = state.areas.find(a => a.id === t.area_id)?.name;
    const section = state.serverSections.find(s => s.id === t.server_section_id);
    const server = section ? state.staffList.find(s => s.id === section.assigned_staff_id) : null;
    const colorStyle = state.serverView && section ? `border-color:${section.color};background:${section.color}22;` : (state.serverView ? 'opacity:.45;' : '');
    return `
      <div id="tbl-${t.id}" class="floor-table shape-${t.shape} ${state.serverView ? '' : 'status-'+t.status}" ${dragAttr}
           style="left:${t.pos_x}px;top:${t.pos_y}px;width:${t.width}px;height:${t.height}px;${colorStyle}">
        <div class="ft-name">${esc(t.label)}</div>
        ${state.serverView
          ? `<div class="ft-meta">${section ? esc(section.name) : 'No section'}</div>${server ? `<div class="ft-meta">${esc(server.name)}</div>` : ''}`
          : `<div class="ft-meta">${t.seats} seats</div>${showingAll && areaName ? `<div class="ft-meta">${esc(areaName)}</div>` : ''}${occ ? `<div class="ft-meta">${esc(guestName(guestById(occ.guest_id)))}</div>` : ''}`}
        ${state.editMode ? `<div class="resize-handle" onpointerdown="startResizeTable(event,'${t.id}')" title="Drag to resize"></div>` : ''}
      </div>`;
  }).join('');

  const toolbar = `
    <button class="btn btn-secondary btn-sm" onclick="openBackgroundModal()">🖼 Floor Plan Image</button>
    ${area ? `<button class="btn btn-secondary btn-sm" onclick="openAreaModal('${area.id}')">✏️ Rename Area</button>` : ''}
    ${state.editMode ? `<button class="btn btn-primary btn-sm" onclick="addTableToCanvas()">+ Add Table</button>` : ''}
    <button class="btn ${state.serverView?'btn-success':'btn-secondary'} btn-sm" onclick="toggleServerView()">🎨 Server View</button>
    <button class="btn ${state.editMode?'btn-success':'btn-secondary'} btn-sm" onclick="toggleEditMode()">${state.editMode ? '✅ Done Editing' : '✏️ Edit Layout'}</button>
  `;

  return `
  <div class="panel-header">
    <div><h2 class="panel-title">Floor Plan</h2><div class="panel-sub">${state.editMode ? 'Drag tables to reposition. Tap a table to rename, resize, or delete.' : 'Tap a table to cycle its status.'}</div></div>
    <div class="floor-toolbar">${toolbar}</div>
  </div>
  <div class="area-tabs" style="margin-bottom:14px">${areaTabs}</div>
  ${state.editMode ? `<div class="edit-mode-banner">✏️ Edit Layout is on — drag tables anywhere on the canvas. Changes save automatically.</div>` : ''}
  <div class="floor-canvas-wrap" id="floorCanvasWrap">
    <div id="floorCanvas" class="floor-canvas" style="width:${canvasW}px;height:${canvasH}px;${bgStyle}">
      ${tableEls || '<div class="empty-state" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">No tables here yet. Click "Edit Layout" then "+ Add Table".</div>'}
    </div>
  </div>
  ${!showingAll ? `<div class="panel-sub" style="margin-top:8px">🔍 Zoomed to ${area?esc(area.name):'Unassigned'}. <span class="linkBtn" style="cursor:pointer" onclick="switchArea('__all')">View full floor plan</span></div>` : ''}`;
}

window.switchArea = function(id){ state.editMode = false; state.currentAreaId = id; render(); };
window.toggleEditMode = function(){ state.editMode = !state.editMode; render(); };
window.toggleServerView = function(){ state.serverView = !state.serverView; render(); };

// Zoom/pan the canvas to fit the bounding box of whichever area's tables are
// currently in view, so filtering by area frames just that part of the sketch.
function fitFloorCanvasView(){
  const wrap = document.getElementById('floorCanvasWrap');
  const canvas = document.getElementById('floorCanvas');
  if (!wrap || !canvas) return;

  const tables = state.currentAreaId === '__all' ? null
    : state.currentAreaId === '__unassigned' ? state.tables.filter(t => !t.area_id)
    : state.tables.filter(t => t.area_id === state.currentAreaId);

  if (!tables || !tables.length){
    canvas.style.transform = 'none';
    canvas.dataset.scale = '1';
    wrap.scrollLeft = 0; wrap.scrollTop = 0;
    return;
  }

  const PAD = 90;
  const minX = Math.max(0, Math.min(...tables.map(t => t.pos_x)) - PAD);
  const minY = Math.max(0, Math.min(...tables.map(t => t.pos_y)) - PAD);
  const maxX = Math.max(...tables.map(t => t.pos_x + t.width)) + PAD;
  const maxY = Math.max(...tables.map(t => t.pos_y + t.height)) + PAD;
  const boxW = Math.max(1, maxX - minX), boxH = Math.max(1, maxY - minY);

  const scale = Math.max(0.3, Math.min(4, Math.min(wrap.clientWidth / boxW, wrap.clientHeight / boxH)));
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `scale(${scale})`;
  canvas.dataset.scale = String(scale);
  wrap.scrollLeft = minX * scale;
  wrap.scrollTop = minY * scale;
}
function getCanvasScale(){
  return Number(document.getElementById('floorCanvas')?.dataset.scale) || 1;
}

window.cycleTableStatus = async function(id){
  const t = tableById(id);
  const order = ['available','reserved','seated','dirty','blocked'];
  const next = order[(order.indexOf(t.status)+1) % order.length];
  await sb.from('dining_tables').update({ status: next }).eq('id', id);
  await reloadTables();
  render();
};

// ---- Dragging (pointer events, works with mouse + touch/iPad) ----
window.startDragTable = function(ev, id){
  if (ev.target.classList.contains('resize-handle')) return; // let the resize handle own this gesture
  ev.preventDefault();
  const el = document.getElementById('tbl-'+id);
  if (!el) return;
  const startX = ev.clientX, startY = ev.clientY;
  const origLeft = parseFloat(el.style.left) || 0;
  const origTop = parseFloat(el.style.top) || 0;
  let moved = false;
  const scale = getCanvasScale();
  try { el.setPointerCapture(ev.pointerId); } catch(e){}

  function onMove(e){
    const dx = (e.clientX - startX) / scale, dy = (e.clientY - startY) / scale;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    el.style.left = Math.max(0, origLeft + dx) + 'px';
    el.style.top = Math.max(0, origTop + dy) + 'px';
  }
  async function onUp(){
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    if (moved){
      const newX = Math.round(parseFloat(el.style.left));
      const newY = Math.round(parseFloat(el.style.top));
      const t = tableById(id);
      if (t){ t.pos_x = newX; t.pos_y = newY; }
      await sb.from('dining_tables').update({ pos_x: newX, pos_y: newY }).eq('id', id);
    } else {
      openCanvasTableModal(id);
    }
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
};

// ---- Resizing (drag the corner handle) ----
window.startResizeTable = function(ev, id){
  ev.preventDefault();
  ev.stopPropagation();
  const handle = ev.currentTarget;
  const el = document.getElementById('tbl-'+id);
  if (!el) return;
  const startX = ev.clientX, startY = ev.clientY;
  const origW = parseFloat(el.style.width) || 80;
  const origH = parseFloat(el.style.height) || 80;
  const MIN_SIZE = 40;
  const scale = getCanvasScale();
  try { handle.setPointerCapture(ev.pointerId); } catch(e){}

  function onMove(e){
    const dx = (e.clientX - startX) / scale, dy = (e.clientY - startY) / scale;
    el.style.width = Math.max(MIN_SIZE, origW + dx) + 'px';
    el.style.height = Math.max(MIN_SIZE, origH + dy) + 'px';
  }
  async function onUp(){
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    const newW = Math.round(parseFloat(el.style.width));
    const newH = Math.round(parseFloat(el.style.height));
    const t = tableById(id);
    if (t){ t.width = newW; t.height = newH; }
    await sb.from('dining_tables').update({ width: newW, height: newH }).eq('id', id);
  }
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
};

// ---- Areas: create / rename / delete (just groupings/filters — background lives in openBackgroundModal) ----
window.openAreaModal = function(id){
  const a = id ? state.areas.find(x => x.id === id) : null;
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${a ? 'Rename Area' : 'New Area'}</h3>
    <label class="field-label">Area name</label>
    <input type="text" class="modal-input" id="areaName" placeholder="e.g. Patio, Main Dining, Private Room" value="${esc(a?.name||'')}"/>
    <p style="font-size:12px;color:var(--gray);margin-top:-4px">Areas are just groupings for filtering tables — everyone shares one floor plan image, set via "🖼 Floor Plan Image" on the toolbar.</p>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:14px 0 4px;">
      <input type="checkbox" id="areaBookable" ${(a ? a.bookable : true) ? 'checked' : ''}/> Bookable through the reservation system by default
    </label>
    <p style="font-size:12px;color:var(--gray);margin-top:0">Turn this off for areas like an uncovered patio that shouldn't be offered when booking (e.g. weather-dependent). Tables here still show on the Floor Plan for walk-ins and status tracking either way. Use "📅 Area Availability" on the Reservations tab to override this for a single day (e.g. blocking a room that's rented for a private party, or opening the patio on a nice day).</p>
    <div class="modal-actions">
      ${a ? `<button class="modal-btn modal-btn-danger" onclick="deleteArea('${a.id}')">Delete Area</button>` : ''}
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveArea(${a?`'${a.id}'`:'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

// ---- Shared floor plan background image (one canvas for the whole restaurant) ----
window.openBackgroundModal = function(){
  const fp = state.floorPlan;
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Floor Plan Image</h3>
    <p style="font-size:12px;color:var(--gray)">Upload a photo, blueprint, or rough sketch of your restaurant. All areas share this one image — drag tables onto it from any area tab or "All Areas".</p>
    ${fp.background_image_url ? `<img src="${esc(fp.background_image_url)}" style="width:100%;border-radius:8px;margin:10px 0;border:1px solid var(--border)"/>` : ''}
    <input type="file" accept="image/*" id="fpImageInput" style="display:none" onchange="uploadFloorPlanImage(event)"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-primary" onclick="document.getElementById('fpImageInput').click()">🖼 ${fp.background_image_url ? 'Replace' : 'Upload'} Image</button>
      ${fp.background_image_url ? `<button class="modal-btn modal-btn-secondary" onclick="removeFloorplanImage()">Remove Image</button>` : ''}
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveArea = async function(id){
  const name = document.getElementById('areaName').value.trim();
  const bookable = document.getElementById('areaBookable').checked;
  if (!name){ alert('Enter an area name.'); return; }
  if (id){
    await sb.from('floor_areas').update({ name, bookable }).eq('id', id);
  } else {
    const { data, error } = await sb.from('floor_areas').insert({ name, bookable, sort_order: state.areas.length }).select().single();
    if (error){ alert('Error: '+error.message); return; }
    state.currentAreaId = data.id;
  }
  closeModal('formModal');
  await reloadAreas();
  render();
};

window.deleteArea = async function(id){
  if (!confirm('Delete this area? Its tables will move to "Unassigned" (not deleted).')) return;
  await sb.from('floor_areas').delete().eq('id', id);
  closeModal('formModal');
  await Promise.all([reloadAreas(), reloadTables()]);
  render();
};

window.uploadFloorPlanImage = async function(ev){
  const file = ev.target.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop();
  const path = `floorplan-${Date.now()}.${ext}`;
  const { error } = await sb.storage.from('floorplans').upload(path, file, { upsert: true });
  if (error){ alert('Upload failed: '+error.message); return; }
  const { data } = sb.storage.from('floorplans').getPublicUrl(path);

  // Size the shared canvas to match the uploaded image's real proportions so it
  // isn't stretched/cropped by a mismatched box (cap the longest side for usability).
  const dims = await new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 1200, h: 800 });
    img.src = data.publicUrl;
  });
  const MAX_SIDE = 1400;
  const scale = Math.min(1, MAX_SIDE / Math.max(dims.w, dims.h));
  const canvas_width = Math.round(dims.w * scale);
  const canvas_height = Math.round(dims.h * scale);

  await sb.from('floor_plan_settings').update({ background_image_url: data.publicUrl, canvas_width, canvas_height, updated_at: new Date().toISOString() }).eq('id', true);
  closeModal('formModal');
  await reloadFloorPlanSettings();
  render();
};

window.removeFloorplanImage = async function(){
  await sb.from('floor_plan_settings').update({ background_image_url: null }).eq('id', true);
  closeModal('formModal');
  await reloadFloorPlanSettings();
  render();
};

// ---- Tables on the canvas: add / edit / resize / rename / delete ----
window.addTableToCanvas = async function(){
  // On a specific area tab, new tables go there. On "All Areas" default to the
  // first area (reassignable in the edit modal); on "Unassigned" leave unassigned.
  const area = currentArea() || (state.currentAreaId === '__all' ? state.areas[0] : null);
  const n = state.tables.filter(t => t.area_id === (area?.id||null)).length + 1;
  const { data, error } = await sb.from('dining_tables').insert({
    label: 'Table '+n, area_id: area?.id || null, section: area?.name || null,
    min_party: 1, max_party: 4, seats: 4, shape: 'square',
    pos_x: 40, pos_y: 40, width: 80, height: 80, status: 'available',
  }).select().single();
  if (error){ alert('Error: '+error.message); return; }
  state.tables.push(data);
  render();
};

window.openCanvasTableModal = function(id){
  const t = tableById(id);
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Edit Table</h3>
    <label class="field-label">Table name</label>
    <input type="text" class="modal-input" id="ctName" value="${esc(t.label)}"/>
    <div class="formgrid">
      <div><label class="field-label">Area</label>
        <select class="modal-select" id="ctArea">
          <option value="">Unassigned</option>
          ${state.areas.map(a => `<option value="${a.id}" ${a.id===t.area_id?'selected':''}>${esc(a.name)}</option>`).join('')}
        </select>
      </div>
      <div><label class="field-label">Shape</label>
        <select class="modal-select" id="ctShape">
          ${['square','round','rect'].map(s => `<option value="${s}" ${s===t.shape?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="formgrid">
      <div><label class="field-label">Seats</label><input type="number" min="1" class="modal-input" id="ctSeats" value="${t.seats}"/></div>
      <div><label class="field-label">Status</label>
        <select class="modal-select" id="ctStatus">
          ${['available','reserved','seated','dirty','blocked'].map(s => `<option value="${s}" ${s===t.status?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="formgrid">
      <div><label class="field-label">Min party</label><input type="number" min="1" class="modal-input" id="ctMin" value="${t.min_party}"/></div>
      <div><label class="field-label">Max party</label><input type="number" min="1" class="modal-input" id="ctMax" value="${t.max_party}"/></div>
    </div>
    ${t.max_party > t.seats ? `<div class="panel-sub" style="color:var(--warn);margin-top:-6px">⚠️ Max party (${t.max_party}) is higher than Seats (${t.seats}) — the app will still only offer this table to parties of ${t.seats} or fewer.</div>` : ''}
    <div class="formgrid">
      <div><label class="field-label">Width (px)</label><input type="number" min="40" class="modal-input" id="ctWidth" value="${t.width}"/></div>
      <div><label class="field-label">Height (px)</label><input type="number" min="40" class="modal-input" id="ctHeight" value="${t.height}"/></div>
    </div>
    <label class="field-label">Server Section</label>
    <select class="modal-select" id="ctServerSection">
      <option value="">No section</option>
      ${state.serverSections.map(s => `<option value="${s.id}" ${s.id===t.server_section_id?'selected':''}>${esc(s.name)}${s.assigned_staff_id ? ' — '+esc(state.staffList.find(st=>st.id===s.assigned_staff_id)?.name||'') : ''}</option>`).join('')}
    </select>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-danger" onclick="deleteCanvasTable('${t.id}')">Delete Table</button>
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveCanvasTable('${t.id}')">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveCanvasTable = async function(id){
  const areaId = document.getElementById('ctArea').value || null;
  const area = state.areas.find(a => a.id === areaId);
  const payload = {
    label: document.getElementById('ctName').value.trim() || 'Table',
    area_id: areaId,
    section: area ? area.name : null,
    shape: document.getElementById('ctShape').value,
    seats: Number(document.getElementById('ctSeats').value)||1,
    status: document.getElementById('ctStatus').value,
    min_party: Number(document.getElementById('ctMin').value)||1,
    max_party: Number(document.getElementById('ctMax').value)||1,
    width: Number(document.getElementById('ctWidth').value)||80,
    height: Number(document.getElementById('ctHeight').value)||80,
    server_section_id: document.getElementById('ctServerSection').value || null,
  };
  const { error } = await sb.from('dining_tables').update(payload).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadTables();
  render();
};

window.deleteCanvasTable = async function(id){
  if (!confirm('Delete this table? This cannot be undone.')) return;
  await sb.from('dining_tables').delete().eq('id', id);
  closeModal('formModal');
  await reloadTables();
  render();
};

// ============================================================================
// WAITLIST TAB
// ============================================================================
function renderWaitlistTab(){
  const list = state.waitlist.slice().sort((a,b) => new Date(a.added_at)-new Date(b.added_at));
  const items = list.length ? list.map(w => `
    <div class="res-item status-pending">
      <div class="res-time">${minutesAgo(w.added_at)}m</div>
      <div class="res-main">
        <div class="res-name">${esc(w.guest_name || guestName(guestById(w.guest_id)))} · ${w.party_size} guests</div>
        <div class="res-meta">Quoted ${w.quoted_wait_minutes} min · ${esc(w.phone||'')}</div>
      </div>
      <div class="res-actions">
        <button class="btn btn-sm btn-success" onclick="seatFromWaitlist('${w.id}')">Seat</button>
        <button class="btn btn-sm btn-danger" onclick="removeFromWaitlist('${w.id}','removed')">Remove</button>
      </div>
    </div>`).join('') : `<div class="empty-state"><div class="empty-state-icon">⏱️</div>Nobody waiting right now.</div>`;

  return `
  <div class="panel-header">
    <div><h2 class="panel-title">Waitlist</h2><div class="panel-sub">${list.length} parties waiting</div></div>
    <button class="btn btn-primary" onclick="openWaitlistModal()">+ Add to Waitlist</button>
  </div>
  <div class="res-list">${items}</div>`;
}

window.openWaitlistModal = function(prefill){
  const p = prefill || {};
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Add to Waitlist</h3>
    <label class="field-label">Guest name</label>
    <input type="text" class="modal-input" id="wlName" placeholder="Name" value="${esc(p.name||'')}"/>
    <div class="formgrid">
      <div><label class="field-label">Phone</label><input type="tel" class="modal-input" id="wlPhone" value="${esc(p.phone||'')}"/></div>
      <div><label class="field-label">Party size</label><input type="number" min="1" class="modal-input" id="wlParty" value="${p.party||2}"/></div>
    </div>
    <label class="field-label">Quoted wait (minutes)</label>
    <input type="number" min="0" class="modal-input" id="wlWait" value="15"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveWaitlist()">Add</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveWaitlist = async function(){
  const payload = {
    guest_name: document.getElementById('wlName').value.trim(),
    phone: document.getElementById('wlPhone').value.trim(),
    party_size: Number(document.getElementById('wlParty').value)||1,
    quoted_wait_minutes: Number(document.getElementById('wlWait').value)||0,
  };
  const { error } = await sb.from('waitlist').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadWaitlist();
  render();
};

async function reloadWaitlist(){
  const { data } = await sb.from('waitlist').select('*').eq('status','waiting').order('added_at');
  state.waitlist = data || [];
}

window.removeFromWaitlist = async function(id, status){
  await sb.from('waitlist').update({ status }).eq('id', id);
  await reloadWaitlist();
  render();
};

window.seatFromWaitlist = async function(id){
  const w = state.waitlist.find(x => x.id === id);
  await sb.from('waitlist').update({ status:'seated', seated_at: new Date().toISOString() }).eq('id', id);
  await sb.from('reservations').insert({
    guest_id: w.guest_id, party_size: w.party_size, reservation_date: todayISO(),
    reservation_time: new Date().toTimeString().slice(0,5), status:'seated',
    source:'walk-in', seated_at: new Date().toISOString(), created_by: currentStaff.id,
  });
  await Promise.all([reloadWaitlist(), reloadReservationsForDate()]);
  render();
};

// ============================================================================
// GUESTS TAB
// ============================================================================
let _guestSearch = '';
function renderGuestsTab(){
  const q = _guestSearch.toLowerCase();
  const list = state.guests.filter(g => !q || guestName(g).toLowerCase().includes(q) || (g.phone||'').includes(q)).slice(0,60);
  const items = list.length ? list.map(g => `
    <div class="guest-item" onclick="openGuestModal('${g.id}')">
      <div>
        <div class="res-name">${esc(guestName(g))} ${g.vip ? '<span class="badge badge-vip">VIP</span>':''}</div>
        <div class="res-meta">${esc(g.phone||'no phone')} · ${g.visit_count} visits${g.no_show_count ? ' · '+g.no_show_count+' no-shows':''}</div>
      </div>
      <div>${(g.tags||[]).map(t=>`<span class="badge badge-confirmed">${esc(t)}</span>`).join(' ')}</div>
    </div>`).join('') : `<div class="empty-state"><div class="empty-state-icon">👥</div>No guests found.</div>`;

  return `
  <div class="panel-header">
    <div><h2 class="panel-title">Guests</h2><div class="panel-sub">${state.guests.length} total guests on file</div></div>
    <button class="btn btn-primary" onclick="openGuestModal()">+ New Guest</button>
  </div>
  <input type="text" class="search-input" placeholder="Search by name or phone…" value="${esc(_guestSearch)}" oninput="searchGuests(this.value)"/>
  ${items}`;
}

window.searchGuests = function(v){ _guestSearch = v; render(); };

window.openGuestModal = function(id){
  const g = id ? guestById(id) : null;
  const history = id ? state.reservations.filter(r => r.guest_id === id) : [];
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${g ? 'Edit Guest' : 'New Guest'}</h3>
    <div class="formgrid">
      <div><label class="field-label">First name</label><input type="text" class="modal-input" id="gFirst" value="${esc(g?.first_name||'')}"/></div>
      <div><label class="field-label">Last name</label><input type="text" class="modal-input" id="gLast" value="${esc(g?.last_name||'')}"/></div>
    </div>
    <div class="formgrid">
      <div><label class="field-label">Phone</label><input type="tel" class="modal-input" id="gPhone" value="${esc(g?.phone||'')}"/></div>
      <div><label class="field-label">Email</label><input type="email" class="modal-input" id="gEmail" value="${esc(g?.email||'')}"/></div>
    </div>
    <label class="field-label">Allergies / dietary</label>
    <input type="text" class="modal-input" id="gAllergies" value="${esc(g?.allergies||'')}"/>
    <label class="field-label">Notes</label>
    <textarea class="modal-textarea" id="gNotes">${esc(g?.notes||'')}</textarea>
    <label class="field-label">Tags (comma separated)</label>
    <input type="text" class="modal-input" id="gTags" value="${esc((g?.tags||[]).join(', '))}"/>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;">
      <input type="checkbox" id="gVip" ${g?.vip ? 'checked':''}/> VIP guest
    </label>
    ${g ? `<div class="modal-section"><h4>Stats</h4><div class="res-meta">${g.visit_count} visits · ${g.no_show_count} no-shows · last visit ${g.last_visit_at ? new Date(g.last_visit_at).toLocaleDateString() : 'never'}</div>
      ${history.length ? `<div style="margin-top:8px">${history.map(r=>`<div class="res-meta">${r.reservation_date} ${fmtTime(r.reservation_time)} — ${r.status}</div>`).join('')}</div>`:''}
      </div>` : ''}
    <div class="modal-actions">
      ${g ? `<button class="modal-btn modal-btn-danger" onclick="deleteGuest('${g.id}')">Delete</button>` : ''}
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveGuest(${g ? `'${g.id}'` : 'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveGuest = async function(id){
  const payload = {
    first_name: document.getElementById('gFirst').value.trim(),
    last_name: document.getElementById('gLast').value.trim(),
    phone: document.getElementById('gPhone').value.trim(),
    email: document.getElementById('gEmail').value.trim(),
    allergies: document.getElementById('gAllergies').value.trim(),
    notes: document.getElementById('gNotes').value.trim(),
    tags: document.getElementById('gTags').value.split(',').map(s=>s.trim()).filter(Boolean),
    vip: document.getElementById('gVip').checked,
  };
  const { error } = id
    ? await sb.from('guests').update(payload).eq('id', id)
    : await sb.from('guests').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  const { data } = await sb.from('guests').select('*').order('last_name');
  state.guests = data || [];
  render();
};

window.deleteGuest = async function(id){
  if (!confirm('Delete this guest record?')) return;
  await sb.from('guests').delete().eq('id', id);
  closeModal('formModal');
  state.guests = state.guests.filter(g => g.id !== id);
  render();
};

// ============================================================================
// DASHBOARD TAB
// ============================================================================
function renderDashboardTab(){
  return `
  <div class="panel-header">
    <div><h2 class="panel-title">Management Dashboard</h2><div class="panel-sub">Key performance indicators</div></div>
    <div class="chip-row" style="margin:0">
      ${[1,7,30,90].map(n => `<span class="chip ${state.dashRange===n?'active':''}" onclick="setDashRange(${n})">${n===1?'Today':n+'d'}</span>`).join('')}
    </div>
  </div>
  <div id="dashBody"><div class="empty-state">Loading…</div></div>`;
}

window.setDashRange = function(n){ state.dashRange = n; render(); };

async function loadDashboard(){
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (state.dashRange - 1));
  const startISO = start.toISOString().slice(0,10);
  const endISO = end.toISOString().slice(0,10);

  const [{ data: kpiRows }, { data: allRes }] = await Promise.all([
    sb.from('kpi_daily').select('*').gte('day', startISO).lte('day', endISO),
    sb.from('reservations').select('reservation_time,party_size,status,guest_id').gte('reservation_date', startISO).lte('reservation_date', endISO),
  ]);
  const rows = kpiRows || [];
  const totalRes = rows.reduce((s,r)=>s+r.total_reservations,0);
  const totalCovers = rows.reduce((s,r)=>s+r.total_covers,0);
  const noShows = rows.reduce((s,r)=>s+r.no_shows,0);
  const cancellations = rows.reduce((s,r)=>s+r.cancellations,0);
  const walkIns = rows.reduce((s,r)=>s+r.walk_ins,0);
  const completed = rows.reduce((s,r)=>s+r.completed_count,0);
  const noShowRate = totalRes ? Math.round(noShows/totalRes*100) : 0;
  const cancelRate = totalRes ? Math.round(cancellations/totalRes*100) : 0;
  const avgParty = totalRes ? (rows.reduce((s,r)=>s+(r.avg_party_size*r.total_reservations),0)/totalRes).toFixed(1) : '0.0';

  const guestVisits = {};
  (allRes||[]).forEach(r => { if (r.guest_id) guestVisits[r.guest_id] = (guestVisits[r.guest_id]||0)+1; });
  const uniqueGuests = Object.keys(guestVisits).length;
  const repeatGuests = Object.values(guestVisits).filter(c => c > 1).length;
  const repeatRate = uniqueGuests ? Math.round(repeatGuests/uniqueGuests*100) : 0;

  const hourCounts = {};
  (allRes||[]).forEach(r => {
    const h = Number((r.reservation_time||'0').split(':')[0]);
    hourCounts[h] = (hourCounts[h]||0) + 1;
  });
  const maxHourCount = Math.max(1, ...Object.values(hourCounts));
  const hourBars = Object.keys(hourCounts).map(Number).sort((a,b)=>a-b).map(h => `
    <div class="bar-row">
      <div class="bar-label">${fmtTime(String(h).padStart(2,'0')+':00')}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${hourCounts[h]/maxHourCount*100}%"></div></div>
      <div class="bar-value">${hourCounts[h]}</div>
    </div>`).join('');

  const el = document.getElementById('dashBody');
  if (!el) return;
  el.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="kpi-card"><div class="kpi-value">${totalCovers}</div><div class="kpi-label">Total Covers</div></div>
      <div class="kpi-card"><div class="kpi-value">${totalRes}</div><div class="kpi-label">Reservations</div></div>
      <div class="kpi-card"><div class="kpi-value">${completed}</div><div class="kpi-label">Completed</div></div>
      <div class="kpi-card"><div class="kpi-value">${avgParty}</div><div class="kpi-label">Avg Party Size</div></div>
      <div class="kpi-card"><div class="kpi-value">${noShowRate}%</div><div class="kpi-label">No-Show Rate</div></div>
      <div class="kpi-card"><div class="kpi-value">${cancelRate}%</div><div class="kpi-label">Cancellation Rate</div></div>
      <div class="kpi-card"><div class="kpi-value">${walkIns}</div><div class="kpi-label">Walk-Ins</div></div>
      <div class="kpi-card"><div class="kpi-value">${repeatRate}%</div><div class="kpi-label">Repeat Guest Rate</div></div>
    </div>
    <div class="section-heading">Reservations by Hour</div>
    <div class="card">${hourBars || '<div class="empty-state">No data in this range.</div>'}</div>`;
}

// ============================================================================
// SETTINGS TAB (tables, service periods, staff)
// ============================================================================
function renderSettingsTab(){
  const isAdmin = currentStaff.role === 'admin';
  return `
  <div class="panel-header"><h2 class="panel-title">Settings</h2></div>

  <div class="section-heading">Dining Tables &amp; Floor Plan</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">${state.tables.filter(t=>!t.is_combo).length} tables across ${state.areas.length} area${state.areas.length===1?'':'s'}. Add, rename, resize, delete, and drag-position tables on your floor plan sketch from the <b>Floor Plan</b> tab.</div>
    <table class="data-table">
      <thead><tr><th>Area</th><th>Table Count</th></tr></thead>
      <tbody>
        ${state.areas.map(a => `<tr><td>${esc(a.name)}</td><td>${state.tables.filter(t=>t.area_id===a.id).length}</td></tr>`).join('')}
        ${state.tables.some(t=>!t.area_id) ? `<tr><td>Unassigned</td><td>${state.tables.filter(t=>!t.area_id).length}</td></tr>` : ''}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="setTab('floorplan')">🗺️ Open Floor Plan Editor</button></div>
  </div>

  <div class="section-heading">Server Sections</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Group tables into color-coded sections and assign a server to each. Turn on "🎨 Server View" on the Floor Plan tab to see the floor colored by section instead of table status. Assign individual tables to a section from the table's edit panel on the Floor Plan tab.</div>
    <table class="data-table">
      <thead><tr><th>Color</th><th>Section</th><th>Assigned Server</th><th>Tables</th><th></th></tr></thead>
      <tbody>
        ${state.serverSections.map(s => `<tr>
          <td><span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:${esc(s.color)};border:1px solid var(--border)"></span></td>
          <td>${esc(s.name)}</td>
          <td>
            <select class="modal-select" style="margin:0;padding:4px 8px" onchange="setSectionServer('${s.id}', this.value)">
              <option value="">Unassigned</option>
              ${state.staffList.filter(st=>st.active).map(st => `<option value="${st.id}" ${st.id===s.assigned_staff_id?'selected':''}>${esc(st.name)}</option>`).join('')}
            </select>
          </td>
          <td>${state.tables.filter(t=>t.server_section_id===s.id).length}</td>
          <td><button class="btn btn-sm btn-danger" onclick="deleteServerSection('${s.id}')">Delete</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="openServerSectionModal()">+ Add Section</button></div>
  </div>

  <div class="section-heading">Table Combinations</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Predefine which tables can be pushed together for larger parties (e.g. two 4-tops = a 6-8 top). A combo shows up automatically as a bookable option once a party is too big for any single table, and it's protected from ever double-booking against its member tables.</div>
    <table class="data-table">
      <thead><tr><th>Combo</th><th>Members</th><th>Combined Seats</th><th></th></tr></thead>
      <tbody>
        ${state.tables.filter(t=>t.is_combo).map(t => `<tr>
          <td>${esc(t.label)}</td>
          <td>${(state.comboMembers[t.id]||[]).map(id => esc(tableById(id)?.label||'?')).join(' + ')}</td>
          <td>${t.seats}</td>
          <td><button class="btn btn-sm btn-danger" onclick="deleteTableCombo('${t.id}')">Delete</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="openTableComboModal()">+ Add Combination</button></div>
  </div>

  <div class="section-heading">Service Periods</div>
  <div class="card">
    <table class="data-table">
      <thead><tr><th>Name</th><th>Hours</th><th>Turn Time</th><th></th></tr></thead>
      <tbody>
        ${state.servicePeriods.map(sp => `<tr>
          <td>${esc(sp.name)}</td><td>${fmtTime(sp.start_time)} – ${fmtTime(sp.end_time)}</td><td>${sp.default_turn_minutes} min</td>
          <td><button class="btn btn-sm btn-secondary" onclick="deleteServicePeriod('${sp.id}')">Remove</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="openServicePeriodModal()">+ Add Service Period</button></div>
  </div>

  ${isAdmin ? `
  <div class="section-heading">Staff Access</div>
  <div class="card">
    <table class="data-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.staffList.map(s => `<tr>
          <td>${esc(s.name)}</td><td>${esc(s.email)}</td>
          <td>
            <select class="modal-select" style="margin:0;padding:4px 8px" onchange="setStaffRole('${s.id}', this.value)">
              ${['host','server','manager','admin'].map(r => `<option value="${r}" ${r===s.role?'selected':''}>${r}</option>`).join('')}
            </select>
          </td>
          <td>${s.active ? '<span class="badge badge-confirmed">active</span>' : '<span class="badge badge-pending">pending</span>'}</td>
          <td><button class="btn btn-sm ${s.active?'btn-danger':'btn-success'}" onclick="toggleStaffActive('${s.id}', ${!s.active})">${s.active?'Deactivate':'Approve'}</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}`;
}

window.openServerSectionModal = function(){
  const box = document.getElementById('formModalBox');
  const defaultColors = ['#0070f2','#dc2626','#16a34a','#d97706','#7c3aed','#0891b2','#db2777','#65a30d'];
  const nextColor = defaultColors[state.serverSections.length % defaultColors.length];
  box.innerHTML = `
    <h3>New Server Section</h3>
    <label class="field-label">Section name</label>
    <input type="text" class="modal-input" id="ssName" placeholder="Section A"/>
    <label class="field-label">Color</label>
    <input type="color" class="modal-input" id="ssColor" value="${nextColor}" style="padding:4px;height:42px"/>
    <label class="field-label">Assign server</label>
    <select class="modal-select" id="ssStaff">
      <option value="">Unassigned</option>
      ${state.staffList.filter(st=>st.active).map(st => `<option value="${st.id}">${esc(st.name)}</option>`).join('')}
    </select>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveServerSection()">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveServerSection = async function(){
  const payload = {
    name: document.getElementById('ssName').value.trim() || 'Section',
    color: document.getElementById('ssColor').value,
    assigned_staff_id: document.getElementById('ssStaff').value || null,
    sort_order: state.serverSections.length,
  };
  const { error } = await sb.from('server_sections').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadServerSections();
  render();
};

window.setSectionServer = async function(id, staffId){
  await sb.from('server_sections').update({ assigned_staff_id: staffId || null }).eq('id', id);
  await reloadServerSections();
};

window.deleteServerSection = async function(id){
  if (!confirm('Delete this section? Tables in it will show "No section" but are not deleted.')) return;
  await sb.from('server_sections').delete().eq('id', id);
  await reloadServerSections();
  await reloadTables();
  render();
};

window.openTableComboModal = function(){
  const box = document.getElementById('formModalBox');
  const candidates = state.tables.filter(t => t.active && !t.is_combo);
  box.innerHTML = `
    <h3>New Table Combination</h3>
    <p style="font-size:12px;color:var(--gray)">Pick two or more tables that can be pushed together. Seats and party-size range are computed automatically.</p>
    <div class="chip-row" id="comboMemberPicker">
      ${candidates.map(t => `<span class="chip" data-id="${t.id}" onclick="this.classList.toggle('active')">${esc(t.label)} (${t.seats})</span>`).join('')}
    </div>
    <label class="field-label">Combo name</label>
    <input type="text" class="modal-input" id="comboName" placeholder="e.g. 3 + 4"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveTableCombo()">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveTableCombo = async function(){
  const chosen = [...document.querySelectorAll('#comboMemberPicker .chip.active')].map(el => el.dataset.id);
  if (chosen.length < 2){ alert('Pick at least two tables to combine.'); return; }
  const members = chosen.map(id => tableById(id)).filter(Boolean);
  const seats = members.reduce((s,t) => s+t.seats, 0);
  const biggestSingle = Math.max(...members.map(t => t.seats));
  const name = document.getElementById('comboName').value.trim() || members.map(t=>t.label).join('+');

  const { data: combo, error } = await sb.from('dining_tables').insert({
    label: name, is_combo: true, active: true, status: 'available',
    seats, min_party: biggestSingle + 1, max_party: seats,
    area_id: members[0].area_id, section: members[0].section,
    pos_x: 0, pos_y: 0, width: 80, height: 80,
  }).select().single();
  if (error){ alert('Error: '+error.message); return; }

  const { error: memErr } = await sb.from('table_combo_members').insert(chosen.map(id => ({ combo_table_id: combo.id, member_table_id: id })));
  if (memErr){ alert('Error linking members: '+memErr.message); return; }

  closeModal('formModal');
  await Promise.all([reloadTables(), reloadCombos()]);
  render();
};

window.deleteTableCombo = async function(id){
  if (!confirm('Delete this combination? Its member tables are unaffected.')) return;
  await sb.from('dining_tables').delete().eq('id', id);
  await Promise.all([reloadTables(), reloadCombos()]);
  render();
};

window.openServicePeriodModal = function(){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>New Service Period</h3>
    <label class="field-label">Name</label>
    <input type="text" class="modal-input" id="spName" placeholder="Dinner"/>
    <div class="formgrid">
      <div><label class="field-label">Start</label><input type="time" class="modal-input" id="spStart" value="17:00"/></div>
      <div><label class="field-label">End</label><input type="time" class="modal-input" id="spEnd" value="22:00"/></div>
    </div>
    <label class="field-label">Default turn time (minutes)</label>
    <input type="number" min="15" class="modal-input" id="spTurn" value="90"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveServicePeriod()">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveServicePeriod = async function(){
  const payload = {
    name: document.getElementById('spName').value.trim(),
    start_time: document.getElementById('spStart').value,
    end_time: document.getElementById('spEnd').value,
    default_turn_minutes: Number(document.getElementById('spTurn').value)||90,
  };
  const { error } = await sb.from('service_periods').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  const { data } = await sb.from('service_periods').select('*').order('start_time');
  state.servicePeriods = data || [];
  render();
};

window.deleteServicePeriod = async function(id){
  await sb.from('service_periods').delete().eq('id', id);
  const { data } = await sb.from('service_periods').select('*').order('start_time');
  state.servicePeriods = data || [];
  render();
};

window.toggleStaffActive = async function(id, active){
  await sb.from('staff').update({ active }).eq('id', id);
  const { data } = await sb.from('staff').select('*').order('created_at');
  state.staffList = data || [];
  render();
};

window.setStaffRole = async function(id, role){
  await sb.from('staff').update({ role }).eq('id', id);
  const { data } = await sb.from('staff').select('*').order('created_at');
  state.staffList = data || [];
};

// ============================================================================
// MODAL HELPERS
// ============================================================================
window.closeModal = function(id){ document.getElementById(id).classList.add('hidden'); };
window.openAccountModal = function(){ document.getElementById('accountModal').classList.remove('hidden'); };
window.todayISO = todayISO;
