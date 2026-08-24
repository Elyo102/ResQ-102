// טפסים.
//
// אלדד יעלה בהמשך את הטפסים הרשמיים. לכן מה שנבנה כאן אינו
// ארבעה טפסים קשיחים אלא **היכולת** שהם ידרשו: טופס שמוגדר
// פעם אחת, ממולא מהטלפון, ונחתם.
//
// טופס קשיח היה מחייב אותי לנחש שדות, ואת אלדד לבקש שינוי
// קוד על כל שדה שחסר. הגדרה בנתונים פירושה שכשהטפסים
// הרשמיים יגיעו, מגדירים אותם במסך — בלי פריסה.
//
// היוצא מן הכלל הוא בקשת חופשה: יש עליה את כל הפרטים, כולל
// מי מאשר ומה קורה אחר כך, ולכן היא בנויה במלואה.

// ------------------------------------------------------------------
//  סוגי שדה
// ------------------------------------------------------------------

export const FIELD_TYPES = [
  { id: 'text',   he: 'שורת טקסט' },
  { id: 'long',   he: 'טקסט ארוך' },
  { id: 'date',   he: 'תאריך' },
  { id: 'time',   he: 'שעה' },
  { id: 'number', he: 'מספר' },
  { id: 'pick',   he: 'בחירה מרשימה' },
  { id: 'yesno',  he: 'כן / לא' }
];

export function fieldTypeHe(id) {
  const t = FIELD_TYPES.filter(function (x) { return x.id === id; })[0];
  return t ? t.he : id;
}

// ------------------------------------------------------------------
//  הטפסים המובנים
// ------------------------------------------------------------------
//
// שלושת האחרונים הם שלד. כשהטפסים הרשמיים יגיעו, השדות
// מוחלפים — המנוע לא משתנה.

export const BUILTIN_FORMS = [
  {
    id: 'leave',
    he: 'בקשת חופשה',
    note: 'ראש המשמרת או סגנו מאשרים. באישור, הימים נכנסים לדוח ' +
          'השעות כחופש, והשיבוץ יודע שאתה לא זמין.',
    approve: 'shift',        // ראש משמרת או סגן
    sign: false,             // בקשה, לא הצהרה
    fields: [
      { id: 'from',  he: 'מתאריך',  type: 'date',   req: true },
      { id: 'to',    he: 'עד תאריך', type: 'date',  req: true },
      { id: 'where', he: 'איפה תהיה', type: 'pick', req: true,
        opts: ['באילת', 'בארץ', 'בחו״ל'],
        note: 'קובע זמינות להזעקה. מי שבחו״ל לא ייכלל בקריאת פתע.' },
      { id: 'phone', he: 'טלפון להשגה', type: 'text', req: false },
      { id: 'why',   he: 'הערה',    type: 'long',   req: false }
    ]
  },
  {
    id: 'noclock',
    he: 'דוח אי החתמת כרטיס',
    note: 'הצהרה על שעות שלא נרשמו בשעון. נחתמת, ולכן היא ' +
          'מסמך ולא הערה.',
    approve: 'shift',
    sign: true,
    fields: [
      { id: 'date',  he: 'תאריך',     type: 'date', req: true },
      { id: 'in',    he: 'שעת כניסה', type: 'time', req: true },
      { id: 'out',   he: 'שעת יציאה', type: 'time', req: true },
      { id: 'why',   he: 'מדוע לא הוחתם', type: 'long', req: true }
    ]
  },
  {
    id: 'injury',
    he: 'דוח פציעה',
    note: 'סגור: רק אתה, ראש המשמרת, מפקד התחנה ורכז כוח אדם.',
    approve: 'shift',
    sign: true,
    private: true,           // לא מופיע בדף החפיפה ולא לכלל הסגל
    fields: [
      { id: 'date',  he: 'תאריך',   type: 'date', req: true },
      { id: 'time',  he: 'שעה',     type: 'time', req: true },
      { id: 'where', he: 'איפה קרה', type: 'text', req: true },
      { id: 'what',  he: 'מה קרה',  type: 'long', req: true },
      { id: 'hurt',  he: 'מה נפגע', type: 'text', req: true },
      { id: 'med',   he: 'טופלת רפואית', type: 'yesno', req: true }
    ]
  },
  {
    id: 'damage_rep',
    he: 'דוח נזק',
    note: 'נזק לרכוש או לצד שלישי. פגיעה ברכב התחנה מדווחת ' +
          'במסך התקלות, לא כאן.',
    approve: 'shift',
    sign: true,
    fields: [
      { id: 'date',  he: 'תאריך',   type: 'date', req: true },
      { id: 'where', he: 'איפה',    type: 'text', req: true },
      { id: 'what',  he: 'מה ניזוק', type: 'long', req: true },
      { id: 'who',   he: 'פרטי הנפגע', type: 'long', req: false },
      { id: 'how',   he: 'נסיבות',  type: 'long', req: true }
    ]
  }
];

export function formById(forms, id) {
  return (forms || BUILTIN_FORMS).filter(function (f) { return f.id === id; })[0]
      || BUILTIN_FORMS.filter(function (f) { return f.id === id; })[0]
      || null;
}

