import { firebaseConfig } from './firebase-config.js?v=41a';
import { renderNav, renderStuckNav } from './nav.js?v=42f';
import { initPWA } from './pwa.js?v=41a';
import { initAppCheck } from './appcheck.js?v=41a1';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const app = initializeApp(firebaseConfig);
await initAppCheck(app);
const auth = getAuth(app);
const functions = getFunctions(app, 'europe-west1');
const call = Object.freeze({
  status: httpsCallable(functions, 'getScheduleRuntimeStatus'),
  setup: httpsCallable(functions, 'getScheduleManagerSetup'),
  run: httpsCallable(functions, 'runSchedulePlanner'),
  preview: httpsCallable(functions, 'getScheduleDraftPreview'),
  publish: httpsCallable(functions, 'publishSchedule'),
  rollback: httpsCallable(functions, 'rollbackSchedule'),
  mine: httpsCallable(functions, 'getMyScheduleV2'),
  station: httpsCallable(functions, 'getStationScheduleV2'),
  respond: httpsCallable(functions, 'respondToSchedule')
});

const $ = (id) => document.getElementById(id);
const state = {
  user: null, claims: {}, status: null, setup: null, draft: null,
  draftPreview: null, previewStart: null,
  mine: null, mineDate: localDate(), stationDate: localDate(), tab: null, busy: false
};

renderStuckNav('');
initPWA({ offer: false });

function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((out, part) => {
    out[part.type] = part.value;
    return out;
  }, {});
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function monthStart() { return localDate().slice(0, 7); }

function shiftDate(iso, amount) {
  const date = new Date(iso + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function requestId(prefix) {
  const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replace(/-/g, '')
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return prefix + '_' + id;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }

function errorText(error) {
  const message = String((error && error.message) || 'הפעולה נכשלה.');
  return message.replace(/^Firebase:\s*/i, '').replace(/^\w+\/[^:]+:\s*/i, '');
}

function message(target, text, kind) {
  const box = typeof target === 'string' ? $(target) : target;
  clear(box);
  if (!text) return;
  box.appendChild(node('div', 'msg ' + (kind || 'info'), text));
}

function dateLabel(iso) {
  try {
    return new Intl.DateTimeFormat('he-IL', {
      timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'numeric'
    }).format(new Date(iso + 'T00:00:00.000Z'));
  } catch (_) { return iso; }
}

function setMode(status) {
  const box = $('mode');
  box.className = 'mode';
  let text = 'המנוע החדש כבוי. הסידור הקיים ממשיך לעבוד ללא שינוי.';
  if (status.mode === 'shadow') {
    text = 'מצב בדיקה: אפשר ליצור טיוטות, אך אי אפשר לפרסם אותן למשתמשים.';
  } else if (status.mode === 'new') {
    box.classList.add('good');
    text = 'המנוע החדש פעיל. פרסום מחליף את הסידור הפעיל ושולח עדכון אישי.';
  } else box.classList.add('bad');
  if (!status.configured) text += ' עדיין חסרים חוקי תחנה או מקור כוח-אדם חתום.';
  if (status.manager && status.active && Number(status.active.delivery_alerts || 0) > 0) {
    box.classList.remove('good'); box.classList.add('bad');
    text += ' יש ' + status.active.delivery_alerts + ' התראות שלא נמסרו ודורשות טיפול.';
  }
  box.lastElementChild.textContent = text;
}

function chooseTab(name, replaceUrl = true) {
  if (name === 'manage' && (!state.status || !state.status.manager)) name = 'mine';
  if (['manage', 'mine', 'station'].indexOf(name) === -1) name = 'mine';
  state.tab = name;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.classList.toggle('on', button.dataset.tab === name);
    button.setAttribute('aria-selected', button.dataset.tab === name ? 'true' : 'false');
  });
  $('manageView').hidden = name !== 'manage';
  $('mineView').hidden = name !== 'mine';
  $('stationView').hidden = name !== 'station';
  if (replaceUrl) {
    const url = new URL(location.href);
    url.searchParams.set('tab', name);
    history.replaceState(null, '', url);
  }
  if (name === 'mine') renderMine();
  if (name === 'station') loadStation();
}

