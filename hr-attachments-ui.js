// Isolated private-attachment UI. It owns no transport, no callable name and
// no Firebase import: the host adapter carries all five service methods and
// verifies the server epoch against token identity before returning. The
// component checks the epoch again against the live session, because an
// answer that outlives its identity belongs to nobody.
//
// It also writes nothing about the parent. Publication moves the parent's
// revision; the host refreshes it and hands back a new context. A UI that
// rebases itself is a UI that decides, and this one does not decide.
//
// Two fences, and only two, guard everything asynchronous:
//   `fence`  - advanced by the single invalidation path (identity, context,
//              pagehide, destroy). It invalidates every pending operation.
//   `ticket` - advanced by the selection lifecycle. It invalidates only the
//              work bound to one chosen file.
// Session identity is compared by object reference, because the host promises
// a stable object: a new object with the same fields is a new session.
const KEY = /^[a-f0-9]{64}$/;
const MAX_BYTES = 2097152;
const MAX_NAME = 120;
// A base64 body cannot exceed this, so the string is refused before anything
// is allocated for it.
const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PARENT_KINDS = ['request', 'document'];
const SERVER_STATES = ['reserved', 'stored_pending', 'stored', 'cleaning', 'ready', 'failed'];

const TYPES = { 'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d], 'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] };
const TYPE_LABEL = { 'application/pdf': 'PDF', 'image/jpeg': 'JPEG', 'image/png': 'PNG' };
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

// The local phases.
//
// `chosen` means nothing has been sent. `attempted` means a request id has
// left this browser at least once - and from there the file cannot go back to
// "merely chosen" and cannot be dropped, because a dropped card is not a
// cancelled operation. Only the server saying the attempt is closed ends it.
const PHASE = { idle: '', chosen: 'נבחר, טרם נשלח', reserving: 'שומר מקום', uploading: 'מעלה',
  resuming: 'בודק מה נקלט', attempted: 'נשלח · מצב לא ידוע', ready: 'צורף', failed: 'נסגר' };
const BUSY = ['reserving', 'uploading', 'resuming'];
// Phases that hold the host: work may still be running on the server.
const HOLDS = BUSY.concat('attempted');

// Refusals that prove the call did nothing and clear what was private.
const CLEARS_PRIVATE = ['permission-denied', 'unauthenticated'];
// Nothing in the error vocabulary closes an attempt. `already-exists` is not
// a closure either: the parent ports raise it for an already-published
// membership as well as for a reused identifier, so it is one code for two
// opposite outcomes. Only an authoritative statement about this attempt ends
// it — a ready receipt, or a reserve answering `state: 'failed'`.
const PAGE_SIZE = 25;
const CURSOR = /^([1-9][0-9]{0,14})\|([a-f0-9]{64})$/;

