'use strict';

// פקודות האבטחה של אחראי/ת הסידור. זהו מודול טהור: אין Firebase,
// אין שעון ואין כתיבה. השרת מזריק את המסמך הקיים ואת רשימת הסגל
// הפעיל, והמודול מחזיר שינוי מפורש והודעות ניטרליות בלבד.

const ID_RE = /^[A-Za-z0-9_-]{2,120}$/;
// Auth UIDs are not request/document ids.  Firebase permits a dot in a UID,
// and signup keys are written with Firestore FieldPath by the runtime.  A
// slash or control character cannot safely address the station user document.
const AUTH_UID_RE = /^[^\u0000-\u001F\u007F/]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const STATUSES = Object.freeze(['open', 'staffed', 'done', 'cancelled']);
const TERMINAL = Object.freeze(['done', 'cancelled']);
const ACTIONS = Object.freeze(['create', 'edit', 'reschedule', 'set_assignees', 'cancel', 'complete']);
const KINDS = Object.freeze(['sport', 'show', 'hotwork', 'crowd', 'school', 'other']);

class GuardManagementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuardManagementError';
    this.code = code;
  }
}

function isPlain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function sortIds(values) { return Array.from(new Set(values)).sort((a, b) => a < b ? -1 : (a > b ? 1 : 0)); }

function fail(code, message) { throw new GuardManagementError(code, message); }

function exactKeys(value, allowed, code) {
  if (!isPlain(value)) fail(code, 'מבנה הבקשה אינו תקין.');
  Object.keys(value).forEach((key) => {
    if (allowed.indexOf(key) === -1) fail(code, 'שדה שאינו מורשה בבקשה.');
  });
}

function cleanId(value, code, label) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!ID_RE.test(out)) fail(code, label + ' אינו תקין.');
  return out;
}

function cleanAuthUid(value, code, label) {
  // UIDs are identity values, not request/document ids: never normalize
  // (trim) them, because that could turn one account into another.
  const out = typeof value === 'string' ? value : '';
  if (!AUTH_UID_RE.test(out)) fail(code, label + ' אינו תקין.');
  return out;
}

function cleanDate(value, code) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!DATE_RE.test(out)) fail(code, 'התאריך אינו תקין.');
  const parsed = new Date(out + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== out) {
    fail(code, 'התאריך אינו אפשרי.');
  }
  return out;
}

function cleanTime(value, code) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!TIME_RE.test(out)) fail(code, 'השעה אינה תקינה.');
  return out;
}

function cleanText(value, code, label, min, max, blankAllowed) {
  if (typeof value !== 'string') fail(code, label + ' אינו תקין.');
  const out = value.trim();
  if (CONTROL_RE.test(out) || out.length > max || (!blankAllowed && out.length < min)) {
    fail(code, label + ' אינו תקין.');
  }
  return out;
}

function cleanSlots(value, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    fail(code, 'מספר המקומות חייב להיות בין 1 ל-20.');
  }
  return value;
}

function cleanRevision(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, 'גרסת האבטחה אינה תקינה.');
  return value;
}

function cleanKinds(value, code) {
  const out = cleanText(value, code, 'סוג האבטחה', 1, 32, false);
  if (KINDS.indexOf(out) === -1) fail(code, 'סוג האבטחה אינו נתמך.');
  return out;
}

function cleanQuals(value, code) {
  if (!Array.isArray(value) || value.length > 12) fail(code, 'דרישות הכשירות אינן תקינות.');
  const values = value.map((item) => cleanId(item, code, 'מזהה כשירות'));
  if (new Set(values).size !== values.length) fail(code, 'דרישות הכשירות כפולות.');
  return values.sort((a, b) => a < b ? -1 : (a > b ? 1 : 0));
}

function cleanUids(value, code) {
  if (!Array.isArray(value) || value.length > 20) fail(code, 'רשימת המשובצים אינה תקינה.');
  const values = value.map((item) => cleanAuthUid(item, code, 'מזהה משובץ'));
  if (new Set(values).size !== values.length) fail(code, 'רשימת המשובצים כוללת כפילות.');
  return values.sort((a, b) => a < b ? -1 : (a > b ? 1 : 0));
}

function createDetails(value) {
  const code = 'guard-details-invalid';
  exactKeys(value, ['title', 'kind', 'place', 'date', 'start', 'end', 'slots', 'need_quals', 'notes'], code);
  ['title', 'date', 'start', 'end', 'slots'].forEach((key) => {
    if (!own(value, key)) fail(code, 'חסר פרט חובה באבטחה.');
  });
  return {
    title: cleanText(value.title, code, 'כותרת האבטחה', 1, 80, false),
    kind: own(value, 'kind') ? cleanKinds(value.kind, code) : 'other',
    place: own(value, 'place') ? cleanText(value.place, code, 'מקום האבטחה', 0, 120, true) : '',
    date: cleanDate(value.date, code),
    start: cleanTime(value.start, code),
    end: cleanTime(value.end, code),
    slots: cleanSlots(value.slots, code),
    need_quals: own(value, 'need_quals') ? cleanQuals(value.need_quals, code) : [],
    notes: own(value, 'notes') ? cleanText(value.notes, code, 'הערת האבטחה', 0, 1000, true) : ''
  };
}

