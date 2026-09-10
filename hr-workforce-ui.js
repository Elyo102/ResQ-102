const disconnected = { currentSession: () => null, subscribeIdentity: () => () => {} };
const KEY = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['long_absence', 'abroad_leave']);
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

function sessionKey(adapter) {
  try {
    const s = adapter.currentSession();
    return s && (s.super === true || s.role === 'hr_coordinator')
      ? JSON.stringify([s.uid, s.stationId, s.role, s.super === true, s.epoch]) : null;
  } catch (_) { return null; }
}

function validCase(value) {
  return value && KEY.test(value.record_id || '') && KINDS.has(value.kind)
    && ['active', 'closed'].includes(value.status) && typeof value.subject_uid === 'string'
    && typeof value.subject_employee_number === 'string' && !!value.subject_employee_number
    && typeof value.subject_full_name === 'string' && !!value.subject_full_name
    && DATE.test(value.start_date || '') && (value.end_date === null || DATE.test(value.end_date))
    && DATE.test(value.followup_date || '') && typeof value.reason === 'string'
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && Number.isSafeInteger(value.updated_at_ms);
}

function exact(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  return typeof value.duplicate === 'boolean';
}

function validMutationResult(value, op, creating) {
  return exact(value, ['record_id', 'revision', 'status', 'event_id', 'duplicate'])
    && KEY.test(value.record_id) && KEY.test(value.event_id)
    && value.status === op.data.status
    && Number.isSafeInteger(value.revision)
    && value.revision === (creating ? 1 : op.data.expected_revision + 1)
    && (creating || value.record_id === op.data.record_id);
}

function validReminderResult(value, op) {
  return exact(value, ['record_id', 'revision', 'event_id', 'notification_status', 'duplicate'])
    && value.record_id === op.data.record_id && KEY.test(value.event_id)
    && value.revision === op.data.expected_revision
    && value.notification_status === 'intent_only';
}

