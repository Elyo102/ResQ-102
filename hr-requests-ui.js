import { MEMBER_ROLES } from './roles.js?v=42h10';

const LABELS = { open: 'פתוחה', in_progress: 'בטיפול', waiting_employee: 'ממתינה לעובד', closed: 'סגורה' };
const KEY = /^[a-f0-9]{64}$/;
const disconnected = { currentSession: () => null, subscribeIdentity: () => () => {} };
const node = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = String(text); if (className) e.className = className; return e; };
const manager = s => s?.super === true || s?.role === 'hr_coordinator';
const member = s => s && typeof s.uid === 'string' && !!s.uid && typeof s.stationId === 'string' && !!s.stationId
  && (s.super === true || MEMBER_ROLES.includes(s.role));
const validSummary = c => c && KEY.test(c.case_id) && typeof c.owner_uid === 'string' && !!c.owner_uid
  && typeof c.subject === 'string' && c.subject.length <= 80 && Object.hasOwn(LABELS, c.status)
  && Number.isSafeInteger(c.revision) && c.revision > 0;
const definite = new Set(['invalid-argument', 'already-exists', 'aborted', 'not-found', 'failed-precondition', 'resource-exhausted', 'permission-denied', 'unauthenticated']);
const errorCode = error => String(error?.code || '').replace(/^functions\//, '');
const errorMessage = code => ({ aborted: 'הפנייה השתנתה. רעננו אותה, בדקו את העדכון ואת הטיוטה, ואז שמרו שוב.',
  'already-exists': 'מזהה הבקשה כבר שימש לפעולה אחרת. רעננו ובדקו את הפנייה לפני פעולה חדשה.',
  'resource-exhausted': 'בוצעו פעולות רבות בזמן קצר. המתינו מעט לפני ניסיון נוסף.',
  'failed-precondition': 'לא ניתן לבצע את הפעולה במצב הנוכחי. רעננו ובדקו את הפנייה.',
  'not-found': 'הפנייה אינה זמינה. רעננו את רשימת הפניות.',
  'invalid-argument': 'בדקו את הנושא והתוכן ואת אורך הטקסט לפני שמירה.' })[code] || 'נדרש חיבור עדכני עם הרשאה מתאימה.';

export function createHrRequestsUI(root, adapter = disconnected) {
  const q = key => root.querySelector('[data-r="' + key + '"]');
  let owner = null, generation = 0, listGeneration = 0, detailGeneration = 0;
  let mode = 'mine', items = [], cursor = null, selected = null, events = [], eventCursor = null;
  let listLoading = false, detailLoading = false, busy = false, pending = null, creating = false, disposed = false;
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
  function dirty() { return !!(q('subject').value || q('body').value || q('reply').value); }
  function clearDrafts() { q('subject').value = ''; q('body').value = ''; q('reply').value = ''; q('send-now').checked = false; }
  const childLocked = () => attachmentLocked || attachmentRefresh;
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
    const next = { session: owner, generation, detailGeneration, id: selected.case_id, revision: selected.revision,
      canUpload: selected.status !== 'closed' };
    if (attachmentOrigin && attachmentOrigin.session === next.session && attachmentOrigin.generation === next.generation
      && attachmentOrigin.detailGeneration === next.detailGeneration && attachmentOrigin.id === next.id
      && attachmentOrigin.revision === next.revision && attachmentOrigin.canUpload === next.canUpload) return;
    attachmentOrigin = next; attachmentHost.hidden = false;
    attachmentSyncing = true;
    try { attachments.setContext({ parent_kind: 'request', parent_id: next.id, parent_revision: next.revision, canUpload: next.canUpload }); }
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
    q('inbox').hidden = !manager(owner);
    q('mine').setAttribute('aria-pressed', String(mode === 'mine')); q('inbox').setAttribute('aria-pressed', String(mode === 'inbox'));
    q('list-title').textContent = mode === 'mine' ? 'הפניות שלי' : 'תיבת משאבי אנוש';
    for (const key of ['mine', 'inbox', 'refresh', 'new', 'subject', 'body', 'reply', 'status', 'send-now', 'save']) q(key).disabled = locked;
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
    q('notification').hidden = !owner || (!creating && !usable);
    q('pending').hidden = !pending || busy; q('retry').disabled = busy || !owner || childLocked();
    for (const button of q('list').querySelectorAll('button')) button.disabled = locked;
    syncAttachments();
  }
  function renderList() {
    q('list').replaceChildren();
    for (const item of items) {
      const b = node('button'); b.type = 'button'; b.dataset.case = item.case_id;
      b.setAttribute('aria-pressed', String(selected?.case_id === item.case_id));
      b.append(node('strong', item.subject), node('small', LABELS[item.status]));
      const g = generation, s = owner;
      b.addEventListener('click', () => { if (alive(g, s) && mayNavigate()) void openCase(item.case_id); });
      q('list').append(b);
    }
    if (!items.length) q('list').append(node('p', listLoading ? 'טוען פניות…' : 'אין פניות להצגה.'));
    controls();
  }
  function renderDetail() {
    const target = q('detail'); target.replaceChildren();
    if (!selected) { target.append(node('p', detailLoading ? 'טוען פנייה…' : 'בחרו פנייה או פתחו פנייה חדשה.')); controls(); return; }
    target.append(node('h2', selected.subject), node('span', LABELS[selected.status], 'requests-tag'));
    if (selected.status === 'closed') target.append(node('p', 'הפנייה סגורה. משאבי אנוש יכולים לפתוח אותה מחדש; אפשר גם ליצור פנייה חדשה.', 'requests-note'));
    for (const event of events) {
      const entry = node('article', null, 'requests-event');
      const by = event.actor_uid === owner.uid ? 'אני' : event.actor_uid === selected.owner_uid ? 'העובד שפנה' : 'משאבי אנוש';
      const kind = { create: 'פתיחת פנייה', reply: 'תגובה', setStatus: 'עדכון מצב', nudge: 'בקשת תזכורת', attachment: 'נוסף קובץ לפנייה' }[event.kind];
      entry.append(node('small', by + ' · ' + kind));
      if (event.text !== undefined) entry.append(node('p', event.text));
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
      const result = await adapter[originMode === 'mine' ? 'list' : 'listInbox'](append && cursor ? { cursor } : {});
      if (!alive(g, s) || l !== listGeneration || mode !== originMode) return;
      if (!result || !Array.isArray(result.items) || result.items.length > 25 ||
        !(result.next_cursor === null || (typeof result.next_cursor === 'string' && KEY.test(result.next_cursor)))) throw new Error('invalid list');
      const merged = append ? items.concat(result.items) : result.items;
      if (merged.some(c => !validSummary(c) || (originMode === 'mine' && c.owner_uid !== s.uid)) ||
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
        !['create', 'reply', 'setStatus', 'nudge', 'attachment'].includes(e.kind) || !Number.isSafeInteger(e.revision) || e.revision < 1 || e.revision > result.revision ||
        (e.kind === 'attachment' && (typeof e.attachment_id !== 'string' || !KEY.test(e.attachment_id))) ||
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
  async function submit(method) {
    if (!alive(generation, owner) || busy || pending || childLocked()) return;
    if (method !== 'create' && (!selected || detailLoading)) return;
    if (method === 'setStatus' && !manager(owner)) return;
    const payload = { request_id: newRequestId(), send_now: q('send-now').checked,
      ...(method === 'create' ? { subject: q('subject').value, text: q('body').value }
        : { case_id: selected.case_id, expected_revision: selected.revision,
          ...(method === 'reply' ? { text: q('reply').value } : method === 'setStatus' ? { status: q('status').value } : {}) }) };
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
      if (operation.method === 'create') { q('subject').value = ''; q('body').value = ''; }
      if (operation.method === 'reply') q('reply').value = '';
      const savedMessage = result.outcome === 'no_change' ? 'המצב כבר מעודכן; לא נוצרה התראה נוספת.'
        : result.notification_status === 'suppressed' ? 'הפעולה נשמרה. ההתראה דוכאה בשל מצב שקט.'
          : result.notification_status === 'no_other_recipient' ? 'הפעולה נשמרה. לא נדרשה התראה לעצמך.'
            : 'הפעולה נשמרה. בקשת ההתראה ממתינה לטיפול; אין אישור לשליחה או לקבלה.';
      message(savedMessage);
      await Promise.all([loadList(), openCase(result.case_id, false, !['create', 'reply'].includes(operation.method))]);
      // Read failures keep their explicit message; no optimistic delivery claim.
    } catch (error) {
      if (!alive(operation.generation, operation.session) || pending !== operation) return;
      const code = errorCode(error);
      if (definite.has(code)) { pending = null; q('send-now').checked = false; message(errorMessage(code)); }
      else message('תוצאת השמירה אינה ידועה. לחצו ניסיון חוזר כדי לברר באותה בקשה בדיוק.');
    } finally { if (alive(operation.generation, operation.session)) { busy = false; controls(); } }
  }
  function resetIdentity() {
    // Parent subscriber runs first, before the child could reload an old parent.
    clearAttachments(); attachmentLocked = false; attachmentRefresh = false;
    owner = suspended ? null : session(); ++generation; ++listGeneration; ++detailGeneration;
    mode = 'mine'; items = []; cursor = null; selected = null; events = []; eventCursor = null;
    pending = null; busy = false; listLoading = false; detailLoading = false; creating = false;
    clearDrafts(); renderList(); renderDetail();
    message(owner ? 'בחרו פנייה או פתחו פנייה חדשה.' : 'ממתין לחיבור מאובטח כעובד תחנה פעיל.');
    if (owner && !disposed) void loadList();
  }
  const changeMode = next => {
    if ((next === 'inbox' && !manager(owner)) || !mayNavigate()) return;
    ++generation; ++detailGeneration; mode = next; items = []; cursor = null; selected = null; events = []; eventCursor = null; creating = false;
    renderList(); renderDetail(); message('טוען פניות…'); void loadList();
  };
  on(q('mine'), 'click', () => changeMode('mine')); on(q('inbox'), 'click', () => changeMode('inbox'));
  on(q('new'), 'click', () => { if (!mayNavigate()) return; ++detailGeneration; selected = null; events = []; eventCursor = null; detailLoading = false; creating = true; renderList(); renderDetail(); q('subject').focus(); });
  on(q('refresh'), 'click', () => { if (!alive(generation, owner) || busy || pending || childLocked()) return; const id = selected?.case_id; void loadList(); if (id) void openCase(id, false, true); });
  on(q('more'), 'click', () => { if (!busy && !pending && !childLocked() && cursor) void loadList(true); });
  on(q('events-more'), 'click', () => { if (!busy && !pending && !childLocked() && selected && eventCursor) void openCase(selected.case_id, true, true); });
  on(q('create'), 'submit', e => { e.preventDefault(); if (q('create').reportValidity()) void submit('create'); });
  on(q('reply-form'), 'submit', e => { e.preventDefault(); if (q('reply-form').reportValidity()) void submit('reply'); });
  on(q('status-save'), 'click', () => { void submit('setStatus'); });
  on(q('nudge'), 'click', () => { void submit('nudge'); });
  on(q('retry'), 'click', () => { void perform(); });
  on(window, 'beforeunload', e => { if (pending || childLocked() || dirty()) { e.preventDefault(); e.returnValue = ''; } });
  on(window, 'pagehide', () => { suspended = true; resetIdentity(); });
  on(window, 'pageshow', () => { if (suspended && !disposed) { suspended = false; resetIdentity(); } });
  const unsubscribe = adapter.subscribeIdentity(resetIdentity);
  if (attachmentHost && typeof adapter.mountAttachments === 'function') {
    attachments = adapter.mountAttachments(attachmentHost, {
      onLockChange(value) { attachmentLocked = value === true; if (!disposed) controls(); },
      onPublished: attachmentPublished
    });
  }
  resetIdentity();
  return { destroy() { disposed = true; clearAttachments(); attachments?.destroy(); attachments = null; attachmentLocked = false; attachmentRefresh = false;
    unsubscribe(); for (const remove of removers) remove(); owner = null; ++generation; ++detailGeneration; ++listGeneration; pending = null; clearDrafts(); items = []; selected = null; events = []; renderList(); renderDetail(); controls(); } };
}
