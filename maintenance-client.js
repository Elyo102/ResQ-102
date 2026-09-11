const MODES = Object.freeze(['OFF', 'OBSERVE']);
const MODE_HE = Object.freeze({ 'OFF':'כבוי', 'OBSERVE':'תצפית בלבד' });
const SEVERITY_HE = Object.freeze({ 'P0':'קריטי', 'P1':'גבוה', 'P2':'בינוני', 'P3':'מידע' });
const OPERATIONAL_HE = Object.freeze({ 'LIVE':'פעילה', 'SILENT':'ניסוי / שקט', 'UNKNOWN':'לא ידוע' });
const HEALTH_HE = Object.freeze({ 'HEALTHY':'תקינה', 'DEGRADED':'דורשת תשומת לב', 'CRITICAL':'תקלה קריטית', 'UNKNOWN':'לא ידוע' });
const FRESHNESS_HE = Object.freeze({ 'FRESH':'עדכנית', 'STALE':'ישנה', 'MISSING':'חסרה' });
const PLATFORM_HE = Object.freeze({ 'AVAILABLE':'זמינה', 'STALE':'לא התקבלה פעימה', 'MISSING':'אין עדיין ראיה' });
const RUNBOOK_HE = Object.freeze({
  'ESCALATE_DATA_INTEGRITY_MANUAL':'בדיקת שלמות נתונים ידנית ומיידית',
  'REVIEW_BACKUP_QUARANTINE':'בדיקת גיבוי שנמצא בהסגר',
  'REVIEW_RUNTIME_MODE':'בדיקת מצב ניסוי לפני הפעלה',
  'REVIEW_SCHEDULER_EXECUTION':'בדיקת המשימה המתוזמנת', 'REVIEW_CAPACITY':'בדיקת עומס ומכסה',
  'CHECK_SERVICE_AVAILABILITY':'בדיקת זמינות שירות', 'REVIEW_AUTH_CONFIGURATION':'בדיקת אימות והרשאות',
  'REVIEW_MAIL_QUEUE':'בדיקת תור הדואר', 'REBUILD_EMPLOYEE_INDEX_DRY_RUN':'בדיקת מפתח עובדים ללא שינוי',
  'REVIEW_DOCUMENT_SIZES':'בדיקת גודל מסמכים', 'REVIEW_COLLECTION_GROWTH':'בדיקת גידול אוספים',
  'MONITOR_CLIENT_ERRORS':'מעקב אחר שגיאות מסך', 'WAIT_AND_RECHECK':'מעקב ובדיקה חוזרת'
});

function text(el, value){ if (el) el.textContent = String(value == null ? '' : value); }
function finite(value, allowed, fallback){ return allowed.includes(value) ? value : fallback; }
function asCount(value){ return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function dateText(value){
  const d = value && value.toDate ? value.toDate() : new Date(value || 0);
  return Number.isNaN(d.getTime()) || d.getTime() === 0 ? 'אין עדיין' :
    new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'short'}).format(d);
}