function editDetails(value) {
  const code = 'guard-details-invalid';
  exactKeys(value, ['title', 'kind', 'place', 'start', 'end', 'slots', 'need_quals', 'notes'], code);
  if (!Object.keys(value).length) fail(code, 'לא נבחר שינוי לאבטחה.');
  const out = {};
  if (own(value, 'title')) out.title = cleanText(value.title, code, 'כותרת האבטחה', 1, 80, false);
  if (own(value, 'kind')) out.kind = cleanKinds(value.kind, code);
  if (own(value, 'place')) out.place = cleanText(value.place, code, 'מקום האבטחה', 0, 120, true);
  if (own(value, 'start')) out.start = cleanTime(value.start, code);
  if (own(value, 'end')) out.end = cleanTime(value.end, code);
  if (own(value, 'slots')) out.slots = cleanSlots(value.slots, code);
  if (own(value, 'need_quals')) out.need_quals = cleanQuals(value.need_quals, code);
  if (own(value, 'notes')) out.notes = cleanText(value.notes, code, 'הערת האבטחה', 0, 1000, true);
  return out;
}

function parseCommand(raw) {
  const code = 'guard-command-invalid';
  exactKeys(raw, ['action', 'request_id', 'guard_id', 'expected_revision', 'details', 'uids'], code);
  const action = typeof raw.action === 'string' ? raw.action : '';
  if (ACTIONS.indexOf(action) === -1) fail(code, 'פעולת האבטחה אינה נתמכת.');
  const request_id = cleanId(raw.request_id, code, 'מזהה הבקשה');
  if (action === 'create') {
    if (own(raw, 'guard_id') || own(raw, 'expected_revision') || own(raw, 'uids')) {
      fail(code, 'פעולת פתיחה אינה מקבלת מזהה או שיבוץ.');
    }
    return Object.freeze({ action, request_id, details: createDetails(raw.details) });
  }
  const guard_id = cleanId(raw.guard_id, code, 'מזהה האבטחה');
  const expected_revision = cleanRevision(raw.expected_revision, code);
  if (action === 'edit') {
    if (own(raw, 'uids')) fail(code, 'עריכת אבטחה אינה מקבלת רשימת משובצים.');
    return Object.freeze({ action, request_id, guard_id, expected_revision, details: editDetails(raw.details) });
  }
  if (action === 'reschedule') {
    exactKeys(raw.details, ['date'], 'guard-details-invalid');
    return Object.freeze({ action, request_id, guard_id, expected_revision,
      details: Object.freeze({ date: cleanDate(raw.details.date, 'guard-details-invalid') }) });
  }
  if (action === 'set_assignees') {
    if (own(raw, 'details')) fail(code, 'שיבוץ אינו מקבל פרטי אבטחה.');
    return Object.freeze({ action, request_id, guard_id, expected_revision, uids: cleanUids(raw.uids, code) });
  }
  if (own(raw, 'details') || own(raw, 'uids')) fail(code, 'פעולת מצב אינה מקבלת פרטים נוספים.');
  return Object.freeze({ action, request_id, guard_id, expected_revision });
}

function existingGuard(raw) {
  const code = 'guard-existing-invalid';
  if (!isPlain(raw)) fail(code, 'מסמך האבטחה אינו תקין.');
  const status = raw.status === undefined ? 'open' : raw.status;
  if (STATUSES.indexOf(status) === -1) fail(code, 'מצב האבטחה אינו תקין.');
  const revision = raw.revision === undefined ? 0 : cleanRevision(raw.revision, code);
  const assigned = raw.assigned === undefined ? [] : cleanUids(raw.assigned, code);
  const signups = isPlain(raw.signups) ? Object.keys(raw.signups)
    .filter((uid) => AUTH_UID_RE.test(uid)).sort((a, b) => a < b ? -1 : (a > b ? 1 : 0)) : [];
  return {
    title: cleanText(raw.title, code, 'כותרת האבטחה', 1, 80, false),
    kind: raw.kind === undefined ? 'other' : cleanKinds(raw.kind, code),
    place: raw.place === undefined ? '' : cleanText(raw.place, code, 'מקום האבטחה', 0, 120, true),
    date: cleanDate(raw.date, code),
    start: cleanTime(raw.start, code),
    end: cleanTime(raw.end, code),
    slots: cleanSlots(raw.slots, code),
    need_quals: raw.need_quals === undefined ? [] : cleanQuals(raw.need_quals, code),
    notes: raw.notes === undefined ? '' : cleanText(raw.notes, code, 'הערת האבטחה', 0, 1000, true),
    status, revision, assigned, signups
  };
}

