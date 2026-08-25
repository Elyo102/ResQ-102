// =====================================================================
//  ייבוא היסטוריית שעות מ-Shift-eilat
// =====================================================================
//
//  **הבעיה שזה פותר.** ביום שעוברים ל-ResQ, ההיסטוריה נשארת
//  בגיליון. כבאי שרוצה לראות כמה עבד במרץ פותח מערכת שנייה,
//  ומשאבי אנוש שצריכים לבדוק חודש קודם חוזרים לגיליון. שתי
//  מערכות במקביל זו לא תקופת מעבר — זו מערכת אחת שלא הוחלפה.
//
//  **למה CSV ולא חיבור ישיר.** Apps Script יכול היה לכתוב
//  ישירות ל-Firestore, וזה נשמע נקי יותר. הוא גם היה דורש
//  מפתח שירות בתוך הגיליון — קובץ שנותן גישת כתיבה מלאה
//  למסד, בתוך מסמך שמשותף ל-42 אנשים. קובץ CSV שעובר ביד
//  הוא איטי יותר ובטוח בהרבה, והוא קורה פעם אחת בחיים של
//  המערכת.
//
//  **מה עובר ומה לא.** עוברים: תאריך, סוג יום, שעות כניסה
//  ויציאה, מקום והערה. לא עוברים: אישורים וחתימות. דוח
//  שנחתם ב-Shift-eilat נחתם שם, ואי אפשר להעביר חתימה
//  ממערכת למערכת — היא תיראה כאילו נחתמה כאן, וזה שקר.
//  כל מה שנקלט נכנס כ-status: 'imported'.

// ---------------------------------------------------------------
//  קריאת CSV
// ---------------------------------------------------------------
//
// כתוב ידנית ולא בספרייה. הפורמט כאן ידוע ומצומצם, וספרייה
// הייתה עוד תלות ברשת בתוך מסך שרץ פעם אחת.
//
// שלושה דברים שנופלים אם לא מטפלים בהם, וכולם קרו בפועל
// בקבצים שיוצאים מ-Google Sheets:
//   BOM        — התו הראשון בקובץ, והופך את "שם" ל-"﻿שם"
//   CRLF       — שורות שמסתיימות ב-\r ומזהמות את הערך האחרון
//   מרכאות     — הערה שיש בה פסיק עטופה במרכאות, ומרכאה
//                בתוך הערה מוכפלת

// זיהוי התו המפריד.
//
// **זה לא פינוק, זו הדרך שבה הקובץ באמת מגיע.**
//
// אלדד הריץ את M170, קיבל קובץ CSV מופרד בפסיקים, פתח אותו
// באקסל, סימן הכל והדביק — **ואקסל מעתיק ללוח עם טאבים, לא
// עם פסיקים.** התוצאה: כל שורה נקראה כתא אחד, אף שם עמודה לא
// נמצא, והמסך אמר "חסרות עמודות בקובץ" על קובץ תקין לגמרי.
//
// זו הייתה שגיאה בתכנון שלי: ההוראה "פתח, סמן הכל, העתק"
// מייצרת טאבים, ולא לקחתי את זה בחשבון.
//
// נבדקת השורה הראשונה בלבד: היא הכותרת, והיא לא מכילה
// טקסט חופשי שעלול להטות את הספירה. נקודה-פסיק נתמכת גם
// היא, כי אקסל בהגדרות אזור מסוימות מייצא איתה.

export function sniffDelimiter(text) {
  const first = String(text || '').split('\n')[0] || '';
  const counts = [
    { ch: '\t', n: (first.match(/\t/g)  || []).length },
    { ch: ',',  n: (first.match(/,/g)   || []).length },
    { ch: ';',  n: (first.match(/;/g)   || []).length }
  ].sort(function (a, b) { return b.n - a.n; });
  // בלי אף מפריד — פסיק, כדי שקובץ בעל עמודה אחת עדיין ייקרא.
  return counts[0].n > 0 ? counts[0].ch : ',';
}

