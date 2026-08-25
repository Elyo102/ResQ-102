// =====================================================================
//  שרשרת החתימות — מי חותם, אחרי מי, ומתי המסמך סגור
// =====================================================================
//
//  הכלל הבסיסי, לפי אלדד: **כבאי ואז ראש משמרת.** שתי חתימות,
//  וזהו. סגן ראש משמרת שקול לראש המשמרת בכל מקום במערכת, וכך
//  גם כאן.
//
//  חריג יחיד: **חופשה בחו"ל דורשת גם את מפקד התחנה.** יציאה
//  מהארץ פירושה שאי אפשר להזעיק את האדם בכלל, ולכן ההחלטה
//  עולה דרגה. חופשה בארץ אינה דורשת זאת — מי שנמצא באילת או
//  בבאר שבע עדיין ניתן לקריאה.
//
//  ראש משמרת רשאי לחתום **במקום** כבאי שלא חתם עד סוף החודש.
//  זה מכוון: דוח שעות שלא נחתם מעכב שכר של אדם. אבל החתימה
//  לעולם אינה מתחזה — היא נרשמת כ"נחתם בידי X בשם Y", והסיבה
//  נשמרת איתה.

// שלבי החתימה, לפי סדר. סדר המערך הוא הסדר בפועל.
export const STEP = {
  'EMPLOYEE':  'employee',
  'COMMANDER': 'commander',
  'STATION':   'station_commander'
};

// מי רשאי לחתום בכל שלב. הרשימות כוללות גם את מנהל-העל,
// שרשאי לחתום בכל שלב — הוא זה שמתקן כשמשהו נתקע.
const WHO_MAY = {
  [STEP.EMPLOYEE]:  ['self'],
  [STEP.COMMANDER]: ['commander', 'deputy', 'station_commander', 'super'],
  [STEP.STATION]:   ['station_commander', 'super']
};

const LABEL = {
  [STEP.EMPLOYEE]:  'הכבאי',
  [STEP.COMMANDER]: 'ראש המשמרת',
  [STEP.STATION]:   'מפקד התחנה'
};

export function stepLabel(step) { return LABEL[step] || step; }

// ---------------------------------------------------------------
//  אילו שלבים נדרשים למסמך מסוים
// ---------------------------------------------------------------
//
// doc מקבל את המסמך עצמו, כדי שההחלטה תילקח מהתוכן ולא
// מהניחוש של המסך. טופס חופשה יודע בעצמו אם הוא לחו"ל.

export function requiredSteps(kind, docData) {
  const d = docData || {};

  switch (kind) {
    // דוח השעות החודשי. הכבאי מאשר את מה שדיווח, ראש
    // המשמרת מאשר שזה מה שהיה בפועל.
    case 'monthly_report':
      return [STEP.EMPLOYEE, STEP.COMMANDER];

    // אי-החתמת כרטיס. הכבאי מצהיר, ראש המשמרת מאשר.
    case 'missed_punch':
      return [STEP.EMPLOYEE, STEP.COMMANDER];

    // מסירת אחריות בחפיפה. שני הצדדים חותמים, ואין מעליהם
    // דרגה — החפיפה היא בין שני אנשים, לא בקשה לאישור.
    case 'handover':
      return [STEP.EMPLOYEE, STEP.COMMANDER];

    // בקשת חופשה. כאן נמצא החריג.
    case 'vacation':
      return isAbroad(d)
        ? [STEP.EMPLOYEE, STEP.COMMANDER, STEP.STATION]
        : [STEP.EMPLOYEE, STEP.COMMANDER];

    // כל טופס אחר.
    default:
      return [STEP.EMPLOYEE, STEP.COMMANDER];
  }
}

// זיהוי חופשה בחו"ל.
//
// השדה where מגיע מהטופס, והוא גם מה שמזין את קריאת הפתע:
// מי שבחופשה מחוץ לאילת אינו מוזעק. כאן בודקים את הדרגה
// שמעליה — מחוץ לארץ.
export function isAbroad(d) {
  if (!d) return false;
  if (d.abroad === true) return true;
  const t = String(d.where || d.location || (d.values && d.values.where) || '');
  return /חו"ל|חו״ל|חול\b|בחו|abroad|overseas/i.test(t);
}

// ---------------------------------------------------------------
//  מצב החתימות של מסמך
// ---------------------------------------------------------------

export function signState(kind, docData) {
  const d = docData || {};
  const signs = d.signatures || {};
  const need = requiredSteps(kind, d);
  const doneSteps = need.filter(s => signs[s] && signs[s].image);
  const next = need.find(s => !(signs[s] && signs[s].image)) || null;

  return {
    required: need,
    done: doneSteps,
    next: next,
    complete: next === null,
    // טקסט לתצוגה. "ממתין לחתימת ראש המשמרת" מובן יותר
    // מ-"1/2", ובמסך שהכבאי פותח פעם בחודש זה מה שחשוב.
    label: next === null
      ? 'חתום · ' + doneSteps.length + ' מתוך ' + need.length
      : 'ממתין לחתימת ' + LABEL[next]
  };
}

