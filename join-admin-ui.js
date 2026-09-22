// קליטה בקישור קבוצתי — צד הניהול (admin.html).
//
// כרטיס הקמפיינים + מסך האישור המרוכז. המודול אינו מכיר Firebase; הוא
// מקבל קריאות שרת ופעולות אישור/דחייה (המנגנון הקיים) מהדף. אין כאן
// innerHTML עם נתוני משתמש — הכל textContent/createElement.

export const SHIFT_HE = Object.freeze({ A: 'א׳', B: 'ב׳', C: 'ג׳' });
const STATE_HE = Object.freeze({ active: 'פעיל', paused: 'מושהה', revoked: 'בוטל', expired: 'פג תוקף', full: 'מלא' });
const REQ_HE = Object.freeze({ pending: 'ממתין', processing: 'בטיפול', needs_recovery: 'דורש בדיקה', approved: 'אושר', closed: 'נסגר', missing: 'חסר' });
const DECL_HE = Object.freeze({ declared: 'הוצהר', pending_verification: 'ממתין לאימות', verified: 'מאומת', rejected: 'נדחה', expired: 'פג', superseded: 'הוחלף' });
const REVIEW_HE = Object.freeze({ none: '', returned: 'הוחזר לתיקון', reminded: 'נשלחה תזכורת' });
const BULK_LIMIT = 25;

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
  return new Date(ms).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function joinLink(base, token) {
  const url = new URL('login.html', base);
  url.searchParams.set('join', token);
  return url.href;
}
export function whatsappText(stationName, link, expiresAtMs) {
  return 'שלום, זהו קישור הצטרפות למערכת ResQ של ' + (stationName || 'התחנה') + '.\n'
    + 'פתחו את הקישור בטלפון, מלאו את הפרטים ואמתו את המייל. הבקשה תאושר על ידי התחנה.\n'
    + link + '\n' + 'הקישור תקף עד ' + dateHe(expiresAtMs) + '. אל תעבירו אותו הלאה.';
}
/** CSV ללא PII מעבר לשם/מייל/טלפון/משמרת/סטטוס. ללא מספר עובד. */
export function registrantsCsv(rows) {
  const cell = (v) => { const s = String(v == null ? '' : v); return /^[=+\-@]/.test(s) ? '\'' + s : s; };
  const quote = (v) => '"' + cell(v).replace(/"/g, '""') + '"';
  const head = ['שם', 'מייל', 'טלפון', 'משמרת', 'מצב בקשה', 'מייל מאומת', 'ביקורת', 'כשירויות מאומתות', 'כשירויות ממתינות', 'נרשם ב'];
  const lines = [head.map(quote).join(',')];
  (rows || []).forEach((r) => {
    const s = r.summary || {};
    lines.push([r.full_name, r.email, r.phone, SHIFT_HE[r.shift] || r.shift, REQ_HE[r.request_status] || r.request_status,
      r.email_verified === true ? 'כן' : r.email_verified === false ? 'לא' : '', REVIEW_HE[r.review_state] || '',
      s.verified || 0, (s.pending || 0) + (s.declared || 0), dateHe(r.created_at_ms)].map(quote).join(','));
  });
  return '﻿' + lines.join('\r\n');
}
/** שורות שמותר לאשר במרוכז: ממתינות, מייל מאומת, ללא חריגה. */
export function bulkEligible(row) {
  return row.request_status === 'pending' && row.email_verified === true && row.account_disabled !== true && row.review_state !== 'returned';
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (ignore) {
    try { const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
  }
}

/** deps: { isSuper, canApprove, stationId, stations:[{id,name}], stationName(id), calls:{create,setStatus,list,registrants,review,verify}, approveOne(row,campaign), rejectOne(row), base } */
export function createJoinAdmin(root, deps) {
  const d = deps || {};
  d.canApprove = d.canApprove === true || d.isSuper === true;
  for (const name of ['approveOne', 'rejectOne', 'stationName']) if (typeof d[name] !== 'function') throw new TypeError('join admin dependency is required: ' + name);
  for (const name of ['create', 'setStatus', 'list', 'registrants', 'review', 'verify']) if (typeof (d.calls || {})[name] !== 'function') throw new TypeError('join admin call is required: ' + name);
  const calls = d.calls;
  const state = { campaigns: [], current: null, rows: [], cursor: null, filter: { status: 'all', shift: 'all', review: 'all', q: '' }, selected: new Set(), busy: false, lastToken: null };

  clear(root);
  const title = el('h2', { id: 'joinAdminTitle' }, 'קליטת עובדים בקישור קבוצתי');
  const intro = el('p', { class: 'note' }, 'קישור אחד לקבוצת WhatsApp; כל עובד ממלא את פרטיו, מאמת מייל, והבקשה מגיעה לכאן לאישור. התפקיד תמיד "לוחם/ת אש"; התחנה נקבעת מהקישור, לא מהעובד.');
  const status = el('p', { class: 'msg', id: 'joinAdminStatus', role: 'status', 'aria-live': 'polite' });
  const createBox = el('div', { class: 'join-admin-create' });
  const listBox = el('div', { class: 'join-admin-list', id: 'joinCampaignList' });
  const regBox = el('div', { class: 'join-admin-registrants hide', id: 'joinRegistrants' });
  root.append(title, intro, createBox, status, listBox, regBox);
  function message(txt, bad) { status.textContent = txt || ''; status.className = 'msg ' + (txt ? (bad ? 'err' : 'ok') : ''); }
  function friendly(e) { return (e && e.details && e.details.reason ? e.details.reason + ' · ' : '') + ((e && e.message) || (e && e.code) || ''); }

  /* ---------- יצירה ---------- */
  function renderCreate() {
    clear(createBox);
    const form = el('form', { id: 'joinCreateForm', novalidate: 'novalidate' });
    const fields = {};
    const add = (id, label, input) => { input.id = id; fields[id] = input; form.append(el('label', { for: id }, label), input); };
    if (d.isSuper) {
      const sel = el('select', {});
      (d.stations || []).forEach((s) => sel.appendChild(el('option', { value: s.id }, s.name + ' (' + s.id + ')')));
      add('jcStation', 'תחנה', sel);
    }
    add('jcLabel', 'תווית (למנהלים בלבד, לא נשלחת לעובד)', el('input', { type: 'text', maxlength: '60', placeholder: 'למשל: קליטת ספטמבר' }));
    const shifts = el('div', { class: 'join-admin-shifts', role: 'group', 'aria-label': 'משמרות מותרות' });
    ['A', 'B', 'C'].forEach((s) => {
      const lab = el('label', { class: 'join-choice', for: 'jcShift' + s });
      const cb = el('input', { type: 'checkbox', id: 'jcShift' + s, value: s }); cb.checked = true;
      lab.append(cb, el('span', {}, 'משמרת ' + SHIFT_HE[s])); shifts.appendChild(lab);
    });
    form.append(el('label', {}, 'משמרות שהעובד יכול לבחור'), shifts);
    add('jcMax', 'מכסת נרשמים (1–500)', el('input', { type: 'number', min: '1', max: '500', value: '50', inputmode: 'numeric' }));
    add('jcDays', 'תוקף הקישור בימים (1–30)', el('input', { type: 'number', min: '1', max: '30', value: '14', inputmode: 'numeric' }));
    const submit = el('button', { type: 'submit', id: 'jcCreate' }, 'צור קישור הצטרפות');
    form.appendChild(submit);
    form.onsubmit = async (event) => {
      event.preventDefault(); if (state.busy) return;
      const allowed = ['A', 'B', 'C'].filter((s) => form.querySelector('#jcShift' + s).checked);
      const max = Number(fields.jcMax.value), days = Number(fields.jcDays.value);
      if (!allowed.length) { message('יש לבחור לפחות משמרת אחת.', true); return; }
      if (!Number.isInteger(max) || max < 1 || max > 500) { message('המכסה חייבת להיות בין 1 ל-500.', true); return; }
      if (!Number.isInteger(days) || days < 1 || days > 30) { message('התוקף חייב להיות בין 1 ל-30 ימים.', true); return; }
      const label = String(fields.jcLabel.value || '').trim(); if (!label) { message('יש להזין תווית.', true); return; }
      const payload = { label, allowed_shifts: allowed, max_registrations: max, expires_at_ms: Date.now() + days * 86400000 };
      if (d.isSuper) payload.station_id = fields.jcStation.value;
      state.busy = true; submit.disabled = true; message('יוצר…');
      try {
        const res = await calls.create(payload);
        state.lastToken = { campaign_id: res.campaign_id, token: res.token, station_name: res.station_name, expires_at_ms: res.expires_at_ms };
        message('הקישור נוצר. הטוקן מוצג פעם אחת בלבד — העתק/י עכשיו.');
        await loadList();
      } catch (e) { message('היצירה נכשלה. ' + friendly(e), true); }
      finally { state.busy = false; submit.disabled = false; }
    };
    createBox.appendChild(form);
  }

  /* ---------- רשימת קמפיינים ---------- */
  async function loadList() {
    try {
      const res = await calls.list(d.isSuper ? {} : {});
      state.campaigns = Array.isArray(res.campaigns) ? res.campaigns : [];
      renderList();
    } catch (e) { message('טעינת הקמפיינים נכשלה. ' + friendly(e), true); }
  }
  function renderList() {
    clear(listBox);
    listBox.appendChild(el('h3', {}, 'קישורים קיימים'));
    if (!state.campaigns.length) { listBox.appendChild(el('div', { class: 'empty' }, 'עדיין אין קישורי הצטרפות.')); return; }
    state.campaigns.forEach((c) => {
      const box = el('div', { class: 'req join-campaign', 'data-campaign': c.campaign_id });
      box.appendChild(el('div', { class: 'nm' }, c.label + ' · ' + d.stationName(c.station_id)));
      const ln = el('div', { class: 'ln' });
      ln.append(el('span', { class: 'join-badge join-badge-' + c.state }, STATE_HE[c.state] || c.state), document.createTextNode(' · נרשמו ' + c.accepted_count + ' מתוך ' + c.max_registrations
        + ' · משמרות ' + c.allowed_shifts.map((s) => SHIFT_HE[s] || s).join(', ') + ' · תקף עד ' + dateHe(c.expires_at_ms)));
      box.appendChild(ln);
      const fresh = state.lastToken && state.lastToken.campaign_id === c.campaign_id ? state.lastToken : null;
      if (fresh) {
        const link = joinLink(d.base || location.href, fresh.token);
        const tokenBox = el('div', { class: 'join-token-box' });
        tokenBox.appendChild(el('div', { class: 'note' }, 'הקישור מוצג פעם אחת. אחרי רענון לא ניתן לשחזר אותו — רק ליצור קישור חדש.'));
        const input = el('input', { readonly: 'readonly', dir: 'ltr', 'aria-label': 'קישור הצטרפות', id: 'joinTokenLink' }); input.value = link;
        tokenBox.appendChild(input);
        const row = el('div', { class: 'join-row' });
        row.append(button('העתק קישור', '', async () => message((await copy(link)) ? 'הקישור הועתק.' : 'ההעתקה נכשלה — סמן/י והעתק/י ידנית.', false)),
          button('העתק הודעת WhatsApp', 'ghost', async () => message((await copy(whatsappText(fresh.station_name, link, fresh.expires_at_ms))) ? 'ההודעה הועתקה. הדבק/י בקבוצה.' : 'ההעתקה נכשלה.', false)),
          button('הסתר', 'ghost', () => { state.lastToken = null; renderList(); }));
        tokenBox.appendChild(row); box.appendChild(tokenBox);
      }
      const actions = el('div', { class: 'join-row' });
      if (c.state === 'active') actions.appendChild(button('השהה', 'ghost', () => setStatus(c, 'pause')));
      if (c.state === 'paused') actions.appendChild(button('חדש', '', () => setStatus(c, 'resume')));
      if (c.state !== 'revoked') actions.appendChild(button('בטל לצמיתות', 'no', () => { if (confirm('לבטל את הקישור? פעולה זו סופית. בקשות שכבר נשלחו ייחסמו לאישור.')) setStatus(c, 'revoke'); }));
      actions.appendChild(button('הצג נרשמים (' + c.accepted_count + ')', 'ghost', () => openRegistrants(c)));
      box.appendChild(actions);
      listBox.appendChild(box);
    });
  }
  async function setStatus(c, action) {
    if (state.busy) return; state.busy = true; message('');
    try { await calls.setStatus({ campaign_id: c.campaign_id, action, expected_revision: c.revision }); message('עודכן.'); await loadList(); }
    catch (e) { message('העדכון נכשל. ' + friendly(e), true); if (e && e.code && /aborted/.test(e.code)) await loadList(); }
    finally { state.busy = false; }
  }

  /* ---------- נרשמים ---------- */
  async function openRegistrants(c) {
    state.current = c; state.rows = []; state.cursor = null; state.selected.clear();
    regBox.classList.remove('hide');
    await loadRegistrants(true);
    regBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function loadRegistrants(reset) {
    try {
      const res = await calls.registrants({ campaign_id: state.current.campaign_id, cursor: reset ? undefined : state.cursor, limit: 50 });
      state.current = res.campaign || state.current;
      state.rows = reset ? res.rows : state.rows.concat(res.rows); state.cursor = res.next_cursor;
      renderRegistrants();
    } catch (e) { message('טעינת הנרשמים נכשלה. ' + friendly(e), true); }
  }
  function visibleRows() {
    const f = state.filter, q = f.q.trim().toLowerCase();
    return state.rows.filter((r) => (f.status === 'all' || r.request_status === f.status) && (f.shift === 'all' || r.shift === f.shift)
      && (f.review === 'all' || (f.review === 'exceptions' ? !bulkEligible(r) : r.review_state === f.review))
      && (!q || [r.full_name, r.email, r.phone].some((v) => String(v || '').toLowerCase().includes(q))));
  }
  function renderRegistrants() {
    clear(regBox);
    const c = state.current;
    regBox.appendChild(el('h3', {}, 'נרשמים · ' + c.label + ' · ' + d.stationName(c.station_id)));
    // מסננים
    const bar = el('div', { class: 'join-filters' });
    const sel = (id, label, opts, key) => {
      const s = el('select', { id, 'aria-label': label });
      opts.forEach(([v, t]) => s.appendChild(el('option', { value: v }, t)));
      s.value = state.filter[key]; s.onchange = () => { state.filter[key] = s.value; renderRegistrants(); }; bar.appendChild(s);
    };
    sel('jrStatus', 'מצב בקשה', [['all', 'כל המצבים'], ['pending', 'ממתין'], ['processing', 'בטיפול'], ['needs_recovery', 'דורש בדיקה'], ['approved', 'אושר'], ['closed', 'נסגר']], 'status');
    sel('jrShift', 'משמרת', [['all', 'כל המשמרות'], ['A', 'משמרת א׳'], ['B', 'משמרת ב׳'], ['C', 'משמרת ג׳']], 'shift');
    sel('jrReview', 'ביקורת', [['all', 'הכל'], ['exceptions', 'חריגים בלבד'], ['returned', 'הוחזרו לתיקון'], ['reminded', 'נשלחה תזכורת'], ['none', 'ללא הערה']], 'review');
    const q = el('input', { type: 'search', id: 'jrSearch', placeholder: 'חיפוש שם / מייל / טלפון', 'aria-label': 'חיפוש' }); q.value = state.filter.q;
    q.oninput = () => { state.filter.q = q.value; renderRegistrants(); }; bar.appendChild(q);
    regBox.appendChild(bar);
    const rows = visibleRows();
    // פעולות מרוכזות
    const bulk = el('div', { class: 'join-row join-bulk' });
    const eligible = rows.filter(bulkEligible);
    if (d.canApprove) {
      bulk.appendChild(button('בחר את כל הכשירים לאישור (' + Math.min(eligible.length, BULK_LIMIT) + ')', 'ghost', () => { state.selected = new Set(eligible.slice(0, BULK_LIMIT).map((r) => r.uid)); renderRegistrants(); }));
      bulk.appendChild(button('אשר את הנבחרים (' + state.selected.size + ')', '', () => bulkApprove(), { id: 'jrBulkApprove' }));
    }
    bulk.appendChild(button('הורד CSV', 'ghost', () => downloadCsv(rows)));
    bulk.appendChild(button('רענן', 'ghost', () => loadRegistrants(true)));
    regBox.appendChild(bulk);
    regBox.appendChild(el('div', { class: 'note' }, 'מוצגים ' + rows.length + ' מתוך ' + state.rows.length + ' · אישור מרוכז: עד ' + BULK_LIMIT + ' בכל פעם, רק שורות ללא חריגה (מייל מאומת, לא הוחזרו לתיקון). חריגים מאושרים אחד-אחד.'));
    if (!rows.length) { regBox.appendChild(el('div', { class: 'empty' }, 'אין נרשמים תואמים.')); return; }
    const table = el('table', { class: 'join-table' });
    const thead = el('thead', {}); const hr = el('tr', {});
    (d.canApprove ? ['', 'שם', 'קשר', 'משמרת', 'מצב', 'כשירויות', 'ביקורת', 'פעולות'] : ['שם', 'קשר', 'משמרת', 'מצב', 'כשירויות', 'ביקורת', 'פעולות']).forEach((h) => hr.appendChild(el('th', { scope: 'col' }, h)));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = el('tbody', {});
    rows.forEach((r) => tbody.appendChild(renderRow(r)));
    table.appendChild(tbody); regBox.appendChild(table);
    if (state.cursor) regBox.appendChild(button('טען עוד', 'ghost', () => loadRegistrants(false)));
  }
  function renderRow(r) {
    const tr = el('tr', { 'data-uid': r.uid, class: bulkEligible(r) ? '' : 'join-exception' });
    if (d.canApprove) {
      const td = el('td', {}); const cb = el('input', { type: 'checkbox', 'aria-label': 'בחר ' + r.full_name });
      cb.checked = state.selected.has(r.uid); cb.disabled = !bulkEligible(r);
      cb.onchange = () => { if (cb.checked) { if (state.selected.size >= BULK_LIMIT) { cb.checked = false; message('עד ' + BULK_LIMIT + ' בכל אישור מרוכז.', true); return; } state.selected.add(r.uid); } else state.selected.delete(r.uid); };
      td.appendChild(cb); tr.appendChild(td);
    }
    tr.appendChild(el('td', { 'data-label': 'שם' }, r.full_name || '—'));
    const contact = el('td', { 'data-label': 'קשר' });
    contact.append(el('div', { dir: 'ltr' }, r.email || ''), el('div', { dir: 'ltr' }, r.phone || ''));
    if (r.email_verified === false) contact.appendChild(el('div', { class: 'join-warn' }, 'מייל לא מאומת'));
    if (r.account_disabled === true) contact.appendChild(el('div', { class: 'join-warn' }, 'חשבון מושבת'));
    tr.appendChild(contact);
    tr.appendChild(el('td', { 'data-label': 'משמרת' }, SHIFT_HE[r.shift] || r.shift));
    tr.appendChild(el('td', { 'data-label': 'מצב' }, REQ_HE[r.request_status] || r.request_status));
    const quals = el('td', { 'data-label': 'כשירויות' });
    if (!r.declarations.length) quals.textContent = '—';
    r.declarations.forEach((q) => {
      const line = el('div', { class: 'join-decl join-decl-' + q.status });
      line.appendChild(el('span', {}, q.key + ' · ' + (DECL_HE[q.status] || q.status) + (q.valid_until_ms ? ' · עד ' + dateHe(q.valid_until_ms) : '') + (q.reference ? ' · ' + q.reference : '')));
      if (d.isSuper && q.status === 'pending_verification') {
        line.appendChild(button('אמת', 'ghost join-mini', () => verifyDecl(r, q, 'verify')));
        line.appendChild(button('דחה', 'ghost join-mini', () => verifyDecl(r, q, 'reject')));
      }
      if (q.status === 'rejected' && q.reject_reason) line.appendChild(el('div', { class: 'note' }, 'נימוק: ' + q.reject_reason));
      quals.appendChild(line);
    });
    tr.appendChild(quals);
    const review = el('td', { 'data-label': 'ביקורת' });
    review.textContent = REVIEW_HE[r.review_state] || '—';
    if (r.review_note) review.appendChild(el('div', { class: 'note' }, r.review_note));
    if (r.reject_reason) review.appendChild(el('div', { class: 'join-warn' }, 'נדחה: ' + r.reject_reason));
    tr.appendChild(review);
    const actions = el('td', { 'data-label': 'פעולות', class: 'join-actions' });
    if (d.canApprove && r.request_status === 'pending') actions.appendChild(button('אשר', 'ok join-mini', () => approveRow(r)));
    if (d.canApprove && ['pending', 'processing', 'needs_recovery'].indexOf(r.request_status) !== -1) actions.appendChild(button('דחה', 'no join-mini', () => rejectRow(r)));
    if (r.request_status === 'pending') {
      actions.appendChild(button('החזר לתיקון', 'ghost join-mini', () => reviewRow(r, 'return')));
      actions.appendChild(button('תזכורת', 'ghost join-mini', () => reviewRow(r, 'remind')));
    }
    if (r.review_state !== 'none') actions.appendChild(button('נקה הערה', 'ghost join-mini', () => reviewRow(r, 'clear')));
    tr.appendChild(actions);
    return tr;
  }
  async function approveRow(r) {
    if (state.busy) return; state.busy = true; message('מאשר את ' + r.full_name + '…');
    try { const out = await d.approveOne(r, state.current); message(out && out.emp ? 'אושר · מספר עובד ' + out.emp + ' · מסור/י אותו לעובד.' : 'אושר.'); }
    catch (e) { message('האישור נכשל. ' + friendly(e), true); }
    finally { state.busy = false; await loadRegistrants(true); }
  }
  async function bulkApprove() {
    if (state.busy || !state.selected.size) return;
    const targets = state.rows.filter((r) => state.selected.has(r.uid) && bulkEligible(r)).slice(0, BULK_LIMIT);
    if (!targets.length) { message('לא נבחרו שורות כשירות.', true); return; }
    if (!confirm('לאשר ' + targets.length + ' בקשות? כל אחת מאושרת בנפרד בשרת (מספר עובד לכל אחת).')) return;
    state.busy = true; const results = [];
    for (const r of targets) {
      message('מאשר ' + (results.length + 1) + ' מתוך ' + targets.length + ' · ' + r.full_name);
      try { const out = await d.approveOne(r, state.current); results.push({ uid: r.uid, name: r.full_name, ok: true, emp: out && out.emp }); }
      catch (e) { results.push({ uid: r.uid, name: r.full_name, ok: false, error: friendly(e) }); }
    }
    state.busy = false; state.selected.clear();
    await loadRegistrants(true);
    const box = el('div', { class: 'join-bulk-result' });
    box.appendChild(el('b', {}, 'תוצאות האישור המרוכז: ' + results.filter((x) => x.ok).length + ' אושרו, ' + results.filter((x) => !x.ok).length + ' נכשלו'));
    results.forEach((x) => box.appendChild(el('div', { class: x.ok ? 'join-ok' : 'join-warn' }, (x.ok ? '✓ ' : '✗ ') + x.name + (x.ok ? (x.emp ? ' · מספר עובד ' + x.emp : '') : ' · ' + x.error))));
    regBox.insertBefore(box, regBox.children[1]);
    message('');
  }
  async function rejectRow(r) {
    const reason = prompt('נימוק הדחייה (יישמר על הנרשם וביומן):'); if (!reason || reason.trim().length < 3) { if (reason !== null) message('נדרש נימוק.', true); return; }
    if (state.busy) return; state.busy = true;
    try {
      // הנימוק נשמר קודם (חוזה הקמפיין); הדחייה עצמה עוברת דרך rejectRegistration הקיים.
      await calls.review({ campaign_id: state.current.campaign_id, uid: r.uid, action: 'reject_note', expected_revision: r.revision, reason: reason.trim() });
      await d.rejectOne(r, reason.trim()); message('הבקשה נדחתה.');
    }
    catch (e) { message('הדחייה נכשלה. ' + friendly(e), true); }
    finally { state.busy = false; await loadRegistrants(true); }
  }
  async function reviewRow(r, action) {
    let reason = '';
    if (action === 'return') { reason = prompt('מה צריך לתקן? (העובד יראה את ההודעה)') || ''; if (!reason.trim()) return; }
    if (action === 'remind') { reason = prompt('טקסט התזכורת (לא חובה):') || 'נא להשלים את התהליך'; }
    if (state.busy) return; state.busy = true;
    try {
      const payload = { campaign_id: state.current.campaign_id, uid: r.uid, action, expected_revision: r.revision };
      if (reason.trim()) payload.reason = reason.trim();
      await calls.review(payload); message('עודכן.');
    } catch (e) { message('העדכון נכשל. ' + friendly(e), true); }
    finally { state.busy = false; await loadRegistrants(true); }
  }
  async function verifyDecl(r, q, action) {
    let reason = '';
    if (action === 'reject') { reason = prompt('נימוק הדחייה של הכשירות (חובה):') || ''; if (reason.trim().length < 3) { message('נדרש נימוק.', true); return; } }
    else if (!confirm('לאמת את הכשירות "' + q.key + '" של ' + r.full_name + '? ההחזקה תיכתב במנוע הסידור.')) return;
    if (state.busy) return; state.busy = true;
    try {
      const payload = { campaign_id: state.current.campaign_id, uid: r.uid, key: q.key, action, expected_revision: r.revision, request_id: 'qv_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 14) };
      if (reason.trim()) payload.reason = reason.trim();
      const out = await calls.verify(payload);
      message(action === 'verify' ? (out.holdings_written ? 'הכשירות אומתה ונכתבה למנוע הסידור.' : 'הכשירות אומתה (ההחזקה כבר הייתה קיימת).') : 'הכשירות נדחתה.');
    } catch (e) { message('הפעולה נכשלה. ' + friendly(e), true); }
    finally { state.busy = false; await loadRegistrants(true); }
  }
  function downloadCsv(rows) {
    const blob = new Blob([registrantsCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'join-' + state.current.campaign_id + '.csv'; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  renderCreate();
  return Object.freeze({ loadList, state });
}
