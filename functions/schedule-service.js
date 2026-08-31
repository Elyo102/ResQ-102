'use strict';

/**
 * schedule-service — שכבת ההרשאות והתצוגות של ניהול סידור עבודה.
 *
 * מודול טהור. מקבל מנוע ומודול פרסום **בהזרקה**, ומחזיר תוכניות ותצוגות.
 * אינו קורא מהמסד, אינו כותב ואינו שולח.
 *
 * ארבעה כללים שאין לשבור:
 *   1. ההפרדה נאכפת כאן, בשרת, ולא במסך. מסך אינו הרשאה.
 *   2. כבאי רגיל צופה בשתי התצוגות ומגיב **רק לשיבוץ שלו**.
 *   3. עריכה, הרצה ופרסום — לאחראי הסידור ולקצינים מורשים בלבד.
 *   4. יכולות מגיעות מ-rules.capabilities. אין ברירת מחדל ואין תפקיד מוכר מראש.
 */

class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

const ACTION = Object.freeze({
  VIEW_MY: 'view_my',
  VIEW_STATION: 'view_station',
  EDIT_DRAFT: 'edit_draft',
  RUN_PLANNER: 'run_planner',
  PUBLISH: 'publish',
  RESPOND_OWN: 'respond_own'
});

const ALL_ACTIONS = Object.freeze(Object.keys(ACTION).map((k) => ACTION[k]));

