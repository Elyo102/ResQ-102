// קליטה בקישור קבוצתי — צד העובד (login.html?join=<token>).
//
// המודול לא מכיר את Firebase ישירות: הוא מקבל את הפעולות (יצירת חשבון,
// כניסה, אימות מייל, קריאות שרת) מהדף שמייבא אותו. כך אפשר לבדוק אותו
// בדפדפן בלי רשת, וכך אין כאן עותק שני של הגדרות ההתחברות.
//
// כללי מסך: אין innerHTML עם תוכן משתמש — כל טקסט נכנס דרך textContent;
// כל כפתור ושדה בגובה 44px לפחות (theme.css); כל מצב שרת מקבל מסך משלו.

export const TERMS_VERSION = '2026-09';
export const PRIVACY_VERSION = '2026-09';
export const SHIFT_HE = Object.freeze({ A: 'א׳', B: 'ב׳', C: 'ג׳' });
const STATE_TEXT = Object.freeze({
  loading: ['⏳', 'בודק את הקישור…', 'רגע אחד.'],
  active: ['👋', 'הצטרפות לתחנה', ''],
  paused: ['⏸', 'הקישור מושהה זמנית', 'התחנה השהתה את הקליטה. נסה שוב מאוחר יותר או פנה לרכז/ת כוח האדם.'],
  expired: ['⌛', 'תוקף הקישור פג', 'בקש/י קישור חדש מהתחנה.'],
  revoked: ['🚫', 'הקישור בוטל', 'התחנה ביטלה את הקישור הזה. בקש/י קישור חדש.'],
  full: ['👥', 'הקישור הגיע למכסת הנרשמים', 'פנה/י לתחנה כדי לקבל קישור נוסף.'],
  not_found: ['❓', 'הקישור אינו תקין', 'ודא/י שהקישור הועתק במלואו, או בקש/י קישור חדש.'],
  network: ['📡', 'אין חיבור לשרת', 'לא הצלחנו לבדוק את הקישור. בדוק/י חיבור ונסה/י שוב.']
});

export function readJoinToken(search) {
  let token = '';
  try { token = new URLSearchParams(search || '').get('join') || ''; } catch (ignore) { token = ''; }
  return /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}