// ---------------------------------------------------------------
//  האם המשתמש הנוכחי רשאי לחתום עכשיו
// ---------------------------------------------------------------
//
// me = { uid, role, shift, emp }
// מחזיר אובייקט ולא בוליאני, כדי שהמסך יוכל להסביר למה לא.

export function canSign(kind, docData, me) {
  const st = signState(kind, docData);
  if (st.complete) return { allowed: false, why: 'המסמך כבר חתום במלואו.' };

  const step = st.next;
  const isSuper = me.role === 'super' || me.super === true;
  const isOwner = docData && (docData.by_uid === me.uid ||
                              docData.emp_number === me.emp);

  if (step === STEP.EMPLOYEE) {
    if (isOwner) return { allowed: true, step: step, onBehalf: false };

    // ראש משמרת חותם במקום כבאי שלא חתם. מותר, ונרשם.
    if (isSuper || mayCommand(me, docData)) {
      return {
        allowed: true, step: step, onBehalf: true,
        warn: 'הכבאי טרם חתם. חתימה כאן תירשם כחתימה בשמו, ' +
              'עם שמך ועם הסיבה.'
      };
    }
    return { allowed: false, why: 'ממתין לחתימת הכבאי עצמו.' };
  }

  if (step === STEP.COMMANDER) {
    if (isSuper || mayCommand(me, docData)) {
      // מפקד אינו מאשר לעצמו. אם הוא הגיש את הבקשה, היא
      // עולה למפקד התחנה — אחרת אין כאן ביקורת בכלל.
      if (isOwner && !isSuper) {
        return { allowed: false,
                 why: 'אינך יכול לאשר בקשה שהגשת בעצמך. ' +
                      'הבקשה ממתינה למפקד התחנה.' };
      }
      return { allowed: true, step: step, onBehalf: false };
    }
    return { allowed: false, why: 'ממתין לחתימת ראש המשמרת.' };
  }

  if (step === STEP.STATION) {
    if (isSuper || me.role === 'station_commander') {
      return { allowed: true, step: step, onBehalf: false };
    }
    return { allowed: false,
             why: 'חופשה בחו"ל דורשת את אישור מפקד התחנה.' };
  }

  return { allowed: false, why: 'שלב לא מוכר.' };
}

// ראש משמרת, סגנו, או מפקד תחנה — ונעולים למשמרת של המסמך.
// מפקד תחנה ורכז כוח אדם אינם נעולים, בדיוק כמו בכל שאר
// המערכת.
function mayCommand(me, docData) {
  const r = me.role;
  if (r === 'station_commander' || r === 'hr_coordinator') return true;
  if (r !== 'commander' && r !== 'deputy') return false;

  const crew = (docData && (docData.crew || docData.shift)) || '';
  // בלי שיוך משמרת — לא ננעל. אותו כלל בדיוק כמו ב-seesCrewData,
  // ומאותה סיבה: מפקד שטרם שויך היה חסום מהכול בלי לדעת למה.
  if (!me.shift || !crew) return true;
  return me.shift === crew;
}

// ---------------------------------------------------------------
//  האם המסמך נעול לעריכה
// ---------------------------------------------------------------
//
// ברגע שחתימה אחת נכנסה, התוכן קפוא. אחרת אפשר היה לחתום
// על מסמך אחד ולהחליף אותו במסמך אחר — וזה מרוקן את החתימה
// מכל משמעות.

export function isLocked(docData) {
  const s = (docData && docData.signatures) || {};
  return Object.keys(s).some(k => s[k] && s[k].image);
}

// ---------------------------------------------------------------
//  בניית רשומת חתימה למסמך
// ---------------------------------------------------------------
//
// זה מה שנכתב לתוך המסמך החתום. השדות קבועים בכוונה, כדי
// שכל מסמך במערכת ייחתם באותו מבנה ואפשר יהיה להציג אותם
// באותו רכיב.

export function signatureRecord(image, who, extra) {
  const r = {
    image: image,
    uid: who.uid,
    name: who.full_name || '',
    emp: who.emp_number || '',
    role: who.role || '',
    at: new Date().toISOString()
  };
  // חתימה בשם אדם אחר. ראש משמרת רשאי לחתום במקום כבאי
  // שלא חתם עד סוף החודש — אבל לעולם לא בשקט: הרשומה
  // אומרת מי חתם באמת, ובשם מי.
  if (extra && extra.on_behalf_of) {
    r.on_behalf_of = extra.on_behalf_of;
    r.on_behalf_name = extra.on_behalf_name || '';
    r.reason = extra.reason || '';
  }
  return r;
}
