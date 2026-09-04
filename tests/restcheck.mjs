// חוק 48 השעות — בדיקת הלוגיקה של השרת.
//
// הפונקציות ב-functions/index.js הן CommonJS ולא נטענות
// בדפדפן, ולכן אי אפשר לבדוק אותן בהארנס הרגיל. כאן הן
// נחלצות מהקובץ ונבדקות ישירות מול המקרים שאלדד הגדיר.
import fs from 'fs';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');


const src = fs.readFileSync(__j(__APP, 'functions/index.js'), 'utf8');

// חילוץ הפונקציות. `sched` הוא כבר לא מחזור+חריגים אלא תשובת הסידור
// האפקטיבי: `works(uid, key)` → true · false · 'unknown'. כאן היא
// נבנית מסבב 1-מתוך-3 כמו קודם, כדי שהמקרים של אלדד יישארו זהים —
// והלא-ידוע נבדק בנפרד.
const grab = name => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
};

const mod = [grab('keyPlus'), grab('keyOffset'), grab('worksAfterSwap'), grab('restBreaks'),
             grab('swapScheduleRange')].join('\n\n');
const f = new Function(mod + '\nreturn { keyPlus, keyOffset, worksAfterSwap, restBreaks, swapScheduleRange };')();

let bad = 0;
const ck = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log((ok ? '✓ ' : '✗ ') + what + ': ' + JSON.stringify(got) +
              (ok ? '' : '  — ציפיתי ' + JSON.stringify(want)));
};

// סבב 1-מתוך-3, עוגן 2026-08-01 = משמרת A. u1 ב-B, u2 ב-A (כמו המקרים המקוריים).
const CREW_OF = { u1: 'B', u2: 'A' };
function crewOn(key) {
  const p = key.split('-').map(Number);
  const diff = Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(2026, 7, 1)) / 86400000);
  return ['A', 'B', 'C'][((diff % 3) + 3) % 3];
}
function schedFor(crews, unknownDates) {
  const unknown = new Set(unknownDates || []);
  return {
    mode: 'off', source: 'legacy', fallback: null,
    works(uid, key) {
      if (unknown.has(key)) return 'unknown';
      if (!Object.prototype.hasOwnProperty.call(crews, uid)) return 'unknown';
      return crewOn(key) === crews[uid];
    }
  };
}
const sched = schedFor(CREW_OF);

ck('תאריך +1', f.keyPlus('2026-08-31', 1), '2026-09-01');
ck('תאריך -1', f.keyPlus('2026-09-01', -1), '2026-08-31');
ck('מעבר שנה',  f.keyPlus('2026-12-31', 1), '2027-01-01');
ck('טווח הקריאה: יום מכל צד', f.swapScheduleRange({ from_date: '2026-08-13', to_date: '2026-08-02' }),
   { from: '2026-08-01', to: '2026-08-14' });
ck('טווח הקריאה בלי תאריכים', f.swapScheduleRange({}), null);

// A עובד 1,4,7,10… B עובד 2,5,8…
// אלדד: "אם משמרת א עבדה בראשון, מי שעבד לא יכול לעבוד בשני."
// החלפה שנותנת לאיש של A את ה-2 באוגוסט — צמוד ל-1 שהוא עובד.
const illegal = {
  from_uid:'u1', from_name:'דני', from_date:'2026-08-02',
  to_uid:'u2',   to_name:'רון',  to_date:'2026-08-13'
};
const r1 = f.restBreaks(sched, [], illegal);
ck('החלפה לא חוקית מזוהה', r1.length > 0, true);
ck('ההתנגשות אינה „לא ידוע"', r1.every(x => !x.unknown), true);
console.log('   ' + r1.map(x => x.who + ': ' + x.gain + ' צמוד ל-' + x.clash).join(' | '));

// החלפה חוקית: כל צד מוותר על המשמרת הצמודה — הזזה של יום אחד.
// (כאן u1 ב-A ו-u2 ב-B, כמו במקרה המקורי.)
const legal = {
  from_uid:'u1', from_name:'דני', from_date:'2026-08-04',
  to_uid:'u2',   to_name:'רון',  to_date:'2026-08-05'
};
const r2 = f.restBreaks(schedFor({ u1: 'A', u2: 'B' }), [], legal);
ck('הזזה ביום אחד — חוקית', r2.length, 0);

// אותה החלפה, אבל לאדם כבר יש החלפה מאושרת שנתנה לו את היום
// הצמוד. חייב להיתפס.
const prior = [{ status:'approved', from_uid:'x', from_date:'2026-08-09',
                 to_uid:'u1', to_date:'2026-08-06' }];
const r3 = f.restBreaks(schedFor({ u1: 'A', u2: 'B' }), prior, {
  from_uid:'u2', from_name:'רון', from_date:'2026-08-11',
  to_uid:'u1',   to_name:'דני',  to_date:'2026-08-05'
});
ck('החלפה קודמת נלקחת בחשבון', r3.length > 0, true);

// ויתור על היום הצמוד מנטרל את ההתנגשות
ck('ויתור על הצמוד מנקה',
   f.worksAfterSwap(schedFor({ u1: 'A', u2: 'B' }), [], 'u1', '2026-08-04', '2026-08-05', '2026-08-04'),
   false);

// ⭐ לא-ידוע אינו „פנוי": יום צמוד מחוץ לכיסוי הסידור → דיווח unknown,
// והצד השני (ידוע ופנוי) לא מדווח. אדם שאינו בסגל הסידור — גם לא-ידוע.
const r4 = f.restBreaks(schedFor({ u1: 'A', u2: 'B' }, ['2026-08-06']), [], legal);
ck('יום צמוד לא ידוע — מדווח כ-unknown ולא כחוקי', r4, [{ who: 'דני', gain: '2026-08-05', clash: '2026-08-06', unknown: true }]);
ck('worksAfterSwap ליום לא ידוע', f.worksAfterSwap(schedFor({ u1: 'A' }, ['2026-08-06']), [], 'u1', '2026-08-06', '2026-08-05', null), 'unknown');
ck('אדם שאינו בסגל — לא ידוע, לא false', f.worksAfterSwap(schedFor({}), [], 'zz', '2026-08-06', null, null), 'unknown');
// ויתור/קבלה מפורשים גוברים גם על לא-ידוע.
ck('היום שמוותרים עליו הוא false גם אם לא ידוע', f.worksAfterSwap(schedFor({}, ['2026-08-04']), [], 'u1', '2026-08-04', '2026-08-05', '2026-08-04'), false);

console.log('\n' + (bad ? bad + ' כשלים בחוק המנוחה' : 'חוק 48 השעות נאכף כמצופה'));
process.exit(bad ? 1 : 0);
