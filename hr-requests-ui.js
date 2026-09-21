import { MEMBER_ROLES } from './roles.js?v=42h26';
import { registerPwaUpdateGuard } from './pwa.js?v=42h26';
import { retroLabel } from './hours.js?v=42h26';
import { errorText as sharedErrorText, logError } from './error-text.js?v=42h26';

const LABELS = { open: 'פתוחה', in_progress: 'בטיפול', waiting_employee: 'ממתינה לעובד', closed: 'סגורה' };
/* אוצר הסוגים זהה לזה שבשרת. המסך אינו ממציא סוג משלו
 * ואינו מקבל סוג שאינו מוכר. דוחות שעות אינם סוג כאן: הם אינם
 * חיים ב-`hr_requests` בכלל, ולכן אין להם תיבה במסך הזה. */
const KINDS = ['general', 'sick', 'reserve', 'vacation', 'extended_absence'];
const DATED_KINDS = ['sick', 'reserve', 'vacation', 'extended_absence'];
const DECISIONS = ['pending', 'approved', 'rejected'];
const FINAL_DECISIONS = ['approved', 'rejected'];
const KIND_LABELS = { general: 'פנייה כללית', sick: 'מחלה', reserve: 'מילואים',
  vacation: 'חופשה', extended_absence: 'היעדרות ממושכת' };
const DECISION_LABELS = { pending: 'ממתין להכרעה', approved: 'אושר', rejected: 'נדחה' };
const SENDING_LABEL = 'שולח…';
/* ⭐ משפט הקבלה, במקום אחד.
 *
 * מה שהוא אומר הוא מה שקרה באמת: הדיווח נשמר אצל משאבי
 * אנוש. מה שהוא במפורש אינו אומר: שהסידור עודכן. אין שום
 * כתיבה לסידור במסלול הזה, ומשפט שהיה מרמז על כך היה שולח
 * כבאי הביתה בהנחה שהוא משובץ — והוא משובץ. */
const REPORT_RECEIPT = 'הדיווח התקבל במשאבי אנוש וממתין לטיפול. אפשר לצרף אישור עכשיו או בהמשך.';
const BOXES = [['box-sick', 'sick'], ['box-reserve', 'reserve'], ['box-vacation', 'vacation'],
  ['box-extended', 'extended_absence']];
const BOX_KINDS = BOXES.map(([, kind]) => kind);
/* ⭐ כותרות המונים — ושני הצירים נשארים נפרדים.
 *
 * „ממתין" בציר ההכרעה אינו „פתוחה" בציר הטיפול: פנייה יכולה
 * להיות בטיפול ולהמתין להכרעה באותו זמן, ויכולה להיסגר
 * בלי שאושרה. איחוד שני הצירים למספר אחד היה מוה בדיוק את
 * מה שהשרת טורח להפריד. */
const COUNT_ROWS = [['decision', 'pending', 'ממתינים להכרעה'],
  ['status', 'open', 'פתוחות'], ['status', 'in_progress', 'בטיפול'],
  ['status', 'waiting_employee', 'ממתינות לעובד'],
  ['decision', 'approved', 'אושרו'], ['decision', 'rejected', 'נדחו'],
  ['status', 'closed', 'נסגרו']];
const STATUS_TOTAL = ['open', 'in_progress', 'waiting_employee'];
const number = new Intl.NumberFormat('he-IL');
const dayCount = (from, to) => {
  const start = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 86400000) + 1;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const kindOf = c => (c && c.kind === undefined ? 'general' : c && c.kind);
const stamp = ms => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem',
  dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
const KEY = /^[a-f0-9]{64}$/;
const disconnected = { currentSession: () => null, subscribeIdentity: () => () => {} };
const node = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = String(text); if (className) e.className = className; return e; };
const manager = s => s?.super === true || s?.role === 'hr_coordinator';
const member = s => s && typeof s.uid === 'string' && !!s.uid && typeof s.stationId === 'string' && !!s.stationId
  && (s.super === true || MEMBER_ROLES.includes(s.role));
/* ⭐ מה שהמסך מציג על דיווח הוא הכרעה של מישהו על היעדרות של
 * אדם. לכן הצורה נבדקת עד הסוף: סוג מוכר, טווח תקין, הכרעה
 * מהאוצר, ומי הכריע ומתי רק כשיש הכרעה סופית. תשובה חלקית
 * נדחית ולא מוצגת חצי — אישור שמוצג בלי מי ומתי גרוע מכלום. */
const validReport = c => {
  const kind = kindOf(c);
  if (!KINDS.includes(kind)) return false;
  if (!DATED_KINDS.includes(kind)) {
    return !Object.hasOwn(c, 'from_date') && !Object.hasOwn(c, 'to_date') && !Object.hasOwn(c, 'decision');
  }
  if (typeof c.from_date !== 'string' || !DATE.test(c.from_date)
    || typeof c.to_date !== 'string' || !DATE.test(c.to_date) || c.to_date < c.from_date) return false;
  if (!DECISIONS.includes(c.decision)) return false;
  return FINAL_DECISIONS.includes(c.decision)
    ? typeof c.decided_by === 'string' && !!c.decided_by && Number.isSafeInteger(c.decided_at_ms) && c.decided_at_ms > 0
    : !Object.hasOwn(c, 'decided_by') && !Object.hasOwn(c, 'decided_at_ms');
};
/* שם ומשמרת מגיעים לתיבת משאבי אנוש בלבד, ולכן הם אופציונליים
 * בבדיקה. מה שכן הגיע חייב להיות מהצורה הנכונה: שדה שהגיע
 * פגום אינו מוצג „כמות שהוא". */