export function stripJoinFromUrl(win) {
  try {
    const url = new URL(win.location.href);
    if (!url.searchParams.has('join')) return;
    url.searchParams.delete('join');
    win.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  } catch (ignore) {}
}

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
function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    return 'jc_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return 'jc_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 18);
}
// sessionStorage — ואם הדפדפן חוסם אותו (מצב פרטי, about:blank), זיכרון בלבד.
const memory = new Map();
const session = {
  get(k) { try { return sessionStorage.getItem(k) || ''; } catch (ignore) { return memory.get(k) || ''; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (ignore) { memory.set(k, v); } },
  remove(k) { try { sessionStorage.removeItem(k); } catch (ignore) {} memory.delete(k); }
};
const requestStore = {
  key: (token) => 'resq_join_request_' + token.slice(0, 16),
  get(token) { return session.get(this.key(token)); },
  set(token, id) { session.set(this.key(token), id); },
  clear(token) { session.remove(this.key(token)); }
};

/** בונה את הפאנל בתוך `root`. deps — ראו login.html. */
export function createJoinPanel(root, deps) {
  const d = deps || {};
  for (const name of ['inspect', 'redeem', 'currentUser', 'createAccount', 'signIn', 'sendVerification', 'refreshUser',
    'hasAssignment', 'onRedeemed', 'pwOk', 'claims']) {
    if (typeof d[name] !== 'function') throw new TypeError('join panel dependency is required: ' + name);
  }
  const token = String(d.token || '');
  const state = { view: null, busy: false, requestId: requestStore.get(token) || '', epoch: 0 };

  const head = el('div', { class: 'join-head' });
  const icon = el('div', { class: 'join-icon', 'aria-hidden': 'true' });
  const title = el('h2', { class: 'join-title', id: 'joinTitle', tabindex: '-1' });
  const text = el('p', { class: 'join-text', id: 'joinText' });
  head.append(icon, title, text);
  const body = el('div', { class: 'join-body' });
  const status = el('p', { class: 'msg', id: 'joinStatus', role: 'status', 'aria-live': 'polite' });
  clear(root); root.append(head, body, status);

  function message(txt, bad) { status.textContent = txt || ''; status.className = 'msg ' + (txt ? (bad ? 'err' : 'ok') : ''); }
  function setHead(kind, stationName) {
    const t = STATE_TEXT[kind] || STATE_TEXT.not_found;
    icon.textContent = t[0]; title.textContent = t[1] + (kind === 'active' && stationName ? ' · ' + stationName : ''); text.textContent = t[2];
    root.dataset.joinState = kind;
  }
  function button(label, cls, onClick) {
    const b = el('button', { type: 'button', class: cls || '' }, label);
    b.onclick = onClick; return b;
  }
  function renderTerminal(kind, retry) {
    setHead(kind); clear(body);
    if (retry) body.appendChild(button('נסה שוב', 'ghost', () => load()));
    body.appendChild(button('לדף הכניסה הרגיל', 'link', () => { stripJoinFromUrl(window); location.replace('./login.html'); }));
  }

  async function load() {
    const epoch = ++state.epoch;
    setHead('loading'); clear(body); message('');
    let view;
    try { view = await d.inspect({ token }); }
    catch (error) { if (epoch === state.epoch) renderTerminal('network', true); return; }
    if (epoch !== state.epoch) return;
    state.view = view && typeof view === 'object' ? view : { state: 'not_found' };
    if (state.view.state !== 'active') { renderTerminal(state.view.state); return; }
    renderForm();
  }

  /* ---------- טופס ---------- */
  const fields = {};
  function labeled(id, labelText, input) {
    const wrap = el('div', { class: 'join-field' });
    wrap.append(el('label', { for: id }, labelText), input);
    input.id = id; fields[id] = input; return wrap;
  }
  function renderForm() {
    const v = state.view; setHead('active', v.station_name); clear(body);
    const user = d.currentUser();

    // שלב 1 — חשבון
    const acct = el('section', { class: 'join-step', 'aria-labelledby': 'joinStep1' });
    acct.appendChild(el('h3', { id: 'joinStep1' }, '1 · חשבון'));
    if (!user) {
      acct.appendChild(el('p', {}, 'הזן/י מייל וסיסמה. אם כבר יש לך חשבון — היכנס/י איתו.'));
      acct.appendChild(labeled('joinEmail', 'מייל', el('input', { type: 'email', dir: 'ltr', autocomplete: 'username', inputmode: 'email' })));
      acct.appendChild(labeled('joinPassword', 'סיסמה', el('input', { type: 'password', autocomplete: 'new-password' })));
      acct.appendChild(el('p', { class: 'join-hint' }, 'לחשבון חדש: 8 תווים לפחות, אות גדולה, אות קטנה וספרה.'));
      const row = el('div', { class: 'join-row' });
      row.append(button('יצירת חשבון', '', () => account('create')), button('כניסה לחשבון קיים', 'ghost', () => account('signin')));
      acct.appendChild(row);
    } else {
      acct.appendChild(el('p', { id: 'joinWho' }, 'מחובר/ת: ' + (user.email || '')));
      if (!user.emailVerified) {
        acct.appendChild(el('p', {}, 'יש לאמת את המייל לפני שליחת הבקשה. פתח/י את הקישור שנשלח אליך וחזור/י לכאן.'));
        const row = el('div', { class: 'join-row' });
        row.append(button('שלח/י מייל אימות', 'ghost', () => verify()), button('אימתתי — בדוק שוב', '', () => recheck()));
        acct.appendChild(row);
      } else acct.appendChild(el('p', { class: 'join-ok' }, 'המייל מאומת ✓'));
    }
    body.appendChild(acct);

    // שלב 2 — פרטים (מוצג תמיד; נשלח רק כשהחשבון מאומת)
    const form = el('form', { class: 'join-step', id: 'joinForm', 'aria-labelledby': 'joinStep2', novalidate: 'novalidate' });
    form.appendChild(el('h3', { id: 'joinStep2' }, '2 · פרטי ההצטרפות'));
    form.appendChild(labeled('joinName', 'שם מלא', el('input', { type: 'text', autocomplete: 'name', maxlength: '160' })));
    form.appendChild(labeled('joinPhone', 'טלפון נייד', el('input', { type: 'tel', dir: 'ltr', autocomplete: 'tel', inputmode: 'tel', maxlength: '40' })));
    const shiftSet = el('fieldset', { class: 'join-shifts' });
    shiftSet.appendChild(el('legend', {}, 'משמרת'));
    (v.allowed_shifts || []).forEach((s, i) => {
      const id = 'joinShift_' + s;
      const lab = el('label', { class: 'join-choice', for: id });
      const input = el('input', { type: 'radio', name: 'joinShift', value: s, id });
      if (i === 0) input.checked = true;
      lab.append(input, el('span', {}, 'משמרת ' + (SHIFT_HE[s] || s)));
      shiftSet.appendChild(lab);
    });
    form.appendChild(shiftSet);
    const quals = el('fieldset', { class: 'join-quals' });
    quals.appendChild(el('legend', {}, 'כשירויות (סמן/י רק מה שיש לך בפועל — ייבדק על ידי התחנה)'));
    (v.qualification_catalog || []).forEach((q) => {
      const key = String(q.key || ''); if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) return;
      const row = el('div', { class: 'join-qual', 'data-key': key });
      const id = 'joinQual_' + key;
      const lab = el('label', { class: 'join-choice', for: id });
      const cb = el('input', { type: 'checkbox', id, value: key });
      lab.append(cb, el('span', {}, String(q.label || key)));
      const extra = el('div', { class: 'join-qual-extra hide' });
      const until = el('input', { type: 'date', id: id + '_until', 'aria-label': 'בתוקף עד' });
      const ref = el('input', { type: 'text', id: id + '_ref', maxlength: '80', 'aria-label': 'אסמכתא (מספר תעודה / קורס)', placeholder: 'אסמכתא (לא חובה)' });
      extra.append(el('label', { for: id + '_until' }, 'בתוקף עד (אם יש)'), until, ref);
      cb.onchange = () => extra.classList.toggle('hide', !cb.checked);
      row.append(lab, extra); quals.appendChild(row);
    });
    form.appendChild(quals);
    form.appendChild(labeled('joinNote', 'הערה לתחנה (לא חובה)', el('textarea', { maxlength: '300', rows: '2' })));
    const legal = el('div', { class: 'join-legal', 'aria-label': 'מסמכי ההצטרפות' });
    const terms = el('details', { class: 'join-legal-doc' });
    terms.append(
      el('summary', {}, 'תנאי שימוש · גרסה ' + TERMS_VERSION),
      el('p', {}, 'ResQ היא מערכת תפעולית לתחנה. יש למסור פרטים נכונים, לשמור על סודיות החשבון ולהשתמש במערכת רק לצורכי התפקיד.'),
      el('p', {}, 'דיווחי שעות ודוחות חודשיים שהוגשו נשמרים בשרת ללא מחיקה אוטומטית לצורכי ביקורת. ביטול טיוטה נשמר בקבלת ביקורת שרתית.'),
      el('p', {}, 'אין מערכת חסינה לחלוטין. יש לנעול את המכשיר, לא למסור סיסמה ולדווח לתחנה על אובדן מכשיר או חשד לשימוש לא מורשה.')
    );
    const privacy = el('details', { class: 'join-legal-doc' });
    privacy.append(
      el('summary', {}, 'מדיניות פרטיות · גרסה ' + PRIVACY_VERSION),
      el('p', {}, 'המערכת מעבדת פרטי זהות, תחנה, תפקיד, משמרות, שעות, מסמכי HR, מידע רפואי שנמסר ביוזמת המשתמש, הרשאות מכשיר וטוקן פוש לצורך הפעלת השירות.'),
      el('p', {}, 'השרת הוא מקור האמת. האפליקציה אינה יוצרת עותק קבוע בדפדפן של שעות, מידע רפואי, הסכמות, נימוקי דחייה או טוקני פוש; Firebase והדפדפן מנהלים פרטי התחברות ופוש הנחוצים לשירות.'),
      el('p', {}, 'Firebase משמש כספק תשתית מטעם מפעיל המערכת. אין מכירת מידע, פרסום ממוקד או שימוש במידע רפואי ו-HR לשיווק. הסכמה שיווקית עתידית, אם תוצע, תהיה נפרדת, אופציונלית וניתנת לביטול.'),
      el('p', {}, 'ייצוא מקומי מיועד למחשב ארגוני מנוהל ומוצפן בלבד. קובץ שיוצא מהמערכת אינו ניתן למחיקה מרחוק, והאחריות התפעולית לשמירתו היא של התחנה.')
    );
    legal.append(terms, privacy);
    form.appendChild(legal);
    const ackLab = el('label', { class: 'join-choice join-ack', for: 'joinAck' });
    const ack = el('input', { type: 'checkbox', id: 'joinAck' }); fields.joinAck = ack;
    ackLab.append(ack, el('span', {}, 'קראתי את תנאי השימוש ומדיניות הפרטיות, הפרטים נכונים ואני מאשר/ת את גרסה ' + TERMS_VERSION + '.'));
    form.appendChild(ackLab);
    const submit = el('button', { type: 'submit', id: 'joinSubmit' }, 'שלח/י בקשת הצטרפות');
    submit.disabled = !(user && user.emailVerified);
    form.appendChild(submit);
    if (!(user && user.emailVerified)) form.appendChild(el('p', { class: 'join-hint' }, 'הכפתור ייפתח אחרי אימות המייל.'));
    form.onsubmit = (event) => { event.preventDefault(); submitJoin(); };
    body.appendChild(form);
    restoreDraft();
    controls();
  }
  function controls() { root.querySelectorAll('button, input, select, textarea').forEach((n) => { n.disabled = state.busy || (n.id === 'joinSubmit' && !(d.currentUser() && d.currentUser().emailVerified)); }); }
  const DRAFT_TTL_MS = 30 * 60 * 1000;
  function draftKey(uid) {
    return 'resq_join_draft_v2:' + token.slice(0, 16) + ':' + (uid || 'guest');
  }
  function draftKeys() {
    const user = d.currentUser();
    const uid = user && String(user.uid || '');
    return uid ? [draftKey(uid), draftKey('')] : [draftKey('')];
  }
  function saveDraft() {
    try {
      const data = { schema_version:2, saved_at_ms:Date.now(),
        name: fields.joinName ? fields.joinName.value : '',
        phone: fields.joinPhone ? fields.joinPhone.value : '',
        note: fields.joinNote ? fields.joinNote.value : '' };
      session.set(draftKeys()[0], JSON.stringify(data));
    } catch (ignore) {}
  }
  function restoreDraft() {
    try {
      const keys = draftKeys();
      let data = null, sourceKey = '';
      for (const key of keys) {
        const value = JSON.parse(session.get(key) || 'null');
        if (value) { data = value; sourceKey = key; break; }
      }
      if (!data) return;
      if (data.schema_version !== 2 || !Number.isFinite(data.saved_at_ms) ||
          data.saved_at_ms < Date.now() - DRAFT_TTL_MS || data.saved_at_ms > Date.now() + 60000) {
        keys.forEach(key => session.remove(key)); return;
      }
      if (fields.joinName) fields.joinName.value = data.name || '';
      if (fields.joinPhone) fields.joinPhone.value = data.phone || '';
      if (fields.joinNote) fields.joinNote.value = data.note || '';
      if (sourceKey !== keys[0]) {
        session.set(keys[0], JSON.stringify(data));
        session.remove(sourceKey);
      }
    } catch (ignore) {}
  }

  /* ---------- פעולות ---------- */
  async function account(kind) {
    if (state.busy) return; state.busy = true; controls(); message('');
    try {
      const email = String(fields.joinEmail.value || '').trim().toLowerCase(), password = String(fields.joinPassword.value || '');
      if (!email || !password) throw new Error('יש להזין מייל וסיסמה.');
      if (kind === 'create' && !d.pwOk(password)) throw new Error('הסיסמה אינה עומדת בכללים המוצגים.');
      saveDraft();
      if (kind === 'create') { await d.createAccount(email, password); try { await d.sendVerification(); } catch (ignore) {} message('החשבון נוצר ונשלח מייל אימות. פתח/י את הקישור במייל וחזור/י לכאן.'); }
      else { await d.signIn(email, password); message('מחובר/ת.'); }
    } catch (error) { message('הפעולה לא הושלמה. ' + friendly(error), true); }
    finally { state.busy = false; renderForm(); }
  }
  async function verify() {
    if (state.busy) return; state.busy = true; controls();
    try { await d.sendVerification(); message('מייל אימות נשלח. פתח/י את הקישור וחזור/י לכאן.'); }
    catch (error) { message('שליחת מייל האימות נכשלה. ' + friendly(error), true); }
    finally { state.busy = false; controls(); }
  }
  async function recheck() {
    if (state.busy) return; state.busy = true; controls();
    try { await d.refreshUser(); const u = d.currentUser(); saveDraft(); renderForm(); message(u && u.emailVerified ? 'המייל מאומת. אפשר לשלוח את הבקשה.' : 'המייל עדיין לא אומת.', !(u && u.emailVerified)); }
    catch (error) { message('הבדיקה נכשלה. ' + friendly(error), true); }
    finally { state.busy = false; controls(); }
  }
  function collect() {
    const name = String(fields.joinName.value || '').trim(), phone = String(fields.joinPhone.value || '').trim();
    if (name.length < 2) throw new Error('יש להזין שם מלא.');
    if (!/^[+0-9][0-9 -]{6,}$/.test(phone)) throw new Error('יש להזין מספר טלפון תקין.');
    const shiftInput = root.querySelector('input[name="joinShift"]:checked');
    if (!shiftInput) throw new Error('יש לבחור משמרת.');
    const qualifications = [];
    root.querySelectorAll('.join-qual').forEach((row) => {
      const key = row.dataset.key; const cb = row.querySelector('input[type="checkbox"]');
      if (!cb || !cb.checked) return;
      const item = { key };
      const until = row.querySelector('input[type="date"]').value;
      if (until) { const ms = Date.parse(until + 'T23:59:59'); if (!Number.isFinite(ms) || ms <= Date.now()) throw new Error('תוקף הכשירות חייב להיות בעתיד.'); item.valid_until_ms = ms; }
      const ref = String(row.querySelector('input[type="text"]').value || '').trim();
      if (ref) item.reference = ref;
      qualifications.push(item);
    });
    if (!fields.joinAck.checked) throw new Error('יש לאשר את נכונות הפרטים ותנאי השימוש.');
    const note = String(fields.joinNote.value || '').trim();
    const payload = { request_id: '', token, full_name: name, phone, shift: shiftInput.value, qualifications,
      ack: { correctness: true, terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION } };
    if (note) payload.note = note;
    return payload;
  }
  async function submitJoin() {
    if (state.busy) return;
    saveDraft();
    let payload;
    try { payload = collect(); } catch (error) { message(error.message, true); return; }
    state.busy = true; controls(); message('שולח…');
    try {
      await d.refreshUser();
      const u = d.currentUser();
      if (!u) throw new Error('נדרשת כניסה לחשבון.');
      if (!u.emailVerified) throw new Error('כתובת המייל עדיין לא אומתה.');
      if (d.hasAssignment(await d.claims())) throw new Error('החשבון כבר משויך למערכת. אין לשלוח בקשה נוספת.');
      if (!state.requestId) { state.requestId = newRequestId(); requestStore.set(token, state.requestId); }
      payload.request_id = state.requestId;
      const result = await d.redeem(payload);
      if (!result || result.ok !== true) throw new Error('לא התקבל אישור מהשרת.');
      requestStore.clear(token); draftKeys().forEach(key => session.remove(key));
      session.remove(draftKey(''));
      stripJoinFromUrl(window);
      message(result.replayed ? 'הבקשה כבר נקלטה קודם. היא ממתינה לאישור התחנה; עדיין לא הוענקו הרשאות.' : 'הבקשה נשלחה וממתינה לאישור התחנה. עדיין לא הוענקו הרשאות.');
      await d.onRedeemed(result);
    } catch (error) {
      const reason = error && error.details && error.details.reason;
      if (reason && /^campaign-(paused|revoked|expired|full|missing)$/.test(reason)) { renderTerminal(reason.replace('campaign-', '').replace('missing', 'not_found')); return; }
      message('הבקשה לא נשלחה. ' + friendly(error), true);
    } finally { state.busy = false; controls(); }
  }
  function friendly(error) {
    const code = String((error && error.code) || '');
    if (/email-already-in-use/.test(code)) return 'המייל כבר רשום. היכנס/י לחשבון הקיים.';
    if (/wrong-password|invalid-credential|user-not-found/.test(code)) return 'מייל או סיסמה שגויים.';
    if (/weak-password/.test(code)) return 'הסיסמה חלשה מדי.';
    if (/too-many-requests|resource-exhausted/.test(code)) return 'יותר מדי ניסיונות. המתן/י מעט ונסה/י שוב.';
    if (/network|unavailable|deadline/.test(code)) return 'בעיית תקשורת. בדוק/י חיבור ונסה/י שוב.';
    return (error && error.message) || 'בדוק/י חיבור ונסה/י שוב.';
  }

  return Object.freeze({ load, rerender: () => { if (state.view && state.view.state === 'active') renderForm(); }, message });
}

