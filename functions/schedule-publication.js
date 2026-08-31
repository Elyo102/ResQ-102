'use strict';

/**
 * schedule-publication — טיוטה, פרסום, איתור שינוי והתראה אישית.
 *
 * מודול טהור. אינו קורא, אינו כותב ואינו שולח. מחזיר **תוכניות בלבד**.
 *
 * חמישה כללים שאין לשבור, ולכל אחד בדיקה ומוטציה:
 *   1. עריכה בטיוטה אינה שולחת דבר. רק פרסום מייצר התראות.
 *   2. כמה שינויים באותו פרסום = פוש אחד מרוכז לאדם. לא הודעה לכל שינוי.
 *   3. מטען הפוש עובר רשימת-היתר ממצה. מה שאינו ברשימה אינו יוצא.
 *      אין סיבות היעדרות, אין מידע רפואי, ואין שמות של אנשים אחרים.
 *   4. לחיצה כפולה אינה מייצרת שני פרסומים ולא שתי התראות.
 *   5. כשל בשליחת פוש אינו מבטל פרסום תקין. הוא נכנס לתור ניסיון חוזר.
 */

class PublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PublicationError';
    this.code = code;
  }
}

const CHANGE = Object.freeze({
  ASSIGNMENT_ADDED: 'assignment_added',
  ASSIGNMENT_REMOVED: 'assignment_removed',
  ASSIGNMENT_CANCELLED: 'assignment_cancelled',
  ASSIGNMENT_RESTORED: 'assignment_restored',
  SUB_STATION_CHANGED: 'sub_station_changed',
  STATION_CHANGED: 'station_changed',
  ROLE_CHANGED: 'role_changed',
  HOURS_CHANGED: 'hours_changed',
  SHIFT_CHANGED: 'shift_changed',
  ROTATION_CHANGED: 'rotation_changed',
  CREW_CHANGED: 'crew_changed',
  EVENT_ASSIGNED: 'event_assigned',
  EVENT_CHANGED: 'event_changed',
  EVENT_CANCELLED: 'event_cancelled'
});

const ALL_CHANGES = Object.freeze(Object.keys(CHANGE).map((k) => CHANGE[k]));

/**
 * רשימת-היתר ממצה למטען הפוש. **בדיקת מקור אוכפת שזו רשימה סגורה.**
 * כל שדה שאינו כאן אינו יוצא למסך הנעילה, גם אם הוא קיים בשינוי.
 */
// מסך הנעילה מקבל רק סוג שינוי ותאריך. שמות, תפקידים, תחנות וכותרות
// אירוע נטענים בתוך האפליקציה לאחר אימות המשתמש.
const PUSH_FIELDS = Object.freeze(['kind', 'date']);

/** מפתחות שאסור שיופיעו בפלט בשום צורה. */
const FORBIDDEN_KEYS = Object.freeze([
  'reason', 'reasons', 'note', 'notes', 'medical', 'diagnosis',
  'absence', 'absence_kind', 'sick', 'vacation', 'reserve', 'private'
]);

