// ============================================================================
// LEGEND RESERVATIONS — Host Stand & Management Console
// Vanilla HTML/CSS/JS + Supabase (auth, Postgres, RLS). No build step.
// ============================================================================

const SUPABASE_URL = 'https://bnjtoobxqfvosbvwnrie.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJuanRvb2J4cWZ2b3NidnducmllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTQ4MzksImV4cCI6MjA5OTU5MDgzOX0.2Zpknuae2DIhHhMLyKZ78kvId1RoT9a-M7oqxFTImuE';
const ADMIN_EMAIL = 'aerubio1@yahoo.com';
const APP_VERSION = '2.01';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Table status color legend — customizable in Settings, persisted on
// floor_plan_settings.status_colors. This default mirrors the original hardcoded
// CSS colors so nothing changes visually until someone edits a color.
const STATUS_LABELS = { available:'Available', reserved:'Reserved', assigned:'Assigned (Pre-Seated)', seated:'Seated', dirty:'Needs Bussing', blocked:'Blocked / Out of Service' };
const STATUS_COLORS_DEFAULT = { available:'#16a34a', reserved:'#d97706', assigned:'#7c3aed', seated:'#dc2626', dirty:'#8492a6', blocked:'#9aa3b0' };
function statusColors(){ return { ...STATUS_COLORS_DEFAULT, ...(state.floorPlan?.status_colors || {}) }; }

// ---- "Now" override — lets staff simulate a different current date/time than
// the device clock for off-hours testing, without touching any real table or
// reservation data. Once set, it ticks forward at real speed from whatever
// moment it was set (rather than freezing), so elapsed-time displays like the
// Timeline "now" line and waitlist wait counters still behave naturally.
// Persisted in localStorage so it survives a page refresh — which is exactly
// why a loud, un-missable banner is shown across the whole app while it's
// active: an override left on by accident should never be silently forgotten
// before real service starts.
const NOW_OVERRIDE_KEY = 'legendResNowOverride';
function loadNowOverride(){
  try {
    const raw = localStorage.getItem(NOW_OVERRIDE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && o.targetMs && o.epochMs) ? o : null;
  } catch(e){ return null; }
}
let nowOverride = loadNowOverride();
function getNow(){
  return nowOverride ? new Date(nowOverride.targetMs + (Date.now() - nowOverride.epochMs)) : new Date();
}
window.setNowOverride = function(dateStr, timeStr){
  if (!dateStr || !timeStr){ alert('Pick both a date and a time.'); return; }
  const target = new Date(`${dateStr}T${timeStr}:00`);
  if (isNaN(target.getTime())){ alert('Invalid date/time.'); return; }
  nowOverride = { targetMs: target.getTime(), epochMs: Date.now() };
  localStorage.setItem(NOW_OVERRIDE_KEY, JSON.stringify(nowOverride));
  renderNowBanner();
  render();
};
window.clearNowOverride = function(){
  nowOverride = null;
  localStorage.removeItem(NOW_OVERRIDE_KEY);
  renderNowBanner();
  render();
};
function renderNowBanner(){
  const el = document.getElementById('nowOverrideBanner');
  if (!el) return;
  if (!nowOverride){ el.innerHTML = ''; return; }
  const label = getNow().toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  el.innerHTML = `<div style="background:#7c3aed;color:#fff;padding:8px 16px;display:flex;align-items:center;gap:10px;font-weight:700;font-size:13px;">
    🧪 TEST MODE — app thinks it's <span style="text-decoration:underline">${esc(label)}</span>, not the real time.
    <button class="btn btn-sm" style="background:#fff;color:#7c3aed;margin-left:auto;border:none" onclick="clearNowOverride()">Exit Test Mode</button>
  </div>`;
}
// A host needs to know what time it actually is to make any of the app's
// time-sensitive calls (pacing, the upcoming-reservation warning, whether
// someone's late) — but nothing on screen ever showed it outside of Test
// Mode. This is a small always-on clock in the topbar, visible on every tab,
// using getNow() so it correctly shows the Now Override time while testing
// and real local time otherwise. Formatting via toLocaleString(undefined, …)
// uses the browser's own locale/timezone automatically — no hardcoded
// timezone needed, it'll read correctly wherever the app is actually opened.
function renderTopbarClock(){
  const el = document.getElementById('topbarClock');
  if (!el) return;
  el.textContent = getNow().toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
}
setInterval(() => { renderTopbarClock(); if (nowOverride) renderNowBanner(); }, 30000);

// Show the version on the login screen and in the app topbar. No index.html edits
// needed for future bumps — just change APP_VERSION above and re-upload app.js.
(function stampVersion(){
  const stamp = el => { if (el && !el.textContent.includes('· v')) el.textContent += ' · v' + APP_VERSION; };
  stamp(document.querySelector('.brand'));
  stamp(document.querySelector('.loginBox p'));
})();

let currentUser = null;
let currentStaff = null;
const TERMINAL_TOKEN_KEY = 'legend_clock_terminal_token';
let _authMode = 'signin';

let state = {
  tab: 'reservations',
  focusedSettingsSection: null, // when set (via ?settingsSection= URL param), Settings renders just that one section
  resView: 'list',
  timelinePartySize: '', // '' = show every table; otherwise filter Timeline rows to tables that fit this many guests
  timelineAreaFilter: null,     // Set<areaId|'__unassigned'> of checked areas
  timelineAreaFilterSeen: null, // Set of area keys already defaulted once, so new areas auto-check without re-checking ones the user deliberately unchecked
  timelineAreaMenuOpen: false,
  selectedDate: todayISO(),
  reservations: [],
  tables: [],
  areas: [],
  currentAreaId: '__all',
  editMode: false,
  serverView: false,
  previewMode: false,       // Floor Plan: live status vs. "what's free at this date/time" projection
  previewDate: todayISO(),
  previewTime: '',          // set lazily to "now" the first time preview mode turns on
  previewData: null,        // { busyByTable: Map<tableId,{res,start,end}>, blockedAreaIds: Set }
  serverSections: [],
  comboMembers: {},   // comboTableId -> [memberTableId, ...]
  memberOfCombos: {}, // memberTableId -> [comboTableId, ...]
  floorPlan: { background_image_url: null, canvas_width: 1200, canvas_height: 800 },
  guests: [],
  waitlist: [],
  staffList: [],
  roster: [], // server_roster: name-only entries for section assignment, no login account
  servicePeriods: [],
  dashRange: 7,
  loyaltyTiers: [],    // club/society/founders terms — editable in Settings, not hardcoded
  loyaltyMembers: [],  // one row per enrolled guest (guests.id -> loyalty_members.guest_id)
  priorityHolidays: [], // dates where Founder's Circle gets the extended 14-day booking lead
  scheduleShifts: [], myPermissions: null, permissions: [], rolePermissions: [], staffOverrides: [],
  timeClockEntries: [], timeOffRequests: [], clockTerminals: [], kitchenSettings: { course_hold_minutes: 12 },
  staffGroups: [], staffGroupMembers: [], messageThreads: [], threadParticipants: [], messages: [], shiftSwapRequests: [],
  ticketDestinations: [], ingredientCategories: [], ingredients: [], menuCategories: [], menuItems: [],
  itemIngredients: [], modifierGroups: [], modifierOptions: [], menuItemModifierGroups: [],
  checks: [], checkItems: [], ordersActiveTableId: null, ordersActiveCheckId: null, ordersCollapsedAreas: [],
  checkDiscounts: [], payments: [],
  vendors: [], purchaseOrders: [], purchaseOrderItems: [],
};

// ============================================================================
// UTILITIES
// ============================================================================
// `.toISOString().slice(0,10)` looks like a harmless way to get "today's date"
// but it isn't: toISOString() always converts to UTC first. Anywhere west of
// UTC, that silently rolls the date forward for every evening hour that's
// already "tomorrow" in UTC even though it's still today locally — exactly
// what broke the Floor Plan preview's "Now" button and would have quietly
// broken Timeline's now-line and the Dashboard's date range the same way.
// This builds the date string from the LOCAL calendar fields instead, same
// as nowHHMM() already correctly does for the time-of-day part.
function toLocalISODate(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function todayISO(){ return toLocalISODate(getNow()); }
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
  return Math.max(0, Math.round((getNow().getTime() - new Date(iso).getTime())/60000));
}

// ============================================================================
// AVAILABILITY — capacity + time-overlap checking (soft vs hard table assignment)
// ============================================================================
function timeToMinutes(t){
  if (!t) return 0;
  const [h,m] = t.split(':').map(Number);
  return h*60 + m;
}
function minutesToTimeStr(mins){
  const h = Math.floor(mins/60) % 24, m = mins % 60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}
// Builds a full-day <option> list in 15-minute increments (12am–11:45pm) for
// any time <select>. Snaps the currently-set value to the nearest 15-minute
// mark so a value like "now" (which can land on an odd minute) still shows
// as selected instead of silently matching nothing.
function timeOptionsHtml(selectedTime){
  const selMin = Math.round(timeToMinutes(selectedTime) / 15) * 15;
  let html = '';
  for (let m = 0; m < 24*60; m += 15){
    const val = minutesToTimeStr(m);
    html += `<option value="${val}" ${m===selMin?'selected':''}>${fmtTime(val)}</option>`;
  }
  return html;
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
    .select('id,table_id,reservation_time,duration_minutes,party_size,guest_id,status,preferred_area_id')
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

// ---- Pacing / flow control -------------------------------------------------
// Caps how many covers (guests) can arrive into any single 15-minute window
// per area, independent of which physical table they end up at. This is what
// keeps a hostess from booking more reservations than the kitchen/floor can
// actually absorb — separate from (and on top of) the per-table conflict
// check saveReservation already does, which only stops two parties sharing
// one physical table at the same time. A reservation counts toward an area's
// pacing total if it's hard-assigned to a table in that area, or if it
// carries that area as its preferred_area_id; reservations with neither are
// area-agnostic and don't count against — or get blocked by — any area's cap.
const PACING_SLOT_MINUTES = 15;
function pacingSlotStart(timeMinutes){
  return Math.floor(timeMinutes / PACING_SLOT_MINUTES) * PACING_SLOT_MINUTES;
}
function pacingSlotLabel(timeMinutes){
  const s = pacingSlotStart(timeMinutes);
  return `${fmtTime(minutesToTimeStr(s))}–${fmtTime(minutesToTimeStr(s + PACING_SLOT_MINUTES))}`;
}
function reservationAreaId(r){
  return (r.table_id && tableById(r.table_id)?.area_id) || r.preferred_area_id || null;
}
// dateReservations: rows from fetchDateReservations (already scoped to the
// date and to active statuses). Sums party sizes already booked into the
// same 15-minute slot as timeMinutes, for the given area, excluding excludeId
// (the reservation being edited, if any) so editing in place doesn't double-count.
function coversInSlot(dateReservations, areaId, timeMinutes, excludeId){
  const target = pacingSlotStart(timeMinutes);
  return dateReservations
    .filter(r => r.id !== excludeId && reservationAreaId(r) === areaId)
    .filter(r => pacingSlotStart(timeToMinutes(r.reservation_time)) === target)
    .reduce((sum, r) => sum + (r.party_size || 0), 0);
}

// ---- Vault / Speakeasy priority booking (loyalty program) -----------------
// An area with member_priority_seats set (Speakeasy) reserves that many
// seats for active loyalty members until member_priority_release_hours
// before service, and — on designated priority holidays only — restricts how
// far ahead a non-Founder's booking can even be made. Regular (non-holiday)
// nights are gated purely by the capacity carve-out below, not a date gate;
// the date gate exists specifically for the highest-demand nights (NYE,
// Valentine's, etc.) where advance date access is itself the perk.
function daysUntilDate(dateStr){
  if (!dateStr) return 0;
  const target = new Date(dateStr + 'T00:00:00');
  const today = new Date(toLocalISODate(getNow()) + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}
function isPriorityHoliday(dateStr){
  return state.priorityHolidays.some(h => h.holiday_date === dateStr);
}
// Sums party sizes of reservations in `areaId` whose time window overlaps
// [start,end) — full-duration overlap, not a 15-min pacing slot, since this
// is asking "how many physical Vault seats are occupied at this moment,"
// not "how many covers arrive in this quarter-hour."
function vaultOverlapCovers(dateReservations, areaId, start, end, excludeId){
  return dateReservations
    .filter(r => r.id !== excludeId && reservationAreaId(r) === areaId)
    .filter(r => { const rs = timeToMinutes(r.reservation_time); return rangesOverlap(start, end, rs, rs + (r.duration_minutes || 90)); })
    .reduce((sum, r) => sum + (r.party_size || 0), 0);
}
// Returns a human-readable reason string if a non-Founder's booking on a
// priority-holiday date is too early, or null if it's allowed.
function vaultHolidayWindowReason(areaId, dateStr, guestId){
  const area = state.areas.find(a => a.id === areaId);
  if (!area || area.member_priority_seats == null || !isPriorityHoliday(dateStr)) return null;
  const member = guestId && hasActivePriorityAccess(guestId) ? activeLoyaltyMember(guestId) : null;
  const tier = member ? loyaltyTierByKey(member.tier_key) : null;
  const window = tier?.key === 'founders' ? 14 : 3;
  const days = daysUntilDate(dateStr);
  if (days <= window) return null;
  const label = state.priorityHolidays.find(h => h.holiday_date === dateStr)?.label || 'This date';
  return tier?.key === 'founders'
    ? `${label} opens for Founder's Circle booking ${window} days out — that's still ${days} days away.`
    : `${label} is a priority holiday. Booking opens ${window} days out for everyone except Founder's Circle (14 days) — that's still ${days} days away.`;
}
// Returns a human-readable reason string if this party would eat into the
// seats reserved for member priority, or null if it's fine (member, or
// enough non-reserved capacity remains, or within the release window).
function vaultCapacityReason(areaId, dateStr, timeStr, durationMin, partySize, guestId, dateReservations, excludeId){
  const area = state.areas.find(a => a.id === areaId);
  if (!area || area.member_priority_seats == null) return null;
  if (guestId && hasActivePriorityAccess(guestId)) return null;
  if (dateStr === todayISO()){
    const nowMin = timeToMinutes(nowHHMM());
    if (timeToMinutes(timeStr) - nowMin <= area.member_priority_release_hours * 60) return null;
  }
  const totalSeats = state.tables.filter(t => t.area_id === areaId && !t.is_combo).reduce((s,t) => s + t.seats, 0);
  const start = timeToMinutes(timeStr), end = start + (Number(durationMin) || 90);
  const already = vaultOverlapCovers(dateReservations, areaId, start, end, excludeId);
  const openToPublic = totalSeats - area.member_priority_seats;
  if (already + partySize > openToPublic){
    return `The Vault holds ${area.member_priority_seats} of its ${totalSeats} seats for loyalty-member priority until ${area.member_priority_release_hours}h before service — the ${openToPublic} non-member seats are full for this time.`;
  }
  return null;
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
    occupiedByBooking(r.table_id).forEach(id => consumed.add(id));
  });

  const fits = (t, partySize) => partySize >= t.min_party && partySize <= Math.min(t.max_party, t.seats);
  const unassigned = overlapping.filter(r => !r.table_id).sort((a,b) => b.party_size - a.party_size);
  unassigned.forEach(r => {
    // Mirrors Auto-Assign's area handling: an Unassigned party that requested a
    // specific area can only ever project as consuming a table in that area — a
    // party that wants the Speakeasy (and might not even fit there) must never
    // be simulated as grabbing the smallest open table anywhere else in the
    // restaurant, or every other area's capacity count gets wrongly deflated by
    // a reservation that could never actually land there.
    const candidate = state.tables
      .filter(t => t.active && isTableBookable(t, blocked) && !consumed.has(t.id) && fits(t, r.party_size)
        && (!r.preferred_area_id || t.area_id === r.preferred_area_id))
      .sort((a,b) => a.seats - b.seats)[0];
    if (candidate) occupiedByBooking(candidate.id).forEach(id => consumed.add(id));
  });

  return state.tables.filter(t => t.active && isTableBookable(t, blocked) && !consumed.has(t.id));
}
function tablesFittingParty(partySize, blockedAreaIds){
  const blocked = blockedAreaIds || new Set();
  // A table's actual seat count is always the hard ceiling, even if max_party
  // was set higher than seats by mistake when the table was configured.
  return state.tables.filter(t => t.active && isTableBookable(t, blocked) && partySize >= t.min_party && partySize <= Math.min(t.max_party, t.seats));
}
// Joining tables (a predefined combo) is only ever a fallback for a party too
// big for any single table — never offered as a choice when a lone table can
// already hold the party. If at least one single physical table is in the
// list, combos are dropped from it entirely; only when every remaining option
// is a combo (no single table qualifies) do combos surface at all.
function preferSingles(tables){
  const singles = tables.filter(t => !t.is_combo);
  return singles.length ? singles : tables;
}
// Same rule as preferSingles, but applied separately within each dining area.
// A single table qualifying in one room (e.g. a 6-top on the Patio) should never
// hide a table combination in a different room (e.g. M Dining Room) — the two
// aren't real alternatives to each other since a party can only be in one place.
function preferSinglesPerArea(tables){
  const byArea = {};
  tables.forEach(t => { (byArea[t.area_id] ||= []).push(t); });
  return Object.values(byArea).flatMap(preferSingles);
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
    occupiedByBooking(tableId).forEach(id => (consumed[id] = consumed[id] || []).push({ start, end }));
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
    // A reservation left Unassigned still carries the Area the hostess picked
    // (preferred_area_id) — Auto-Assign must stay inside that area rather than
    // reaching for the first open table anywhere in the restaurant.
    const candidates = state.tables
      .filter(t => t.active && isTableBookable(t, blockedAreaIds) && fits(t, r.party_size) && isFree(t.id, start, end)
        && (!r.preferred_area_id || t.area_id === r.preferred_area_id))
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
// Booking `bookedId` (a single table OR a predefined combo) physically seats
// every one of that combo's member tables — occupation propagates DOWN from
// a combo into its members. It does NOT propagate back OUT from a member to
// that member's other combo partners: if table M1 alone is booked, the
// "M1+M2" combo can no longer be formed (so it's marked unavailable too),
// but table M2 itself is a separate, still-empty physical table and stays
// bookable on its own. Only booking a combo directly seats all of its
// members; booking one member of a combo never seats that combo's *other*
// members. This is what keeps a single-table reservation from cascading
// into "reserved" across every table that happens to share a combo chain.
function occupiedByBooking(bookedId){
  const occupied = new Set([bookedId]);
  (state.comboMembers[bookedId] || []).forEach(id => occupied.add(id));
  Object.keys(state.comboMembers).forEach(comboId => {
    if (occupied.has(comboId)) return;
    const members = state.comboMembers[comboId] || [];
    if (members.some(m => occupied.has(m))) occupied.add(comboId);
  });
  return occupied;
}

function isTableBusy(tableId, timeStr, durationMinutes, dateReservations){
  const start = timeToMinutes(timeStr), end = start + (Number(durationMinutes)||90);
  return dateReservations.some(r => {
    if (!r.table_id) return false;
    const rStart = timeToMinutes(r.reservation_time);
    const rEnd = rStart + (r.duration_minutes||90);
    if (!rangesOverlap(start, end, rStart, rEnd)) return false;
    return occupiedByBooking(r.table_id).has(tableId);
  });
}
function guestName(g){
  if(!g) return 'Walk-in';
  return `${g.first_name||''} ${g.last_name||''}`.trim() || g.phone || 'Guest';
}
function guestById(id){ return state.guests.find(g => g.id === id); }

// ---- Loyalty program -------------------------------------------------------
function loyaltyTierByKey(key){ return state.loyaltyTiers.find(t => t.key === key); }
function loyaltyMemberByGuestId(guestId){ return state.loyaltyMembers.find(m => m.guest_id === guestId); }
// Only an 'active' (not cancelled) membership counts for perks/priority — a
// cancelled member still has a row (for history) but gets treated as a
// regular guest everywhere else in the app.
function activeLoyaltyMember(guestId){
  const m = loyaltyMemberByGuestId(guestId);
  return m && m.status === 'active' ? m : null;
}
// Same as activeLoyaltyMember, but returns false while a no-show suspension
// is in effect — used only for the Vault priority-booking gates, so a
// suspended member still keeps their tier, perks, and redemptions.
function hasActivePriorityAccess(guestId){
  const m = activeLoyaltyMember(guestId);
  if (!m) return false;
  if (m.priority_suspended_until && m.priority_suspended_until >= todayISO()) return false;
  const vaultAccess = m.locked_vault_access ?? loyaltyTierByKey(m.tier_key)?.vault_access ?? false;
  if (!vaultAccess) return false;
  return true;
}
function currentMonthKey(){ const d = getNow(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); }
function currentQuarterKey(){ const d = getNow(); return d.getFullYear() + '-Q' + (Math.floor(d.getMonth()/3)+1); }
// Redemption counters reset lazily on first read of a new period rather than
// a scheduled job — if the stored period_key doesn't match "now", the member
// simply hasn't used anything yet this period.
// Reads from the price/benefit snapshot locked in at enrollment (or last tier
// change) rather than the live loyalty_tiers row, so editing tier terms in
// Settings only affects new enrollments — not members already signed up.
function lockedCocktailsPerMonth(member){
  return member.locked_cocktails_per_month ?? loyaltyTierByKey(member.tier_key)?.cocktails_per_month ?? 0;
}
function lockedCreditPerQuarter(member){
  return member.locked_credit_per_quarter ?? loyaltyTierByKey(member.tier_key)?.credit_per_quarter ?? 0;
}
function cocktailsRemaining(member){
  const used = member.cocktails_period_key === currentMonthKey() ? member.cocktails_used_period : 0;
  return Math.max(0, lockedCocktailsPerMonth(member) - used);
}
function creditRemaining(member){
  const used = member.credit_period_key === currentQuarterKey() ? member.credit_used_period : 0;
  return Math.max(0, lockedCreditPerQuarter(member) - used);
}
function nextBillingDue(member){
  const base = member.last_billed_at || member.joined_at;
  if (!base) return null;
  const d = new Date(base + 'T00:00:00'); d.setMonth(d.getMonth()+1);
  return toLocalISODate(d);
}
async function reloadLoyaltyMembers(){
  const { data } = await sb.from('loyalty_members').select('*');
  state.loyaltyMembers = data || [];
}
async function reloadLoyaltyTiers(){
  const { data } = await sb.from('loyalty_tiers').select('*').order('sort_order');
  state.loyaltyTiers = data || [];
}
async function reloadPriorityHolidays(){
  const { data } = await sb.from('priority_holidays').select('*').order('holiday_date');
  state.priorityHolidays = data || [];
}
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
  // Laptops/phones that sleep or sit backgrounded for hours can miss the library's
  // normal auto-refresh timer, leaving a stale access token in place. The next request
  // then goes out unauthenticated (Postgres sees it as the anon role) and fails with a
  // confusing "permission denied for function ..." error instead of a clear sign-in
  // prompt. Force a session refresh whenever the tab regains focus so this resolves
  // itself silently before the person touches anything.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser){
      sb.auth.refreshSession().catch(()=>{});
    }
  });
  // Any interaction on a shared terminal resets its auto-lock countdown — see
  // the SHARED TERMINAL LOCK section below for what happens when it fires.
  ['click','keydown','touchstart'].forEach(evt => document.addEventListener(evt, resetTerminalIdleTimer, { passive: true }));
});

// ============================================================================
// SHARED TERMINAL LOCK — PIN-based active-operator switching
// ============================================================================
// A device flagged as a clock-in terminal (Settings → Clock Terminals) sits in
// a public area of the restaurant and gets used by whichever waiter is
// nearest — not just whoever's Supabase account happens to be signed into the
// browser. Rather than requiring a full sign-out/sign-in for every handoff,
// the terminal instead "locks" behind a PIN screen — the same PIN staff
// already use for clock-in and manager approvals — and swaps the app's
// notion of currentStaff to whoever just unlocked it. From that point on,
// that's who gets stamped as server_id/added_by on new checks and items,
// until the terminal locks again (idle for a minute, or tapped to lock).
// This intentionally does NOT swap the underlying Supabase Auth session —
// auth.uid() stays whatever account the terminal itself is signed into. That
// works cleanly as long as the terminal's real login is the admin account,
// since is_admin() already bypasses the "server_id must match auth.uid()"
// check in RLS. It would NOT work correctly if a non-admin account were the
// terminal's underlying login — RLS would reject writes attributed to a
// different staff member in that case.
let terminalLocked = false;
let _terminalIdleTimer = null;
function isSharedTerminalDevice(){
  const token = localStorage.getItem(TERMINAL_TOKEN_KEY);
  return !!(token && state.clockTerminals?.some(t => t.device_token === token && t.active));
}
function resetTerminalIdleTimer(){
  if (!isSharedTerminalDevice() || terminalLocked) return;
  clearTimeout(_terminalIdleTimer);
  _terminalIdleTimer = setTimeout(() => window.lockTerminalNow(), 60000);
}
window.lockTerminalNow = function(){
  if (!isSharedTerminalDevice() || terminalLocked) return;
  terminalLocked = true;
  clearTimeout(_terminalIdleTimer);
  showTerminalLockOverlay();
};
function showTerminalLockOverlay(){
  const pinEl = document.getElementById('lockPin');
  if (pinEl) pinEl.value = '';
  const errEl = document.getElementById('lockError');
  if (errEl) errEl.textContent = '';
  document.getElementById('terminalLockOverlay')?.classList.remove('hidden');
  pinEl?.focus();
}
// PIN-only unlock — no name picker. identify_staff_by_pin checks the PIN against every
// active, order-taking-eligible staff member server-side and returns a match only if
// exactly one person's PIN fits, which is why PINs must be unique (enforced in
// set_staff_pin) — a shared PIN would make this lookup ambiguous and always fail closed.
window.unlockTerminal = async function(){
  const pinEl = document.getElementById('lockPin');
  const pin = pinEl?.value;
  const errEl = document.getElementById('lockError');
  if (!pin){ if (errEl) errEl.textContent = 'Enter your PIN.'; return; }
  const { data: staffId, error } = await sb.rpc('identify_staff_by_pin', { p_pin: pin, p_permission: 'take_orders' });
  if (error || !staffId){ if (errEl) errEl.textContent = 'Incorrect PIN.'; if (pinEl) pinEl.value = ''; pinEl?.focus(); return; }
  const staffRow = state.staffList.find(s => s.id === staffId);
  if (!staffRow){ if (errEl) errEl.textContent = 'Could not find that staff record — try again.'; return; }
  currentStaff = staffRow;
  computeMyPermissions();
  document.getElementById('topbarName').textContent = currentStaff.name || currentUser.email.split('@')[0];
  terminalLocked = false;
  document.getElementById('terminalLockOverlay')?.classList.add('hidden');
  resetTerminalIdleTimer();
  render();
};
// Called once on sign-in (after loadAll, so clockTerminals/staffList are loaded) — a shared
// terminal always boots locked, regardless of who the underlying browser session belongs to.
function initTerminalLock(){
  const btn = document.getElementById('lockNowBtn');
  if (!isSharedTerminalDevice()){
    btn?.classList.add('hidden');
    return;
  }
  btn?.classList.remove('hidden');
  terminalLocked = true;
  showTerminalLockOverlay();
}

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
      const { error: staffErr } = await sb.from('staff').insert({ id: data.user.id, email, name: name || email, role:'host', active:false });
      if (staffErr && !data.session){
        // Expected when email confirmation is required: there's no session yet for this brand-new
        // user, so the insert is blocked by RLS. onSignedIn() re-attempts this same insert the
        // moment they confirm their email and actually sign in, so nothing is lost — just delayed.
        err.style.color = 'var(--success)';
        err.textContent = 'Request submitted! Check your email to confirm your account, then come back and sign in — your access request will be ready for a manager to approve right after.';
        return;
      }
      if (staffErr){
        err.textContent = 'Your account was created, but saving your access request failed: ' + staffErr.message + '. Try signing in, or contact your manager.';
        return;
      }
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

  // A Settings section link opens the whole app in a fresh tab with ?settingsSection=<key> —
  // land straight on that one section instead of the tab the app would otherwise default to.
  const settingsSectionParam = new URLSearchParams(location.search).get('settingsSection');
  if (settingsSectionParam){
    state.tab = 'settings';
    state.focusedSettingsSection = settingsSectionParam;
  }

  // The "History" link on a check opens a *new* browser window (window.open, same origin,
  // so the already-signed-in Supabase session just carries over via localStorage) pointed at
  // this same app with ?guestHistory=<id>. That's a small, focused popup — not the full tabbed
  // app — so it skips the normal tab render entirely, along with the terminal lock and the
  // background polling loops, none of which are relevant to a short-lived read view.
  const guestHistoryParam = new URLSearchParams(location.search).get('guestHistory');
  if (guestHistoryParam){
    const nav = document.getElementById('tabnav');
    if (nav) nav.style.display = 'none';
    document.getElementById('lockNowBtn')?.classList.add('hidden');
    await renderGuestHistoryView(guestHistoryParam);
    return;
  }

  render();
  initTerminalLock();
  startKdsPolling();
  startMessagePolling();
  startCourseAutoFirePolling();
}

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadAll(){
  const statusEl = document.getElementById('syncStatus');
  setStatus(statusEl, '☁ Syncing…', '');
  try {
    const [tablesRes, areasRes, fpRes, ssRes, comboRes, guestsRes, waitlistRes, staffRes, rosterRes, spRes, resRes, loyaltyTiersRes, loyaltyMembersRes, holidaysRes, permsRes, rolePermsRes, overridesRes,
      tdRes, icRes, ingRes, mcRes, miRes, iiRes, mgRes, moRes, mimgRes] = await Promise.all([
      sb.from('dining_tables').select('*').order('label'),
      sb.from('floor_areas').select('*').order('sort_order').order('created_at'),
      sb.from('floor_plan_settings').select('*').eq('id', true).maybeSingle(),
      sb.from('server_sections').select('*').order('sort_order').order('created_at'),
      sb.from('table_combo_members').select('*'),
      sb.from('guests').select('*').order('last_name'),
      sb.from('waitlist').select('*').eq('status','waiting').order('added_at'),
      sb.rpc('staff_directory'),
      sb.from('server_roster').select('*').order('name'),
      sb.from('service_periods').select('*').order('start_time'),
      sb.from('reservations').select('*').eq('reservation_date', state.selectedDate).order('reservation_time'),
      sb.from('loyalty_tiers').select('*').order('sort_order'),
      sb.from('loyalty_members').select('*'),
      sb.from('priority_holidays').select('*').order('holiday_date'),
      sb.from('permissions').select('*'),
      sb.from('role_permissions').select('*'),
      sb.from('staff_permission_overrides').select('*'),
      sb.from('ticket_destinations').select('*').order('sort_order'),
      sb.from('ingredient_categories').select('*').order('sort_order'),
      sb.from('ingredients').select('*').order('name'),
      sb.from('menu_categories').select('*').order('sort_order'),
      sb.from('menu_items').select('*').order('sort_order'),
      sb.from('item_ingredients').select('*'),
      sb.from('modifier_groups').select('*').order('name'),
      sb.from('modifier_options').select('*').order('sort_order'),
      sb.from('menu_item_modifier_groups').select('*'),
    ]);
    const [vendorsRes, poRes, poItemsRes, terminalsRes, clockRes, kitchenSettingsRes] = await Promise.all([
      sb.from('vendors').select('*').order('name'),
      sb.from('purchase_orders').select('*').order('created_at', { ascending: false }),
      sb.from('purchase_order_items').select('*'),
      sb.from('clock_terminals').select('*').order('created_at'),
      sb.from('time_clock_entries').select('*').order('clock_in_at', { ascending: false }).limit(300),
      sb.from('kitchen_settings').select('*').eq('id', true).maybeSingle(),
    ]);
    state.vendors = vendorsRes.data || [];
    state.purchaseOrders = poRes.data || [];
    state.purchaseOrderItems = poItemsRes.data || [];
    state.clockTerminals = terminalsRes.data || [];
    state.timeClockEntries = clockRes.data || [];
    state.kitchenSettings = kitchenSettingsRes.data || { course_hold_minutes: 12 };
    state.tables = tablesRes.data || [];
    state.areas = areasRes.data || [];
    if (fpRes.data) state.floorPlan = fpRes.data;
    state.serverSections = ssRes.data || [];
    buildComboMaps(comboRes.data || []);
    state.guests = guestsRes.data || [];
    state.waitlist = waitlistRes.data || [];
    state.staffList = staffRes.data || [];
    state.roster = rosterRes.data || [];
    state.servicePeriods = spRes.data || [];
    state.reservations = resRes.data || [];
    state.loyaltyTiers = loyaltyTiersRes.data || [];
    state.loyaltyMembers = loyaltyMembersRes.data || [];
    state.priorityHolidays = holidaysRes.data || [];
    state.permissions = permsRes.data || [];
    state.rolePermissions = rolePermsRes.data || [];
    state.staffOverrides = overridesRes.data || [];
    state.ticketDestinations = tdRes.data || [];
    state.ingredientCategories = icRes.data || [];
    state.ingredients = ingRes.data || [];
    state.menuCategories = mcRes.data || [];
    state.menuItems = miRes.data || [];
    state.itemIngredients = iiRes.data || [];
    state.modifierGroups = mgRes.data || [];
    state.modifierOptions = moRes.data || [];
    state.menuItemModifierGroups = mimgRes.data || [];
    if (!state.currentAreaId) state.currentAreaId = '__all';
    computeMyPermissions();
    // The batch load above only pulls the safe staff_directory() columns (id/name/role/active) —
    // enough for approvals, messaging, and transfers. Admins/managers who can actually edit staff
    // (Settings > Staff Access) need the full row (email/phone/address), which RLS now allows for
    // manage_staff_permissions holders — fetch it here rather than exposing it to everyone.
    if (can('manage_staff_permissions')) await reloadStaffList();
    setStatus(statusEl, '☁ Synced', 'synced');
  } catch(e){
    setStatus(statusEl, '⚠ Offline', 'error');
  }
}

async function reloadReservationsForDate(){
  const { data } = await sb.from('reservations').select('*').eq('reservation_date', state.selectedDate).order('reservation_time');
  state.reservations = data || [];
  // The Floor Plan's "Check Availability" preview snapshots reservations for its own
  // date/time separately from the Reservations tab — without this, a table just
  // booked from a preview click (or edited/cancelled elsewhere) would keep showing
  // its old color until the preview date/time was touched again.
  if (state.previewMode) await loadFloorPreview();
}

async function logActivity(action, entity_type, entity_id, details){
  try { await sb.from('activity_log').insert({ staff_id: currentStaff.id, action, entity_type, entity_id, details: details||{} }); } catch(e){}
}

// ============================================================================
// PERMISSIONS — mirrors the has_permission() logic in Postgres client-side,
// purely for showing/hiding UI. The database's Row Level Security is the
// real enforcement; this just keeps people from seeing buttons/tabs they
// can't actually use. Effective permission = this employee's own override
// if one exists, else their role's default bundle. The 'admin' role (the
// hardcoded owner bootstrap account) always gets everything.
// ============================================================================
function computeMyPermissions(){
  const perms = new Set();
  if (!currentStaff) { state.myPermissions = perms; return perms; }
  if (currentStaff.role === 'admin'){
    state.permissions.forEach(p => perms.add(p.key));
    state.myPermissions = perms;
    return perms;
  }
  state.rolePermissions.filter(rp => rp.role === currentStaff.role).forEach(rp => perms.add(rp.permission_key));
  state.staffOverrides.filter(o => o.staff_id === currentStaff.id).forEach(o => {
    if (o.granted) perms.add(o.permission_key); else perms.delete(o.permission_key);
  });
  state.myPermissions = perms;
  return perms;
}
function can(permKey){ return state.myPermissions ? state.myPermissions.has(permKey) : false; }

const TAB_PERMISSIONS = {
  reservations: ['manage_reservations'],
  floorplan: ['manage_reservations'],
  split: ['manage_reservations'],
  waitlist: ['manage_reservations'],
  guests: ['manage_reservations','manage_loyalty_program'],
  loyalty: ['manage_loyalty_program'],
  dashboard: ['view_reports'],
  settings: ['manage_reservations','manage_staff_permissions','manage_loyalty_program','manage_menu','manage_ingredients_costing','manage_inventory'],
  schedule: ['view_own_schedule','manage_schedule','clock_in_out','request_time_off'],
  orders: ['take_orders','take_payment'],
  kitchen: ['view_kitchen_station'],
  expo: ['mark_item_delivered'],
};
const PERMISSION_CATEGORIES = {
  take_orders: 'Orders & Payments',
  take_payment: 'Orders & Payments',
  split_checks: 'Orders & Payments',
  apply_comp: 'Orders & Payments',
  apply_discretionary_discount: 'Orders & Payments',
  apply_loyalty_payment: 'Orders & Payments',
  process_refund: 'Orders & Payments',
  sell_gift_card: 'Gift Cards',
  redeem_gift_card: 'Gift Cards',
  view_kitchen_station: 'Kitchen & Expo',
  mark_item_delivered: 'Kitchen & Expo',
  manage_menu: 'Menu & Inventory',
  manage_ingredients_costing: 'Menu & Inventory',
  manage_inventory: 'Menu & Inventory',
  manage_reservations: 'Reservations & Loyalty',
  manage_loyalty_program: 'Reservations & Loyalty',
  clock_in_out: 'Schedule & Time',
  view_own_schedule: 'Schedule & Time',
  request_time_off: 'Schedule & Time',
  manage_schedule: 'Schedule & Time',
  manage_timecards: 'Schedule & Time',
  approve_shift_swap: 'Schedule & Time',
  use_messaging: 'Messaging',
  manage_broadcasts: 'Messaging',
  manage_staff_permissions: 'Staff & Reports',
  view_reports: 'Staff & Reports',
};
const PERMISSION_CATEGORY_ORDER = ['Orders & Payments','Gift Cards','Kitchen & Expo','Menu & Inventory','Reservations & Loyalty','Schedule & Time','Messaging','Staff & Reports'];
// Frontline roles must be on the clock to touch guest-facing/job-function screens — this keeps
// someone from working a shift (and being on a check as the server, etc.) without ever punching in.
// Managers/admins are exempt: they often need to approve things or step in without being "on shift."
const CLOCK_GATED_ROLES = new Set(['host','waiter','bartender','kitchen','expo']);
const CLOCK_GATED_TABS = new Set(['reservations','floorplan','split','waitlist','guests','loyalty','orders','kitchen','expo']);
function isClockedIn(){
  return !!currentStaff && state.timeClockEntries.some(e => e.staff_id === currentStaff.id && !e.clock_out_at);
}
// Same check as isClockedIn(), but for an arbitrary staff id rather than currentStaff —
// used to gate check transfers so a check can't be handed to someone who isn't actually
// on shift right now.
function isStaffClockedIn(staffId){
  return state.timeClockEntries.some(e => e.staff_id === staffId && !e.clock_out_at);
}
function needsClockGate(){
  return !!currentStaff && CLOCK_GATED_ROLES.has(currentStaff.role) && !isClockedIn();
}
function canSeeTab(tab){
  const need = TAB_PERMISSIONS[tab];
  const permitted = !need ? true : need.some(p => can(p));
  if (!permitted) return false;
  if (CLOCK_GATED_TABS.has(tab) && needsClockGate()) return false;
  return true;
}
// Hides nav buttons the current employee has no permission for, and bumps
// them off a tab they've lost access to (or never had) onto the first one
// they can actually see — or a placeholder if there isn't one yet, which
// will be the normal state for Kitchen/Expo/Waiter/Bartender logins until
// ordering (a later phase) ships.
function applyPermissionGating(){
  let firstVisible = null;
  document.querySelectorAll('.tabbtn').forEach(btn => {
    const visible = canSeeTab(btn.dataset.tab);
    btn.classList.toggle('hidden', !visible);
    if (visible && !firstVisible) firstVisible = btn.dataset.tab;
  });
  if (!canSeeTab(state.tab)) state.tab = firstVisible; // null if nothing is visible yet
}

