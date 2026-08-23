// חישוב כשירות משמרת — מקור אמת אחד.
//
// שלושה מסכים שואלים את אותה שאלה: מסך הכשירויות ("האם המשמרת
// מעל הקו האדום"), מסך הציוות ("האם כל המשבצות מאוישות ומתאימות")
// וסידור העבודה ("איזה יום בחודש יוצא עם משמרת לא כשירה").
//
// כשהחישוב שוכפל לשלושה מקומות, שינוי בהגדרה תיקן מסך אחד והשאיר
// שניים עם תשובה אחרת — והמשתמש רואה שני מספרים סותרים על אותו
// נתון ולא יודע לאיזה להאמין.
//
// הקובץ הזה טהור בכוונה: הוא לא מכיר את Firebase ולא קורא כלום.
// כל מסך טוען את הנתונים בעצמו ומעביר אותם לכאן.

export const CREWS   = ['A', 'B', 'C'];
export const CREW_HE = { A: "א'", B: "ב'", C: "ג'" };

// אילו משמרות המשתמש אמור לראות.
//
// מפקד משמרת וכבאי — את שלהם בלבד. רכז כוח אדם ומנהל-על רואים
// הכל, כי תפקידם להשוות בין משמרות ולסדר ביניהן.
//
// מי שאין לו שיוך משמרת רואה הכל: אחרת הוא לא היה רואה כלום,
// ולא הייתה שום דרך להבין למה.
//
// חייב להיות זהה ל-seesShift() בכללי האבטחה. אם הם ייפרדו,
// המסך יציג משמרת שהשרת יחסום — וזה נראה כמו תקלה.
export function visibleCrews(claims) {
  const c = claims || {};
  const isSuper = c.super === true || c.role === 'super_admin';
  if (isSuper || c.role === 'hr_coordinator') return CREWS.slice();
  if (CREWS.indexOf(c.shift) !== -1) return [c.shift];
  return CREWS.slice();
}

// כל המשבצות של הלוח — שרשרת הפיקוד והרכבים יחד.
export function allSlots(board) {
  const b = board || {};
  const out = (b.command || []).map(function (c) {
    return { id: c.id, job: c.rank, req: c.req || '', where: 'פיקוד' };
  });
  (b.vehicles || []).forEach(function (v) {
    (v.slots || []).forEach(function (s) {
      out.push({ id: s.id, job: s.job, req: s.req || '', where: v.name });
    });
  });
  return out;
}

function holds(held, uid, qid) {
  return !qid || (((held || {})[uid]) || []).indexOf(qid) !== -1;
}

// ---------- קו אדום ----------
//
// people: [{uid, crew}]  ·  held: {uid: [qid]}
// redline: {min_headcount, min_quals:{qid:n}}
//
// configured=false פירושו שאף סף לא הוגדר. במצב הזה אסור להכריז
// "לא כשירה" — תחנה שרק נפתחה הייתה נצבעת אדומה לפני שמישהו
// הספיק להגדיר בה משהו, וזה מאמן את המשתמש להתעלם מהאדום.
export function redlineState(people, held, redline, crew) {
  const rl      = redline || {};
  const minHead = Number(rl.min_headcount || 0);
  const mins    = rl.min_quals || {};

  const crewPeople = (people || []).filter(function (p) { return p.crew === crew; });
  const head = crewPeople.length;
  const gaps = [];

  if (minHead > 0 && head < minHead) {
    gaps.push({ kind: 'head', have: head, need: minHead });
  }

  Object.keys(mins).forEach(function (qid) {
    const need = Number(mins[qid] || 0);
    if (need <= 0) return;
    const have = crewPeople.filter(function (p) {
      return holds(held, p.uid, qid);
    }).length;
    if (have < need) gaps.push({ kind: 'qual', qid: qid, have: have, need: need });
  });

  return {
    head: head, minHead: minHead, gaps: gaps,
    below: gaps.length > 0,
    configured: minHead > 0 || Object.keys(mins).length > 0
  };
}

// ---------- לוח הציוות ----------
//
// assign: {slotId: uid} של משמרת אחת.
export function boardState(board, assign, held) {
  const slots = allSlots(board);
  const a = assign || {};

  const open  = slots.filter(function (s) { return !a[s.id]; });
  const wrong = slots.filter(function (s) {
    return s.req && a[s.id] && !holds(held, a[s.id], s.req);
  });

  return {
    total: slots.length, open: open.length, wrong: wrong.length,
    openSlots: open, wrongSlots: wrong,
    below: open.length > 0 || wrong.length > 0,
    configured: slots.length > 0
  };
}