/** מצב הבקשה כפי שהעובד רואה אחרי שנרשם (מסך ההמתנה). */
export function renderJoinStatus(container, status) {
  clear(container);
  if (!status || status.found !== true) { container.classList.add('hide'); return; }
  container.classList.remove('hide');
  const box = el('div', { class: 'join-status' });
  box.appendChild(el('div', { class: 'join-status-title' }, 'הבקשה שלך מהקישור הקבוצתי'));
  box.appendChild(el('div', {}, 'משמרת מבוקשת: ' + (SHIFT_HE[status.shift] || status.shift || '—')));
  if (status.review_state === 'returned') {
    const r = el('div', { class: 'join-status-returned' });
    r.appendChild(el('b', {}, 'התחנה ביקשה תיקון: '));
    r.appendChild(document.createTextNode(String(status.review_note || '')));
    r.appendChild(el('div', {}, 'לא ניתן לערוך את הבקשה מהמסך הזה; פנה/י לרכז/ת כוח האדם עם הפרטים המתוקנים.'));
    box.appendChild(r);
  } else if (status.reject_reason) {
    box.appendChild(el('div', { class: 'join-status-returned' }, 'הבקשה נדחתה: ' + String(status.reject_reason)));
  } else if (status.review_state === 'reminded') {
    box.appendChild(el('div', {}, 'התחנה שלחה תזכורת: ' + String(status.review_note || 'השלם/י את התהליך')));
  }
  const s = status.summary || {};
  box.appendChild(el('div', {}, 'כשירויות שהוצהרו: ' + ((s.verified || 0) + (s.pending || 0) + (s.declared || 0) + (s.rejected || 0) + (s.expired || 0))
    + ' · מאומתות: ' + (s.verified || 0) + ' · ממתינות: ' + ((s.pending || 0) + (s.declared || 0)) + (s.rejected ? ' · נדחו: ' + s.rejected : '')));
  container.appendChild(box);
}