// ------------------------------------------------------------------
//  מצבים
// ------------------------------------------------------------------

export const SUB_STATES = [
  { id: 'submitted', he: 'הוגשה',  color: 'var(--warn)' },
  { id: 'approved',  he: 'אושרה',  color: 'var(--good)' },
  { id: 'rejected',  he: 'נדחתה',  color: 'var(--bad)' },
  { id: 'cancelled', he: 'בוטלה',  color: 'var(--muted)' }
];

export function subHe(id) {
  const s = SUB_STATES.filter(function (x) { return x.id === id; })[0];
  return s ? s.he : String(id || '');
}
export function subColor(id) {
  const s = SUB_STATES.filter(function (x) { return x.id === id; })[0];
  return s ? s.color : 'var(--muted)';
}
export function isPending(sub) {
  return (sub || {}).status === 'submitted';
}

// ------------------------------------------------------------------
//  אימות
// ------------------------------------------------------------------
//
// מחזיר רשימת הודעות בעברית. רשימה ריקה = תקין.
//
// טופס שנדחה בשרת בלי הסבר הוא טופס שממלאים שלוש פעמים.

export function validate(form, values) {
  const out = [];
  const v = values || {};
  (form.fields || []).forEach(function (f) {
    const val = v[f.id];
    const empty = val == null || String(val).trim() === '';
    if (f.req && empty) { out.push('חסר: ' + f.he); return; }
    if (empty) return;
    if (f.type === 'number' && isNaN(Number(val))) {
      out.push(f.he + ' — צריך מספר.');
    }
    if (f.type === 'pick' && (f.opts || []).indexOf(String(val)) === -1) {
      out.push(f.he + ' — בחירה לא מוכרת.');
    }
  });

  // טווח תאריכים הפוך. נבדק כאן ולא בשרת, כי המשתמש עוד
  // רואה את השדות ויכול לתקן.
  if (v.from && v.to && String(v.to) < String(v.from)) {
    out.push('תאריך הסיום מוקדם מתאריך ההתחלה.');
  }
  return out;
}

// ------------------------------------------------------------------
//  חופשה וזמינות
// ------------------------------------------------------------------
//
// למה בכלל נשאל איפה הכבאי נמצא: כדי שקריאת פתע לא תזעיק
// מישהו שנמצא ביוון. אלדד אישר שזו הסיבה.

export const AWAY_LEVELS = {
  'באילת': { callable: true,  he: 'זמין להזעקה' },
  'בארץ':  { callable: false, he: 'בארץ אבל לא באילת' },
  'בחו״ל': { callable: false, he: 'בחו״ל — לא ניתן להזעקה' }
};

export function callableWhileAway(where) {
  const a = AWAY_LEVELS[String(where || '')];
  return a ? a.callable : true;
}

export function awayHe(where) {
  const a = AWAY_LEVELS[String(where || '')];
  return a ? a.he : '';
}

export function toKey(d) {
  if (typeof d === 'string') return d;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const a = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + a;
}

export function dmy(key) {
  const p = String(key || '').split('-');
  return p.length === 3 ? Number(p[2]) + '.' + Number(p[1]) + '.' + p[0] : String(key || '');
}

// כל הימים בטווח, כולל הקצוות. משמש למילוי הנוכחות אחרי
// אישור, ולבדיקה מי בחופש בתאריך מסוים.
export function daysInRange(from, to) {
  const out = [];
  if (!from || !to) return out;
  const a = new Date(String(from) + 'T00:00:00');
  const b = new Date(String(to) + 'T00:00:00');
  if (isNaN(a) || isNaN(b) || b < a) return out;
  // תקרה שפויה: בקשה של שנתיים היא טעות הקלדה, לא חופשה.
  for (let i = 0; i < 400; i++) {
    const d = new Date(a);
    d.setDate(d.getDate() + i);
    out.push(toKey(d));
    if (toKey(d) === toKey(b)) break;
  }
  return out;
}

// מי בחופשה מאושרת בתאריך נתון, ואם הוא בכל זאת ניתן
// להזעקה. מוחזר כמפה uid → {where, callable}.
export function awayOn(subs, dateKey) {
  const out = {};
  (subs || []).forEach(function (s) {
    if (!s || s.form_id !== 'leave' || s.status !== 'approved') return;
    const v = s.values || {};
    const days = daysInRange(v.from, v.to);
    if (days.indexOf(String(dateKey)) === -1) return;
    out[s.by_uid] = { where: v.where || '',
                      callable: callableWhileAway(v.where),
                      name: s.by_name || '' };
  });
  return out;
}

// שורת סיכום לכרטיס. "הוגשה" בלי מה ומתי היא לא מידע.
export function summaryOf(form, sub) {
  const v = (sub || {}).values || {};
  if (!form) return '';
  if (form.id === 'leave') {
    const n = daysInRange(v.from, v.to).length;
    return dmy(v.from) + ' – ' + dmy(v.to) + ' · ' + n + ' ימים · ' +
           (v.where || '');
  }
  const first = (form.fields || []).filter(function (f) {
    return f.type === 'date';
  })[0];
  const d = first ? v[first.id] : '';
  return d ? dmy(d) : '';
}
