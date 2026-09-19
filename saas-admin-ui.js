// שכבת SaaS — מסך מנהל-על (saas-admin.html).
//
// ארגון, תוכנית, סטטוס, מכסות, שימוש נוכחי והיסטוריית שינויים. כל הכפתורים
// כאן הם סימולציה מקומית של מנהל-על — אין כאן תשלום ואין כאן חיוב.
// המודול אינו מכיר Firebase; הוא מקבל קריאות שרת מהדף. אין innerHTML —
// הכל textContent/createElement.

export const PLAN_HE = Object.freeze({ evaluation: 'הערכה', station: 'תחנה', district: 'מחוז', enterprise: 'ארגוני' });
export const STATUS_HE = Object.freeze({ evaluation: 'בהערכה', active: 'פעיל', suspended: 'מושהה', cancelled: 'בוטל' });
export const METRIC_HE = Object.freeze({ stations: 'תחנות', active_users: 'משתמשים פעילים', storage_mb: 'אחסון (MB)', pushes_per_month: 'התראות בחודש' });
export const ACTION_HE = Object.freeze({ create_organization: 'יצירת ארגון', attach_station: 'צירוף תחנה', change_plan: 'שינוי תוכנית', set_status: 'שינוי סטטוס (סימולציה)',
  webhook: 'אירוע ספק (סימולציה)', webhook_rejected: 'אירוע ספק נדחה', provider_error: 'כשל ספק', usage: 'שימוש' });
export const REASON_HE = Object.freeze({ 'saas-actor': 'מותר למנהל-על בלבד.', 'saas-actor-stale': 'הרשאת מנהל-העל אינה עדכנית.', input: 'הקלט אינו תקין.',
  'request-conflict': 'אותו מזהה פעולה כבר שימש לכוונה אחרת.', 'revision-mismatch': 'הנתונים השתנו בינתיים. רענן ונסה שוב.', provider: 'ספק החיוב אינו זמין. לא בוצע שינוי.',
  'quota-exceeded': 'המכסה של התוכנית מלאה.', 'subscription-suspended': 'המנוי מושהה — אין להוסיף משאבים.', 'subscription-cancelled': 'המנוי בוטל — אין להוסיף משאבים.',
  'station-owned-elsewhere': 'התחנה כבר משויכת לארגון אחר.', 'station-attached': 'התחנה כבר מצורפת.', 'station-district': 'התחנה במחוז אחר.', 'station-inactive': 'התחנה אינה פעילה.',
  transition: 'המעבר אינו מותר במצב הנוכחי.', 'webhook-signature': 'חתימת האירוע אינה תקפה.', 'webhook-mismatch': 'האירוע אינו שייך למנוי הזה.', 'organization-exists': 'מזהה הארגון תפוס.' });