export function parseCsv(text) {
  const s = String(text == null ? '' : text).replace(/^﻿/, '');
  const sep = sniffDelimiter(s);
  const rows = [];
  let row = [], cell = '', q = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { q = true; continue; }
    if (c === sep) { row.push(cell); cell = ''; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (c === '\r') continue;
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  // שורות ריקות לגמרי בסוף הקובץ אינן נתונים.
  return rows.filter(function (r) {
    return r.some(function (v) { return String(v).trim() !== ''; });
  });
}

// ---------------------------------------------------------------
//  חוזה העמודות
// ---------------------------------------------------------------
//
// הכותרות בעברית במכוון: אלדד פותח את הקובץ לפני שהוא מעלה
// אותו, וכותרות באנגלית היו הופכות בדיקה של שלוש שניות
// לניחוש.
//
// הסדר אינו קובע — העמודות מזוהות לפי השם. עמודה שהוזזה
// בגיליון לא תשבור את הייבוא, ועמודה חסרה תיתפס בשמה.

export const COLUMNS = [
  { key: 'name',   he: 'שם',          req: true  },
  { key: 'emp',    he: 'מספר עובד',   req: true  },
  { key: 'crew',   he: 'משמרת',       req: false },
  { key: 'date',   he: 'תאריך',       req: true  },
  { key: 'type',   he: 'סוג יום',     req: true  },
  { key: 'start',  he: 'כניסה',       req: false },
  { key: 'end',    he: 'יציאה',       req: false },
  { key: 'start2', he: 'כניסה 2',     req: false },
  { key: 'end2',   he: 'יציאה 2',     req: false },
  { key: 'hours',  he: 'שעות',        req: false },
  { key: 'site',   he: 'מקום',        req: false },
  { key: 'notes',  he: 'הערה',        req: false }
];

export function headerMap(headerRow) {
  const idx = {}, missing = [];
  const clean = (headerRow || []).map(function (h) {
    return String(h == null ? '' : h).replace(/^﻿/, '').trim();
  });
  COLUMNS.forEach(function (c) {
    const at = clean.indexOf(c.he);
    if (at === -1) { if (c.req) missing.push(c.he); return; }
    idx[c.key] = at;
  });
  return { idx: idx, missing: missing };
}

// ---------------------------------------------------------------
//  תרגום סוג היום
// ---------------------------------------------------------------
//
//  שתי המערכות חושבות אחרת על אותו יום, וזו הנקודה שבה
//  ייבוא נאיבי מייצר נתונים שגויים בשקט:
//
//  ב-Shift-eilat "סוג היום" מערבב **מה זה** (חופש, מחלה)
//  עם **מה הצורה** (המשך משמרת, משמרת מפוצלת) ועם **איפה**
//  (יטבתה). ב-ResQ אלה שלושה שדות נפרדים: day_type, shape
//  ו-sub_station — כי אחרת אי אפשר לשאול "כמה משמרות מפוצלות
//  היו לו" בלי לפרסר מחרוזת.
//
//  יטבתה היא 25 שעות בהגדרה, ולכן היא חייבת להיכנס כמקום
//  ולא כסוג. יום יטבתה שלם אינו חריגה ואינו דורש נימוק —
//  אלדד תיקן אותי על זה במפורש.

const TYPE_MAP = {
  'רגיל':            { day_type: 'regular',  shape: 'regular'   },
  'משמרת':           { day_type: 'regular',  shape: 'regular'   },
  'משמרת רגילה':     { day_type: 'regular',  shape: 'regular'   },
  'חופש':            { day_type: 'vacation', shape: 'regular'   },
  'חופשה':           { day_type: 'vacation', shape: 'regular'   },
  'מחלה':            { day_type: 'sick',     shape: 'regular'   },
  'מילואים':         { day_type: 'reserve',  shape: 'regular'   },
  'יטבתה':           { day_type: 'regular',  shape: 'regular',   site: 'yotvata' },
  'יוטבתה':          { day_type: 'regular',  shape: 'regular',   site: 'yotvata' },
  'המשך משמרת':      { day_type: 'regular',  shape: 'continued' },
  'משמרת מפוצלת':    { day_type: 'regular',  shape: 'split'     },
  'אבטחה':           { day_type: 'guard',    shape: 'regular'   },
  'ישיבות':          { day_type: 'meeting',  shape: 'regular'   },
  'ישיבה':           { day_type: 'meeting',  shape: 'regular'   }
};

export function mapDayType(he) {
  const t = String(he == null ? '' : he).trim();
  return TYPE_MAP[t] || null;
}

// ---------------------------------------------------------------
//  תחנות הקצה
// ---------------------------------------------------------------
//
//  עמודת "מקום" בקובץ נקראה אבל **לא נכנסה לרשומה** — ראיתי
//  את זה בנתונים של אלדד: שורה של ישיבה ב"ראשית" הייתה
//  נכנסת בלי שום ציון מקום.
//
//  זה משנה יותר מתצוגה: יטבתה היא משמרת של 25 שעות בהגדרה,
//  ולכן יום יטבתה שלם אינו חריגה ואינו דורש נימוק. בלי
//  ה-sub_station, המערכת הייתה מסמנת אותו כחריגה.
//
//  "אילת" אינה תחנת קצה — היא התחנה עצמה, ולכן היא ממופה
//  למחרוזת ריקה בדיוק כמו שהמסך שומר יום רגיל.

const SITE_MAP = {
  'ראשית':  'rashit',
  'שחמון':  'shahmon',
  'תמנע':   'timna',
  'יטבתה':  'yotvata',
  'יוטבתה': 'yotvata',
  'אילת':   '',
  '':       ''
};

export function mapSite(he) {
  const t = String(he == null ? '' : he).trim();
  // מקום שאינו מוכר אינו שגיאה — הוא פשוט לא תחנת קצה
  // מוגדרת, והרשומה נכנסת כאילו נעשתה בתחנה עצמה.
  return SITE_MAP[t] != null ? SITE_MAP[t] : '';
}

export function knownTypes() { return Object.keys(TYPE_MAP); }

// ---------------------------------------------------------------
//  התאמת שמות
// ---------------------------------------------------------------
//
//  **מספר עובד קודם לשם, תמיד.** שם הוא מחרוזת שאדם הקליד:
//  "מורגאן מרעי" מול "מורגן", "רחמים חנן" מול "רמי". בדיוק
//  הכינוי הזה גרם ל-266 שעות של רחמים חנן להיספר כאפס
//  ב-Shift-eilat, כי הלשונית שלו נקראת "רמי" והבקרה מחפשת
//  "רחמים חנן".
//
//  לכן: מתאימים לפי מספר עובד. השם משמש רק כשאין מספר,
//  ואז דרך אותה טבלת כינויים.

export const NAME_ALIASES = {
  'מורגאן מרעי': ['מורגן'],
  'רחמים חנן':   ['רמי', 'רמי חנן'],
  'אכרם חמזה':   ['אכרם']
};

function normName(s) {
  return String(s == null ? '' : s)
    .replace(/["'׳״]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchPerson(row, roster) {
  const people = roster || [];
  const emp = String(row.emp == null ? '' : row.emp).trim();

  if (emp) {
    const byEmp = people.filter(function (p) {
      return String(p.emp == null ? '' : p.emp).trim() === emp;
    })[0];
    if (byEmp) return { person: byEmp, how: 'emp' };
  }

  const n = normName(row.name);
  if (!n) return { person: null, how: 'none' };

  const byName = people.filter(function (p) { return normName(p.name) === n; })[0];
  if (byName) return { person: byName, how: 'name' };

  // כינויים. עוברים על הטבלה ובודקים אם השם בקובץ הוא כינוי
  // של מישהו שקיים.
  const keys = Object.keys(NAME_ALIASES);
  for (let i = 0; i < keys.length; i++) {
    const full = keys[i];
    const nicks = NAME_ALIASES[full].map(normName);
    if (nicks.indexOf(n) === -1 && normName(full) !== n) continue;
    const p = people.filter(function (x) { return normName(x.name) === normName(full); })[0];
    if (p) return { person: p, how: 'alias' };
  }

  return { person: null, how: 'none' };
}

// ---------------------------------------------------------------
//  בניית רשומת נוכחות
// ---------------------------------------------------------------

export function isDateKey(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function cleanTime(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return '';
  return String(h).padStart(2, '0') + ':' + m[2];
}

// מחזיר { rec } או { error } — לעולם לא זורק. שורה אחת פגומה
// בקובץ של 12,000 שורות אסור שתפיל את כל הייבוא.
export function toAttendance(row, person, sid) {
  const date = String(row.date == null ? '' : row.date).trim();
  if (!isDateKey(date)) {
    return { error: 'תאריך לא תקין: "' + date + '" (צריך 2026-08-01)' };
  }

  const t = mapDayType(row.type);
  if (!t) return { error: 'סוג יום לא מוכר: "' + String(row.type || '') + '"' };

  const start  = cleanTime(row.start);
  const end    = cleanTime(row.end);
  const start2 = cleanTime(row.start2);
  const end2   = cleanTime(row.end2);

  // השעות נלקחות מהקובץ ולא מחושבות מחדש. זו החלטה מכוונת:
  // Shift-eilat חישב אותן לפי הכללים שלו — כולל שעת התחלה
  // קבועה של 06:45 לראשי משמרת, יטבתה 25 שעות, ומילואים 8.5.
  // חישוב מחדש כאן היה מייצר מספרים שונים מאלה שהאדם ראה
  // ואישר בזמנו, ואז ההיסטוריה שנקלטה סותרת את הדוחות
  // שכבר נשלחו למשאבי אנוש.
  let hours = Number(String(row.hours == null ? '' : row.hours).trim());
  if (!isFinite(hours) || hours < 0) hours = 0;
  if (hours > 48) return { error: 'שעות לא סבירות: ' + hours };

  const rec = {
    emp_number: String(person.emp || ''),
    uid: person.uid || '',
    full_name: person.name || '',
    crew: person.crew || String(row.crew || ''),
    date: date,
    month: date.slice(0, 7),
    day_type: t.day_type,
    shape: t.shape,
    start: start, end: end,
    // סוג היום גובר על עמודת המקום: מי שרשום "יטבתה" בסוג
    // היום נמצא ביטבתה גם אם עמודת המקום ריקה.
    sub_station: t.site || mapSite(row.site),
    hours: Math.round(hours * 100) / 100,
    notes: String(row.notes == null ? '' : row.notes).trim().slice(0, 300),

    // **לא 'approved' ולא 'draft'.**
    //
    // 'approved' היה אומר שמישהו אישר את זה כאן, וזה לא נכון —
    // האישור, אם היה, קרה במערכת אחרת. 'draft' היה מזמין את
    // הכבאי לערוך היסטוריה שכבר שולמה עליה משכורת.
    //
    // 'imported' אומר בדיוק מה שקרה: הנתון הגיע מבחוץ, הוא
    // נכון לפי המקור, ואיש לא חתם עליו כאן.
    status: 'imported',
    imported_from: 'shift-eilat',
    imported_key: new Date().toISOString()
  };

  if (t.shape === 'split') {
    if (!start2 || !end2) {
      return { error: 'משמרת מפוצלת בלי קטע שני' };
    }
    rec.start2 = start2; rec.end2 = end2;
  }

  // המשך משמרת חוצה חצות ביום. בלי end_day, כל חישוב עתידי
  // שיסתכל על הרשומה יראה משמרת שנגמרת לפני שהתחילה.
  if (t.shape === 'continued') rec.end_day = 1;

  return { rec: rec, id: String(person.emp || '') + '_' + date };
}

// ---------------------------------------------------------------
//  הרצה יבשה
// ---------------------------------------------------------------
//
//  **שום דבר לא נכתב לפני שאלדד רואה את התוצאה.** ייבוא של
//  12,000 רשומות שמתברר כשגוי אחרי הכתיבה הוא לא "נסה שוב" —
//  הוא ניקוי ידני של אוסף שלם.

export function dryRun(csvText, roster) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { fatal: 'הקובץ ריק או מכיל רק שורת כותרת.' };
  }

  const hm = headerMap(rows[0]);
  if (hm.missing.length) {
    return { fatal: 'חסרות עמודות בקובץ: ' + hm.missing.join(', ') +
                    '. הרץ את M170 ב-Shift-eilat כדי לייצר קובץ תקין.' };
  }

  const ok = [], bad = [], unknownPeople = {}, months = {}, perPerson = {};
  const seen = {};
  let dupes = 0;

  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i];
    const row = {};
    Object.keys(hm.idx).forEach(function (k) {
      row[k] = raw[hm.idx[k]] == null ? '' : raw[hm.idx[k]];
    });

    const m = matchPerson(row, roster);
    if (!m.person) {
      const label = (String(row.name || '').trim() || '(בלי שם)') +
                    (row.emp ? ' · ' + row.emp : '');
      unknownPeople[label] = (unknownPeople[label] || 0) + 1;
      bad.push({ line: i + 1, why: 'לא נמצא במערכת: ' + label });
      continue;
    }

    const out = toAttendance(row, m.person, null);
    if (out.error) { bad.push({ line: i + 1, why: out.error }); continue; }

    // אותו אדם ואותו יום פעמיים בקובץ. קורה כשמייצאים חודש
    // פעמיים ומדביקים את שני הקבצים.
    if (seen[out.id]) { dupes++; continue; }
    seen[out.id] = true;

    ok.push(out);
    months[out.rec.month] = (months[out.rec.month] || 0) + 1;
    const pk = out.rec.full_name || out.rec.emp_number;
    perPerson[pk] = perPerson[pk] || { rows: 0, hours: 0 };
    perPerson[pk].rows++;
    perPerson[pk].hours = Math.round((perPerson[pk].hours + out.rec.hours) * 100) / 100;
  }

  return {
    fatal: '',
    ready: ok,
    errors: bad,
    dupes: dupes,
    unknownPeople: unknownPeople,
    months: months,
    perPerson: perPerson,
    totalRows: rows.length - 1,
    totalHours: Math.round(ok.reduce(function (a, o) {
      return a + o.rec.hours; }, 0) * 100) / 100
  };
}
