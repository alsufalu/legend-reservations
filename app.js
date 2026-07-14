// ============================================================================
// LEGEND RESERVATIONS — Host Stand & Management Console
// Vanilla HTML/CSS/JS + Supabase (auth, Postgres, RLS). No build step.
// ============================================================================

const SUPABASE_URL = 'https://bnjtoobxqfvosbvwnrie.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJuanRvb2J4cWZ2b3NidnducmllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTQ4MzksImV4cCI6MjA5OTU5MDgzOX0.2Zpknuae2DIhHhMLyKZ78kvId1RoT9a-M7oqxFTImuE';
const ADMIN_EMAIL = 'aerubio1@yahoo.com';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let currentStaff = null;
let _authMode = 'signin';

let state = {
  tab: 'reservations',
  selectedDate: todayISO(),
  reservations: [],
  tables: [],
  areas: [],
  currentAreaId: null,
  editMode: false,
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
function guestName(g){
  if(!g) return 'Walk-in';
  return `${g.first_name||''} ${g.last_name||''}`.trim() || g.phone || 'Guest';
}
function guestById(id){ return state.guests.find(g => g.id === id); }
function tableById(id){ return state.tables.find(t => t.id === id); }
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
    const [tablesRes, areasRes, guestsRes, waitlistRes, staffRes, spRes, resRes] = await Promise.all([
      sb.from('dining_tables').select('*').order('label'),
      sb.from('floor_areas').select('*').order('sort_order').order('created_at'),
      sb.from('guests').select('*').order('last_name'),
      sb.from('waitlist').select('*').eq('status','waiting').order('added_at'),
      sb.from('staff').select('*').order('created_at'),
      sb.from('service_periods').select('*').order('start_time'),
      sb.from('reservations').select('*').eq('reservation_date', state.selectedDate).order('reservation_time'),
    ]);
    state.tables = tablesRes.data || [];
    state.areas = areasRes.data || [];
    state.guests = guestsRes.data || [];
    state.waitlist = waitlistRes.data || [];
    state.staffList = staffRes.data || [];
    state.servicePeriods = spRes.data || [];
    state.reservations = resRes.data || [];
    if (!state.currentAreaId && state.areas.length) state.currentAreaId = state.areas[0].id;
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
  else if (state.tab === 'floorplan') c.innerHTML = renderFloorPlanTab();
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
          ${t ? ` · Table ${esc(t.label)}` : ' · No table assigned'}
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

  return `
  <div class="panel-header">
    <div>
      <h2 class="panel-title">Reservations</h2>
      <div class="panel-sub">${activeCount} reservations · ${covers} covers booked</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <input type="date" class="search-input" style="margin:0;width:auto" value="${state.selectedDate}" onchange="changeDate(this.value)"/>
      <button class="btn btn-secondary" onclick="changeDate(todayISO())">Today</button>
      <button class="btn btn-primary" onclick="openReservationModal()">+ New Reservation</button>
    </div>
  </div>
  <div class="res-list">${items}</div>`;
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
  const available = state.tables.filter(t => t.active && ['available','reserved'].includes(t.status));
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Seat Reservation</h3>
    <p class="modal-user-email">${esc(guestName(guestById(r.guest_id)))} · ${r.party_size} guests</p>
    <label class="field-label">Assign Table</label>
    <select class="modal-select" id="seatTableSelect">
      <option value="">No table / seat at bar</option>
      ${available.map(t => `<option value="${t.id}" ${t.id===r.table_id?'selected':''}>${esc(t.label)} (${t.section}, seats ${t.seats})</option>`).join('')}
    </select>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="confirmSeat('${id}')">Seat Now</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.confirmSeat = async function(id){
  const tableId = document.getElementById('seatTableSelect').value || null;
  await sb.from('reservations').update({ status:'seated', seated_at: new Date().toISOString(), table_id: tableId }).eq('id', id);
  if (tableId) await sb.from('dining_tables').update({ status:'seated' }).eq('id', tableId);
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
    <div class="formgrid">
      <div>
        <label class="field-label">Phone</label>
        <input type="tel" class="modal-input" id="resGuestPhone" value="${esc(g?.phone || '')}"/>
      </div>
      <div>
        <label class="field-label">Party size</label>
        <input type="number" min="1" class="modal-input" id="resPartySize" value="${r?.party_size || 2}"/>
      </div>
    </div>
    <div class="formgrid">
      <div>
        <label class="field-label">Date</label>
        <input type="date" class="modal-input" id="resDate" value="${r?.reservation_date || state.selectedDate}"/>
      </div>
      <div>
        <label class="field-label">Time</label>
        <input type="time" class="modal-input" id="resTime" value="${r?.reservation_time?.slice(0,5) || '18:00'}"/>
      </div>
    </div>
    <div class="formgrid">
      <div>
        <label class="field-label">Table (optional)</label>
        <select class="modal-select" id="resTable">
          <option value="">Unassigned</option>
          ${state.tables.filter(t=>t.active).map(t => `<option value="${t.id}" ${t.id===r?.table_id?'selected':''}>${esc(t.label)} (${t.section})</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="field-label">Source</label>
        <select class="modal-select" id="resSource">
          ${['phone','walk-in','online','website','other'].map(s => `<option value="${s}" ${s===(r?.source||'phone')?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
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

  const payload = {
    guest_id: guestId,
    party_size: Number(document.getElementById('resPartySize').value) || 1,
    reservation_date: document.getElementById('resDate').value,
    reservation_time: document.getElementById('resTime').value,
    table_id: document.getElementById('resTable').value || null,
    source: document.getElementById('resSource').value,
    occasion: document.getElementById('resOccasion').value.trim() || null,
    special_requests: document.getElementById('resNotes').value.trim() || null,
  };
  if (!id){ payload.created_by = currentStaff.id; payload.status = 'pending'; }

  const { error } = id
    ? await sb.from('reservations').update(payload).eq('id', id)
    : await sb.from('reservations').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
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
  if (state.currentAreaId !== '__unassigned' && !state.areas.find(a => a.id === state.currentAreaId)) state.currentAreaId = state.areas[0]?.id || null;
}
function currentArea(){ return state.areas.find(a => a.id === state.currentAreaId); }

function renderFloorPlanTab(){
  const activeRes = state.reservations.filter(r => r.status === 'seated');
  const area = currentArea();
  const unassignedCount = state.tables.filter(t => !t.area_id).length;

  const areaTabs = state.areas.map(a => `<span class="area-chip ${a.id===state.currentAreaId?'active':''}" onclick="switchArea('${a.id}')">${esc(a.name)}</span>`).join('')
    + (unassignedCount ? `<span class="area-chip ${state.currentAreaId==='__unassigned'?'active':''}" onclick="switchArea('__unassigned')">Unassigned (${unassignedCount})</span>` : '')
    + `<span class="area-chip-add" onclick="openAreaModal()">+ New Area</span>`;

  const tablesInArea = state.currentAreaId === '__unassigned'
    ? state.tables.filter(t => !t.area_id)
    : state.tables.filter(t => t.area_id === state.currentAreaId);

  const canvasW = area?.canvas_width || 1200;
  const canvasH = area?.canvas_height || 800;
  const bgStyle = area?.background_image_url ? `background-image:url('${esc(area.background_image_url)}');background-size:cover;background-position:center;` : '';

  const tableEls = tablesInArea.map(t => {
    const occ = activeRes.find(r => r.table_id === t.id);
    const dragAttr = state.editMode ? `onpointerdown="startDragTable(event,'${t.id}')"` : `onclick="cycleTableStatus('${t.id}')"`;
    return `
      <div id="tbl-${t.id}" class="floor-table shape-${t.shape} status-${t.status}" ${dragAttr}
           style="left:${t.pos_x}px;top:${t.pos_y}px;width:${t.width}px;height:${t.height}px;">
        <div class="ft-name">${esc(t.label)}</div>
        <div class="ft-meta">${t.seats} seats</div>
        ${occ ? `<div class="ft-meta">${esc(guestName(guestById(occ.guest_id)))}</div>` : ''}
      </div>`;
  }).join('');

  const toolbar = area ? `
    <button class="btn btn-secondary btn-sm" onclick="openAreaModal('${area.id}')">✏️ Rename / Background</button>
    ${state.editMode ? `<button class="btn btn-primary btn-sm" onclick="addTableToCanvas()">+ Add Table</button>` : ''}
    <button class="btn ${state.editMode?'btn-success':'btn-secondary'} btn-sm" onclick="toggleEditMode()">${state.editMode ? '✅ Done Editing' : '✏️ Edit Layout'}</button>
  ` : (state.currentAreaId === '__unassigned' ? `<span class="panel-sub">Assign these tables to an area via Edit Layout → tap a table.</span>` : '');

  return `
  <div class="panel-header">
    <div><h2 class="panel-title">Floor Plan</h2><div class="panel-sub">${state.editMode ? 'Drag tables to reposition. Tap a table to rename, resize, or delete.' : 'Tap a table to cycle its status.'}</div></div>
    <div class="floor-toolbar">${toolbar}</div>
  </div>
  <div class="area-tabs" style="margin-bottom:14px">${areaTabs || '<span class="panel-sub">No areas yet — create one to start placing tables.</span>'}</div>
  ${state.editMode ? `<div class="edit-mode-banner">✏️ Edit Layout is on — drag tables anywhere on the canvas. Changes save automatically.</div>` : ''}
  ${area ? `
  <div class="floor-canvas-wrap">
    <div id="floorCanvas" class="floor-canvas" style="width:${canvasW}px;height:${canvasH}px;${bgStyle}">
      ${tableEls || '<div class="empty-state" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">No tables in this area yet. Click "Edit Layout" then "+ Add Table".</div>'}
    </div>
  </div>` : (state.currentAreaId === '__unassigned' ? `
  <div class="grid grid-4">${tablesInArea.map(t => `<div class="table-card status-${t.status}" onclick="openCanvasTableModal('${t.id}')"><div class="table-label">${esc(t.label)}</div><div class="table-meta">Seats ${t.seats}</div></div>`).join('')}</div>
  ` : '')}`;
}

window.switchArea = function(id){ state.editMode = false; state.currentAreaId = id; render(); };
window.toggleEditMode = function(){ state.editMode = !state.editMode; render(); };

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
  ev.preventDefault();
  const el = document.getElementById('tbl-'+id);
  if (!el) return;
  const startX = ev.clientX, startY = ev.clientY;
  const origLeft = parseFloat(el.style.left) || 0;
  const origTop = parseFloat(el.style.top) || 0;
  let moved = false;
  try { el.setPointerCapture(ev.pointerId); } catch(e){}

  function onMove(e){
    const dx = e.clientX - startX, dy = e.clientY - startY;
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

// ---- Areas: create / rename / delete / background image ----
window.openAreaModal = function(id){
  const a = id ? state.areas.find(x => x.id === id) : null;
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${a ? 'Edit Area' : 'New Area'}</h3>
    <label class="field-label">Area name</label>
    <input type="text" class="modal-input" id="areaName" placeholder="e.g. Patio, Main Dining, Private Room" value="${esc(a?.name||'')}"/>
    ${a ? `
    <div class="modal-section">
      <h4>Floor Plan Background</h4>
      ${a.background_image_url ? `<img src="${esc(a.background_image_url)}" style="width:100%;border-radius:8px;margin-bottom:8px;border:1px solid var(--border)"/>` : `<p style="font-size:12px;color:var(--gray)">No sketch or floor plan image uploaded yet. Upload a photo or rough sketch of this area and drag tables onto it.</p>`}
      <input type="file" accept="image/*" id="areaImageInput" style="display:none" onchange="uploadFloorPlanImage(event,'${a.id}')"/>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-secondary" onclick="document.getElementById('areaImageInput').click()">🖼 ${a.background_image_url ? 'Replace' : 'Upload'} Image</button>
        ${a.background_image_url ? `<button class="modal-btn modal-btn-secondary" onclick="removeFloorplanImage('${a.id}')">Remove Image</button>` : ''}
      </div>
    </div>` : ''}
    <div class="modal-actions">
      ${a ? `<button class="modal-btn modal-btn-danger" onclick="deleteArea('${a.id}')">Delete Area</button>` : ''}
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveArea(${a?`'${a.id}'`:'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveArea = async function(id){
  const name = document.getElementById('areaName').value.trim();
  if (!name){ alert('Enter an area name.'); return; }
  if (id){
    await sb.from('floor_areas').update({ name }).eq('id', id);
  } else {
    const { data, error } = await sb.from('floor_areas').insert({ name, sort_order: state.areas.length }).select().single();
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

window.uploadFloorPlanImage = async function(ev, areaId){
  const file = ev.target.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop();
  const path = `area-${areaId}-${Date.now()}.${ext}`;
  const { error } = await sb.storage.from('floorplans').upload(path, file, { upsert: true });
  if (error){ alert('Upload failed: '+error.message); return; }
  const { data } = sb.storage.from('floorplans').getPublicUrl(path);
  await sb.from('floor_areas').update({ background_image_url: data.publicUrl }).eq('id', areaId);
  closeModal('formModal');
  await reloadAreas();
  render();
};

window.removeFloorplanImage = async function(areaId){
  await sb.from('floor_areas').update({ background_image_url: null }).eq('id', areaId);
  closeModal('formModal');
  await reloadAreas();
  render();
};

// ---- Tables on the canvas: add / edit / resize / rename / delete ----
window.addTableToCanvas = async function(){
  const area = currentArea();
  if (!area){ alert('Create an area first.'); return; }
  const n = state.tables.filter(t => t.area_id === area.id).length + 1;
  const { data, error } = await sb.from('dining_tables').insert({
    label: 'Table '+n, area_id: area.id, section: area.name,
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
    <div class="formgrid">
      <div><label class="field-label">Width (px)</label><input type="number" min="40" class="modal-input" id="ctWidth" value="${t.width}"/></div>
      <div><label class="field-label">Height (px)</label><input type="number" min="40" class="modal-input" id="ctHeight" value="${t.height}"/></div>
    </div>
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

window.openWaitlistModal = function(){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Add to Waitlist</h3>
    <label class="field-label">Guest name</label>
    <input type="text" class="modal-input" id="wlName" placeholder="Name"/>
    <div class="formgrid">
      <div><label class="field-label">Phone</label><input type="tel" class="modal-input" id="wlPhone"/></div>
      <div><label class="field-label">Party size</label><input type="number" min="1" class="modal-input" id="wlParty" value="2"/></div>
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
    <div class="panel-sub" style="margin-bottom:10px">${state.tables.length} tables across ${state.areas.length} area${state.areas.length===1?'':'s'}. Add, rename, resize, delete, and drag-position tables on your floor plan sketch from the <b>Floor Plan</b> tab.</div>
    <table class="data-table">
      <thead><tr><th>Area</th><th>Table Count</th></tr></thead>
      <tbody>
        ${state.areas.map(a => `<tr><td>${esc(a.name)}</td><td>${state.tables.filter(t=>t.area_id===a.id).length}</td></tr>`).join('')}
        ${state.tables.some(t=>!t.area_id) ? `<tr><td>Unassigned</td><td>${state.tables.filter(t=>!t.area_id).length}</td></tr>` : ''}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="setTab('floorplan')">🗺️ Open Floor Plan Editor</button></div>
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