const disconnected = { currentSession: () => null, subscribeIdentity: () => () => {} };
const el = (tag, value, className) => { const node = document.createElement(tag); if (value != null) node.textContent = String(value); if (className) node.className = className; return node; };
const errorCode = error => String(error?.code || '').replace(/^functions\//, '');
const errorMessage = code => ({ 'permission-denied': 'אין הרשאה לפעולה הזאת. ייתכן שההרשאה השתנתה בזמן שהמסך היה פתוח.',
  unauthenticated: 'נדרש חיבור עדכני. התחברו מחדש.',
  'failed-precondition': 'הפריט השתנה או שהפעולה אינה אפשרית במצב הנוכחי.',
  aborted: 'פעולה מקבילה רצה על הקובץ הזה.',
  'resource-exhausted': 'הגעתם לתקרת הקבצים של הפריט.',
  'already-exists': 'השרת מדווח שהמזהה הזה כבר בשימוש. ייתכן שהקובץ כבר צורף וייתכן שלא.',
  'not-found': 'הפריט אינו זמין. רעננו את הרשימה.',
  'invalid-argument': 'הקובץ אינו עומד בדרישות.' })[code] || null;
// Never "the file was not sent", and never "it was not received": neither a
// dropped connection nor an upload-required answer can prove either one.
const UNKNOWN_TEXT = 'הבקשה נשלחה ולא התקבלה עליה תשובה ודאית. לא ידוע אם הקובץ נקלט. אל תבחרו קובץ חדש — בדקו שוב, אותה בקשה ואותו קובץ.';
const RESEND_TEXT = 'השרת מבקש את הקובץ שוב. ייתכן ששליחה קודמת עדיין בדרך, ולכן זו אותה בקשה ואותו קובץ — לא בקשה חדשה.';
const RESENDING_TEXT = 'שולחים שוב את אותם בייטים על אותו מזהה.';

const signature = (bytes, type) => TYPES[type].length <= bytes.length && TYPES[type].every((b, i) => bytes[i] === b);
const detectType = bytes => Object.keys(TYPES).find(type => signature(bytes, type)) || null;
const size = n => n < 1024 ? n + ' בתים' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

function nameProblem(value) {
  const name = String(value ?? '').trim();
  if (!name) return 'לקובץ אין שם.';
  if (name.length > MAX_NAME) return 'שם הקובץ ארוך מ-' + MAX_NAME + ' תווים.';
  if (UNSAFE_NAME.test(name)) return 'שם הקובץ מכיל תווים שאינם מותרים.';
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return 'שם הקובץ מכיל תווי נתיב.';
  if (WINDOWS_RESERVED.test(name)) return 'שם הקובץ שמור במערכת ההפעלה.';
  return null;
}

// String.fromCharCode.apply over two million bytes overflows the stack.
function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const hex = buffer => Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');

const text = (v, max) => typeof v === 'string' && !!v.trim() && v.length <= max;
const count = v => Number.isSafeInteger(v) && v > 0;

// Bounded before allocation: the cap is checked on the string, and the length
// the string can possibly decode to is compared with the declared length
// before `atob` runs. A five-byte body declared as eighteen is a malformed
// result, not a small file.
function decodeBounded(value, declared) {
  if (!count(declared) || declared > MAX_BYTES) return null;
  if (typeof value !== 'string' || !value.length || value.length > MAX_BASE64) return null;
  if (!BASE64.test(value) || value.length % 4 !== 0) return null;
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length / 4 * 3 - pad !== declared) return null;
  let binary;
  try { binary = atob(value); } catch (_) { return null; }
  if (binary.length !== declared) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// `claims_digest` is a SHA-256 hex digest and `auth_time` is the token claim,
// in seconds. Accepting anything roughly that shape would let a wrong answer
// through, so the shape is checked as it actually is.
const validEpoch = e => !!e && text(e.uid, 400) && text(e.station_id, 400)
  && Number.isSafeInteger(e.auth_time) && e.auth_time >= 0 && KEY.test(e.claims_digest || '');
const validRow = row => !!row && KEY.test(row.attachment_id || '') && text(row.display_name, MAX_NAME)
  && Object.hasOwn(TYPE_LABEL, row.declared_type) && count(row.byte_length) && row.byte_length <= MAX_BYTES
  && count(row.revision) && Number.isSafeInteger(row.created_at_ms);

// The host promises one stable session object. Reference equality is the
// check, so a rebuilt object with identical fields is a different session.
const usableSession = s => (!!s && typeof s === 'object' && text(s.uid, 400) && text(s.stationId, 400)) ? s : null;

// A file name carries a bidi hazard inside itself. In an RTL line the dot
// between "12.8" and "pdf" is a neutral, so it takes the paragraph direction
// and splits the two Latin runs: the name is drawn with its extension before
// its number - a different file name than the one on disk.
const LATIN_RUN = /[A-Za-z0-9][A-Za-z0-9 ._+()#&@'\-]*[A-Za-z0-9]|[A-Za-z0-9]/g;
function naming(value) {
  const node = el('span', null, 'hra-name');
  const source = String(value);
  let at = 0;
  for (const match of source.matchAll(LATIN_RUN)) {
    if (match.index > at) node.append(document.createTextNode(source.slice(at, match.index)));
    node.append(el('bdi', match[0]));
    at = match.index + match[0].length;
  }
  if (at < source.length) node.append(document.createTextNode(source.slice(at)));
  return node;
}

// A Latin token beside a Hebrew one reorders the same way. Each is isolated.
function meta(parts) {
  const node = el('span', null, 'hra-meta');
  parts.filter(Boolean).forEach((part, index) => {
    if (index) node.append(document.createTextNode(' · '));
    node.append(el('span', part, 'hra-tok'));
  });
  return node;
}

/**
 * @param {Element} root     container the component fills; it creates its own
 *                           markup and removes it on destroy().
 * @param {object}  adapter  currentSession · subscribeIdentity ·
 *                           reserve · upload · resume · list · download,
 *                           and optionally onLockChange · onPublished.
 * @returns {{setContext:Function,isLocked:Function,destroy:Function}}
 */
export function createHrAttachmentsUI(root, adapter = disconnected) {
  const safeSession = () => { try { return adapter.currentSession(); } catch (_) { return null; } };

  let owner = usableSession(safeSession()), disposed = false;
  let fence = 0, ticket = 0, context = null, locked = false;
  let pick = null, selecting = false, pickProblem = null;
  let rows = [], cursor = null, listRun = 0, listActive = 0, listProblem = null;
  // id -> the run token that owns this download. A completion that no longer
  // owns the id must not clear the busy state of the request that replaced it.
  const pulling = new Map();
  const pullProblem = new Map();
  let pullRun = 0;

  const removers = [];
  const on = (target, event, fn) => { target.addEventListener(event, fn); removers.push(() => target.removeEventListener(event, fn)); };

  /* ---------- markup ---------- */

  const box = el('section', null, 'hra');
  const say = el('p', null, 'hra-live');
  say.setAttribute('role', 'status');
  say.setAttribute('aria-live', 'polite');

  const pickBox = el('div', null, 'hra-pick');
  const chooser = el('label', null, 'hra-file');
  chooser.append(el('span', 'בחרו קובץ לצירוף'));
  const input = el('input');
  input.type = 'file';
  // No `capture`: on a phone that attribute forces the camera and hides the
  // gallery, and most of these files are already on the device.
  input.accept = Object.keys(TYPES).join(',');
  chooser.append(input);
  const note = el('p', 'PDF · JPEG · PNG · עד ' + size(MAX_BYTES) + ' · קובץ אחד בכל פעם', 'hra-note');
  const pickMsg = el('p', null, 'hra-problem');
  pickBox.append(chooser, note, pickMsg);

  const card = el('div', null, 'hra-item');
  const cardHead = el('div', null, 'hra-head');
  const cardName = el('span', null, 'hra-name');
  const cardMeta = el('span', null, 'hra-meta');
  const cardPhase = el('span', null, 'hra-state');
  cardHead.append(cardName, cardMeta, cardPhase);
  const cardNote = el('p', null, 'hra-problem');
  const cardActs = el('div', null, 'hra-acts');
  const sendBtn = el('button', 'העלו את הקובץ');
  const againBtn = el('button', 'בדקו מה נקלט');
  const resendBtn = el('button', 'שלחו שוב את אותו קובץ');
  const closeBtn = el('button', 'בררו אם הבקשה נסגרה');
  const dropBtn = el('button', 'הסירו את הבחירה');
  for (const b of [sendBtn, againBtn, resendBtn, closeBtn, dropBtn]) b.type = 'button';
  cardActs.append(sendBtn, againBtn, resendBtn, closeBtn, dropBtn);
  card.append(cardHead, cardNote, cardActs);

  const listHead = el('div', null, 'hra-head');
  const listCount = el('span', null, 'hra-count');
  const refreshBtn = el('button', 'רענון');
  refreshBtn.type = 'button';
  listHead.append(el('h3', 'קבצים מצורפים'), listCount, refreshBtn);
  const listMsg = el('p', null, 'hra-empty');
  const listBody = el('ul', null, 'hra-rows');
  listBody.setAttribute('aria-label', 'קבצים מצורפים');
  const moreBtn = el('button', 'טענו עוד');
  moreBtn.type = 'button';

  box.append(say, pickBox, card, listHead, listMsg, listBody, moreBtn);
  root.append(box);

  /* ---------- the fences ---------- */

  const announce = value => { say.textContent = value; };

  function setLocked(next) {
    if (next === locked) return;
    locked = next;
    try { adapter.onLockChange?.(locked); } catch (_) { /* the host's business */ }
  }

  // The identity reset is deferred: a predicate that resets identity as a
  // side effect runs inside `finally` blocks and re-enters drawing.
  const later = () => queueMicrotask(() => { if (!disposed && safeSession() !== owner) resetIdentity(); });

  /**
   * The only fence. `f` is the stamp an operation took when it started;
   * `ticket` is compared only for selection-bound work.
   */
  function live(f) {
    if (disposed) return false;
    if (safeSession() !== owner) { later(); return false; }
    if (f.fence !== fence) return false;
    return f.ticket == null || f.ticket === ticket;
  }
  const stamp = bound => ({ fence, ticket: bound ? ticket : null });

  function dropBytes() {
    if (pick) { pick.bytes = null; pick.content_base64 = null; }
    pick = null;
    selecting = false;
    input.value = '';
  }

  /**
   * One invalidation path: identity change, context change, pagehide and
   * destroy all come through here. It advances both fences, clears every
   * piece of private state, and releases the host lock.
   *
   * It cancels nothing on the server and promises no quota release: losing
   * the local card is not a cancellation.
   */
  function invalidate() {
    fence += 1;
    ticket += 1;
    listRun += 1;
    listActive = 0;
    dropBytes();
    rows = []; cursor = null; listProblem = null; pickProblem = null;
    pulling.clear();
    pullProblem.clear();
    pullRun += 1;
    setLocked(false);
    announce('');
  }

  /**
   * A refusal of the current identity's authority. Everything private goes
   * through the same invalidation path the lifecycle uses, and one message
   * survives it to say why.
   */
  function refused(why) {
    invalidate();
    pickProblem = why;
    announce(why);
    draw();
  }

  function resetIdentity() {
    invalidate();
    owner = usableSession(safeSession());
    draw();
    if (owner && context) void load(true);
  }

  // The epoch the server signed must name the person sitting here. The host
  // verified it against the token; this is the second, cheaper check.
  function sameIdentity(epoch) {
    return validEpoch(epoch) && !!owner && epoch.uid === owner.uid && epoch.station_id === owner.stationId;
  }

  /* ---------- drawing ---------- */

  function draw() {
    if (disposed) return;
    const usable = !!owner && !!context;
    pickBox.hidden = !usable || context?.canUpload === false || !!pick;
    card.hidden = !pick;
    if (!pick) {
      // Hidden is not gone. A card that keeps the file name in the DOM keeps
      // it readable, so the strings are erased and not merely covered.
      cardName.replaceChildren();
      cardMeta.replaceChildren();
      cardPhase.textContent = '';
      cardNote.textContent = '';
      cardNote.hidden = true;
      delete card.dataset.state;
      delete cardPhase.dataset.busy;
      for (const b of [sendBtn, againBtn, resendBtn, closeBtn, dropBtn]) { b.hidden = true; b.disabled = false; }
    }
    if (pick) {
      const busy = BUSY.includes(pick.phase);
      const held = HOLDS.includes(pick.phase);
      card.dataset.state = pick.phase;
      cardName.replaceChildren(...naming(pick.display_name).childNodes);
      cardMeta.replaceChildren(...meta([TYPE_LABEL[pick.declared_type], size(pick.byte_length)]).childNodes);
      cardPhase.textContent = PHASE[pick.phase];
      cardPhase.dataset.busy = busy ? 'yes' : 'no';
      cardNote.textContent = pick.note || '';
      cardNote.hidden = !pick.note;
      // Unknown is not painted as failure. The screen may not say more than
      // the answer said.
      cardNote.className = pick.phase === 'ready' ? 'hra-ok' : pick.phase === 'attempted' ? 'hra-wait' : 'hra-problem';
      sendBtn.hidden = pick.phase !== 'chosen';
      // Recovery is offered, never taken: the same identifier, the same
      // bytes, and only when a person asks.
      againBtn.hidden = pick.phase !== 'attempted';
      againBtn.textContent = pick.attachment_id ? 'בדקו מה נקלט' : 'שלחו שוב את אותה בקשה';
      // Offered only when the server actually asked for the bytes on a state
      // that can take them. This is the only way to retransmit, and it changes
      // nothing else about the attempt.
      resendBtn.hidden = pick.phase !== 'attempted' || !pick.needsBytes
        || !pick.content_base64 || !pick.attachment_id;
      // Without this the known-identifier recovery can only ever ask `resume`,
      // and a closed attempt answers it with the same throw for ever.
      closeBtn.hidden = pick.phase !== 'attempted' || !pick.attachment_id;
      // An attempt that left this browser cannot be dropped. Only the server
      // closing it, or a publication, ends it here.
      dropBtn.hidden = held;
      dropBtn.textContent = pick.phase === 'ready' ? 'סיימתי' : pick.phase === 'failed' ? 'בחרו קובץ אחר' : 'הסירו את הבחירה';
      for (const b of [sendBtn, againBtn, resendBtn, closeBtn, dropBtn]) b.disabled = busy;
    }
    listHead.hidden = !usable;
    listBody.hidden = !usable;
    listMsg.hidden = !usable || (!listProblem && !listActive && rows.length > 0);
    listMsg.textContent = listActive ? 'טוען…' : listProblem || 'אין קבצים מצורפים.';
    listMsg.className = listProblem ? 'hra-problem' : 'hra-empty';
    listCount.textContent = rows.length ? rows.length + ' קבצים' : '';
    refreshBtn.disabled = !usable || !!listActive;
    moreBtn.hidden = !usable || !cursor;
    moreBtn.disabled = !!listActive;
    listBody.replaceChildren(...rows.map(row => {
      const busy = pulling.has(row.attachment_id);
      const li = el('li', null, 'hra-row');
      li.dataset.id = row.attachment_id;
      const head = el('div', null, 'hra-head');
      head.append(naming(row.display_name), meta([TYPE_LABEL[row.declared_type], size(row.byte_length)]));
      const button = el('button', busy ? 'מוריד…' : 'הורדה');
      button.type = 'button';
      button.disabled = busy;
      button.dataset.pull = row.attachment_id;
      head.append(button);
      li.append(head);
      const problem = pullProblem.get(row.attachment_id);
      if (problem) li.append(el('p', problem, 'hra-problem'));
      return li;
    }));
    pickMsg.textContent = pickProblem || '';
    pickMsg.hidden = !pickProblem;
    setLocked(!!pick && HOLDS.includes(pick.phase));
  }

  /* ---------- failure handling ---------- */

  /**
   * One place decides what a failure means.
   *
   * `clears` - the call was refused outright; private data goes.
   * Nothing else ends an attempt. `aborted` and `failed-precondition` are CAS
   * and cleanup conflicts, `already-exists` covers an already-published
   * membership as well as a reused identifier, and a conflict is not a
   * receipt. Only a ready result or a reserve answering `failed` is.
   */
  function classify(error) {
    const code = errorCode(error);
    // `text` is null for a code we have nothing accurate to say about; the
    // caller supplies the sentence that fits where the failure happened.
    return { code, clears: CLEARS_PRIVATE.includes(code), text: errorMessage(code) };
  }

  /* ---------- listing ---------- */

  function listArgs(next) {
    const data = { parent_kind: context.parent_kind, parent_id: context.parent_id };
    // Documents only, and only when the host gave one. `undefined` is not
    // "omitted" - the field must not exist on the object at all.
    if (context.parent_kind === 'document' && count(context.parent_revision)) data.revision = context.parent_revision;
    if (next) data.cursor = next;
    return data;
  }

  /**
   * The list is owned by one run id. A completion that is not the current run
   * neither renders nor clears the busy flag of the run that replaced it.
   */
  async function load(reset) {
    if (!owner || !context || listActive) return;
    const run = (listRun += 1);
    const f = stamp(false);
    listActive = run;
    listProblem = null;
    if (reset) { rows = []; cursor = null; }
    draw();
    try {
      const out = await adapter.list(listArgs(reset ? null : cursor));
      if (!live(f) || listRun !== run) return;
      if (!out || !Array.isArray(out.items) || !sameIdentity(out.epoch) || !count(out.revision)
        || out.items.length > PAGE_SIZE
        || (out.next_cursor != null && !CURSOR.test(out.next_cursor))
        // A cursor means a full page was cut short; a short page with a cursor
        // is a page that does not describe itself.
        || (out.next_cursor != null && out.items.length !== PAGE_SIZE)) {
        throw Object.assign(new Error('malformed'), { code: 'internal' });
      }
      // The displayed revision is bound: a document list must answer about the
      // revision it was asked about, not about whatever the parent is now.
      if (context.parent_kind === 'document' && out.revision !== context.parent_revision) {
        throw Object.assign(new Error('malformed'), { code: 'internal' });
      }
      // A row we cannot read is not a row we skip. A partial list that looks
      // whole is worse than an honest failure.
      if (!out.items.every(validRow)) throw Object.assign(new Error('malformed'), { code: 'internal' });
      rows = reset ? out.items : rows.concat(out.items);
      cursor = out.next_cursor || null;
    } catch (error) {
      if (!live(f) || listRun !== run) return;
      const verdict = classify(error);
      if (verdict.clears) return refused(verdict.text);
      if (reset) { rows = []; cursor = null; }
      listProblem = verdict.text || 'לא ניתן לטעון את רשימת הקבצים כרגע.';
    } finally {
      // Only the run that owns the flag may clear it.
      if (listActive === run) listActive = 0;
      if (live(f) && listRun === run) draw();
    }
  }

  /* ---------- download ---------- */

  async function pull(row) {
    const id = row.attachment_id;
    if (pulling.has(id)) return;
    const f = stamp(false);
    const run = (pullRun += 1);
    pulling.set(id, run);
    pullProblem.delete(id);
    draw();
    let url = null;
    try {
      const data = { attachment_id: id };
      if (context.parent_kind === 'document' && count(context.parent_revision)) data.revision = context.parent_revision;
      const out = await adapter.download(data);
      if (!live(f)) return;
      // Nothing is allocated until the whole shape has been checked, and the
      // answer must be about the row that was clicked.
      if (!out || out.attachment_id !== id || !sameIdentity(out.epoch)
        || !Object.hasOwn(TYPE_LABEL, out.declared_type) || !count(out.byte_length) || out.byte_length > MAX_BYTES
        || nameProblem(out.display_name)) {
        throw Object.assign(new Error('malformed'), { code: 'internal' });
      }
      const bytes = decodeBounded(out.content_base64, out.byte_length);
      if (!bytes || !signature(bytes, out.declared_type)) {
        throw Object.assign(new Error('malformed'), { code: 'internal' });
      }
      url = URL.createObjectURL(new Blob([bytes], { type: out.declared_type }));
      const anchor = el('a');
      anchor.href = url;
      anchor.download = String(out.display_name).trim();
      anchor.rel = 'noopener';
      box.append(anchor);
      anchor.click();
      anchor.remove();
      announce('הקובץ ' + anchor.download + ' הורד.');
    } catch (error) {
      if (!live(f)) return;
      const verdict = classify(error);
      if (verdict.clears) return refused(verdict.text);
      pullProblem.set(id, verdict.text || 'ההורדה לא הושלמה. אפשר לנסות שוב.');
      announce(pullProblem.get(id));
    } finally {
      // The bytes live for the length of one click, and they are released
      // even when this request no longer owns the row.
      if (url) URL.revokeObjectURL(url);
      if (pulling.get(id) === run) pulling.delete(id);
      if (live(f)) draw();
    }
  }

  /* ---------- reserve · upload · resume ---------- */

  const intentOf = item => ({ request_id: item.request_id, parent_kind: item.parent_kind,
    parent_id: item.parent_id, parent_revision: item.parent_revision, display_name: item.display_name,
    declared_type: item.declared_type, byte_length: item.byte_length, content_sha256: item.content_sha256 });

  function published(item, out) {
    item.phase = 'ready';
    item.attachment_id = out.attachment_id;
    item.revision = out.revision;
    item.bytes = null;
    item.content_base64 = null;
    // "queued" is a queue, not a delivery, and this text never says otherwise.
    item.note = 'הקובץ צורף. גרסה ' + out.revision + '.';
    announce(item.display_name + ' — ' + PHASE.ready);
    draw();
    // The publication is recorded before the host is told, and the host's
    // refresh is awaited nowhere: neither a synchronous throw nor a rejected
    // promise may walk a completed publication back.
    try { Promise.resolve(adapter.onPublished?.({ attachment_id: out.attachment_id, revision: out.revision })).catch(() => {}); }
    catch (_) { /* the host's refresh is the host's problem */ }
    // A request has no displayed revision, so its list can be refreshed here.
    // A document's cannot: the file now lives at N+1 and this context is N.
    if (item.parent_kind === 'request') void load(true);
  }

  /**
   * A ready receipt as the service actually returns it: identity, attachment,
   * revision, `duplicate` and a notification status — which is a queue state
   * and never a delivery.
   *
   * For a document the publication sits exactly one revision past the base the
   * intent was frozen on: the reserve refuses a stale base with `aborted`, so
   * a ready answer that is not base+1 is not an answer about this intent. A
   * request carries no displayed revision, so only its presence is checked.
   */
  function readyShape(out, item) {
    if (!out || out.state !== 'ready' || !KEY.test(out.attachment_id || '')) return false;
    if (item.attachment_id && out.attachment_id !== item.attachment_id) return false;
    if (!count(out.revision) || !sameIdentity(out.epoch)) return false;
    if (typeof out.duplicate !== 'boolean' || !text(out.notification_status, 64)) return false;
    return item.parent_kind !== 'document' || out.revision === item.parent_revision + 1;
  }

  // Everything that is neither a publication nor a closure lands here.
  function unknown(item, note) {
    item.phase = 'attempted';
    item.note = note;
    announce(item.display_name + ' — ' + PHASE.attempted);
    draw();
  }

  function closed(item, note) {
    item.phase = 'failed';
    item.note = note;
    item.needsBytes = false;
    item.bytes = null;
    item.content_base64 = null;
    draw();
  }

  function afterFailure(item, error) {
    const verdict = classify(error);
    if (verdict.clears) return refused(verdict.text);
    unknown(item, verdict.text ? verdict.text + ' ' + UNKNOWN_TEXT : UNKNOWN_TEXT);
  }

  /**
   * Ask the reserve, and only the reserve. It is idempotent on the request id,
   * so asking again is asking the same question — and it is the **only** call
   * that carries an authoritative `failed`. `resume` throws
   * `failed-precondition` on a closed attempt, and a thrown code is not a
   * receipt: it cannot be told apart from the same code raised by a parent
   * that moved.
   *
   * Returns 'ready' | 'failed' | 'reserved' | 'held' | 'gone', where 'gone'
   * means the caller must stop because the fence moved under it.
   */
  async function askReserve(item, f) {
    const reserved = await adapter.reserve(intentOf(item));
    if (!live(f) || pick !== item) return 'gone';
    if (!reserved || !KEY.test(reserved.attachment_id || '') || !SERVER_STATES.includes(reserved.state)
      || !sameIdentity(reserved.epoch) || typeof reserved.duplicate !== 'boolean'
      || !count(reserved.reserve_expires_ms)
      // An attempt that already has an identifier keeps it. A receipt about a
      // different attachment is not a receipt about this one, whatever it
      // says: the epoch proves who is asking, not which file is answered.
      || (item.attachment_id && reserved.attachment_id !== item.attachment_id)) {
      throw Object.assign(new Error('malformed'), { code: 'internal' });
    }
    // Only now, and only for the first reservation, is the identifier learned.
    item.attachment_id = reserved.attachment_id;
    // Already linked: sending the bytes again would be a second upload of a
    // file that is already attached.
    if (reserved.state === 'ready') {
      if (!readyShape(reserved, item)) throw Object.assign(new Error('malformed'), { code: 'internal' });
      published(item, reserved);
      return 'ready';
    }
    // The one authoritative closure. It clears the bytes and releases the host.
    if (reserved.state === 'failed') {
      closed(item, 'השרת מדווח שהניסיון הזה נסגר. אפשר לבחור קובץ מחדש.');
      return 'failed';
    }
    if (reserved.state === 'reserved') return 'reserved';
    // cleaning / stored / stored_pending: bytes may already be there, or a
    // cleanup may be running. Neither is a receipt and neither is a failure.
    unknown(item, reserved.state === 'cleaning'
      ? 'השרת מנקה את הניסיון הזה. לא ידוע מה נקלט; אפשר לבדוק שוב מאוחר יותר.' : UNKNOWN_TEXT);
    return 'held';
  }

  /** Reserve, then upload. Reserving is idempotent on the request id, so this
   *  is also the recovery for an attempt whose identifier never came back. */
  async function send(item) {
    const f = stamp(true);
    // The attempt is recorded before the call leaves, not after it answers.
    item.attempted = true;
    item.note = null;
    item.phase = 'reserving';
    draw();
    try {
      const outcome = await askReserve(item, f);
      // The helper checked the fence for its own work. This is a second
      // boundary: an identity or context reset can land between its return
      // and this continuation, and the upload below is this function's.
      if (!live(f) || pick !== item || outcome !== 'reserved') return;
      item.phase = 'uploading';
      draw();
      const out = await adapter.upload({ ...intentOf(item), content_base64: item.content_base64 });
      if (!live(f) || pick !== item) return;
      if (!readyShape(out, item)) throw Object.assign(new Error('malformed'), { code: 'internal' });
      published(item, out);
    } catch (error) {
      if (!live(f) || pick !== item) return;
      afterFailure(item, error);
    }
  }

  /**
   * Ask the reserve whether this attempt is closed. Nothing else: no upload,
   * no new identifier, no new base. A `reserved` answer means the attempt is
   * still open, which is not a closure either — it stays held, and the person
   * decides what to do next.
   */
  async function recheck(item) {
    const f = stamp(true);
    item.phase = 'reserving';
    item.note = null;
    draw();
    try {
      const outcome = await askReserve(item, f);
      // Same boundary: without this the old file can be announced after a
      // reset, and the host lock brought back with it.
      if (!live(f) || pick !== item) return;
      if (outcome === 'reserved') {
        unknown(item, 'ההזמנה עדיין פתוחה בשרת, ולא נמסרה תשובה על הקובץ. לא ידוע אם הוא נקלט.');
      }
    } catch (error) {
      if (!live(f) || pick !== item) return;
      // Not even `failed-precondition` closes it here: the same code covers a
      // parent that moved, and a guess is not a receipt.
      afterFailure(item, error);
    }
  }

  /**
   * Send the same bytes again on the same attempt. Not a new request, not a
   * new identifier, not a new base: `intentOf` is the intent frozen at
   * selection, and `content_base64` is the string built from it. The attempt
   * is never dropped, rebased or unlocked to get here.
   */
  async function resend(item) {
    if (!item.content_base64 || !KEY.test(item.attachment_id || '')) return;
    const f = stamp(true);
    item.phase = 'uploading';
    item.note = RESENDING_TEXT;
    draw();
    try {
      const out = await adapter.upload({ ...intentOf(item), content_base64: item.content_base64 });
      if (!live(f) || pick !== item) return;
      if (!readyShape(out, item)) throw Object.assign(new Error('malformed'), { code: 'internal' });
      published(item, out);
    } catch (error) {
      if (!live(f) || pick !== item) return;
      afterFailure(item, error);
    }
  }

  /** Explicit recovery on the identifier that already exists. It never
   *  replaces the identifier, the revision or the file. */
  async function recover(item) {
    if (!KEY.test(item.attachment_id || '')) return send(item);
    const f = stamp(true);
    item.phase = 'resuming';
    item.note = null;
    // The request for bytes is re-earned on every check, never remembered.
    item.needsBytes = false;
    draw();
    try {
      const out = await adapter.resume({ attachment_id: item.attachment_id });
      if (!live(f) || pick !== item) return;
      if (!out || out.attachment_id !== item.attachment_id || !sameIdentity(out.epoch)
        || !SERVER_STATES.includes(out.state)) {
        throw Object.assign(new Error('malformed'), { code: 'internal' });
      }
      if (out.state === 'ready') {
        if (!readyShape(out, item)) throw Object.assign(new Error('malformed'), { code: 'internal' });
        return published(item, out);
      }
      // `upload-required` asks for the bytes again on the same attempt. It is
      // not evidence that an earlier upload cannot still arrive, so the
      // attempt stays an attempt and the card stays held — but from here the
      // person can actually send the same bytes again.
      const asks = out.resume === 'upload-required'
        && ['reserved', 'stored_pending', 'stored'].includes(out.state);
      if (asks && item.content_base64) {
        item.needsBytes = true;
        return unknown(item, RESEND_TEXT);
      }
      unknown(item, UNKNOWN_TEXT);
    } catch (error) {
      if (!live(f) || pick !== item) return;
      afterFailure(item, error);
    }
  }

  /* ---------- selection ---------- */

  // Selection-only invalidation: it advances the selection ticket without
  // disturbing a list or a download in flight.
  function invalidateSelection() {
    ticket += 1;
    dropBytes();
    setLocked(false);
  }

  function refuse(name, why, f) {
    if (!live(f)) return;
    invalidateSelection();
    pickProblem = why;
    announce(name + ' — ' + why);
    draw();
  }

  async function choose(file, f) {
    const name = String(file.name ?? '').trim();
    try {
      const bad = nameProblem(file.name);
      if (bad) return refuse(name, bad, f);
      if (!file.size || file.size > MAX_BYTES) {
        return refuse(name, !file.size ? 'הקובץ ריק.' : 'הקובץ גדול מ-' + size(MAX_BYTES) + '.', f);
      }
      let bytes;
      try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (_) {
        return refuse(name, 'לא ניתן לקרוא את הקובץ מהמכשיר.', f);
      }
      if (!live(f)) return;
      const type = detectType(bytes);
      if (!type) return refuse(name, 'אפשר לצרף PDF, JPEG או PNG בלבד. הקובץ שנבחר אינו אחד מהם.', f);
      let digest;
      try { digest = hex(await crypto.subtle.digest('SHA-256', bytes)); } catch (_) {
        return refuse(name, 'לא ניתן לחשב את חתימת הקובץ במכשיר הזה.', f);
      }
      if (!live(f)) return;
      // The identifier, the intent and the bytes freeze together, here.
      // Nothing downstream may swap any of them.
      pick = { request_id: crypto.randomUUID(), display_name: name, declared_type: type,
        byte_length: bytes.length, content_sha256: digest, content_base64: base64(bytes), bytes: null,
        parent_kind: context.parent_kind, parent_id: context.parent_id, parent_revision: context.parent_revision,
        phase: 'chosen', note: null, attachment_id: null, attempted: false, needsBytes: false };
      announce(name + ' — ' + PHASE.chosen);
      draw();
    } finally {
      // Only the selection that still owns the ticket may release the latch.
      if (!disposed && f.fence === fence && f.ticket === ticket) selecting = false;
    }
  }

  /* ---------- wiring ---------- */

  on(input, 'change', event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!owner || !context || context.canUpload === false) return;
    // Exclusive, and decided synchronously. A second selection while the
    // first is still being read, or while a file is in flight, is refused
    // outright: it must never be able to replace what is already on its way.
    if (pick || selecting) {
      pickProblem = 'כבר יש קובץ בטיפול. סיימו אותו לפני בחירת קובץ נוסף.';
      draw();
      return;
    }
    if (!files.length) return;
    selecting = true;
    ticket += 1;
    pickProblem = files.length > 1 ? 'אפשר לצרף קובץ אחד בכל פעם. נבחר הראשון.' : null;
    void choose(files[0], stamp(true));
  });
  on(sendBtn, 'click', () => { if (pick && pick.phase === 'chosen') void send(pick); });
  on(againBtn, 'click', () => { if (pick && pick.phase === 'attempted') void recover(pick); });
  on(resendBtn, 'click', () => { if (pick && pick.phase === 'attempted') void resend(pick); });
  on(closeBtn, 'click', () => { if (pick && pick.phase === 'attempted' && pick.attachment_id) void recheck(pick); });
  on(dropBtn, 'click', () => { if (pick && !HOLDS.includes(pick.phase)) { invalidateSelection(); draw(); } });
  on(refreshBtn, 'click', () => { void load(true); });
  on(moreBtn, 'click', () => { void load(false); });
  on(listBody, 'click', event => {
    const id = event.target instanceof Element ? event.target.dataset.pull : null;
    if (!id) return;
    const row = rows.find(r => r.attachment_id === id);
    if (row) void pull(row);
  });
  // Leaving the page clears everything held locally. It cancels nothing the
  // server may already have done, and it releases no quota.
  on(window, 'pagehide', () => { invalidate(); draw(); });

  const unsubscribe = adapter.subscribeIdentity(() => { if (safeSession() !== owner) resetIdentity(); });
  draw();

  return {
    /**
     * The host owns the context. After a publication it refreshes the parent
     * and passes the new revision in; the component never rebases itself.
     */
    setContext(next) {
      if (disposed) return;
      if (next === null) { context = null; invalidate(); draw(); return; }
      if (!next || !PARENT_KINDS.includes(next.parent_kind) || !KEY.test(String(next.parent_id || ''))
        || !count(next.parent_revision)) {
        throw new TypeError('parent_kind, parent_id and parent_revision are required');
      }
      const same = context && context.parent_kind === next.parent_kind && context.parent_id === next.parent_id
        && context.parent_revision === next.parent_revision && context.canUpload === (next.canUpload !== false);
      if (same) return;
      context = { parent_kind: next.parent_kind, parent_id: next.parent_id,
        parent_revision: next.parent_revision, canUpload: next.canUpload !== false };
      invalidate();
      draw();
      if (owner) void load(true);
    },
    isLocked() { return locked; },
    destroy() {
      if (disposed) return;
      // Invalidate first, so the host is told the lock is released while the
      // callback is still allowed to run.
      invalidate();
      context = null;
      disposed = true;
      for (const remove of removers) remove();
      removers.length = 0;
      try { unsubscribe?.(); } catch (_) { /* an adapter that never subscribed */ }
      box.remove();
    }
  };
}

export const internals = { detectType, nameProblem, size, base64, decodeBounded, errorMessage, errorCode,
  naming, LATIN_RUN, validRow, validEpoch, usableSession, MAX_BYTES, MAX_NAME, MAX_BASE64, TYPES, PHASE,
  BUSY, HOLDS, SERVER_STATES, CLEARS_PRIVATE, PAGE_SIZE, CURSOR };
