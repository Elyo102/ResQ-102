import { MEMBER_ROLES } from './roles.js?v=42h12';

const KEY = /^[a-f0-9]{64}$/;
const uid = v => typeof v === 'string' && /^[^\u0000-\u001f\u007f/]{1,128}$/.test(v);
const revision = n => Number.isSafeInteger(n) && n > 0;
const manager = s => s?.super === true || s?.role === 'hr_coordinator';
const member = s => s && uid(s.uid) && typeof s.stationId === 'string' && !!s.stationId && (s.super === true || MEMBER_ROLES.includes(s.role));
const make = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = String(text); if (cls) e.className = cls; return e; };
const empty = { currentSession: () => null, subscribeIdentity: () => () => {} };
const definite = new Set(['invalid-argument', 'already-exists', 'aborted', 'not-found', 'failed-precondition', 'resource-exhausted', 'permission-denied', 'unauthenticated']);
const code = e => String(e?.code || '').replace(/^functions\//, '');
const errText = c => ({ aborted: 'פורסמה גרסה חדשה. רעננו, עיינו בגרסה העדכנית ובדקו את הטיוטה לפני פעולה חדשה.',
  'resource-exhausted': 'בוצעו פעולות רבות בזמן קצר. המתינו מעט לפני ניסיון נוסף.',
  'failed-precondition': 'הפעולה אינה מתאימה למצב הנוכחי. רעננו ובדקו את הגרסה או את רישומי הנמען.',
  'already-exists': 'הבקשה כבר שימשה לפעולה אחרת. רעננו ובדקו את התוצאה לפני פעולה חדשה.',
  'not-found': 'הפרסום אינו זמין. רעננו את הרשימה.', 'invalid-argument': 'בדקו את השדות ואת אורך הטקסט.' })[c] || 'נדרש חיבור עדכני והרשאה מתאימה.';
function validSummary(d) {
  return d && typeof d.document_id === 'string' && KEY.test(d.document_id) && ['document', 'procedure'].includes(d.kind)
    && typeof d.title === 'string' && d.title.length <= 80 && revision(d.current_revision) && (d.kind !== 'document' || uid(d.target_uid));
}
function validReceipt(r, n) {
  const time = t => t === null || (Number.isSafeInteger(t) && t >= 0);
  return r && uid(r.recipient_uid) && r.revision === n && time(r.opened_at_ms) && time(r.acknowledged_at_ms)
    && (r.acknowledged_at_ms === null || (r.opened_at_ms !== null && r.acknowledged_at_ms >= r.opened_at_ms));
}
function newId() { const a = new Uint8Array(16); crypto.getRandomValues(a); return 'doc-' + [...a].map(n => n.toString(16).padStart(2, '0')).join(''); }

export function createHrDocumentsUI(root, adapter = empty) {
  const q = k => root.querySelector('[data-d="' + k + '"]');
  let owner = null, generation = 0, lg = 0, dg = 0, rg = 0, sg = 0, disposed = false;
  let tab = 'mine', list = [], cursor = null, selected = null, receiptRows = [], receiptCursor = null, receiptNames = {};
  let editor = null, editBase = null, target = null, pending = null, busy = false, loading = false, detailLoading = false, receiptLoading = false, searchLoading = false;
  let receiptVisible = false, attempted = new Set();
  let attachments = null, attachmentContext = null, attachmentLocked = false, attachmentRefresh = null, suspended = false;
  const removers = [];
  const on = (e, event, fn) => { e.addEventListener(event, fn); removers.push(() => e.removeEventListener(event, fn)); };
  const message = value => { q('message').textContent = value; };
  function session() { try { const s = suspended ? null : adapter.currentSession(); return member(s) ? s : null; } catch (_) { return null; } }
  function alive(g, s) {
    if (disposed) return false;
    if (session() !== owner) { resetIdentity(); return false; }
    return !!owner && owner === s && generation === g;
  }
  const current = () => selected && selected.is_current === true && selected.revision === selected.current_revision;
  const openKey = d => d.document_id + ':' + d.revision;
  const childLocked = () => attachmentLocked || attachments?.isLocked() === true;
  const attachmentHolds = () => childLocked() || !!attachmentRefresh;
  function clearAttachments() {
    attachmentContext = null;
    attachments?.setContext(null);
    attachmentLocked = false;
    if (q('attachments')) q('attachments').hidden = true;
  }
  function syncAttachments() {
    // A child's own lock must never feed back into setContext and erase its
    // immutable pending attempt. Only settled parent state supplies a context.
    if (!attachments || childLocked()) return;
    if (disposed || suspended || !owner || !selected || loading || detailLoading || busy || pending || editor || attachmentRefresh) {
      clearAttachments(); return;
    }
    attachmentContext = { session: owner, generation, detail: dg, document_id: selected.document_id, revision: selected.revision };
    q('attachments').hidden = false;
    attachments.setContext({ parent_kind: 'document', parent_id: selected.document_id,
      parent_revision: selected.revision, canUpload: manager(owner) && current() });
  }
  async function attachmentPublished(result) {
    const origin = attachmentContext;
    if (!origin || !alive(origin.generation, origin.session) || origin.detail !== dg
      || selected?.document_id !== origin.document_id || !KEY.test(result?.attachment_id || '')
      || result.revision !== origin.revision + 1) return;
    const refresh = { ...origin };
    attachmentRefresh = refresh; ++lg; ++rg;
    clearAttachments(); controls();
    message('הקובץ צורף לגרסה ' + result.revision + '. מרענן את הפרסום; אישורי עיון אינם מועתקים לגרסה החדשה.');
    try {
      const [listed, loaded] = await Promise.all([loadList(), loadDocument(origin.document_id)]);
      if (!alive(origin.generation, origin.session) || attachmentRefresh !== refresh) return;
      message(listed && loaded ? 'הקובץ צורף לגרסה ' + result.revision + '. הפרסום רוענן; אין בכך אישור לשליחת התראה או לעיון בקובץ.'
        : 'הקובץ צורף לגרסה ' + result.revision + ', אך הרענון לא הושלם. רעננו את הפרסום; אין צורך להעלות את הקובץ שוב.');
    } finally {
      if (alive(origin.generation, origin.session) && attachmentRefresh === refresh) {
        attachmentRefresh = null; ensureOpened(); syncAttachments(); controls();
      }
    }
  }
  function clearTarget() { target = null; ++sg; searchLoading = false; q('candidates').replaceChildren(); q('chosen').textContent = ''; q('search-message').textContent = ''; }
  function clearEditor() { editor = null; editBase = null; q('title').value = ''; q('text').value = ''; q('requires-ack').checked = false; q('send-now').checked = false; }
  function dirty() { return !!editor && !!(q('title').value || q('text').value); }
  function mayLeave() {
    if (!alive(generation, owner) || busy || pending || attachmentHolds()) return false;
    if (dirty() && !window.confirm('הטיוטה טרם נשמרה. לעבור ולמחוק אותה?')) return false;
    clearEditor(); clearTarget(); q('search').value = ''; return true;
  }
  function controls() {
    const lock = !owner || busy || !!pending || attachmentHolds(), hr = manager(owner), active = !!selected && !detailLoading && !editor;
    q('workspace').hidden = !owner; q('login').hidden = !!owner;
    q('managed').hidden = !hr; q('new').hidden = !hr; q('managed-kind').hidden = tab !== 'managed';
    for (const k of ['mine', 'procedures', 'managed']) q(k).setAttribute('aria-pressed', String(tab === k));
    for (const k of ['mine', 'procedures', 'managed', 'managed-kind', 'refresh', 'new', 'title', 'text', 'requires-ack', 'publish', 'send-now', 'search', 'version']) q(k).disabled = lock;
    q('kind').disabled = lock || editor === 'revise';
    q('editor').hidden = !editor; q('fixed-audience').hidden = editor !== 'revise';
    q('editor-title').textContent = editor === 'revise' ? 'פרסום גרסה חדשה' : 'פרסום חדש';
    q('publish').textContent = editor === 'revise' ? 'פרסום גרסה חדשה' : 'פרסום';
    q('picker').hidden = !hr || !(editor === 'publish' && q('kind').value === 'document') && !(active && selected.kind === 'procedure' && current());
    q('search-button').disabled = lock || searchLoading;
    q('more').hidden = !cursor; q('more').disabled = lock || loading;
    q('version-controls').hidden = !active; q('load-version').disabled = lock; q('latest').disabled = lock;
    q('revise').hidden = !hr || !active; q('revise').disabled = lock || !current();
    q('show-receipts').hidden = !hr || !active; q('show-receipts').disabled = lock || receiptLoading;
    q('receipt-panel').hidden = !receiptVisible || !active;
    q('receipts-more').hidden = !receiptCursor; q('receipts-more').disabled = lock || receiptLoading;
    const eligible = active && selected.recipient_eligible === true;
    q('receipt-state').hidden = !eligible;
    q('retry-open').hidden = !eligible || selected.receipt?.opened_at_ms != null;
    q('retry-open').disabled = lock;
    q('ack').hidden = !eligible || !selected.requires_ack || selected.receipt?.acknowledged_at_ms != null;
    q('ack').disabled = lock || !current() || selected?.receipt?.opened_at_ms == null;
    q('nudge').hidden = !hr || !active;
    const nudgeUid = selected?.kind === 'document' ? selected.target_uid : target?.uid;
    q('nudge').disabled = lock || !current() || !nudgeUid || nudgeUid === owner?.uid;
    q('notification').hidden = !hr || (!editor && !active);
    q('pending').hidden = !pending || busy; q('retry').disabled = busy || attachmentHolds();
    for (const e of root.querySelectorAll('[data-d="list"] button,[data-d="candidates"] button,[data-d="receipts"] button')) e.disabled = lock;
  }
  function renderList() {
    q('list-title').textContent = tab === 'mine' ? 'המסמכים שלי' : tab === 'procedures' ? 'נהלי התחנה' : 'ניהול פרסומים';
    q('list').replaceChildren();
    for (const d of list) {
      const b = make('button'); b.type = 'button'; b.dataset.document = d.document_id;
      b.setAttribute('aria-pressed', String(d.document_id === selected?.document_id));
      b.append(make('strong', d.title), make('small', (d.kind === 'document' ? 'מסמך אישי' : 'נוהל') + ' · גרסה ' + d.current_revision));
      const g = generation, s = owner, l = lg;
      b.addEventListener('click', () => { if (alive(g, s) && l === lg && mayLeave()) void loadDocument(d.document_id); });
      q('list').append(b);
    }
    if (!list.length) q('list').append(make('p', loading ? 'טוען פרסומים…' : 'אין פרסומים להצגה.'));
    controls();
  }
  function renderDetail() {
    const box = q('detail'); box.replaceChildren();
    if (!selected) box.append(make('p', detailLoading ? 'טוען פרסום…' : 'בחרו מסמך או נוהל לצפייה.'));
    else {
      box.append(make('h2', selected.title), make('p', 'גרסה ' + selected.revision + ' · הגרסה האחרונה בזמן הטעינה: ' + selected.current_revision, 'doc-note'));
      if (!current()) box.append(make('p', 'זו גרסה קודמת. לצורך אישור עיון או תזכורת יש לטעון את הגרסה האחרונה.', 'doc-note'));
      box.append(make('div', selected.text, 'doc-body'));
      q('version').value = selected.revision; q('version').max = selected.current_revision;
      const receipt = selected.receipt;
      q('receipt-state').textContent = receipt?.acknowledged_at_ms != null ? 'נשמר אישור עיון שלך לגרסה זו.'
        : receipt?.opened_at_ms != null ? 'נרשמה פתיחה במסך. אישור עיון מפורש טרם נשמר.' : 'הפרסום מוצג. רישום הפתיחה טרם אושר.';
    }
    controls();
  }
  async function loadList(append = false) {
    if (childLocked()) return false;
    const g = generation, s = owner, l = ++lg, mode = tab, kind = q('managed-kind').value;
    if (!alive(g, s)) return;
    clearAttachments();
    loading = true; controls();
    try {
      const result = await adapter[mode === 'mine' ? 'listMine' : mode === 'procedures' ? 'listProcedures' : 'listManaged']({ ...(mode === 'managed' ? { kind } : {}), ...(append && cursor ? { cursor } : {}) });
      if (!alive(g, s) || l !== lg || mode !== tab) return;
      if (!result || !Array.isArray(result.items) || result.items.length > 25 || !(result.next_cursor === null || typeof result.next_cursor === 'string' && KEY.test(result.next_cursor))) throw new Error('invalid page');
      const merged = append ? list.concat(result.items) : result.items;
      if (merged.some(d => !validSummary(d) || (mode === 'mine' && (d.kind !== 'document' || d.target_uid !== s.uid)) || (mode === 'procedures' && d.kind !== 'procedure') || (mode === 'managed' && d.kind !== kind)) || new Set(merged.map(d => d.document_id)).size !== merged.length) throw new Error('invalid list');
      list = merged; cursor = result.next_cursor; renderList(); return true;
    } catch (_) { if (alive(g, s) && l === lg) { list = []; cursor = null; renderList(); message('הרשימה אינה זמינה כרגע. נסו לרענן.'); } }
    finally { if (alive(g, s) && l === lg) { loading = false; syncAttachments(); controls(); } }
  }
  function checkDocument(d, id, n, s) {
    if (!validSummary(d) || d.document_id !== id || !revision(d.revision) || d.revision > d.current_revision || (n && d.revision !== n)
      || typeof d.text !== 'string' || d.text.length > 20000 || typeof d.requires_ack !== 'boolean' || typeof d.recipient_eligible !== 'boolean'
      || d.is_current !== (d.revision === d.current_revision) || (!manager(s) && d.kind === 'document' && d.target_uid !== s.uid)
      || (d.receipt !== null && (!validReceipt(d.receipt, d.revision) || d.receipt.recipient_uid !== s.uid))) throw new Error('invalid document');
  }
  async function loadDocument(id, n = null, preserveEditor = false) {
    if (childLocked()) return false;
    const g = generation, s = owner, d = ++dg;
    if (!alive(g, s)) return;
    clearAttachments();
    ++rg; receiptVisible = false; receiptRows = []; receiptCursor = null; q('receipts').replaceChildren();
    if (!preserveEditor) clearEditor();
    clearTarget(); q('search').value = ''; q('send-now').checked = false;
    selected = null; detailLoading = true; renderDetail();
    try {
      const result = await adapter.get({ document_id: id, ...(n ? { revision: n } : {}) });
      if (!alive(g, s) || d !== dg) return;
      checkDocument(result, id, n, s); selected = result;
      if (preserveEditor && editor === 'revise' && editBase?.document_id === id && current()) editBase = { document_id: id, expected_revision: result.current_revision };
      detailLoading = false; renderDetail(); renderList();
      // The body has been inserted into the DOM before this explicit opened
      // receipt is requested. No list/prefetch/GET result alone records it.
      if (!editor) ensureOpened();
      return true;
    } catch (_) { if (alive(g, s) && d === dg) { selected = null; renderDetail(); message('לא ניתן להציג את הפרסום כרגע. בחרו אותו שוב.'); } }
    finally { if (alive(g, s) && d === dg) { detailLoading = false; syncAttachments(); controls(); } }
  }
  function ensureOpened() {
    if (!alive(generation, owner) || busy || pending || attachmentHolds() || editor || !selected || selected.recipient_eligible !== true || selected.receipt?.opened_at_ms != null) return;
    const key = openKey(selected); if (attempted.has(key)) return;
    attempted.add(key); void submit('markOpened');
  }
  async function search() {
    const g = generation, s = owner, name = q('search').value;
    if (!alive(g, s) || !manager(s) || busy || pending || attachmentHolds()) return;
    clearTarget(); const searchId = sg;
    if (name.trim().length < 2) { q('search-message').textContent = 'הזינו לפחות שני תווים בשם.'; return; }
    searchLoading = true; controls();
    try {
      const result = await adapter.searchPeople({ name });
      if (!alive(g, s) || searchId !== sg || q('search').value !== name) return;
      if (!result || !Array.isArray(result.items) || result.items.length > 25 || result.items.some(p => !uid(p.uid) || typeof p.name !== 'string') || new Set(result.items.map(p => p.uid)).size !== result.items.length) throw new Error('invalid search');
      q('search-message').textContent = result.items.length ? 'בחרו עובד במפורש. ניתן לדייק את השם אם חסרה התאמה.' : 'לא נמצאה התאמה בתחנה בתוצאות הנוכחיות. נסו שם מלא יותר.';
      for (const person of result.items) {
        const b = make('button', person.name + (person.crew ? ' · ' + person.crew : '')); b.type = 'button';
        b.addEventListener('click', () => { if (!alive(g, s) || searchId !== sg || q('search').value !== name || busy || pending || attachmentHolds()) return;
          target = Object.freeze({ uid: person.uid, name: person.name }); q('chosen').textContent = 'נבחר/ה: ' + person.name; controls(); });
        q('candidates').append(b);
      }
    } catch (_) { if (alive(g, s) && searchId === sg) q('search-message').textContent = 'החיפוש אינו זמין כרגע. לא נבחר עובד.'; }
    finally { if (alive(g, s) && searchId === sg) { searchLoading = false; controls(); } }
  }
  function renderReceipts() {
    q('receipts').replaceChildren();
    for (const row of receiptRows) {
      const box = make('div', null, 'doc-receipt');
      const name = Object.hasOwn(receiptNames, row.recipient_uid) ? receiptNames[row.recipient_uid] : 'שם לא זמין';
      box.append(make('strong', name), make('p', row.acknowledged_at_ms != null ? 'נשמר אישור עיון' : row.opened_at_ms != null ? 'נפתחה הגרסה; טרם אושרה' : 'לא נרשמה פתיחה'));
      if (selected?.kind === 'procedure' && current() && (selected.requires_ack ? row.acknowledged_at_ms == null : row.opened_at_ms == null)) {
        const b = make('button', 'בחירת עובד זה לתזכורת'); b.type = 'button'; const g = generation, s = owner, d = dg;
        b.addEventListener('click', () => { if (!alive(g, s) || d !== dg || pending || busy || attachmentHolds()) return;
          clearTarget(); q('search').value = ''; target = Object.freeze({ uid: row.recipient_uid, name }); q('chosen').textContent = 'נבחר/ה: ' + name; controls(); });
        box.append(b);
      }
      q('receipts').append(box);
    }
    if (!receiptRows.length) q('receipts').append(make('p', 'אין רישומי פתיחה או אישור בעמוד זה.'));
    controls();
  }
  async function loadReceipts(append = false) {
    const g = generation, s = owner, d = dg, r = ++rg, doc = selected;
    if (!alive(g, s) || !manager(s) || !doc || busy || pending || attachmentHolds()) return;
    receiptLoading = true; receiptVisible = true; controls();
    try {
      const result = await adapter.listReceipts({ document_id: doc.document_id, revision: doc.revision, ...(append && receiptCursor ? { cursor: receiptCursor } : {}) });
      if (!alive(g, s) || d !== dg || r !== rg) return;
      if (!result || result.document_id !== doc.document_id || result.revision !== doc.revision || !Array.isArray(result.items) || result.items.length > 25
        || !(result.next_cursor === null || uid(result.next_cursor)) || result.items.some(x => !validReceipt(x, doc.revision) || (doc.kind === 'document' && x.recipient_uid !== doc.target_uid))) throw new Error('invalid receipts');
      const merged = append ? receiptRows.concat(result.items) : result.items;
      if (new Set(merged.map(x => x.recipient_uid)).size !== merged.length) throw new Error('duplicate receipts');
      receiptRows = merged; receiptCursor = result.next_cursor; if (!append) receiptNames = {}; renderReceipts();
      let names = {}; try { names = await adapter.lookupNames({ uids: result.items.map(x => x.recipient_uid) }); } catch (_) { /* Authorized rows remain visible without names. */ }
      if (!alive(g, s) || d !== dg || r !== rg) return;
      for (const item of result.items) if (names && Object.hasOwn(names, item.recipient_uid) && typeof names[item.recipient_uid] === 'string') Object.defineProperty(receiptNames, item.recipient_uid, { value: names[item.recipient_uid], enumerable: true, configurable: true });
      renderReceipts();
    } catch (_) { if (alive(g, s) && d === dg && r === rg) message('רישומי הפתיחה והאישור אינם זמינים כרגע.'); }
    finally { if (alive(g, s) && d === dg && r === rg) { receiptLoading = false; controls(); } }
  }
  async function submit(method) {
    if (!alive(generation, owner) || busy || pending || attachmentHolds()) return;
    if (['publish', 'revise', 'nudge'].includes(method) && !manager(owner)) return;
    if (method !== 'publish' && (!selected || detailLoading)) return;
    let data = { request_id: newId() };
    if (method === 'publish' || method === 'revise') {
      if (method === 'publish' && q('kind').value === 'document' && !target) { message('יש לבחור עובד מתוך תוצאות החיפוש.'); return; }
      if (method === 'revise' && (!editBase || !current())) { message('יש לטעון את הגרסה האחרונה לפני עדכון.'); return; }
      data = { ...data, ...(method === 'publish' ? { kind: q('kind').value, ...(q('kind').value === 'document' ? { target_uid: target.uid } : {}) } : editBase),
        title: q('title').value, text: q('text').value, requires_ack: q('requires-ack').checked, send_now: q('send-now').checked };
    } else {
      data.document_id = selected.document_id; data.revision = selected.revision;
      if (method === 'nudge') { const targetUid = selected.kind === 'document' ? selected.target_uid : target?.uid;
        if (!targetUid || !current() || targetUid === owner.uid) return;
        data.target_uid = targetUid; data.send_now = q('send-now').checked;
      }
      if (method === 'acknowledge' && (!current() || !selected.recipient_eligible || !selected.requires_ack || selected.receipt?.opened_at_ms == null || selected.receipt?.acknowledged_at_ms != null)) return;
      if (method === 'markOpened' && !selected.recipient_eligible) return;
    }
    pending = Object.freeze({ method, data: Object.freeze(data), session: owner, generation, detail: dg });
    await perform();
  }
  async function perform() {
    const p = pending; if (!p || busy || attachmentHolds() || !alive(p.generation, p.session)) return;
    busy = true; clearAttachments(); controls(); message(p.method === 'markOpened' ? 'רושם פתיחה של הגרסה שהוצגה…' : 'שומר את הפעולה…');
    try {
      const result = await adapter[p.method](p.data);
      if (!alive(p.generation, p.session) || pending !== p || p.detail !== dg) return;
      if (!result || !KEY.test(result.document_id) || !revision(result.revision) || !revision(result.current_revision) || result.current_revision < result.revision
        || !['saved', 'no_change', 'confirmation_required'].includes(result.outcome) || !['not_queued', 'policy_pending', 'suppressed', 'no_other_recipient'].includes(result.notification_status)
        || (p.method !== 'publish' && result.document_id !== p.data.document_id)
        || (['markOpened', 'acknowledge', 'nudge'].includes(p.method) && result.revision !== p.data.revision)) throw new Error('uncertain result');
      if (['markOpened', 'acknowledge'].includes(p.method) && (!validReceipt(result.receipt, p.data.revision) || result.receipt.recipient_uid !== owner.uid)) throw new Error('uncertain receipt');
      pending = null; q('send-now').checked = false;
      if (p.method === 'markOpened' || p.method === 'acknowledge') {
        selected = { ...selected, receipt: result.receipt, current_revision: result.current_revision, is_current: selected.revision === result.current_revision };
        renderDetail(); message(p.method === 'acknowledge' ? 'נשמר אישור העיון שלך לגרסה ' + result.revision + '.' : 'נרשמה פתיחה. אישור עיון, אם נדרש, נעשה בכפתור נפרד.');
        if (!current()) message('נרשמה הפעולה לגרסה שהוצגה. קיימת גרסה חדשה; טענו אותה לפני אישור נוסף.');
      } else if (result.outcome === 'confirmation_required') message('לא נוצרה תזכורת. בשעות הלילה יש לסמן בקשת התראה כעת וללחוץ שוב במפורש.');
      else {
        message(result.notification_status === 'suppressed' ? 'הפעולה נשמרה. ההתראה דוכאה בשל מצב שקט.'
          : result.notification_status === 'no_other_recipient' ? 'הפעולה נשמרה; לא נדרשה התראה לעצמך.' : 'הפעולה נשמרה. ההתראה ממתינה לטיפול; אין אישור לשליחה או לקבלה.');
        if (p.method !== 'nudge') { clearEditor(); await Promise.all([loadList(), loadDocument(result.document_id)]); }
      }
    } catch (e) {
      if (!alive(p.generation, p.session) || pending !== p) return;
      if (definite.has(code(e))) { pending = null; q('send-now').checked = false; message(errText(code(e))); }
      else message('תוצאת הפעולה אינה ידועה. לחצו ניסיון חוזר כדי לברר באותה בקשה בדיוק.');
    } finally { if (alive(p.generation, p.session)) { busy = false; if (!pending) ensureOpened(); syncAttachments(); controls(); } }
  }
  function resetIdentity() {
    // This parent subscribes before the child. Clear the old parent's context
    // before the child can react to a newly signed-in user's identity.
    clearAttachments(); attachmentRefresh = null;
    owner = session(); ++generation; ++lg; ++dg; ++rg;
    tab = 'mine'; list = []; cursor = null; selected = null; receiptRows = []; receiptCursor = null; receiptNames = {};
    busy = false; pending = null; loading = false; detailLoading = false; receiptLoading = false; receiptVisible = false; attempted = new Set();
    clearEditor(); clearTarget(); q('search').value = ''; q('receipts').replaceChildren();
    renderList(); renderDetail(); message(owner ? 'בחרו מסמך או נוהל. פתיחה ואישור עיון נרשמים בנפרד.' : 'ממתין לחיבור מאובטח כעובד תחנה פעיל.');
    if (owner && !disposed && !suspended) void loadList();
  }
  function switchTab(next) {
    if (next === 'managed' && !manager(owner) || !mayLeave()) return;
    clearAttachments();
    ++generation; ++dg; ++rg; tab = next; list = []; cursor = null; selected = null; detailLoading = false; receiptVisible = false; receiptRows = []; receiptCursor = null;
    renderList(); renderDetail(); void loadList();
  }
  for (const k of ['mine', 'procedures', 'managed']) on(q(k), 'click', () => switchTab(k));
  on(q('managed-kind'), 'change', () => switchTab('managed'));
  on(q('more'), 'click', () => { if (!busy && !pending && !attachmentHolds() && !loading && cursor) void loadList(true); });
  on(q('refresh'), 'click', () => { if (!alive(generation, owner) || busy || pending || attachmentHolds()) return; void loadList(); if (selected) void loadDocument(selected.document_id, null, editor === 'revise'); });
  on(q('new'), 'click', () => { if (!manager(owner) || !mayLeave()) return; clearAttachments(); ++dg; ++rg; selected = null; detailLoading = false; receiptVisible = false; editor = 'publish'; q('kind').value = 'document'; renderDetail(); q('title').focus(); });
  on(q('revise'), 'click', () => { if (!manager(owner) || !current() || busy || pending || attachmentHolds()) return;
    clearAttachments();
    editor = 'revise'; editBase = { document_id: selected.document_id, expected_revision: selected.current_revision };
    q('kind').value = selected.kind; q('title').value = selected.title; q('text').value = selected.text; q('requires-ack').checked = selected.requires_ack;
    clearTarget(); q('send-now').checked = false; controls(); q('title').focus(); });
  on(q('kind'), 'change', () => { if (attachmentHolds()) return; clearTarget(); q('search').value = ''; q('send-now').checked = false; controls(); });
  on(q('search'), 'input', () => { if (attachmentHolds()) return; clearTarget(); controls(); });
  on(q('search-button'), 'click', () => { void search(); });
  on(q('editor'), 'submit', e => { e.preventDefault(); if (q('editor').reportValidity()) void submit(editor === 'revise' ? 'revise' : 'publish'); });
  on(q('load-version'), 'click', () => { const n = Number(q('version').value); if (selected && revision(n) && n <= selected.current_revision && mayLeave()) void loadDocument(selected.document_id, n); });
  on(q('latest'), 'click', () => { if (selected && mayLeave()) void loadDocument(selected.document_id); });
  on(q('ack'), 'click', () => { void submit('acknowledge'); });
  on(q('retry-open'), 'click', () => { if (selected && !attachmentHolds()) { attempted.add(openKey(selected)); void submit('markOpened'); } });
  on(q('nudge'), 'click', () => { void submit('nudge'); });
  on(q('show-receipts'), 'click', () => { void loadReceipts(); });
  on(q('receipts-more'), 'click', () => { if (receiptCursor && !receiptLoading) void loadReceipts(true); });
  on(q('retry'), 'click', () => { void perform(); });
  on(window, 'beforeunload', e => { if (pending || dirty() || attachmentHolds()) { e.preventDefault(); e.returnValue = ''; } });
  on(window, 'pagehide', () => { suspended = true; resetIdentity(); });
  on(window, 'pageshow', () => { if (suspended && !disposed) { suspended = false; resetIdentity(); } });
  const unsubscribe = adapter.subscribeIdentity(resetIdentity);
  if (typeof adapter.mountAttachments === 'function' && q('attachments')) {
    attachments = adapter.mountAttachments(q('attachments'), {
      onLockChange(value) { attachmentLocked = value === true; if (!disposed) controls(); },
      onPublished: attachmentPublished
    });
  }
  resetIdentity();
  return { destroy() { disposed = true; unsubscribe(); removers.forEach(fn => fn()); owner = null; ++generation; ++dg; ++rg; ++lg;
    clearAttachments(); attachments?.destroy(); attachments = null; attachmentRefresh = null;
    pending = null; selected = null; list = []; receiptRows = []; receiptCursor = null; receiptVisible = false; clearEditor(); clearTarget();
    q('search').value = ''; q('receipts').replaceChildren(); renderList(); renderDetail(); controls(); } };
}