function renderPolicy() {
  const list = $('policy');
  clear(list);
  const setup = state.setup;
  if (!setup || !setup.configured) {
    $('sourceSummary').textContent = 'אין מדיניות ומקור נתונים פעילים.';
    return;
  }
  $('sourceSummary').textContent = 'מקור ' + setup.source.version + ' · מהדורה ' + setup.source.revision;
  setup.policy.sub_stations.forEach((sub) => {
    const row = node('div', 'policy-row');
    row.appendChild(node('span', '', sub.label));
    row.appendChild(node('b', '', 'מינימום ' + sub.minimum));
    list.appendChild(row);
    (sub.requirements || []).forEach((requirement) => {
      const detail = node('div', 'policy-row');
      detail.appendChild(node('span', '', requirement.label || requirement.role));
      detail.appendChild(node('b', '', requirement.count + (requirement.required ? ' חובה' : ' רצוי')));
      list.appendChild(detail);
    });
  });
}

function option(select, value, label) {
  const item = node('option', '', label);
  item.value = value;
  select.appendChild(item);
}

function addOverride(initial = {}) {
  if (!state.setup || !state.setup.configured) return;
  const row = node('div', 'override');
  const dateWrap = node('div');
  const dateLabelNode = node('label', '', 'תאריך');
  const date = node('input');
  date.type = 'date'; date.value = initial.date || (monthStart() + '-01');
  dateWrap.append(dateLabelNode, date);

  const subWrap = node('div');
  const subLabel = node('label', '', 'תחנת קצה');
  const sub = node('select'); sub.dataset.field = 'sub_station';
  state.setup.policy.sub_stations.forEach((value) => option(sub, value.id, value.label));
  sub.value = initial.sub_station || sub.value;
  subWrap.append(subLabel, sub);

  const personWrap = node('div', 'wide');
  const personLabel = node('label', '', 'אדם');
  const person = node('select'); person.dataset.field = 'person';
  state.setup.people.forEach((value) => option(person, value.id, value.name));
  person.value = initial.person || person.value;
  personWrap.append(personLabel, person);

  const roleWrap = node('div');
  const roleLabel = node('label', '', 'תפקיד בשיבוץ');
  const role = node('select'); role.dataset.field = 'role';
  const updateRoles = () => {
    const selected = state.setup.people.find((value) => value.id === person.value);
    clear(role); option(role, '', 'לפי צורכי המנוע');
    (selected && selected.roles || []).forEach((value) => option(role, value, value));
    if (initial.role) role.value = initial.role;
  };
  person.addEventListener('change', updateRoles); updateRoles();
  roleWrap.append(roleLabel, role);

  const remove = node('button', 'btn danger remove', 'הסר');
  remove.type = 'button'; remove.addEventListener('click', () => row.remove());
  date.dataset.field = 'date';
  row.append(dateWrap, subWrap, personWrap, roleWrap, remove);
  $('overrideList').appendChild(row);
}

function overrides() {
  return Array.from($('overrideList').querySelectorAll('.override')).map((row) => {
    const get = (field) => row.querySelector('[data-field="' + field + '"]').value;
    const value = {
      date: get('date'), sub_station: get('sub_station'), person: get('person'), role: get('role') || null
    };
    if (!value.date || !value.sub_station || !value.person) throw new Error('יש להשלים כל שיבוץ ידני.');
    return value;
  });
}

function renderSummary(summary) {
  const box = $('draftSummary'); clear(box); box.classList.remove('hide');
  const values = [
    ['שובצו', summary.filled || 0], ['חוסרים חוסמים', summary.blocking_gaps || 0],
    ['ימים מתחת למינימום', summary.days_below_minimum || 0], ['שינויים שנדחו', summary.rejected_manual || 0]
  ];
  values.forEach(([label, value]) => {
    const metric = node('div', 'metric');
    metric.append(node('b', '', value), node('span', '', label)); box.appendChild(metric);
  });
}