// ============================================================================
// SHELL / TAB SWITCHING
// ============================================================================
window.setTab = function(tab){
  state.tab = tab;
  state.focusedSettingsSection = null; // clicking a nav tab always goes to the full Settings directory, not a leftover pop-out section
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
};

let _lastRenderedTab = null; // guards against fetch-then-render loops for tabs whose loader itself calls render()
// render() fully replaces the active tab's innerHTML on every call — necessary
// since state can change from many places (polling, other tabs, etc.), but that
// normally means a focused text input (e.g. a live search box) gets destroyed
// and rebuilt on every keystroke, kicking focus out after each character typed.
// To avoid that, any focused <input>/<textarea> that has an `id` has its focus
// + cursor position captured before the re-render and restored after, as long
// as an element with that same id still exists in the freshly rendered markup.
function render(){
  applyPermissionGating();
  renderNowBanner();
  renderTopbarClock();
  const c = document.getElementById('content');
  const active = document.activeElement;
  const focusPreserve = (active && active.id && c.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'))
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
    : null;
  if (!state.tab){
    c.innerHTML = `<div class="empty-state"><div class="empty-state-icon">👋</div>Nothing here yet for your role.<br><span class="panel-sub">Ordering, kitchen, and bar screens are coming in a later update — for now, ask a manager if you think this is wrong.</span></div>`;
    _lastRenderedTab = state.tab;
    return;
  }
  const enteringTab = state.tab !== _lastRenderedTab;
  _lastRenderedTab = state.tab;
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'reservations') { c.innerHTML = renderReservationsTab(); if (state.resView === 'timeline') scrollTimelineToNow(); }
  else if (state.tab === 'floorplan') { renderFloorTabPreservingView(renderFloorPlanTab(), enteringTab); if (enteringTab) loadOrdersData(); }
  else if (state.tab === 'split') { renderFloorTabPreservingView(renderSplitViewTab(), enteringTab); if (enteringTab) loadOrdersData(); }
  else if (state.tab === 'orders') { c.innerHTML = renderOrdersTab(); if (enteringTab) loadOrdersData(); }
  else if (state.tab === 'kitchen') { c.innerHTML = renderKitchenTab(); if (enteringTab) loadOrdersData(); }
  else if (state.tab === 'expo') { c.innerHTML = renderExpoTab(); if (enteringTab) loadOrdersData(); }
  else if (state.tab === 'waitlist') c.innerHTML = renderWaitlistTab();
  else if (state.tab === 'guests') c.innerHTML = renderGuestsTab();
  else if (state.tab === 'loyalty') c.innerHTML = renderLoyaltyTab();
  else if (state.tab === 'schedule') { c.innerHTML = renderScheduleTab(); if (enteringTab) loadScheduleData(); }
  else if (state.tab === 'dashboard') { c.innerHTML = renderDashboardTab(); loadDashboard(); }
  else if (state.tab === 'settings') c.innerHTML = renderSettingsTab();
  if (focusPreserve){
    const el = document.getElementById(focusPreserve.id);
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')){
      el.focus();
      if (typeof focusPreserve.start === 'number' && el.setSelectionRange){
        try { el.setSelectionRange(focusPreserve.start, focusPreserve.end); } catch(e){}
      }
    }
  }
}