// ---------- שתיהן יחד ----------
//
// משמרת כשירה רק אם שתי הבדיקות עוברות. בדיקה שלא הוגדרה
// אינה מפילה — היא פשוט לא נשאלת.
export function crewReady(rl, bs) {
  const badRl = !!(rl && rl.configured && rl.below);
  const badBs = !!(bs && bs.configured && bs.below);
  return {
    ready: !badRl && !badBs,
    known: !!((rl && rl.configured) || (bs && bs.configured)),
    badRedline: badRl,
    badBoard: badBs
  };
}

// טקסט קצר לתצוגה. qualName מועבר מבחוץ כי שמות הכשירויות
// שייכים לתחנה ולא לקובץ הזה.
export function summaryText(rl, bs, qualName) {
  const name = qualName || function (id) { return id; };
  const parts = [];

  if (rl && rl.configured) {
    rl.gaps.forEach(function (g) {
      if (g.kind === 'head') {
        const miss = g.need - g.have;
        parts.push(miss === 1 ? 'חסר איש אחד' : 'חסרים ' + miss + ' אנשים');
      } else {
        parts.push(name(g.qid) + ' ' + g.have + '/' + g.need);
      }
    });
  }

  if (bs && bs.configured) {
    if (bs.open) {
      parts.push(bs.open === 1 ? 'משבצת אחת לא מאוישת'
                               : bs.open + ' משבצות לא מאוישות');
    }
    if (bs.wrong) {
      parts.push(bs.wrong === 1 ? 'שיבוץ אחד בלי הכשירות'
                                : bs.wrong + ' שיבוצים בלי הכשירות');
    }
  }

  return parts.join(' · ');
}


// ---------- ירידה מאושרת מתחת לקו האדום ----------
//
// אלדד: "כשירות תמיד לפי צרכי מערכת, לפעמים מאשרים לרדת מקו
// אדום." ההחלטה היא של ראש המשמרת — היא שלו, והוא זה שמכיר
// את המשמרת — אבל היא נכנסת לתוקף רק אחרי אישור מפקד התחנה.
//
// שני דברים שקבע במפורש:
//
//   בלי נימוק   ראש המשמרת קיבל את ההחלטה, היא שלו. לבקש
//               ממנו לנמק היה הופך אישור לטופס
//   למשמרת אחת  היתר נפתח על יום ומשמרת מסוימים ופג מעצמו.
//               היתר פתוח שנשכח משתיק את המערכת בדיוק כשהיא
//               אמורה לצעוק
//
// המצב אינו נשמר כשדה על המשמרת אלא נקרא מהוויתורים, מאותה
// סיבה שמצב רכב נגזר מהתקלות: אין מה לשכוח לבטל.

export const WAIVER_STATES = [
  { id: 'pending',  he: 'ממתין לאישור מפקד התחנה', color: '#e0a23c' },
  { id: 'approved', he: 'מאושר',                    color: '#66bb6a' },
  { id: 'rejected', he: 'נדחה',                     color: '#ef5350' }
];

export function waiverId(crew, dateKey) {
  return String(crew || '') + '_' + String(dateKey || '');
}

export function waiverOn(waivers, crew, dateKey) {
  const w = (waivers || {})[waiverId(crew, dateKey)];
  return w || null;
}

// האם המשמרת רשאית לעבוד מתחת לקו האדום ביום הזה.
export function waived(waivers, crew, dateKey) {
  const w = waiverOn(waivers, crew, dateKey);
  return !!(w && w.status === 'approved');
}

// המשפט שמופיע ליד הכשירות. שם המבקש ושם המאשר, כי היתר בלי
// שמות הוא היתר שאיש לא אחראי עליו.
export function waiverLine(w) {
  if (!w) return '';
  const by = w.by_name || 'ראש המשמרת';
  if (w.status === 'pending') {
    return by + ' ביקש היתר לעבוד מתחת לקו האדום. ממתין לאישור מפקד התחנה.';
  }
  if (w.status === 'approved') {
    return 'אושר לעבוד מתחת לקו האדום · ביקש ' + by +
           ' · אישר ' + (w.approved_by_name || 'מפקד התחנה') +
           '. תקף להיום בלבד.';
  }
  if (w.status === 'rejected') {
    return 'הבקשה נדחתה על ידי ' + (w.approved_by_name || 'מפקד התחנה') + '.';
  }
  return '';
}