function updatePublishAvailability() {
  const gaps = Number((state.draft && state.draft.summary || {}).blocking_gaps || 0);
  $('publish').disabled = state.busy || !state.draft || !state.draftPreview
    || !$('reviewDraft').checked || !state.status || state.status.mode !== 'new' || gaps > 0;
}

function renderDraftPreview(preview) {
  const card = $('draftPreviewCard');
  const box = $('draftPreview');
  card.classList.remove('hide'); clear(box);
  (preview.days || []).forEach((day) => box.appendChild(stationBlock(day, dateLabel(day.date))));
  if (!(preview.days || []).length) box.appendChild(node('div', 'empty', 'אין שיבוצים בשבוע הזה.'));
  const first = (preview.days || [])[0];
  const last = (preview.days || [])[preview.days.length - 1];
  $('previewRange').textContent = first && last ? first.date + ' — ' + last.date : preview.week_start;
  $('previewPrev').disabled = preview.week_start <= preview.from;
  $('previewNext').disabled = !last || last.date >= preview.to;
}

async function loadDraftPreview(start, resetApproval) {
  if (!state.draft) return;
  state.previewStart = start || state.draft.from;
  state.draftPreview = null;
  if (resetApproval !== false) $('reviewDraft').checked = false;
  $('reviewDraft').disabled = true;
  updatePublishAvailability();
  clear($('draftPreview')); $('draftPreview').appendChild(node('div', 'loader'));
  $('draftPreviewCard').classList.remove('hide');
  message('previewMessage', 'טוען את הטיוטה לבדיקה…', 'info');
  try {
    const preview = (await call.preview({
      draft_id: state.draft.draft_id,
      start: state.previewStart
    })).data;
    if (!state.draft || preview.draft_id !== state.draft.draft_id) return;
    state.draftPreview = preview;
    state.previewStart = preview.week_start;
    renderDraftPreview(preview);
    $('reviewDraft').disabled = false;
    message('previewMessage', 'הטיוטה מוצגת לבדיקה. היא עדיין לא פורסמה.', 'ok');
  } catch (error) {
    message('previewMessage', errorText(error), 'err');
  }
  updatePublishAvailability();
}

async function runPlanner() {
  if (state.busy) return;
  state.busy = true; $('runPlanner').disabled = true; state.draft = null; state.draftPreview = null;
  $('publish').disabled = true; $('reviewDraft').checked = false; $('reviewDraft').disabled = true;
  $('draftPreviewCard').classList.add('hide');
  message('runMessage', 'המנוע בונה טיוטה ובודק את כל החוקים…', 'info');
  try {
    const startMonth = $('startMonth').value;
    if (!/^\d{4}-\d{2}$/.test(startMonth)) throw new Error('יש לבחור חודש התחלה.');
    const result = (await call.run({
      request_id: requestId('draft'), start: startMonth + '-01',
      months: Number($('months').value), overrides: overrides()
    })).data;
    state.draft = result;
    renderSummary(result.summary || {});
    message('runMessage', 'הטיוטה הושלמה. היא עדיין לא פורסמה ולא נשלחה שום הודעה.', 'ok');
    await loadDraftPreview(result.from, true);
  } catch (error) { message('runMessage', errorText(error), 'err'); }
  finally { state.busy = false; $('runPlanner').disabled = false; updatePublishAvailability(); }
}