export function createHrWorkforceUI(root, adapter = disconnected) {
  const q = key => root.querySelector(`[data-w="${key}"]`);
  let owner = null, generation = 0, items = [], cursor = null, busy = false;
  let chosen = null, editing = null, filter = 'long_absence', disposed = false;
  const attempts = new Map();
  const alive = (g, key) => !disposed && g === generation && key === owner && key === sessionKey(adapter);
  const message = value => { q('message').textContent = value; };
  const due = item => item.status === 'active' && item.followup_date <= today();
  const kindLabel = kind => kind === 'abroad_leave' ? 'חופש בחו״ל' : 'היעדרות ממושכת';
  const request = (scope, payload) => {
    const key = scope + ':' + JSON.stringify(payload);
    if (!attempts.has(key)) attempts.set(key, crypto.randomUUID());
    return { key, data: { request_id: attempts.get(key), ...payload } };
  };
  const completed = key => attempts.delete(key);

  function resetForm() {
    chosen = null; editing = null;
    q('chosen').textContent = 'לא נבחר עובד.';
    q('kind').value = filter === 'abroad_leave' ? 'abroad_leave' : 'long_absence';
    for (const key of ['start', 'end', 'reason', 'followup']) q(key).value = '';
    q('candidates').replaceChildren();
  }

  function controls() {
    const signed = !!owner;
    for (const key of ['refresh', 'search-button']) q(key).disabled = !signed || busy;
    q('more').hidden = !cursor; q('more').disabled = !signed || busy;
    q('save').disabled = !signed || busy || !chosen;
    q('tab-absence').setAttribute('aria-pressed', String(filter === 'long_absence'));
    q('tab-abroad').setAttribute('aria-pressed', String(filter === 'abroad_leave'));
    q('tab-due').setAttribute('aria-pressed', String(filter === 'due'));
  }

  function editCase(item) {
    if (!owner || busy) return;
    editing = item;
    chosen = { uid: item.subject_uid, name: item.subject_full_name,
      employee_number: item.subject_employee_number };
    q('chosen').textContent = `נבחר: ${item.subject_full_name} · ${item.subject_employee_number}`;
    q('kind').value = item.kind; q('start').value = item.start_date;
    q('end').value = item.end_date || ''; q('reason').value = item.reason;
    q('followup').value = item.followup_date; controls();
    q('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function render() {
    const list = q('list'); list.replaceChildren();
    const shown = items.filter(item => filter === 'due' ? due(item) : item.kind === filter);
    for (const item of shown) {
      const card = el('article', undefined, 'hr-case'); card.dataset.due = String(due(item));
      card.append(el('h4', item.subject_full_name),
        el('p', `${kindLabel(item.kind)} · מספר עובד: ${item.subject_employee_number}`),
        el('p', `התחלה: ${item.start_date}${item.end_date ? ` · חזרה/סיום: ${item.end_date}` : ''}`),
        el('p', `נימוק פנימי: ${item.reason}`),
        el('p', `תזכורת: ${item.followup_date}${due(item) ? ' · הגיע המועד' : ''}`, 'hr-meta'));
      const actions = el('div', undefined, 'hr-case-actions');
      const edit = el('button', 'עריכה'); edit.type = 'button'; edit.onclick = () => editCase(item);
      const close = el('button', 'סיום מעקב'); close.type = 'button'; close.onclick = () => void closeCase(item);
      actions.append(edit, close);
      if (due(item)) {
        const remind = el('button', 'שליחת תזכורת פנימית'); remind.type = 'button';
        remind.onclick = () => void remindCase(item); actions.append(remind);
      }
      card.append(actions); list.append(card);
    }
    if (!shown.length) list.append(el('p', filter === 'due'
      ? 'אין תזכורות שהגיע מועדן ברשומות שנטענו.'
      : `אין ${kindLabel(filter)} פעיל ברשומות שנטענו.`, 'hr-meta'));
    q('absence-count').textContent = String(items.filter(x => x.kind === 'long_absence').length) + (cursor ? '+' : '');
    q('abroad-count').textContent = String(items.filter(x => x.kind === 'abroad_leave').length) + (cursor ? '+' : '');
    q('due-count').textContent = String(items.filter(due).length) + (cursor ? '+' : '');
    controls();
  }

  async function load(append = false) {
    if (!owner || busy) return;
    const g = generation, key = owner; busy = true; controls(); message('טוען מעקבי כוח אדם…');
    try {
      const out = await adapter.listCases(append && cursor ? { cursor } : {});
      if (!alive(g, key)) return;
      if (!out || !Array.isArray(out.items) || out.items.length > 25
          || !(out.next_cursor === null || KEY.test(out.next_cursor)) || !out.items.every(validCase)) throw Error('invalid response');
      const merged = append ? items.concat(out.items) : out.items;
      if (new Set(merged.map(x => x.record_id)).size !== merged.length) throw Error('duplicate response');
      items = merged.filter(x => x.status === 'active'); cursor = out.next_cursor; render();
      message(cursor ? `הוצגו ${items.length} מעקבים; קיימים נוספים.` : 'המעקבים מעודכנים לזמן הטעינה.');
    } catch (_) {
      if (alive(g, key)) { if (!append) { items = []; cursor = null; render(); } message('לא ניתן לטעון את המעקב כרגע.'); }
    } finally { if (alive(g, key)) { busy = false; controls(); } }
  }

  async function closeCase(item) {
    if (!owner || busy || !validCase(item)) return;
    const g = generation, key = owner; busy = true; controls(); message('מסיים את המעקב…');
    const op = request('close', { record_id: item.record_id,
      expected_revision: item.revision, subject_uid: item.subject_uid, kind: item.kind,
      start_date: item.start_date, end_date: item.end_date || today(), followup_date: item.followup_date,
      reason: item.reason, status: 'closed' });
    try {
      const out = await adapter.updateCase(op.data); if (!alive(g, key)) return;
      if (!validMutationResult(out, op, false)) throw Error('invalid response');
      completed(op.key);
      items = items.filter(x => x.record_id !== item.record_id); render();
      message('המעקב הסתיים ונשמר ביומן השינויים.');
    } catch (error) {
      if (alive(g, key)) { if(String(error?.code || '').includes('aborted')) completed(op.key); message(String(error?.code || '').includes('aborted')
        ? 'הרשומה השתנתה. יש לרענן.' : 'סיום המעקב נכשל; לחיצה נוספת תשדר שוב את אותה בקשה.'); }
    } finally { if (alive(g, key)) { busy = false; controls(); } }
  }

  async function remindCase(item) {
    if (!owner || busy || !validCase(item) || !due(item)) return;
    const g = generation, key = owner; busy = true; controls(); message('רושם תזכורת מאובטחת…');
    try {
      const op=request('reminder',{record_id:item.record_id,expected_revision:item.revision});
      const out = await adapter.queueReminder(op.data);
      if (!alive(g, key)) return;
      if (!validReminderResult(out, op)) throw Error('invalid response');
      completed(op.key);
      message('התזכורת הוכנסה לתור. זו אינה הוכחה למסירה או לקריאה.');
    } catch (_) { if (alive(g, key)) message('לא ניתן לרשום כרגע; לחיצה נוספת תשדר שוב את אותה בקשה.'); }
    finally { if (alive(g, key)) { busy = false; controls(); } }
  }

  async function search() {
    if (!owner || busy) return;
    const name = q('search').value.trim(), g = generation, key = owner;
    if (name.length < 2) { message('יש להזין לפחות שני תווים לחיפוש.'); return; }
    busy = true; controls(); message('מחפש עובד…');
    try {
      const out = await adapter.searchPeople({ name }); if (!alive(g, key)) return;
      if (!out || !Array.isArray(out.items) || out.items.length > 25) throw Error('invalid response');
      q('candidates').replaceChildren();
      for (const person of out.items) {
        if (!person || typeof person.uid !== 'string' || typeof person.name !== 'string') throw Error('invalid response');
        const button = el('button', `${person.name}${person.employee_number ? ` · ${person.employee_number}` : ''}${person.crew ? ` · משמרת ${person.crew}` : ''}`);
        button.type = 'button'; button.onclick = () => {
          if (!alive(g, key) || busy) return;
          chosen = person; editing = null;
          q('chosen').textContent = `נבחר: ${person.name}${person.employee_number ? ` · ${person.employee_number}` : ''}`;
          controls();
        };
        q('candidates').append(button);
      }
      message(out.items.length ? 'בחרו עובד מתוצאות החיפוש.' : 'לא נמצאו עובדים פעילים בשם הזה.');
    } catch (_) { if (alive(g, key)) message('חיפוש העובד נכשל. נסו שוב.'); }
    finally { if (alive(g, key)) { busy = false; controls(); } }
  }

  async function save(event) {
    event.preventDefault(); if (!owner || busy || !chosen) return;
    const kind = q('kind').value, start = q('start').value, end = q('end').value || null;
    const followup = q('followup').value, reason = q('reason').value.trim();
    if (!KINDS.has(kind) || !DATE.test(start) || (end && !DATE.test(end)) || !DATE.test(followup)
        || !reason || (kind === 'abroad_leave' && !end)) {
      message('יש להשלים סוג, תאריכים, תזכורת ונימוק תקינים. לחופש בחו״ל נדרש תאריך חזרה.'); return;
    }
    const g = generation, key = owner; busy = true; controls(); message('שומר מעקב…');
    const op = request(editing?'update':'create', { subject_uid: chosen.uid, kind, start_date: start,
      end_date: end, reason, followup_date: followup, status: 'active',
      ...(editing ? { record_id: editing.record_id, expected_revision: editing.revision } : {}) });
    try {
      const out = await (editing ? adapter.updateCase(op.data) : adapter.createCase(op.data));
      if (!alive(g, key)) return;
      if (!validMutationResult(out, op, !editing)) throw Error('invalid response');
      completed(op.key);
      resetForm(); message('המעקב נשמר עם חתימת המשתמש המבצע.'); busy = false; await load();
    } catch (error) {
      if (alive(g, key)) { if(String(error?.code || '').includes('aborted')) completed(op.key); message(String(error?.code || '').includes('aborted')
        ? 'הרשומה השתנתה. רעננו לפני שמירה נוספת.' : 'שמירת המעקב לא אושרה; לחיצה נוספת תשדר שוב את אותה בקשה.'); }
    } finally { if (alive(g, key)) { busy = false; controls(); } }
  }

  q('refresh').onclick = () => void load(); q('more').onclick = () => void load(true);
  q('search-button').onclick = () => void search(); q('editor').addEventListener('submit', save);
  q('tab-absence').onclick = () => { filter = 'long_absence'; resetForm(); render(); };
  q('tab-abroad').onclick = () => { filter = 'abroad_leave'; resetForm(); render(); };
  q('tab-due').onclick = () => { filter = 'due'; resetForm(); render(); };
  const unsubscribe = adapter.subscribeIdentity(() => {
    const next = sessionKey(adapter); if (next === owner) return;
    owner = next; ++generation; attempts.clear(); items = []; cursor = null; busy = false; resetForm(); render();
    message(owner ? 'טוען מעקבי כוח אדם…' : 'ממתין לחיבור מאובטח עם הרשאת משאבי אנוש.');
    if (owner) void load();
  });
  owner = sessionKey(adapter); resetForm(); render();
  if (owner) void load(); else message('ממתין לחיבור מאובטח עם הרשאת משאבי אנוש.');
  return { destroy() { disposed = true; ++generation; attempts.clear(); unsubscribe(); } };
}