export function createMaintenanceUi({ elements, call, currentIdentity, onIdentityLost }){
  if (!elements || typeof call !== 'function' || typeof currentIdentity !== 'function') throw new TypeError('maintenance ui dependencies required');
  let generation = 0;
  let busy = false;
  let revision = 0;
  function sameIdentity(before){
    const now = currentIdentity();
    return !!before && !!now && before.uid === now.uid && before.epoch === now.epoch && before.super === true && now.super === true;
  }
  function setBusy(value){
    busy = value === true;
    [elements.refresh, elements.analyze, elements.mode].forEach((button) => { if (button) button.disabled = busy; });
  }
  function message(value, kind){
    if (!elements.message) return;
    elements.message.className = 'maintenance-note ' + (kind || '');
    text(elements.message, value);
  }
  function invalidate(){
    generation += 1;
    revision = 0;
    setBusy(false);
    text(elements.p0, 0); text(elements.p1, 0); text(elements.p2, 0);
    text(elements.open, 0); text(elements.dropped, 0); text(elements.heartbeat, '—');
    text(elements.modeBadge, '—'); text(elements.mode, '—');
    text(elements.operationalState, '—'); text(elements.healthState, '—'); text(elements.freshnessState, '—'); text(elements.platformState, '—');
    if (elements.list) elements.list.replaceChildren();
    message('', '');
  }
  function render(dto){
    const mode = finite(dto && dto.mode, MODES, 'OFF');
    revision = asCount(dto && dto.config_revision);
    elements.modeBadge.className = 'maintenance-mode ' + mode.toLowerCase();
    text(elements.modeBadge, MODE_HE[mode]);
    text(elements.mode, mode === 'OBSERVE' ? 'כבה תצפית' : 'הפעל תצפית');
    const counts = dto && dto.counts || {};
    text(elements.p0, asCount(counts.P0)); text(elements.p1, asCount(counts.P1));
    text(elements.p2, asCount(counts.P2)); text(elements.open, asCount(counts.open));
    text(elements.dropped, asCount(counts.dropped));
    text(elements.heartbeat, dateText(dto && dto.last_health_at));
    const operational = finite(dto && dto.operational_state, Object.keys(OPERATIONAL_HE), 'UNKNOWN');
    const health = finite(dto && dto.health_state, Object.keys(HEALTH_HE), 'UNKNOWN');
    const freshness = finite(dto && dto.health_freshness, Object.keys(FRESHNESS_HE), 'MISSING');
    const platform = finite(dto && dto.platform_state, Object.keys(PLATFORM_HE), 'MISSING');
    text(elements.operationalState, OPERATIONAL_HE[operational]);
    text(elements.healthState, HEALTH_HE[health]);
    text(elements.freshnessState, FRESHNESS_HE[freshness]);
    text(elements.platformState, PLATFORM_HE[platform]);
    if (elements.operationalCard) elements.operationalCard.dataset.state = operational.toLowerCase();
    if (elements.healthCard) elements.healthCard.dataset.state = health.toLowerCase();
    if (elements.freshnessCard) elements.freshnessCard.dataset.state = freshness.toLowerCase();
    if (elements.platformCard) elements.platformCard.dataset.state = platform.toLowerCase();
    const rows = Array.isArray(dto && dto.items) ? dto.items : [];
    elements.list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div'); empty.className = 'maintenance-empty';
      empty.textContent = 'אין כרגע תקלות פתוחות שדורשות טיפול.'; elements.list.appendChild(empty); return;
    }
    rows.forEach((row) => {
      const card = document.createElement('article'); card.className = 'maintenance-item';
      const severity = document.createElement('div');
      const sev = finite(row.severity, ['P0','P1','P2','P3'], 'P3');
      severity.className = 'maintenance-severity ' + sev.toLowerCase(); severity.textContent = sev + ' · ' + SEVERITY_HE[sev];
      const body = document.createElement('div');
      const title = document.createElement('div'); title.className = 'maintenance-item-title';
      title.textContent = String(row.title_code || 'תקלה טכנית');
      const meta = document.createElement('div'); meta.className = 'maintenance-item-meta';
      meta.textContent = 'מסך: ' + String(row.screen || 'unknown') + ' · מופעים: ' + asCount(row.count) + ' · גרסה: ' + String(row.version || 'unknown');
      body.append(title, meta);
      const runbook = document.createElement('div'); runbook.className = 'maintenance-runbook';
      runbook.textContent = RUNBOOK_HE[row.runbook_code] || 'קוד טיפול לא מוכר — נדרשת בדיקה ידנית';
      const state = document.createElement('div'); state.className = 'maintenance-state';
      state.textContent = 'אבחון מבוסס כללים';
      card.append(severity, body, runbook, state); elements.list.appendChild(card);
    });
  }
  async function invoke(name, data){
    if (busy) return;
    const before = currentIdentity(); const mine = ++generation; setBusy(true);
    try {
      const result = await call(name, data || {});
      if (mine !== generation) return;
      if (!sameIdentity(before)) { onIdentityLost(); return; }
      render(result || {}); message(name === 'runMaintenanceAnalysis' ? 'האבחון הושלם ללא שינוי בנתונים העסקיים.' : 'הנתונים עודכנו.', 'safe');
    } catch (error) {
      if (mine !== generation) return;
      if (!sameIdentity(before)) { onIdentityLost(); return; }
      const code = String(error && error.code || '');
      message(code.includes('permission-denied') ? 'השרת דחה את הפעולה: נדרשת הרשאת מנהל־על חיה.' : 'הפעולה נכשלה. ' + (code || 'שגיאה'), 'warn');
    } finally { if (mine === generation) setBusy(false); }
  }
  return Object.freeze({ render, invalidate, refresh:() => invoke('getMaintenanceDashboard'), analyze:() => invoke('runMaintenanceAnalysis'), setMode:(mode) => invoke('setMaintenanceMode',{mode,expected_revision:revision}) });
}

export const MAINTENANCE_MODES = MODES;
export const MAINTENANCE_RUNBOOK_LABELS = RUNBOOK_HE;