async function publishDraft() {
  if (state.busy || !state.draft || !state.draftPreview || !$('reviewDraft').checked) return;
  const gaps = Number((state.draft.summary || {}).blocking_gaps || 0);
  if (gaps > 0) { message('publishMessage', 'אי אפשר לפרסם: בטיוטה יש חוסרים חוסמים.', 'err'); return; }
  if (!confirm('לפרסם את הטיוטה? הסידור יהפוך לפעיל והמשתמשים הרלוונטיים יקבלו עדכון.')) return;
  state.busy = true; $('publish').disabled = true;
  message('publishMessage', 'מפרסם את הסידור בפעולה אחת…', 'info');
  try {
    const result = (await call.publish({
      draft_id: state.draft.draft_id,
      expected_content_digest: state.draftPreview.expected_content_digest,
      request_id: requestId('publish')
    })).data;
    message('publishMessage', 'הסידור פורסם בהצלחה. נוצרו ' + result.notified_people + ' עדכונים לשליחה.', 'ok');
    state.draft = null;
    state.draftPreview = null;
    $('reviewDraft').checked = false;
    $('reviewDraft').disabled = true;
    $('draftPreviewCard').classList.add('hide');
    state.status = (await call.status({})).data;
    setMode(state.status); setRollbackAvailability();
    await Promise.all([loadMine(), loadStation()]);
  } catch (error) { message('publishMessage', errorText(error), 'err'); }
  finally { state.busy = false; setRollbackAvailability(); updatePublishAvailability(); }
}

function setRollbackAvailability() {
  const active = state.status && state.status.active;
  $('rollback').disabled = state.busy || !state.status || state.status.mode !== 'new'
    || !state.status.manager || !active || active.can_rollback !== true
    || !active.previous_publication_id;
}

async function rollbackSchedule() {
  if (state.busy || $('rollback').disabled) return;
  const active = state.status.active;
  const text = 'לחזור מגרסה ' + active.revision + ' לגרסה הקודמת? '
    + 'המערכת תשמור את ההיסטוריה ותשלח עדכון רק למי שהסידור שלו משתנה.';
  if (!confirm(text)) return;
  state.busy = true; setRollbackAvailability();
  message('rollbackMessage', 'מחזיר לגרסה הקודמת בפעולה בטוחה…', 'info');
  try {
    const result = (await call.rollback({
      request_id: requestId('rollback'),
      expected_active_publication_id: active.publication_id,
      target_publication_id: active.previous_publication_id,
      reason_code: 'operational_safety'
    })).data;
    message('rollbackMessage', 'החזרה הושלמה כגרסה ' + result.revision + '.', 'ok');
    state.status = (await call.status({})).data;
    setMode(state.status); setRollbackAvailability();
    await Promise.all([loadMine(), loadStation()]);
  } catch (error) {
    message('rollbackMessage', errorText(error), 'err');
  } finally {
    state.busy = false; setRollbackAvailability();
  }
}

function answerStatus(item) {
  if (!item.answer) return '';
  return item.answer.status === 'confirmed' ? 'אישרתי' : 'דיווחתי שאיני יכול';
}

function answerButtons(itemId, item) {
  const wrap = node('div', 'answer');
  if (item.answer) { wrap.appendChild(node('div', 'msg ok', answerStatus(item))); return wrap; }
  const yes = node('button', 'confirm', 'מאשר/ת'); yes.type = 'button';
  const no = node('button', 'decline', 'לא יכול/ה'); no.type = 'button';
  yes.addEventListener('click', () => respond(itemId, 'confirm', null));
  no.addEventListener('click', () => {
    const choice = prompt('בחר סיבה: 1 לא זמין, 2 התנגשות, 3 שיבוץ שגוי, 4 אחר', '1');
    const reasons = { '1': 'unavailable', '2': 'conflict', '3': 'incorrect_assignment', '4': 'other' };
    if (choice !== null && reasons[choice]) respond(itemId, 'decline', reasons[choice]);
  });
  wrap.append(yes, no); return wrap;
}