const STATUS_ACTIONS = Object.freeze([['activate', 'הפעל'], ['suspend', 'השהה'], ['reactivate', 'החזר לפעילות'], ['cancel', 'בטל']]);
const WEBHOOK_EVENTS = Object.freeze(['checkout.completed', 'payment.failed', 'payment.recovered', 'subscription.cancelled']);
export const SIMULATION_LABEL = 'סימולציה מקומית — לא חיוב';

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    if (k === 'class') node.className = attrs[k];
    else if (k === 'for') node.htmlFor = attrs[k];
    else node.setAttribute(k, attrs[k]);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function button(label, cls, onClick, attrs) {
  const b = el('button', Object.assign({ type: 'button', class: cls || '' }, attrs || {}), label);
  b.onclick = onClick; return b;
}
function dateHe(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function newRequestId() {
  const bytes = new Uint8Array(24);
  (globalThis.crypto || {}).getRandomValues ? globalThis.crypto.getRandomValues(bytes) : bytes.forEach((v, i) => { bytes[i] = Math.floor(Math.random() * 256); });
  return 'saas_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function errorText(error) {
  const reason = error && error.details && typeof error.details.reason === 'string' ? error.details.reason : '';
  return REASON_HE[reason] || (error && typeof error.message === 'string' ? error.message : 'הפעולה נכשלה.');
}
export function quotaRows(view) {
  return (view && Array.isArray(view.quotas) ? view.quotas : []).map((q) => Object.freeze({
    metric: q.metric, label: METRIC_HE[q.metric] || q.metric, used: q.used, limit: q.limit,
    percent: q.limit > 0 ? Math.min(999, Math.round((q.used / q.limit) * 100)) : 0, over: q.over === true
  }));
}

/** deps: { calls:{ list, overview, create, attach, changePlan, setStatus, webhook }, signWebhook?(payload) } */
export function createSaasAdmin(root, deps) {
  const d = deps || {};
  for (const name of ['list', 'overview', 'create', 'attach', 'changePlan', 'setStatus', 'webhook']) {
    if (typeof (d.calls || {})[name] !== 'function') throw new TypeError('saas admin call is required: ' + name);
  }
  const calls = d.calls;
  const state = { organizations: [], current: null, view: null, busy: false };

  clear(root);
  root.appendChild(el('h1', { id: 'saasTitle' }, 'ארגונים ומנויים'));
  root.appendChild(el('p', { class: 'sub' }, 'שכבה מסחרית בלבד: ארגון מפנה לתחנות לפי מזהה ואינו מקור הרשאה. קטלוג התוכניות הוא מקום שמור שטרם סוכם.'));
  const status = el('p', { class: 'msg', id: 'saasStatus', role: 'status', 'aria-live': 'polite' });
  root.appendChild(status);

  /* ---- בחירה / יצירה ---- */
  const pick = el('section', { class: 'card', id: 'saasPick' });
  pick.appendChild(el('h2', {}, 'ארגון'));
  const selWrap = el('label', { for: 'saasOrg' }, 'בחר ארגון');
  const sel = el('select', { id: 'saasOrg' });
  selWrap.appendChild(sel); pick.appendChild(selWrap);
  const createForm = el('form', { id: 'saasCreate', class: 'saas-form' });
  const field = (id, label, attrs) => { const l = el('label', { for: id }, label); const i = el('input', Object.assign({ id, name: id }, attrs || {})); l.appendChild(i); createForm.appendChild(l); return i; };
  const idInput = field('scOrgId', 'מזהה ארגון (אותיות קטנות, ספרות, מקף)', { pattern: '[a-z0-9][a-z0-9_-]{2,63}', required: '', autocomplete: 'off' });
  const nameInput = field('scName', 'שם הארגון', { maxlength: '80', required: '' });
  const districtInput = field('scDistrict', 'מזהה מחוז', { pattern: '[a-z0-9][a-z0-9_-]{1,40}', required: '' });
  const planLabel = el('label', { for: 'scPlan' }, 'תוכנית (קטלוג שמור, לא מוסכם)');
  const planSel = el('select', { id: 'scPlan' });
  Object.keys(PLAN_HE).forEach((id) => planSel.appendChild(el('option', { value: id }, PLAN_HE[id] + ' (' + id + ')')));
  planLabel.appendChild(planSel); createForm.appendChild(planLabel);
  createForm.appendChild(button('צור ארגון', 'primary', null, { id: 'scSubmit' })).type = 'submit';
  pick.appendChild(createForm);
  root.appendChild(pick);

  /* ---- סקירה ---- */
  const overview = el('section', { class: 'card hide', id: 'saasOverview' });
  root.appendChild(overview);

  function say(text, kind) { status.textContent = text || ''; status.className = 'msg' + (kind ? ' ' + kind : ''); }
  function busy(on) { state.busy = on; root.querySelectorAll('button').forEach((b) => { b.disabled = on; }); }
  async function run(label, fn) {
    if (state.busy) return;
    busy(true); say(label + '…');
    try { const out = await fn(); say(out && out.duplicate ? 'הפעולה כבר בוצעה קודם — הוחזרה הקבלה הקיימת.' : label + ' — בוצע (סימולציה מקומית).', 'ok'); }
    catch (e) { say(errorText(e), 'err'); }
    finally { busy(false); if (state.current) await load(state.current); }
  }

  function renderOverview() {
    clear(overview);
    const v = state.view; if (!v) { overview.classList.add('hide'); return; }
    overview.classList.remove('hide');
    const org = v.organization, sub = v.subscription;
    overview.appendChild(el('h2', { id: 'soName' }, org.name));
    const facts = el('dl', { class: 'saas-facts' });
    const fact = (k, val, id) => { facts.appendChild(el('dt', {}, k)); facts.appendChild(el('dd', id ? { id } : {}, val)); };
    fact('מזהה', org.organization_id); fact('מחוז', org.district_id);
    fact('תוכנית', (PLAN_HE[sub.plan_id] || sub.plan_id) + ' (' + sub.plan_id + ')', 'soPlan');
    fact('סטטוס', STATUS_HE[sub.status] || sub.status, 'soStatus');
    fact('גרסת מנוי', String(sub.revision), 'soRevision');
    fact('תחנות', org.station_ids.length ? org.station_ids.join(', ') : 'אין', 'soStations');
    fact('תקופת שימוש', v.usage.period);
    overview.appendChild(facts);
    overview.appendChild(el('p', { class: 'note' }, 'התוכנית והמספרים הם placeholder שטרם סוכם מסחרית. אין כאן חיוב.'));

    const table = el('table', { id: 'soQuotas', class: 'saas-table' });
    const thead = el('thead'); const hr = el('tr'); ['מדד', 'בשימוש', 'מכסה', '%'].forEach((h) => hr.appendChild(el('th', {}, h))); thead.appendChild(hr); table.appendChild(thead);
    const tbody = el('tbody');
    quotaRows(v).forEach((q) => {
      const tr = el('tr', q.over ? { class: 'over' } : {});
      tr.appendChild(el('td', {}, q.label)); tr.appendChild(el('td', {}, String(q.used))); tr.appendChild(el('td', {}, String(q.limit))); tr.appendChild(el('td', {}, q.percent + '%'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); overview.appendChild(table);

    /* סימולציה */
    const sim = el('section', { class: 'saas-sim', id: 'soSim' });
    sim.appendChild(el('h3', {}, SIMULATION_LABEL));
    sim.appendChild(el('p', { class: 'note' }, 'הכפתורים מפעילים מעברי סטטוס וספק חיוב מזויף בשרת. שום כרטיס אשראי ושום חיוב אמיתי אינם מעורבים.'));
    const row = el('div', { class: 'saas-actions' });
    STATUS_ACTIONS.forEach(([action, label]) => row.appendChild(button(label, 'ghost', () => run(label, () => calls.setStatus({ request_id: newRequestId(), organization_id: org.organization_id, action, expected_revision: sub.revision })), { 'data-action': action })));
    sim.appendChild(row);

    const planRow = el('div', { class: 'saas-actions' });
    const planPick = el('select', { id: 'soPlanPick', 'aria-label': 'תוכנית חדשה' });
    Object.keys(PLAN_HE).forEach((id) => { const o = el('option', { value: id }, PLAN_HE[id] + ' (' + id + ')'); if (id === sub.plan_id) o.selected = true; planPick.appendChild(o); });
    planRow.appendChild(planPick);
    planRow.appendChild(button('שנה תוכנית', 'ghost', () => run('שינוי תוכנית', () => calls.changePlan({ request_id: newRequestId(), organization_id: org.organization_id, plan_id: planPick.value, expected_revision: sub.revision })), { id: 'soPlanChange' }));
    sim.appendChild(planRow);

    const attachRow = el('div', { class: 'saas-actions' });
    const stationInput = el('input', { id: 'soStationId', placeholder: 'מזהה תחנה (למשל eilat_102)', 'aria-label': 'מזהה תחנה', pattern: '[a-z0-9][a-z0-9_-]{1,63}' });
    attachRow.appendChild(stationInput);
    attachRow.appendChild(button('צרף תחנה', 'ghost', () => { const sid = stationInput.value.trim(); if (!sid) { say('יש להזין מזהה תחנה.', 'err'); return; }
      run('צירוף תחנה', () => calls.attach({ request_id: newRequestId(), organization_id: org.organization_id, station_id: sid })); }, { id: 'soAttach' }));
    sim.appendChild(attachRow);

    const hookRow = el('div', { class: 'saas-actions' });
    const hookPick = el('select', { id: 'soWebhookEvent', 'aria-label': 'אירוע ספק' });
    WEBHOOK_EVENTS.forEach((t) => hookPick.appendChild(el('option', { value: t }, t)));
    hookRow.appendChild(hookPick);
    hookRow.appendChild(button('הזרק אירוע ספק', 'ghost', () => run('אירוע ספק', () => calls.webhook({ request_id: newRequestId(), organization_id: org.organization_id, event_type: hookPick.value })), { id: 'soWebhook' }));
    sim.appendChild(hookRow);
    overview.appendChild(sim);

    /* היסטוריה */
    overview.appendChild(el('h3', {}, 'היסטוריית שינויים (עד 50 אחרונים)'));
    const list = el('ul', { id: 'soAudit', class: 'saas-audit' });
    (Array.isArray(v.audit) ? v.audit : []).forEach((e) => {
      const li = el('li');
      li.appendChild(el('b', {}, ACTION_HE[e.action] || e.action));
      const det = e.details || {};
      const bits = Object.keys(det).map((k) => k + ': ' + String(det[k]));
      li.appendChild(el('span', {}, ' · ' + dateHe(e.at_ms) + (bits.length ? ' · ' + bits.join(' · ') : '')));
      list.appendChild(li);
    });
    if (!list.firstChild) list.appendChild(el('li', { class: 'empty' }, 'אין שינויים עדיין.'));
    overview.appendChild(list);
  }

  async function load(oid) {
    if (!oid) { state.view = null; renderOverview(); return; }
    try { state.view = await calls.overview({ organization_id: oid }); state.current = oid; }
    catch (e) { state.view = null; say(errorText(e), 'err'); }
    renderOverview();
  }
  async function refresh() {
    try {
      const res = await calls.list({});
      state.organizations = Array.isArray(res && res.organizations) ? res.organizations : [];
      clear(sel);
      sel.appendChild(el('option', { value: '' }, state.organizations.length ? 'בחר…' : 'אין ארגונים עדיין'));
      state.organizations.forEach((o) => sel.appendChild(el('option', { value: o.organization_id }, o.name + ' (' + o.organization_id + ')')));
      if (state.current && state.organizations.some((o) => o.organization_id === state.current)) { sel.value = state.current; await load(state.current); }
      else { state.current = null; await load(null); }
    } catch (e) { say(errorText(e), 'err'); }
  }
  sel.onchange = () => { state.current = sel.value || null; load(state.current); };
  createForm.onsubmit = (ev) => {
    ev.preventDefault();
    if (!createForm.reportValidity()) return;
    const payload = { request_id: newRequestId(), organization_id: idInput.value.trim(), name: nameInput.value.trim(), district_id: districtInput.value.trim(), plan_id: planSel.value };
    run('יצירת ארגון', async () => { const out = await calls.create(payload); state.current = out.organization_id; createForm.reset(); await refresh(); return out; });
  };

  return Object.freeze({ refresh, load, state });
}