const validPerson = c => (!Object.hasOwn(c, 'owner_name') || (typeof c.owner_name === 'string' && c.owner_name.length <= 160))
  && (!Object.hasOwn(c, 'owner_crew') || (typeof c.owner_crew === 'string' && c.owner_crew.length <= 40));
const validSummary = c => c && KEY.test(c.case_id) && typeof c.owner_uid === 'string' && !!c.owner_uid
  && typeof c.subject === 'string' && c.subject.length <= 80 && Object.hasOwn(LABELS, c.status)
  && (!Object.hasOwn(c, 'has_attachment') || typeof c.has_attachment === 'boolean')
  && validPerson(c)
  && Number.isSafeInteger(c.revision) && c.revision > 0 && validReport(c);
const definite = new Set(['invalid-argument', 'already-exists', 'aborted', 'not-found', 'failed-precondition', 'resource-exhausted', 'permission-denied', 'unauthenticated']);
const errorCode = error => String(error?.code || '').replace(/^functions\//, '');
const errorMessage = (code, error) => ({ aborted: 'הפנייה השתנתה. רעננו אותה, בדקו את העדכון ואת הטיוטה, ואז שמרו שוב.',
  'already-exists': 'מזהה הבקשה כבר שימש לפעולה אחרת. רעננו ובדקו את הפנייה לפני פעולה חדשה.',
  'resource-exhausted': 'בוצעו פעולות רבות בזמן קצר. המתינו מעט לפני ניסיון נוסף.',
  'failed-precondition': 'לא ניתן לבצע את הפעולה במצב הנוכחי. רעננו ובדקו את הפנייה.',
  'not-found': 'הפנייה אינה זמינה. רעננו את רשימת הפניות.',
  'invalid-argument': 'בדקו את הנושא והתוכן ואת אורך הטקסט לפני שמירה.' })[code]
  /* ⭐ מה שאין לו ניסוח מקומי טוב יותר יורד למילון המשותף. כך
   * „פג תוקף ההתחברות" נאמר באותן מילים בכל מסך, ושום קוד אינו
   * מגיע למסך רק מפני ששכחו להוסיף אותו למפה המקומית. */
  || sharedErrorText(error);

export function createHrRequestsUI(root, adapter = disconnected) {
  const q = key => root.querySelector('[data-r="' + key + '"]');
  let owner = null, generation = 0, listGeneration = 0, detailGeneration = 0;
  let mode = 'mine', items = [], cursor = null, selected = null, events = [], eventCursor = null;
  let listLoading = false, detailLoading = false, busy = false, pending = null, creating = false, disposed = false;
  let boxCounts = null, countsLoading = false, countsGeneration = 0;
  let attachments = null, attachmentOrigin = null, attachmentLocked = false, attachmentRefresh = false;
  let attachmentSyncing = false, suspended = false;
  const attachmentHost = q('attachments');
  const removers = [];
  const on = (target, event, fn) => { target.addEventListener(event, fn); removers.push(() => target.removeEventListener(event, fn)); };
  const message = text => { q('message').textContent = text; };
  function session() { try { const s = adapter.currentSession(); return member(s) ? s : null; } catch (_) { return null; } }
  function alive(g, s) {
    if (disposed || suspended) return false;
    if (session() !== owner) { resetIdentity(); return false; }
    return !!s && s === owner && g === generation;
  }
  const draftKind = () => (KINDS.includes(q('kind').value) ? q('kind').value : 'general');
  const draftDated = () => DATED_KINDS.includes(draftKind());
  function dirty() {
    return !!(q('subject').value || q('body').value || q('reply').value
      || (draftDated() && (q('from-date').value || q('to-date').value)));
  }
  function clearDrafts() {
    q('subject').value = ''; q('body').value = ''; q('reply').value = ''; q('send-now').checked = false;
    q('kind').value = 'general'; q('from-date').value = ''; q('to-date').value = ''; syncKind();
  }
  /* הטופס משתנה לפי הסוג, ואיתו גם ה-`required`: שדה חובה
   * מוסתר הוא טופס שלעולם לא נשלח, בלי שהמשתמש ידע למה.
   * בדיווח הנושא נגזר מהסוג ומהתאריכים שהעובד מילא,
   * וההערה אינה חובה — התאריכים הם הדיווח. */
  function syncKind() {
    const dated = draftDated();
    q('dates').hidden = !dated;
    q('subject-label').hidden = dated;
    q('subject').required = !dated;
    q('from-date').required = dated; q('to-date').required = dated;
    q('body').required = !dated;
    q('report-note').hidden = !dated;
    q('create-title').textContent = dated ? 'דיווח חדש' : 'פנייה חדשה';
    q('body-label').firstChild.textContent = dated ? 'הערה (לא חובה) ' : 'תוכן הפנייה ';
    renderSummary();
  }
  const childLocked = () => attachmentLocked || attachmentRefresh;
  const unregisterUpdateGuard = registerPwaUpdateGuard(() =>
    pending || busy || creating || childLocked() || dirty()
      ? { safe:false, reason:'יש טיוטת פנייה או צירוף שעדיין לא נשמרו.' }
      : { safe:true });
  function clearAttachments() {
    attachmentOrigin = null;
    if (attachmentHost) attachmentHost.hidden = true;
    if (!attachments) return;
    attachmentSyncing = true;
    try { attachments.setContext(null); } finally { attachmentSyncing = false; }
  }
  function syncAttachments() {
    if (!attachments || attachmentSyncing || disposed) return;
    // A child's own pending operation must never invalidate its own context.
    if (attachmentLocked) return;
    if (!owner || suspended || attachmentRefresh || busy || pending || listLoading || detailLoading || creating || !selected) {
      if (attachmentOrigin) clearAttachments();
      return;
    }
    /* ⭐ `canRemove` — רק בעל הפנייה. אין כאן תנאי סטטוס בכוונה:
     * השרת אינו אוכף אחד, ומסך שמוסיף כלל שאין בשרת הוא כלל שקוף
     * שאיש לא יידע עליו. הכפתור עצמו מופיע רק לקובץ שהמשתמש העלה,
     * וההרשאה נאכפת בשרת בכל מקרה. */
    const next = { session: owner, generation, detailGeneration, id: selected.case_id, revision: selected.revision,
      canUpload: selected.status !== 'closed',
      canRemove: !!owner && selected.owner_uid === owner.uid };
    if (attachmentOrigin && attachmentOrigin.session === next.session && attachmentOrigin.generation === next.generation
      && attachmentOrigin.detailGeneration === next.detailGeneration && attachmentOrigin.id === next.id
      && attachmentOrigin.revision === next.revision && attachmentOrigin.canUpload === next.canUpload
      && attachmentOrigin.canRemove === next.canRemove) return;
    attachmentOrigin = next; attachmentHost.hidden = false;
    attachmentSyncing = true;
    try { attachments.setContext({ parent_kind: 'request', parent_id: next.id, parent_revision: next.revision,
      canUpload: next.canUpload, canRemove: next.canRemove }); }
    finally { attachmentSyncing = false; }
  }
  async function attachmentPublished(result) {
    const origin = attachmentOrigin;
    if (!origin || !alive(origin.generation, origin.session) || detailGeneration !== origin.detailGeneration
      || selected?.case_id !== origin.id || attachmentRefresh || !KEY.test(result?.attachment_id || '')
      || !Number.isSafeInteger(result?.revision) || result.revision < 1) return;
    attachmentRefresh = true;
    clearAttachments(); controls();
    message('הקובץ צורף. מרענן את הפנייה; אין בכך אישור לשליחה או לקבלת התראה.');
    try {
      await Promise.all([loadList(), openCase(origin.id, false, true)]);
      if (!alive(origin.generation, origin.session)) return;
      message(selected?.case_id === origin.id ? 'הקובץ צורף והפנייה רועננה. אין אישור למסירת התראה.'
        : 'הקובץ צורף, אך רענון הפנייה אינו זמין כרגע. רעננו כדי לבדוק; אין להעלות שוב בגלל כשל הרענון.');
    } finally {
      if (alive(origin.generation, origin.session)) { attachmentRefresh = false; controls(); }
    }
  }
  function mayNavigate() {
    if (!alive(generation, owner) || busy || pending || childLocked()) return false;
    if (dirty() && !window.confirm('הטיוטה טרם נשמרה. לעבור ולמחוק את הטיוטה?')) return false;
    clearDrafts(); return true;
  }
  function controls() {
    const locked = !owner || busy || !!pending || childLocked();
    q('workspace').hidden = !owner; q('login').hidden = !!owner;
    /* תיבות העבודה של משאבי אנוש. „כל הפניות" נשארת כפי שהיתה,
     * והיא גם המקום היחיד שבו פנייה שנכתבה לפני שהשדה קיים עדיין
     * נראית. דוחות שעות אינם תיבה כאן ולא יהיו: הם במסך אחר ובאוסף אחר. */
    const hr = manager(owner);
    q('inbox').hidden = !hr;
    /* הכניסה החמישית היא קישור, לא תיבה: דוחות השעות
     * חיים באוסף אחר לגמרי, והמסך הזה אינו שואל אותו דבר.
     * מונה על הקישור היה מחייב לשאול — וזה בדיוק העירוב
     * שההפרדה נועדה למנוע. לכן הוא מפנה ואינו מספר. */
    q('box-hours').hidden = !hr;
    q('mine').setAttribute('aria-pressed', String(mode === 'mine')); q('inbox').setAttribute('aria-pressed', String(mode === 'inbox'));
    for (const [key, kind] of BOXES) { q(key).hidden = !hr; q(key).setAttribute('aria-pressed', String(mode === kind)); }
    q('list-title').textContent = mode === 'mine' ? 'הפניות שלי'
      : mode === 'inbox' ? 'תיבת משאבי אנוש' : 'תיבת ' + KIND_LABELS[mode];
    for (const key of ['mine', 'inbox', ...BOX_KINDS.map((_, i) => BOXES[i][0]), 'refresh', 'new',
      'kind', 'from-date', 'to-date', 'subject', 'body', 'reply', 'status', 'send-now', 'save']) q(key).disabled = locked;
    renderCounts();
    renderSummary();
    /* ⭐ שלושה אותות על אותה עובדה: הכפתור חסום, הטקסט
     * אומר „שולח…", ו-`aria-busy` מדווח אותה לקורא מסך. חסימה
     * לבדה נראית כמו כפתור שלא עבד. */
    const sending = busy || !!pending;
    q('save').textContent = sending ? SENDING_LABEL : draftDated() ? 'שליחת הדיווח' : 'שמירת הפנייה והמשך לצירוף קובץ';
    q('save').setAttribute('aria-busy', String(sending));
    q('reply-save').setAttribute('aria-busy', String(sending));
    q('more').hidden = !cursor; q('more').disabled = locked || listLoading;
    q('events-more').hidden = !eventCursor || creating; q('events-more').disabled = locked || detailLoading;
    q('create').hidden = !creating; q('detail').hidden = creating;
    const usable = !!selected && !creating && !detailLoading;
    q('reply-form').hidden = !usable || selected.status === 'closed';
    q('reply-save').disabled = locked || !usable;
    q('actions').hidden = !usable;
    q('status-label').hidden = !manager(owner); q('status-save').hidden = !manager(owner);
    q('status-save').disabled = locked || !usable;
    const ownerSide = selected?.owner_uid === owner?.uid;
    const eligible = usable && (ownerSide ? ['open', 'in_progress'].includes(selected.status) : manager(owner) && selected.status === 'waiting_employee');
    q('nudge').hidden = !eligible; q('nudge').disabled = locked || !eligible;
    /* ⭐ הכרעה היא סמכות משאבי אנוש בלבד, ואיש אינו מכריע
     * בעניין של עצמו. השרת אוכף את שניהם; כאן הכפתור פשוט אינו
     * מוצג, כדי שלא ייראה שאפשר ואז ייכשל. */
    const decidable = usable && DATED_KINDS.includes(kindOf(selected));
    const mayDecide = decidable && manager(owner) && selected.owner_uid !== owner.uid;
    for (const [key, decision] of [['approve', 'approved'], ['reject', 'rejected']]) {
      q(key).hidden = !mayDecide;
      q(key).disabled = locked || !mayDecide || selected.decision === decision;
    }
    q('notification').hidden = !owner || (!creating && !usable);
    q('pending').hidden = !pending || busy; q('retry').disabled = busy || !owner || childLocked();
    for (const button of q('list').querySelectorAll('button')) button.disabled = locked;
    syncAttachments();
  }
  /* תגית סטטוס: המילה העברית המדויקת שהשרת מכיר, והצבע
   * מגיע מ-`data-state` ב-CSS. הטקסט לא משתנה עם הצבע, ולכן
   * הוא נשאר הערוץ היחיד שחייבים לקרוא. */
  function stateTag(status, tag = 'span') {
    const element = node(tag, LABELS[status], 'requests-tag');
    element.dataset.state = status;
    return element;
  }
  function decisionTag(decision) {
    const element = node('span', DECISION_LABELS[decision], 'requests-decision');
    element.dataset.decision = decision;
    return element;
  }
  /* שורת רשימה: מה שצריך להיות בה כדי שאפשר לטפל בלי
   * לפתוח אותה — מי, מאיזו משמרת, לאיזה טווח, האם יש אישור
   * מצורף, והיכן הדבר עומד.
   *
   * שם ומשמרת מוצגים רק כשהשרת שלח אותם, והוא שולח אותם
   * לתיבת משאבי אנוש בלבד. המסך אינו ממציא שם מ-uid ואינו
   * מציג uid במקומו: uid על המסך הוא מזהה פנימי שדלף. */
  function rowMeta(item) {
    const meta = node('span', null, 'requests-row-meta');
    const kind = kindOf(item);
    if (item.owner_name) meta.append(node('span', item.owner_name));
    if (item.owner_crew) meta.append(node('span', item.owner_crew));
    if (DATED_KINDS.includes(kind)) {
      meta.append(node('span', KIND_LABELS[kind]));
      meta.append(node('span', item.from_date + ' — ' + item.to_date));
      const days = dayCount(item.from_date, item.to_date);
      if (days) meta.append(node('span', days === 1 ? 'יום אחד' : number.format(days) + ' ימים'));
    }
    if (item.has_attachment === true) meta.append(node('span', 'אישור מצורף', 'requests-row-file'));
    return meta;
  }
  function renderList() {
    q('list').replaceChildren();
    for (const item of items) {
      const b = node('button'); b.type = 'button'; b.dataset.case = item.case_id;
      b.setAttribute('aria-pressed', String(selected?.case_id === item.case_id));
      const head = node('span'); head.append(node('strong', item.subject));
      b.append(head);
      const meta = rowMeta(item);
      if (meta.childNodes.length) b.append(meta);
      const tags = node('span');
      tags.append(stateTag(item.status));
      if (DATED_KINDS.includes(kindOf(item))) tags.append(decisionTag(item.decision));
      b.append(tags);
      const g = generation, s = owner;
      b.addEventListener('click', () => { if (alive(g, s) && mayNavigate()) void openCase(item.case_id); });
      q('list').append(b);
    }
    if (!items.length) q('list').append(node('p', listLoading ? 'טוען פניות…' : 'אין פניות להצגה.'));
    controls();
  }
  /* ⭐ מוני התיבות. המספר על הכפתור הוא „מה פתוח אצלך"
   * — סכום שלושת מצבי הטיפול שאינם סגורים, ולא סך הכל
   * היסטורי. הפירוט המלא של שני הצירים יושב ב-`aria-label`
   * וב-`title`, כדי שהכפתור יישאר כפתור ולא טבלה. */
  function renderCounts() {
    const hr = manager(owner);
    q('counts-note').hidden = !(hr && boxCounts && boxCounts.drift);
    if (hr && boxCounts && boxCounts.drift) {
      q('counts-note').textContent = 'המונים על התיבות משוערים כרגע: נמצאה אי-התאמה בספירה. הרשימה בתוך כל תיבה מדויקת.';
    }
    for (const [key, kind] of BOXES) {
      const badge = q('count-' + kind);
      const row = boxCounts && boxCounts.boxes ? boxCounts.boxes[kind] : null;
      if (!hr || !row) {
        badge.textContent = ''; badge.removeAttribute('data-live');
        q(key).removeAttribute('aria-label'); q(key).removeAttribute('title');
        continue;
      }
      const openNow = STATUS_TOTAL.reduce((sum, state) => sum + (row.status[state] || 0), 0);
      badge.textContent = number.format(openNow);
      badge.dataset.live = String(openNow > 0);
      const detail = COUNT_ROWS.map(([axis, value, label]) =>
        label + ' ' + number.format((row[axis] || {})[value] || 0)).join(' · ');
      const full = 'תיבת ' + KIND_LABELS[kind] + ' · ' + detail
        + (boxCounts.drift ? ' · המונים משוערים' : '');
      q(key).setAttribute('aria-label', full);
      q(key).setAttribute('title', full);
    }
  }
  async function loadCounts() {
    if (!manager(owner) || typeof adapter.counts !== 'function' || countsLoading) return;
    const g = generation, s = owner, c = ++countsGeneration;
    countsLoading = true;
    try {
      const result = await adapter.counts({});
      if (!alive(g, s) || c !== countsGeneration) return;
      /* תשובה שאינה בצורה הנכונה אינה מוצגת חלקית. מונה
       * שגוי גרוע מאין מונה, כי מספר נראה כמו עובדה. */
      const ok = !!result && !!result.boxes && typeof result.drift === 'boolean'
        && BOX_KINDS.every(kind => {
          const row = result.boxes[kind];
          return !!row && !!row.status && !!row.decision
            && Object.keys(LABELS).every(state => Number.isSafeInteger(row.status[state]) && row.status[state] >= 0)
            && DECISIONS.every(value => Number.isSafeInteger(row.decision[value]) && row.decision[value] >= 0);
        });
      boxCounts = ok ? result : null;
    } catch (error) { if (alive(g, s) && c === countsGeneration) { logError('hr request counts', error); boxCounts = null; } }
    finally { if (alive(g, s) && c === countsGeneration) { countsLoading = false; controls(); } }
  }
  /* ⭐ סיכום לפני שליחה — בתוך הטופס, ובלחיצה אחת.
   *
   * למה לא דיאלוג אישור: צעד שני אינו נקרא, הוא נלחץ. מה
   * שבאמת מונע דיווח שגוי הוא לראות את הטווח ואת מספר
   * הימים כתובים לפני הלחיצה — לא לאשר עוד פעם שבאמת רוצים
   * לשלוח. מספר הימים הוא השדה שתופס טעות הקלדה בתאריך. */
  function renderSummary() {
    const target = q('summary');
    if (!creating || !draftDated()) { target.hidden = true; target.replaceChildren(); return; }
    const from = q('from-date').value, to = q('to-date').value;
    const days = from && to ? dayCount(from, to) : null;
    target.replaceChildren();
    target.append(node('h3', 'לפני השליחה'));
    const list = node('dl');
    const line = (term, value) => { list.append(node('dt', term), node('dd', value)); };
    line('סוג הדיווח', KIND_LABELS[draftKind()]);
    line('טווח', from && to ? from + ' — ' + to : 'טרם הוזן');
    line('מספר ימים', days ? (days === 1 ? 'יום אחד' : number.format(days) + ' ימים')
      : from && to ? 'הטווח אינו תקין' : 'טרם הוזן');
    line('הערה', q('body').value.trim() ? 'צורפה הערה' : 'ללא הערה');
    line('אישור', 'ניתן לצרף אחרי השליחה');
    target.append(list);
    target.hidden = false;
  }
  /* שורות הדיווח: סוג, טווח, מצב ההכרעה, מי הכריע ומתי.
   *
   * ⭐ „רטרואקטיבי" נגזר ואינו דגל: ההפרש בין תחילת הטווח
   * לבין הרגע שהשרת חתם על פתיחת הדיווח. אותה גזירה בדיוק
   * כמו בדיווח הנוכחות, ומאותה פונקציה. */
  function reportLines() {
    const lines = [node('p', KIND_LABELS[kindOf(selected)] + ' · ' + selected.from_date + ' — ' + selected.to_date, 'requests-tag')];
    const retro = retroLabel(selected.from_date, { reported_at: new Date(selected.created_at_ms) });
    if (retro) lines.push(node('p', retro, 'requests-note'));
    lines.push(node('p', 'מצב הדיווח: ' + DECISION_LABELS[selected.decision], 'requests-note'));
    if (FINAL_DECISIONS.includes(selected.decision)) {
      const by = selected.decided_by === owner.uid ? 'אני' : 'משאבי אנוש';
      lines.push(node('p', 'הכריע: ' + by + ' · ' + stamp(selected.decided_at_ms), 'requests-note'));
    }
    /* „אין קובץ" נאמר רק כשהוא ידוע בוודאות: כל היומן לפנינו
     * (`eventCursor === null`). ביומן מעודף אנחנו פשוט לא יודעים,
     * ועדיף לא לומר מאשר לומר משהו שאינו נכון. */
    const removed = Array.isArray(selected.removed_attachment_ids) ? selected.removed_attachment_ids : [];
    const hasFile = events.some(e => e.kind === 'attachment' && !removed.includes(e.attachment_id));
    if (selected.owner_uid === owner.uid && eventCursor === null && !hasFile) {
      lines.push(node('p', REPORT_RECEIPT, 'requests-note'));
    }
    return lines;
  }
  function renderDetail() {
    const target = q('detail'); target.replaceChildren();
    if (!selected) { target.append(node('p', detailLoading ? 'טוען פנייה…' : 'בחרו פנייה או פתחו פנייה חדשה.')); controls(); return; }
    target.append(node('h2', selected.subject), stateTag(selected.status));
    if (DATED_KINDS.includes(kindOf(selected))) {
      target.append(decisionTag(selected.decision));
      target.append(...reportLines());
    }
    if (selected.status === 'closed') target.append(node('p', 'הפנייה סגורה. משאבי אנוש יכולים לפתוח אותה מחדש; אפשר גם ליצור פנייה חדשה.', 'requests-note'));
    for (const event of events) {
      const entry = node('article', null, 'requests-event');
      const by = event.actor_uid === owner.uid ? 'אני' : event.actor_uid === selected.owner_uid ? 'העובד שפנה' : 'משאבי אנוש';
      const kind = { create: 'פתיחת פנייה', reply: 'תגובה', setStatus: 'עדכון מצב', nudge: 'בקשת תזכורת',
        attachment: 'נוסף קובץ לפנייה', removeAttachment: 'הוסר קובץ מהפנייה',
        setDecision: 'הכרעה בדיווח' }[event.kind];
      entry.append(node('small', by + ' · ' + kind));
      if (event.text !== undefined) entry.append(node('p', event.text));
      if (event.kind === 'removeAttachment' && event.attachment_display_name !== undefined) {
        entry.append(node('p', 'הקובץ: ' + event.attachment_display_name));
      }
      if (event.to_status) entry.append(node('p', LABELS[event.from_status] + ' ← ' + LABELS[event.to_status]));
      target.append(entry);
    }
    q('status').value = selected.status; controls();
  }
  async function loadList(append = false) {
    if (attachmentLocked) return;
    const g = generation, s = owner, l = ++listGeneration, originMode = mode;
    if (!alive(g, s)) return;
    listLoading = true; controls();
    try {
      const result = await adapter[originMode === 'mine' ? 'list' : 'listInbox']({
        ...(append && cursor ? { cursor } : {}),
        ...(BOX_KINDS.includes(originMode) ? { kind: originMode } : {}) });
      if (!alive(g, s) || l !== listGeneration || mode !== originMode) return;
      if (!result || !Array.isArray(result.items) || result.items.length > 25 ||
        !(result.next_cursor === null || (typeof result.next_cursor === 'string' && KEY.test(result.next_cursor)))) throw new Error('invalid list');
      const merged = append ? items.concat(result.items) : result.items;
      /* ⭐ המסך אינו מאמין לשרת על התיבה שהוא עצמו מציג: דיווח מחלה
       * שיגיע לתיבת המילואים יפסול את העמוד, ולא יוצג תחת כותרת
       * שאומרת משהו אחר. */
      if (merged.some(c => !validSummary(c) || (originMode === 'mine' && c.owner_uid !== s.uid)
        || (BOX_KINDS.includes(originMode) && kindOf(c) !== originMode)) ||
        new Set(merged.map(c => c.case_id)).size !== merged.length) throw new Error('invalid summaries');
      items = merged; cursor = result.next_cursor; renderList();
    } catch (_) {
      if (alive(g, s) && l === listGeneration) { items = []; cursor = null; renderList(); message('רשימת הפניות אינה זמינה כרגע. נסו לרענן.'); }
    } finally { if (alive(g, s) && l === listGeneration) { listLoading = false; controls(); } }
  }
  function checkedDetail(result, id, s) {
    if (!validSummary(result) || result.case_id !== id || (!manager(s) && result.owner_uid !== s.uid) ||
      !Array.isArray(result.events) || result.events.length > 25 ||
      !(result.next_cursor === null || (Number.isSafeInteger(result.next_cursor) && result.next_cursor > 0))) throw new Error('invalid detail');
    for (const e of result.events) {
      if (!e || !KEY.test(e.event_id) || typeof e.actor_uid !== 'string' ||
        /* ⭐ שתי שורות יומן נוספו בשרת: הסרת קובץ והכרעה בדיווח.
       * כל עוד הן חסרות כאן, הסרה אחת היתה פוסלת את כל קריאת
       * הפנייה ומשאירה את המסך עם „הפנייה אינה זמינה". */
      !['create', 'reply', 'setStatus', 'nudge', 'attachment', 'removeAttachment', 'setDecision'].includes(e.kind) || !Number.isSafeInteger(e.revision) || e.revision < 1 || e.revision > result.revision ||
        (['attachment', 'removeAttachment'].includes(e.kind) && (typeof e.attachment_id !== 'string' || !KEY.test(e.attachment_id))) ||
        (e.attachment_display_name !== undefined && (typeof e.attachment_display_name !== 'string' || e.attachment_display_name.length > 200)) ||
        (e.text !== undefined && (typeof e.text !== 'string' || e.text.length > 1000)) ||
        (e.kind === 'setStatus' && (!Object.hasOwn(LABELS, e.from_status) || !Object.hasOwn(LABELS, e.to_status)))) throw new Error('invalid event');
    }
    return result;
  }
  async function openCase(id, append = false, keepDraft = false) {
    if (attachmentLocked) return;
    const g = generation, s = owner, d = ++detailGeneration;
    if (!alive(g, s)) return;
    const previousEvents = append ? events : [], after = append ? eventCursor : null;
    creating = false; if (!keepDraft) q('reply').value = ''; q('send-now').checked = false;
    if (!append) { selected = null; events = []; eventCursor = null; }
    detailLoading = true; renderDetail();
    try {
      const result = await adapter.get({ case_id: id, ...(after ? { cursor: after } : {}) });
      if (!alive(g, s) || d !== detailGeneration) return;
      checkedDetail(result, id, s);
      const merged = previousEvents.concat(result.events);
      if (merged.some((e, i) => i && e.revision <= merged[i - 1].revision) || new Set(merged.map(e => e.event_id)).size !== merged.length) throw new Error('invalid history');
      selected = result; events = merged; eventCursor = result.next_cursor; renderDetail(); renderList();
    } catch (_) {
      if (alive(g, s) && d === detailGeneration) { selected = null; events = []; eventCursor = null; renderDetail(); message('הפנייה אינה זמינה כרגע. נסו לבחור אותה שוב.'); }
    } finally { if (alive(g, s) && d === detailGeneration) { detailLoading = false; controls(); } }
  }
  function newRequestId() {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return 'hr-' + [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  /* בדיווח הנושא אינו שדה שהעובד ממלא — הוא נגזר משלושת
   * השדות שהוא כן מילא. אין כאן המצאה של תוכן: זו אותה
   * הצהרה בדיוק, כתובה בשורה אחת. */
  const draftSubject = () => (draftDated()
    ? KIND_LABELS[draftKind()] + ' · ' + q('from-date').value + ' — ' + q('to-date').value
    : q('subject').value);
  async function submit(method, value) {
    if (!alive(generation, owner) || busy || pending || childLocked()) return;
    if (method !== 'create' && (!selected || detailLoading)) return;
    if ((method === 'setStatus' || method === 'setDecision') && !manager(owner)) return;
    if (method === 'setDecision' && (!FINAL_DECISIONS.includes(value) || selected.owner_uid === owner.uid
      || !DATED_KINDS.includes(kindOf(selected)))) return;
    const payload = { request_id: newRequestId(), send_now: q('send-now').checked,
      ...(method === 'create' ? { subject: draftSubject(), text: q('body').value, kind: draftKind(),
        ...(draftDated() ? { from_date: q('from-date').value, to_date: q('to-date').value } : {}) }
        : { case_id: selected.case_id, expected_revision: selected.revision,
          ...(method === 'reply' ? { text: q('reply').value } : method === 'setStatus' ? { status: q('status').value }
            : method === 'setDecision' ? { decision: value } : {}) }) };
    pending = Object.freeze({ method, payload: Object.freeze(payload), session: owner, generation });
    await perform();
  }
  async function perform() {
    const operation = pending;
    if (!operation || busy || childLocked() || !alive(operation.generation, operation.session)) return;
    busy = true; controls(); message('שומר את הבקשה…');
    try {
      const result = await adapter[operation.method](operation.payload);
      if (!alive(operation.generation, operation.session) || pending !== operation) return;
      if (!result || !KEY.test(result.case_id) || !Number.isSafeInteger(result.revision) || result.revision < 1 ||
        !Object.hasOwn(LABELS, result.status) || !['saved', 'no_change', 'confirmation_required'].includes(result.outcome) ||
        (operation.method !== 'create' && result.case_id !== operation.payload.case_id)) throw new Error('uncertain result');
      pending = null; q('send-now').checked = false;
      if (result.outcome === 'confirmation_required') {
        message('לא נוצרה תזכורת. זו שעת לילה: סמנו בקשת התראה כעת ולחצו שוב אם ברצונכם לבקש תזכורת עכשיו.'); controls(); return;
      }
      const openedReport = operation.method === 'create' && DATED_KINDS.includes(operation.payload.kind);
      if (operation.method === 'create') {
        q('subject').value = ''; q('body').value = ''; q('from-date').value = ''; q('to-date').value = '';
        q('kind').value = 'general'; syncKind();
      }
      if (operation.method === 'reply') q('reply').value = '';
      const savedMessage = result.outcome === 'no_change' ? 'המצב כבר מעודכן; לא נוצרה התראה נוספת.'
        : result.notification_status === 'suppressed' ? 'הפעולה נשמרה. ההתראה דוכאה בשל מצב שקט.'
          : result.notification_status === 'no_other_recipient' ? 'הפעולה נשמרה. לא נדרשה התראה לעצמך.'
            : 'הפעולה נשמרה. בקשת ההתראה ממתינה לטיפול; אין אישור לשליחה או לקבלה.';
      /* ⭐ המשפט הזה קיים כדי שאיש לא יחשוב שהדיווח „לא נקלט" רק
       * מפני שעדיין לא צירף אישור. הדיווח נפתח; הקובץ הוא המשך. */
      message(openedReport ? REPORT_RECEIPT : savedMessage);
      await Promise.all([loadList(), loadCounts(),
        openCase(result.case_id, false, !['create', 'reply'].includes(operation.method))]);
      // Read failures keep their explicit message; no optimistic delivery claim.
    } catch (error) {
      if (!alive(operation.generation, operation.session) || pending !== operation) return;
      const code = errorCode(error);
      logError('hr request ' + operation.method, error);
      if (definite.has(code)) { pending = null; q('send-now').checked = false; message(errorMessage(code, error)); }
      else message('תוצאת השמירה אינה ידועה. לחצו ניסיון חוזר כדי לברר באותה בקשה בדיוק.');
    } finally { if (alive(operation.generation, operation.session)) { busy = false; controls(); } }
  }
  function resetIdentity() {
    // Parent subscriber runs first, before the child could reload an old parent.
    clearAttachments(); attachmentLocked = false; attachmentRefresh = false;
    owner = suspended ? null : session(); ++generation; ++listGeneration; ++detailGeneration;
    mode = 'mine'; items = []; cursor = null; selected = null; events = []; eventCursor = null;
    pending = null; busy = false; listLoading = false; detailLoading = false; creating = false;
    boxCounts = null; countsLoading = false; ++countsGeneration;
    clearDrafts(); renderList(); renderDetail();
    message(owner ? 'בחרו פנייה או פתחו פנייה חדשה.' : 'ממתין לחיבור מאובטח כעובד תחנה פעיל.');
    if (owner && !disposed) { void loadList(); void loadCounts(); }
  }
  const changeMode = next => {
    if ((next !== 'mine' && !manager(owner)) || !mayNavigate()) return;
    ++generation; ++detailGeneration; mode = next; items = []; cursor = null; selected = null; events = []; eventCursor = null; creating = false;
    renderList(); renderDetail(); message('טוען פניות…'); void loadList(); void loadCounts();
  };
  on(q('mine'), 'click', () => changeMode('mine')); on(q('inbox'), 'click', () => changeMode('inbox'));
  for (const [key, kind] of BOXES) on(q(key), 'click', () => changeMode(kind));
  on(q('kind'), 'change', () => { syncKind(); });
  for (const key of ['from-date', 'to-date', 'body']) on(q(key), 'input', () => { renderSummary(); });
  on(q('new'), 'click', () => { if (!mayNavigate()) return; ++detailGeneration; selected = null; events = []; eventCursor = null; detailLoading = false; creating = true; renderList(); renderDetail(); q('subject').focus(); });
  on(q('refresh'), 'click', () => { if (!alive(generation, owner) || busy || pending || childLocked()) return; const id = selected?.case_id; void loadList(); void loadCounts(); if (id) void openCase(id, false, true); });
  on(q('more'), 'click', () => { if (!busy && !pending && !childLocked() && cursor) void loadList(true); });
  on(q('events-more'), 'click', () => { if (!busy && !pending && !childLocked() && selected && eventCursor) void openCase(selected.case_id, true, true); });
  on(q('create'), 'submit', e => { e.preventDefault(); if (q('create').reportValidity()) void submit('create'); });
  on(q('reply-form'), 'submit', e => { e.preventDefault(); if (q('reply-form').reportValidity()) void submit('reply'); });
  on(q('status-save'), 'click', () => { void submit('setStatus'); });
  on(q('nudge'), 'click', () => { void submit('nudge'); });
  on(q('approve'), 'click', () => { void submit('setDecision', 'approved'); });
  on(q('reject'), 'click', () => { void submit('setDecision', 'rejected'); });
  on(q('retry'), 'click', () => { void perform(); });
  on(window, 'beforeunload', e => { if (pending || childLocked() || dirty()) { e.preventDefault(); e.returnValue = ''; } });
  on(window, 'pagehide', () => { suspended = true; resetIdentity(); });
  on(window, 'pageshow', () => { if (suspended && !disposed) { suspended = false; resetIdentity(); } });
  const unsubscribe = adapter.subscribeIdentity(resetIdentity);
  if (attachmentHost && typeof adapter.mountAttachments === 'function') {
    attachments = adapter.mountAttachments(attachmentHost, {
      onLockChange(value) { attachmentLocked = value === true; if (!disposed) controls(); },
      onPublished: attachmentPublished,
      /* הרכיב יודע רק את מזהה הקובץ. הפנייה והגרסה מגיעות מכאן,
       * בזמן הקריאה ולא בזמן ההרכבה, כדי שההסרה תיקשר לגרסה
       * שהמסך באמת מציג. */
      async remove(data) {
        const origin = selected;
        if (!origin || !owner) throw Object.assign(new Error('no case'), { code: 'failed-precondition' });
        const out = await adapter.removeAttachment({
          request_id: crypto.randomUUID(), case_id: origin.case_id,
          expected_revision: origin.revision, attachment_id: data.attachment_id
        });
        return { removed_attachment_id: out?.removed_attachment_id };
      },
      onRemoved() { if (!disposed && selected) void openCase(selected.case_id); }
    });
  }
  resetIdentity();
  return { destroy() { disposed = true; unregisterUpdateGuard(); clearAttachments(); attachments?.destroy(); attachments = null; attachmentLocked = false; attachmentRefresh = false;
    unsubscribe(); for (const remove of removers) remove(); owner = null; ++generation; ++detailGeneration; ++listGeneration; pending = null; clearDrafts(); items = []; selected = null; events = []; renderList(); renderDetail(); controls(); } };
}
