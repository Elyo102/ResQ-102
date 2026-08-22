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
      { id: 'eilat_main',  name: 'אילת ראשית' },
      { id: 'shahamon',    name: 'שחמון'      },
      { id: 'timna',       name: 'תמנע'       },
      { id: 'yotvata',     name: 'יטבתה'      }
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

// שם לתצוגה. אם המזהה לא מוכר — מחזיר אותו כמו שהוא, כדי
// שרשומות ישנות מלפני המפרט הזה עדיין ייראו על המסך ולא
// ייעלמו בשקט.
export function stationName(id) {
  return STATION_HE[id] || id || '';
}

export function districtName(id) {
  return DISTRICT_HE[id] || id || '';
}
