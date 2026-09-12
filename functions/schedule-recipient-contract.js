'use strict';

const personContract = require('./schedule-person-contract');

class ScheduleRecipientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScheduleRecipientError';
    this.code = code;
  }
}

function recipientsForChanges(input) {
  const value = input || {};
  const stationId = typeof value.station_id === 'string' ? value.station_id.trim() : '';
  const changed = Array.isArray(value.changed_person_ids) ? value.changed_person_ids : null;
  const people = Array.isArray(value.people) ? value.people : null;
  const users = Array.isArray(value.verified_users) ? value.verified_users : null;
  if (!stationId || !changed || !people || !users) throw new ScheduleRecipientError('recipient-input', 'קלט נמענים אינו תקין.');
  const wanted = new Set(changed);
  if (wanted.size !== changed.length) throw new ScheduleRecipientError('changed-duplicate', 'רשימת השינויים מכילה כפילות.');
  const byPerson = new Map();
  const byUid = new Map();
  const liveUsers = new Map();
  for (const user of users) {
    if (!user || !personContract.validUid(user.uid) || typeof user.active !== 'boolean'
        || typeof user.station_id !== 'string' || !user.station_id.trim()) {
      throw new ScheduleRecipientError('verified-user-shape', 'רשומת משתמש מאומתת אינה תקינה.');
    }
    if (liveUsers.has(user.uid)) throw new ScheduleRecipientError('verified-user-duplicate', 'משתמש מאומת הופיע פעמיים.');
    liveUsers.set(user.uid, Object.freeze({ uid:user.uid, active:user.active, station_id:user.station_id.trim() }));
  }
  for (const raw of people) {
    const person = personContract.normalizeSchedulePerson(raw);
    if (byPerson.has(person.person_id)) throw new ScheduleRecipientError('person-duplicate', 'מזהה אדם כפול.');
    byPerson.set(person.person_id, person);
    if (person.linked_uid) {
      if (byUid.has(person.linked_uid)) throw new ScheduleRecipientError('uid-duplicate', 'חשבון מקושר ליותר מאדם אחד.');
      byUid.set(person.linked_uid, person.person_id);
    }
  }
  const recipients = [];
  for (const personId of Array.from(wanted).sort()) {
    const person = byPerson.get(personId);
    if (!person) throw new ScheduleRecipientError('changed-person-missing', 'אדם שהשתנה אינו קיים במלאי.');
    if (person.station_id !== stationId) throw new ScheduleRecipientError('recipient-cross-station', 'אדם מתחנה אחרת אינו יכול לקבל הודעה.');
    if (person.kind === 'registered' && person.active && person.linked_uid) {
      const user = liveUsers.get(person.linked_uid);
      if (!user) throw new ScheduleRecipientError('verified-user-missing', 'החשבון המקושר לא אומת בזמן הפרסום.');
      if (user.station_id !== stationId) throw new ScheduleRecipientError('verified-user-cross-station', 'החשבון המקושר שייך לתחנה אחרת.');
      if (user.active) recipients.push(Object.freeze({ person_id: person.person_id, uid: person.linked_uid }));
    }
  }
  return Object.freeze(recipients);
}

module.exports = Object.freeze({ ScheduleRecipientError, recipientsForChanges });