function recipients(values) {
  return sortIds(values.filter((uid) => AUTH_UID_RE.test(uid)));
}

function makeNotifications(action, before, after, added, removed) {
  if (action === 'create') return [];
  if (action === 'set_assignees') {
    const retained = after.assigned.filter((uid) => before.assigned.indexOf(uid) !== -1);
    // A replacement assignment can supersede the original "assigned" push
    // before it is delivered.  Retained people therefore receive an
    // explicit neutral update on every real team-composition change; nobody
    // is silently skipped just because another person was added or removed.
    return recipients(added).map((uid) => ({ uid, kind: 'assigned' }))
      .concat(recipients(removed).map((uid) => ({ uid, kind: 'removed' })))
      .concat(recipients(retained).map((uid) => ({ uid, kind: 'updated' })));
  }
  const kind = action === 'reschedule' ? 'rescheduled'
    : (action === 'cancel' ? 'cancelled' : (action === 'complete' ? 'completed' : 'updated'));
  return recipients(before.assigned.concat(before.signups)).map((uid) => ({ uid, kind }));
}

function operation(currentRaw, command, activeUids, createId) {
  const active = new Set(Array.isArray(activeUids) ? activeUids : []);
  if (command.action === 'create') {
    if (currentRaw) fail('guard-already-exists', 'האבטחה כבר קיימת.');
    const guard_id = cleanId(createId, 'guard-id-invalid', 'מזהה האבטחה');
    const after = Object.assign({}, command.details, {
      assigned: [], signups: {}, status: 'open', revision: 1
    });
    return Object.freeze({ guard_id, before: null, after, changed: true, notifications: [] });
  }

  if (!currentRaw) fail('guard-not-found', 'האבטחה לא נמצאה.');
  const before = existingGuard(currentRaw);
  if (before.revision !== command.expected_revision) {
    fail('guard-revision-conflict', 'האבטחה השתנתה. יש לרענן ולנסות שוב.');
  }
  if (TERMINAL.indexOf(before.status) !== -1) {
    fail('guard-terminal', 'אבטחה שבוטלה או הסתיימה אינה ניתנת לשינוי.');
  }

  const after = Object.assign({}, before);
  let added = [], removed = [];
  if (command.action === 'edit') {
    Object.assign(after, command.details);
    if (after.slots < after.assigned.length) {
      fail('guard-slots-below-assigned', 'אין לצמצם מקומות מתחת למספר המשובצים.');
    }
    after.status = after.assigned.length >= after.slots ? 'staffed' : 'open';
  } else if (command.action === 'reschedule') {
    after.date = command.details.date;
  } else if (command.action === 'set_assignees') {
    command.uids.forEach((uid) => {
      if (!active.has(uid)) fail('guard-assignee-inactive', 'אפשר לשבץ רק סגל פעיל בתחנה.');
    });
    if (command.uids.length > after.slots) fail('guard-capacity', 'נבחרו יותר משובצים ממספר המקומות.');
    added = command.uids.filter((uid) => before.assigned.indexOf(uid) === -1);
    removed = before.assigned.filter((uid) => command.uids.indexOf(uid) === -1);
    after.assigned = command.uids.slice();
    after.status = after.assigned.length >= after.slots ? 'staffed' : 'open';
  } else if (command.action === 'cancel') {
    after.status = 'cancelled';
  } else if (command.action === 'complete') {
    after.status = 'done';
  }

  const changed = !same({
    title: before.title, kind: before.kind, place: before.place, date: before.date,
    start: before.start, end: before.end, slots: before.slots, need_quals: before.need_quals,
    notes: before.notes, assigned: before.assigned, status: before.status
  }, {
    title: after.title, kind: after.kind, place: after.place, date: after.date,
    start: after.start, end: after.end, slots: after.slots, need_quals: after.need_quals,
    notes: after.notes, assigned: after.assigned, status: after.status
  });
  if (changed) after.revision = before.revision + 1;
  const notifications = changed ? makeNotifications(command.action, before, after, added, removed) : [];
  return Object.freeze({ guard_id: command.guard_id, before, after, changed,
    added: sortIds(added), removed: sortIds(removed), notifications });
}

module.exports = Object.freeze({
  GuardManagementError,
  parseCommand,
  operation,
  ACTIONS,
  STATUSES,
  AUTH_UID_RE
});
