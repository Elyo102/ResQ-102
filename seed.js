// נתוני הדגמה.
//
// הבעיה שזה פותר: מערכת שזה עתה נפרסה היא ריקה, ומסך ריק
// נראה בדיוק כמו מסך שנכשל בטעינה. אי אפשר לבדוק שמונה
// מודולים כשאין בהם כלום.
//
// שני כללים שמפרידים בין כלי בדיקה לבין בלגן:
//
//   1. **כל רשומה מסומנת __demo.** המחיקה מוחקת בדיוק את מה
//      שנוצר כאן, ולא דבר מעבר. בלי הסימון, "נקה נתוני בדיקה"
//      הוא הימור
//   2. **אנשים אמיתיים.** האבטחות והתקלות משובצות לסגל שכבר
//      קיים במערכת. נתוני הדגמה עם "כבאי 1, כבאי 2" בודקים
//      את הפריסה אבל לא את הקריאוּת — ובדיוק הקריאוּת היא מה
//      שצריך לראות לפני שמכניסים אנשים
//
// מה שהמודול הזה **אינו** נוגע בו: סגל, משתמשים, הרשאות.
// אלה נתונים אמיתיים על אנשים אמיתיים.

export const MARK = '__demo';

function key(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const a = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + a;
}
function shift(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// ------------------------------------------------------------------
//  ההגדרות — מה שהמערכת צריכה כדי לעבוד בכלל
// ------------------------------------------------------------------
//
// בלי סבב, בלי כשירויות ובלי קו אדום, מחצית מהמסכים מציגים
// "לא הוגדר" וזו לא בדיקה של כלום.

export const QUALS = [
  { id: 'q_driver', name: 'נהג מפעיל משאבה' },
  { id: 'q_medic',  name: 'חובש' },
  { id: 'q_hazmat', name: 'חומרים מסוכנים' },
  { id: 'q_rescue', name: 'חילוץ מרכב' },
  { id: 'q_height', name: 'עבודה בגובה' }
];

export const REDLINE = {
  min_headcount: 5,
  min_quals: { q_driver: 1, q_medic: 1 }
};

export const SITES = [
  { id: 'rashit',  name: 'ראשית', fixed_hours: 0,  order: 1 },
  { id: 'shahmon', name: 'שחמון', fixed_hours: 0,  order: 2 },
  { id: 'timna',   name: 'תמנע',  fixed_hours: 0,  order: 3 },
  { id: 'yotvata', name: 'יטבתה', fixed_hours: 25, order: 4 }
];

export const ANCHORS = [
  { name: 'טרנזיט לבן',   plate: '12-345-67', kind: 'anchor' },
  { name: 'טנדר לוגיסטי', plate: '98-765-43', kind: 'anchor' }
];

// סבב שלוש משמרות. נקודת העוגן היא היום, כדי שהלוח ייראה
// נכון בלי קשר למתי מריצים.
export function rotations() {
  const anchor = key(new Date());
  return ['A', 'B', 'C'].map(function (c, i) {
    return { crew: c, position_in_cycle: i, cycle_days: 3,
             anchor_date: anchor, is_active: true,
             shift_start: '07:00', shift_end: '07:00' };
  });
}

// לוח ציוות: שלושה רכבים עם משבצות, כמו בתחנה.
export function board() {
  return {
    command: [
      { id: 'c1', rank: 'מפקד משמרת',     req: '' },
      { id: 'c2', rank: 'סגן מפקד משמרת', req: '' },
      { id: 'c3', rank: 'קצין חומ״ס',     req: 'q_hazmat' }
    ],
    vehicles: [
      { id: 'v_almog', name: 'רכב אלמוג', role: 'חומ״ס', slots: [
        { id: 's1', job: 'נהג מפעיל משאבה', req: 'q_driver' },
        { id: 's2', job: 'כבאי בכיר',       req: '' },
        { id: 's3', job: 'חובש',            req: 'q_medic' } ] },
      { id: 'v_gaash', name: 'רכב געש', role: 'חילוץ', slots: [
        { id: 's4', job: 'נהג',        req: 'q_driver' },
        { id: 's5', job: 'חלץ',        req: 'q_rescue' } ] },
      { id: 'v_saar',  name: 'רכב סער', role: 'כיבוי', slots: [
        { id: 's6', job: 'נהג',   req: 'q_driver' },
        { id: 's7', job: 'כבאי',  req: '' } ] }
    ]
  };
}

// ------------------------------------------------------------------
//  התנועה — מה שממלא את המסכים
// ------------------------------------------------------------------
//
// people = [{uid, name, crew}] מהסגל האמיתי.

export function guards(people) {
  if (!people.length) return [];
  const p = i => people[i % people.length];
  return [
    { title: 'משחק ליגה', kind: 'sport', place: 'אצטדיון טוטו טרנר',
      date: key(shift(6)), start: '18:00', end: '23:00', slots: 2,
      need_quals: [], notes: '', status: 'open',
      signups: sign([p(0), p(1)]), assigned: [] },
    { title: 'הופעה בפארק', kind: 'show', place: 'פארק העיר',
      date: key(shift(11)), start: '20:00', end: '01:00', slots: 2,
      need_quals: ['q_medic'], notes: 'להגיע עם רכב סער',
      status: 'staffed', signups: {},
      assigned: [p(2).uid, p(3).uid] },
    { title: 'עבודות חמות במספנה', kind: 'hotwork', place: 'נמל אילת',
      date: key(shift(-14)), start: '08:00', end: '14:00', slots: 1,
      need_quals: [], notes: '', status: 'done',
      signups: {}, assigned: [p(1).uid] },
    { title: 'טקס יום הזיכרון', kind: 'crowd', place: 'גן העצמאות',
      date: key(shift(-30)), start: '10:00', end: '13:00', slots: 2,
      need_quals: [], notes: '', status: 'done',
      signups: {}, assigned: [p(0).uid, p(2).uid] }
  ];
}

function sign(list) {
  const out = {};
  list.forEach(function (p) {
    out[p.uid] = { name: p.name, crew: p.crew, at: new Date().toISOString() };
  });
  return out;
}

export function faults(people) {
  if (!people.length) return [];
  const p = i => people[i % people.length];
  const iso = d => shift(d).toISOString();
  return [
    { kind: 'vehicle', vehicle_id: 'v_almog', vehicle_name: 'רכב אלמוג',
      title: 'נזילת שמן מתחת למנוע',
      desc: 'שלולית מתחת לרכב אחרי החניה. לא נבדק עדיין במוסך.',
      severity: 'blocking', status: 'open', photos: 0,
      by_uid: p(0).uid, by_name: p(0).name, crew: p(0).crew,
      date: key(shift(-1)), created_key: iso(-1) },
    { kind: 'vehicle', vehicle_id: 'v_gaash', vehicle_name: 'רכב געש',
      title: 'פנס אחורי שמאלי שרוף', desc: '',
      severity: 'unset', status: 'open', photos: 0,
      by_uid: p(1).uid, by_name: p(1).name, crew: p(1).crew,
      date: key(shift(-2)), created_key: iso(-2) },
    { kind: 'gear', vehicle_id: '', vehicle_name: '',
      title: 'מסכה מספר 4 — רצועה קרועה', desc: 'הוחלפה מהמלאי.',
      severity: 'minor', status: 'fixed', photos: 0,
      by_uid: p(2).uid, by_name: p(2).name, crew: p(2).crew,
      date: key(shift(-9)), created_key: iso(-9),
      fixed_by_name: p(2).name, fix_note: 'הוחלפה רצועה',
      fixed_key: iso(-8) },
    { kind: 'task_st', vehicle_id: '', vehicle_name: '',
      title: 'בדיקת עמדות כיבוי בקומה 2',
      desc: 'לא בוצע החודש.',
      severity: 'minor', status: 'open', photos: 0,
      by_uid: p(0).uid, by_name: p(0).name, crew: p(0).crew,
      date: key(shift(-3)), created_key: iso(-3) },
    { kind: 'note', vehicle_id: '', vehicle_name: '',
      title: 'מים בעמדת הכיבוי נסגרו לתחזוקה',
      desc: 'חוזר מחר בבוקר. עודכן במוקד.',
      severity: 'minor', status: 'open', photos: 0,
      by_uid: p(3).uid, by_name: p(3).name, crew: p(3).crew,
      date: key(shift(0)), created_key: iso(0) }
  ];
}

export function submissions(people) {
  if (people.length < 2) return [];
  const p = i => people[i % people.length];
  return [
    { form_id: 'leave', form_he: 'בקשת חופשה',
      values: { from: key(shift(9)), to: key(shift(13)),
                where: 'בחו״ל', phone: '', why: '' },
      signature: '', is_private: false, status: 'submitted',
      by_uid: p(1).uid, by_name: p(1).name, by_emp: p(1).emp || '',
      crew: p(1).crew, created_key: shift(-1).toISOString() },
    { form_id: 'leave', form_he: 'בקשת חופשה',
      values: { from: key(shift(-20)), to: key(shift(-18)),
                where: 'באילת', phone: '', why: '' },
      signature: '', is_private: false, status: 'approved',
      by_uid: p(2).uid, by_name: p(2).name, by_emp: p(2).emp || '',
      crew: p(2).crew, decided_by_name: p(0).name,
      created_key: shift(-25).toISOString() }
  ];
}

// החלפה פתוחה — הטינדר. מראה את המסלול בלי לחייב שני
// משתמשים אמיתיים ללחוץ.
export function swaps(people) {
  if (people.length < 2) return [];
  const a = people[0], b = people[1];
  return [
    { status: 'open', from_uid: a.uid, from_name: a.name, from_crew: a.crew,
      from_emp: a.emp || '', from_date: key(shift(8)),
      want_crew: b.crew, to_uid: '', to_name: '', to_crew: '',
      to_emp: '', to_date: '',
      created_key: shift(-1).toISOString() }
  ];
}

// ------------------------------------------------------------------
//  מה נמחק
// ------------------------------------------------------------------
//
// רק אוספי תנועה. ההגדרות (כשירויות, סבב, לוח, קו אדום)
// נשארות — הן מה שהתחנה תעבוד איתו, ומחיקה שלהן הייתה
// מרוקנת את המערכת בדיוק אחרי שהוגדרה.

export const WIPE = ['guards', 'faults', 'submissions', 'swaps',
                     'handovers', 'broadcasts'];

export const KEEPS = 'כשירויות, סבב, לוח ציוות, קו אדום ותחנות משנה ' +
                     'נשארים — הם ההגדרה של התחנה, לא נתוני בדיקה.';