function assignmentCard(item) {
  const card = node('article', 'assignment');
  card.appendChild(node('div', 'place', item.sub_station_label || item.sub_station));
  const inner = node('div', 'inner');
  const person = node('div', 'person');
  person.append(node('div', 'avatar', (state.user.displayName || state.user.email || '?').slice(0, 1)));
  const who = node('div'); who.append(node('b', '', state.user.displayName || state.user.email || 'הסידור שלי'),
    node('div', 'role', (item.role_label || item.role || '') + (item.hours ? ' · ' + item.hours : '')));
  person.appendChild(who); inner.appendChild(person);
  const chips = node('div', 'chips');
  (item.qualifications || []).forEach((value) => chips.appendChild(node('span', 'chip', value)));
  if (item.shift) chips.appendChild(node('span', 'chip', item.shift));
  inner.appendChild(chips);
  const names = (item.crew || []).map((value) => value.person + (value.role_label ? ' · ' + value.role_label : ''));
  inner.appendChild(node('div', 'crew', names.length ? 'צוות: ' + names.join(' · ') : 'לא שובצו אנשי צוות נוספים.'));
  if (item.change) inner.appendChild(node('div', 'msg info', 'השיבוץ הזה השתנה בפרסום האחרון.'));
  if (item.requires_answer || item.answer) inner.appendChild(answerButtons(item.date, item));
  card.appendChild(inner); return card;
}

function eventCard(item) {
  const card = node('article', 'assignment');
  card.appendChild(node('div', 'place', 'אירוע')); const inner = node('div', 'inner');
  inner.append(node('b', '', item.title), node('div', 'role', item.hours || item.date));
  if (item.change) inner.appendChild(node('div', 'msg info', 'האירוע הזה השתנה בפרסום האחרון.'));
  if (item.requires_answer || item.answer) inner.appendChild(answerButtons(item.id, item));
  card.appendChild(inner); return card;
}

function renderMine() {
  const box = $('mineContent'); clear(box);
  if (!state.mine || !state.mine.active) {
    box.appendChild(node('div', 'empty', state.status && state.status.mode === 'off'
      ? 'המנוע החדש עדיין כבוי. הסידור הקיים ממשיך להיות זמין במסך הישן.'
      : 'עדיין לא פורסם סידור חדש.'));
    return;
  }
  const date = state.mineDate || localDate(); state.mineDate = date;
  $('mineDateTitle').textContent = dateLabel(date); $('mineDate').textContent = date;
  const days = (state.mine.days || []).filter((item) => item.date === date);
  const events = (state.mine.events || []).filter((item) => item.date === date);
  days.forEach((item) => box.appendChild(assignmentCard(item)));
  events.forEach((item) => box.appendChild(eventCard(item)));
  if (!days.length && !events.length) box.appendChild(node('div', 'empty', 'אין לך שיבוץ או אירוע ביום הזה.'));
}

async function respond(itemId, answer, reasonCode) {
  if (state.busy || !state.mine || !state.mine.publication_id) return;
  state.busy = true;
  try {
    await call.respond({
      request_id: requestId('answer'), publication_id: state.mine.publication_id,
      item_id: itemId, answer, reason_code: reasonCode
    });
    await loadMine();
  } catch (error) { alert(errorText(error)); }
  finally { state.busy = false; }
}

async function loadMine() {
  try {
    state.mine = (await call.mine({ date: state.mineDate || localDate() })).data;
  } catch (error) { state.mine = { active: false, error: errorText(error) }; }
  renderMine();
}

function stationBlock(block, title) {
  const column = node('article', 'day');
  const heading = node('h3', '', title); heading.appendChild(node('small', '', block.date)); column.appendChild(heading);
  (block.sub_stations || []).forEach((sub) => {
    const section = node('section', 'station'); section.appendChild(node('strong', '', sub.label || sub.sub_station));
    (sub.people || []).forEach((person) => {
      const row = node('div', 'member' + (person.is_me ? ' me' : ''));
      row.append(document.createTextNode(person.person || person.uid));
      if (person.role_label || person.hours) row.appendChild(node('small', '', ' · ' + [person.role_label, person.hours].filter(Boolean).join(' · ')));
      section.appendChild(row);
    });
    if (sub.below_minimum) section.appendChild(node('div', 'msg err', 'מתחת לקו המינימום'));
    column.appendChild(section);
  });
  (block.events || []).forEach((event) => {
    const item = node('div', 'event' + (event.includes_me ? ' me' : ''));
    item.append(node('b', '', event.title), document.createTextNode(event.hours ? ' · ' + event.hours : ''));
    const names = (event.people || []).map((person) => typeof person === 'string' ? person : person.person);
    if (names.length) item.appendChild(node('div', '', names.join(' · ')));
    column.appendChild(item);
  });
  if (!(block.sub_stations || []).length && !(block.events || []).length) column.appendChild(node('div', 'empty', 'אין סידור ליום הזה.'));
  return column;
}

