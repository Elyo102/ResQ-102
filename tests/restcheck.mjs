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

// חילוץ שלוש הפונקציות + isWorking/crewOnKey שהן נשענות עליהן
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

const mod = [grab('daysBetweenKeys'), grab('crewOnKey'), grab('isWorking'), grab('keyPlus'),
             grab('worksAfterSwap'), grab('restBreaks')].join('\n\n');
const f = new Function(mod + '\nreturn { keyPlus, worksAfterSwap, restBreaks };')();

let bad = 0;
const ck = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log((ok ? '✓ ' : '✗ ') + what + ': ' + JSON.stringify(got) +
              (ok ? '' : '  — ציפיתי ' + JSON.stringify(want)));
};

// סבב 1-מתוך-3, עוגן 2026-08-01 = משמרת A
const sched = {
  rotations: [
    { crew:'A', position_in_cycle:0, cycle_days:3, anchor_date:'2026-08-01', is_active:true },
    { crew:'B', position_in_cycle:1, cycle_days:3, anchor_date:'2026-08-01', is_active:true },
    { crew:'C', position_in_cycle:2, cycle_days:3, anchor_date:'2026-08-01', is_active:true }
  ],
  overrides: {}
};

ck('תאריך +1', f.keyPlus('2026-08-31', 1), '2026-09-01');
ck('תאריך -1', f.keyPlus('2026-09-01', -1), '2026-08-31');
ck('מעבר שנה',  f.keyPlus('2026-12-31', 1), '2027-01-01');

// A עובד 1,4,7,10… B עובד 2,5,8…
// אלדד: "אם משמרת א עבדה בראשון, מי שעבד לא יכול לעבוד בשני."
// החלפה שנותנת לאיש של A את ה-2 באוגוסט — צמוד ל-1 שהוא עובד.
const illegal = {
  from_uid:'u1', from_name:'דני', from_crew:'B', from_date:'2026-08-02',
  to_uid:'u2',   to_name:'רון',  to_crew:'A',   to_date:'2026-08-13'
};
const r1 = f.restBreaks(sched, [], illegal);
ck('החלפה לא חוקית מזוהה', r1.length > 0, true);
console.log('   ' + r1.map(x => x.who + ': ' + x.gain + ' צמוד ל-' + x.clash).join(' | '));

// החלפה חוקית: כל צד מוותר על המשמרת הצמודה — הזזה של יום אחד.
const legal = {
  from_uid:'u1', from_name:'דני', from_crew:'A', from_date:'2026-08-04',
  to_uid:'u2',   to_name:'רון',  to_crew:'B',   to_date:'2026-08-05'
};
const r2 = f.restBreaks(sched, [], legal);
ck('הזזה ביום אחד — חוקית', r2.length, 0);

// אותה החלפה, אבל לאדם כבר יש החלפה מאושרת שנתנה לו את היום
// הצמוד. חייב להיתפס.
const prior = [{ status:'approved', from_uid:'x', from_date:'2026-08-09',
                 to_uid:'u1', to_date:'2026-08-06' }];
const r3 = f.restBreaks(sched, prior, {
  from_uid:'u2', from_name:'רון', from_crew:'B', from_date:'2026-08-11',
  to_uid:'u1',   to_name:'דני',  to_crew:'A',   to_date:'2026-08-05'
});
ck('החלפה קודמת נלקחת בחשבון', r3.length > 0, true);

// ויתור על היום הצמוד מנטרל את ההתנגשות
ck('ויתור על הצמוד מנקה',
   f.worksAfterSwap(sched, [], 'u1', 'A', '2026-08-04', '2026-08-05', '2026-08-04'),
   false);

console.log('\n' + (bad ? bad + ' כשלים בחוק המנוחה' : 'חוק 48 השעות נאכף כמצופה'));
process.exit(bad ? 1 : 0);