/** פעולות שאסור שיינתנו לכבאי רגיל. בדיקת מקור אוכפת שהרשימה נשארת. */
const PRIVILEGED = Object.freeze([ACTION.EDIT_DRAFT, ACTION.RUN_PLANNER, ACTION.PUBLISH]);
const DECLINE_REASONS = Object.freeze(['unavailable', 'conflict', 'incorrect_assignment', 'other']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function createScheduleService(deps) {
  const d = isPlainObject(deps) ? deps : {};

  const clock = d.clock;
  if (typeof clock !== 'function') throw new ServiceError('clock-required', 'חובה להזריק clock');

  const engine = d.engine;
  if (!isPlainObject(engine) || typeof engine.planPeriod !== 'function') {
    throw new ServiceError('engine-required', 'חובה להזריק מנוע סידור');
  }
  const publication = d.publication;
  if (!isPlainObject(publication) || typeof publication.planPublication !== 'function') {
    throw new ServiceError('publication-required', 'חובה להזריק מודול פרסום');
  }

  const rules = isPlainObject(d.rules) ? d.rules : null;
  if (!rules) throw new ServiceError('rules-required', 'חובה להזריק rules');
  if (!isNonEmptyString(rules.station_id)) {
    throw new ServiceError('rules-station', 'חובה להגדיר את התחנה');
  }
  if (!isPlainObject(engine.policy) || engine.policy.station_id !== rules.station_id) {
    throw new ServiceError('engine-station-mismatch', 'המנוע ושכבת ההרשאות חייבים להיות קשורים לאותה תחנה');
  }
  const caps = rules.capabilities;
  if (!isPlainObject(caps) || Object.keys(caps).length === 0) {
    throw new ServiceError('rules-capabilities', 'חובה להגדיר יכולות לכל תפקיד. אין ברירת מחדל.');
  }
  for (const role of Object.keys(caps)) {
    const list = caps[role];
    if (!Array.isArray(list)) throw new ServiceError('capabilities-shape', 'יכולות התפקיד ' + role + ' אינן רשימה');
    for (const a of list) {
      if (ALL_ACTIONS.indexOf(a) === -1) {
        throw new ServiceError('capability-unknown', 'פעולה לא מוכרת בתפקיד ' + role + ': ' + a);
      }
    }
  }

  /* ---------------- הרשאה ---------------- */

  function assertActor(actor) {
    if (!isPlainObject(actor)) throw new ServiceError('actor-required', 'חובה למסור מבצע');
    if (!isNonEmptyString(actor.id)) throw new ServiceError('actor-id', 'למבצע חסר מזהה');
    if (!isNonEmptyString(actor.role)) throw new ServiceError('actor-role', 'למבצע חסר תפקיד');
    if (!isNonEmptyString(actor.station_id)) throw new ServiceError('actor-station', 'למבצע חסרה תחנה');
    if (typeof actor.active !== 'boolean') {
      throw new ServiceError('actor-active', 'למבצע חסר סימון פעיל/לא פעיל מפורש');
    }
    if (actor.active !== true) throw new ServiceError('actor-inactive', 'משתמש לא פעיל');
    if (actor.station_id !== rules.station_id) {
      throw new ServiceError('actor-station-mismatch', 'המשתמש אינו שייך לתחנה');
    }
    if (!Object.prototype.hasOwnProperty.call(caps, actor.role)) {
      throw new ServiceError('role-unknown', 'תפקיד שאין לו יכולות מוגדרות: ' + actor.role);
    }
    return actor;
  }

  /**
   * שער יחיד. **כל מסלול במודול עובר דרכו**, ובדיקת מקור אוכפת זאת.
   */
  function assertMay(action, actor, target) {
    if (ALL_ACTIONS.indexOf(action) === -1) {
      throw new ServiceError('action-unknown', 'פעולה לא מוכרת: ' + action);
    }
    assertActor(actor);
    if (caps[actor.role].indexOf(action) === -1) {
      throw new ServiceError('forbidden', 'התפקיד ' + actor.role + ' אינו רשאי: ' + action);
    }
    // אדם עונה רק עבור עצמו — גם אם התפקיד שלו מרשה תגובה.
    if (action === ACTION.RESPOND_OWN) {
      if (!isNonEmptyString(target)) throw new ServiceError('target-required', 'חסר האדם שעבורו עונים');
      if (target !== actor.id) throw new ServiceError('not-your-answer', 'אי אפשר לענות בשם אדם אחר');
    }
    return true;
  }

  /* ---------------- תצוגה · הסידור שלי ---------------- */

  function assertPlan(plan) {
    if (!isPlainObject(plan) || !Array.isArray(plan.rows)) {
      throw new ServiceError('plan-required', 'חובה למסור תוכנית');
    }
    if (!isNonEmptyString(plan.station_id) || plan.station_id !== rules.station_id) {
      throw new ServiceError('plan-station-mismatch', 'התוכנית אינה שייכת לתחנה של המשתמש');
    }
    if (!isNonEmptyString(plan.source_snapshot) || !isNonEmptyString(plan.source_version)) {
      throw new ServiceError('plan-source-required', 'לתוכנית חסר זיהוי מקור מלא');
    }
    if (!isNonEmptyString(plan.contract_station_id)
        || plan.contract_station_id !== plan.station_id
        || !isNonEmptyString(plan.source_revision)
        || !isNonEmptyString(plan.source_digest)
        || !isNonEmptyString(plan.policy_version)
        || !isNonEmptyString(plan.policy_digest)
        || plan.source_complete !== true) {
      throw new ServiceError('plan-source-contract', 'לתוכנית חסר חוזה מקור מלא ותואם');
    }
    for (const row of plan.rows) {
      if (!isPlainObject(row) || row.station_id !== rules.station_id) {
        throw new ServiceError('plan-row-station-mismatch', 'אחת משורות התוכנית שייכת לתחנה אחרת');
      }
    }
    return plan;
  }

  function assertEvents(events, plan, what) {
    if (events === undefined || events === null) return [];
    if (!Array.isArray(events)) throw new ServiceError('events-shape', what + ' אינם מערך');
    for (const event of events) {
      if (!isPlainObject(event)) throw new ServiceError('event-shape', what + ' כוללים אירוע לא תקין');
      if (event.station_id !== rules.station_id) {
        throw new ServiceError('event-station-mismatch', what + ' כוללים אירוע מתחנה אחרת');
      }
      if (event.source_snapshot !== plan.source_snapshot || event.source_version !== plan.source_version) {
        throw new ServiceError('event-source-mismatch', what + ' אינם מאותו מקור של התוכנית');
      }
    }
    return events;
  }

  function qualificationsOf(roster, id) {
    if (!Array.isArray(roster)) return [];
    const p = roster.filter((x) => x && x.id === id)[0];
    if (!p) return [];
    return Array.isArray(p.qualifications) ? p.qualifications.slice()
      : (Array.isArray(p.roles) ? p.roles.slice() : []);
  }

  function personName(roster, id) {
    if (!Array.isArray(roster)) return id;
    const person = roster.filter((entry) => entry && entry.id === id)[0];
    return person && isNonEmptyString(person.name) ? person.name : id;
  }

  /**
   * „הסידור שלי" — רק שלו, עם מי הוא עובד ומה השתנה.
   * מצב התגובה מגיע מבחוץ; המודול אינו ממציא אישור לאיש.
   */
  function buildMySchedule(input) {
    const inp = isPlainObject(input) ? input : {};
    const actor = inp.actor;
    assertMay(ACTION.VIEW_MY, actor);
    const plan = assertPlan(inp.plan);
    const person = isNonEmptyString(inp.person) ? inp.person : actor.id;
    if (person !== actor.id) {
      // צפייה בסידור של אדם אחר היא „סידור התחנה", לא „הסידור שלי".
      throw new ServiceError('not-your-schedule', 'המסך הזה מציג את הסידור שלך בלבד');
    }

    const events = assertEvents(inp.events, plan, 'האירועים האישיים');
    const changes = isPlainObject(inp.changes_by_date) ? inp.changes_by_date : {};
    const answers = isPlainObject(inp.answers_by_date) ? inp.answers_by_date : {};

    const days = [];
    for (const row of plan.rows) {
      for (const s of row.slots) {
        if (s.person !== person) continue;
        days.push({
          date: row.date,
          station_id: row.station_id,
          sub_station: row.sub_station,
          sub_station_label: row.label,
          role: s.role,
          role_label: s.label,
          hours: s.hours || null,
          shift: s.shift || null,
          rotation_group: row.rotation_group === undefined ? null : row.rotation_group,
          cancelled: s.cancelled === true,
          crew: row.slots.filter((x) => x.person !== person)
            .map((x) => ({ uid: x.person, person: personName(inp.roster, x.person), role_label: x.label || null }))
            .sort((a, b) => (a.person < b.person ? -1 : a.person > b.person ? 1 : 0)),
          qualifications: qualificationsOf(inp.roster, person),
          change: changes[row.date] || null,
          answer: answers[row.date] || null,
          /** חובה לענות: אישור או „לא יכול" עם נימוק. */
          requires_answer: !!changes[row.date] && !answers[row.date]
        });
      }
    }

    const myEvents = events.filter((e) => isPlainObject(e) && Array.isArray(e.people) && e.people.indexOf(person) > -1)
      .map((e) => ({
        id: e.id, title: e.title, date: e.date, hours: e.hours || null,
        cancelled: e.cancelled === true,
        change: changes[e.id] || null,
        answer: answers[e.id] || null,
        requires_answer: e.cancelled !== true && !!changes[e.id] && !answers[e.id]
      }));

    days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    myEvents.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    return Object.freeze({
      kind: 'my-schedule',
      view: 'mine',
      person,
      generated_at: clock(),
      days: Object.freeze(days),
      events: Object.freeze(myEvents),
      pending_answers: days.filter((x) => x.requires_answer).length
        + myEvents.filter((x) => x.requires_answer).length
    });
  }

  /* ---------------- תצוגה · סידור התחנה ---------------- */

  function shiftDate(iso, delta) {
    const ms = Date.parse(iso + 'T00:00:00.000Z');
    if (Number.isNaN(ms)) throw new ServiceError('bad-date', 'תאריך לא תקין: ' + iso);
    const dt = new Date(ms + delta * 86400000);
    const p = (x) => String(x).padStart(2, '0');
    return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
  }

  function dayBlock(plan, date, viewer, events, roster) {
    const subs = [];
    for (const row of plan.rows) {
      if (row.date !== date) continue;
      subs.push({
        sub_station: row.sub_station,
        label: row.label,
        minimum: row.minimum === undefined ? null : row.minimum,
        below_minimum: row.below_minimum === true,
        people: row.slots.map((s) => ({
          uid: s.person,
          person: personName(roster, s.person),
          role_label: s.label || null,
          hours: s.hours || null,
          cancelled: s.cancelled === true,
          /** ההדגשה של המשתמש המחובר. */
          is_me: s.person === viewer
        }))
      });
    }
    const dayEvents = (events || []).filter((e) => isPlainObject(e) && e.date === date)
      .map((e) => ({
        id: e.id, title: e.title, hours: e.hours || null,
        cancelled: e.cancelled === true,
        people: Array.isArray(e.people) ? e.people.map((id) => ({
          uid: id,
          person: personName(roster, id),
          is_me: id === viewer
        })) : [],
        includes_me: Array.isArray(e.people) && e.people.indexOf(viewer) > -1
      }));
    return { date, sub_stations: subs, events: dayEvents };
  }

  /**
   * „סידור התחנה" — כלל התחנה, עם היום שלפני והיום שאחרי,
   * כדי שאפשר יהיה לראות מי עובד לפניך, איתך ואחריך.
   */
  function buildStationSchedule(input) {
    const inp = isPlainObject(input) ? input : {};
    const actor = inp.actor;
    assertMay(ACTION.VIEW_STATION, actor);
    const plan = assertPlan(inp.plan);
    if (!isNonEmptyString(inp.date)) throw new ServiceError('date-required', 'חובה למסור תאריך');

    const events = assertEvents(inp.events, plan, 'אירועי התחנה');
    return Object.freeze({
      kind: 'station-schedule',
      view: 'station',
      viewer: actor.id,
      generated_at: clock(),
      previous_day: Object.freeze(dayBlock(plan, shiftDate(inp.date, -1), actor.id, events, inp.roster)),
      day: Object.freeze(dayBlock(plan, inp.date, actor.id, events, inp.roster)),
      next_day: Object.freeze(dayBlock(plan, shiftDate(inp.date, 1), actor.id, events, inp.roster))
    });
  }

  /* ---------------- פעולות ניהול ---------------- */

  function runPlanner(input) {
    const inp = isPlainObject(input) ? input : {};
    assertMay(ACTION.RUN_PLANNER, inp.actor);
    if (!isPlainObject(inp.request) || inp.request.station_id !== rules.station_id) {
      throw new ServiceError('request-station-mismatch', 'בקשת התכנון אינה שייכת לתחנה של המשתמש');
    }
    const plan = inp.months === undefined
      ? engine.planPeriod(inp.request)
      : engine.planMonths(Object.assign({}, inp.request, { months: inp.months }));
    return Object.freeze({
      kind: 'planner-run',
      by: inp.actor.id,
      at: clock(),
      /** תוצאה של הרצה היא טיוטה. איש לא קיבל דבר. */
      state: 'draft',
      plan
    });
  }

  function publish(input) {
    const inp = isPlainObject(input) ? input : {};
    assertMay(ACTION.PUBLISH, inp.actor);
    if (!isPlainObject(inp.request)) throw new ServiceError('publish-request', 'חסרה בקשת פרסום');
    assertPlan(inp.request.next);
    assertEvents(inp.request.next_events, inp.request.next, 'אירועי התוכנית החדשה');
    if (inp.request.previous !== undefined && inp.request.previous !== null) {
      assertPlan(inp.request.previous);
      assertEvents(inp.request.previous_events, inp.request.previous, 'אירועי התוכנית הקודמת');
    } else if (inp.request.previous_events !== undefined && inp.request.previous_events !== null
        && (!Array.isArray(inp.request.previous_events) || inp.request.previous_events.length > 0)) {
      throw new ServiceError('previous-events-without-plan', 'אי אפשר למסור אירועים קודמים בלי תוכנית קודמת');
    }
    return publication.planPublication(Object.assign({}, inp.request, { actor: inp.actor.id }));
  }

  /** תגובת כבאי. עוברת בשער ואינה נגישה לאיש בשם אחר. */
  function respond(input) {
    const inp = isPlainObject(input) ? input : {};
    const target = isPlainObject(inp.request) ? inp.request.person : undefined;
    assertMay(ACTION.RESPOND_OWN, inp.actor, target);
    if (!isNonEmptyString(inp.answer) || ['confirm', 'decline'].indexOf(inp.answer) === -1) {
      throw new ServiceError('answer-required', 'התשובה חייבת להיות confirm או decline');
    }
    if (!isNonEmptyString(inp.request.request_id)) {
      throw new ServiceError('request-id-required', 'חובה למסור מזהה פעולה חד-פעמי');
    }
    if (!isNonEmptyString(inp.request.publication_id) || !isNonEmptyString(inp.request.item_id)
        || !Number.isInteger(inp.request.publication_revision) || inp.request.publication_revision < 1) {
      throw new ServiceError('response-target-required', 'חובה לזהות פרסום, גרסה ושיבוץ');
    }
    const active = inp.active_publication;
    if (!isPlainObject(active) || active.id !== inp.request.publication_id
        || active.revision !== inp.request.publication_revision) {
      throw new ServiceError('publication-not-active', 'אפשר לענות רק לגרסה הפעילה');
    }
    if (active.station_id !== rules.station_id) {
      throw new ServiceError('publication-station-mismatch', 'הפרסום הפעיל אינו שייך לתחנה של המשתמש');
    }
    if (!Array.isArray(active.assigned_items)) {
      throw new ServiceError('publication-items-required', 'לפרסום הפעיל חסרה רשימת שיבוצים מוסמכת');
    }
    const ownItem = active.assigned_items.some((item) => isPlainObject(item)
      && item.id === inp.request.item_id && item.person === inp.actor.id);
    if (!ownItem) {
      throw new ServiceError('response-item-not-owned', 'השיבוץ אינו שייך למשתמש בפרסום הפעיל');
    }
    if (inp.answer === 'decline' && DECLINE_REASONS.indexOf(inp.reason_code) === -1) {
      throw new ServiceError('decline-reason-required', 'דחייה מחייבת סיבת דחייה מוכרת');
    }
    if (inp.answer === 'confirm' && inp.reason_code !== undefined && inp.reason_code !== null) {
      throw new ServiceError('confirm-reason-forbidden', 'אישור אינו מקבל סיבת דחייה');
    }
    return Object.freeze({
      kind: 'response-plan',
      person: inp.actor.id,
      request_id: inp.request.request_id,
      publication_id: inp.request.publication_id,
      publication_revision: inp.request.publication_revision,
      item_id: inp.request.item_id,
      answer: inp.answer,
      reason_code: inp.answer === 'decline' ? inp.reason_code : null,
      at: clock(),
      idempotency_key: inp.actor.id + ':' + inp.request.request_id
    });
  }

  return Object.freeze({
    assertMay,
    buildMySchedule,
    buildStationSchedule,
    runPlanner,
    publish,
    respond,
    ACTION,
    PRIVILEGED
  });
}

module.exports = { createScheduleService, ServiceError, ACTION, ALL_ACTIONS, PRIVILEGED, DECLINE_REASONS };