async function loadStation() {
  if (!state.status) return;
  $('stationDateTitle').textContent = dateLabel(state.stationDate); $('stationDate').textContent = state.stationDate;
  const box = $('stationContent'); clear(box); box.appendChild(node('div', 'loader'));
  try {
    const view = (await call.station({ date: state.stationDate })).data; clear(box);
    if (!view.active) { box.appendChild(node('div', 'empty', 'עדיין לא פורסם סידור חדש.')); return; }
    box.append(stationBlock(view.previous_day, 'היום שלפני'), stationBlock(view.day, 'היום'), stationBlock(view.next_day, 'היום שאחרי'));
  } catch (error) { clear(box); box.appendChild(node('div', 'msg err', errorText(error))); }
}

async function loadSetup() {
  if (!state.status.manager) return;
  try { state.setup = (await call.setup({})).data; renderPolicy(); }
  catch (error) { message('runMessage', errorText(error), 'err'); }
}

async function boot(user) {
  state.user = user;
  try { state.claims = (await user.getIdTokenResult()).claims || {}; } catch (_) { state.claims = {}; }
  renderNav(state.claims, 'schedule-management.html', user.displayName || user.email || '');
  $('who').textContent = user.displayName || user.email || '';
  $('appMain').classList.remove('hide');
  try {
    state.status = (await call.status({})).data;
    // פריסה של הקוד לבדה אינה מחליפה את הסידור החי. כל עוד מנהל
    // המערכת לא הפעיל במפורש shadow/new, מחזירים את המשתמש למסך
    // הוותיק. כך אפשר לפרוס בחשיכה בלי ליצור מסך ריק לכבאים.
    if (state.status.mode === 'off' || (state.status.mode === 'shadow' && !state.status.manager)) {
      location.replace('./schedule.html');
      return;
    }
    setMode(state.status);
    setRollbackAvailability();
    $('manageTab').hidden = !state.status.manager;
    $('startMonth').value = monthStart();
    await Promise.all([loadSetup(), loadMine()]);
    chooseTab(new URLSearchParams(location.search).get('tab') || (state.status.manager ? 'manage' : 'mine'));
  } catch (error) {
    location.replace('./schedule.html');
  }
}

document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => chooseTab(button.dataset.tab)));
document.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => {
  const delta = Number(button.dataset.move);
  if (button.closest('#mineView')) { state.mineDate = shiftDate(state.mineDate || localDate(), delta); loadMine(); }
  else { state.stationDate = shiftDate(state.stationDate, delta); loadStation(); }
}));
$('previewPrev').addEventListener('click', () => {
  if (!state.draftPreview || $('previewPrev').disabled) return;
  loadDraftPreview(shiftDate(state.previewStart, -7), false);
});
$('previewNext').addEventListener('click', () => {
  if (!state.draftPreview || $('previewNext').disabled) return;
  loadDraftPreview(shiftDate(state.previewStart, 7), false);
});
$('reviewDraft').addEventListener('change', updatePublishAvailability);
$('addOverride').addEventListener('click', () => addOverride());
$('runPlanner').addEventListener('click', runPlanner);
$('publish').addEventListener('click', publishDraft);
$('rollback').addEventListener('click', rollbackSchedule);

onAuthStateChanged(auth, (user) => {
  if (!user) { location.replace('./login.html?next=schedule-management.html'); return; }
  boot(user);
});
