// מפרט המחוזות והתחנות.
//
// זהו מקור האמת היחיד לשמות ולמזהים. כל מסך שמבקש "תחנה"
// קורא מכאן — טופס ההרשמה, מסך הניהול, בקרת הגישה.
//
// למה זה קיים בכלל:
// עד עכשיו התחנה הייתה שדה טקסט חופשי. 39 כבאים שמקלידים
// "אילת", "תחנת אילת" ו-"אילת " עם רווח יוצרים שלוש תחנות
// נפרדות במסד — שלוש רשימות בקרת גישה שאף אחת לא רואה את
// השנייה. במערכת ארצית זה נזק בלתי הפיך.
//
// כלל ברזל: המזהה (id) לעולם לא משתנה אחרי שנרשם אליו אדם
// אחד. השם (name) אפשר לתקן מתי שרוצים — הוא תצוגה בלבד.

export const DISTRICTS = [
  { id: 'south',     name: 'מחוז דרום',     open: true  },
  { id: 'center',    name: 'מחוז מרכז',     open: false },
  { id: 'north',     name: 'מחוז צפון',     open: false },
  { id: 'jerusalem', name: 'מחוז ירושלים',  open: false },
  { id: 'haifa',     name: 'מחוז חוף',      open: false },
  { id: 'dan',       name: 'מחוז דן',       open: false }
];

// תחנה אזורית = היחידה שמנהלת כוח אדם, משמרות ובקרת גישה.
// תחנות הקצה שתחתיה הן מקומות עבודה, לא ישויות ניהוליות
// נפרדות — כבאי משויך לתחנה האזורית ומוצב בתחנת קצה.
export const STATIONS = [
  {
    id:         'eilat_102',
    name:       'תחנת כיבוי אילת',
    districtId: 'south',
    subStations: [
      // אלה המזהים הקיימים במסד ובלוח הציוות. שינוי כתיב כאן
      // היה יוצר לוח מודעות מקביל וריק לאותו מקום פיזי.
      { id: 'rashit',  name: 'ראשית', order: 1 },
      { id: 'shahmon', name: 'שחמון', order: 2 },
      { id: 'timna',   name: 'תמנע',  order: 3 },
      { id: 'yotvata', name: 'יטבתה', order: 4 }
    ]
  }
];

export const DISTRICT_HE = DISTRICTS.reduce(function (acc, d) {
  acc[d.id] = d.name;
  return acc;
}, {});

export const STATION_HE = STATIONS.reduce(function (acc, s) {
  acc[s.id] = s.name;
  return acc;
}, {});

export function stationsInDistrict(districtId) {
  return STATIONS.filter(function (s) { return s.districtId === districtId; });
}

export function subStationsForStation(stationId) {
  const station = STATIONS.filter(function (s) { return s.id === stationId; })[0];
  return station && Array.isArray(station.subStations)
    ? station.subStations.map(function (item) { return Object.assign({}, item); })
    : [];
}

// חוזה אחיד למסכי התחנה ולפונקציות השרת: רשומת legacy יכולה
// להשתמש באחד מכמה שדות, ולכן כל סימן מפורש לארכוב גובר על
// ברירת המחדל הפעילה.
export function subStationAvailable(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const state = String(data.status || '').toLowerCase();
  return data.is_active !== false && data.active !== false &&
    data.archived !== true && state !== 'inactive' && state !== 'archived';
}

// שם לתצוגה. אם המזהה לא מוכר — מחזיר אותו כמו שהוא, כדי
// שרשומות ישנות מלפני המפרט הזה עדיין ייראו על המסך ולא
// ייעלמו בשקט.
export function stationName(id) {
  return STATION_HE[id] || id || '';
}

export function districtName(id) {
  return DISTRICT_HE[id] || id || '';
}