/** באנר מוכנות במסך הבית — רק כשהעובד עדיין לא מוכן. */
export function renderReadinessBanner(container, readiness) {
  clear(container);
  if (!readiness || readiness.operational_ready === true || !Array.isArray(readiness.blockers)) { container.classList.add('hide'); return; }
  if (readiness.blockers.indexOf('account_not_approved') !== -1) { container.classList.add('hide'); return; }
  container.classList.remove('hide');
  const a = el('a', { class: 'join-readiness-banner', href: './device-readiness.html' });
  a.appendChild(el('span', { class: 'join-readiness-icon', 'aria-hidden': 'true' }, '🔔'));
  const t = el('span', {});
  t.appendChild(el('b', {}, 'המכשיר עדיין לא מוכן להתראות'));
  t.appendChild(document.createTextNode(' · ' + blockerText(readiness.blockers[0]) + ' · לחץ/י להשלמת ההגדרה'));
  a.appendChild(t);
  container.appendChild(a);
}
export function blockerText(code) {
  return ({
    account_not_approved: 'החשבון עדיין לא אושר', email_not_verified: 'המייל לא אומת',
    no_push_token: 'ההתראות לא הופעלו במכשיר', device_not_ready: 'בדיקת ההתראה לא הושלמה',
    push_token_changed: 'מזהה המכשיר השתנה — יש לבדוק שוב',
    qualifications_unverified: 'כשירות שהצהרת עליה ממתינה לאימות התחנה',
    qualifications_expired: 'תוקף כשירות שאומתה פג — נדרש חידוש'
  })[code] || 'נדרשת השלמה';
}
