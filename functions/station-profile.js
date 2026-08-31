'use strict';

// תחנה נכתבה לאורך חיי המערכת בשלושה שמות. אין לבחור את הראשון
// בשקט: מסמך עם שני שיוכים שונים הוא מצב זהות פגום, וחייב להיחסם
// במקום לתת עדיפות לשדה מקרי. הערכים נשארים גולמיים — ללא trim או
// נרמול — כדי שלא תיווצר התאמה מזויפת בין הטוקן למסמך.
function resolveStationAliases(profile, isValidStationId) {
  const data = profile && typeof profile === 'object' ? profile : {};
  if (typeof isValidStationId !== 'function') {
    throw new TypeError('isValidStationId is required');
  }

  const values = [];
  for (const key of ['stationId', 'station_id', 'station']) {
    const value = data[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !isValidStationId(value)) {
      return Object.freeze({ ok: false, reason: 'invalid' });
    }
    values.push(value);
  }

  if (!values.length) return Object.freeze({ ok: false, reason: 'missing' });
  const unique = Array.from(new Set(values));
  if (unique.length !== 1) return Object.freeze({ ok: false, reason: 'conflict' });
  return Object.freeze({ ok: true, stationId: unique[0] });
}

module.exports = { resolveStationAliases };