const LIMITS = Object.freeze({
  MAX_PEOPLE: 20000,
  MAX_CHANGES_PER_PERSON: 500,
  MAX_ATTEMPTS: 5,
  MAX_PUSH_ITEMS: 20,
  MAX_PUSH_BYTES: 3500
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** סידור דטרמיניסטי של מפתחות, כדי שגיבוב יהיה יציב. */
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/* ------------------------------------------------------------------ */

function createPublication(deps) {
  const d = isPlainObject(deps) ? deps : {};

  const clock = d.clock;
  if (typeof clock !== 'function') {
    throw new PublicationError('clock-required', 'חובה להזריק clock');
  }
  const hash = d.hash;
  if (typeof hash !== 'function') {
    throw new PublicationError('hash-required', 'חובה להזריק פונקציית גיבוב. המודול אינו מייבא crypto.');
  }
  const rules = isPlainObject(d.rules) ? d.rules : null;
  if (!rules) throw new PublicationError('rules-required', 'חובה להזריק rules');
  if (!isInt(rules.max_attempts) || rules.max_attempts <= 0 || rules.max_attempts > LIMITS.MAX_ATTEMPTS) {
    throw new PublicationError('rules-attempts', 'חובה להגדיר max_attempts בין 1 ל-' + LIMITS.MAX_ATTEMPTS);
  }
  if (!Array.isArray(rules.retry_backoff_ms) || rules.retry_backoff_ms.length < rules.max_attempts - 1
      || rules.retry_backoff_ms.some((x) => !isInt(x) || x < 0)) {
    throw new PublicationError('rules-backoff', 'חובה להגדיר retry_backoff_ms לכל ניסיון חוזר');
  }

  /* ---------------- המרת תוכנית לתמונת-אדם ---------------- */

  function assertPlan(plan, what) {
    if (!isPlainObject(plan)) throw new PublicationError('plan-required', what + ' חסר');
    if (!Array.isArray(plan.rows)) throw new PublicationError('plan-rows', what + ' בלי rows');
    if (!isNonEmptyString(plan.station_id)) throw new PublicationError('plan-station', what + ' בלי station_id');
    if (!isNonEmptyString(plan.source_snapshot)) throw new PublicationError('plan-source', what + ' בלי תמונת מקור');
    if (!isNonEmptyString(plan.source_version)) throw new PublicationError('plan-version', what + ' בלי גרסת מקור');
    return plan;
  }

  function assertPublishable(plan) {
    const summary = plan.summary;
    if (!isPlainObject(summary)) {
      throw new PublicationError('plan-summary', 'לתוכנית החדשה חסר סיכום כשירות לפרסום');
    }
    const blocking = ['blocking_gaps', 'days_below_minimum', 'rejected_manual'];
    for (const key of blocking) {
      if (!isInt(summary[key]) || summary[key] < 0) {
        throw new PublicationError('plan-summary', 'סיכום התוכנית אינו תקין: ' + key);
      }
      if (summary[key] > 0) {
        throw new PublicationError('plan-not-publishable', 'התוכנית כוללת חוסרים או שיבוצים שנדחו');
      }
    }
    if (plan.rows.some((row) => row.complete !== true)) {
      throw new PublicationError('plan-not-publishable', 'יש שורות שלא הושלמו ולכן אי אפשר לפרסם');
    }
  }

  /**
   * לכל אדם, לכל תאריך — רשומה אחת.
   * ה-crew הוא הצוות באותה תחנת קצה באותו יום, בלי האדם עצמו.
   */
  function personView(plan) {
    const view = new Map();
    for (const row of plan.rows) {
      const crew = row.slots.map((s) => s.person).sort();
      for (const slot of row.slots) {
        if (!view.has(slot.person)) view.set(slot.person, new Map());
        const byDate = view.get(slot.person);
        if (byDate.has(row.date)) {
          throw new PublicationError('duplicate-assignment',
            'האדם ' + slot.person + ' מופיע פעמיים בתאריך ' + row.date);
        }
        byDate.set(row.date, {
          date: row.date,
          station_id: row.station_id,
          sub_station: row.sub_station,
          sub_station_label: row.label,
          role: slot.role,
          role_label: slot.label,
          hours: isNonEmptyString(slot.hours) ? slot.hours : null,
          shift: isNonEmptyString(slot.shift) ? slot.shift : null,
          rotation_group: row.rotation_group === undefined ? null : row.rotation_group,
          cancelled: slot.cancelled === true,
          crew: crew.filter((x) => x !== slot.person)
        });
      }
    }
    return view;
  }

  function eventView(events, what, plan) {
    const view = new Map();
    if (events === undefined || events === null) return view;
    if (!Array.isArray(events)) throw new PublicationError('events-shape', what + ' אינם מערך');
    for (const e of events) {
      if (!isPlainObject(e)) throw new PublicationError('event-shape', 'אירוע לא תקין');
      if (!isNonEmptyString(e.id)) throw new PublicationError('event-id', 'לאירוע חסר מזהה');
      if (!isNonEmptyString(e.title)) throw new PublicationError('event-title', 'לאירוע חסרה כותרת');
      if (!isNonEmptyString(e.date)) throw new PublicationError('event-date', 'לאירוע חסר תאריך');
      if (!Array.isArray(e.people)) throw new PublicationError('event-people', 'לאירוע חסרה רשימת אנשים');
      if (e.station_id !== plan.station_id) {
        throw new PublicationError('event-station-mismatch', what + ' כוללים אירוע מתחנה אחרת');
      }
      if (e.source_snapshot !== plan.source_snapshot || e.source_version !== plan.source_version) {
        throw new PublicationError('event-source-mismatch', what + ' אינם מאותו מקור של התוכנית');
      }
      for (const p of e.people) {
        if (!isNonEmptyString(p)) throw new PublicationError('event-people', 'מזהה אדם לא תקין באירוע');
        if (!view.has(p)) view.set(p, new Map());
        view.get(p).set(e.id, {
          id: e.id,
          title: e.title,
          date: e.date,
          hours: isNonEmptyString(e.hours) ? e.hours : null,
          cancelled: e.cancelled === true
        });
      }
    }
    return view;
  }

  function sameCrew(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  function diffOnePerson(prev, next) {
    const out = [];
    const dates = new Set();
    if (prev) for (const k of prev.keys()) dates.add(k);
    if (next) for (const k of next.keys()) dates.add(k);

    for (const date of Array.from(dates).sort()) {
      const a = prev ? prev.get(date) : undefined;
      const b = next ? next.get(date) : undefined;

      if (!a && b) {
        out.push({ kind: CHANGE.ASSIGNMENT_ADDED, date, to: b });
        continue;
      }
      if (a && !b) {
        out.push({ kind: CHANGE.ASSIGNMENT_REMOVED, date, from: a });
        continue;
      }
      if (a.cancelled !== b.cancelled) {
        out.push({ kind: b.cancelled ? CHANGE.ASSIGNMENT_CANCELLED : CHANGE.ASSIGNMENT_RESTORED, date, from: a, to: b });
      }
      if (a.station_id !== b.station_id) out.push({ kind: CHANGE.STATION_CHANGED, date, from: a, to: b });
      if (a.sub_station !== b.sub_station) out.push({ kind: CHANGE.SUB_STATION_CHANGED, date, from: a, to: b });
      if (a.role !== b.role) out.push({ kind: CHANGE.ROLE_CHANGED, date, from: a, to: b });
      if (a.hours !== b.hours) out.push({ kind: CHANGE.HOURS_CHANGED, date, from: a, to: b });
      if (a.shift !== b.shift) out.push({ kind: CHANGE.SHIFT_CHANGED, date, from: a, to: b });
      if (a.rotation_group !== b.rotation_group) out.push({ kind: CHANGE.ROTATION_CHANGED, date, from: a, to: b });
      if (!sameCrew(a.crew, b.crew)) out.push({ kind: CHANGE.CREW_CHANGED, date, from: a, to: b });
    }
    return out;
  }

  function diffOnePersonEvents(prev, next) {
    const out = [];
    const ids = new Set();
    if (prev) for (const k of prev.keys()) ids.add(k);
    if (next) for (const k of next.keys()) ids.add(k);

    for (const id of Array.from(ids).sort()) {
      const a = prev ? prev.get(id) : undefined;
      const b = next ? next.get(id) : undefined;
      if (!a && b) {
        out.push({ kind: b.cancelled ? CHANGE.EVENT_CANCELLED : CHANGE.EVENT_ASSIGNED, date: b.date, to: b });
        continue;
      }
      if (a && !b) { out.push({ kind: CHANGE.EVENT_CANCELLED, date: a.date, from: a }); continue; }
      if (!a.cancelled && b.cancelled) { out.push({ kind: CHANGE.EVENT_CANCELLED, date: b.date, from: a, to: b }); continue; }
      if (a.cancelled && !b.cancelled) { out.push({ kind: CHANGE.EVENT_ASSIGNED, date: b.date, from: a, to: b }); continue; }
      if (a.date !== b.date || a.hours !== b.hours || a.title !== b.title) {
        out.push({ kind: CHANGE.EVENT_CHANGED, date: b.date, from: a, to: b });
      }
    }
    return out;
  }

  /** השוואה מלאה. מחזירה מפה: אדם → רשימת שינויים ממוינת ויציבה. */
  function diff(input) {
    const inp = isPlainObject(input) ? input : {};
    const next = assertPlan(inp.next, 'התוכנית החדשה');
    const prev = inp.previous === null || inp.previous === undefined
      ? null
      : assertPlan(inp.previous, 'התוכנית הקודמת');

    if (prev && prev.station_id !== next.station_id) {
      throw new PublicationError('station-mismatch', 'השוואה בין שתי תחנות שונות');
    }

    const nextView = personView(next);
    const prevView = prev ? personView(prev) : new Map();
    const nextEvents = eventView(inp.next_events, 'אירועי התוכנית החדשה', next);
    if (!prev && inp.previous_events !== undefined && inp.previous_events !== null
        && (!Array.isArray(inp.previous_events) || inp.previous_events.length > 0)) {
      throw new PublicationError('previous-events-without-plan', 'אי אפשר למסור אירועים קודמים בלי תוכנית קודמת');
    }
    const prevEvents = prev ? eventView(inp.previous_events, 'אירועי התוכנית הקודמת', prev) : new Map();

    const people = new Set();
    for (const k of nextView.keys()) people.add(k);
    for (const k of prevView.keys()) people.add(k);
    for (const k of nextEvents.keys()) people.add(k);
    for (const k of prevEvents.keys()) people.add(k);

    if (people.size > LIMITS.MAX_PEOPLE) {
      throw new PublicationError('too-many-people', 'יותר מדי אנשים בפרסום אחד');
    }

    const out = new Map();
    for (const person of Array.from(people).sort()) {
      // בפרסום ראשון כל השיבוצים והאירועים האישיים הם מידע חדש.
      // פונקציות ההשוואה כבר מייצגות אותם כתוספות כאשר הצד הקודם חסר.
      const changes = diffOnePerson(prevView.get(person), nextView.get(person))
        .concat(diffOnePersonEvents(prevEvents.get(person), nextEvents.get(person)));
      if (!changes.length) continue;
      if (changes.length > LIMITS.MAX_CHANGES_PER_PERSON) {
        throw new PublicationError('too-many-changes', 'יותר מדי שינויים לאדם אחד');
      }
      out.set(person, changes);
    }
    return out;
  }

  /* ---------------- מטען פוש · רשימת היתר ---------------- */

  function pickPushFields(change) {
    const flat = {
      kind: change.kind,
      date: change.date
    };
    const out = {};
    // רשימת היתר ממצה: רק מה שברשימה יוצא, ובאותו סדר.
    for (const key of PUSH_FIELDS) out[key] = flat[key] === undefined ? null : flat[key];
    return out;
  }

  /**
   * מטען הפוש. **אין בו שמות של אנשים אחרים** — גם לא בשינוי הרכב צוות.
   * מי שרוצה לדעת מי איתו פותח את האפליקציה.
   */
  function buildPush(person, changes, publicationId, firstPublication) {
    const items = changes.slice(0, LIMITS.MAX_PUSH_ITEMS).map(pickPushFields);
    const body = firstPublication
      ? (items.length === 1 ? 'שיבוץ אחד פורסם עבורך' : items.length + ' שיבוצים ואירועים פורסמו עבורך')
      : (items.length === 1 ? 'שינוי אחד בסידור שלך' : items.length + ' שינויים בסידור שלך');
    const push = {
      title: firstPublication ? 'ResQ · הסידור פורסם' : 'ResQ · הסידור שלך',
      body,
      items,
      truncated_changes: Math.max(0, changes.length - items.length),
      /** לחיצה פותחת את השינוי במסך „הסידור שלי" ולא במסך כללי. */
      route: 'my-schedule',
      publication_id: publicationId
    };
    if (utf8Bytes(stable(push)) > LIMITS.MAX_PUSH_BYTES) {
      throw new PublicationError('push-too-large', 'מטען ההתראה גדול מהמותר');
    }
    return push;
  }

  function utf8Bytes(value) {
    let bytes = 0;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length
          && value.charCodeAt(i + 1) >= 0xDC00 && value.charCodeAt(i + 1) <= 0xDFFF) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function assertNoLeak(value, path) {
    if (Array.isArray(value)) { value.forEach((v, i) => assertNoLeak(v, path + '[' + i + ']')); return; }
    if (isPlainObject(value)) {
      for (const k of Object.keys(value)) {
        if (FORBIDDEN_KEYS.indexOf(k) > -1) {
          throw new PublicationError('leak', 'שדה אסור במטען: ' + path + '.' + k);
        }
        assertNoLeak(value[k], path + '.' + k);
      }
    }
  }

  /* ---------------- פרסום ---------------- */

  function planPublication(input) {
    const inp = isPlainObject(input) ? input : {};
    const next = assertPlan(inp.next, 'התוכנית החדשה');
    assertPublishable(next);

    if (!isNonEmptyString(inp.publication_id)) {
      throw new PublicationError('publication-id', 'חובה למסור publication_id');
    }
    if (!isNonEmptyString(inp.actor)) {
      throw new PublicationError('actor-required', 'חובה לדעת מי מפרסם — ההודעה נוקבת בשם');
    }

    const contentHash = hash(stable({
      rows: next.rows,
      events: inp.next_events || null,
      station: next.station_id,
      version: next.source_version
    }));

    // לחיצה כפולה: אותו מזהה ואותו תוכן = אין פרסום שני ואין התראה שנייה.
    const existing = inp.existing_publication;
    if (existing !== undefined && existing !== null) {
      if (!isPlainObject(existing)) throw new PublicationError('existing-shape', 'פרסום קיים לא תקין');
      if (existing.id === inp.publication_id) {
        if (existing.content_hash === contentHash) {
          return Object.freeze({
            kind: 'publication-plan',
            duplicate: true,
            publication: Object.freeze(existing),
            notifications: Object.freeze([]),
            audit: Object.freeze({
              action: 'publish_duplicate_ignored',
              publication_id: inp.publication_id,
              actor: inp.actor,
              at: clock()
            })
          });
        }
        throw new PublicationError('publication-conflict',
          'אותו מזהה פרסום עם תוכן אחר. צור מזהה חדש.');
      }
    }

    const at = clock();
    const changesByPerson = diff({
      previous: inp.previous,
      next,
      previous_events: inp.previous_events,
      next_events: inp.next_events
    });

    const notifications = [];
    for (const person of Array.from(changesByPerson.keys()).sort()) {
      const changes = changesByPerson.get(person);
      const push = buildPush(person, changes, inp.publication_id, !inp.previous);
      assertNoLeak(push, 'push');
      notifications.push(Object.freeze({
        kind: 'notification-plan',
        /** מפתח ייחודי לאדם ולפרסום — כתיבה חוזרת אינה מייצרת התראה שנייה. */
        dedupe_key: inp.publication_id + ':' + person + ':' + contentHash,
        person,
        publication_id: inp.publication_id,
        created_at: at,
        changed_by: inp.actor,
        change_count: changes.length,
        push: Object.freeze(push),
        /** מוצג בתוך האפליקציה בלבד, למי שרשאי. */
        detail: Object.freeze(changes.map((c) => Object.freeze({
          kind: c.kind,
          date: c.date,
          sub_station_label: (c.to || c.from || {}).sub_station_label || null,
          role_label: (c.to || c.from || {}).role_label || null,
          hours: (c.to || c.from || {}).hours || null,
          crew: ((c.to || c.from || {}).crew || []).slice()
        }))),
        attempt: 0,
        status: 'queued'
      }));
    }

    const publication = Object.freeze({
      id: inp.publication_id,
      station_id: next.station_id,
      source_snapshot: next.source_snapshot || null,
      source_version: next.source_version,
      content_hash: contentHash,
      published_at: at,
      published_by: inp.actor,
      first_publication: !inp.previous,
      notified_people: notifications.length
    });

    return Object.freeze({
      kind: 'publication-plan',
      duplicate: false,
      publication,
      notifications: Object.freeze(notifications),
      audit: Object.freeze({
        action: 'publish',
        publication_id: inp.publication_id,
        actor: inp.actor,
        at,
        content_hash: contentHash,
        notified_people: notifications.length
      })
    });
  }

  /* ---------------- ניסיון חוזר ---------------- */

  /**
   * כשל בשליחה אינו נוגע בפרסום. הוא מייצר רשומת ניסיון חוזר בלבד.
   * אחרי max_attempts הרשומה עוברת ל-dead_letter ומסומנת לאחראי הסידור —
   * **ולא נמחקת בשקט.**
   */
  function planRetry(input) {
    const inp = isPlainObject(input) ? input : {};
    const n = inp.notification;
    if (!isPlainObject(n) || !isNonEmptyString(n.dedupe_key)) {
      throw new PublicationError('notification-required', 'חובה למסור התראה');
    }
    if (!isNonEmptyString(inp.error_code)) {
      throw new PublicationError('error-code-required', 'חובה למסור קוד כשל');
    }
    const attempt = isInt(n.attempt) ? n.attempt + 1 : 1;
    const at = clock();

    if (attempt >= rules.max_attempts) {
      return Object.freeze({
        kind: 'notification-plan',
        dedupe_key: n.dedupe_key,
        person: n.person,
        publication_id: n.publication_id,
        push: n.push,
        detail: n.detail,
        attempt,
        status: 'dead_letter',
        last_error: inp.error_code,
        failed_at: at,
        /** הפרסום עצמו נשאר תקף. הכשל הוא בשליחה בלבד. */
        publication_still_valid: true
      });
    }
    const waitMs = rules.retry_backoff_ms[attempt - 1];
    return Object.freeze({
      kind: 'notification-plan',
      dedupe_key: n.dedupe_key,
      person: n.person,
      publication_id: n.publication_id,
      push: n.push,
      detail: n.detail,
      attempt,
      status: 'retry',
      last_error: inp.error_code,
      next_attempt_at: new Date(Date.parse(at) + waitMs).toISOString(),
      publication_still_valid: true
    });
  }

  /** מסך אחראי הסידור אחרי פרסום. */
  function summarize(notifications) {
    if (!Array.isArray(notifications)) {
      throw new PublicationError('notifications-required', 'חובה למסור רשימת התראות');
    }
    const byStatus = {};
    const seen = new Set();
    let duplicates = 0;
    for (const n of notifications) {
      if (!isPlainObject(n) || !isNonEmptyString(n.dedupe_key)) {
        throw new PublicationError('notification-shape', 'התראה לא תקינה');
      }
      if (seen.has(n.dedupe_key)) { duplicates += 1; continue; }
      seen.add(n.dedupe_key);
      const s = n.status || 'queued';
      byStatus[s] = (byStatus[s] || 0) + 1;
    }
    return Object.freeze({
      total: seen.size,
      duplicates_ignored: duplicates,
      by_status: Object.freeze(byStatus),
      dead_letters: byStatus.dead_letter || 0
    });
  }

  return Object.freeze({
    diff,
    planPublication,
    planRetry,
    summarize,
    CHANGE,
    PUSH_FIELDS,
    LIMITS
  });
}

module.exports = {
  createPublication,
  PublicationError,
  CHANGE,
  ALL_CHANGES,
  PUSH_FIELDS,
  FORBIDDEN_KEYS,
  LIMITS
};
