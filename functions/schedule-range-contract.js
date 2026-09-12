'use strict';

class ScheduleRangeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScheduleRangeError';
    this.code = code;
  }
}

const MAX_DAYS = 366;
const MAX_PEOPLE = 3000;
// Large stations are paged; a single request never serializes the full
// 3,000-person yearly population as one unbounded payload.
const MAX_CELLS = 250000;

function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function normalizeScheduleRange(input) {
  const value = input || {};
  const fromDate = iso(value.from);
  const toDate = iso(value.to);
  if (!fromDate || !toDate || fromDate > toDate) throw new ScheduleRangeError('range-invalid', 'טווח הסידור אינו תקין.');
  const days = Math.round((toDate - fromDate) / 86400000) + 1;
  if (days > MAX_DAYS) throw new ScheduleRangeError('range-too-large', 'טווח הסידור מוגבל ל־366 ימים.');
  const people = value.people === undefined ? 0 : value.people;
  if (!Number.isInteger(people) || people < 0 || people > MAX_PEOPLE) {
    throw new ScheduleRangeError('people-limit', 'כמות האנשים אינה תקינה.');
  }
  if (days * people > MAX_CELLS) throw new ScheduleRangeError('range-capacity', 'טווח הסידור חורג ממגבלת הקיבולת.');
  return Object.freeze({ from: value.from, to: value.to, days, people });
}

module.exports = Object.freeze({ ScheduleRangeError, MAX_DAYS, MAX_PEOPLE, MAX_CELLS, normalizeScheduleRange });