// Shows the Reservations panel and the Floor Plan panel side by side — same
// two panels as their standalone tabs (still available separately for a
// narrower phone/tablet screen), just composed together so a table can be
// tapped on the floor plan while checking who's up next on the list, without
// switching tabs back and forth. Below ~900px wide the two panes stack
// vertically instead (see .split-view in styles.css) rather than squeezing
// both down to an unusable width.
function renderSplitViewTab(){
  return `
  <div class="split-view">
    <div class="split-pane">${renderReservationsTab()}</div>
    <div class="split-pane split-pane-right">${renderFloorPlanTab()}</div>
  </div>`;
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
      ${state.resView==='timeline' ? renderPartySizeFilterSelect() : ''}
      ${state.resView==='timeline' ? renderTimelineAreaFilter() : ''}
      <input type="date" class="search-input" style="margin:0;width:auto" value="${state.selectedDate}" onchange="changeDate(this.value)"/>
      <button class="btn btn-secondary" onclick="changeDate(todayISO())">Today</button>
      ${state.resView==='timeline' ? `<button class="btn btn-secondary" onclick="scrollTimelineToNow()">🕐 Now</button>` : ''}
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

// Party-size filter for the Timeline: narrows the table rows down to just the ones
// that could actually seat a party of that size, so a manager can answer "what's
// open for a 6-top right now" at a glance instead of scanning every table.
function renderPartySizeFilterSelect(){
  const maxSize = Math.max(2, ...state.tables.filter(t=>t.active).map(t => Math.min(t.max_party, t.seats)));
  const options = Array.from({length: maxSize}, (_, i) => i+1);
  return `
    <select class="modal-select" style="margin:0;width:auto" onchange="setTimelinePartySize(this.value)">
      <option value="">All tables</option>
      ${options.map(n => `<option value="${n}" ${String(n)===String(state.timelinePartySize)?'selected':''}>Fits ${n} guest${n===1?'':'s'}</option>`).join('')}
    </select>`;
}
window.setTimelinePartySize = function(v){ state.timelinePartySize = v; render(); };

// Multi-select area filter for the Timeline (checkboxes, not a single-select) —
// lets a manager show just one area or several at once, e.g. Bar + Main but not
// Patio/Speakeasy. Lazily defaults to "everything checked" the first time it's
// touched, and auto-includes any area added later.
function timelineAreaFilterSet(){
  if (!state.timelineAreaFilter) state.timelineAreaFilter = new Set();
  if (!state.timelineAreaFilterSeen) state.timelineAreaFilterSeen = new Set();
  const allKeys = state.areas.map(a => a.id).concat(state.tables.some(t => !t.area_id) ? ['__unassigned'] : []);
  allKeys.forEach(key => {
    if (!state.timelineAreaFilterSeen.has(key)){
      state.timelineAreaFilterSeen.add(key);
      state.timelineAreaFilter.add(key); // areas default to checked the first time they're seen
    }
  });
  return state.timelineAreaFilter;
}
function renderTimelineAreaFilter(){
  const set = timelineAreaFilterSet();
  const hasUnassignedTables = state.tables.some(t => !t.area_id);
  const totalOptions = state.areas.length + (hasUnassignedTables ? 1 : 0);
  const checkedCount = [...set].filter(k => k !== '__unassigned' || hasUnassignedTables).length;
  const label = checkedCount >= totalOptions ? 'All areas' : checkedCount === 0 ? 'No areas' : `${checkedCount} area${checkedCount===1?'':'s'}`;
  return `
  <div style="position:relative;display:inline-block">
    <button type="button" class="btn btn-secondary" onclick="toggleTimelineAreaMenu()">🏙️ ${esc(label)} ▾</button>
    ${state.timelineAreaMenuOpen ? `
      <div class="dropdown-panel">
        <div style="display:flex;gap:12px;margin-bottom:8px">
          <span class="linkBtn" style="cursor:pointer" onclick="setAllTimelineAreas(true)">Select all</span>
          <span class="linkBtn" style="cursor:pointer" onclick="setAllTimelineAreas(false)">Clear</span>
        </div>
        ${state.areas.map(a => `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;cursor:pointer">
          <input type="checkbox" ${set.has(a.id)?'checked':''} onchange="toggleTimelineAreaFilter('${a.id}')"/> ${esc(a.name)}
        </label>`).join('')}
        ${hasUnassignedTables ? `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;cursor:pointer">
          <input type="checkbox" ${set.has('__unassigned')?'checked':''} onchange="toggleTimelineAreaFilter('__unassigned')"/> No area
        </label>` : ''}
      </div>` : ''}
  </div>`;
}
window.toggleTimelineAreaMenu = function(){ state.timelineAreaMenuOpen = !state.timelineAreaMenuOpen; render(); };
window.toggleTimelineAreaFilter = function(key){
  const set = timelineAreaFilterSet();
  if (set.has(key)) set.delete(key); else set.add(key);
  render();
};
window.setAllTimelineAreas = function(on){
  const set = timelineAreaFilterSet();
  set.clear();
  if (on){
    state.areas.forEach(a => set.add(a.id));
    if (state.tables.some(t => !t.area_id)) set.add('__unassigned');
  }
  render();
};

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
      const areaName = r.preferred_area_id ? state.areas.find(a => a.id === r.preferred_area_id)?.name : null;
      const reason = areaName
        ? `⚠️ No table or combo in ${esc(areaName)} fits ${r.party_size} guests (that area tops out below this party size, or is fully booked) — leave Unassigned, seat manually, or pick a different area on the reservation.`
        : `⚠️ No table or combo currently fits/free — leave Unassigned or seat manually.`;
      return `
      <div class="card-row" style="padding:8px 0;border-bottom:1px solid var(--border);opacity:.7">
        <div>
          <strong>${fmtTime(r.reservation_time)} · ${esc(guestName(g))}</strong> · ${r.party_size} guests${areaName ? ` · wants ${esc(areaName)}` : ''}
          <div class="panel-sub" style="margin:0;color:var(--warn)">${reason}</div>
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

  const partyFilter = state.timelinePartySize ? Number(state.timelinePartySize) : null;
  const fitsFilter = t => !partyFilter || (partyFilter >= t.min_party && partyFilter <= Math.min(t.max_party, t.seats));
  const areaFilter = timelineAreaFilterSet();
  const inAreaFilter = t => areaFilter.has(t.area_id || '__unassigned');

  const tables = state.tables.filter(t => t.active && fitsFilter(t) && inAreaFilter(t)).slice().sort((a,b) => (a.section||'').localeCompare(b.section||'') || a.label.localeCompare(b.label));
  const unassigned = list.filter(r => !r.table_id && !['cancelled'].includes(r.status) && (!partyFilter || r.party_size === partyFilter));

  const nowMin = (() => {
    const now = getNow();
    const todayStr = toLocalISODate(now);
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

  // Positioned with the exact same x(m) function used for the reservation bars below
  // (rather than laid out sequentially via flex) so the ruler can never drift out of
  // sync with the bars — flex layout assumed each cell started exactly on the hour,
  // but rangeStart is offset by a 30-min buffer, silently shifting every hour label.
  const headerCells = hourMarks.map(m => `<div class="timeline-hour" style="position:absolute;left:${x(m)}px;width:${60*PX_PER_MIN}px">${fmtTime(String(Math.floor(m/60)).padStart(2,'0')+':00')}</div>`).join('');

  // "Now" line spans the full height of the grid — placed once on the shared
  // relatively-positioned wrapper so it isn't clipped to a single row.
  const LABEL_COL_W = 130;
  const nowLine = nowMin!=null && nowMin>=rangeStart && nowMin<=rangeEnd
    ? `<div id="timelineNowLine" class="timeline-now-line" style="left:${LABEL_COL_W + x(nowMin)}px" title="Now"></div>` : '';

  const filterNote = partyFilter
    ? `<div class="panel-sub" style="margin-bottom:8px">Showing ${tables.length} table${tables.length===1?'':'s'} that fit${tables.length===1?'s':''} ${partyFilter} guest${partyFilter===1?'':'s'} — any open stretch on a row is free for that party size. <span class="linkBtn" style="cursor:pointer" onclick="setTimelinePartySize('')">Clear filter</span></div>`
    : '';

  return `
  ${filterNote}
  <div class="timeline-wrap">
    <div style="position:relative">
      <div class="timeline-header">
        <div class="timeline-corner"></div>
        <div class="timeline-header-hours" style="width:${totalW}px">${headerCells}</div>
      </div>
      ${rows || '<div class="empty-state">No tables fit that party size.</div>'}
      ${nowLine}
    </div>
  </div>
  <div class="panel-sub" style="margin-top:8px">🟠 Dashed marker = less than 20 min to turn a table between reservations. Tap any bar to edit.</div>`;
}

// The Timeline can easily be wide enough that reaching the current time means
// real horizontal scrolling — and .timeline-wrap's own scrollbar sits at the
// bottom of a box up to 70vh tall, which can end up below the fold with no
// visible hint it's there. Rather than rely on a host discovering a scrollbar
// (or a trackpad gesture) on their own, this scrolls the now-line into view
// automatically every time the Timeline renders, and the "Now" button lets
// them jump back to it on demand after scrolling elsewhere. Quietly no-ops if
// there's no now-line to find (viewing a different date, or "now" falls
// outside the visible service-period range).
window.scrollTimelineToNow = function(){
  const line = document.getElementById('timelineNowLine');
  if (!line) return;
  line.scrollIntoView({ inline: 'center', block: 'nearest' });
};

function resActionButtons(r){
  const btns = [];
  if (r.status === 'pending') btns.push(`<button class="btn btn-sm btn-secondary" onclick="updateReservationStatus('${r.id}','confirmed')">Confirm</button>`);
  if (['pending','confirmed'].includes(r.status)) btns.push(`<button class="btn btn-sm btn-success" onclick="openSeatModal('${r.id}')">Seat</button>`);
  if (r.status === 'seated') btns.push(`<button class="btn btn-sm btn-secondary" onclick="updateReservationStatus('${r.id}','completed')">Complete</button>`);
  if (['pending','confirmed'].includes(r.status)) btns.push(`<button class="btn btn-sm btn-danger" onclick="updateReservationStatus('${r.id}','no_show')">No-Show</button>`);
  if (!['completed','cancelled','no_show'].includes(r.status)) btns.push(`<button class="btn btn-sm btn-danger" onclick="updateReservationStatus('${r.id}','cancelled')">Cancel</button>`);
  // Cancel keeps the record (status history, no-show/cancel-rate stats on the
  // Dashboard); Delete permanently removes the row — kept as a visually
  // distinct, separate button so the two aren't confused for one action.
  btns.push(`<button class="btn btn-sm btn-secondary" style="color:var(--danger);border-color:var(--danger)" onclick="deleteReservation('${r.id}')">🗑️ Delete</button>`);
  return btns.join('');
}

window.changeDate = async function(d){
  state.selectedDate = d;
  await reloadReservationsForDate();
  render();
};

window.updateReservationStatus = async function(id, status){
  const patch = { status };
  if (status === 'seated') patch.seated_at = getNow().toISOString();
  if (status === 'completed') patch.completed_at = getNow().toISOString();
  if (status === 'cancelled') patch.cancelled_at = getNow().toISOString();
  const { error } = await sb.from('reservations').update(patch).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await logActivity('status_change','reservation', id, {status});
  if (status === 'no_show') await checkLoyaltyNoShowSuspension(id);
  await reloadReservationsForDate();
  render();
};

// Two no-shows by an active loyalty member within a rolling 90-day window
// suspend their Vault priority booking (not their membership, perks, or
// redemptions) for 60 days — protects the seats held back for members
// without punishing a dues-paying member over a single missed reservation.
async function checkLoyaltyNoShowSuspension(reservationId){
  let r = state.reservations.find(x => x.id === reservationId);
  if (!r){
    const { data } = await sb.from('reservations').select('id, guest_id').eq('id', reservationId).maybeSingle();
    r = data;
  }
  if (!r || !r.guest_id) return;
  const member = activeLoyaltyMember(r.guest_id);
  if (!member) return;
  const cutoff = new Date(getNow()); cutoff.setDate(cutoff.getDate() - 90);
  const { data: recentNoShows } = await sb.from('reservations')
    .select('id')
    .eq('guest_id', r.guest_id)
    .eq('status', 'no_show')
    .gte('reservation_date', toLocalISODate(cutoff));
  if ((recentNoShows?.length || 0) >= 2){
    const until = new Date(getNow()); until.setDate(until.getDate() + 60);
    await sb.from('loyalty_members').update({ priority_suspended_until: toLocalISODate(until) }).eq('id', member.id);
    await reloadLoyaltyMembers();
  }
}

window.openSeatModal = function(id){
  const r = state.reservations.find(x => x.id === id);
  const physicallyFree = state.tables.filter(t => t.active && ['available','reserved'].includes(t.status));
  const capFits = t => r.party_size >= t.min_party && r.party_size <= Math.min(t.max_party, t.seats);
  const fits = preferSinglesPerArea(physicallyFree.filter(capFits));
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
  const { error } = await sb.from('reservations').update({ status:'seated', seated_at: getNow().toISOString(), table_id: tableId }).eq('id', id);
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

window.openReservationModal = function(id, prefill){
  const r = id ? state.reservations.find(x => x.id === id) : null;
  const g = r ? guestById(r.guest_id) : null;
  state._resDurationTouched = false; // reset so the first area/table pick can still suggest a default duration
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
        <input type="date" class="modal-input" id="resDate" value="${r?.reservation_date || prefill?.date || state.selectedDate}" onchange="refreshAvailability()"/>
      </div>
      <div>
        <label class="field-label">Time</label>
        <input type="time" class="modal-input" id="resTime" value="${r?.reservation_time?.slice(0,5) || prefill?.time || '18:00'}" onchange="refreshAvailability()"/>
      </div>
    </div>
    <div class="formgrid">
      <div>
        <label class="field-label">Area <span style="font-weight:400;color:var(--gray)">(sets default duration; scopes Table list below)</span></label>
        <select class="modal-select" id="resArea" onchange="onResAreaChange()">
          <option value="">No preference</option>
          ${(() => {
            const preselectedAreaId = (r?.table_id && tableById(r.table_id)?.area_id) || (prefill?.tableId && tableById(prefill.tableId)?.area_id) || r?.preferred_area_id || '';
            return state.areas.map(a => `<option value="${a.id}" ${preselectedAreaId===a.id ? 'selected':''}>${esc(a.name)}</option>`).join('');
          })()}
        </select>
      </div>
      <div>
        <label class="field-label">Duration (minutes)</label>
        <input type="number" min="15" step="15" class="modal-input" id="resDuration" value="${r?.duration_minutes || (prefill?.tableId && tableById(prefill.tableId)?.area_id ? (state.areas.find(a=>a.id===tableById(prefill.tableId).area_id)?.default_duration_minutes || 90) : 90)}" oninput="state._resDurationTouched=true" onchange="refreshAvailability()"/>
      </div>
    </div>
    <label class="field-label">Source</label>
    <select class="modal-select" id="resSource">
      ${['phone','walk-in','online','website','other'].map(s => `<option value="${s}" ${s===(r?.source||'phone')?'selected':''}>${s}</option>`).join('')}
    </select>
    <label class="field-label">Table</label>
    <select class="modal-select" id="resTable" onchange="onResTableChange()">
      <option value="">Unassigned — assign a table at seating (recommended)</option>
      ${(!r && prefill?.tableId) ? `<option value="${prefill.tableId}" selected>${esc(tableDisplayLabel(tableById(prefill.tableId)))} (checking availability…)</option>` : ''}
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
  refreshAvailability(r?.table_id || prefill?.tableId || '');
};

// Suggests each area's configured default duration the moment a hostess indicates
// where the party will sit — either by picking a specific table, or just an area
// while leaving the table Unassigned. Never overwrites a duration the hostess
// already typed by hand (tracked via state._resDurationTouched).
function applyAreaDefaultDuration(areaId){
  if (state._resDurationTouched || !areaId) return;
  const a = state.areas.find(x => x.id === areaId);
  const el = document.getElementById('resDuration');
  if (a && el) el.value = a.default_duration_minutes || 90;
}
window.onResAreaChange = function(){
  applyAreaDefaultDuration(document.getElementById('resArea').value);
  refreshAvailability();
};
window.onResTableChange = function(){
  const tableId = document.getElementById('resTable').value;
  const t = tableId ? tableById(tableId) : null;
  if (t?.area_id){
    const areaSel = document.getElementById('resArea');
    if (areaSel) areaSel.value = t.area_id;
    applyAreaDefaultDuration(t.area_id);
  }
  refreshAvailability();
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

  const areaId = document.getElementById('resArea')?.value || '';
  const areaName = areaId ? (state.areas.find(a => a.id === areaId)?.name || '') : '';

  const blockedAreaIds = date ? await getBlockedAreaIds(date, time) : new Set();
  const fittingAll = tablesFittingParty(partySize, blockedAreaIds);
  // When an Area is picked, the Table list is scoped to just that area — this is
  // what makes Auto-Assign's area handling meaningful in the first place: without
  // this, a hostess could pick "Speakeasy" here and still see (and pick) a Main
  // table, which is exactly the confusion that led to Auto-Assign ignoring area.
  const fitting = areaId ? fittingAll.filter(t => t.area_id === areaId) : fittingAll;
  const dateReservations = date ? await fetchDateReservations(date, excludeId) : [];
  const stillFree = new Set(simulateAvailability(dateReservations, time, duration, excludeId, blockedAreaIds).map(t => t.id));
  const freeFitting = preferSinglesPerArea(fitting.filter(t => stillFree.has(t.id)));
  const busyFitting = fitting.filter(t => !stillFree.has(t.id));
  const blockedAreaNames = state.areas.filter(a => blockedAreaIds.has(a.id)).map(a => a.name);

  sel.innerHTML = `<option value="">Unassigned — assign a table at seating (recommended)</option>`
    + freeFitting.map(t => `<option value="${t.id}">✅ ${esc(tableDisplayLabel(t))} (${t.section||''}, seats ${t.seats})</option>`).join('')
    + busyFitting.map(t => `<option value="${t.id}">⛔ ${esc(tableDisplayLabel(t))} — reserved for another party at that time</option>`).join('');
  const stillValid = [...sel.options].some(o => o.value === currentVal);
  if (stillValid) sel.value = currentVal;
  // If a table WAS selected but just fell out of the list (party size grew past its
  // capacity, its area got blocked for this date, etc.), the <select> silently lands
  // back on "Unassigned" — flag that loudly instead of saving a booking the hostess
  // didn't actually choose.
  const droppedTable = (!stillValid && currentVal) ? tableById(currentVal) : null;

  // Kept as a separate line (not appended inline) so "N tables available" can never
  // read like it's contradicted by the blocked-area aside right next to it.
  const blockedLine = blockedAreaNames.length
    ? `<div style="color:var(--gray);margin-top:2px">ℹ️ ${esc(blockedAreaNames.join(', '))} ${blockedAreaNames.length===1?'is':'are'} not bookable on this date — excluded from the count above.</div>` : '';

  // Pacing/flow-control readout: only meaningful once an Area is picked (or a
  // specific table implies one) and that area has a cap configured.
  let pacingLine = '';
  const pacingArea = areaId ? state.areas.find(a => a.id === areaId) : null;
  if (pacingArea && pacingArea.max_covers_per_slot && date && time){
    const timeMin = timeToMinutes(time);
    const already = coversInSlot(dateReservations, areaId, timeMin, excludeId);
    const projected = already + partySize;
    const cap = pacingArea.max_covers_per_slot;
    const over = projected > cap;
    pacingLine = `<div style="margin-top:2px;color:${over ? 'var(--danger)' : 'var(--gray)'}">${over ? '⚠️' : '📊'} Pacing: ${esc(pacingArea.name)} ${pacingSlotLabel(timeMin)} would be ${projected}/${cap} covers${over ? ' — over cap, you’ll be asked to confirm on Save.' : '.'}</div>`;
  }

  // Loyalty Vault priority: only meaningful once an Area with a member
  // priority carve-out is picked (Speakeasy) — informs the hostess up front
  // rather than only at Save time, same pattern as pacing above.
  let vaultLine = '';
  if (areaId && date && time){
    const guestId = document.getElementById('resGuestId')?.value || null;
    const reason = vaultHolidayWindowReason(areaId, date, guestId) || vaultCapacityReason(areaId, date, time, duration, partySize, guestId, dateReservations, excludeId);
    if (reason) vaultLine = `<div style="margin-top:2px;color:var(--danger)">🗝️ ${esc(reason)} You'll be asked to confirm on Save.</div>`;
  }

  if (noteEl){
    if (droppedTable){
      noteEl.style.color = 'var(--danger)';
      noteEl.innerHTML = `⚠️ ${esc(tableDisplayLabel(droppedTable))} no longer fits/is free for this party — cleared to Unassigned. Pick another table below or leave it Unassigned.` + blockedLine;
    } else if (!fitting.length){
      noteEl.style.color = 'var(--danger)';
      const areaHint = (areaId && fittingAll.length)
        ? ` ${fittingAll.length} table${fittingAll.length===1?'':'s'} elsewhere would fit — clear the Area filter above to see them.` : '';
      noteEl.innerHTML = (areaId ? `No bookable tables in ${esc(areaName)} fit a party of ${partySize}.` : `No bookable tables fit a party of ${partySize}.`) + areaHint + blockedLine;
    } else if (!freeFitting.length){
      noteEl.style.color = 'var(--warn)';
      noteEl.innerHTML = `⚠️ Fully booked for a party of ${partySize} at that time. <span class="linkBtn" style="cursor:pointer" onclick="waitlistFromReservationModal()">Add to Waitlist instead</span>` + blockedLine;
    } else {
      noteEl.style.color = 'var(--success)';
      noteEl.innerHTML = `${freeFitting.length} table${freeFitting.length===1?'':'s'} available for this party size at this time.` + blockedLine;
    }
    noteEl.innerHTML += pacingLine + vaultLine;
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

  const dateReservations = await fetchDateReservations(date, id);

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
    if (isTableBusy(tableId, time, duration, dateReservations)){
      alert('That table just got booked for an overlapping time — pick a different table or leave it Unassigned.');
      refreshAvailability(tableId);
      return;
    }
  }

  // Pacing/flow control: soft-block if this booking would push the area over its
  // configured covers-per-15-minute-slot cap. This is a warning the hostess can
  // override (e.g. deliberately banking on no-shows), not a hard stop — matching
  // how real-world flow-control systems (OpenTable, Resy) behave. It's checked
  // here rather than only in Auto-Assign so the overbooking never gets created
  // in the first place, instead of being discovered as an unhonored reservation
  // days later.
  const pacingAreaId = (tableId && tableById(tableId)?.area_id) || document.getElementById('resArea')?.value || null;
  if (pacingAreaId){
    const pacingArea = state.areas.find(a => a.id === pacingAreaId);
    if (pacingArea && pacingArea.max_covers_per_slot){
      const timeMin = timeToMinutes(time);
      const already = coversInSlot(dateReservations, pacingAreaId, timeMin, id);
      const projected = already + partySize;
      if (projected > pacingArea.max_covers_per_slot){
        const ok = confirm(`⚠️ Pacing cap: ${pacingArea.name} is set to ${pacingArea.max_covers_per_slot} covers per 15-minute slot.\n\nBooking this party would bring the ${pacingSlotLabel(timeMin)} window to ${projected} covers — over cap.\n\nBook anyway?`);
        if (!ok) return;
      }
    }
  }

  // Loyalty Vault priority: soft-block a non-member (or a member outside
  // their allowed lead time) booking into the Speakeasy's reserved capacity
  // or ahead of their priority-holiday window — same override-with-confirm
  // pattern as pacing, since staff sometimes have a legitimate reason to
  // seat someone there anyway (a VIP walk-in, a manager's call).
  const vaultAreaId = (tableId && tableById(tableId)?.area_id) || document.getElementById('resArea')?.value || null;
  if (vaultAreaId){
    const reason = vaultHolidayWindowReason(vaultAreaId, date, guestId) || vaultCapacityReason(vaultAreaId, date, time, duration, partySize, guestId, dateReservations, id);
    if (reason){
      const ok = confirm(`🗝️ Vault priority: ${reason}\n\nBook anyway?`);
      if (!ok) return;
    }
  }

  const payload = {
    guest_id: guestId,
    party_size: partySize,
    reservation_date: date,
    reservation_time: time,
    duration_minutes: duration,
    table_id: tableId,
    // Kept even when a table IS assigned (it'll just match that table's area) so
    // Auto-Assign still knows the intended area if the table is ever cleared back
    // to Unassigned later.
    preferred_area_id: document.getElementById('resArea').value || null,
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
async function reloadRoster(){
  const { data } = await sb.from('server_roster').select('*').order('name');
  state.roster = data || [];
}
// A server section's assignee can be either a lightweight roster entry (name only,
// no login) or a real staff login account — exactly one of assigned_roster_id /
// assigned_staff_id is set. This resolves either into a display name.
function sectionAssigneeName(s){
  if (s.assigned_roster_id) return state.roster.find(r => r.id === s.assigned_roster_id)?.name || null;
  if (s.assigned_staff_id) return state.staffList.find(st => st.id === s.assigned_staff_id)?.name || null;
  return null;
}
function currentArea(){ return state.areas.find(a => a.id === state.currentAreaId); }

// A Reserved/Assigned table should show what it's actually being held for
// right now, not just the earliest reservation that happens to exist on it
// that day. Without this, a table with an early lunch reservation and a
// separate later dinner reservation would keep showing the (already long
// over) lunch guest's name all evening, since the old logic only sorted by
// time-of-day and never dropped reservations whose window had already
// passed. Prefers whichever reservation is currently in its window or still
// upcoming; only falls back to the day's most recent past reservation if
// every one of them has already ended. "Now" respects the Now Override
// testing tool. On any date other than today (real or overridden), there's
// no meaningful "now" to compare against, so it just shows the day's first.
function pickHeldReservation(candidates){
  if (!candidates.length) return null;
  const sorted = candidates.slice().sort((a,b) => a.reservation_time.localeCompare(b.reservation_time));
  if (state.selectedDate !== todayISO()) return sorted[0];
  const nowMin = timeToMinutes(nowHHMM());
  const stillRelevant = sorted.filter(r => timeToMinutes(r.reservation_time) + (r.duration_minutes || 90) >= nowMin);
  return stillRelevant[0] || sorted[sorted.length - 1];
}

// A table's live color only reflects whatever a human last manually tapped it
// to — it has no built-in awareness that a reservation is about to need that
// exact table. That's fine once a host has proactively marked it Reserved/
// Assigned ahead of time, but nothing forces that to happen, and a table that
// still reads Available can silently have a party arriving in minutes. This
// surfaces a heads-up directly on the tile — independent of its manual status
// — for any table with a reservation starting soon, so a host deciding
// whether to seat a walk-in there sees the collision before it happens rather
// than after. Only meaningful when viewing today (real or Now-Override), same
// as pickHeldReservation.
const UPCOMING_SOON_MINUTES = 45;
function upcomingSoonReservation(tableReservations){
  if (state.selectedDate !== todayISO()) return null;
  const nowMin = timeToMinutes(nowHHMM());
  const soon = tableReservations
    .filter(r => {
      const start = timeToMinutes(r.reservation_time);
      return start >= nowMin && start - nowMin <= UPCOMING_SOON_MINUTES;
    })
    .sort((a,b) => a.reservation_time.localeCompare(b.reservation_time));
  return soon[0] || null;
}

function renderFloorPlanTab(){
  const activeRes = state.reservations.filter(r => r.status === 'seated');
  // For a manually-marked Assigned or Reserved table, show which upcoming
  // reservation is actually holding it (if any) — otherwise the status is just
  // a colored dot with no way to tell who it's being held for.
  const heldRes = state.reservations.filter(r => ['pending','confirmed'].includes(r.status));
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

  const sc = statusColors();
  const preview = state.previewMode ? state.previewData : null;
  const tableEls = tablesInArea.map(t => {
    const occ = activeRes.find(r => r.table_id === t.id);
    let dragAttr, colorStyle, metaHtml;

    if (state.previewMode){
      dragAttr = state.editMode ? `onpointerdown="startDragTable(event,'${t.id}')"` : `onclick="onPreviewTableClick('${t.id}')"`;
      if (!preview){
        colorStyle = `border-color:#c9ced6;background:#c9ced622;opacity:.6;`;
        metaHtml = `<div class="ft-meta">${t.seats} seats</div><div class="ft-meta">Loading…</div>`;
      } else {
        const blocked = !isTableBookable(t, preview.blockedAreaIds);
        const busy = preview.busyByTable.get(t.id);
        const previewColor = blocked ? '#9aa3b0' : (busy ? (sc.seated || STATUS_COLORS_DEFAULT.seated) : (sc.available || STATUS_COLORS_DEFAULT.available));
        colorStyle = `border-color:${previewColor};background:${previewColor}${blocked?'33':'22'};${blocked?'opacity:.6;':''}`;
        metaHtml = `<div class="ft-meta">${t.seats} seats</div>`
          + (blocked ? `<div class="ft-meta">Not bookable</div>`
            : busy ? `<div class="ft-meta">Reserved ${fmtTime(busy.res.reservation_time)}–${fmtTime(minutesToTimeStr(busy.end))}</div><div class="ft-meta">${esc(guestName(guestById(busy.res.guest_id)))} · ${busy.res.party_size}p</div>`
            : `<div class="ft-meta">Free at ${fmtTime(state.previewTime)}</div>`);
      }
    } else {
      dragAttr = state.editMode ? `onpointerdown="startDragTable(event,'${t.id}')"` : `onclick="cycleTableStatus('${t.id}')"`;
      const areaName = state.areas.find(a => a.id === t.area_id)?.name;
      const section = state.serverSections.find(s => s.id === t.server_section_id);
      const serverName = section ? sectionAssigneeName(section) : null;
      const statusColor = sc[t.status] || STATUS_COLORS_DEFAULT.dirty;
      const held = (!occ && ['assigned','reserved'].includes(t.status))
        ? pickHeldReservation(heldRes.filter(r => r.table_id === t.id))
        : null;
      // Only worth flagging when the table isn't already showing a held
      // reservation's name/time via `held` (that already covers it) or
      // actually occupied by the matching seated party via `occ`.
      const upcoming = (!state.serverView && !occ && !held)
        ? upcomingSoonReservation(heldRes.filter(r => r.table_id === t.id))
        : null;
      // Once every open check with items on it is fully paid, flag the table so the host
      // knows it's about to turn over — even though nobody's bussed it / marked it Dirty
      // yet. Only relevant for tables currently shown as Seated.
      const paidUp = !state.serverView && t.status === 'seated' && isTablePaidUp(t.id);
      colorStyle = state.serverView
        ? (section ? `border-color:${section.color};background:${section.color}22;` : 'opacity:.45;')
        : `border-color:${statusColor};background:${statusColor}22;${upcoming ? 'box-shadow:inset 0 0 0 3px #f59e0b;' : paidUp ? 'box-shadow:inset 0 0 0 3px #16a34a;' : ''}`;
      metaHtml = state.serverView
        ? `<div class="ft-meta">${section ? esc(section.name) : 'No section'}</div>${serverName ? `<div class="ft-meta">${esc(serverName)}</div>` : ''}`
        : `<div class="ft-meta">${t.seats} seats</div>${showingAll && areaName ? `<div class="ft-meta">${esc(areaName)}</div>` : ''}`
          + (occ ? `<div class="ft-meta">${esc(guestName(guestById(occ.guest_id)))}</div>`
            : held ? `<div class="ft-meta">${esc(guestName(guestById(held.guest_id)))} · ${fmtTime(held.reservation_time)}</div>`
            : upcoming ? `<div class="ft-meta" style="color:#b45309;font-weight:600">⏰ ${esc(guestName(guestById(upcoming.guest_id)))} in ${timeToMinutes(upcoming.reservation_time) - timeToMinutes(nowHHMM())}m (${fmtTime(upcoming.reservation_time)})</div>` : '')
          + (paidUp ? `<div class="ft-meta" style="color:#16a34a;font-weight:700">💵 Paid — ready to turn</div>` : '');
    }

    return `
      <div id="tbl-${t.id}" class="floor-table shape-${t.shape}" ${dragAttr}
           style="left:${t.pos_x}px;top:${t.pos_y}px;width:${t.width}px;height:${t.height}px;${colorStyle}">
        <div class="ft-name">${esc(t.label)}</div>
        ${metaHtml}
        ${state.editMode ? `<div class="resize-handle" onpointerdown="startResizeTable(event,'${t.id}')" title="Drag to resize"></div>` : ''}
      </div>`;
  }).join('');

  const toolbar = `
    <button class="btn btn-secondary btn-sm" onclick="openBackgroundModal()">🖼 Floor Plan Image</button>
    ${area ? `<button class="btn btn-secondary btn-sm" onclick="openAreaModal('${area.id}')">✏️ Rename Area</button>` : ''}
    ${state.editMode ? `<button class="btn btn-primary btn-sm" onclick="addTableToCanvas()">+ Add Table</button>` : ''}
    <button class="btn ${state.previewMode?'btn-success':'btn-secondary'} btn-sm" onclick="togglePreviewMode()">🕐 Check Availability</button>
    <button class="btn ${state.serverView?'btn-success':'btn-secondary'} btn-sm" onclick="toggleServerView()">🎨 Server View</button>
    <button class="btn ${state.editMode?'btn-success':'btn-secondary'} btn-sm" onclick="toggleEditMode()">${state.editMode ? '✅ Done Editing' : '✏️ Edit Layout'}</button>
  `;

  const previewBar = state.previewMode ? `
    <div class="floor-toolbar" style="margin-bottom:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;">
      <span style="font-weight:700;font-size:13px;">🕐 Checking availability for:</span>
      <input type="date" class="modal-input" style="margin:0;width:auto" value="${state.previewDate}" onchange="setPreviewDateTime('date', this.value)"/>
      <select class="modal-select" style="margin:0;width:auto" onchange="setPreviewDateTime('time', this.value)">${timeOptionsHtml(state.previewTime)}</select>
      <button class="btn btn-secondary btn-sm" onclick="jumpPreviewToNow()">Now</button>
      <span class="panel-sub" style="margin:0">Green = free, red = reserved, gray = area not bookable that date. Tap a free table to book it, tap a reserved one to see/edit that reservation.</span>
    </div>` : '';

  // The live Floor Plan's held-reservation names and upcoming-arrival warning
  // are both scoped to whichever date is currently loaded (state.selectedDate,
  // set from the Reservations tab's date picker) — a separate control from
  // Now Override's simulated clock. Nothing here previously showed which date
  // that was, so a host (or tester) could change Now Override without
  // realizing the Floor Plan was still showing a different day's reservations,
  // and get confusing stale-looking results with no explanation why.
  const viewingToday = state.selectedDate === todayISO();
  const dateNote = state.previewMode ? '' : `<div class="panel-sub" style="margin-top:2px${viewingToday ? '' : ';color:var(--danger);font-weight:600'}">${viewingToday
    ? `Viewing ${fmtDateHuman(state.selectedDate)} (today).`
    : `⚠️ Viewing ${fmtDateHuman(state.selectedDate)} — not today (${fmtDateHuman(todayISO())}). Held-reservation names and the upcoming-arrival warning only compare against "now" when viewing today's date. <span class="linkBtn" style="cursor:pointer" onclick="changeDate(todayISO())">Jump to today</span>`}</div>`;

  return `
  <div class="panel-header">
    <div><h2 class="panel-title">Floor Plan</h2><div class="panel-sub">${state.previewMode ? 'Availability preview — tap a table to book or view its reservation.' : state.editMode ? 'Drag tables to reposition. Tap a table to rename, resize, or delete.' : 'Tap a table to cycle its status.'}</div>${dateNote}</div>
    <div class="floor-toolbar">${toolbar}</div>
  </div>
  <div class="area-tabs" style="margin-bottom:14px">${areaTabs}</div>
  ${previewBar}
  ${renderFloorLegend(sc)}
  ${state.editMode ? `<div class="edit-mode-banner">✏️ Edit Layout is on — drag tables anywhere on the canvas. Changes save automatically.</div>` : ''}
  <div class="floor-canvas-wrap" id="floorCanvasWrap">
    <div id="floorCanvas" class="floor-canvas" style="width:${canvasW}px;height:${canvasH}px;${bgStyle}">
      ${tableEls || '<div class="empty-state" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">No tables here yet. Click "Edit Layout" then "+ Add Table".</div>'}
    </div>
  </div>
  ${!showingAll ? `<div class="panel-sub" style="margin-top:8px">🔍 Zoomed to ${area?esc(area.name):'Unassigned'}. <span class="linkBtn" style="cursor:pointer" onclick="switchArea('__all')">View full floor plan</span></div>` : ''}`;
}

// Shows what the table colors mean — the status legend normally, or a per-server
// legend while Server View is on (since colors mean something different in that mode).
// Colors themselves are editable in Settings > Table Status Colors.
function renderFloorLegend(sc){
  if (state.previewMode){
    return `<div class="floor-legend">
      <span class="legend-chip"><span class="legend-swatch" style="background:${sc.available||STATUS_COLORS_DEFAULT.available}"></span>Free</span>
      <span class="legend-chip"><span class="legend-swatch" style="background:${sc.seated||STATUS_COLORS_DEFAULT.seated}"></span>Reserved</span>
      <span class="legend-chip"><span class="legend-swatch" style="background:#9aa3b0"></span>Not bookable that date</span>
    </div>`;
  }
  if (state.serverView){
    if (!state.serverSections.length) return `<div class="panel-sub" style="margin-bottom:10px">No server sections defined yet — add some in Settings.</div>`;
    return `<div class="floor-legend">${state.serverSections.map(s => `<span class="legend-chip"><span class="legend-swatch" style="background:${esc(s.color)}"></span>${esc(s.name)}</span>`).join('')}<span class="legend-chip"><span class="legend-swatch" style="background:#ccc;opacity:.45"></span>No section</span></div>`;
  }
  return `<div class="floor-legend">${Object.keys(STATUS_LABELS).map(k => `<span class="legend-chip"><span class="legend-swatch" style="background:${sc[k]}"></span>${STATUS_LABELS[k]}</span>`).join('')}<span class="legend-chip"><span class="legend-swatch" style="background:#fff;box-shadow:inset 0 0 0 3px #f59e0b"></span>⏰ Reservation arriving soon</span><span class="legend-chip"><span class="legend-swatch" style="background:#fff;box-shadow:inset 0 0 0 3px #16a34a"></span>💵 Paid — ready to turn</span><span class="panel-sub" style="margin:0 0 0 4px">Customize the status colors in Settings → Table Status Colors.</span></div>`;
}

window.switchArea = function(id){ state.editMode = false; state.currentAreaId = id; render(); };
window.toggleEditMode = function(){ state.editMode = !state.editMode; render(); };
window.toggleServerView = function(){ state.serverView = !state.serverView; render(); };

// ---- Floor Plan availability preview: "what's free if someone calls right now,
// or at 7:30pm on the 20th" — colors tables by projected occupancy for a chosen
// date/time instead of their live physical status. Reuses the same reservation
// data + combo-conflict + area-bookability logic as the booking engine itself, so
// this always agrees with what the Reservations tab would actually offer.
function nowHHMM(){
  const d = getNow();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
window.togglePreviewMode = async function(){
  state.previewMode = !state.previewMode;
  if (state.previewMode){
    if (!state.previewTime) state.previewTime = nowHHMM();
    state.previewData = null; // show a neutral loading state instead of a stale/empty preview
    render();
    await loadFloorPreview();
  }
  render();
};
window.jumpPreviewToNow = async function(){
  state.previewDate = todayISO();
  state.previewTime = nowHHMM();
  await loadFloorPreview();
  render();
};
window.setPreviewDateTime = async function(field, value){
  if (field === 'date') state.previewDate = value; else state.previewTime = value;
  await loadFloorPreview();
  render();
};
async function loadFloorPreview(){
  const targetMin = timeToMinutes(state.previewTime);
  const dateReservations = await fetchDateReservations(state.previewDate, null);
  const busyByTable = new Map();
  dateReservations.forEach(r => {
    if (!r.table_id) return;
    const start = timeToMinutes(r.reservation_time);
    const end = start + (r.duration_minutes || 90);
    if (targetMin >= start && targetMin < end){
      occupiedByBooking(r.table_id).forEach(id => {
        // If a combo's member tables are each individually double-booked somehow,
        // keep whichever reservation actually starts soonest relative to now.
        const existing = busyByTable.get(id);
        if (!existing || start < existing.start) busyByTable.set(id, { res: r, start, end });
      });
    }
  });
  const blockedAreaIds = await getBlockedAreaIds(state.previewDate, state.previewTime);
  state.previewData = { busyByTable, blockedAreaIds };
}

window.onPreviewTableClick = function(tableId){
  const t = tableById(tableId);
  const pd = state.previewData;
  if (!t || !pd) return;
  if (!isTableBookable(t, pd.blockedAreaIds)){
    alert(`${t.label} is in an area not bookable for ${state.previewDate}. Check "📅 Area Availability" on the Reservations tab to see or change why.`);
    return;
  }
  const busy = pd.busyByTable.get(tableId);
  if (busy){
    openReservationModal(busy.res.id);
  } else {
    openReservationModal(null, { date: state.previewDate, time: state.previewTime, tableId });
  }
};

// Re-renders the floor plan (or split view) content while preserving whatever pan/zoom
// the host currently has set, instead of always snapping back to the auto-fit view.
// Necessary because the background poll that now also refreshes checks/payments while
// on this tab (for the "paid up" indicator) triggers a full render every 15s — without
// this, a host who'd manually zoomed into one area would get yanked back to the fit-all
// view every 15 seconds. Only a genuine tab entry (or an area with no prior view yet)
// re-fits from scratch; every other re-render just restores the previous transform/scroll.
let _lastFloorViewSignature = null;
function renderFloorTabPreservingView(html, enteringTab){
  const c = document.getElementById('content');
  const wrap = document.getElementById('floorCanvasWrap');
  const canvas = document.getElementById('floorCanvas');
  // Re-fit whenever the actual view selection changed (area filter, edit mode, server
  // view, preview mode, or which tab) — only a "nothing changed, this render was just a
  // background data refresh" case gets its pan/zoom preserved instead of reset.
  const signature = JSON.stringify([state.tab, state.currentAreaId, state.editMode, state.serverView, state.previewMode]);
  const signatureChanged = signature !== _lastFloorViewSignature;
  _lastFloorViewSignature = signature;
  const prevView = (!enteringTab && !signatureChanged && wrap && canvas)
    ? { transform: canvas.style.transform, scale: canvas.dataset.scale, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop }
    : null;
  c.innerHTML = html;
  if (prevView){
    const w2 = document.getElementById('floorCanvasWrap'), c2 = document.getElementById('floorCanvas');
    if (w2 && c2){
      c2.style.transform = prevView.transform;
      c2.dataset.scale = prevView.scale;
      w2.scrollLeft = prevView.scrollLeft;
      w2.scrollTop = prevView.scrollTop;
      return;
    }
  }
  fitFloorCanvasView();
}
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
  const order = ['available','reserved','assigned','seated','dirty','blocked'];
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
    <label class="field-label">Default reservation duration (minutes)</label>
    <input type="number" min="15" step="15" max="480" class="modal-input" id="areaDefaultDuration" value="${a?.default_duration_minutes || 90}"/>
    <p style="font-size:12px;color:var(--gray);margin-top:-4px">Pre-fills the Duration field on new reservations once a table in this area is picked (e.g. Bar seats might turn in 60 min, a Speakeasy table might run 120). Can always be overridden per reservation.</p>
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
  const default_duration_minutes = Number(document.getElementById('areaDefaultDuration').value) || 90;
  if (!name){ alert('Enter an area name.'); return; }
  if (id){
    await sb.from('floor_areas').update({ name, bookable, default_duration_minutes }).eq('id', id);
  } else {
    const { data, error } = await sb.from('floor_areas').insert({ name, bookable, default_duration_minutes, sort_order: state.areas.length }).select().single();
    if (error){ alert('Error: '+error.message); return; }
    state.currentAreaId = data.id;
  }
  closeModal('formModal');
  await reloadAreas();
  render();
};

window.setAreaDefaultDuration = async function(areaId, value){
  const minutes = Number(value);
  if (!minutes || minutes < 15){ alert('Enter a valid duration (15 minutes or more).'); await reloadAreas(); render(); return; }
  await sb.from('floor_areas').update({ default_duration_minutes: minutes }).eq('id', areaId);
  await reloadAreas();
};
// A blank field means "no cap" (unrestricted, the default) — stored as NULL.
window.setAreaMaxCovers = async function(areaId, value){
  const trimmed = String(value).trim();
  let covers = null;
  if (trimmed !== ''){
    covers = Number(trimmed);
    if (!covers || covers < 1){ alert('Enter a valid cap (1 or more), or leave it blank for no cap.'); await reloadAreas(); render(); return; }
  }
  await sb.from('floor_areas').update({ max_covers_per_slot: covers }).eq('id', areaId);
  await reloadAreas();
};
// A blank field means "no Vault carve-out for this area" — stored as NULL.
window.setAreaMemberPrioritySeats = async function(areaId, value){
  const trimmed = String(value).trim();
  let seats = null;
  if (trimmed !== ''){
    seats = Number(trimmed);
    if (isNaN(seats) || seats < 0){ alert('Enter a valid seat count (0 or more), or leave it blank for no Vault carve-out.'); await reloadAreas(); render(); return; }
  }
  await sb.from('floor_areas').update({ member_priority_seats: seats }).eq('id', areaId);
  await reloadAreas();
};
window.setAreaMemberPriorityReleaseHours = async function(areaId, value){
  const hours = Number(value);
  if (isNaN(hours) || hours < 0){ alert('Enter a valid number of hours (0 or more).'); await reloadAreas(); render(); return; }
  await sb.from('floor_areas').update({ member_priority_release_hours: hours }).eq('id', areaId);
  await reloadAreas();
};

window.setLoyaltyTierField = async function(tierKey, field, value){
  let payload;
  if (field === 'vault_access'){
    payload = { vault_access: !!value };
  } else {
    const num = Number(value);
    if (isNaN(num) || num < 0){ alert('Enter a valid number.'); await reloadLoyaltyTiers(); render(); return; }
    payload = { [field]: num };
  }
  const { error } = await sb.from('loyalty_tiers').update(payload).eq('key', tierKey);
  if (error){ alert('Error: '+error.message); }
  await reloadLoyaltyTiers();
};

window.addPriorityHoliday = async function(){
  const dateEl = document.getElementById('newHolidayDate');
  const labelEl = document.getElementById('newHolidayLabel');
  const date = dateEl?.value;
  const label = (labelEl?.value || '').trim();
  if (!date || !label){ alert('Enter both a date and a label.'); return; }
  const { error } = await sb.from('priority_holidays').insert({ holiday_date: date, label });
  if (error){ alert('Error: '+error.message); return; }
  await reloadPriorityHolidays();
  render();
};
window.deletePriorityHoliday = async function(id){
  if (!confirm('Remove this priority holiday?')) return;
  await sb.from('priority_holidays').delete().eq('id', id);
  await reloadPriorityHolidays();
  render();
};

window.setStatusColor = async function(key, hex){
  const updated = { ...statusColors(), [key]: hex };
  const { error } = await sb.from('floor_plan_settings').update({ status_colors: updated }).eq('id', true);
  if (error){ alert('Error: '+error.message); return; }
  await reloadFloorPlanSettings();
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
      ${state.serverSections.map(s => { const an = sectionAssigneeName(s); return `<option value="${s.id}" ${s.id===t.server_section_id?'selected':''}>${esc(s.name)}${an ? ' — '+esc(an) : ''}</option>`; }).join('')}
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
    // Stamped explicitly with the app's own "now" (real or Now-Override)
    // instead of leaving it to the added_at column's `now()` default, which
    // is the database server's real clock — under Now Override those two
    // diverge, and the "waiting Xm" badge (minutesAgo, which correctly uses
    // getNow()) would measure against a real timestamp instead of a
    // simulated one, producing a nonsense elapsed count.
    added_at: getNow().toISOString(),
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
  await sb.from('waitlist').update({ status:'seated', seated_at: getNow().toISOString() }).eq('id', id);
  await sb.from('reservations').insert({
    guest_id: w.guest_id, party_size: w.party_size, reservation_date: todayISO(),
    reservation_time: getNow().toTimeString().slice(0,5), status:'seated',
    source:'walk-in', seated_at: getNow().toISOString(), created_by: currentStaff.id,
  });
  await Promise.all([reloadWaitlist(), reloadReservationsForDate()]);
  render();
};

// ============================================================================
// GUESTS TAB
// ============================================================================
let _guestSearch = '';
let _loyaltySearch = '';
let _loyaltyStatusFilter = 'active';

// ---- Loyalty Members roster (all members, one row each) -------------------
function renderLoyaltyTab(){
  const q = _loyaltySearch.toLowerCase();
  let list = state.loyaltyMembers.map(m => ({ m, g: guestById(m.guest_id) }))
    .filter(x => x.g);
  if (_loyaltyStatusFilter !== 'all') list = list.filter(x => x.m.status === _loyaltyStatusFilter);
  if (q) list = list.filter(x => guestName(x.g).toLowerCase().includes(q));
  list.sort((a,b) => guestName(a.g).localeCompare(guestName(b.g)));

  const activeMembers = state.loyaltyMembers.filter(m => m.status === 'active');
  const mrr = activeMembers.reduce((s,m) => s + Number(m.locked_monthly_price ?? loyaltyTierByKey(m.tier_key)?.monthly_price ?? 0), 0);
  const byTier = {};
  activeMembers.forEach(m => { byTier[m.tier_key] = (byTier[m.tier_key]||0) + 1; });
  const tierSummary = state.loyaltyTiers.map(t => `${t.name}: ${byTier[t.key]||0}`).join(' · ');

  const rows = list.map(({m,g}) => {
    const tierName = m.locked_tier_name || loyaltyTierByKey(m.tier_key)?.name || m.tier_key;
    const suspended = m.priority_suspended_until && m.priority_suspended_until >= todayISO();
    const nextDue = nextBillingDue(m);
    const statusBadge = m.status === 'cancelled'
      ? `<span class="badge badge-cancelled">Cancelled</span>`
      : suspended ? `<span class="badge badge-no_show">Suspended</span>` : `<span class="badge badge-confirmed">Active</span>`;
    return `<tr style="cursor:pointer" onclick="openGuestModal('${g.id}')">
      <td>${esc(guestName(g))}</td>
      <td>${esc(tierName)}</td>
      <td>${statusBadge}</td>
      <td>${m.status==='cancelled' ? '—' : `${cocktailsRemaining(m)} / ${lockedCocktailsPerMonth(m)}`}</td>
      <td>${m.status==='cancelled' ? '—' : `$${creditRemaining(m).toFixed(2)} / $${lockedCreditPerQuarter(m).toFixed(2)}`}</td>
      <td>${new Date(m.joined_at).toLocaleDateString()}</td>
      <td>${m.commitment_end_at ? new Date(m.commitment_end_at).toLocaleDateString() : '—'}</td>
      <td>${m.last_billed_at ? new Date(m.last_billed_at).toLocaleDateString() : 'never'}</td>
      <td>${m.status==='cancelled' ? '—' : (nextDue ? new Date(nextDue).toLocaleDateString() : '—')}</td>
    </tr>`;
  }).join('');

  return `
  <div class="panel-header">
    <div><h2 class="panel-title">Loyalty Members</h2><div class="panel-sub">${activeMembers.length} active members · $${mrr.toFixed(2)}/mo recurring · ${tierSummary}</div></div>
  </div>
  <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
    <input type="text" class="search-input" id="loyaltySearchInput" style="margin:0;flex:1;min-width:200px" placeholder="Search by name…" value="${esc(_loyaltySearch)}" oninput="searchLoyalty(this.value)"/>
    <select class="modal-select" style="margin:0;width:auto" onchange="filterLoyaltyStatus(this.value)">
      <option value="active" ${_loyaltyStatusFilter==='active'?'selected':''}>Active only</option>
      <option value="cancelled" ${_loyaltyStatusFilter==='cancelled'?'selected':''}>Cancelled only</option>
      <option value="all" ${_loyaltyStatusFilter==='all'?'selected':''}>All</option>
    </select>
  </div>
  ${list.length ? `<table class="data-table">
    <thead><tr><th>Guest</th><th>Tier</th><th>Status</th><th>Cocktails left/mo</th><th>Credit left/qtr</th><th>Joined</th><th>Commitment ends</th><th>Last billed</th><th>Next due</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<div class="empty-state"><div class="empty-state-icon">💳</div>No members match.</div>`}
  <div class="panel-sub" style="margin-top:10px">Click a row to open that guest's profile and manage their membership. Billing dates are logged manually here — this app doesn't charge cards.</div>`;
}
window.searchLoyalty = function(v){ _loyaltySearch = v; render(); };
window.filterLoyaltyStatus = function(v){ _loyaltyStatusFilter = v; render(); };
function renderGuestsTab(){
  const q = _guestSearch.toLowerCase();
  const list = state.guests.filter(g => !q || guestName(g).toLowerCase().includes(q) || (g.phone||'').includes(q)).slice(0,60);
  const items = list.length ? list.map(g => {
    const member = activeLoyaltyMember(g.id);
    const memberTierName = member ? (member.locked_tier_name || loyaltyTierByKey(member.tier_key)?.name) : null;
    return `
    <div class="guest-item" onclick="openGuestModal('${g.id}')">
      <div>
        <div class="res-name">${esc(guestName(g))} ${g.vip ? '<span class="badge badge-vip">VIP</span>':''} ${memberTierName ? `<span class="badge badge-vip" style="background:#122b22">${esc(memberTierName)}</span>`:''}</div>
        <div class="res-meta">${esc(g.phone||'no phone')} · ${g.visit_count} visits${g.no_show_count ? ' · '+g.no_show_count+' no-shows':''}</div>
      </div>
      <div>${(g.tags||[]).map(t=>`<span class="badge badge-confirmed">${esc(t)}</span>`).join(' ')}</div>
    </div>`;
  }).join('') : `<div class="empty-state"><div class="empty-state-icon">👥</div>No guests found.</div>`;

  return `
  <div class="panel-header">
    <div><h2 class="panel-title">Guests</h2><div class="panel-sub">${state.guests.length} total guests on file</div></div>
    <button class="btn btn-primary" onclick="openGuestModal()">+ New Guest</button>
  </div>
  <input type="text" class="search-input" id="guestSearchInput" placeholder="Search by name or phone…" value="${esc(_guestSearch)}" oninput="searchGuests(this.value)"/>
  ${items}`;
}

window.searchGuests = function(v){ _guestSearch = v; render(); };

window.openGuestModal = function(id){
  const g = id ? guestById(id) : null;
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
    ${g ? `<div class="modal-section"><h4>Stats</h4><div class="res-meta">${g.visit_count} visits · ${g.no_show_count} no-shows · last visit ${g.last_visit_at ? new Date(g.last_visit_at).toLocaleDateString() : 'never'}</div></div>` : ''}
    ${g ? `<div class="modal-section"><h4>Visit History</h4><div id="guestVisitHistory"><div class="panel-sub" style="margin:0">Loading…</div></div></div>` : ''}
    ${g && can('manage_loyalty_program') ? renderLoyaltySection(g) : ''}
    <div class="modal-actions">
      ${g ? `<button class="modal-btn modal-btn-danger" onclick="deleteGuest('${g.id}')">Delete</button>` : ''}
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveGuest(${g ? `'${g.id}'` : 'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
  if (g) loadGuestVisitHistory(g.id);
};

// Every reservation row (walk-in or booked ahead) is guest-linked, so this
// table doubles as the full visit log — fetched fresh from the DB each time
// the modal opens rather than from whatever date happens to be loaded in
// state.reservations, so it shows a guest's entire history, not just today's.
async function loadGuestVisitHistory(guestId){
  const el = document.getElementById('guestVisitHistory');
  const { data, error } = await sb.from('reservations')
    .select('reservation_date, reservation_time, party_size, status, source, table_id')
    .eq('guest_id', guestId)
    .order('reservation_date', { ascending: false })
    .order('reservation_time', { ascending: false })
    .limit(50);
  if (!el) return; // modal was closed before this resolved
  if (error){ el.innerHTML = `<div class="panel-sub" style="margin:0">Couldn't load visit history.</div>`; return; }
  const rows = data || [];
  if (!rows.length){ el.innerHTML = `<div class="panel-sub" style="margin:0">No visits on record yet.</div>`; return; }
  const statusLabels = { completed:'Completed', no_show:'No-show', cancelled:'Cancelled', seated:'Seated', confirmed:'Upcoming', pending:'Upcoming' };
  el.innerHTML = `<div style="max-height:220px;overflow-y:auto">${rows.map(r => {
    const t = tableById(r.table_id);
    return `<div class="res-meta" style="display:flex;justify-content:space-between;gap:10px;padding:3px 0">
      <span>${fmtDateHuman(r.reservation_date)} ${fmtTime(r.reservation_time)} · ${r.party_size} guests${t ? ' · '+esc(tableDisplayLabel(t)) : ''} <span style="color:var(--gray)">(${esc(r.source||'phone')})</span></span>
      <span class="badge badge-${r.status}">${statusLabels[r.status] || r.status}</span>
    </div>`;
  }).join('')}</div>
  ${rows.length === 50 ? `<div class="panel-sub" style="margin:6px 0 0">Showing the 50 most recent.</div>` : ''}`;
}

// ---- Loyalty membership management (inside the Guest modal) ---------------
function renderLoyaltySection(g){
  const member = loyaltyMemberByGuestId(g.id);
  const tierOptions = state.loyaltyTiers.map(t => `<option value="${t.key}">${esc(t.name)} — $${t.monthly_price}/mo</option>`).join('');

  if (!member){
    return `<div class="modal-section"><h4>Loyalty Membership</h4>
      <div class="res-meta" style="margin-bottom:8px">Not enrolled.</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <select class="modal-select" style="margin:0" id="loyaltyEnrollTier">${tierOptions}</select>
        <button class="btn btn-sm btn-primary" onclick="enrollLoyalty('${g.id}')">Enroll</button>
      </div>
    </div>`;
  }

  const tier = loyaltyTierByKey(member.tier_key);
  const tierName = member.locked_tier_name || tier?.name || member.tier_key;
  const price = member.locked_monthly_price ?? tier?.monthly_price;
  const vaultAccess = member.locked_vault_access ?? tier?.vault_access ?? false;
  const vaultGuests = member.locked_vault_guest_allowance ?? tier?.vault_guest_allowance ?? 0;
  const creditMin = member.locked_credit_min_check ?? tier?.credit_min_check ?? 0;
  const cocktailsLeft = cocktailsRemaining(member);
  const creditLeft = creditRemaining(member);
  const suspended = member.priority_suspended_until && member.priority_suspended_until >= todayISO();
  const nextDue = nextBillingDue(member);

  if (member.status === 'cancelled'){
    return `<div class="modal-section"><h4>Loyalty Membership</h4>
      <div class="res-meta">${esc(tierName)} — cancelled ${member.cancelled_at ? 'on '+new Date(member.cancelled_at).toLocaleDateString() : ''}</div>
      <div class="modal-actions" style="padding-top:10px;justify-content:flex-start">
        <button class="btn btn-sm btn-primary" onclick="reactivateLoyalty('${member.id}')">Re-enroll (new 12-month term)</button>
      </div>
    </div>`;
  }

  return `<div class="modal-section"><h4>Loyalty Membership</h4>
    <div class="res-meta"><b>${esc(tierName)}</b> — $${(price??0).toFixed(2)}/mo (locked in at signup) · joined ${new Date(member.joined_at).toLocaleDateString()} · commitment through ${member.commitment_end_at ? new Date(member.commitment_end_at).toLocaleDateString() : '—'}</div>
    <div class="res-meta" style="margin-top:4px">🍸 ${cocktailsLeft} of ${lockedCocktailsPerMonth(member)} featured cocktails left this month</div>
    <div class="res-meta">💳 $${creditLeft.toFixed(2)} of $${lockedCreditPerQuarter(member).toFixed(2)} credit left this quarter (min. check $${creditMin})</div>
    ${vaultAccess ? `<div class="res-meta">🗝️ Vault access — member + ${vaultGuests} guest${vaultGuests===1?'':'s'}</div>` : `<div class="res-meta">No Vault access at this tier.</div>`}
    <div class="res-meta">💵 Last billed ${member.last_billed_at ? new Date(member.last_billed_at).toLocaleDateString() : 'never logged'} · next due ${nextDue ? new Date(nextDue).toLocaleDateString() : '—'}</div>
    ${suspended ? `<div class="res-meta" style="color:var(--danger);font-weight:600">⚠️ Priority booking suspended until ${new Date(member.priority_suspended_until).toLocaleDateString()} (no-show policy)</div>` : ''}
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;">
      <button class="btn btn-sm btn-secondary" onclick="openLogCocktailModal('${member.id}')" ${cocktailsLeft<=0?'disabled':''}>Log cocktail redemption</button>
      <button class="btn btn-sm btn-secondary" onclick="redeemLoyaltyCredit('${member.id}')" ${creditLeft<=0?'disabled':''}>Log credit redemption</button>
      <button class="btn btn-sm btn-secondary" onclick="logLoyaltyBilling('${member.id}')">Log billing charge</button>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px;">
      <select class="modal-select" style="margin:0" id="loyaltyChangeTier-${member.id}">${state.loyaltyTiers.map(t=>`<option value="${t.key}" ${t.key===member.tier_key?'selected':''}>${esc(t.name)} — $${t.monthly_price}/mo</option>`).join('')}</select>
      <button class="btn btn-sm btn-secondary" onclick="changeLoyaltyTier('${member.id}')">Change tier</button>
      <button class="btn btn-sm btn-danger" onclick="cancelLoyaltyMembership('${member.id}')">Cancel membership</button>
    </div>
    <div class="panel-sub" style="margin-top:6px">Changing tier re-locks pricing and benefits to that tier's current terms.</div>
  </div>`;
}

// Snapshots a tier's current price/benefits so future edits in Settings
// don't retroactively reprice a member already locked into these terms.
function lockedFieldsForTier(tierKey){
  const t = loyaltyTierByKey(tierKey);
  if (!t) return {};
  return {
    locked_tier_name: t.name, locked_monthly_price: t.monthly_price,
    locked_cocktails_per_month: t.cocktails_per_month, locked_credit_per_quarter: t.credit_per_quarter,
    locked_credit_min_check: t.credit_min_check, locked_vault_access: t.vault_access,
    locked_vault_guest_allowance: t.vault_guest_allowance, locked_discount_pct: t.discount_pct,
  };
}

window.enrollLoyalty = async function(guestId){
  const tierKey = document.getElementById('loyaltyEnrollTier').value;
  const joined = todayISO();
  const end = new Date(joined); end.setFullYear(end.getFullYear()+1);
  const { error } = await sb.from('loyalty_members').insert({
    guest_id: guestId, tier_key: tierKey, status: 'active', joined_at: joined,
    commitment_end_at: toLocalISODate(end), ...lockedFieldsForTier(tierKey),
  });
  if (error){ alert('Error: '+error.message); return; }
  await reloadLoyaltyMembers();
  openGuestModal(guestId);
};

window.changeLoyaltyTier = async function(memberId){
  const tierKey = document.getElementById('loyaltyChangeTier-'+memberId).value;
  if (!confirm('Changing tier re-locks this member into the new tier\'s current price and benefits. Continue?')) return;
  await sb.from('loyalty_members').update({ tier_key: tierKey, ...lockedFieldsForTier(tierKey) }).eq('id', memberId);
  await reloadLoyaltyMembers();
  const m = state.loyaltyMembers.find(x=>x.id===memberId);
  await reloadGuests();
  if (m) openGuestModal(m.guest_id);
};

window.logLoyaltyBilling = async function(memberId){
  await sb.from('loyalty_members').update({ last_billed_at: todayISO() }).eq('id', memberId);
  await reloadLoyaltyMembers();
  const m = state.loyaltyMembers.find(x=>x.id===memberId);
  if (m) openGuestModal(m.guest_id);
};

window.cancelLoyaltyMembership = async function(memberId){
  if (!confirm('Cancel this membership? Unused credit/cocktails for the current period will be forfeited per the membership terms.')) return;
  const m = state.loyaltyMembers.find(x=>x.id===memberId);
  await sb.from('loyalty_members').update({ status:'cancelled', cancelled_at: todayISO() }).eq('id', memberId);
  await reloadLoyaltyMembers();
  await reloadGuests();
  if (m) openGuestModal(m.guest_id);
};

window.reactivateLoyalty = async function(memberId){
  const joined = todayISO();
  const end = new Date(joined); end.setFullYear(end.getFullYear()+1);
  const m = state.loyaltyMembers.find(x=>x.id===memberId);
  await sb.from('loyalty_members').update({
    status:'active', joined_at: joined, commitment_end_at: toLocalISODate(end), cancelled_at: null,
    cocktails_used_period: 0, cocktails_period_key: null, credit_used_period: 0, credit_period_key: null,
    last_billed_at: null, ...(m ? lockedFieldsForTier(m.tier_key) : {}),
  }).eq('id', memberId);
  await reloadLoyaltyMembers();
  await reloadGuests();
  if (m) openGuestModal(m.guest_id);
};

// Swaps the guest modal's content for a small confirm form (same pattern as
// openSeatModal) rather than logging immediately on click — lets a host pick
// how many cocktails to log in one go and confirm before it's saved.
window.openLogCocktailModal = function(memberId){
  const m = state.loyaltyMembers.find(x => x.id === memberId);
  if (!m) return;
  const g = guestById(m.guest_id);
  const remaining = cocktailsRemaining(m);
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Log Cocktail Redemption</h3>
    <p class="modal-user-email">${esc(guestName(g))} — ${remaining} of ${lockedCocktailsPerMonth(m)} left this month</p>
    <label class="field-label">Number of cocktails to log</label>
    <select class="modal-select" id="cocktailLogQty">
      ${Array.from({length: Math.max(remaining,1)}, (_,i) => i+1).map(n => `<option value="${n}">${n}</option>`).join('')}
    </select>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="openGuestModal('${g.id}')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="confirmLogCocktails('${memberId}')">Log Selected</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.confirmLogCocktails = async function(memberId){
  const qty = Number(document.getElementById('cocktailLogQty').value);
  const m = state.loyaltyMembers.find(x=>x.id===memberId);
  if (!m || !qty || qty < 1) return;
  const period = currentMonthKey();
  const used = (m.cocktails_period_key === period ? m.cocktails_used_period : 0) + qty;
  await sb.from('loyalty_members').update({ cocktails_used_period: used, cocktails_period_key: period }).eq('id', memberId);
  await sb.from('loyalty_redemptions').insert({ loyalty_member_id: memberId, type:'cocktail', amount: qty });
  await reloadLoyaltyMembers();
  openGuestModal(m.guest_id);
};

window.redeemLoyaltyCredit = async function(memberId){
  const m = state.loyaltyMembers.find(x=>x.id===memberId);
  if (!m) return;
  const tier = loyaltyTierByKey(m.tier_key);
  const remaining = creditRemaining(m);
  const input = prompt(`Amount to redeem (up to $${remaining.toFixed(2)} left this quarter):`, remaining.toFixed(2));
  const amount = Number(input);
  if (!input || !amount || amount <= 0){ return; }
  if (amount > remaining){ alert(`That's more than the $${remaining.toFixed(2)} remaining this quarter.`); return; }
  const period = currentQuarterKey();
  const used = (m.credit_period_key === period ? m.credit_used_period : 0) + amount;
  await sb.from('loyalty_members').update({ credit_used_period: used, credit_period_key: period }).eq('id', memberId);
  await sb.from('loyalty_redemptions').insert({ loyalty_member_id: memberId, type:'credit', amount });
  await reloadLoyaltyMembers();
  openGuestModal(m.guest_id);
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
  await reloadGuests();
  render();
};
async function reloadGuests(){
  const { data } = await sb.from('guests').select('*').order('last_name');
  state.guests = data || [];
}

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
  const end = getNow();
  const start = getNow();
  start.setDate(end.getDate() - (state.dashRange - 1));
  const startISO = toLocalISODate(start);
  const endISO = toLocalISODate(end);

  const startTs = new Date(startISO+'T00:00:00').toISOString();
  const endTs = new Date(endISO+'T23:59:59.999').toISOString();

  const [{ data: kpiRows }, { data: allRes }, { data: payRows }, { data: discRows }, { data: itemRows }] = await Promise.all([
    sb.from('kpi_daily').select('*').gte('day', startISO).lte('day', endISO),
    sb.from('reservations').select('reservation_time,party_size,status,guest_id').gte('reservation_date', startISO).lte('reservation_date', endISO),
    sb.from('payments').select('*').gte('created_at', startTs).lte('created_at', endTs),
    sb.from('check_discounts').select('*').gte('created_at', startTs).lte('created_at', endTs),
    sb.from('check_items').select('check_id,fired_at,delivered_at,status').gte('created_at', startTs).lte('created_at', endTs),
  ]);
  const pays = payRows || [];
  const payCheckIds = [...new Set(pays.map(p=>p.check_id))];
  const { data: payChecks } = payCheckIds.length ? await sb.from('checks').select('id,server_id').in('id', payCheckIds) : { data: [] };
  const checksById = {}; (payChecks||[]).forEach(c=>checksById[c.id]=c);

  const totalSales = pays.reduce((s,p)=>s+Number(p.amount)-Number(p.refunded_amount||0),0);
  const totalTips = pays.reduce((s,p)=>s+Number(p.tip_amount||0),0);
  const totalRefunds = pays.reduce((s,p)=>s+Number(p.refunded_amount||0),0);
  const tipPct = totalSales ? (totalTips/totalSales*100) : 0;

  const bySrv = {};
  pays.forEach(p => {
    const srvId = checksById[p.check_id]?.server_id;
    if (!srvId) return;
    bySrv[srvId] = bySrv[srvId] || { sales:0, tips:0 };
    bySrv[srvId].sales += Number(p.amount) - Number(p.refunded_amount||0);
    bySrv[srvId].tips += Number(p.tip_amount||0);
  });
  const serverRows = Object.keys(bySrv).map(id => {
    const st = state.staffList.find(s=>s.id===id);
    const { sales, tips } = bySrv[id];
    return { name: st?.name||'?', sales, tips, tipPct: sales?(tips/sales*100):0 };
  }).sort((a,b)=>b.sales-a.sales);

  const discs = discRows || [];
  const compTotal = discs.filter(d=>d.type==='comp_item').reduce((s,d)=>s+Number(d.amount||0),0);
  const compCount = discs.filter(d=>d.type==='comp_item').length;
  const discretionaryCount = discs.filter(d=>d.type==='discretionary_discount').length;
  const loyaltyDiscCount = discs.filter(d=>d.type==='loyalty_discount').length;

  const deliveredItems = (itemRows||[]).filter(i=>i.status==='delivered' && i.fired_at && i.delivered_at);
  const avgOrderMin = deliveredItems.length ? deliveredItems.reduce((s,i)=>s+(new Date(i.delivered_at)-new Date(i.fired_at))/60000,0)/deliveredItems.length : null;
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

    <div class="section-heading">Sales &amp; Tips</div>
    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="kpi-card"><div class="kpi-value">$${totalSales.toFixed(2)}</div><div class="kpi-label">Total Sales</div></div>
      <div class="kpi-card"><div class="kpi-value">$${totalTips.toFixed(2)}</div><div class="kpi-label">Total Tips</div></div>
      <div class="kpi-card"><div class="kpi-value">${tipPct.toFixed(1)}%</div><div class="kpi-label">Tip %</div></div>
      <div class="kpi-card"><div class="kpi-value">${avgOrderMin!=null?avgOrderMin.toFixed(1)+'m':'—'}</div><div class="kpi-label">Avg Order Time</div></div>
    </div>

    <div class="section-heading">Server Tips</div>
    <div class="card" style="margin-bottom:20px">
      <table class="data-table">
        <thead><tr><th>Server</th><th>Sales</th><th>Tips</th><th>Tip %</th></tr></thead>
        <tbody>
          ${serverRows.map(r=>`<tr><td>${esc(r.name)}</td><td>$${r.sales.toFixed(2)}</td><td>$${r.tips.toFixed(2)}</td><td>${r.tipPct.toFixed(1)}%</td></tr>`).join('') || '<tr><td colspan="4"><span class="panel-sub">No payments in this range.</span></td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="section-heading">Comps, Discounts &amp; Refunds</div>
    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="kpi-card"><div class="kpi-value">$${compTotal.toFixed(2)}</div><div class="kpi-label">Comps (${compCount})</div></div>
      <div class="kpi-card"><div class="kpi-value">${discretionaryCount}</div><div class="kpi-label">Discretionary Discounts</div></div>
      <div class="kpi-card"><div class="kpi-value">${loyaltyDiscCount}</div><div class="kpi-label">Membership Discounts</div></div>
      <div class="kpi-card"><div class="kpi-value">$${totalRefunds.toFixed(2)}</div><div class="kpi-label">Refunds</div></div>
    </div>

    <div class="section-heading">Reservations by Hour</div>
    <div class="card">${hourBars || '<div class="empty-state">No data in this range.</div>'}</div>`;
}

// ============================================================================
// ORDERS TAB — table/check selection, item entry with modifiers, firing to
// the kitchen/bar, check splitting (equal-ways or item-to-item move), and
// linking a loyalty membership for automatic discounting at payment time
// (Phase 8 will read checks.loyalty_member_id to apply the discount).
// ============================================================================
async function loadOrdersData(){
  const { data: checks } = await sb.from('checks').select('*').eq('status','open').order('opened_at');
  state.checks = checks || [];
  const ids = state.checks.map(c=>c.id);
  if (ids.length){
    const [{ data: items }, { data: discounts }, { data: pays }] = await Promise.all([
      sb.from('check_items').select('*').in('check_id', ids).order('created_at'),
      sb.from('check_discounts').select('*').in('check_id', ids).order('created_at'),
      sb.from('payments').select('*').in('check_id', ids).order('created_at'),
    ]);
    state.checkItems = items || [];
    state.checkDiscounts = discounts || [];
    state.payments = pays || [];
  } else {
    state.checkItems = [];
    state.checkDiscounts = [];
    state.payments = [];
  }
  // guests/loyaltyMembers are loaded once at sign-in and never re-fetched wholesale — fine on
  // the device that made a change (it reloads its own local copy right after), but a second
  // device just sitting on Orders won't otherwise learn about a guest linked/created, or a
  // membership linked, by someone else mid-shift. Top up only the specific rows this device's
  // open checks now reference but doesn't have yet, so that resolves within one poll cycle
  // instead of needing a full page reload.
  const missingGuestIds = [...new Set(state.checks.map(c=>c.guest_id).filter(Boolean))].filter(id => !state.guests.some(g=>g.id===id));
  const missingMemberIds = [...new Set(state.checks.map(c=>c.loyalty_member_id).filter(Boolean))].filter(id => !state.loyaltyMembers.some(m=>m.id===id));
  const topUps = [];
  if (missingGuestIds.length) topUps.push(sb.from('guests').select('*').in('id', missingGuestIds).then(r => { if (r.data?.length) state.guests = [...state.guests, ...r.data]; }));
  if (missingMemberIds.length) topUps.push(sb.from('loyalty_members').select('*').in('id', missingMemberIds).then(r => { if (r.data?.length) state.loyaltyMembers = [...state.loyaltyMembers, ...r.data]; }));
  if (topUps.length) await Promise.all(topUps);
  render();
}
// Discount total (dollars) currently applied to a check, excluding item comps (which already
// remove their own item from the subtotal by voiding it — counting them again would double-dip).
function checkDiscountTotal(checkId, subtotal){
  return state.checkDiscounts.filter(d => d.check_id === checkId && d.type !== 'comp_item')
    .reduce((s,d) => s + (d.percent ? subtotal * (d.percent/100) : (Number(d.amount)||0)), 0);
}
function checkTotalDue(checkId){
  const items = state.checkItems.filter(ci => ci.check_id === checkId && ci.status !== 'voided');
  const subtotal = items.reduce((s,ci)=>s+checkItemTotal(ci), 0);
  return Math.max(0, subtotal - checkDiscountTotal(checkId, subtotal));
}
// True once every open check on a table that actually has items on it has been paid down
// to zero — signals to the host that the table is effectively done, even though nobody has
// bussed it (changed its floor status to Dirty) yet. A check that's still totally empty
// (opened but nothing rung in, nothing paid) doesn't count either way — it just means
// no one's ordered, not that they're "paid up."
function isTablePaidUp(tableId){
  const openChecks = state.checks.filter(c => c.table_id === tableId && c.status === 'open');
  if (!openChecks.length) return false;
  const withItems = openChecks.filter(c => state.checkItems.some(ci => ci.check_id === c.id && ci.status !== 'voided'));
  if (!withItems.length) return false;
  return withItems.every(c => (checkTotalDue(c.id) - checkAmountPaid(c.id)) <= 0.01);
}
function checkAmountPaid(checkId){
  return state.payments.filter(p => p.check_id === checkId).reduce((s,p) => s + Number(p.amount) - Number(p.refunded_amount||0), 0);
}
// Every employee who currently holds `permKey` (self or via a per-employee override) — used to
// populate the manager dropdown for a PIN-approval prompt without anyone else having to log in.
function staffHasPermission(staffId, permKey){
  const st = state.staffList.find(s=>s.id===staffId);
  if (!st) return false;
  if (st.role === 'admin') return true;
  const ov = state.staffOverrides.find(o=>o.staff_id===staffId && o.permission_key===permKey);
  if (ov) return ov.granted;
  return state.rolePermissions.some(rp => rp.role === st.role && rp.permission_key === permKey);
}
function eligibleApprovers(permKey){
  return state.staffList.filter(s => s.active && staffHasPermission(s.id, permKey));
}
// Generic PIN-approval gate: if the current employee already holds the permission themselves,
// runs the action immediately (self-authorized). Otherwise prompts for a manager (by name — no
// separate login) plus their PIN, and lets the server-side RPC verify both the PIN and that
// manager's authority before doing anything privileged.
function withApproval(permKey, actionLabel, actionFn){
  if (can(permKey)) { actionFn(null, null); return; }
  const approvers = eligibleApprovers(permKey);
  if (!approvers.length){ alert('No one is currently set up to approve this. Ask an admin to grant the permission.'); return; }
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Manager Approval Needed</h3>
    <div class="panel-sub" style="margin-bottom:10px">${esc(actionLabel)} requires a manager's PIN.</div>
    <label class="field-label">Manager</label>
    <select class="modal-select" id="apprStaff">${approvers.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <label class="field-label">PIN</label>
    <input type="password" inputmode="numeric" class="modal-input" id="apprPin"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" id="apprSubmitBtn">Approve</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
  document.getElementById('apprSubmitBtn').onclick = () => {
    const approverId = document.getElementById('apprStaff').value;
    const pin = document.getElementById('apprPin').value;
    if (!pin){ alert('Enter the PIN.'); return; }
    actionFn(approverId, pin);
  };
}
function checkItemTotal(ci){
  const modTotal = (ci.modifiers||[]).reduce((s,m)=>s+(Number(m.price_delta)||0),0);
  return (Number(ci.price_snapshot) + modTotal) * ci.quantity;
}
function renderOrdersTab(){
  const myTables = state.tables.filter(t => !t.is_combo && t.active);
  const grouped = {};
  myTables.forEach(t => {
    const areaName = state.areas.find(a=>a.id===t.area_id)?.name || 'Unassigned';
    (grouped[areaName] = grouped[areaName]||[]).push(t);
  });
  const activeChecks = state.checks.filter(c => c.status === 'open' && c.table_id === state.ordersActiveTableId);
  const activeCheck = state.checks.find(c => c.id === state.ordersActiveCheckId && c.status === 'open');

  const avgMin = avgOrderTimeMinutes();
  return `
  <div class="panel-header"><h2 class="panel-title">Orders</h2>
    <div style="display:flex;align-items:center;gap:12px">
      ${avgMin!=null?`<span class="panel-sub" style="margin:0">Avg order time: ${avgMin.toFixed(1)} min</span>`:''}
      ${(can('sell_gift_card')||can('redeem_gift_card'))?`<button class="btn btn-secondary btn-sm" onclick="openGiftCardsModal()">🎁 Gift Cards</button>`:''}
      ${can('take_payment')?`<button class="btn btn-secondary btn-sm" onclick="openRecentPaymentsModal()">Recent Payments</button>`:''}
    </div>
  </div>
  <div class="orders-layout">
    <div class="card orders-sidebar">
      ${Object.keys(grouped).length ? `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:4px">
        <span class="linkBtn" style="cursor:pointer;font-size:12px" onclick='setOrdersAreasCollapsed(${JSON.stringify(Object.keys(grouped))})'>Collapse all</span>
        <span class="linkBtn" style="cursor:pointer;font-size:12px" onclick="setOrdersAreasCollapsed([])">Expand all</span>
      </div>` : ''}
      ${Object.keys(grouped).map(areaName => {
        const collapsed = state.ordersCollapsedAreas.includes(areaName);
        const zoneCheckCount = grouped[areaName].reduce((s,t)=>s+state.checks.filter(c=>c.status==='open' && c.table_id===t.id).length, 0);
        return `
        <div class="panel-sub" style="margin:10px 0 4px;font-weight:600;display:flex;justify-content:space-between;align-items:center;cursor:pointer" onclick='toggleOrdersAreaCollapse(${JSON.stringify(areaName)})'>
          <span>${collapsed?'▸':'▾'} ${esc(areaName)}</span>
          ${collapsed && zoneCheckCount ? `<span class="badge badge-pending">${zoneCheckCount} check${zoneCheckCount>1?'s':''}</span>` : ''}
        </div>
        ${collapsed ? '' : grouped[areaName].map(t => {
          const count = state.checks.filter(c=>c.status==='open' && c.table_id===t.id).length;
          return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:5px 6px;cursor:pointer;border-radius:6px;${state.ordersActiveTableId===t.id?'background:#eef2ff':''}" onclick="selectOrdersTable('${t.id}')">
            <span>${esc(t.label)}</span>
            ${count?`<span class="badge badge-pending">${count} check${count>1?'s':''}</span>`:''}
          </div>`;
        }).join('')}
      `;
      }).join('') || '<div class="panel-sub">No tables set up yet.</div>'}
    </div>

    <div class="orders-main">
      ${!state.ordersActiveTableId ? `<div class="card"><div class="panel-sub" style="margin:0">Pick a table on the left to open or view its checks.</div></div>` : `
        <div class="card" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <h3 style="margin:0">${esc(tableById(state.ordersActiveTableId)?.label||'')}</h3>
            <button class="btn btn-secondary btn-sm" onclick="openNewCheckModal()">+ New Check</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
            ${activeChecks.length ? activeChecks.map(c => {
              const items = state.checkItems.filter(ci=>ci.check_id===c.id && ci.status!=='voided');
              const total = items.reduce((s,ci)=>s+checkItemTotal(ci),0);
              const readyCount = items.filter(ci=>ci.status==='ready').length;
              const st = state.staffList.find(x=>x.id===c.server_id);
              return `<div class="area-chip" style="cursor:pointer;${state.ordersActiveCheckId===c.id?'border-color:#0070f2':''}${readyCount?'border-color:#16a34a':''}" onclick="selectOrdersCheck('${c.id}')">
                ${readyCount?'🔔 ':''}${esc(c.guest_label || 'Check')} · $${total.toFixed(2)}${c.split_ways>1?` · split ${c.split_ways}x`:''} <span class="panel-sub" style="margin:0">(${esc(st?.name||'?')})</span>
              </div>`;
            }).join('') : '<span class="panel-sub" style="margin:0">No open checks on this table yet.</span>'}
          </div>
        </div>
        ${activeCheck ? renderCheckDetail(activeCheck) : ''}
      `}
    </div>
  </div>`;
}
function renderCheckDetail(check){
  const items = state.checkItems.filter(ci => ci.check_id === check.id && ci.status !== 'voided');
  const isEmpty = !state.checkItems.some(ci => ci.check_id === check.id);
  // Deletable whenever nothing on it has actually gone out yet — items still sitting
  // 'open' (rung in but not sent) or 'voided' don't block it, only something fired,
  // held, ready, or delivered does. Matches the checks_delete RLS policy server-side.
  const canDeleteCheck = !state.checkItems.some(ci => ci.check_id === check.id && !['open','voided'].includes(ci.status));
  const subtotal = items.reduce((s,ci)=>s+checkItemTotal(ci), 0);
  const canOrder = can('take_orders');
  const canPay = can('take_payment');
  const hasUnfired = items.some(ci => ci.status === 'open');
  const hasHeld = items.some(ci => ci.status === 'held');
  const autoFireStatus = hasHeld ? courseAutoFireStatus(check) : null;
  const loyaltyMember = check.loyalty_member_id ? state.loyaltyMembers.find(m=>m.id===check.loyalty_member_id) : null;
  const loyaltyGuest = loyaltyMember ? state.guests.find(g=>g.id===loyaltyMember.guest_id) : null;
  const linkedGuest = check.guest_id ? state.guests.find(g=>g.id===check.guest_id) : null;
  const cocktailsLeft = loyaltyMember ? cocktailsRemaining(loyaltyMember) : 0;
  const canRedeemLoyalty = loyaltyMember && cocktailsLeft > 0 && can('apply_loyalty_payment');
  const hasLoyaltyDiscount = state.checkDiscounts.some(d=>d.check_id===check.id && d.type==='loyalty_discount');
  const discounts = state.checkDiscounts.filter(d=>d.check_id===check.id);
  const discountTotal = checkDiscountTotal(check.id, subtotal);
  const totalDue = checkTotalDue(check.id);
  const paid = checkAmountPaid(check.id);
  const balance = Math.max(0, totalDue - paid);
  const payments = state.payments.filter(p=>p.check_id===check.id);
  // Whether the check currently has anything in the "apps" or "mains" bucket (by course,
  // not menu-item default) — used below to hide the Fire-with-apps/Hold-with-mains toggles
  // when there's nothing on the other side to join, since offering them then is misleading:
  // with no apps at all, fireCheck() just sends everything together regardless of course.
  const hasApps = items.some(ci => ci.course === 1);
  const hasMains = items.some(ci => ci.course >= 2);
  return `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">${esc(check.guest_label || 'Check')}</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${canOrder ? `<button class="btn btn-sm btn-secondary" onclick="openItemPickerModal('${check.id}')">+ Add Items</button>` : ''}
        ${canOrder && hasUnfired ? `<button class="btn btn-sm btn-primary" onclick="fireCheck('${check.id}')">Send to Kitchen/Bar</button>` : ''}
        ${canOrder && hasHeld ? `<button class="btn btn-sm btn-primary" onclick="releaseHeldCourse('${check.id}')">Send Mains to Kitchen</button>` : ''}
        ${canOrder ? `<button class="btn btn-sm btn-secondary" onclick="openSplitCheckModal('${check.id}')">Split</button>` : ''}
        ${(canOrder||canPay) ? `<button class="btn btn-sm btn-secondary" onclick="openDiscretionaryDiscountModal('${check.id}')">Discount</button>` : ''}
        ${(canOrder||canPay) ? `<button class="btn btn-sm btn-secondary" onclick="openTransferCheckModal('${check.id}')">Transfer</button>` : ''}
        ${canOrder && canDeleteCheck && !isEmpty ? `<button class="btn btn-sm btn-danger" onclick="deleteEmptyCheck('${check.id}')">Delete Order</button>` : ''}
        ${canOrder && isEmpty ? `<button class="btn btn-sm btn-danger" onclick="deleteEmptyCheck('${check.id}')">Delete Check</button>` : ''}
        ${canPay && balance > 0 ? `<button class="btn btn-sm btn-primary" onclick="openPaymentModal('${check.id}')">Take Payment</button>` : ''}
      </div>
    </div>
    ${check.notes || canOrder ? `<div class="res-meta" style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:6px;padding:6px 10px;margin-bottom:8px;white-space:pre-line">
      ${check.notes ? esc(check.notes) : '<span style="color:var(--gray)">No notes for this check.</span>'}
      ${canOrder ? ` <span class="linkBtn" style="cursor:pointer" onclick="editCheckNotes('${check.id}')">${check.notes?'Edit':'+ Add note'}</span>` : ''}
    </div>` : ''}
    ${autoFireStatus && autoFireStatus.remainingMin <= 3 ? `<div class="res-meta" style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:6px 10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px">
      <span>🔥 Mains fire automatically in ${Math.ceil(autoFireStatus.remainingMin)} min${canOrder?'':' — apps are all delivered'}</span>
      ${canOrder ? `<button class="btn btn-sm btn-secondary" onclick="holdMainsLonger('${check.id}')">Hold longer</button>` : ''}
    </div>` : ''}
    <div class="panel-sub" style="margin-bottom:4px">Server: ${esc(state.staffList.find(s=>s.id===check.server_id)?.name || '?')}</div>
    <div class="panel-sub" style="margin-bottom:4px">
      ${linkedGuest ? `👤 Guest: ${esc(guestName(linkedGuest))} · <span class="linkBtn" style="cursor:pointer" onclick="openGuestHistoryWindow('${linkedGuest.id}')">📜 History</span>` : (canOrder ? `<span class="linkBtn" style="cursor:pointer" onclick="openLinkGuestModal('${check.id}')">+ Link guest</span>` : '')}
    </div>
    <div class="panel-sub" style="margin-bottom:8px">
      ${loyaltyGuest ? `💳 Linked: ${esc(loyaltyGuest.first_name)} ${esc(loyaltyGuest.last_name)} (${esc(loyaltyMember.locked_tier_name || state.loyaltyTiers.find(t=>t.key===loyaltyMember.tier_key)?.name || loyaltyMember.tier_key)}) · 🍸 ${cocktailsLeft} free drink${cocktailsLeft===1?'':'s'} left this month${(!hasLoyaltyDiscount && can('apply_loyalty_payment')) ? ` · <span class="linkBtn" style="cursor:pointer" onclick="applyLoyaltyDiscount('${check.id}')">Apply membership discount</span>` : ''}` : (canOrder ? `<span class="linkBtn" style="cursor:pointer" onclick="openLinkLoyaltyModal('${check.id}')">+ Link loyalty membership</span>` : '')}
    </div>
    <div class="table-scroll">
    <table class="data-table">
      <thead><tr><th>Qty</th><th>Seat</th><th>Item</th><th>Modifiers</th><th>Status</th><th>Price</th><th></th></tr></thead>
      <tbody>
        ${items.map(ci => {
          const miEligible = canRedeemLoyalty && state.menuItems.find(m=>m.id===ci.menu_item_id)?.loyalty_eligible;
          const removable = ci.status==='open' || ci.status==='held';
          const compable = !removable;
          const naturalCourse = state.menuItems.find(m=>m.id===ci.menu_item_id)?.course || null;
          const overridden = naturalCourse>=2 && ci.course===1; // main reclassified to fire early with apps
          const heldToMains = naturalCourse===1 && ci.course>=2; // app reclassified to hold and fire with mains instead
          let courseToggleHtml = '';
          if (naturalCourse>=2 && ci.course>=2 && removable && hasApps){
            courseToggleHtml = `<span class="linkBtn" style="cursor:pointer" onclick="fireItemWithApps('${ci.id}')">Fire with apps</span>`;
          } else if (overridden && ci.status==='open'){
            courseToggleHtml = `<span class="linkBtn" style="cursor:pointer" onclick="undoFireWithApps('${ci.id}')">Undo — hold with mains</span>`;
          } else if (overridden){
            courseToggleHtml = `<span style="color:var(--gray)">Fired with apps</span>`;
          } else if (naturalCourse===1 && ci.course===1 && ci.status==='open' && hasMains){
            courseToggleHtml = `<span class="linkBtn" style="cursor:pointer" onclick="holdItemWithMains('${ci.id}')">Hold with mains</span>`;
          } else if (heldToMains && ci.status==='open'){
            courseToggleHtml = `<span class="linkBtn" style="cursor:pointer" onclick="undoHoldWithMains('${ci.id}')">Undo — fire with apps</span>`;
          } else if (heldToMains){
            courseToggleHtml = `<span style="color:var(--gray)">Held with mains</span>`;
          }
          return `<tr>
          <td>${ci.quantity}</td>
          <td>${ci.seat_number ? `<span class="badge badge-pending">Seat ${ci.seat_number}</span>` : '<span class="panel-sub" style="margin:0">table</span>'}</td>
          <td>${esc(ci.name_snapshot)}${ci.notes?`<div class="panel-sub" style="margin:0">${esc(ci.notes)}</div>`:''}${courseToggleHtml ? `<div class="panel-sub" style="margin:0">${courseToggleHtml}</div>` : ''}</td>
          <td>${(ci.modifiers||[]).map(m=>esc(m.name)).join(', ')}</td>
          <td><span class="badge badge-${ci.status==='ready'?'confirmed':ci.status==='delivered'?'confirmed':'pending'}">${ci.status==='ready'?'🔔 ready':ci.status==='held'?'held (course 2)':esc(ci.status)}</span></td>
          <td>$${checkItemTotal(ci).toFixed(2)}</td>
          <td style="white-space:nowrap">${removable && canOrder ? `<button class="btn btn-sm btn-danger" onclick="removeCheckItem('${ci.id}')">Remove</button>` : ''}${compable && canOrder ? `<button class="btn btn-sm btn-danger" onclick="compCheckItem('${ci.id}')">Comp</button>` : ''}${miEligible ? `<button class="btn btn-sm btn-secondary" onclick="redeemLoyaltyFreeItem('${ci.id}')">🍸 Free Drink</button>` : ''}</td>
        </tr>`;
        }).join('') || `<tr><td colspan="7"><span class="panel-sub">No items yet.</span></td></tr>`}
      </tbody>
    </table>
    </div>
    ${discounts.length ? `<div class="panel-sub" style="margin-top:8px">${discounts.map(d=>`${d.type==='comp_item'?'Comp':d.type==='loyalty_discount'?'Membership discount':d.type==='loyalty_free_item'?'🍸 Free drink (membership)':'Discount'}: ${d.percent?d.percent+'%':'$'+Number(d.amount).toFixed(2)}${d.reason?' — '+esc(d.reason):''}`).join('<br>')}</div>` : ''}
    <div style="text-align:right;padding-top:8px">
      <div>Subtotal: $${subtotal.toFixed(2)}</div>
      ${discountTotal ? `<div>Discounts: -$${discountTotal.toFixed(2)}</div>` : ''}
      <div style="font-weight:600">Total due: $${totalDue.toFixed(2)}${check.split_ways>1?` · ${check.split_ways}-way split ≈ $${(totalDue/check.split_ways).toFixed(2)} each`:''}</div>
      ${paid ? `<div>Paid: $${paid.toFixed(2)} ${balance<=0.001?'<span class="badge badge-confirmed">paid in full</span>':''}</div>` : ''}
    </div>
    ${payments.length ? `<div class="panel-sub" style="margin-top:8px">${payments.map(p=>`${esc(p.method)} $${Number(p.amount).toFixed(2)}${p.tip_amount?' + $'+Number(p.tip_amount).toFixed(2)+' tip':''}${p.status!=='completed'?' ('+esc(p.status)+')':''}`).join('<br>')}</div>` : ''}
  </div>`;
}
window.toggleOrdersAreaCollapse = function(areaName){
  const i = state.ordersCollapsedAreas.indexOf(areaName);
  if (i === -1) state.ordersCollapsedAreas.push(areaName);
  else state.ordersCollapsedAreas.splice(i, 1);
  render();
};
window.setOrdersAreasCollapsed = function(areaNames){
  state.ordersCollapsedAreas = areaNames;
  render();
};
window.selectOrdersTable = function(tableId){
  state.ordersActiveTableId = tableId;
  const firstOpen = state.checks.find(c=>c.status==='open' && c.table_id===tableId);
  state.ordersActiveCheckId = firstOpen ? firstOpen.id : null;
  render();
};
window.selectOrdersCheck = function(checkId){
  state.ordersActiveCheckId = checkId;
  render();
};
window.openNewCheckModal = function(){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>New Check</h3>
    <label class="field-label">Label (optional — e.g. "Seat 1", "Smith party")</label>
    <input type="text" class="modal-input" id="ncLabel" placeholder="Check"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="createCheck()">Open Check</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
// A table counts as "linked" to a guest when today's reservation list has that
// table assigned to a reservation that's currently seated (best signal — the
// party is physically there right now) or, failing that, confirmed/pending for
// today (host forgot to tap Seat, or a walk-in got matched to a phone booking).
// Seated reservations are preferred and, among those, the most recently seated
// one wins, since a table can cycle through more than one party in a night.
//
// Queries the DB directly rather than trusting state.reservations/state.guests —
// those are only loaded once at sign-in and refreshed by specific actions on the
// Reservations tab, not by the Orders-tab polling loop. A phone that's been sitting
// on Orders all shift would otherwise never learn a host seated someone on another
// device moments ago, and silently create an unlinked check instead.
async function findGuestForTable(tableId){
  if (!tableId) return null;
  // A reservation for a combined party is seated against the COMBO table's id, not any
  // individual member table's id — so a check opened on just "M2" (one member of an
  // M2+M4+M6 combo) needs to also look up the combo's reservation, and vice versa.
  // Query table_combo_members live rather than trusting state.comboMembers (which is
  // only loaded once at app boot) — a device that's had the app open since before this
  // combo existed, or since before it had RLS permission to read it, would otherwise
  // keep working off an empty/stale snapshot forever and never resolve the group.
  const candidateIds = new Set([tableId]);
  const { data: comboRows } = await sb.from('table_combo_members').select('*')
    .or(`combo_table_id.eq.${tableId},member_table_id.eq.${tableId}`);
  (comboRows || []).forEach(row => { candidateIds.add(row.combo_table_id); candidateIds.add(row.member_table_id); });
  // Also sweep the cached map as a defensive fallback (cheap, can't hurt).
  Object.entries(state.comboMembers || {}).forEach(([comboId, memberIds]) => {
    if (comboId === tableId || (memberIds||[]).includes(tableId)){
      candidateIds.add(comboId);
      (memberIds||[]).forEach(id => candidateIds.add(id));
    }
  });
  const { data: todaysRaw } = await sb.from('reservations').select('*')
    .in('table_id', [...candidateIds]).eq('reservation_date', todayISO());
  const todays = (todaysRaw || []).filter(r => !['cancelled','no_show'].includes(r.status));
  if (!todays.length) return null;
  const seated = todays.filter(r => r.status === 'seated').sort((a,b) => (b.seated_at||'').localeCompare(a.seated_at||''));
  const r = seated[0] || todays.find(r => ['confirmed','pending'].includes(r.status));
  if (!r) return null;
  let g = guestById(r.guest_id);
  if (!g){
    const { data } = await sb.from('guests').select('*').eq('id', r.guest_id).maybeSingle();
    g = data;
    if (g) state.guests = [...state.guests, g]; // cache for the rest of this session
  }
  if (!g) return null;
  return { reservation: r, guest: g };
}
// Builds the "heads up" summary a waiter needs at a glance — kept short and
// scannable rather than a full guest-profile dump, since this lands straight
// in the check's notes the moment the ticket opens.
function buildGuestInfoNote(guest, reservation){
  const lines = [];
  const member = activeLoyaltyMember(guest.id);
  const memberTierName = member ? (member.locked_tier_name || loyaltyTierByKey(member.tier_key)?.name || member.tier_key) : null;
  lines.push(`👤 ${guestName(guest)}${guest.vip ? ' ⭐ VIP' : ''}${memberTierName ? ' · 💳 '+memberTierName+' member' : ''}`);
  if (guest.allergies) lines.push(`⚠️ Allergy/dietary: ${guest.allergies}`);
  if (reservation?.occasion) lines.push(`🎉 Occasion: ${reservation.occasion}`);
  if (reservation?.special_requests) lines.push(`📌 Special request: ${reservation.special_requests}`);
  if (guest.notes) lines.push(`📝 ${guest.notes}`);
  if ((guest.tags||[]).length) lines.push(`🏷️ ${guest.tags.join(', ')}`);
  return lines.join('\n');
}
window.createCheck = async function(){
  const label = document.getElementById('ncLabel').value.trim() || null;
  const match = await findGuestForTable(state.ordersActiveTableId);
  const payload = { table_id: state.ordersActiveTableId, server_id: currentStaff.id, guest_label: label };
  if (match){
    payload.reservation_id = match.reservation.id;
    payload.guest_id = match.guest.id;
    payload.notes = buildGuestInfoNote(match.guest, match.reservation);
    if (!label) payload.guest_label = guestName(match.guest);
  }
  const { data, error } = await sb.from('checks').insert(payload).select().single();
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  state.ordersActiveCheckId = data.id;
  await loadOrdersData();
};
window.editCheckNotes = async function(checkId){
  const check = state.checks.find(c=>c.id===checkId);
  const notes = prompt('Notes for this check (visible to staff working this table):', check?.notes || '');
  if (notes === null) return;
  const { error } = await sb.from('checks').update({ notes: notes.trim() || null }).eq('id', checkId);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
// Only reachable when nothing on the check has actually fired to the kitchen/bar yet
// (button is hidden otherwise) — RLS double-checks the same thing server-side, so this
// can't be used to quietly make a real, in-progress order disappear. Deleting the check
// row cascades to delete any of its still-unsent items too.
window.deleteEmptyCheck = async function(checkId){
  const hasItems = state.checkItems.some(ci => ci.check_id === checkId);
  if (!confirm(hasItems ? 'Delete this order and everything rung in on it? This can\'t be undone.' : 'Delete this check? This can\'t be undone.')) return;
  const { error } = await sb.from('checks').delete().eq('id', checkId);
  if (error){ alert('Error: '+error.message); return; }
  if (state.ordersActiveCheckId === checkId) state.ordersActiveCheckId = null;
  await loadOrdersData();
};
// A check can only be transferred to someone who is BOTH currently clocked in AND holds
// take_orders permission — handing a table to someone off the clock (or without ordering
// rights) would leave it effectively orphaned. eligibleApprovers('take_orders') already
// covers the permission half; isStaffClockedIn() adds the on-shift half.
window.openTransferCheckModal = function(checkId){
  const check = state.checks.find(c=>c.id===checkId);
  const candidates = eligibleApprovers('take_orders').filter(s=>s.id!==check.server_id && isStaffClockedIn(s.id));
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Transfer Check</h3>
    <p class="panel-sub">Currently: ${esc(state.staffList.find(s=>s.id===check.server_id)?.name || '?')}</p>
    <label class="field-label">Transfer to</label>
    <select class="modal-select" id="transferToStaff">
      ${candidates.map(s=>`<option value="${s.id}">${esc(s.name)} (${esc(s.role)})</option>`).join('') || '<option value="">No eligible staff — must be clocked in with order-taking permission</option>'}
    </select>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="transferCheck('${checkId}')">Transfer</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.transferCheck = async function(checkId){
  const newServerId = document.getElementById('transferToStaff').value;
  if (!newServerId){ alert('No staff selected.'); return; }
  // Re-validate on submit (not just at modal-open time) in case their clock or permission
  // status changed while the modal was sitting open.
  if (!isStaffClockedIn(newServerId)){ alert('That staff member is not currently clocked in — a check can only be transferred to someone on shift.'); return; }
  if (!staffHasPermission(newServerId, 'take_orders')){ alert('That staff member does not have order-taking permission.'); return; }
  const { error } = await sb.from('checks').update({ server_id: newServerId }).eq('id', checkId);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await loadOrdersData();
};

let _orderPickerCategory = null;
let _orderPickerSeat = null; // null = "Whole table" (no specific seat) — sticks across items added in the same picker session so a server can ring in a full seat's order without reselecting each time
window.openItemPickerModal = function(checkId){
  _orderPickerCategory = null;
  _orderPickerSeat = null;
  const box = document.getElementById('formModalBox');
  box.innerHTML = renderItemPickerBody(checkId);
  document.getElementById('formModal').classList.remove('hidden');
};
function refreshItemPickerModal(checkId){
  // Re-renders the picker body without resetting the seat/category selection —
  // used after adding an item so a server can ring in several items for the
  // same seat in a row without re-tapping the seat button each time.
  const box = document.getElementById('formModalBox');
  if (box) box.innerHTML = renderItemPickerBody(checkId);
}
function renderItemPickerBody(checkId){
  const check = state.checks.find(c=>c.id===checkId);
  const table = check ? tableById(check.table_id) : null;
  const seatCount = table?.seats || 0;
  const cats = state.menuCategories;
  const activeCat = _orderPickerCategory || (cats[0]?.id || null);
  const items = state.menuItems.filter(it => it.active && (activeCat ? it.category_id === activeCat : true));
  return `
    <h3>Add Items</h3>
    ${seatCount > 0 ? `
    <div style="margin-bottom:10px">
      <label class="field-label" style="margin-bottom:4px;display:block">Seat (so expo knows where to deliver)</label>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        <button type="button" class="btn btn-sm ${_orderPickerSeat===null?'btn-primary':'btn-secondary'}" onclick="setOrderPickerSeat('${checkId}', null)">Whole table</button>
        ${Array.from({length: seatCount}, (_, i) => i+1).map(n => `<button type="button" class="btn btn-sm ${_orderPickerSeat===n?'btn-primary':'btn-secondary'}" onclick="setOrderPickerSeat('${checkId}', ${n})">Seat ${n}</button>`).join('')}
      </div>
    </div>` : ''}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
      ${cats.map(c => `<button type="button" class="btn btn-sm ${activeCat===c.id?'btn-primary':'btn-secondary'}" onclick="setOrderPickerCategory('${checkId}','${c.id}')">${esc(c.name)}</button>`).join('') || '<span class="panel-sub">No menu categories set up yet — add them in Settings.</span>'}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;max-height:340px;overflow-y:auto">
      ${items.map(it => `<button type="button" class="btn btn-secondary" style="text-align:left;height:auto;padding:8px" onclick="pickMenuItem('${checkId}','${it.id}')">
        <div style="font-weight:600;font-size:13px">${esc(it.name)}</div>
        <div class="panel-sub" style="margin:2px 0 0">$${Number(it.price).toFixed(2)}</div>
      </button>`).join('') || '<span class="panel-sub">No items in this category.</span>'}
    </div>
    <div class="modal-actions"><button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Done</button></div>`;
}
window.setOrderPickerCategory = function(checkId, catId){
  _orderPickerCategory = catId;
  refreshItemPickerModal(checkId);
};
window.setOrderPickerSeat = function(checkId, seatNum){
  _orderPickerSeat = seatNum;
  refreshItemPickerModal(checkId);
};
// Always route through the quantity/notes modal, even for items with no modifier
// groups (e.g. a soda) — previously those skipped straight to a single qty-1 add,
// so whether you got a quantity option at all depended on an invisible detail
// (does this item happen to have modifiers configured). openItemModifierModal
// already renders fine with an empty group list — it just shows the quantity/
// notes fields with nothing above them.
window.pickMenuItem = function(checkId, itemId){
  const groupIds = state.menuItemModifierGroups.filter(x=>x.item_id===itemId).map(x=>x.group_id);
  openItemModifierModal(checkId, itemId, groupIds);
};
function openItemModifierModal(checkId, itemId, groupIds){
  const it = state.menuItems.find(x=>x.id===itemId);
  const groups = state.modifierGroups.filter(g=>groupIds.includes(g.id));
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${esc(it.name)}</h3>
    ${groups.map(g => {
      const opts = state.modifierOptions.filter(o=>o.group_id===g.id);
      const inputType = g.max_select === 1 ? 'radio' : 'checkbox';
      return `<div style="margin-bottom:10px">
        <label class="field-label">${esc(g.name)}${g.required?' *':''}</label>
        ${opts.map(o => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:2px 0">
          <input type="${inputType}" name="modgrp_${g.id}" class="miPickModOpt" data-group="${g.id}" value="${o.id}"/>
          ${esc(o.name)}${o.price_delta?` (+$${Number(o.price_delta).toFixed(2)})`:''}
        </label>`).join('')}
      </div>`;
    }).join('')}
    <div class="formgrid">
      <div><label class="field-label">Quantity</label><input type="number" min="1" class="modal-input" id="pickQty" value="1"/></div>
      <div><label class="field-label">Notes (optional)</label><input type="text" class="modal-input" id="pickNotes" placeholder="e.g. no onions"/></div>
    </div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="confirmAddItemWithModifiers('${checkId}','${itemId}')">Add to Check</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
}
window.confirmAddItemWithModifiers = function(checkId, itemId){
  const groupIds = state.menuItemModifierGroups.filter(x=>x.item_id===itemId).map(x=>x.group_id);
  const groups = state.modifierGroups.filter(g=>groupIds.includes(g.id));
  const modifiers = [];
  for (const g of groups){
    const checked = Array.from(document.querySelectorAll(`.miPickModOpt[data-group="${g.id}"]:checked`));
    if (g.required && checked.length < Math.max(1, g.min_select)){ alert(`Please choose an option for "${g.name}".`); return; }
    checked.forEach(el => {
      const opt = state.modifierOptions.find(o=>o.id===el.value);
      if (opt) modifiers.push({ name: opt.name, price_delta: opt.price_delta });
    });
  }
  const quantity = parseInt(document.getElementById('pickQty').value) || 1;
  const notes = document.getElementById('pickNotes').value.trim() || null;
  addItemToCheck(checkId, itemId, modifiers, quantity, notes);
};
async function addItemToCheck(checkId, itemId, modifiers, quantity, notes){
  const it = state.menuItems.find(x=>x.id===itemId);
  if (!it) return;
  const { error } = await sb.from('check_items').insert({
    check_id: checkId, menu_item_id: itemId, name_snapshot: it.name, price_snapshot: it.price,
    quantity, modifiers, notes, ticket_destination_id: it.ticket_destination_id, added_by: currentStaff.id,
    course: it.course || null, seat_number: _orderPickerSeat,
  });
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
  refreshItemPickerModal(checkId); // stay in the picker, keeping the same seat/category selected, so a server can add several items for the same seat in a row
}
// Course firing: if the check has any appetizer-course item on it (fired or not), mains
// (course 2+) get held back instead of firing immediately — the kitchen only sees them once
// someone taps "Send Mains to Kitchen". A check with no apps at all has nothing to sequence
// against, so everything just fires together like before.
window.fireCheck = async function(checkId){
  const openItems = state.checkItems.filter(ci => ci.check_id === checkId && ci.status === 'open');
  const hasApps = state.checkItems.some(ci => ci.check_id === checkId && ci.status !== 'voided' && ci.course === 1);
  const now = new Date().toISOString();
  if (hasApps){
    const toFireIds = openItems.filter(ci => !(ci.course >= 2)).map(ci=>ci.id);
    const toHoldIds = openItems.filter(ci => ci.course >= 2).map(ci=>ci.id);
    if (toFireIds.length){
      const { error } = await sb.from('check_items').update({ status: 'fired', fired_at: now }).in('id', toFireIds);
      if (error){ alert('Error: '+error.message); return; }
    }
    if (toHoldIds.length){
      const { error } = await sb.from('check_items').update({ status: 'held' }).in('id', toHoldIds);
      if (error){ alert('Error: '+error.message); return; }
    }
  } else {
    const { error } = await sb.from('check_items').update({ status: 'fired', fired_at: now }).eq('check_id', checkId).eq('status', 'open');
    if (error){ alert('Error: '+error.message); return; }
  }
  await loadOrdersData();
};
window.releaseHeldCourse = async function(checkId){
  const { error } = await sb.from('check_items').update({ status: 'fired', fired_at: new Date().toISOString() }).eq('check_id', checkId).eq('status', 'held');
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
// Pushes the course auto-fire deadline back by another full hold window from right now —
// for the table that's clearly still working through apps when the warning banner shows up.
window.holdMainsLonger = async function(checkId){
  const holdMin = state.kitchenSettings?.course_hold_minutes || 12;
  const until = new Date(Date.now() + holdMin*60000).toISOString();
  const { error } = await sb.from('checks').update({ course_hold_snoozed_until: until }).eq('id', checkId);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
// For the "customer wants their appetizer served as/with the main" case: reclassify a single
// item to course 1 so it goes out with the apps rather than waiting. If the apps have already
// been fired (this item is currently 'held'), fire it immediately instead of waiting on a
// separate release click.
window.fireItemWithApps = async function(checkItemId){
  const ci = state.checkItems.find(x=>x.id===checkItemId);
  if (!ci) return;
  const patch = ci.status === 'held' ? { course: 1, status: 'fired', fired_at: new Date().toISOString() } : { course: 1 };
  const { error } = await sb.from('check_items').update(patch).eq('id', checkItemId);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
// Reverts "Fire with apps" back to the item's normal course — only offered while the item is
// still 'open' (unsent). Once it's actually been fired to the kitchen there's nothing to undo.
window.undoFireWithApps = async function(checkItemId){
  const ci = state.checkItems.find(x=>x.id===checkItemId);
  if (!ci) return;
  const naturalCourse = state.menuItems.find(m=>m.id===ci.menu_item_id)?.course || null;
  const { error } = await sb.from('check_items').update({ course: naturalCourse }).eq('id', checkItemId);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
// The mirror case: customer wants an appetizer served AS a main, so it should
// come out with the mains rather than firing right away with the other apps.
// Bumping its course to 2 puts it in the same "held until mains release"
// bucket as real mains once the check is fired — see fireCheck's grouping.
// Only offered pre-fire (status still 'open'); once it's gone out there's
// nothing left to hold back.
window.holdItemWithMains = async function(checkItemId){
  const { error } = await sb.from('check_items').update({ course: 2 }).eq('id', checkItemId);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
// Reverts "Hold with mains" back to firing with the apps like a normal appetizer —
// only offered while the item is still 'open' (unsent).
window.undoHoldWithMains = async function(checkItemId){
  const { error } = await sb.from('check_items').update({ course: 1 }).eq('id', checkItemId);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
window.removeCheckItem = async function(id){
  if (!confirm('Remove this item?')) return;
  const { error } = await sb.from('check_items').delete().eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
window.voidCheckItem = async function(id){
  const reason = prompt('Reason for voiding this item (required):');
  if (!reason || !reason.trim()) return;
  const ci = state.checkItems.find(x=>x.id===id);
  const newNotes = (ci?.notes ? ci.notes + ' | ' : '') + 'VOID: ' + reason.trim();
  const { error } = await sb.from('check_items').update({ status: 'voided', notes: newNotes }).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
window.openSplitCheckModal = function(checkId){
  const check = state.checks.find(c=>c.id===checkId);
  const otherChecks = state.checks.filter(c=>c.status==='open' && c.table_id===check.table_id && c.id!==checkId);
  const items = state.checkItems.filter(ci=>ci.check_id===checkId && ci.status!=='voided');
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Split Check</h3>
    <label class="field-label">Split evenly N ways (for payment — items stay together on this check)</label>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <input type="number" min="1" class="modal-input" style="margin:0;width:80px" id="splitWays" value="${check.split_ways}"/>
      <button class="btn btn-secondary btn-sm" onclick="saveSplitWays('${checkId}')">Set</button>
    </div>
    <label class="field-label">Or move specific items to ${otherChecks.length ? 'another check' : 'a new check'}</label>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;max-height:200px;overflow-y:auto">
      ${items.map(ci => `<label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" class="splitItemChk" value="${ci.id}"/> ${ci.quantity}x ${esc(ci.name_snapshot)} — $${checkItemTotal(ci).toFixed(2)}</label>`).join('') || '<span class="panel-sub" style="margin:0">No items to move.</span>'}
    </div>
    <label class="field-label">Move to</label>
    <select class="modal-select" id="splitDestCheck">
      <option value="__new">+ New check</option>
      ${otherChecks.map(c=>`<option value="${c.id}">${esc(c.guest_label||'Check')}</option>`).join('')}
    </select>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button>
      <button class="modal-btn modal-btn-primary" onclick="moveSplitItems('${checkId}')">Move Selected</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.saveSplitWays = async function(checkId){
  const ways = parseInt(document.getElementById('splitWays').value) || 1;
  const { error } = await sb.from('checks').update({ split_ways: ways }).eq('id', checkId);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await loadOrdersData();
};
window.moveSplitItems = async function(checkId){
  const ids = Array.from(document.querySelectorAll('.splitItemChk:checked')).map(el=>el.value);
  if (!ids.length){ alert('Select at least one item to move.'); return; }
  let destId = document.getElementById('splitDestCheck').value;
  if (destId === '__new'){
    const check = state.checks.find(c=>c.id===checkId);
    const { data, error } = await sb.from('checks').insert({ table_id: check.table_id, server_id: currentStaff.id, guest_label: 'Split Check' }).select().single();
    if (error){ alert('Error: '+error.message); return; }
    destId = data.id;
  }
  const { error: moveErr } = await sb.from('check_items').update({ check_id: destId }).in('id', ids);
  if (moveErr){ alert('Error: '+moveErr.message); return; }
  closeModal('formModal');
  state.ordersActiveCheckId = destId;
  await loadOrdersData();
};
window.openLinkLoyaltyModal = function(checkId){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Link Loyalty Membership</h3>
    <label class="field-label">Search guest</label>
    <input type="text" class="modal-input" id="linkLoyaltySearch" oninput="renderLinkLoyaltyResults('${checkId}', this.value)" placeholder="Name or phone…"/>
    <div id="linkLoyaltyResults" style="max-height:220px;overflow-y:auto;margin-top:8px"></div>
    <div class="modal-actions"><button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button></div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.renderLinkLoyaltyResults = function(checkId, q){
  const div = document.getElementById('linkLoyaltyResults');
  const query = q.trim().toLowerCase();
  if (!query){ div.innerHTML = ''; return; }
  const activeMemberGuestIds = new Set(state.loyaltyMembers.filter(m=>m.status==='active').map(m=>m.guest_id));
  const matches = state.guests.filter(g => activeMemberGuestIds.has(g.id) && (`${g.first_name} ${g.last_name}`.toLowerCase().includes(query) || (g.phone||'').includes(query))).slice(0,10);
  div.innerHTML = matches.map(g => {
    const m = state.loyaltyMembers.find(x=>x.guest_id===g.id);
    return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;cursor:pointer" onclick="linkLoyaltyToCheck('${checkId}','${m.id}')">
      <span>${esc(g.first_name)} ${esc(g.last_name)} — ${esc(m.locked_tier_name || m.tier_key)}</span>
    </div>`;
  }).join('') || '<span class="panel-sub" style="margin:0">No active members match.</span>';
};
window.linkLoyaltyToCheck = async function(checkId, memberId){
  const member = state.loyaltyMembers.find(m=>m.id===memberId);
  const patch = { loyalty_member_id: memberId };
  // Linking a membership always resolves to a specific guest — tie the check to their
  // permanent record too so this visit shows up in their history, same as linkGuestToCheck.
  if (member) patch.guest_id = member.guest_id;
  const { error } = await sb.from('checks').update(patch).eq('id', checkId);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await loadOrdersData();
};
// Manual version of the same idea for guests with no loyalty membership and no
// reservation match (e.g. a walk-in the host didn't tie to a booking) — lets staff
// attach the check to an existing guest profile after the fact so it counts toward
// that guest's permanent visit history.
window.openLinkGuestModal = function(checkId){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Link Guest</h3>
    <p class="panel-sub" style="margin-top:-4px">Ties this check to a guest's permanent profile so it shows up in their visit history.</p>
    <label class="field-label">Search guest</label>
    <input type="text" class="modal-input" id="linkGuestSearch" oninput="renderLinkGuestResults('${checkId}', this.value)" placeholder="Name or phone…"/>
    <div id="linkGuestResults" style="max-height:220px;overflow-y:auto;margin-top:8px"></div>
    <div class="modal-actions"><button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button></div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.renderLinkGuestResults = function(checkId, q){
  const div = document.getElementById('linkGuestResults');
  const query = q.trim().toLowerCase();
  if (!query){ div.innerHTML = ''; return; }
  const matches = state.guests.filter(g => guestName(g).toLowerCase().includes(query) || (g.phone||'').includes(query)).slice(0,10);
  div.innerHTML = matches.map(g => `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;cursor:pointer" onclick="linkGuestToCheck('${checkId}','${g.id}')">
      <span>${esc(guestName(g))}${g.phone?' — '+esc(g.phone):''}</span>
    </div>`).join('') || '<span class="panel-sub" style="margin:0">No guests match.</span>';
};
window.linkGuestToCheck = async function(checkId, guestId){
  const check = state.checks.find(c=>c.id===checkId);
  const guest = state.guests.find(g=>g.id===guestId);
  const patch = { guest_id: guestId };
  // Only auto-fill the notes banner if the check doesn't already have notes of its own —
  // never silently overwrite something a waiter already typed.
  if (guest && !check?.notes) patch.notes = buildGuestInfoNote(guest, null);
  const { error } = await sb.from('checks').update(patch).eq('id', checkId);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await loadOrdersData();
};

// ---- Guest visit history (opens in its own browser window/tab) ------------
// Every check tied to a guest (guest_id, set automatically off a reservation match or
// manually via "+ Link guest") counts toward their permanent history here — past items
// ordered, per-visit notes, and totals — regardless of how long ago the check closed.
window.openGuestHistoryWindow = function(guestId){
  window.open('index.html?guestHistory='+encodeURIComponent(guestId), '_blank', 'width=560,height=780,noopener');
};
async function renderGuestHistoryView(guestId){
  const c = document.getElementById('content');
  c.innerHTML = '<div class="panel-sub">Loading history…</div>';
  const [{ data: guest }, { data: checks }] = await Promise.all([
    sb.from('guests').select('*').eq('id', guestId).maybeSingle(),
    sb.from('checks').select('*').eq('guest_id', guestId).order('opened_at', { ascending: false }),
  ]);
  if (!guest){ c.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div>Guest not found.</div>'; return; }
  const checkIds = (checks||[]).map(ch=>ch.id);
  const [itemsRes, discountsRes] = checkIds.length ? await Promise.all([
    sb.from('check_items').select('*').in('check_id', checkIds),
    sb.from('check_discounts').select('*').in('check_id', checkIds),
  ]) : [{ data: [] }, { data: [] }];
  const items = itemsRes.data || [];
  const discounts = discountsRes.data || [];

  // "Today's visit" = whatever open check this guest has today, if any — that's the one the
  // quick-note box below writes to, so a waiter can jot something down mid-service without
  // digging back to the Orders tab.
  const todaysOpenCheck = (checks||[]).find(ch => ch.status === 'open' && ch.opened_at?.slice(0,10) === todayISO());

  const rows = (checks||[]).map(ch => {
    const chItems = items.filter(i => i.check_id === ch.id && i.status !== 'voided');
    const subtotal = chItems.reduce((s,ci)=>s+checkItemTotal(ci), 0);
    const chDiscounts = discounts.filter(d=>d.check_id===ch.id && d.type!=='comp_item');
    const discountTotal = chDiscounts.reduce((s,d)=>s+(d.percent ? subtotal*(d.percent/100) : (Number(d.amount)||0)), 0);
    const total = Math.max(0, subtotal - discountTotal);
    const table = tableById(ch.table_id);
    const server = state.staffList.find(s=>s.id===ch.server_id);
    const statusBadge = ch.status==='closed' ? 'confirmed' : ch.status==='open' ? 'pending' : 'cancelled';
    return `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <div>
          <strong>${new Date(ch.opened_at).toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'})}</strong>
          <span class="panel-sub" style="margin:0">${new Date(ch.opened_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}${table?' · '+esc(tableDisplayLabel(table)):''}${server?' · server '+esc(server.name):''}</span>
        </div>
        <span class="badge badge-${statusBadge}">${esc(ch.status)}</span>
      </div>
      ${chItems.length ? `<table class="data-table" style="margin-top:8px"><tbody>${chItems.map(ci=>`<tr><td style="width:30px">${ci.quantity}</td><td>${esc(ci.name_snapshot)}${(ci.modifiers||[]).length?`<div class="panel-sub" style="margin:0">${ci.modifiers.map(m=>esc(m.name)).join(', ')}</div>`:''}</td><td style="text-align:right;width:70px">$${checkItemTotal(ci).toFixed(2)}</td></tr>`).join('')}</tbody></table>` : '<div class="panel-sub" style="margin-top:6px">No items on this visit.</div>'}
      <div style="text-align:right;font-weight:600;margin-top:6px">Total: $${total.toFixed(2)}</div>
      ${ch.notes ? `<div class="res-meta" style="background:#f4f4f5;border-radius:6px;padding:6px 10px;margin-top:8px;white-space:pre-line">📝 ${esc(ch.notes)}</div>` : ''}
    </div>`;
  }).join('') || '<div class="empty-state"><div class="empty-state-icon">📭</div>No visits on record yet.</div>';

  c.innerHTML = `
  <div class="panel-header"><div>
    <h2 class="panel-title">${esc(guestName(guest))} — Visit History</h2>
    <div class="panel-sub">${guest.vip?'⭐ VIP · ':''}${(checks||[]).length} visit${(checks||[]).length===1?'':'s'} on record${guest.phone?' · '+esc(guest.phone):''}</div>
  </div>
  <button class="btn btn-secondary btn-sm" onclick="window.close()">✕ Close</button>
  </div>
  ${guest.allergies ? `<div class="panel-sub">⚠️ Allergy/dietary: ${esc(guest.allergies)}</div>` : ''}
  ${guest.notes ? `<div class="panel-sub" style="margin-bottom:10px">📝 Standing note: ${esc(guest.notes)}</div>` : ''}
  ${todaysOpenCheck ? `
  <div class="card" style="margin-bottom:14px;background:#eef2ff">
    <div class="panel-sub" style="margin-bottom:6px">Note for today's visit:</div>
    <textarea class="modal-textarea" id="historyNewNote" placeholder="e.g. celebrating an anniversary, asked for extra napkins…">${esc(todaysOpenCheck.notes||'')}</textarea>
    <div class="modal-actions" style="padding-top:8px;justify-content:flex-start"><button class="btn btn-primary btn-sm" onclick="saveHistoryNote('${todaysOpenCheck.id}')">Save Note</button></div>
  </div>` : ''}
  ${rows}`;
}
window.saveHistoryNote = async function(checkId){
  const val = document.getElementById('historyNewNote')?.value || '';
  const { error } = await sb.from('checks').update({ notes: val.trim() || null }).eq('id', checkId);
  if (error){ alert('Error: '+error.message); return; }
  alert('Note saved.');
};

// ============================================================================
// PAYMENTS, TIPS, COMPS, DISCOUNTS, REFUNDS (Phase 8)
// Comps/discretionary discounts/refunds all go through server-side RPCs that
// self-authorize if the caller already holds the permission, or otherwise
// require a manager's staff id + PIN (verified in Postgres, never client-side —
// see apply_check_discount()/process_refund() in the DB). Payments are a fake
// Square "sandbox" charge: no real card is ever contacted.
// ============================================================================
window.compCheckItem = function(checkItemId){
  const ci = state.checkItems.find(x=>x.id===checkItemId);
  if (!ci) return;
  const reason = prompt('Reason for comping this item:');
  if (!reason || !reason.trim()) return;
  withApproval('apply_comp', 'Comping an item', async (approverId, pin) => {
    const { error } = await sb.rpc('apply_check_discount', {
      p_check_id: ci.check_id, p_check_item_id: ci.id, p_type: 'comp_item',
      p_amount: checkItemTotal(ci), p_percent: null, p_reason: reason.trim(), p_approver_id: approverId, p_pin: pin,
    });
    if (error){ alert('Error: '+error.message); return; }
    closeModal('formModal');
    await loadOrdersData();
  });
};
window.redeemLoyaltyFreeItem = async function(checkItemId){
  const ci = state.checkItems.find(x=>x.id===checkItemId);
  if (!ci) return;
  const check = state.checks.find(c=>c.id===ci.check_id);
  const member = check?.loyalty_member_id ? state.loyaltyMembers.find(m=>m.id===check.loyalty_member_id) : null;
  if (!member){ alert('No membership linked to this check.'); return; }
  const remaining = cocktailsRemaining(member);
  if (remaining <= 0){ alert('This member has no free drinks remaining this month.'); return; }
  if (!confirm(`Redeem 1 free drink for "${ci.name_snapshot}"? (${remaining} of ${lockedCocktailsPerMonth(member)} left this month)`)) return;
  const { error } = await sb.rpc('redeem_loyalty_free_item', {
    p_check_id: ci.check_id, p_check_item_id: ci.id, p_loyalty_member_id: member.id, p_amount: checkItemTotal(ci),
  });
  if (error){ alert('Error: '+error.message); return; }
  await reloadLoyaltyMembers();
  await loadOrdersData();
};
window.openDiscretionaryDiscountModal = function(checkId){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Apply Discount</h3>
    <div class="formgrid">
      <div><label class="field-label">Percent off (%)</label><input type="number" min="0" max="100" class="modal-input" id="ddPercent" placeholder="e.g. 10"/></div>
      <div><label class="field-label">Or flat $ off</label><input type="number" min="0" step="0.01" class="modal-input" id="ddAmount" placeholder="e.g. 5.00"/></div>
    </div>
    <label class="field-label">Reason</label>
    <input type="text" class="modal-input" id="ddReason" placeholder="e.g. service recovery"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="submitDiscretionaryDiscount('${checkId}')">Apply</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.submitDiscretionaryDiscount = function(checkId){
  const percent = parseFloat(document.getElementById('ddPercent').value) || null;
  const amount = parseFloat(document.getElementById('ddAmount').value) || null;
  const reason = document.getElementById('ddReason').value.trim();
  if (!percent && !amount){ alert('Enter a percent or a flat amount.'); return; }
  if (!reason){ alert('A reason is required.'); return; }
  withApproval('apply_discretionary_discount', 'Applying a discount', async (approverId, pin) => {
    const { error } = await sb.rpc('apply_check_discount', {
      p_check_id: checkId, p_check_item_id: null, p_type: 'discretionary_discount',
      p_amount: amount, p_percent: percent, p_reason: reason, p_approver_id: approverId, p_pin: pin,
    });
    if (error){ alert('Error: '+error.message); return; }
    closeModal('formModal');
    await loadOrdersData();
  });
};
window.applyLoyaltyDiscount = async function(checkId){
  const check = state.checks.find(c=>c.id===checkId);
  const member = state.loyaltyMembers.find(m=>m.id===check?.loyalty_member_id);
  if (!member) return;
  const pct = member.locked_discount_pct ?? state.loyaltyTiers.find(t=>t.key===member.tier_key)?.discount_pct ?? 0;
  if (!pct){ alert('This membership tier has no automatic discount.'); return; }
  const { error } = await sb.from('check_discounts').insert({ check_id: checkId, type: 'loyalty_discount', percent: pct, reason: 'Membership discount', applied_by: currentStaff.id });
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
window.openPaymentModal = function(checkId){
  const subtotal = state.checkItems.filter(ci=>ci.check_id===checkId && ci.status!=='voided').reduce((s,ci)=>s+checkItemTotal(ci),0);
  const discountTotal = checkDiscountTotal(checkId, subtotal);
  const totalDue = checkTotalDue(checkId);
  const paid = checkAmountPaid(checkId);
  const balance = Math.max(0, totalDue - paid);
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Take Payment</h3>
    <div class="panel-sub" style="margin-bottom:10px">Subtotal $${subtotal.toFixed(2)}${discountTotal?` · Discounts -$${discountTotal.toFixed(2)}`:''} · Total due $${totalDue.toFixed(2)}${paid?` · Already paid $${paid.toFixed(2)}`:''}</div>
    <div class="formgrid">
      <div><label class="field-label">Amount ($)</label><input type="number" min="0.01" step="0.01" class="modal-input" id="payAmount" value="${balance.toFixed(2)}"/></div>
      <div><label class="field-label">Tip ($)</label><input type="number" min="0" step="0.01" class="modal-input" id="payTip" value="0"/></div>
    </div>
    <label class="field-label">Method</label>
    <select class="modal-select" id="payMethod" onchange="togglePayMethodFields()">
      <option value="card_sandbox">Card (Square sandbox)</option>
      <option value="cash">Cash</option>
      <option value="gift_card">Gift Card</option>
    </select>
    <div id="payMethodFields" class="panel-sub" style="margin-top:6px"></div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" id="payChargeBtn" onclick="processPayment('${checkId}')">Charge</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
  togglePayMethodFields();
};
window.togglePayMethodFields = function(){
  const method = document.getElementById('payMethod').value;
  const div = document.getElementById('payMethodFields');
  if (method === 'gift_card'){
    div.innerHTML = `<label class="field-label" style="margin:0 0 4px">Gift card code</label><input type="text" class="modal-input" id="payGiftCode" placeholder="GC-XXXXXXXX" style="margin:0;text-transform:uppercase"/>`;
  } else if (method === 'card_sandbox'){
    div.innerHTML = 'A fake sandbox charge will be simulated — no real card is ever contacted.';
  } else {
    div.innerHTML = '';
  }
};
window.processPayment = async function(checkId){
  const amount = parseFloat(document.getElementById('payAmount').value) || 0;
  const tip_amount = parseFloat(document.getElementById('payTip').value) || 0;
  const method = document.getElementById('payMethod').value;
  if (amount <= 0){ alert('Enter a valid amount.'); return; }
  const btn = document.getElementById('payChargeBtn');
  if (btn){ btn.disabled = true; btn.textContent = 'Processing…'; }
  let sandbox_txn_id = null, card_last4 = null;
  if (method === 'card_sandbox'){
    sandbox_txn_id = 'SANDBOX-' + Date.now().toString(36).toUpperCase();
    card_last4 = String(1000 + Math.floor(Math.random()*9000));
    await new Promise(r => setTimeout(r, 600)); // simulated processing delay
  } else if (method === 'gift_card'){
    const code = (document.getElementById('payGiftCode')?.value || '').trim();
    if (!code){ alert('Enter the gift card code.'); if (btn){ btn.disabled = false; btn.textContent = 'Charge'; } return; }
    const { error: giftErr } = await sb.rpc('redeem_gift_card', { p_code: code, p_amount: amount, p_check_id: checkId });
    if (giftErr){ alert('Error: '+giftErr.message); if (btn){ btn.disabled = false; btn.textContent = 'Charge'; } return; }
  }
  const { error } = await sb.from('payments').insert({
    check_id: checkId, amount, tip_amount, method, sandbox_txn_id, card_last4, processed_by: currentStaff.id,
  });
  if (error){ alert('Error: '+error.message); if (btn){ btn.disabled = false; btn.textContent = 'Charge'; } return; }
  await maybeCloseCheck(checkId);
  closeModal('formModal');
  await loadOrdersData();
};

// ============================================================================
// GIFT CARDS (Phase 11) — selling issues a new random code; redemption is
// handled atomically server-side (redeem_gift_card()) so balance can never go
// negative even with two people using the same card at once.
// ============================================================================
window.openGiftCardsModal = function(){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Gift Cards</h3>
    ${can('sell_gift_card') ? `
    <div class="section-heading" style="margin-top:0">Sell New</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <input type="number" min="1" step="1" class="modal-input" style="margin:0;width:120px" id="gcAmount" placeholder="$ amount"/>
      <button class="btn btn-primary btn-sm" onclick="sellGiftCard()">Sell</button>
    </div>` : ''}
    <div class="section-heading">Look Up${can('sell_gift_card')?' / Reload':''}</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <input type="text" class="modal-input" style="margin:0;text-transform:uppercase" id="gcLookupCode" placeholder="Card code"/>
      <button class="btn btn-secondary btn-sm" onclick="lookupGiftCard()">Look Up</button>
    </div>
    <div id="gcLookupResult"></div>
    <div class="modal-actions"><button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button></div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.sellGiftCard = async function(){
  const amount = parseFloat(document.getElementById('gcAmount').value) || 0;
  if (amount <= 0){ alert('Enter a valid amount.'); return; }
  const code = 'GC-' + Math.random().toString(36).slice(2,10).toUpperCase();
  const { data, error } = await sb.from('gift_cards').insert({ code, initial_value: amount, balance: amount, sold_by: currentStaff.id }).select().single();
  if (error){ alert('Error: '+error.message); return; }
  await sb.from('gift_card_transactions').insert({ gift_card_id: data.id, type: 'sale', amount, staff_id: currentStaff.id });
  alert(`Gift card sold! Code: ${code}\n\nWrite this on the card or give it to the guest — it's needed to redeem.`);
  document.getElementById('gcAmount').value = '';
};
window.lookupGiftCard = async function(){
  const code = document.getElementById('gcLookupCode').value.trim();
  if (!code) return;
  const { data: card, error } = await sb.from('gift_cards').select('*').ilike('code', code).maybeSingle();
  const div = document.getElementById('gcLookupResult');
  if (error || !card){ div.innerHTML = '<span class="panel-sub">Not found.</span>'; return; }
  div.innerHTML = `
    <div class="panel-sub" style="margin:8px 0">Balance: $${Number(card.balance).toFixed(2)} of $${Number(card.initial_value).toFixed(2)} · <span class="badge badge-${card.status==='active'?'confirmed':'cancelled'}">${esc(card.status)}</span></div>
    ${(can('sell_gift_card') && card.status!=='cancelled') ? `<div style="display:flex;gap:8px;align-items:center">
      <input type="number" min="1" step="1" class="modal-input" style="margin:0;width:120px" id="gcReloadAmount" placeholder="$ to add"/>
      <button class="btn btn-secondary btn-sm" onclick="reloadGiftCard('${card.id}')">Add Funds</button>
    </div>` : ''}`;
};
window.reloadGiftCard = async function(id){
  const amount = parseFloat(document.getElementById('gcReloadAmount').value) || 0;
  if (amount <= 0){ alert('Enter a valid amount.'); return; }
  const { data: card } = await sb.from('gift_cards').select('*').eq('id', id).single();
  if (!card) return;
  const { error } = await sb.from('gift_cards').update({ balance: Number(card.balance) + amount, status: 'active' }).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await sb.from('gift_card_transactions').insert({ gift_card_id: id, type: 'reload', amount, staff_id: currentStaff.id });
  alert('Funds added.');
  document.getElementById('gcLookupResult').innerHTML = '';
  document.getElementById('gcLookupCode').value = '';
};
async function maybeCloseCheck(checkId){
  const totalDue = checkTotalDue(checkId);
  const { data: freshPayments } = await sb.from('payments').select('amount,refunded_amount').eq('check_id', checkId);
  const paid = (freshPayments||[]).reduce((s,p)=>s+Number(p.amount)-Number(p.refunded_amount||0),0);
  if (paid >= totalDue - 0.005){
    await sb.from('checks').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', checkId);
  }
}
window.openRecentPaymentsModal = async function(){
  const { data: pays } = await sb.from('payments').select('*').order('created_at',{ascending:false}).limit(30);
  const checkIds = [...new Set((pays||[]).map(p=>p.check_id))];
  const { data: chks } = checkIds.length ? await sb.from('checks').select('id,table_id,guest_label').in('id', checkIds) : { data: [] };
  const checksById = {}; (chks||[]).forEach(c=>checksById[c.id]=c);
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Recent Payments</h3>
    <div style="max-height:400px;overflow-y:auto">
      ${(pays||[]).map(p => {
        const chk = checksById[p.check_id];
        const table = chk ? tableById(chk.table_id) : null;
        const refundable = p.status !== 'refunded' && (p.amount - p.refunded_amount) > 0;
        return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:5px 0">
          <span>${esc(table?.label||'')}${chk?.guest_label?' · '+esc(chk.guest_label):''} — $${Number(p.amount).toFixed(2)} ${esc(p.method)} ${p.status!=='completed'?`<span class="badge badge-pending">${esc(p.status)}</span>`:''}<div class="panel-sub" style="margin:0">${new Date(p.created_at).toLocaleString()}</div></span>
          ${refundable ? `<button class="btn btn-sm btn-danger" onclick="openRefundModal('${p.id}', ${Number(p.amount) - Number(p.refunded_amount)})">Refund</button>` : ''}
        </div>`;
      }).join('') || '<div class="panel-sub">No payments yet.</div>'}
    </div>
    <div class="modal-actions"><button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button></div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.openRefundModal = function(paymentId, maxAmount){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Refund Payment</h3>
    <label class="field-label">Amount to refund (max $${maxAmount.toFixed(2)})</label>
    <input type="number" min="0.01" max="${maxAmount}" step="0.01" class="modal-input" id="refundAmount" value="${maxAmount.toFixed(2)}"/>
    <label class="field-label">Reason</label>
    <input type="text" class="modal-input" id="refundReason" placeholder="e.g. guest complaint"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="submitRefund('${paymentId}')">Refund</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.submitRefund = function(paymentId){
  const amount = parseFloat(document.getElementById('refundAmount').value) || 0;
  const reason = document.getElementById('refundReason').value.trim();
  if (amount <= 0){ alert('Enter a valid amount.'); return; }
  if (!reason){ alert('A reason is required.'); return; }
  withApproval('process_refund', 'Processing a refund', async (approverId, pin) => {
    const { error } = await sb.rpc('process_refund', { p_payment_id: paymentId, p_amount: amount, p_reason: reason, p_approver_id: approverId, p_pin: pin });
    if (error){ alert('Error: '+error.message); return; }
    closeModal('formModal');
    alert('Refund processed.');
  });
};

// ============================================================================
// KITCHEN / BAR DISPLAY (Phase 6) — one column per ticket destination, live
// tickets grouped by check, oldest first. Polls every 15s while this tab (or
// Orders, which shares the same data) is on screen so new fired tickets show
// up without a manual refresh.
// ============================================================================
let _kdsPollInterval = null;
function startKdsPolling(){
  stopKdsPolling();
  _kdsPollInterval = setInterval(() => {
    // Also poll while on the Floor Plan / Split View tabs — that's what keeps the
    // "paid up, ready to turn" indicator on table tiles from going stale while a
    // host is sitting on the floor plan rather than the Orders screen.
    if (['kitchen','orders','expo','floorplan','split'].includes(state.tab)) loadOrdersData();
  }, 15000);
}
function stopKdsPolling(){ if (_kdsPollInterval){ clearInterval(_kdsPollInterval); _kdsPollInterval = null; } }

// ============================================================================
// MESSAGES — same polling approach as the KDS above. Postgres Realtime isn't
// wired up in this project (no tables in the realtime publication), so instead
// of a persistent socket subscription, poll for new threads/messages every 8s
// while the Schedule tab (where Messages lives) is on screen. Deliberately a
// lighter query than loadScheduleData() — just the three messaging tables —
// so it doesn't re-pull shifts/timecards/groups on every tick.
// ============================================================================
let _msgPollInterval = null;
async function reloadMessagingData(){
  const [threadsRes, participantsRes, messagesRes] = await Promise.all([
    sb.from('message_threads').select('*').order('created_at', { ascending: false }),
    sb.from('thread_participants').select('*'),
    sb.from('messages').select('*').order('created_at', { ascending: false }).limit(300),
  ]);
  state.messageThreads = threadsRes.data || [];
  state.threadParticipants = participantsRes.data || [];
  state.messages = messagesRes.data || [];
}
function startMessagePolling(){
  stopMessagePolling();
  _msgPollInterval = setInterval(async () => {
    if (state.tab !== 'schedule') return;
    await reloadMessagingData();
    render();
  }, 8000);
}
function stopMessagePolling(){ if (_msgPollInterval){ clearInterval(_msgPollInterval); _msgPollInterval = null; } }

// ============================================================================
// COURSE AUTO-FIRE SAFETY NET — runs in the background regardless of which tab
// is open (a forgotten "Send Mains to Kitchen" click is exactly the kind of
// thing that happens on a busy floor, not just when someone's staring at the
// screen). Once every course-1 (appetizer) item on a check has been delivered,
// a countdown starts; if nobody has released the held course-2+ items by the
// time it expires, they fire automatically. A check-level snooze
// (course_hold_snoozed_until) lets staff explicitly push the deadline back
// instead of just getting overridden.
// ============================================================================
let _courseAutoFireInterval = null;
function startCourseAutoFirePolling(){
  stopCourseAutoFirePolling();
  _courseAutoFireInterval = setInterval(checkCourseAutoFire, 30000);
}
function stopCourseAutoFirePolling(){ if (_courseAutoFireInterval){ clearInterval(_courseAutoFireInterval); _courseAutoFireInterval = null; } }
async function checkCourseAutoFire(){
  const holdMin = state.kitchenSettings?.course_hold_minutes || 12;
  const { data: held } = await sb.from('check_items').select('id,check_id').eq('status','held');
  if (!held || !held.length) return;
  const checkIds = [...new Set(held.map(h=>h.check_id))];
  const [{ data: appItems }, { data: checksRows }] = await Promise.all([
    sb.from('check_items').select('check_id,status,delivered_at').in('check_id', checkIds).eq('course', 1).neq('status','voided'),
    sb.from('checks').select('id,course_hold_snoozed_until').in('id', checkIds),
  ]);
  const now = getNow();
  const readyCheckIds = checkIds.filter(cid => {
    const snoozedUntil = checksRows?.find(c=>c.id===cid)?.course_hold_snoozed_until;
    if (snoozedUntil && new Date(snoozedUntil).getTime() > now.getTime()) return false;
    const apps = (appItems||[]).filter(a=>a.check_id===cid);
    if (!apps.length || !apps.every(a=>a.status==='delivered')) return false;
    const latest = apps.map(a=>a.delivered_at).filter(Boolean).sort().slice(-1)[0];
    if (!latest) return false;
    return (now.getTime() - new Date(latest).getTime())/60000 >= holdMin;
  });
  if (!readyCheckIds.length) return;
  const heldIdsToFire = held.filter(h=>readyCheckIds.includes(h.check_id)).map(h=>h.id);
  await sb.from('check_items').update({ status:'fired', fired_at: new Date().toISOString() }).in('id', heldIdsToFire);
  if (['orders','kitchen','expo'].includes(state.tab)) await loadOrdersData();
}
// Latest-delivered appetizer time + remaining minutes for a check's held mains, or null if
// there's nothing to time (no held items, apps not all delivered yet, or actively snoozed).
// Shared by the warning banner on the check detail view.
function courseAutoFireStatus(check){
  const holdMin = state.kitchenSettings?.course_hold_minutes || 12;
  if (check.course_hold_snoozed_until && new Date(check.course_hold_snoozed_until).getTime() > getNow().getTime()) return null;
  const items = state.checkItems.filter(ci => ci.check_id === check.id);
  if (!items.some(ci => ci.status === 'held')) return null;
  const apps = items.filter(ci => ci.course === 1 && ci.status !== 'voided');
  if (!apps.length || !apps.every(ci => ci.status === 'delivered')) return null;
  const latest = apps.map(ci=>ci.delivered_at).filter(Boolean).sort().slice(-1)[0];
  if (!latest) return null;
  const elapsedMin = (getNow().getTime() - new Date(latest).getTime())/60000;
  return { remainingMin: Math.max(0, holdMin - elapsedMin) };
}
function ticketElapsedMinutes(firedAt){
  if (!firedAt) return 0;
  return Math.max(0, Math.floor((getNow().getTime() - new Date(firedAt).getTime()) / 60000));
}
// Which ticket-destination columns this device shows on the Kitchen/Bar board — a display
// preference for the physical screen sitting in that station, not a business setting, so it's
// kept in localStorage per-device rather than the database. Kitchen doesn't want Main Bar/Secret
// Bar tickets cluttering their screen and vice versa, but nothing stops any station from checking
// every box to see the whole house if they want to.
const KDS_HIDDEN_DESTINATIONS_KEY = 'legend_kds_hidden_destinations';
function kdsHiddenDestinations(){
  try { return new Set(JSON.parse(localStorage.getItem(KDS_HIDDEN_DESTINATIONS_KEY) || '[]')); } catch(e){ return new Set(); }
}
window.toggleKdsDestination = function(destId, visible){
  const hidden = kdsHiddenDestinations();
  if (visible) hidden.delete(destId); else hidden.add(destId);
  localStorage.setItem(KDS_HIDDEN_DESTINATIONS_KEY, JSON.stringify([...hidden]));
  render();
};
window.saveCourseHoldMinutes = async function(){
  const val = parseInt(document.getElementById('courseHoldMinutes').value);
  if (!val || val < 1){ alert('Enter a number of minutes.'); return; }
  const { error } = await sb.from('kitchen_settings').update({ course_hold_minutes: val, updated_at: new Date().toISOString() }).eq('id', true);
  if (error){ alert('Error: '+error.message); return; }
  state.kitchenSettings.course_hold_minutes = val;
  render();
};
function renderKitchenTab(){
  const allDestinations = state.ticketDestinations.filter(td=>td.active);
  const hidden = kdsHiddenDestinations();
  const destinations = allDestinations.filter(td => !hidden.has(td.id));
  const relevantItems = state.checkItems.filter(ci => ['fired','preparing','ready'].includes(ci.status));
  return `
  <div class="panel-header"><h2 class="panel-title">Kitchen &amp; Bar Tickets</h2></div>
  <div class="card" style="margin-bottom:12px">
    <div class="panel-sub" style="margin-bottom:6px">Show stations on this screen:</div>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      ${allDestinations.map(td => `<label style="display:flex;align-items:center;gap:6px;font-size:13px">
        <input type="checkbox" ${hidden.has(td.id)?'':'checked'} onchange="toggleKdsDestination('${td.id}', this.checked)"/> ${esc(td.name)}
      </label>`).join('') || '<span class="panel-sub" style="margin:0">No ticket destinations set up yet.</span>'}
    </div>
    ${can('manage_menu') ? `
    <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
      <label class="field-label" style="margin:0">Auto-fire held mains after apps are delivered:</label>
      <input type="number" min="1" step="1" class="modal-input" style="margin:0;width:70px" id="courseHoldMinutes" value="${state.kitchenSettings.course_hold_minutes}"/>
      <span class="panel-sub" style="margin:0">min</span>
      <button class="btn btn-secondary btn-sm" onclick="saveCourseHoldMinutes()">Save</button>
    </div>` : ''}
  </div>
  <div style="display:flex;gap:14px;overflow-x:auto;padding-bottom:8px">
    ${destinations.map(td => {
      const items = relevantItems.filter(ci => ci.ticket_destination_id === td.id);
      const checkIds = [...new Set(items.map(ci=>ci.check_id))];
      const tickets = checkIds.map(cid => {
        const check = state.checks.find(c=>c.id===cid);
        const tItems = items.filter(ci=>ci.check_id===cid).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
        const firedAt = tItems.map(ci=>ci.fired_at).filter(Boolean).sort()[0];
        return { check, items: tItems, firedAt };
      }).filter(t => t.check).sort((a,b) => new Date(a.firedAt||0) - new Date(b.firedAt||0));
      return `
      <div style="flex:0 0 300px">
        <div class="section-heading" style="margin-top:0">${esc(td.name)} <span class="panel-sub" style="margin:0">(${tickets.length})</span></div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${tickets.map(t => renderKitchenTicket(t)).join('') || '<div class="card"><div class="panel-sub" style="margin:0">No active tickets.</div></div>'}
        </div>
      </div>`;
    }).join('') || `<div class="panel-sub">${allDestinations.length ? 'All stations are hidden on this screen — check a box above to show one.' : 'No ticket destinations set up yet — add them in Settings → Menu.'}</div>`}
  </div>`;
}
function renderKitchenTicket(t){
  const table = tableById(t.check.table_id);
  const mins = ticketElapsedMinutes(t.firedAt);
  const urgent = mins >= 12;
  const allReady = t.items.every(ci => ci.status === 'ready');
  const destId = t.items[0]?.ticket_destination_id;
  return `
  <div class="card" style="border-left:4px solid ${urgent?'#dc2626':'#0070f2'}">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <b>${esc(table?.label||'?')}${t.check.guest_label?' · '+esc(t.check.guest_label):''}</b>
      <span class="panel-sub" style="margin:0">${mins}m</span>
    </div>
    ${t.items.map(ci => `<div style="padding:4px 0;border-top:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span>${ci.quantity}x ${esc(ci.name_snapshot)}${ci.seat_number ? ` <b>· Seat ${ci.seat_number}</b>` : ''}</span>
        <span class="badge badge-pending">${esc(ci.status)}</span>
      </div>
      ${(ci.modifiers||[]).length ? `<div class="panel-sub" style="margin:0">${(ci.modifiers||[]).map(m=>esc(m.name)).join(', ')}</div>` : ''}
      ${ci.notes ? `<div class="panel-sub" style="margin:0">📝 ${esc(ci.notes)}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:4px">
        ${ci.status==='fired' ? `<button class="btn btn-sm btn-secondary" onclick="advanceCheckItem('${ci.id}','preparing')">Start</button>` : ''}
        ${ci.status==='preparing' ? `<button class="btn btn-sm btn-primary" onclick="advanceCheckItem('${ci.id}','ready')">Ready</button>` : ''}
      </div>
    </div>`).join('')}
    ${!allReady ? `<div class="modal-actions" style="padding-top:8px;justify-content:flex-start"><button class="btn btn-sm btn-primary" onclick="advanceTicket('${t.check.id}','${destId}')">Mark Whole Ticket Ready</button></div>` : `<div class="panel-sub" style="margin-top:6px">✅ Ready for expo</div>`}
  </div>`;
}
window.advanceCheckItem = async function(id, newStatus){
  const patch = { status: newStatus };
  if (newStatus === 'ready') patch.ready_at = new Date().toISOString();
  const { error } = await sb.from('check_items').update(patch).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
window.advanceTicket = async function(checkId, destinationId){
  const { error } = await sb.from('check_items').update({ status: 'ready', ready_at: new Date().toISOString() })
    .eq('check_id', checkId).eq('ticket_destination_id', destinationId).in('status', ['fired','preparing']);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};

// ============================================================================
// EXPO (Phase 7) — everything the kitchen/bar has marked ready, waiting to be
// run to the table. Expo (or a manager) clears items here once delivered,
// which is also what clears the 🔔 ready flag servers see on the Orders tab.
// ============================================================================
function renderExpoTab(){
  const readyItems = state.checkItems.filter(ci => ci.status === 'ready');
  const checkIds = [...new Set(readyItems.map(ci=>ci.check_id))];
  const tickets = checkIds.map(cid => {
    const check = state.checks.find(c=>c.id===cid);
    const items = readyItems.filter(ci=>ci.check_id===cid).sort((a,b)=>new Date(a.ready_at||0)-new Date(b.ready_at||0));
    return { check, items };
  }).filter(t=>t.check).sort((a,b) => new Date(a.items[0]?.ready_at||0) - new Date(b.items[0]?.ready_at||0));
  return `
  <div class="panel-header"><h2 class="panel-title">Expo — Ready to Run</h2></div>
  <div style="display:flex;flex-wrap:wrap;gap:12px">
    ${tickets.map(t => {
      const table = tableById(t.check.table_id);
      return `<div class="card" style="flex:0 0 300px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <b>${esc(table?.label||'?')}${t.check.guest_label?' · '+esc(t.check.guest_label):''}</b>
          <span class="panel-sub" style="margin:0">${ticketElapsedMinutes(t.items[0]?.ready_at)}m ready</span>
        </div>
        ${(() => {
          // Group by seat so expo can see at a glance which plate goes to which seat —
          // "table" (no seat set) items are listed first, then seats in numeric order.
          const bySeat = {};
          t.items.forEach(ci => { const k = ci.seat_number || 'table'; (bySeat[k] ||= []).push(ci); });
          const seatKeys = Object.keys(bySeat).sort((a,b) => a==='table' ? -1 : b==='table' ? 1 : Number(a)-Number(b));
          return seatKeys.map(k => `
            <div style="margin-top:6px">
              <div class="panel-sub" style="margin:0;font-weight:600">${k==='table' ? 'Whole table' : 'Seat '+k}</div>
              ${bySeat[k].map(ci => `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-top:1px solid var(--border)">
                <span>${ci.quantity}x ${esc(ci.name_snapshot)}</span>
                <button class="btn btn-sm btn-primary" onclick="markItemDelivered('${ci.id}')">Delivered</button>
              </div>`).join('')}
            </div>`).join('');
        })()}
        <div class="modal-actions" style="padding-top:8px;justify-content:flex-start"><button class="btn btn-sm btn-secondary" onclick="markTicketDelivered('${t.check.id}')">Mark All Delivered</button></div>
      </div>`;
    }).join('') || '<div class="panel-sub">Nothing ready right now.</div>'}
  </div>`;
}
window.markItemDelivered = async function(id){
  const { error } = await sb.from('check_items').update({ status: 'delivered', delivered_at: new Date().toISOString() }).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
window.markTicketDelivered = async function(checkId){
  const { error } = await sb.from('check_items').update({ status: 'delivered', delivered_at: new Date().toISOString() }).eq('check_id', checkId).eq('status','ready');
  if (error){ alert('Error: '+error.message); return; }
  await loadOrdersData();
};
function avgOrderTimeMinutes(){
  const delivered = state.checkItems.filter(ci => ci.status==='delivered' && ci.fired_at && ci.delivered_at);
  if (!delivered.length) return null;
  const totalMin = delivered.reduce((s,ci) => s + (new Date(ci.delivered_at) - new Date(ci.fired_at))/60000, 0);
  return totalMin / delivered.length;
}

// ============================================================================
// SCHEDULE TAB — clock in/out, my schedule, time off, and (permission-gated)
// the manager-facing schedule builder + timecard/time-off management.
// ============================================================================
async function loadScheduleData(){
  const today = todayISO();
  const from = toLocalISODate(new Date(new Date(today+'T00:00:00').getTime() - 7*86400000));
  const to = toLocalISODate(new Date(new Date(today+'T00:00:00').getTime() + 30*86400000));
  const [shiftsRes, clockRes, offRes, groupsRes, groupMembersRes, threadsRes, participantsRes, messagesRes, swapsRes, terminalsRes] = await Promise.all([
    sb.from('schedule_shifts').select('*').gte('shift_date', from).lte('shift_date', to).order('shift_date').order('scheduled_start'),
    sb.from('time_clock_entries').select('*').order('clock_in_at', { ascending: false }).limit(300),
    sb.from('time_off_requests').select('*').order('requested_at', { ascending: false }),
    sb.from('staff_groups').select('*').order('name'),
    sb.from('staff_group_members').select('*'),
    sb.from('message_threads').select('*').order('created_at', { ascending: false }),
    sb.from('thread_participants').select('*'),
    sb.from('messages').select('*').order('created_at', { ascending: false }).limit(300),
    sb.from('shift_swap_requests').select('*').order('created_at', { ascending: false }),
    sb.from('clock_terminals').select('*').order('created_at'),
  ]);
  state.scheduleShifts = shiftsRes.data || [];
  state.timeClockEntries = clockRes.data || [];
  state.timeOffRequests = offRes.data || [];
  state.staffGroups = groupsRes.data || [];
  state.staffGroupMembers = groupMembersRes.data || [];
  state.messageThreads = threadsRes.data || [];
  state.threadParticipants = participantsRes.data || [];
  state.messages = messagesRes.data || [];
  state.shiftSwapRequests = swapsRes.data || [];
  state.clockTerminals = terminalsRes.data || [];
  render();
}

function renderScheduleTab(){
  const myOpenEntry = state.timeClockEntries.find(e => e.staff_id === currentStaff.id && !e.clock_out_at);
  const myShifts = state.scheduleShifts.filter(s => s.staff_id === currentStaff.id && s.published && s.shift_date >= todayISO()).slice(0,10);
  const myTimeOff = state.timeOffRequests.filter(r => r.staff_id === currentStaff.id);

  const thisDeviceToken = localStorage.getItem(TERMINAL_TOKEN_KEY);
  const thisDeviceIsTerminal = thisDeviceToken && state.clockTerminals.some(t => t.device_token === thisDeviceToken && t.active);
  // On a shared terminal, currentStaff is whoever PIN-unlocked the screen (see the
  // terminal-lock feature) — not the identity actually behind this browser's Supabase
  // session. The plain Clock In/Out button below calls punch_clock_in/out, which stamps
  // auth.uid() (the real underlying session) rather than currentStaff, so on a shared
  // terminal it would silently clock in the WRONG person. Hide it there entirely and
  // rely on the PIN-verified kiosk card instead, which stamps whichever staff id the PIN
  // actually belongs to regardless of the browser's own session.
  const clockCard = (can('clock_in_out') && !thisDeviceIsTerminal) ? `
  <div class="section-heading">Time Clock</div>
  <div class="card">
    ${myOpenEntry
      ? `<div class="res-meta">Clocked in since ${new Date(myOpenEntry.clock_in_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}${myOpenEntry.status==='late'?' <span class="badge badge-pending">late</span>':''}</div>
         <div class="modal-actions" style="padding-top:10px;justify-content:flex-start"><button class="btn btn-danger" onclick="clockOut()">Clock Out</button></div>`
      : `<div class="panel-sub" style="margin:0 0 10px">Not clocked in.${CLOCK_GATED_ROLES.has(currentStaff.role)?' Clock in below to unlock the rest of the app.':''}</div>
         <div class="modal-actions" style="padding-top:0;justify-content:flex-start"><button class="btn btn-primary" onclick="clockIn()">Clock In</button></div>`}
  </div>` : '';

  const kioskEligibleStaff = state.staffList.filter(s => s.active && staffHasPermission(s.id, 'clock_in_out'));
  // Default the picker to whoever's currently PIN-active on this terminal (if they're
  // clock-eligible) instead of just the first name alphabetically — on a shared terminal
  // that's almost always who actually walked up to punch in.
  const kioskDefaultId = kioskEligibleStaff.some(s => s.id === currentStaff.id) ? currentStaff.id : kioskEligibleStaff[0]?.id;
  const kioskFirstOpen = kioskDefaultId && state.timeClockEntries.some(e => e.staff_id === kioskDefaultId && !e.clock_out_at);
  const kioskCard = thisDeviceIsTerminal ? `
  <div class="section-heading">Staff Time Clock (This Terminal)</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">This device is a registered clock-in terminal — anyone can use it to punch themselves in or out here, no matter whose account is signed into the browser. Pick your name and enter your own PIN.</div>
    <div class="formgrid">
      <div><label class="field-label">Employee</label><select class="modal-select" id="kioskEmployee" onchange="kioskUpdateButtonLabel()">${kioskEligibleStaff.map(s => `<option value="${s.id}" ${s.id===kioskDefaultId?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div><label class="field-label">PIN</label><input type="password" inputmode="numeric" maxlength="6" class="modal-input" id="kioskPin" placeholder="••••" onkeydown="if(event.key==='Enter')kioskPunch()"/></div>
    </div>
    <div class="modal-actions" style="padding-top:6px;justify-content:flex-start">
      <button class="btn ${kioskFirstOpen?'btn-danger':'btn-primary'}" id="kioskPunchBtn" onclick="kioskPunch()">${kioskFirstOpen?'Clock Out':'Clock In'}</button>
    </div>
  </div>` : '';

  const scheduleCard = can('view_own_schedule') ? `
  <div class="section-heading">My Upcoming Shifts</div>
  <div class="card">
    ${myShifts.length ? myShifts.map(s => `<div class="res-meta" style="padding:3px 0">${fmtDateHuman(s.shift_date)} · ${fmtTime(s.scheduled_start)}–${fmtTime(s.scheduled_end)}${s.shift_role?' · '+esc(s.shift_role):''}</div>`).join('') : '<div class="panel-sub" style="margin:0">No upcoming shifts scheduled.</div>'}
  </div>` : '';

  const timeOffCard = can('request_time_off') ? `
  <div class="section-heading">Time Off</div>
  <div class="card">
    ${myTimeOff.length ? myTimeOff.map(r => `<div class="res-meta" style="padding:3px 0">${fmtDateHuman(r.start_date)} – ${fmtDateHuman(r.end_date)}${r.reason?' · '+esc(r.reason):''} <span class="badge badge-${r.status==='approved'?'confirmed':r.status==='denied'?'cancelled':'pending'}">${r.status}</span></div>`).join('') : '<div class="panel-sub" style="margin:0 0 10px">No requests yet.</div>'}
    <div class="modal-actions" style="padding-top:10px;justify-content:flex-start"><button class="btn btn-secondary btn-sm" onclick="openTimeOffModal()">+ Request Time Off</button></div>
  </div>` : '';

  return `
  <div class="panel-header"><h2 class="panel-title">Schedule</h2></div>
  ${clockCard}
  ${kioskCard}
  ${scheduleCard}
  ${timeOffCard}
  ${can('use_messaging') ? renderMessagesSection() : ''}
  ${can('manage_broadcasts') ? renderGroupsSection() : ''}
  ${can('manage_schedule') ? renderScheduleBuilder() : ''}
  ${can('manage_timecards') ? renderTimecardManagement() + renderClockTerminalsSection() : ''}`;
}

// ---- Messaging: threads, groups, shift swaps -------------------------------
function myThreadIds(){
  return new Set(state.threadParticipants.filter(tp => tp.staff_id === currentStaff.id).map(tp => tp.thread_id));
}
function threadLabel(t){
  if (t.type === 'broadcast') return '📣 ' + (t.name || 'Broadcast: Everyone');
  if (t.type === 'group'){
    const g = state.staffGroups.find(x => x.id === t.group_id);
    return '👥 ' + (g?.name || t.name || 'Group');
  }
  const others = state.threadParticipants.filter(tp => tp.thread_id === t.id && tp.staff_id !== currentStaff.id).map(tp => state.staffList.find(s=>s.id===tp.staff_id)?.name).filter(Boolean);
  return '💬 ' + (others.join(', ') || 'Direct message');
}
function renderMessagesSection(){
  const mine = myThreadIds();
  const myThreads = state.messageThreads.filter(t => mine.has(t.id) || can('manage_broadcasts'));
  const rows = myThreads.map(t => {
    const last = state.messages.filter(m => m.thread_id === t.id).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0];
    return { t, last };
  }).sort((a,b) => new Date(b.last?.created_at||b.t.created_at) - new Date(a.last?.created_at||a.t.created_at));

  const openSwaps = state.shiftSwapRequests.filter(r => r.status === 'open' && r.requested_by !== currentStaff.id);
  const mySwaps = state.shiftSwapRequests.filter(r => r.requested_by === currentStaff.id && r.status !== 'denied');
  const swapLine = r => {
    const s = state.scheduleShifts.find(x => x.id === r.shift_id);
    return s ? `${fmtDateHuman(s.shift_date)} · ${fmtTime(s.scheduled_start)}–${fmtTime(s.scheduled_end)}` : 'shift';
  };

  return `
  <div class="section-heading">Messages</div>
  <div class="card">
    ${rows.length ? rows.map(({t,last}) => `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;cursor:pointer" onclick="openThreadModal('${t.id}')">
      <span><b>${esc(threadLabel(t))}</b>${last ? ' — '+esc(last.body.slice(0,60))+(last.body.length>60?'…':'') : ' — no messages yet'}</span>
      <span class="panel-sub" style="margin:0">${last ? new Date(last.created_at).toLocaleDateString() : ''}</span>
    </div>`).join('') : '<div class="panel-sub" style="margin:0">No messages yet.</div>'}
    <div class="modal-actions" style="padding-top:10px;justify-content:flex-start;gap:8px">
      <button class="btn btn-secondary btn-sm" onclick="openNewMessageModal()">+ New Message</button>
      <button class="btn btn-secondary btn-sm" onclick="openShiftSwapModal()">🔁 Request Shift Swap</button>
    </div>
  </div>
  ${(openSwaps.length || mySwaps.length) ? `
  <div class="section-heading">Shift Swaps</div>
  <div class="card">
    ${mySwaps.map(r => {
      const claimant = r.claimed_by ? state.staffList.find(x=>x.id===r.claimed_by) : null;
      return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
        <span>Your shift — ${swapLine(r)}${claimant ? ' — claimed by '+esc(claimant.name) : ''}</span>
        <span class="badge badge-${r.status==='approved'?'confirmed':'pending'}">${r.status}</span>
      </div>`;
    }).join('')}
    ${openSwaps.length ? openSwaps.map(r => {
      const req = state.staffList.find(x=>x.id===r.requested_by);
      return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
        <span>${esc(req?.name||'?')}'s shift — ${swapLine(r)}</span>
        <button class="btn btn-sm btn-secondary" onclick="claimShiftSwap('${r.id}')">Claim</button>
      </div>`;
    }).join('') : '<div class="panel-sub" style="margin:0">No open swaps to claim right now.</div>'}
  </div>` : ''}`;
}

function renderGroupsSection(){
  return `
  <div class="section-heading">Staff Groups</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Groups used for group messages and broadcasts — any mix of employees, not tied to role.</div>
    ${state.staffGroups.length ? state.staffGroups.map(g => {
      const members = state.staffGroupMembers.filter(m => m.group_id === g.id).map(m => state.staffList.find(s=>s.id===m.staff_id)?.name).filter(Boolean);
      return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
        <span><b>${esc(g.name)}</b> — ${members.length ? esc(members.join(', ')) : 'no members yet'}</span>
        <span style="display:flex;gap:6px"><button class="btn btn-sm btn-secondary" onclick="openGroupModal('${g.id}')">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteStaffGroup('${g.id}')">Delete</button></span>
      </div>`;
    }).join('') : '<div class="panel-sub" style="margin:0">No groups yet.</div>'}
    <div class="modal-actions" style="padding-top:10px;justify-content:flex-start"><button class="btn btn-secondary btn-sm" onclick="openGroupModal()">+ New Group</button></div>
  </div>`;
}

// ---- Groups: create/edit/delete -------------------------------------------
window.openGroupModal = function(groupId){
  const g = groupId ? state.staffGroups.find(x => x.id === groupId) : null;
  const memberIds = g ? new Set(state.staffGroupMembers.filter(m => m.group_id === g.id).map(m => m.staff_id)) : new Set();
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${g ? 'Edit Group' : 'New Group'}</h3>
    <label class="field-label">Group name</label>
    <input type="text" class="modal-input" id="grpName" value="${g ? esc(g.name) : ''}"/>
    <label class="field-label">Members</label>
    <div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:10px">
      ${state.staffList.filter(s=>s.active).map(s => `<label style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px">
        <input type="checkbox" class="grpMemberChk" value="${s.id}" ${memberIds.has(s.id)?'checked':''}/> ${esc(s.name)} (${esc(s.role)})
      </label>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveGroup(${g ? `'${g.id}'` : 'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.saveGroup = async function(groupId){
  const name = document.getElementById('grpName').value.trim();
  if (!name){ alert('Enter a group name.'); return; }
  const memberIds = Array.from(document.querySelectorAll('.grpMemberChk:checked')).map(el => el.value);
  let id = groupId;
  if (id){
    const { error } = await sb.from('staff_groups').update({ name }).eq('id', id);
    if (error){ alert('Error: '+error.message); return; }
    await sb.from('staff_group_members').delete().eq('group_id', id);
  } else {
    const { data, error } = await sb.from('staff_groups').insert({ name, created_by: currentStaff.id }).select().single();
    if (error){ alert('Error: '+error.message); return; }
    id = data.id;
  }
  if (memberIds.length){
    const { error: memErr } = await sb.from('staff_group_members').insert(memberIds.map(sid => ({ group_id: id, staff_id: sid })));
    if (memErr){ alert('Group saved, but adding members failed: '+memErr.message); }
  }
  closeModal('formModal');
  await loadScheduleData();
};
window.deleteStaffGroup = async function(id){
  if (!confirm('Delete this group? Any group message thread stays but the group definition will be gone.')) return;
  await sb.from('staff_group_members').delete().eq('group_id', id);
  const { error } = await sb.from('staff_groups').delete().eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await loadScheduleData();
};

// ---- Messages: new message, threads, replies -------------------------------
window.openNewMessageModal = function(){
  const canBroadcast = can('manage_broadcasts');
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>New Message</h3>
    <label class="field-label">Send to</label>
    <select class="modal-select" id="msgKind" onchange="toggleMsgKindFields()">
      <option value="direct">One person</option>
      <option value="group">A group</option>
      ${canBroadcast ? '<option value="broadcast">Broadcast to everyone</option>' : ''}
    </select>
    <div id="msgKindFields" style="margin-top:8px"></div>
    <label class="field-label" style="margin-top:10px">Message</label>
    <textarea class="modal-input" id="msgBody" rows="3" style="resize:vertical"></textarea>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="sendNewMessage()">Send</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
  toggleMsgKindFields();
};
window.toggleMsgKindFields = function(){
  const kind = document.getElementById('msgKind').value;
  const div = document.getElementById('msgKindFields');
  if (kind === 'direct'){
    div.innerHTML = `<select class="modal-select" id="msgToStaff">${state.staffList.filter(s=>s.active && s.id!==currentStaff.id).map(s=>`<option value="${s.id}">${esc(s.name)} (${esc(s.role)})</option>`).join('') || '<option value="">No other staff yet</option>'}</select>`;
  } else if (kind === 'group'){
    div.innerHTML = `<select class="modal-select" id="msgToGroup">${state.staffGroups.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('') || '<option value="">No groups yet — create one first</option>'}</select>`;
  } else {
    div.innerHTML = `<div class="panel-sub" style="margin:0">Goes to every active employee.</div>`;
  }
};
async function findOrCreateDirectThread(otherId){
  const myThreadIdsArr = state.threadParticipants.filter(tp => tp.staff_id === currentStaff.id).map(tp => tp.thread_id);
  const theirThreadIds = new Set(state.threadParticipants.filter(tp => tp.staff_id === otherId).map(tp => tp.thread_id));
  const existing = state.messageThreads.find(t => t.type === 'direct' && myThreadIdsArr.includes(t.id) && theirThreadIds.has(t.id));
  if (existing) return existing.id;
  const { data, error } = await sb.from('message_threads').insert({ type: 'direct', created_by: currentStaff.id }).select().single();
  if (error){ alert('Error: '+error.message); return null; }
  const { error: partErr } = await sb.from('thread_participants').insert([{ thread_id: data.id, staff_id: currentStaff.id }, { thread_id: data.id, staff_id: otherId }]);
  if (partErr){ alert('Error: '+partErr.message); return null; }
  return data.id;
}
async function findOrCreateGroupThread(groupId){
  const existing = state.messageThreads.find(t => t.type === 'group' && t.group_id === groupId);
  if (existing) return existing.id;
  const g = state.staffGroups.find(x => x.id === groupId);
  const { data, error } = await sb.from('message_threads').insert({ type: 'group', group_id: groupId, name: g?.name || null, created_by: currentStaff.id }).select().single();
  if (error){ alert('Error: '+error.message); return null; }
  const memberIds = new Set(state.staffGroupMembers.filter(m => m.group_id === groupId).map(m => m.staff_id));
  memberIds.add(currentStaff.id);
  const { error: partErr } = await sb.from('thread_participants').insert(Array.from(memberIds).map(sid => ({ thread_id: data.id, staff_id: sid })));
  if (partErr){ alert('Error: '+partErr.message); return null; }
  return data.id;
}
async function findOrCreateBroadcastThread(){
  const existing = state.messageThreads.find(t => t.type === 'broadcast');
  if (existing) return existing.id;
  const { data, error } = await sb.from('message_threads').insert({ type: 'broadcast', name: 'Everyone', created_by: currentStaff.id }).select().single();
  if (error){ alert('Error: '+error.message); return null; }
  const { error: partErr } = await sb.from('thread_participants').insert(state.staffList.filter(s=>s.active).map(s => ({ thread_id: data.id, staff_id: s.id })));
  if (partErr){ alert('Error: '+partErr.message); return null; }
  return data.id;
}
window.sendNewMessage = async function(){
  const kind = document.getElementById('msgKind').value;
  const body = document.getElementById('msgBody').value.trim();
  if (!body){ alert('Enter a message.'); return; }
  let threadId;
  if (kind === 'direct'){
    const toId = document.getElementById('msgToStaff').value;
    if (!toId){ alert('Choose someone to message.'); return; }
    threadId = await findOrCreateDirectThread(toId);
  } else if (kind === 'group'){
    const groupId = document.getElementById('msgToGroup').value;
    if (!groupId){ alert('Choose a group.'); return; }
    threadId = await findOrCreateGroupThread(groupId);
  } else {
    threadId = await findOrCreateBroadcastThread();
  }
  if (!threadId) return;
  const { error } = await sb.from('messages').insert({ thread_id: threadId, sender_id: currentStaff.id, body });
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await loadScheduleData();
};
window.openThreadModal = function(threadId){
  const t = state.messageThreads.find(x => x.id === threadId);
  if (!t) return;
  const msgs = state.messages.filter(m => m.thread_id === threadId).sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  const canPost = t.type !== 'broadcast' || can('manage_broadcasts');
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${esc(threadLabel(t))}</h3>
    <div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:12px;padding:4px">
      ${msgs.length ? msgs.map(m => {
        const s = state.staffList.find(x => x.id === m.sender_id);
        return `<div style="padding:8px 10px;border-radius:8px;background:${m.sender_id===currentStaff.id?'#eef2ff':'#f4f4f5'}">
          <div style="font-size:12px;font-weight:600;margin-bottom:2px">${esc(s?.name||'?')} <span class="panel-sub" style="font-weight:400">${new Date(m.created_at).toLocaleString()}</span></div>
          <div style="font-size:13px">${esc(m.body)}</div>
        </div>`;
      }).join('') : '<div class="panel-sub" style="margin:0">No messages yet.</div>'}
    </div>
    ${canPost ? `
    <div style="display:flex;gap:8px">
      <input type="text" class="modal-input" id="replyBody" style="margin:0;flex:1" placeholder="Type a reply…" onkeydown="if(event.key==='Enter')sendReply('${threadId}')"/>
      <button class="btn btn-primary" onclick="sendReply('${threadId}')">Send</button>
    </div>` : `<div class="panel-sub" style="margin:0">Only managers can post to broadcasts.</div>`}
    <div class="modal-actions"><button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button></div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.sendReply = async function(threadId){
  const input = document.getElementById('replyBody');
  const body = input.value.trim();
  if (!body) return;
  const { error } = await sb.from('messages').insert({ thread_id: threadId, sender_id: currentStaff.id, body });
  if (error){ alert('Error: '+error.message); return; }
  await loadScheduleData();
  openThreadModal(threadId);
};

// ---- Shift swaps: request, claim -------------------------------------------
window.openShiftSwapModal = function(){
  const myShifts = state.scheduleShifts.filter(s => s.staff_id === currentStaff.id && s.published && s.shift_date >= todayISO());
  if (!myShifts.length){ alert('You have no upcoming published shifts to offer for swap.'); return; }
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Request Shift Swap</h3>
    <label class="field-label">Which shift?</label>
    <select class="modal-select" id="swapShift">${myShifts.map(s=>`<option value="${s.id}">${fmtDateHuman(s.shift_date)} · ${fmtTime(s.scheduled_start)}–${fmtTime(s.scheduled_end)}</option>`).join('')}</select>
    <div class="panel-sub" style="margin:8px 0">Anyone can claim it from the Messages section — a manager still has to approve the swap before it's final.</div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="submitShiftSwap()">Request Swap</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.submitShiftSwap = async function(){
  const shiftId = document.getElementById('swapShift').value;
  const { error } = await sb.from('shift_swap_requests').insert({ shift_id: shiftId, requested_by: currentStaff.id });
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await loadScheduleData();
};
window.claimShiftSwap = async function(id){
  if (!confirm('Claim this shift? A manager still needs to approve it.')) return;
  const { error } = await sb.from('shift_swap_requests').update({ status: 'claimed', claimed_by: currentStaff.id }).eq('id', id).eq('status', 'open');
  if (error){ alert('Error: '+error.message); return; }
  await loadScheduleData();
};
window.decideShiftSwap = async function(id, decision){
  const r = state.shiftSwapRequests.find(x => x.id === id);
  if (!r) return;
  if (decision === 'approved' && !confirm('Approve this swap? The shift will be reassigned to the person who claimed it.')) return;
  const { error } = await sb.from('shift_swap_requests').update({ status: decision, approved_by: currentStaff.id, decided_at: new Date().toISOString() }).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  if (decision === 'approved' && r.claimed_by){
    const { error: reassignErr } = await sb.from('schedule_shifts').update({ staff_id: r.claimed_by }).eq('id', r.shift_id);
    if (reassignErr) alert('Swap approved, but the shift could not be reassigned automatically (missing schedule permission) — move it manually on the Schedule Builder. '+reassignErr.message);
  }
  await loadScheduleData();
};

function renderScheduleBuilder(){
  const upcoming = state.scheduleShifts.filter(s => s.shift_date >= todayISO()).slice(0,50);
  return `
  <div class="section-heading">Schedule Builder</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Unpublished shifts are drafts — only visible here until you publish them, so staff never see a schedule that isn't final yet.</div>
    <table class="data-table">
      <thead><tr><th>Employee</th><th>Date</th><th>Time</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${upcoming.map(s => {
          const st = state.staffList.find(x=>x.id===s.staff_id);
          return `<tr>
            <td>${esc(st?.name||'?')}</td>
            <td>${fmtDateHuman(s.shift_date)}</td>
            <td>${fmtTime(s.scheduled_start)}–${fmtTime(s.scheduled_end)}</td>
            <td>${esc(s.shift_role||st?.role||'')}</td>
            <td>${s.published ? '<span class="badge badge-confirmed">published</span>' : '<span class="badge badge-pending">draft</span>'}</td>
            <td style="display:flex;gap:6px">
              ${!s.published ? `<button class="btn btn-sm btn-primary" onclick="publishShift('${s.id}')">Publish</button>` : ''}
              <button class="btn btn-sm btn-danger" onclick="deleteShift('${s.id}')">Delete</button>
            </td>
          </tr>`;
        }).join('') || `<tr><td colspan="6"><span class="panel-sub">No shifts scheduled yet.</span></td></tr>`}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="openShiftModal()">+ Add Shift</button></div>
  </div>`;
}

function renderTimecardManagement(){
  const now = getNow();
  const missing = state.scheduleShifts.filter(s => {
    if (s.shift_date > todayISO()) return false;
    const scheduledEnd = new Date(s.shift_date+'T'+s.scheduled_end);
    if (now.getTime() - scheduledEnd.getTime() < 60*60000) return false; // grace period before flagging
    const entry = state.timeClockEntries.find(e => e.shift_id === s.id);
    return !entry || !entry.clock_out_at;
  });
  const pendingOff = state.timeOffRequests.filter(r => r.status === 'pending');
  const pendingSwaps = state.shiftSwapRequests.filter(r => r.status === 'claimed');
  return `
  <div class="section-heading">Missing Punches</div>
  <div class="card">
    ${missing.length ? missing.map(s => {
      const st = state.staffList.find(x=>x.id===s.staff_id);
      return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
        <span>${esc(st?.name||'?')} — ${fmtDateHuman(s.shift_date)}, scheduled until ${fmtTime(s.scheduled_end)}</span>
        <button class="btn btn-sm btn-secondary" onclick="correctMissingPunch('${s.id}')">Correct</button>
      </div>`;
    }).join('') : '<div class="panel-sub" style="margin:0">No missing punches.</div>'}
  </div>
  <div class="section-heading">Time Off Requests</div>
  <div class="card">
    ${pendingOff.length ? pendingOff.map(r => {
      const st = state.staffList.find(x=>x.id===r.staff_id);
      return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
        <span>${esc(st?.name||'?')} — ${fmtDateHuman(r.start_date)} to ${fmtDateHuman(r.end_date)}${r.reason?' · '+esc(r.reason):''}</span>
        <span style="display:flex;gap:6px"><button class="btn btn-sm btn-success" onclick="decideTimeOff('${r.id}','approved')">Approve</button><button class="btn btn-sm btn-danger" onclick="decideTimeOff('${r.id}','denied')">Deny</button></span>
      </div>`;
    }).join('') : '<div class="panel-sub" style="margin:0">No pending requests.</div>'}
  </div>
  ${can('approve_shift_swap') ? `
  <div class="section-heading">Pending Shift Swaps</div>
  <div class="card">
    ${pendingSwaps.length ? pendingSwaps.map(r => {
      const s = state.scheduleShifts.find(x=>x.id===r.shift_id);
      const req = state.staffList.find(x=>x.id===r.requested_by);
      const claim = state.staffList.find(x=>x.id===r.claimed_by);
      return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
        <span>${esc(req?.name||'?')} → ${esc(claim?.name||'?')} — ${s?fmtDateHuman(s.shift_date)+' · '+fmtTime(s.scheduled_start)+'–'+fmtTime(s.scheduled_end):'shift'}</span>
        <span style="display:flex;gap:6px"><button class="btn btn-sm btn-success" onclick="decideShiftSwap('${r.id}','approved')">Approve</button><button class="btn btn-sm btn-danger" onclick="decideShiftSwap('${r.id}','denied')">Deny</button></span>
      </div>`;
    }).join('') : '<div class="panel-sub" style="margin:0">No pending swaps.</div>'}
  </div>` : ''}`;
}

function renderClockTerminalsSection(){
  const myToken = localStorage.getItem(TERMINAL_TOKEN_KEY);
  return `
  <div class="section-heading">Clock-In Terminals</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Only devices registered here can process clock in/out — this keeps staff from punching in on a personal phone. Pull up the app on the physical terminal or tablet (e.g. a waiter station) you want to use for punches, then register it below.</div>
    <table class="data-table">
      <thead><tr><th>Name</th><th>Registered</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.clockTerminals.map(t => `<tr>
          <td>${esc(t.name)}${myToken===t.device_token?' <span class="badge badge-confirmed">this device</span>':''}</td>
          <td>${fmtDateHuman(t.created_at.slice(0,10))}</td>
          <td>${t.active?'<span class="badge badge-confirmed">active</span>':'<span class="badge badge-pending">inactive</span>'}</td>
          <td style="display:flex;gap:6px">
            <button class="btn btn-sm btn-secondary" onclick="renameClockTerminal('${t.id}')">Rename</button>
            <button class="btn btn-sm ${t.active?'btn-danger':'btn-success'}" onclick="toggleClockTerminalActive('${t.id}', ${!t.active})">${t.active?'Deactivate':'Reactivate'}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteClockTerminal('${t.id}')">Delete</button>
          </td>
        </tr>`).join('') || `<tr><td colspan="4"><span class="panel-sub">No terminals registered yet — punches are blocked everywhere until you register at least one.</span></td></tr>`}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px">
      <button class="btn btn-primary" onclick="registerThisDeviceAsTerminal()">+ Register This Device</button>
    </div>
  </div>`;
}
window.registerThisDeviceAsTerminal = async function(){
  const name = prompt('Name for this terminal (e.g. "Waiter Station 1", "Host Stand iPad"):');
  if (!name || !name.trim()) return;
  const { data, error } = await sb.from('clock_terminals').insert({ name: name.trim(), created_by: currentStaff.id }).select().single();
  if (error){ alert('Error: '+error.message); return; }
  localStorage.setItem(TERMINAL_TOKEN_KEY, data.device_token);
  await loadScheduleData();
  alert(`"${data.name}" is now a registered clock-in terminal — staff can punch in/out on this device.`);
};
window.renameClockTerminal = async function(id){
  const t = state.clockTerminals.find(x=>x.id===id);
  const name = prompt('Terminal name:', t?.name||'');
  if (!name || !name.trim()) return;
  await sb.from('clock_terminals').update({ name: name.trim() }).eq('id', id);
  await loadScheduleData();
};
window.toggleClockTerminalActive = async function(id, active){
  await sb.from('clock_terminals').update({ active }).eq('id', id);
  await loadScheduleData();
};
window.deleteClockTerminal = async function(id){
  if (!confirm('Delete this terminal? If this is the device using it, punches on this device will stop working until it\'s registered again.')) return;
  await sb.from('clock_terminals').delete().eq('id', id);
  await loadScheduleData();
};

window.clockIn = async function(){
  // punch_clock_in stamps auth.uid() (the real signed-in browser session), not
  // currentStaff — wrong on a shared terminal where currentStaff may be a PIN-swapped
  // operator. The Schedule tab already hides this button there; this is a backstop.
  if (isSharedTerminalDevice()){ alert('Use the "Staff Time Clock (This Terminal)" section below to clock in on a shared terminal.'); return; }
  const pin = prompt('Enter your PIN to clock in:');
  if (!pin) return;
  const { data: ok, error: pinErr } = await sb.rpc('verify_staff_pin', { target_staff_id: currentStaff.id, pin });
  if (pinErr || !ok){ alert('Incorrect PIN.'); return; }
  const now = getNow();
  const today = todayISO();
  const todaysShifts = state.scheduleShifts.filter(s => s.staff_id === currentStaff.id && s.shift_date === today && s.published);
  let shift = todaysShifts.find(s => now.getTime() >= new Date(today+'T'+s.scheduled_start).getTime() - 10*60000) || todaysShifts[0];
  if (!shift){
    if (!can('manage_timecards')){ alert('No scheduled shift found for you today — ask a manager to clock you in.'); return; }
    if (!confirm('No scheduled shift found for today — clock in anyway?')) return;
  } else {
    const start = new Date(today+'T'+shift.scheduled_start);
    if (now.getTime() < start.getTime() - 10*60000){
      alert(`Too early — your shift starts at ${fmtTime(shift.scheduled_start)}.`);
      return;
    }
  }
  const status = shift && now.getTime() > new Date(today+'T'+shift.scheduled_start).getTime() ? 'late' : 'on_time';
  const deviceToken = localStorage.getItem(TERMINAL_TOKEN_KEY);
  const { error } = await sb.rpc('punch_clock_in', { p_device_token: deviceToken, p_shift_id: shift?.id || null, p_status: status });
  if (error){ alert(error.message); return; }
  await loadScheduleData();
};

window.clockOut = async function(){
  if (isSharedTerminalDevice()){ alert('Use the "Staff Time Clock (This Terminal)" section below to clock out on a shared terminal.'); return; }
  const entry = state.timeClockEntries.find(e => e.staff_id === currentStaff.id && !e.clock_out_at);
  if (!entry){ alert("You're not clocked in."); return; }
  const pin = prompt('Enter your PIN to clock out:');
  if (!pin) return;
  const { data: ok, error: pinErr } = await sb.rpc('verify_staff_pin', { target_staff_id: currentStaff.id, pin });
  if (pinErr || !ok){ alert('Incorrect PIN.'); return; }
  const cashTipsInput = prompt(`Card tips this shift: $${Number(entry.computed_card_tips||0).toFixed(2)} (tracked automatically once Payments is live — nothing to enter for that part).\n\nCash tips you received this shift ($):`, '0');
  if (cashTipsInput === null) return;
  const cashTips = Number(cashTipsInput);
  if (isNaN(cashTips) || cashTips < 0){ alert('Enter a valid dollar amount.'); return; }
  const deviceToken = localStorage.getItem(TERMINAL_TOKEN_KEY);
  const { error } = await sb.rpc('punch_clock_out', { p_device_token: deviceToken, p_cash_tips: cashTips });
  if (error){ alert(error.message); return; }
  await loadScheduleData();
};

// ---- Shared-terminal kiosk: clock a DIFFERENT employee in/out by their own PIN, independent
// of whichever account the browser itself is signed into (e.g. a manager stays logged into the
// front-desk PC all shift, and each employee walks up, picks their name, and punches themselves).
window.kioskPunch = async function(){
  const staffId = document.getElementById('kioskEmployee')?.value;
  const pinInput = document.getElementById('kioskPin');
  const pin = pinInput?.value;
  if (!staffId){ alert('Select an employee.'); return; }
  if (!pin){ alert('Enter a PIN.'); return; }
  const deviceToken = localStorage.getItem(TERMINAL_TOKEN_KEY);
  const openEntry = state.timeClockEntries.find(e => e.staff_id === staffId && !e.clock_out_at);
  if (openEntry){
    const cashTipsInput = prompt(`Card tips this shift: $${Number(openEntry.computed_card_tips||0).toFixed(2)} (tracked automatically once Payments is live — nothing to enter for that part).\n\nCash tips received this shift ($):`, '0');
    if (cashTipsInput === null) return;
    const cashTips = Number(cashTipsInput);
    if (isNaN(cashTips) || cashTips < 0){ alert('Enter a valid dollar amount.'); return; }
    const { error } = await sb.rpc('punch_clock_out_for', { p_target_staff_id: staffId, p_pin: pin, p_device_token: deviceToken, p_cash_tips: cashTips });
    if (error){ alert(error.message); return; }
  } else {
    const now = getNow();
    const today = todayISO();
    const todaysShifts = state.scheduleShifts.filter(s => s.staff_id === staffId && s.shift_date === today && s.published);
    let shift = todaysShifts.find(s => now.getTime() >= new Date(today+'T'+s.scheduled_start).getTime() - 10*60000) || todaysShifts[0];
    if (!shift){
      if (!confirm('No scheduled shift found for this employee today — clock in anyway?')) return;
    } else {
      const start = new Date(today+'T'+shift.scheduled_start);
      if (now.getTime() < start.getTime() - 10*60000){
        alert(`Too early — this employee's shift starts at ${fmtTime(shift.scheduled_start)}.`);
        return;
      }
    }
    const status = shift && now.getTime() > new Date(today+'T'+shift.scheduled_start).getTime() ? 'late' : 'on_time';
    const { error } = await sb.rpc('punch_clock_in_for', { p_target_staff_id: staffId, p_pin: pin, p_device_token: deviceToken, p_shift_id: shift?.id || null, p_status: status });
    if (error){ alert(error.message); return; }
  }
  if (pinInput) pinInput.value = '';
  await loadScheduleData();
};
window.kioskUpdateButtonLabel = function(){
  const staffId = document.getElementById('kioskEmployee')?.value;
  const btn = document.getElementById('kioskPunchBtn');
  if (!btn) return;
  const openEntry = state.timeClockEntries.find(e => e.staff_id === staffId && !e.clock_out_at);
  btn.textContent = openEntry ? 'Clock Out' : 'Clock In';
  btn.className = 'btn ' + (openEntry ? 'btn-danger' : 'btn-primary');
};

window.openTimeOffModal = function(){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Request Time Off</h3>
    <div class="formgrid">
      <div><label class="field-label">Start date</label><input type="date" class="modal-input" id="toStart" value="${todayISO()}"/></div>
      <div><label class="field-label">End date</label><input type="date" class="modal-input" id="toEnd" value="${todayISO()}"/></div>
    </div>
    <label class="field-label">Reason (optional)</label>
    <input type="text" class="modal-input" id="toReason"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="submitTimeOff()">Submit</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.submitTimeOff = async function(){
  const start = document.getElementById('toStart').value;
  const end = document.getElementById('toEnd').value;
  const reason = document.getElementById('toReason').value.trim();
  if (!start || !end || end < start){ alert('Enter a valid date range.'); return; }
  const { error } = await sb.from('time_off_requests').insert({ staff_id: currentStaff.id, start_date: start, end_date: end, reason: reason || null });
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await loadScheduleData();
};
window.decideTimeOff = async function(id, status){
  await sb.from('time_off_requests').update({ status, decided_by: currentStaff.id, decided_at: new Date().toISOString() }).eq('id', id);
  await loadScheduleData();
};

window.openShiftModal = function(){
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Add Shift</h3>
    <label class="field-label">Employee</label>
    <select class="modal-select" id="shStaff">${state.staffList.filter(s=>s.active).map(s=>`<option value="${s.id}">${esc(s.name)} (${esc(s.role)})</option>`).join('')}</select>
    <div class="formgrid">
      <div><label class="field-label">Date</label><input type="date" class="modal-input" id="shDate" value="${todayISO()}"/></div>
      <div><label class="field-label">Role for this shift (optional)</label><input type="text" class="modal-input" id="shRole" placeholder="Defaults to their normal role"/></div>
    </div>
    <div class="formgrid">
      <div><label class="field-label">Start time</label><select class="modal-select" id="shStart">${timeOptionsHtml('17:00')}</select></div>
      <div><label class="field-label">End time</label><select class="modal-select" id="shEnd">${timeOptionsHtml('23:00')}</select></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:10px 0;"><input type="checkbox" id="shPublished"/> Publish immediately (otherwise saved as a draft only visible here)</label>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveShift()">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.saveShift = async function(){
  const staffId = document.getElementById('shStaff').value;
  const date = document.getElementById('shDate').value;
  const role = document.getElementById('shRole').value.trim();
  const start = document.getElementById('shStart').value;
  const end = document.getElementById('shEnd').value;
  const published = document.getElementById('shPublished').checked;
  const conflict = state.timeOffRequests.find(r => r.staff_id === staffId && r.status === 'approved' && date >= r.start_date && date <= r.end_date);
  if (conflict){
    const st = state.staffList.find(s=>s.id===staffId);
    if (!confirm(`${st?.name||'This employee'} has approved time off covering ${date}${conflict.reason?' ('+conflict.reason+')':''}. Schedule them anyway?`)) return;
  }
  const { error } = await sb.from('schedule_shifts').insert({ staff_id: staffId, shift_date: date, scheduled_start: start, scheduled_end: end, shift_role: role || null, published, created_by: currentStaff.id });
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await loadScheduleData();
};
window.publishShift = async function(id){
  await sb.from('schedule_shifts').update({ published: true }).eq('id', id);
  await loadScheduleData();
};
window.deleteShift = async function(id){
  if (!confirm('Delete this shift?')) return;
  await sb.from('schedule_shifts').delete().eq('id', id);
  await loadScheduleData();
};

window.correctMissingPunch = async function(shiftId){
  const shift = state.scheduleShifts.find(s => s.id === shiftId);
  if (!shift) return;
  const entry = state.timeClockEntries.find(e => e.shift_id === shiftId);
  const correctedTime = prompt(`Corrected clock-out time (HH:MM, 24-hour) for ${fmtDateHuman(shift.shift_date)}:`, shift.scheduled_end.slice(0,5));
  if (!correctedTime) return;
  const note = prompt('Note explaining this correction (required):');
  if (!note || !note.trim()){ alert('A note is required for any timecard correction.'); return; }
  const clockOutIso = new Date(shift.shift_date+'T'+correctedTime+':00').toISOString();
  if (entry){
    await sb.from('time_clock_entries').update({ clock_out_at: clockOutIso, status:'manager_corrected', corrected_by: currentStaff.id, correction_note: note.trim() }).eq('id', entry.id);
  } else {
    const clockInTime = prompt('No clock-in was recorded either — corrected clock-in time (HH:MM):', shift.scheduled_start.slice(0,5));
    if (!clockInTime) return;
    await sb.from('time_clock_entries').insert({
      staff_id: shift.staff_id, shift_id: shift.id,
      clock_in_at: new Date(shift.shift_date+'T'+clockInTime+':00').toISOString(),
      clock_out_at: clockOutIso, status:'manager_corrected', corrected_by: currentStaff.id, correction_note: note.trim(),
    });
  }
  await loadScheduleData();
};

// ============================================================================
// SETTINGS TAB (tables, service periods, staff)
// ============================================================================
// ============================================================================
// MENU, INGREDIENTS & TICKET DESTINATIONS (Phase 4)
// ============================================================================
function ticketDestName(id){ return state.ticketDestinations.find(t=>t.id===id)?.name || '—'; }
function menuCategoryName(id){ return state.menuCategories.find(c=>c.id===id)?.name || '—'; }
function itemCost(itemId){
  return state.itemIngredients.filter(ii=>ii.item_id===itemId).reduce((sum,ii) => {
    const ing = state.ingredients.find(x=>x.id===ii.ingredient_id);
    return sum + (ing ? ing.cost_per_unit * ii.quantity : 0);
  }, 0);
}
async function reloadMenuData(){
  const [tdRes, icRes, ingRes, mcRes, miRes, iiRes, mgRes, moRes, mimgRes] = await Promise.all([
    sb.from('ticket_destinations').select('*').order('sort_order'),
    sb.from('ingredient_categories').select('*').order('sort_order'),
    sb.from('ingredients').select('*').order('name'),
    sb.from('menu_categories').select('*').order('sort_order'),
    sb.from('menu_items').select('*').order('sort_order'),
    sb.from('item_ingredients').select('*'),
    sb.from('modifier_groups').select('*').order('name'),
    sb.from('modifier_options').select('*').order('sort_order'),
    sb.from('menu_item_modifier_groups').select('*'),
  ]);
  state.ticketDestinations = tdRes.data || [];
  state.ingredientCategories = icRes.data || [];
  state.ingredients = ingRes.data || [];
  state.menuCategories = mcRes.data || [];
  state.menuItems = miRes.data || [];
  state.itemIngredients = iiRes.data || [];
  state.modifierGroups = mgRes.data || [];
  state.modifierOptions = moRes.data || [];
  state.menuItemModifierGroups = mimgRes.data || [];
  render();
}

function renderMenuSection(){
  const canCost = can('manage_ingredients_costing');
  return `
  <div class="section-heading">Ticket Destinations</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Where a printed ticket for an item goes — Kitchen, Main Bar, Secret Bar, or any station you add. Assign one to each menu item below.</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
      ${state.ticketDestinations.map(td => `<span class="area-chip" style="cursor:default">${esc(td.name)} <span class="linkBtn" style="cursor:pointer;color:var(--danger);margin-left:4px" onclick="deleteTicketDestination('${td.id}')">×</span></span>`).join('') || '<span class="panel-sub" style="margin:0">None yet.</span>'}
    </div>
    <div style="display:flex;gap:8px">
      <input type="text" class="modal-input" style="margin:0" id="newTicketDest" placeholder="e.g. Waiter Station"/>
      <button class="btn btn-secondary btn-sm" onclick="addTicketDestination()">Add</button>
    </div>
  </div>

  <div class="section-heading">Menu Categories</div>
  <div class="card">
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
      ${state.menuCategories.map(c => `<span class="area-chip" style="cursor:default">${esc(c.name)} <span class="linkBtn" style="cursor:pointer;color:var(--danger);margin-left:4px" onclick="deleteMenuCategory('${c.id}')">×</span></span>`).join('') || '<span class="panel-sub" style="margin:0">None yet.</span>'}
    </div>
    <div style="display:flex;gap:8px">
      <input type="text" class="modal-input" style="margin:0" id="newMenuCategory" placeholder="e.g. Small Plates"/>
      <button class="btn btn-secondary btn-sm" onclick="addMenuCategory()">Add</button>
    </div>
  </div>

  <div class="section-heading">Menu Items</div>
  <div class="card">
    <table class="data-table">
      <thead><tr><th>Item</th><th>Category</th><th>Price</th>${canCost?'<th>Cost</th><th>Margin</th>':''}<th>Goes To</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.menuItems.map(it => {
          const cost = itemCost(it.id);
          const margin = it.price - cost;
          return `<tr>
            <td>${esc(it.name)}</td>
            <td>${esc(menuCategoryName(it.category_id))}</td>
            <td>$${Number(it.price).toFixed(2)}</td>
            ${canCost?`<td>$${cost.toFixed(2)}</td><td>$${margin.toFixed(2)}</td>`:''}
            <td>${esc(ticketDestName(it.ticket_destination_id))}</td>
            <td>${it.active?'<span class="badge badge-confirmed">active</span>':'<span class="badge badge-pending">hidden</span>'}</td>
            <td><button class="btn btn-sm btn-secondary" onclick="openMenuItemModal('${it.id}')">Edit</button></td>
          </tr>`;
        }).join('') || `<tr><td colspan="${canCost?7:5}"><span class="panel-sub">No menu items yet.</span></td></tr>`}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="openMenuItemModal()">+ Add Menu Item</button></div>
  </div>

  <div class="section-heading">Modifier Groups</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Reusable option sets like "Temperature" or "Add-ons" — attach any group to a menu item from that item's edit screen.</div>
    ${state.modifierGroups.map(g => {
      const opts = state.modifierOptions.filter(o=>o.group_id===g.id);
      return `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
        <span><b>${esc(g.name)}</b> (${g.required?'required, ':''}${g.min_select}-${g.max_select} select) — ${opts.map(o=>esc(o.name)+(o.price_delta?` (+$${Number(o.price_delta).toFixed(2)})`:'')).join(', ') || 'no options yet'}</span>
        <span style="display:flex;gap:6px"><button class="btn btn-sm btn-secondary" onclick="openModifierGroupModal('${g.id}')">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteModifierGroup('${g.id}')">Delete</button></span>
      </div>`;
    }).join('') || '<div class="panel-sub" style="margin:0 0 10px">No modifier groups yet.</div>'}
    <div class="modal-actions" style="padding-top:10px;justify-content:flex-start"><button class="btn btn-secondary btn-sm" onclick="openModifierGroupModal()">+ New Modifier Group</button></div>
  </div>`;
}

window.addTicketDestination = async function(){
  const input = document.getElementById('newTicketDest');
  const name = input.value.trim();
  if (!name) return;
  const { error } = await sb.from('ticket_destinations').insert({ name, sort_order: state.ticketDestinations.length });
  if (error){ alert('Error: '+error.message); return; }
  input.value = '';
  await reloadMenuData();
};
window.deleteTicketDestination = async function(id){
  if (!confirm('Delete this ticket destination? Any item using it will show "—" until reassigned.')) return;
  await sb.from('ticket_destinations').delete().eq('id', id);
  await reloadMenuData();
};
window.addMenuCategory = async function(){
  const input = document.getElementById('newMenuCategory');
  const name = input.value.trim();
  if (!name) return;
  const { error } = await sb.from('menu_categories').insert({ name, sort_order: state.menuCategories.length });
  if (error){ alert('Error: '+error.message); return; }
  input.value = '';
  await reloadMenuData();
};
window.deleteMenuCategory = async function(id){
  if (!confirm('Delete this category? Items in it will show "—" until reassigned.')) return;
  await sb.from('menu_categories').delete().eq('id', id);
  await reloadMenuData();
};

function renderRecipeRow(ingredientId, qty){
  return `<div style="display:flex;gap:6px;align-items:center" class="miRecipeRow">
    <select class="modal-select miRecipeIngredient" style="margin:0;flex:1" onchange="recalcMenuItemCost()">${state.ingredients.map(ing=>`<option value="${ing.id}" ${ing.id===ingredientId?'selected':''}>${esc(ing.name)} (${esc(ing.unit)})</option>`).join('')}</select>
    <input type="number" min="0" step="0.01" class="modal-input miRecipeQty" style="margin:0;width:80px" value="${qty??0}" oninput="recalcMenuItemCost()"/>
    <button type="button" class="btn btn-sm btn-danger" onclick="this.closest('.miRecipeRow').remove(); recalcMenuItemCost();">×</button>
  </div>`;
}
window.addRecipeRow = function(){
  if (!state.ingredients.length){ alert('Add ingredients first (Ingredients &amp; Costing section).'); return; }
  document.getElementById('miRecipeRows').insertAdjacentHTML('beforeend', renderRecipeRow(state.ingredients[0].id, 0));
  recalcMenuItemCost();
};
// Live-updates the cost/margin readout under the recipe builder as ingredients, quantities,
// or the menu price change — before anything is saved, so pricing decisions happen up front.
window.recalcMenuItemCost = function(){
  const summaryEl = document.getElementById('miCostSummary');
  if (!summaryEl) return;
  const rows = Array.from(document.querySelectorAll('#miRecipeRows .miRecipeRow'));
  const cost = rows.reduce((sum, row) => {
    const ing = state.ingredients.find(x => x.id === row.querySelector('.miRecipeIngredient').value);
    const qty = parseFloat(row.querySelector('.miRecipeQty').value) || 0;
    return sum + (ing ? ing.cost_per_unit * qty : 0);
  }, 0);
  const price = parseFloat(document.getElementById('miPrice')?.value) || 0;
  const margin = price - cost;
  const marginPct = price > 0 ? (margin / price) * 100 : null;
  summaryEl.innerHTML = `Ingredient cost: <strong>$${cost.toFixed(2)}</strong>`
    + (price > 0 ? ` &nbsp;·&nbsp; Margin: <strong style="color:${margin>=0?'var(--success)':'var(--danger)'}">$${margin.toFixed(2)}${marginPct!=null?' ('+marginPct.toFixed(0)+'%)':''}</strong>` : '');
};
window.openMenuItemModal = function(itemId){
  const it = itemId ? state.menuItems.find(x=>x.id===itemId) : null;
  const canCost = can('manage_ingredients_costing');
  const recipe = it ? state.itemIngredients.filter(ii=>ii.item_id===it.id) : [];
  const myGroupIds = it ? new Set(state.menuItemModifierGroups.filter(x=>x.item_id===it.id).map(x=>x.group_id)) : new Set();
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${it?'Edit':'New'} Menu Item</h3>
    <label class="field-label">Name</label>
    <input type="text" class="modal-input" id="miName" value="${it?esc(it.name):''}"/>
    <div class="formgrid">
      <div><label class="field-label">Category</label><select class="modal-select" id="miCategory"><option value="">—</option>${state.menuCategories.map(c=>`<option value="${c.id}" ${it?.category_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label class="field-label">Ticket Destination</label><select class="modal-select" id="miDest"><option value="">—</option>${state.ticketDestinations.map(td=>`<option value="${td.id}" ${it?.ticket_destination_id===td.id?'selected':''}>${esc(td.name)}</option>`).join('')}</select></div>
    </div>
    <div class="formgrid">
      <div><label class="field-label">Price ($)</label><input type="number" min="0" step="0.01" class="modal-input" id="miPrice" value="${it?it.price:'0'}" oninput="recalcMenuItemCost()"/></div>
      <div><label class="field-label" style="display:flex;align-items:center;gap:6px;margin-top:22px"><input type="checkbox" id="miActive" ${it?(it.active?'checked':''):'checked'}/> Active / visible</label></div>
    </div>
    <label class="field-label">Description (optional)</label>
    <input type="text" class="modal-input" id="miDesc" value="${it?esc(it.description||''):''}"/>
    <label class="field-label" style="display:flex;align-items:center;gap:6px;margin-top:10px">
      <input type="checkbox" id="miLoyaltyEligible" ${it?.loyalty_eligible?'checked':''}/> Counts toward membership free drink
    </label>
    <label class="field-label" style="margin-top:10px">Course</label>
    <select class="modal-select" id="miCourse">
      <option value="" ${!it?.course?'selected':''}>No course — fires immediately</option>
      <option value="1" ${it?.course===1?'selected':''}>1 — Appetizer (fires first)</option>
      <option value="2" ${it?.course===2?'selected':''}>2 — Main (held until apps are fired)</option>
      <option value="3" ${it?.course===3?'selected':''}>3 — Dessert (held until fired)</option>
    </select>
    <div class="panel-sub" style="margin:2px 0 0">Course 2+ items are held back when the check is sent — use "Send to Kitchen/Bar" for apps, then a separate button releases the held items when you're ready.</div>
    ${canCost ? `
    <label class="field-label">Recipe / Ingredient Costing</label>
    <div id="miRecipeRows" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
      ${recipe.map(r => renderRecipeRow(r.ingredient_id, r.quantity)).join('')}
    </div>
    <button type="button" class="btn btn-secondary btn-sm" onclick="addRecipeRow()">+ Add Ingredient</button>
    <div class="panel-sub" id="miCostSummary" style="margin:8px 0 0"></div>
    ` : ''}
    <label class="field-label" style="margin-top:10px">Modifier Groups</label>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px">
      ${state.modifierGroups.map(g => `<label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" class="miModGroupChk" value="${g.id}" ${myGroupIds.has(g.id)?'checked':''}/> ${esc(g.name)}</label>`).join('') || '<span class="panel-sub" style="margin:0">No modifier groups defined yet.</span>'}
    </div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      ${it ? `<button class="modal-btn modal-btn-danger" onclick="deleteMenuItem('${it.id}')">Delete</button>` : ''}
      <button class="modal-btn modal-btn-primary" onclick="saveMenuItem(${it?`'${it.id}'`:'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
  if (canCost) recalcMenuItemCost();
};
window.saveMenuItem = async function(itemId){
  const name = document.getElementById('miName').value.trim();
  if (!name){ alert('Enter a name.'); return; }
  const category_id = document.getElementById('miCategory').value || null;
  const ticket_destination_id = document.getElementById('miDest').value || null;
  const price = parseFloat(document.getElementById('miPrice').value) || 0;
  const active = document.getElementById('miActive').checked;
  const description = document.getElementById('miDesc').value.trim() || null;
  const loyalty_eligible = document.getElementById('miLoyaltyEligible').checked;
  const course = document.getElementById('miCourse').value ? parseInt(document.getElementById('miCourse').value) : null;
  let id = itemId;
  if (id){
    const { error } = await sb.from('menu_items').update({ name, category_id, ticket_destination_id, price, active, description, loyalty_eligible, course }).eq('id', id);
    if (error){ alert('Error: '+error.message); return; }
  } else {
    const { data, error } = await sb.from('menu_items').insert({ name, category_id, ticket_destination_id, price, active, description, loyalty_eligible, course, sort_order: state.menuItems.length }).select().single();
    if (error){ alert('Error: '+error.message); return; }
    id = data.id;
  }
  if (can('manage_ingredients_costing')){
    await sb.from('item_ingredients').delete().eq('item_id', id);
    const rows = Array.from(document.querySelectorAll('#miRecipeRows .miRecipeRow')).map(row => ({
      item_id: id,
      ingredient_id: row.querySelector('.miRecipeIngredient').value,
      quantity: parseFloat(row.querySelector('.miRecipeQty').value) || 0,
    })).filter(r => r.ingredient_id);
    if (rows.length) await sb.from('item_ingredients').insert(rows);
  }
  await sb.from('menu_item_modifier_groups').delete().eq('item_id', id);
  const groupIds = Array.from(document.querySelectorAll('.miModGroupChk:checked')).map(el=>el.value);
  if (groupIds.length) await sb.from('menu_item_modifier_groups').insert(groupIds.map(gid => ({ item_id: id, group_id: gid })));
  closeModal('formModal');
  await reloadMenuData();
};
window.deleteMenuItem = async function(id){
  if (!confirm('Delete this menu item?')) return;
  await sb.from('menu_items').delete().eq('id', id);
  closeModal('formModal');
  await reloadMenuData();
};

window.openModifierGroupModal = function(groupId){
  const g = groupId ? state.modifierGroups.find(x=>x.id===groupId) : null;
  const opts = g ? state.modifierOptions.filter(o=>o.group_id===g.id) : [];
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${g?'Edit':'New'} Modifier Group</h3>
    <label class="field-label">Group name</label>
    <input type="text" class="modal-input" id="mgName" value="${g?esc(g.name):''}" placeholder="e.g. Temperature, Add-ons"/>
    <div class="formgrid">
      <div><label class="field-label">Min select</label><input type="number" min="0" class="modal-input" id="mgMin" value="${g?g.min_select:0}"/></div>
      <div><label class="field-label">Max select</label><input type="number" min="1" class="modal-input" id="mgMax" value="${g?g.max_select:1}"/></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0"><input type="checkbox" id="mgRequired" ${g?.required?'checked':''}/> Required</label>
    <label class="field-label">Options (one per line — "Name" or "Name, +1.50" for a price add-on)</label>
    <textarea class="modal-input" id="mgOptions" rows="4" style="resize:vertical">${opts.map(o=>o.price_delta?`${o.name}, +${o.price_delta}`:o.name).join('\n')}</textarea>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveModifierGroup(${g?`'${g.id}'`:'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.saveModifierGroup = async function(groupId){
  const name = document.getElementById('mgName').value.trim();
  if (!name){ alert('Enter a group name.'); return; }
  const min_select = parseInt(document.getElementById('mgMin').value) || 0;
  const max_select = parseInt(document.getElementById('mgMax').value) || 1;
  const required = document.getElementById('mgRequired').checked;
  const lines = document.getElementById('mgOptions').value.split('\n').map(l=>l.trim()).filter(Boolean);
  let id = groupId;
  if (id){
    const { error } = await sb.from('modifier_groups').update({ name, min_select, max_select, required }).eq('id', id);
    if (error){ alert('Error: '+error.message); return; }
    await sb.from('modifier_options').delete().eq('group_id', id);
  } else {
    const { data, error } = await sb.from('modifier_groups').insert({ name, min_select, max_select, required }).select().single();
    if (error){ alert('Error: '+error.message); return; }
    id = data.id;
  }
  const optionRows = lines.map((line, i) => {
    const [namePart, priceStr] = line.split(',').map(s=>s?.trim());
    const price_delta = priceStr ? parseFloat(priceStr.replace('+','')) || 0 : 0;
    return { group_id: id, name: namePart, price_delta, sort_order: i };
  });
  if (optionRows.length){
    const { error: optErr } = await sb.from('modifier_options').insert(optionRows);
    if (optErr){ alert('Group saved, but options failed: '+optErr.message); }
  }
  closeModal('formModal');
  await reloadMenuData();
};
window.deleteModifierGroup = async function(id){
  if (!confirm('Delete this modifier group and its options?')) return;
  await sb.from('modifier_options').delete().eq('group_id', id);
  await sb.from('menu_item_modifier_groups').delete().eq('group_id', id);
  const { error } = await sb.from('modifier_groups').delete().eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await reloadMenuData();
};

function renderIngredientsSection(){
  return `
  <div class="section-heading">Ingredient Categories</div>
  <div class="card">
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
      ${state.ingredientCategories.map(c => `<span class="area-chip" style="cursor:default">${esc(c.name)} <span class="linkBtn" style="cursor:pointer;color:var(--danger);margin-left:4px" onclick="deleteIngredientCategory('${c.id}')">×</span></span>`).join('') || '<span class="panel-sub" style="margin:0">None yet.</span>'}
    </div>
    <div style="display:flex;gap:8px">
      <input type="text" class="modal-input" style="margin:0" id="newIngCategory" placeholder="e.g. Spirits"/>
      <button class="btn btn-secondary btn-sm" onclick="addIngredientCategory()">Add</button>
    </div>
  </div>

  <div class="section-heading">Ingredients &amp; Costing</div>
  <div class="card">
    <table class="data-table">
      <thead><tr><th>Ingredient</th><th>Brand</th><th>Category</th><th>Unit</th><th>ABV</th><th>Package</th><th>Cost / Unit</th><th></th></tr></thead>
      <tbody>
        ${state.ingredients.map(ing => `<tr>
          <td>${esc(ing.name)}</td>
          <td>${esc(ing.brand||'—')}</td>
          <td>${esc(state.ingredientCategories.find(c=>c.id===ing.category_id)?.name || '—')}</td>
          <td>${esc(ing.unit)}</td>
          <td>${ing.abv_percent!=null ? ing.abv_percent+'%' : '—'}</td>
          <td>${ing.package_label ? `${esc(ing.package_label)}${ing.package_cost!=null?' · $'+Number(ing.package_cost).toFixed(2):''}` : '<span class="panel-sub" style="margin:0">not set</span>'}</td>
          <td>$<input type="number" min="0" step="0.01" class="modal-input" style="margin:0;width:80px;padding:4px 8px;display:inline-block" value="${ing.cost_per_unit}" onchange="setIngredientCost('${ing.id}', this.value)"/></td>
          <td style="display:flex;gap:6px"><button class="btn btn-sm btn-secondary" onclick="openIngredientModal('${ing.id}')">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteIngredient('${ing.id}')">Delete</button></td>
        </tr>`).join('') || `<tr><td colspan="8"><span class="panel-sub">No ingredients yet.</span></td></tr>`}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="openIngredientModal()">+ Add Ingredient</button></div>
  </div>`;
}
const INGREDIENT_UNIT_GROUPS = {
  'Bar / Cocktail': ['oz','dash','splash','barspoon','part','cube','sprig','wedge','twist','slice'],
  'Volume': ['ml','l','cup','tbsp','tsp','pint','quart','gallon'],
  'Weight': ['g','kg','lb'],
  'Count': ['each','bottle','can','case','bunch'],
};
function ingredientUnitSelectHtml(selected){
  const flat = Object.values(INGREDIENT_UNIT_GROUPS).flat();
  const customOpt = selected && !flat.includes(selected) ? `<option value="${esc(selected)}" selected>${esc(selected)} (custom)</option>` : '';
  return customOpt + Object.entries(INGREDIENT_UNIT_GROUPS).map(([label, units]) =>
    `<optgroup label="${esc(label)}">${units.map(u=>`<option value="${u}" ${u===selected?'selected':''}>${u}</option>`).join('')}</optgroup>`
  ).join('');
}
// Standard liquor bottle sizes, pre-converted to fl oz, for the quick-fill buttons in the
// ingredient modal — lets someone costing out a bottle skip doing the ml→oz math by hand.
const BOTTLE_SIZES_OZ = [
  { label: '50ml', oz: 1.69 }, { label: '200ml', oz: 6.76 }, { label: '375ml', oz: 12.68 },
  { label: '750ml', oz: 25.36 }, { label: '1L', oz: 33.81 }, { label: '1.75L', oz: 59.18 },
];
window.fillBottleSize = function(oz){
  const yieldInput = document.getElementById('ingPkgYield');
  if (yieldInput){ yieldInput.value = oz; recalcIngredientCost(); }
};
// Package cost ÷ package yield = cost per recipe unit. Recomputes live as the manager types,
// and only overwrites the Cost/Unit field while package fields are actually in use — clearing
// them leaves Cost/Unit as a plain manually-entered number, same as before this feature existed.
window.recalcIngredientCost = function(){
  const unit = document.getElementById('ingUnit')?.value || 'oz';
  const yieldUnitLabel = document.getElementById('ingPkgYieldUnit');
  if (yieldUnitLabel) yieldUnitLabel.textContent = unit;
  const bottleSizes = document.getElementById('ingBottleSizes');
  if (bottleSizes) bottleSizes.style.display = unit === 'oz' ? 'flex' : 'none';
  const costInput = document.getElementById('ingCost');
  const pkgCost = parseFloat(document.getElementById('ingPkgCost')?.value);
  const pkgYield = parseFloat(document.getElementById('ingPkgYield')?.value);
  const preview = document.getElementById('ingPkgCostPreview');
  if (!isNaN(pkgCost) && !isNaN(pkgYield) && pkgYield > 0){
    const perUnit = pkgCost / pkgYield;
    costInput.value = perUnit.toFixed(4).replace(/0+$/,'').replace(/\.$/,'') || '0';
    if (preview) preview.textContent = `= $${perUnit.toFixed(4)} per ${unit}`;
  } else if (preview) preview.textContent = '';
};
window.addIngredientCategory = async function(){
  const input = document.getElementById('newIngCategory');
  const name = input.value.trim();
  if (!name) return;
  const { error } = await sb.from('ingredient_categories').insert({ name, sort_order: state.ingredientCategories.length });
  if (error){ alert('Error: '+error.message); return; }
  input.value = '';
  await reloadMenuData();
};
window.deleteIngredientCategory = async function(id){
  if (!confirm('Delete this category?')) return;
  await sb.from('ingredient_categories').delete().eq('id', id);
  await reloadMenuData();
};
window.openIngredientModal = function(ingredientId){
  const ing = ingredientId ? state.ingredients.find(x=>x.id===ingredientId) : null;
  const unit = ing?.unit || 'oz';
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${ing ? 'Edit' : 'Add'} Ingredient</h3>
    <label class="field-label">Name</label>
    <input type="text" class="modal-input" id="ingName" value="${esc(ing?.name||'')}"/>
    <label class="field-label">Brand</label>
    <input type="text" class="modal-input" id="ingBrand" value="${esc(ing?.brand||'')}" placeholder="e.g. Tito's, Heinz…"/>
    <div class="formgrid">
      <div><label class="field-label">Category</label><select class="modal-select" id="ingCategory"><option value="">—</option>${state.ingredientCategories.map(c=>`<option value="${c.id}" ${ing?.category_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label class="field-label">Unit</label><select class="modal-select" id="ingUnit" onchange="recalcIngredientCost()">${ingredientUnitSelectHtml(unit)}</select></div>
    </div>
    <label class="field-label">ABV % <span class="panel-sub" style="margin:0">(alcoholic ingredients only — leave blank otherwise)</span></label>
    <input type="number" min="0" max="100" step="0.1" class="modal-input" id="ingAbv" value="${ing?.abv_percent!=null?ing.abv_percent:''}" placeholder="e.g. 40"/>

    <div class="section-heading" style="margin-top:4px">Price by the Package</div>
    <p class="panel-sub" style="margin:0 0 8px">Enter what you actually bought — a bottle, a case, a lemon — and its cost. Cost per unit below is calculated for you.</p>
    <label class="field-label">Package <span class="panel-sub" style="margin:0">(e.g. "750ml bottle", "Case of 24", "1 lemon")</span></label>
    <input type="text" class="modal-input" id="ingPkgLabel" value="${esc(ing?.package_label||'')}" placeholder="750ml bottle"/>
    <div class="formgrid">
      <div><label class="field-label">Package cost ($)</label><input type="number" min="0" step="0.01" class="modal-input" id="ingPkgCost" value="${ing?.package_cost!=null?ing.package_cost:''}" oninput="recalcIngredientCost()"/></div>
      <div><label class="field-label">Package yield (<span id="ingPkgYieldUnit">${esc(unit)}</span>)</label><input type="number" min="0" step="0.01" class="modal-input" id="ingPkgYield" value="${ing?.package_yield!=null?ing.package_yield:''}" oninput="recalcIngredientCost()"/></div>
    </div>
    <div id="ingBottleSizes" style="display:${unit==='oz'?'flex':'none'};flex-wrap:wrap;gap:6px;margin:-6px 0 10px">${BOTTLE_SIZES_OZ.map(b=>`<button type="button" class="btn btn-secondary btn-sm" onclick="fillBottleSize(${b.oz})">${b.label}</button>`).join('')}</div>
    <div class="panel-sub" id="ingPkgCostPreview" style="margin:-4px 0 10px;min-height:16px"></div>

    <label class="field-label">Cost per unit ($) <span class="panel-sub" style="margin:0">(auto-filled from package above, or enter directly)</span></label>
    <input type="number" min="0" step="0.0001" class="modal-input" id="ingCost" value="${ing?.cost_per_unit!=null?ing.cost_per_unit:0}"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveIngredient('${ingredientId||''}')">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
  recalcIngredientCost();
};
window.saveIngredient = async function(ingredientId){
  const name = document.getElementById('ingName').value.trim();
  if (!name){ alert('Enter a name.'); return; }
  const brand = document.getElementById('ingBrand').value.trim() || null;
  const category_id = document.getElementById('ingCategory').value || null;
  const unit = document.getElementById('ingUnit').value || 'oz';
  const abvRaw = document.getElementById('ingAbv').value.trim();
  const abv_percent = abvRaw === '' ? null : parseFloat(abvRaw);
  if (abv_percent!=null && (isNaN(abv_percent) || abv_percent<0 || abv_percent>100)){ alert('ABV must be between 0 and 100.'); return; }
  const package_label = document.getElementById('ingPkgLabel').value.trim() || null;
  const pkgCostRaw = document.getElementById('ingPkgCost').value.trim();
  const pkgYieldRaw = document.getElementById('ingPkgYield').value.trim();
  const package_cost = pkgCostRaw === '' ? null : parseFloat(pkgCostRaw);
  const package_yield = pkgYieldRaw === '' ? null : parseFloat(pkgYieldRaw);
  if (package_cost!=null && (isNaN(package_cost) || package_cost<0)){ alert('Package cost must be a positive number.'); return; }
  if (package_yield!=null && (isNaN(package_yield) || package_yield<=0)){ alert('Package yield must be greater than 0.'); return; }
  const cost_per_unit = parseFloat(document.getElementById('ingCost').value) || 0;
  const payload = { name, brand, category_id, unit, abv_percent, package_label, package_cost, package_yield, cost_per_unit };
  const { error } = ingredientId
    ? await sb.from('ingredients').update(payload).eq('id', ingredientId)
    : await sb.from('ingredients').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadMenuData();
};
window.setIngredientCost = async function(id, value){
  const cost_per_unit = parseFloat(value) || 0;
  await sb.from('ingredients').update({ cost_per_unit }).eq('id', id);
  await reloadMenuData();
};
window.deleteIngredient = async function(id){
  if (!confirm('Delete this ingredient? It will be removed from any recipes using it.')) return;
  await sb.from('ingredients').delete().eq('id', id);
  await reloadMenuData();
};

// ============================================================================
// INVENTORY, VENDORS & PURCHASE ORDERS (Phase 10)
// Stock deducts automatically when an item is marked delivered (server-side
// trigger, using the recipe from Phase 4) and credits automatically when a
// purchase order line's received quantity is recorded — see
// deplete_inventory_on_delivery() / receive_purchase_order_item() in the DB.
// ============================================================================
async function reloadInventoryData(){
  const [{ data: vendors }, { data: pos }, { data: poItems }] = await Promise.all([
    sb.from('vendors').select('*').order('name'),
    sb.from('purchase_orders').select('*').order('created_at', { ascending: false }),
    sb.from('purchase_order_items').select('*'),
  ]);
  state.vendors = vendors || [];
  state.purchaseOrders = pos || [];
  state.purchaseOrderItems = poItems || [];
  render();
}
function renderInventorySection(){
  const lowStock = state.ingredients.filter(ing => ing.reorder_threshold != null && ing.current_stock <= ing.reorder_threshold);
  return `
  <div class="section-heading">Inventory Levels</div>
  <div class="card">
    ${lowStock.length ? `<div class="panel-sub" style="margin-bottom:10px;color:#dc2626">⚠ Low stock: ${lowStock.map(i=>esc(i.name)).join(', ')}</div>` : ''}
    <table class="data-table">
      <thead><tr><th>Ingredient</th><th>On Hand</th><th>Reorder At</th></tr></thead>
      <tbody>
        ${state.ingredients.map(ing => `<tr>
          <td>${esc(ing.name)} <span class="panel-sub" style="margin:0">(${esc(ing.unit)})</span></td>
          <td><input type="number" step="0.01" class="modal-input" style="margin:0;width:90px;padding:4px 8px" value="${ing.current_stock}" onchange="setIngredientStock('${ing.id}', this.value)"/></td>
          <td><input type="number" step="0.01" min="0" class="modal-input" style="margin:0;width:90px;padding:4px 8px" placeholder="none" value="${ing.reorder_threshold ?? ''}" onchange="setIngredientReorderThreshold('${ing.id}', this.value)"/></td>
        </tr>`).join('') || `<tr><td colspan="3"><span class="panel-sub">Add ingredients in the Ingredients &amp; Costing section first.</span></td></tr>`}
      </tbody>
    </table>
  </div>

  <div class="section-heading">Vendors</div>
  <div class="card">
    ${state.vendors.map(v => `<div class="res-meta" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
      <span><b>${esc(v.name)}</b>${v.contact_name?' — '+esc(v.contact_name):''}${v.phone?' · '+esc(v.phone):''}</span>
      <span style="display:flex;gap:6px"><button class="btn btn-sm btn-secondary" onclick="openVendorModal('${v.id}')">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteVendor('${v.id}')">Delete</button></span>
    </div>`).join('') || '<div class="panel-sub" style="margin:0 0 10px">No vendors yet.</div>'}
    <div class="modal-actions" style="padding-top:10px;justify-content:flex-start"><button class="btn btn-secondary btn-sm" onclick="openVendorModal()">+ New Vendor</button></div>
  </div>

  <div class="section-heading">Purchase Orders</div>
  <div class="card">
    <table class="data-table">
      <thead><tr><th>Vendor</th><th>Status</th><th>Items</th><th>Total Cost</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${state.purchaseOrders.map(po => {
          const items = state.purchaseOrderItems.filter(i=>i.po_id===po.id);
          const total = items.reduce((s,i)=>s+i.quantity_ordered*i.unit_cost,0);
          const vendor = state.vendors.find(v=>v.id===po.vendor_id);
          return `<tr>
            <td>${esc(vendor?.name||'—')}</td>
            <td><span class="badge badge-${po.status==='received'?'confirmed':po.status==='cancelled'?'cancelled':'pending'}">${esc(po.status)}</span></td>
            <td>${items.length}</td>
            <td>$${total.toFixed(2)}</td>
            <td>${new Date(po.created_at).toLocaleDateString()}</td>
            <td><button class="btn btn-sm btn-secondary" onclick="openPurchaseOrderModal('${po.id}')">Open</button></td>
          </tr>`;
        }).join('') || `<tr><td colspan="6"><span class="panel-sub">No purchase orders yet.</span></td></tr>`}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="openPurchaseOrderModal()">+ New Purchase Order</button></div>
  </div>`;
}
window.setIngredientStock = async function(id, value){
  const { error } = await sb.from('ingredients').update({ current_stock: parseFloat(value)||0 }).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await reloadMenuData();
};
window.setIngredientReorderThreshold = async function(id, value){
  const reorder_threshold = value === '' ? null : parseFloat(value);
  const { error } = await sb.from('ingredients').update({ reorder_threshold }).eq('id', id);
  if (error){ alert('Error: '+error.message); return; }
  await reloadMenuData();
};
window.openVendorModal = function(vendorId){
  const v = vendorId ? state.vendors.find(x=>x.id===vendorId) : null;
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${v?'Edit':'New'} Vendor</h3>
    <label class="field-label">Name</label>
    <input type="text" class="modal-input" id="vName" value="${v?esc(v.name):''}"/>
    <div class="formgrid">
      <div><label class="field-label">Contact name</label><input type="text" class="modal-input" id="vContact" value="${v?esc(v.contact_name||''):''}"/></div>
      <div><label class="field-label">Phone</label><input type="text" class="modal-input" id="vPhone" value="${v?esc(v.phone||''):''}"/></div>
    </div>
    <label class="field-label">Email</label>
    <input type="text" class="modal-input" id="vEmail" value="${v?esc(v.email||''):''}"/>
    <label class="field-label">Notes</label>
    <input type="text" class="modal-input" id="vNotes" value="${v?esc(v.notes||''):''}"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveVendor(${v?`'${v.id}'`:'null'})">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.saveVendor = async function(vendorId){
  const name = document.getElementById('vName').value.trim();
  if (!name){ alert('Enter a name.'); return; }
  const payload = {
    name,
    contact_name: document.getElementById('vContact').value.trim() || null,
    phone: document.getElementById('vPhone').value.trim() || null,
    email: document.getElementById('vEmail').value.trim() || null,
    notes: document.getElementById('vNotes').value.trim() || null,
  };
  const { error } = vendorId ? await sb.from('vendors').update(payload).eq('id', vendorId) : await sb.from('vendors').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadInventoryData();
};
window.deleteVendor = async function(id){
  if (!confirm('Delete this vendor?')) return;
  await sb.from('vendors').delete().eq('id', id);
  await reloadInventoryData();
};
function renderPoItemRow(item, status){
  const editable = !status || status === 'draft';
  const receiving = status === 'ordered';
  return `<div class="poItemRow" style="display:flex;gap:6px;align-items:center" data-id="${item?.id||''}">
    <select class="modal-select poItemIngredient" style="margin:0;flex:1" ${editable?'':'disabled'}>${state.ingredients.map(ing=>`<option value="${ing.id}" ${item?.ingredient_id===ing.id?'selected':''}>${esc(ing.name)} (${esc(ing.unit)})</option>`).join('')}</select>
    <input type="number" min="0" step="0.01" class="modal-input poItemQty" style="margin:0;width:80px" placeholder="Qty" value="${item?item.quantity_ordered:0}" ${editable?'':'disabled'}/>
    <input type="number" min="0" step="0.01" class="modal-input poItemCost" style="margin:0;width:90px" placeholder="Unit $" value="${item?item.unit_cost:0}" ${editable?'':'disabled'}/>
    ${receiving ? `<input type="number" min="0" step="0.01" class="modal-input poItemReceived" style="margin:0;width:80px" placeholder="Received" value="${item?item.quantity_received:0}"/>` : ''}
    ${editable ? `<button type="button" class="btn btn-sm btn-danger" onclick="this.closest('.poItemRow').remove()">×</button>` : ''}
  </div>`;
}
window.addPoItemRow = function(){
  if (!state.ingredients.length){ alert('Add ingredients first (Ingredients &amp; Costing section).'); return; }
  document.getElementById('poItemRows').insertAdjacentHTML('beforeend', renderPoItemRow(null, 'draft'));
};
window.openPurchaseOrderModal = function(poId){
  const po = poId ? state.purchaseOrders.find(x=>x.id===poId) : null;
  const items = po ? state.purchaseOrderItems.filter(i=>i.po_id===po.id) : [];
  const editable = !po || po.status === 'draft';
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${po?'Purchase Order':'New Purchase Order'}</h3>
    <label class="field-label">Vendor</label>
    <select class="modal-select" id="poVendor" ${editable?'':'disabled'}>
      <option value="">—</option>
      ${state.vendors.map(v=>`<option value="${v.id}" ${po?.vendor_id===v.id?'selected':''}>${esc(v.name)}</option>`).join('')}
    </select>
    <label class="field-label">Notes</label>
    <input type="text" class="modal-input" id="poNotes" value="${po?esc(po.notes||''):''}" ${editable?'':'disabled'}/>
    <label class="field-label" style="margin-top:8px">Line Items</label>
    <div id="poItemRows" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
      ${items.map(i => renderPoItemRow(i, po?.status)).join('')}
    </div>
    ${editable ? `<button type="button" class="btn btn-secondary btn-sm" onclick="addPoItemRow()">+ Add Line</button>` : ''}
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button>
      ${editable ? `<button class="modal-btn modal-btn-primary" onclick="savePurchaseOrder(${po?`'${po.id}'`:'null'})">Save Draft</button>` : ''}
      ${po && po.status==='draft' ? `<button class="modal-btn modal-btn-primary" onclick="markPoOrdered('${po.id}')">Mark Ordered</button>` : ''}
      ${po && po.status==='ordered' ? `<button class="modal-btn modal-btn-primary" onclick="receivePurchaseOrder('${po.id}')">Save Received Quantities</button>` : ''}
      ${po && (po.status==='draft'||po.status==='ordered') ? `<button class="modal-btn modal-btn-danger" onclick="cancelPurchaseOrder('${po.id}')">Cancel PO</button>` : ''}
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};
window.savePurchaseOrder = async function(poId){
  const vendor_id = document.getElementById('poVendor').value || null;
  const notes = document.getElementById('poNotes').value.trim() || null;
  let id = poId;
  if (id){
    const { error } = await sb.from('purchase_orders').update({ vendor_id, notes }).eq('id', id);
    if (error){ alert('Error: '+error.message); return; }
    await sb.from('purchase_order_items').delete().eq('po_id', id);
  } else {
    const { data, error } = await sb.from('purchase_orders').insert({ vendor_id, notes, created_by: currentStaff.id }).select().single();
    if (error){ alert('Error: '+error.message); return; }
    id = data.id;
  }
  const rows = Array.from(document.querySelectorAll('#poItemRows .poItemRow')).map(row => ({
    po_id: id,
    ingredient_id: row.querySelector('.poItemIngredient').value,
    quantity_ordered: parseFloat(row.querySelector('.poItemQty').value) || 0,
    unit_cost: parseFloat(row.querySelector('.poItemCost').value) || 0,
  })).filter(r => r.ingredient_id);
  if (rows.length){
    const { error: itemErr } = await sb.from('purchase_order_items').insert(rows);
    if (itemErr){ alert('PO saved, but line items failed: '+itemErr.message); }
  }
  closeModal('formModal');
  await reloadInventoryData();
};
window.markPoOrdered = async function(poId){
  const { error } = await sb.from('purchase_orders').update({ status: 'ordered', ordered_at: new Date().toISOString() }).eq('id', poId);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadInventoryData();
};
window.receivePurchaseOrder = async function(poId){
  const rows = Array.from(document.querySelectorAll('#poItemRows .poItemRow'));
  for (const row of rows){
    const id = row.dataset.id;
    if (!id) continue;
    const received = parseFloat(row.querySelector('.poItemReceived').value) || 0;
    await sb.from('purchase_order_items').update({ quantity_received: received }).eq('id', id);
  }
  const { error } = await sb.from('purchase_orders').update({ status: 'received', received_at: new Date().toISOString() }).eq('id', poId);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadMenuData(); // ingredient stock changed via trigger — refresh costing/ingredient views too
  await reloadInventoryData();
};
window.cancelPurchaseOrder = async function(poId){
  if (!confirm('Cancel this purchase order?')) return;
  const { error } = await sb.from('purchase_orders').update({ status: 'cancelled' }).eq('id', poId);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadInventoryData();
};

function renderTestingToolsSection(){
  return `
  <div class="section-heading">Testing: Override "Now"</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">For testing off-hours (e.g. checking what a Friday 7pm dinner rush looks like at 3am): make the whole app believe it's a different date/time than your device clock. This affects Today's default date, the Floor Plan's live status view, the Timeline "now" line, waitlist wait counters, and every seated/completed/cancelled timestamp — all without touching any real reservation data. It ticks forward normally from whatever you set, and persists until you clear it, even across a page refresh — a purple banner stays up across the whole app the entire time it's active so it's never accidentally left on.</div>
    <div class="formgrid">
      <div><label class="field-label">Date</label><input type="date" class="modal-input" id="nowOvDate" value="${todayISO()}"/></div>
      <div><label class="field-label">Time</label><select class="modal-select" id="nowOvTime">${timeOptionsHtml(nowHHMM())}</select></div>
    </div>
    <div class="modal-actions" style="padding-top:10px;justify-content:flex-start">
      <button class="btn btn-primary" onclick="setNowOverride(document.getElementById('nowOvDate').value, document.getElementById('nowOvTime').value)">Set Test Time</button>
      ${nowOverride ? `<button class="btn btn-secondary" onclick="clearNowOverride()">Exit Test Mode (use real time)</button>` : ''}
    </div>
  </div>`;
}
function renderFloorPlanSettingsSection(){
  return `
  <div class="section-heading">Dining Tables &amp; Floor Plan</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">${state.tables.filter(t=>!t.is_combo).length} tables across ${state.areas.length} area${state.areas.length===1?'':'s'}. Add, rename, resize, delete, and drag-position tables on your floor plan sketch from the <b>Floor Plan</b> tab.</div>
    <table class="data-table">
      <thead><tr><th>Area</th><th>Table Count</th><th>Default Duration (min)</th><th>Pacing Cap (covers / 15 min)</th><th>Vault Seats Reserved for Members</th><th>Release (hrs before service)</th></tr></thead>
      <tbody>
        ${state.areas.map(a => `<tr>
          <td>${esc(a.name)}</td>
          <td>${state.tables.filter(t=>t.area_id===a.id).length}</td>
          <td><input type="number" min="15" step="15" max="480" class="modal-input" style="margin:0;width:90px;padding:4px 8px" value="${a.default_duration_minutes || 90}" onchange="setAreaDefaultDuration('${a.id}', this.value)"/></td>
          <td><input type="number" min="1" step="1" class="modal-input" style="margin:0;width:90px;padding:4px 8px" placeholder="No cap" value="${a.max_covers_per_slot || ''}" onchange="setAreaMaxCovers('${a.id}', this.value)"/></td>
          <td><input type="number" min="0" step="1" class="modal-input" style="margin:0;width:90px;padding:4px 8px" placeholder="None" value="${a.member_priority_seats ?? ''}" onchange="setAreaMemberPrioritySeats('${a.id}', this.value)"/></td>
          <td><input type="number" min="0" step="1" class="modal-input" style="margin:0;width:90px;padding:4px 8px" value="${a.member_priority_release_hours ?? 2}" onchange="setAreaMemberPriorityReleaseHours('${a.id}', this.value)"/></td>
        </tr>`).join('')}
        ${state.tables.some(t=>!t.area_id) ? `<tr><td>Unassigned</td><td>${state.tables.filter(t=>!t.area_id).length}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>` : ''}
      </tbody>
    </table>
    <div class="panel-sub" style="margin-top:8px">Each area's default duration pre-fills the Duration field on a new reservation once you pick a table there — the hostess can always type over it. The Pacing Cap limits how many total covers (guests) can be booked into any single 15-minute arrival window for that area. "Vault Seats Reserved for Members" holds that many seats back for active loyalty members until the release window before service — leave blank for areas with no loyalty carve-out (only the Speakeasy has one by default). All of these warn and ask for confirmation rather than blocking outright.</div>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="setTab('floorplan')">🗺️ Open Floor Plan Editor</button></div>
  </div>`;
}
function renderLoyaltySettingsSection(){
  return `
  <div class="section-heading">Loyalty Program</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Membership tier terms. Changing a number here only affects future redemption counting and new enrollments — it does not retroactively change what a member has already used this period.</div>
    <table class="data-table">
      <thead><tr><th>Tier</th><th>Price/mo</th><th>Cocktails/mo</th><th>Credit/qtr</th><th>Min. check</th><th>Vault access</th><th>Vault guests</th><th>Event discount %</th></tr></thead>
      <tbody>
        ${state.loyaltyTiers.map(t => `<tr>
          <td><b>${esc(t.name)}</b></td>
          <td>$<input type="number" min="0" step="1" class="modal-input" style="margin:0;width:70px;padding:4px 8px;display:inline-block" value="${t.monthly_price}" onchange="setLoyaltyTierField('${t.key}','monthly_price',this.value)"/></td>
          <td><input type="number" min="0" step="1" class="modal-input" style="margin:0;width:60px;padding:4px 8px" value="${t.cocktails_per_month}" onchange="setLoyaltyTierField('${t.key}','cocktails_per_month',this.value)"/></td>
          <td>$<input type="number" min="0" step="1" class="modal-input" style="margin:0;width:70px;padding:4px 8px;display:inline-block" value="${t.credit_per_quarter}" onchange="setLoyaltyTierField('${t.key}','credit_per_quarter',this.value)"/></td>
          <td>$<input type="number" min="0" step="1" class="modal-input" style="margin:0;width:70px;padding:4px 8px;display:inline-block" value="${t.credit_min_check}" onchange="setLoyaltyTierField('${t.key}','credit_min_check',this.value)"/></td>
          <td><input type="checkbox" ${t.vault_access?'checked':''} onchange="setLoyaltyTierField('${t.key}','vault_access',this.checked)"/></td>
          <td><input type="number" min="0" step="1" class="modal-input" style="margin:0;width:60px;padding:4px 8px" value="${t.vault_guest_allowance}" onchange="setLoyaltyTierField('${t.key}','vault_guest_allowance',this.value)"/></td>
          <td><input type="number" min="0" max="100" step="1" class="modal-input" style="margin:0;width:60px;padding:4px 8px" value="${t.discount_pct}" onchange="setLoyaltyTierField('${t.key}','discount_pct',this.value)"/></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="panel-sub" style="margin-top:14px;margin-bottom:8px"><b>Priority Holidays</b> — Founder's Circle gets a 14-day booking lead on these dates (everyone else, including Society, gets the standard 3 days). Doesn't apply to regular nights.</div>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">
      ${state.priorityHolidays.map(h => `<div style="display:flex;align-items:center;gap:10px;font-size:13px">
        <span style="min-width:110px">${esc(fmtDateHuman(h.holiday_date))}</span><span style="flex:1">${esc(h.label)}</span>
        <span class="linkBtn" style="cursor:pointer;color:var(--danger)" onclick="deletePriorityHoliday('${h.id}')">Remove</span>
      </div>`).join('') || '<span class="panel-sub" style="margin:0">No priority holidays added yet.</span>'}
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <input type="date" class="modal-input" style="margin:0;width:auto" id="newHolidayDate"/>
      <input type="text" class="modal-input" style="margin:0" id="newHolidayLabel" placeholder="Label (e.g. New Year's Eve)"/>
      <button class="btn btn-secondary btn-sm" onclick="addPriorityHoliday()">Add</button>
    </div>
  </div>`;
}
function renderTableColorsSection(){
  return `
  <div class="section-heading">Table Status Colors</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Define what each table color means on the Floor Plan. Tapping a table there cycles through these statuses in order: Available → Reserved → Assigned (Pre-Seated) → Seated → Needs Bussing → Blocked / Out of Service. "Assigned" is for a table held for a specific walk-in or reservation that hasn't sat down yet. The legend shown on the Floor Plan always reflects whatever colors you set here.</div>
    <table class="data-table">
      <thead><tr><th>Status</th><th>Color</th></tr></thead>
      <tbody>
        ${Object.keys(STATUS_LABELS).map(k => `<tr>
          <td>${STATUS_LABELS[k]}</td>
          <td><input type="color" value="${statusColors()[k]}" onchange="setStatusColor('${k}', this.value)" style="width:52px;height:32px;padding:0;border:1px solid var(--border);border-radius:6px;cursor:pointer"/></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}
function renderServersRosterSection(){
  return `
  <div class="section-heading">Servers Roster</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Quick list of server names for assigning to sections below — no login account needed. Most servers never need to sign into this app, so they don't need "Request Access" or Staff Access approval; that's only for people who'll actually use the software (hosts, managers, you). If a server is later promoted and needs real access, add them via Request Access on the login screen and approve them in Staff Access instead.</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
      ${state.roster.length ? state.roster.map(r => `<span class="area-chip" style="cursor:default">${esc(r.name)} <span class="linkBtn" style="cursor:pointer;color:var(--danger);margin-left:4px" onclick="deleteRosterServer('${r.id}')">×</span></span>`).join('') : '<span class="panel-sub" style="margin:0">No servers added yet.</span>'}
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <input type="text" class="modal-input" id="newRosterName" placeholder="Server name" style="margin:0;max-width:240px" onkeydown="if(event.key==='Enter')addRosterServer()"/>
      <button class="btn btn-primary btn-sm" onclick="addRosterServer()">+ Add Server</button>
    </div>
  </div>`;
}
function renderServerSectionsSection(){
  return `
  <div class="section-heading">Server Sections</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Group tables into color-coded sections and assign a server (or staff member) to each. Turn on "🎨 Server View" on the Floor Plan tab to see the floor colored by section instead of table status. Assign individual tables to a section from the table's edit panel on the Floor Plan tab.</div>
    <table class="data-table">
      <thead><tr><th>Color</th><th>Section</th><th>Assigned Server</th><th>Tables</th><th></th></tr></thead>
      <tbody>
        ${state.serverSections.map(s => `<tr>
          <td><span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:${esc(s.color)};border:1px solid var(--border)"></span></td>
          <td>${esc(s.name)}</td>
          <td>
            <select class="modal-select" style="margin:0;padding:4px 8px" onchange="setSectionServer('${s.id}', this.value)">
              ${assigneeOptionsHtml(s.assigned_roster_id, s.assigned_staff_id)}
            </select>
          </td>
          <td>${state.tables.filter(t=>t.server_section_id===s.id).length}</td>
          <td><button class="btn btn-sm btn-danger" onclick="deleteServerSection('${s.id}')">Delete</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="modal-actions" style="padding-top:14px"><button class="btn btn-primary" onclick="openServerSectionModal()">+ Add Section</button></div>
  </div>`;
}
function renderTableCombosSection(){
  return `
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
  </div>`;
}
function renderServicePeriodsSection(){
  return `
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
  </div>`;
}
function renderStaffAccessSection(){
  return `
  <div class="section-heading">Staff Access &amp; Permissions</div>
  <div class="card">
    <div class="panel-sub" style="margin-bottom:10px">Each role has a default set of permissions (see the plan doc for the full bundle). Click "Permissions" on any employee to grant or deny specific ones for just that person — e.g. a senior waiter who can apply discounts without becoming a manager.</div>
    <table class="data-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>PIN</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.staffList.map(s => `<tr>
          <td>${esc(s.name)}</td><td>${esc(s.email)}</td>
          <td>
            <select class="modal-select" style="margin:0;padding:4px 8px" onchange="setStaffRole('${s.id}', this.value)">
              ${['host','waiter','bartender','kitchen','expo','manager'].includes(s.role) ? '' : `<option value="${s.role}" selected>${esc(s.role)}</option>`}
              ${['host','waiter','bartender','kitchen','expo','manager'].map(r => `<option value="${r}" ${r===s.role?'selected':''}>${r}</option>`).join('')}
            </select>
          </td>
          <td>${s.pin_hash ? '<span class="badge badge-confirmed">set</span>' : '<span class="badge badge-pending">none</span>'} <button class="btn btn-sm btn-secondary" onclick="promptSetStaffPin('${s.id}')">${s.pin_hash?'Reset':'Set'}</button></td>
          <td>${s.active ? '<span class="badge badge-confirmed">active</span>' : '<span class="badge badge-pending">pending</span>'}</td>
          <td style="display:flex;gap:6px">
            <button class="btn btn-sm btn-secondary" onclick="openEditStaffModal('${s.id}')">Edit</button>
            <button class="btn btn-sm btn-secondary" onclick="openStaffPermissionsModal('${s.id}')">Permissions</button>
            <button class="btn btn-sm ${s.active?'btn-danger':'btn-success'}" onclick="toggleStaffActive('${s.id}', ${!s.active})">${s.active?'Deactivate':'Approve'}</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

// Registry driving both the Settings directory (link grid) and the focused single-section
// pop-out windows opened from it — one source of truth for what sections exist, their gating,
// and how to render them, so the two views can never drift out of sync with each other.
const SETTINGS_SECTIONS = [
  { key:'testing',     label:'🧪 Testing Tools',                can: () => currentStaff.role==='admin' || can('manage_staff_permissions'), render: renderTestingToolsSection },
  { key:'floorplan',   label:'🗺️ Dining Tables & Floor Plan',   can: () => can('manage_reservations'), render: renderFloorPlanSettingsSection },
  { key:'loyalty',     label:'💳 Loyalty Program',               can: () => can('manage_loyalty_program'), render: renderLoyaltySettingsSection },
  { key:'colors',      label:'🎨 Table Status Colors',           can: () => can('manage_reservations'), render: renderTableColorsSection },
  { key:'roster',      label:'🧑‍🍳 Servers Roster',             can: () => can('manage_reservations'), render: renderServersRosterSection },
  { key:'sections',    label:'📍 Server Sections',               can: () => can('manage_reservations'), render: renderServerSectionsSection },
  { key:'combos',      label:'🔗 Table Combinations',            can: () => can('manage_reservations'), render: renderTableCombosSection },
  { key:'periods',     label:'⏰ Service Periods',                can: () => can('manage_reservations'), render: renderServicePeriodsSection },
  { key:'menu',        label:'🍽️ Menu, Items & Modifiers',      can: () => can('manage_menu'), render: renderMenuSection },
  { key:'ingredients', label:'🧂 Ingredients & Costing',         can: () => can('manage_ingredients_costing'), render: renderIngredientsSection },
  { key:'inventory',   label:'📦 Inventory & Vendors',           can: () => can('manage_inventory'), render: renderInventorySection },
  { key:'staff',       label:'👤 Staff Access & Permissions',    can: () => currentStaff.role==='admin' || can('manage_staff_permissions'), render: renderStaffAccessSection },
];

function renderSettingsDirectory(){
  const visible = SETTINGS_SECTIONS.filter(s => s.can());
  return `
  <div class="panel-header"><h2 class="panel-title">Settings</h2></div>
  <p class="panel-sub" style="margin:0 0 14px">Each area below opens in its own window instead of one long page — click one to open it.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px">
    ${visible.map(s => `<div class="card" style="cursor:pointer;padding:18px" onclick="openSettingsSection('${s.key}')">
      <div style="font-size:16px;font-weight:600">${s.label}</div>
      <div class="panel-sub" style="margin:4px 0 0">Opens in a new window</div>
    </div>`).join('')}
  </div>`;
}

window.openSettingsSection = function(key){
  window.open('?settingsSection=' + encodeURIComponent(key), '_blank');
};
window.closeSettingsSectionWindow = function(){
  window.close();
  // Some browsers refuse to close a tab that wasn't opened by a user gesture in this same
  // script context (varies by browser) — if it's still here a moment later, guide them instead.
  setTimeout(() => { alert('You can close this browser tab now.'); }, 300);
};

function renderSettingsTab(){
  if (state.focusedSettingsSection){
    const sec = SETTINGS_SECTIONS.find(s => s.key === state.focusedSettingsSection);
    if (!sec){
      return `<div class="panel-header"><h2 class="panel-title">Settings</h2></div><div class="card"><div class="panel-sub" style="margin:0">Unknown settings section.</div></div>`;
    }
    if (!sec.can()){
      return `<div class="panel-header"><h2 class="panel-title">${sec.label}</h2></div><div class="card"><div class="panel-sub" style="margin:0">You don't have permission to view this section.</div></div>`;
    }
    return `
    <div class="panel-header"><h2 class="panel-title">${sec.label}</h2>
      <button class="btn btn-secondary btn-sm" onclick="closeSettingsSectionWindow()">Close Window</button>
    </div>
    ${sec.render()}`;
  }
  return renderSettingsDirectory();
}

window.openEditStaffModal = function(staffId){
  const s = state.staffList.find(x => x.id === staffId);
  if (!s) return;
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>Edit Staff Profile</h3>
    <p class="modal-user-email">Login email: ${esc(s.email)} — email isn't editable here since it's tied to their sign-in account.</p>
    <label class="field-label">Name</label>
    <input type="text" class="modal-input" id="editStaffName" value="${esc(s.name||'')}"/>
    <label class="field-label">Phone</label>
    <input type="tel" class="modal-input" id="editStaffPhone" value="${esc(s.phone||'')}" placeholder="(555) 555-5555"/>
    <label class="field-label">Address</label>
    <input type="text" class="modal-input" id="editStaffAddress" value="${esc(s.address||'')}" placeholder="Street, city, state, zip"/>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveStaffProfile('${staffId}')">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveStaffProfile = async function(staffId){
  const name = document.getElementById('editStaffName').value.trim();
  const phone = document.getElementById('editStaffPhone').value.trim() || null;
  const address = document.getElementById('editStaffAddress').value.trim() || null;
  if (!name){ alert('Name is required.'); return; }
  const { error } = await sb.from('staff').update({ name, phone, address }).eq('id', staffId);
  if (error){ alert('Error: '+error.message); return; }
  await reloadStaffList();
  closeModal('formModal');
  render();
};

window.promptSetStaffPin = async function(staffId){
  const pin = prompt('New 4-6 digit PIN for this employee (used for comp/discount/loyalty-payment approval and time-clock punches):');
  if (!pin) return;
  if (!/^[0-9]{4,6}$/.test(pin)){ alert('PIN must be 4-6 digits.'); return; }
  const { error } = await sb.rpc('set_staff_pin', { target_staff_id: staffId, new_pin: pin });
  if (error){ alert('Error: '+error.message); return; }
  await reloadStaffList();
  render();
};

async function reloadStaffList(){
  const { data } = await sb.from('staff').select('*').order('created_at');
  state.staffList = data || [];
}

// ---- Per-employee permission overrides ------------------------------------
window.openStaffPermissionsModal = function(staffId){
  const s = state.staffList.find(x => x.id === staffId);
  if (!s) return;
  const roleDefaults = new Set(state.rolePermissions.filter(rp => rp.role === s.role).map(rp => rp.permission_key));
  const overrideMap = {};
  state.staffOverrides.filter(o => o.staff_id === staffId).forEach(o => { overrideMap[o.permission_key] = o.granted; });
  const byCategory = {};
  state.permissions.forEach(p => {
    const cat = PERMISSION_CATEGORIES[p.key] || 'Other';
    (byCategory[cat] = byCategory[cat] || []).push(p);
  });
  const categories = PERMISSION_CATEGORY_ORDER.filter(c => byCategory[c]).concat(Object.keys(byCategory).filter(c => !PERMISSION_CATEGORY_ORDER.includes(c)));
  const box = document.getElementById('formModalBox');
  box.innerHTML = `
    <h3>${esc(s.name)}'s Permissions</h3>
    <p class="modal-user-email">Role: ${esc(s.role)}. Checked = this employee currently has the privilege (via role default or a personal override). Toggling a box overrides just that permission for this person; it stops following the role default only where you've changed it.</p>
    ${categories.map(cat => `
      <div class="section-heading" style="margin-top:16px;font-size:13px">${esc(cat)}</div>
      <table class="data-table">
        <tbody>
          ${byCategory[cat].map(p => {
            const roleDefault = roleDefaults.has(p.key);
            const overrideVal = overrideMap.hasOwnProperty(p.key) ? overrideMap[p.key] : null;
            const effective = overrideVal === null ? roleDefault : overrideVal;
            const overridden = overrideVal !== null;
            return `<tr>
              <td style="width:28px"><input type="checkbox" ${effective?'checked':''} onchange="togglePermissionOverride('${staffId}','${p.key}', this.checked)"/></td>
              <td>${esc(p.label)}${overridden ? ` <span class="panel-sub" style="margin:0">(overridden — role default: ${roleDefault?'Yes':'No'})</span>` : ''}<div class="panel-sub" style="margin:0">${esc(p.description||'')}</div></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`).join('')}
    <div class="modal-actions"><button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Close</button></div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.togglePermissionOverride = async function(staffId, permKey, checked){
  const s = state.staffList.find(x => x.id === staffId);
  const roleDefault = state.rolePermissions.some(rp => rp.role === s.role && rp.permission_key === permKey);
  if (checked === roleDefault){
    await sb.from('staff_permission_overrides').delete().eq('staff_id', staffId).eq('permission_key', permKey);
  } else {
    await sb.from('staff_permission_overrides').upsert({ staff_id: staffId, permission_key: permKey, granted: checked, set_by: currentStaff.id, set_at: new Date().toISOString() });
  }
  const { data } = await sb.from('staff_permission_overrides').select('*');
  state.staffOverrides = data || [];
  if (staffId === currentStaff.id) computeMyPermissions();
  openStaffPermissionsModal(staffId);
};

// Assignee dropdown covers two very different kinds of people: lightweight roster
// entries (just a name, no login — most servers) and real staff login accounts
// (rare for a server, common for hosts/managers). Encoded as "roster:<id>" /
// "staff:<id>" in the option value so one dropdown can offer both.
function assigneeOptionsHtml(selectedRosterId, selectedStaffId){
  const rosterOpts = state.roster.map(r => `<option value="roster:${r.id}" ${selectedRosterId===r.id?'selected':''}>${esc(r.name)}</option>`).join('');
  const staffOpts = state.staffList.filter(st=>st.active).map(st => `<option value="staff:${st.id}" ${selectedStaffId===st.id?'selected':''}>${esc(st.name)} (login account)</option>`).join('');
  return `<option value="">Unassigned</option>`
    + (rosterOpts ? `<optgroup label="Servers">${rosterOpts}</optgroup>` : '')
    + (staffOpts ? `<optgroup label="Staff Accounts">${staffOpts}</optgroup>` : '');
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
    <select class="modal-select" id="ssAssignee">${assigneeOptionsHtml(null, null)}</select>
    ${!state.roster.length ? `<p style="font-size:12px;color:var(--gray);margin-top:-4px">No servers in your roster yet — add one in the "Servers Roster" card below.</p>` : ''}
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick="closeModal('formModal')">Cancel</button>
      <button class="modal-btn modal-btn-primary" onclick="saveServerSection()">Save</button>
    </div>`;
  document.getElementById('formModal').classList.remove('hidden');
};

window.saveServerSection = async function(){
  const [kind, subId] = (document.getElementById('ssAssignee').value || '').split(':');
  const payload = {
    name: document.getElementById('ssName').value.trim() || 'Section',
    color: document.getElementById('ssColor').value,
    assigned_roster_id: kind==='roster' ? subId : null,
    assigned_staff_id: kind==='staff' ? subId : null,
    sort_order: state.serverSections.length,
  };
  const { error } = await sb.from('server_sections').insert(payload);
  if (error){ alert('Error: '+error.message); return; }
  closeModal('formModal');
  await reloadServerSections();
  render();
};

window.setSectionServer = async function(id, value){
  const [kind, subId] = (value || '').split(':');
  await sb.from('server_sections').update({
    assigned_roster_id: kind==='roster' ? subId : null,
    assigned_staff_id: kind==='staff' ? subId : null,
  }).eq('id', id);
  await reloadServerSections();
};

window.addRosterServer = async function(){
  const input = document.getElementById('newRosterName');
  const name = input.value.trim();
  if (!name){ alert('Enter a name.'); return; }
  const { error } = await sb.from('server_roster').insert({ name });
  if (error){ alert('Error: '+error.message); return; }
  input.value = '';
  await reloadRoster();
  render();
};

window.deleteRosterServer = async function(id){
  if (!confirm('Remove this server from the roster? Any section they\'re assigned to will become Unassigned.')) return;
  await sb.from('server_roster').delete().eq('id', id);
  await Promise.all([reloadRoster(), reloadServerSections()]);
  render();
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
  const { error } = await sb.from('staff').update({ role }).eq('id', id);
  const { data } = await sb.from('staff').select('*').order('created_at');
  state.staffList = data || [];
  if (error){ alert('Error: '+error.message); render(); return; }
};

// ============================================================================
// MODAL HELPERS
// ============================================================================
window.closeModal = function(id){ document.getElementById(id).classList.add('hidden'); };
window.openAccountModal = function(){ document.getElementById('accountModal').classList.remove('hidden'); };
window.todayISO = todayISO;
