
// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f, pathToFileURL } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');
// כללי העסק — לא עיצוב, לא DOM. המספרים שאלדד אישר, והכללים
// שנלמדו מהמערכת שרצה בשטח. כל שינוי כאן חייב להיות החלטה,
// לא תופעת לוואי.
// ייבוא דינמי, לא סטטי: הנתיב נגזר ממיקום הקובץ בזמן ריצה,
// ו-import סטטי אינו יכול לקבל ביטוי. פותר את התלות בנתיב
// מוחלט, שבגללה הבדיקות רצו רק במחשב אחד.
const __u = (f) => pathToFileURL(__j(__APP, f)).href;
const H = await import(__u('hours.js'));
const R = await import(__u('rotation.js'));
const G = await import(__u('guards.js'));
const F = await import(__u('forms.js'));



let bad = 0;
function is(name, got, want){
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log((ok ? '✓' : '✗') + ' ' + name + ' → ' + JSON.stringify(got) +
              (ok ? '' : '   ציפיתי ' + JSON.stringify(want)));
}

console.log('--- שעות ---');
is('משמרת מלאה 07:00→07:00',  H.calcHours({day_type:'regular',start:'07:00',end:'07:00'}), 24);
is('חצי משמרת 07:00→19:00',   H.calcHours({day_type:'regular',start:'07:00',end:'19:00'}), 12);
is('חציית חצות 19:00→07:00',  H.calcHours({day_type:'regular',start:'19:00',end:'07:00'}), 12);
is('יטבתה 07:00→08:00 = 25',  H.calcHours({day_type:'regular',start:'07:00',end:'08:00'}, 25), 25);
is('בלי יטבתה 07:00→08:00',   H.calcHours({day_type:'regular',start:'07:00',end:'08:00'}, 0), 1);
is('חופש = 24',               H.calcHours({day_type:'vacation'}), 24);
is('מחלה = 0',                H.calcHours({day_type:'sick'}), 0);
is('מילואים = 8.5',           H.calcHours({day_type:'reserve'}), 8.5);
is('מילואים מתעלם משעות',     H.calcHours({day_type:'reserve',start:'07:00',end:'19:00'}), 8.5);
is('חופש מתעלם מתחנת קצה',    H.calcHours({day_type:'vacation'}, 25), 24);
is('החלפה נספרת כרגיל',       H.calcHours({day_type:'swap',start:'07:00',end:'07:00'}), 24);
is('בלי שעות = null',         H.calcHours({day_type:'regular'}), null);
is('שעה לא חוקית = null',     H.calcHours({day_type:'regular',start:'99:99',end:'07:00'}), null);

console.log('--- צורת המשמרת ---');
// כניסה 07:00 ויציאה 09:00 היא שעתיים או 26 שעות. רק הצורה מבדילה.
is('רגילה 07:00→09:00',    H.calcHours({day_type:'regular',shape:'regular',start:'07:00',end:'09:00',end_day:0}), 2);
is('המשך 07:00→09:00',     H.calcHours({day_type:'regular',shape:'continued',start:'07:00',end:'09:00',end_day:1}), 26);
is('רגילה חוצה חצות',      H.calcHours({day_type:'regular',start:'19:00',end:'07:00',end_day:1}), 12);
is('מפוצלת 6+6',           H.calcHours({day_type:'regular',start:'07:00',end:'13:00',end_day:0,start2:'17:00',end2:'23:00',end_day2:0}), 12);
is('מפוצלת קטע שני חסר',   H.calcHours({day_type:'regular',start:'07:00',end:'13:00',end_day:0,start2:'17:00',end2:'זז',end_day2:0}), null);
is('יטבתה גוברת על פיצול', H.calcHours({day_type:'regular',start:'07:00',end:'13:00',start2:'17:00',end2:'23:00'}, 25), 25);
is('זיהוי צורה: המשך',      H.shapeOf({start:'07:00',end:'09:00',end_day:1}), 'continued');
is('זיהוי צורה: מפוצלת',    H.shapeOf({start:'07:00',end:'13:00',start2:'17:00',end2:'23:00'}), 'split');
is('זיהוי צורה: רגילה',     H.shapeOf({start:'07:00',end:'07:00',end_day:1}), 'regular');

console.log('--- שעות נוספות ונימוק ---');
const OT = {day_type:'regular',shape:'continued',start:'07:00',end:'09:00',end_day:1};
is('26 מול 24 = 2 נוספות',  H.overtimeHours(OT, 0, 24), 2);
is('יטבתה 25 אינה נוספת',   H.overtimeHours({day_type:'regular',start:'07:00',end:'08:00'}, 25, 24), 0);
is('חופש אינו נוסף',        H.overtimeHours({day_type:'vacation'}, 0, 24), 0);
is('בדיוק 24 אינו נוסף',    H.overtimeHours({day_type:'regular',start:'07:00',end:'07:00'}, 0, 24), 0);
is('מפוצלת 26 = 2 נוספות',  H.overtimeHours({day_type:'regular',start:'07:00',end:'07:00',end_day:1,start2:'08:00',end2:'10:00',end_day2:0}, 0, 24), 2);
is('בלי נימוק — חוסם',      H.reasonMissing(OT, 0, 24), true);
is('עם נימוק — עובר',       H.reasonMissing(Object.assign({overtime_reason:'שריפה'}, OT), 0, 24), false);
is('בלי נוספות — לא נדרש',  H.reasonMissing({day_type:'regular',start:'07:00',end:'07:00'}, 0, 24), false);

console.log('--- מתי נדרש נימוק ---');
is('יטבתה 25 קבועות',      H.reasonWhy({day_type:'regular',start:'07:00',end:'08:00'}, 25, 24), '');
is('רגיל 24',              H.reasonWhy({day_type:'regular',start:'07:00',end:'07:00'}, 0, 24), '');
is('חופש',                 H.reasonWhy({day_type:'vacation'}, 0, 24), '');
is('מילואים',              H.reasonWhy({day_type:'reserve'}, 0, 24), '');
is('המשך משמרת',           H.reasonWhy({day_type:'regular',shape:'continued',start:'07:00',end:'09:00',end_day:1}, 0, 24), 'המשך משמרת');
is('החלפה צרכי מערכת',     H.reasonWhy({day_type:'swap',start:'07:00',end:'07:00'}, 0, 24), 'החלפה צרכי מערכת');
is('נע״ת',                 H.reasonWhy({day_type:'extra',start:'08:00',end:'15:00',end_day:0}, 0, 24), 'שעות ידני · נע״ת');
is('ישיבות',               H.reasonWhy({day_type:'meeting',start:'09:00',end:'11:00',end_day:0}, 0, 24), 'ישיבות');
is('מפוצלת 26',            H.reasonWhy({day_type:'regular',start:'07:00',end:'07:00',end_day:1,start2:'08:00',end2:'10:00',end_day2:0}, 0, 24), '2 שעות מעל המשמרת');
is('נע״ת בלי נימוק חוסם',  H.reasonMissing({day_type:'extra',start:'08:00',end:'15:00',end_day:0}, 0, 24), true);
is('נע״ת עם נימוק עובר',   H.reasonMissing({day_type:'extra',start:'08:00',end:'15:00',end_day:0,overtime_reason:'השתלמות'}, 0, 24), false);

console.log('--- סיכום חודשי ---');
const SUM = H.monthSummary([
  {date:'2026-08-01', day_type:'regular',  start:'07:00', end:'07:00'},
  {date:'2026-08-04', day_type:'regular',  start:'07:00', end:'08:00', sub_station:'yotvata'},
  {date:'2026-08-07', day_type:'vacation'},
  {date:'2026-08-10', day_type:'reserve'},
  {date:'2026-08-13', day_type:'regular',  start:'07:00', end:'13:00', end_day:0,
                      start2:'17:00', end2:'23:00', end_day2:0},
  {date:'2026-08-16', day_type:'regular',  start:'07:00', end:'09:00', end_day:1,
                      overtime_reason:'שריפה בשחמון'},
  {date:'2026-08-19', day_type:'regular',  start:'07:00', end:'10:00', end_day:1}
], id => id === 'yotvata' ? 25 : 0, () => 24);
is('סך שעות',              SUM.hours, 146.5);
is('ימים',                 SUM.days, 7);
is('מפוצלות',              SUM.split, 1);
is('שעות נוספות',          SUM.overtimeHours, 5);
is('ימים בלי נימוק',       SUM.unexplained.length, 1);
is('היום בלי הנימוק',      SUM.unexplained[0].date, '2026-08-19');

console.log('--- סך חודשי ---');
is('סך עם יטבתה', H.monthTotal([
  {day_type:'regular', start:'07:00', end:'07:00', sub_station:''},
  {day_type:'regular', start:'07:00', end:'08:00', sub_station:'yotvata'},
  {day_type:'vacation'}, {day_type:'sick'}, {day_type:'reserve'}
], id => id === 'yotvata' ? 25 : 0), 81.5);

console.log('--- מחזור וחריגות ---');
const rot = [
  {crew:'A', position_in_cycle:0, cycle_days:3, anchor_date:'2026-01-01', is_active:true},
  {crew:'B', position_in_cycle:1, cycle_days:3, anchor_date:'2026-01-01', is_active:true},
  {crew:'C', position_in_cycle:2, cycle_days:3, anchor_date:'2026-01-01', is_active:true}
];
const d = new Date(2026, 7, 22);
is('מחזור רגיל',            R.crewOnDate(rot, d), 'C');
is('החלפה גוברת',           R.crewOnDate(rot, d, {'2026-08-22':{kind:'swap',crew:'A'}}), 'A');
is('חג לא משנה מי עובד',    R.crewOnDate(rot, d, {'2026-08-22':{kind:'holiday',crew:''}}), 'C');
const standby = {'2026-08-22':{kind:'standby',crew:'',extra_crews:['B']}};
is('כוננות — B עובדת',       R.isCrewWorking(rot,'B',d,standby), true);
is('כוננות — C עדיין עובדת', R.isCrewWorking(rot,'C',d,standby), true);
is('כוננות — A לא עובדת',    R.isCrewWorking(rot,'A',d,standby), false);
is('בלי מחזור אין משמרת',    R.crewOnDate([], d), null);
is('חריגה גוברת גם בלי מחזור', R.crewOnDate([], d, {'2026-08-22':{kind:'swap',crew:'B'}}), 'B');

console.log('--- החלפות מאושרות ---');
const SW = [{ status:'approved', from_uid:'u1', from_crew:'C', from_date:'2026-08-01',
              to_uid:'u2', to_crew:'A', to_date:'2026-08-02' }];
const s1 = new Date(2026,7,1), s2 = new Date(2026,7,2);
is('היוצא לא עובד ביום שלו',   R.personWorks(rot,'C',s1,null,SW,'u1'), false);
is('הנכנס עובד ביום ההוא',     R.personWorks(rot,'A',s1,null,SW,'u2'), true);
is('הנכנס לא עובד ביום שלו',   R.personWorks(rot,'A',s2,null,SW,'u2'), false);
is('היוצא עובד ביום השני',     R.personWorks(rot,'C',s2,null,SW,'u1'), true);
is('מי שלא מעורב לא מושפע',    R.personWorks(rot,'C',s1,null,SW,'u9'),
   R.isCrewWorking(rot,'C',s1));
is('החלפה לא מאושרת מתעלמים',  R.personWorks(rot,'C',s1,null,
   [{status:'cmd_to',from_uid:'u1',from_date:'2026-08-01',to_uid:'u2',to_date:'2026-08-02'}],'u1'),
   R.isCrewWorking(rot,'C',s1));


// ---------- 48 שעות רצוף ----------
//
// כבאי לא עובד שתי משמרות בימים צמודים. הסבב הרגיל לא מייצר
// את זה; החלפה כן יכולה, וזה מה שנבדק כאן.
console.log('\n--- מנוחה בין משמרות');

is('יום אחרי',   R.addDays('2026-08-01', 1),  '2026-08-02');
is('יום לפני',   R.addDays('2026-08-01', -1), '2026-07-31');
is('חוצה חודש',  R.addDays('2026-08-31', 1),  '2026-09-01');

// הסבב מהמבחן למעלה: משמרת C עובדת ב-1.8, לא ב-2.8, ושוב ב-4.8.
const rotWorks = k => R.isCrewWorking(rot, 'C', R.fromKey(k));
is('1.8 משמרת C עובדת',   rotWorks('2026-08-01'), true);
is('2.8 משמרת C לא עובדת', rotWorks('2026-08-02'), false);

// כניסה ל-2.8 צמודה ל-1.8 שהוא כבר עובד → הפרה.
is('כניסה ליום צמוד = הפרה',
   R.restConflicts(rot, 'C', null, [], 'u1', '2026-08-02', '').length > 0, true);

// אבל אם הוא יוצא מ-1.8 באותה החלפה, אין הצמדה.
is('יציאה מהיום הצמוד מנטרלת',
   R.restConflicts(rot, 'C', null, [], 'u1', '2026-08-02', '2026-08-01'), []);

// התוצאה שאינה מובנת מאליה, ולכן היא נעולה כאן:
//
// בסבב של שלוש משמרות אדם עובד כל יום שלישי. לכן **כל** יום
// פנוי שלו צמוד ליום עבודה שלו — אין אף יום פנוי באמצע.
// המסקנה: החלפה חוקית מחייבת שהיום שהוא מוותר עליו יהיה
// דווקא היום הצמוד. אי אפשר "לקחת יום רחוק" ולהישאר תקין.
is('יום רחוק גם הוא צמוד — כך בנוי סבב 1 מתוך 3',
   R.restConflicts(rot, 'C', null, [], 'u1', '2026-08-20', '2026-08-01').length > 0,
   true);
is('ויתור על היום הצמוד מכשיר את ההחלפה',
   R.restConflicts(rot, 'C', null, [], 'u1', '2026-08-20', '2026-08-19'), []);

// הדוגמה של אלדד, מילה במילה:
// "אם משמרת א עבדה בראשון לחודש, כל מי שעבד לא יכול לעבוד
//  בשני לחודש. אם הוא עבד 24 שעות הוא לא יכול להמשיך ל-24
//  שעות נוספות ולסך של 48."
{
  // מוצאים יום שמשמרת א' עובדת בו, ובודקים את יום המחרת.
  let d1 = '';
  for (let i = 1; i <= 5; i++) {
    const k = '2026-09-0' + i;
    if (R.isCrewWorking(rot, 'A', R.fromKey(k))) { d1 = k; break; }
  }
  const d2 = R.addDays(d1, 1);
  is('משמרת א עובדת ב-' + d1, R.isCrewWorking(rot, 'A', R.fromKey(d1)), true);
  is('ולא עובדת למחרת',        R.isCrewWorking(rot, 'A', R.fromKey(d2)), false);
  is('אבל אסור לה להיכנס למחרת — 48 שעות',
     R.restConflicts(rot, 'A', null, [], 'u7', d2, '').length > 0, true);
  is('אלא אם היא מוותרת על היום הראשון',
     R.restConflicts(rot, 'A', null, [], 'u7', d2, d1), []);
}

// בדיקת שני צדדים.
const RC = R.swapRestCheck(rot, null, [],
  { uid:'u1', crew:'C', name:'אלדד', gain:'2026-08-02', lose:'2026-08-04' },
  { uid:'u2', crew:'A', name:'טל',   gain:'2026-08-04', lose:'2026-08-02' });
is('צד מפר מזוהה בשמו', RC.length > 0 && RC[0].name, 'אלדד');
is('ההסבר מזכיר 48 שעות',
   /48 שעות/.test(R.restWhy(RC[0])), true);

// החלפה חוקית: כל צד לוקח יום צמוד ליום שלו ומוותר עליו.
// C עובד 19.8, A עובד 20.8 — הם מחליפים ביניהם.
is('החלפה בין משמרות שכנות נקייה',
   R.swapRestCheck(rot, null, [],
     { uid:'u1', crew:'C', name:'א', gain:'2026-08-20', lose:'2026-08-19' },
     { uid:'u2', crew:'A', name:'ב', gain:'2026-08-19', lose:'2026-08-20' }
   ).length, 0);

// ---------- אבטחות ----------
console.log('\n--- אבטחות');

is('שעות אבטחה 18:00→23:00',  G.guardHours({start:'18:00',end:'23:00'}), 5);
is('אבטחה חוצה חצות 20:00→01:00', G.guardHours({start:'20:00',end:'01:00'}), 5);
is('בלי שעות = null',          G.guardHours({}), null);

is('חפיפה מלאה',      G.overlaps({start:'18:00',end:'23:00'},{start:'19:00',end:'20:00'}), true);
is('בלי חפיפה',       G.overlaps({start:'08:00',end:'12:00'},{start:'13:00',end:'16:00'}), false);
is('נגיעה בקצה אינה חפיפה', G.overlaps({start:'08:00',end:'12:00'},{start:'12:00',end:'16:00'}), false);
is('חפיפה מעבר לחצות', G.overlaps({start:'20:00',end:'01:00'},{start:'23:00',end:'03:00'}), true);
// עדין: שתיהן באותו תאריך, אבל הראשונה גולשת ללילה שאחרי
// והשנייה מתחילה בבוקר של אותו יום. אין ביניהן חפיפה, וקל
// לכתוב קוד שיחשוב שיש.
is('לילה־אחרי מול בוקר אינם חופפים',
   G.overlaps({start:'20:00',end:'01:00'},{start:'00:00',end:'02:00'}), false);

// סבב: משמרת C עובדת ב-1.8.2026 ולא ב-2.8.2026 (אותו סבב שבמבחן למעלה)
const gctx = { rotations: rot, overrides: null, swaps: [], guards: [] };
is('אבטחה ביום משמרת = בתוך המשמרת',
   G.dutyKind(gctx, 'u1', 'C', '2026-08-01'), 'shift');
is('אבטחה ביום שאינו משמרת = יום חופש',
   G.dutyKind(gctx, 'u1', 'C', '2026-08-02'), 'off');
is('בלי משמרת אין ידיעה — נחשב חופש',
   G.dutyKind(gctx, 'u1', '', '2026-08-01'), 'off');

// ספירת עומס: שתי אבטחות לאותו אדם, אחת במשמרת ואחת בחופש.
const PPL = [{uid:'u1',name:'אלדד',crew:'C'},
             {uid:'u2',name:'טל',  crew:'C'},
             {uid:'u3',name:'דנה', crew:'C'}];
const GG = [
  {id:'a', date:'2026-08-01', start:'18:00', end:'23:00', slots:2,
   assigned:['u1','u2'], status:'staffed'},              // יום משמרת
  {id:'b', date:'2026-08-02', start:'08:00', end:'12:00', slots:1,
   assigned:['u1'], status:'staffed'},                    // יום חופש
  {id:'c', date:'2026-08-04', start:'08:00', end:'12:00', slots:1,
   assigned:['u2'], status:'cancelled'}                   // מבוטלת — לא נספרת
];
const LM = G.loadByPerson(PPL, GG, gctx, '');
is('u1 — אחת בחופש',        LM.u1.off, 1);
is('u1 — אחת במשמרת',       LM.u1.shift, 1);
is('u1 — סך הכל שתיים',     LM.u1.total, 2);
is('u1 — שעות רק מהחופש',   LM.u1.hours, 4);
is('u2 — רק במשמרת',        [LM.u2.off, LM.u2.shift], [0, 1]);
is('אבטחה מבוטלת לא נספרת', LM.u2.total, 1);
is('u3 — לא יצא בכלל',      LM.u3.total, 0);
is('חלון תאריכים חותך',     G.loadByPerson(PPL, GG, gctx, '2026-08-02').u1.total, 1);

// דירוג: מי שלא יצא ביום חופש ראשון.
const RK = G.fairnessRank(LM);
is('ראשון בדירוג הוא מי שאין לו חופש', [RK[0].uid, RK[1].uid].sort(), ['u2','u3']);
is('אחרון בדירוג הוא מי שיצא בחופש',   RK[RK.length-1].uid, 'u1');

// המלצה: כשיש נרשמים — רק מהם.
const OPEN = {id:'z', date:'2026-08-02', start:'08:00', end:'12:00', slots:1,
              assigned:[], status:'open',
              signups:{ u1:{name:'אלדד'} }};
const REC1 = G.recommend(OPEN, PPL, LM, gctx, {}, {});
is('רק הנרשמים מוצעים',      REC1.map(r=>r.uid), ['u1']);
is('נרשם מסומן כנרשם',       REC1[0].signed, true);

// בלי נרשמים — כל הסגל, לפי הוגנות.
const OPEN2 = Object.assign({}, OPEN, {signups:{}});
const REC2 = G.recommend(OPEN2, PPL, LM, gctx, {}, {});
is('בלי נרשמים — כולם',      REC2.length, 3);
is('העמוס ביותר אחרון',      REC2[REC2.length-1].uid, 'u1');

// מי שכבר משובץ אינו מוצע שוב.
const OPEN3 = Object.assign({}, OPEN2, {assigned:['u2'], slots:2});
is('משובץ לא חוזר בהמלצה',
   G.recommend(OPEN3, PPL, LM, gctx, {}, {}).map(r=>r.uid).indexOf('u2'), -1);

// חסימה: מי שבחופש מסומן ולא נבחר אוטומטית.
const BUSY = { '2026-08-02': { u3: 'בחופש' } };
const REC4 = G.recommend(OPEN2, PPL, LM, gctx, BUSY, {});
is('חסום יורד לתחתית',       REC4[REC4.length-1].uid, 'u3');
is('חסום מסומן חסום',        REC4[REC4.length-1].blocked, true);
is('בחירה אוטומטית מדלגת על חסום', G.autoPick(OPEN2, REC4).indexOf('u3'), -1);
is('בחירה אוטומטית לפי מקומות',    G.autoPick(OPEN2, REC4).length, 1);

// כשירות חסרה — לא חוסמת אבל יורדת בדירוג ולא נבחרת אוטומטית.
const NEEDQ = Object.assign({}, OPEN2, {need_quals:['q1'], slots:3});
const REC5 = G.recommend(NEEDQ, PPL, LM, gctx, {}, {needQuals:['q1'],
              memberQuals:{ u3:['q1'] }});
is('בעל הכשירות ראשון',      REC5[0].uid, 'u3');
is('חסר כשירות מסומן',       REC5[1].missingQuals, ['q1']);
is('אוטומטי לא בוחר חסר כשירות', G.autoPick(NEEDQ, REC5), ['u3']);

// לוג: שורה לכל יציאה, לא לכל אבטחה.
is('לוג — שלוש יציאות משתי אבטחות', G.logRows(GG, PPL, gctx).length, 3);


// ---------- טפסים ----------
console.log('\n--- טפסים');

is('טווח של יום אחד',   F.daysInRange('2026-09-01','2026-09-01').length, 1);
is('טווח של ארבעה ימים', F.daysInRange('2026-09-01','2026-09-04').length, 4);
is('טווח חוצה חודש',    F.daysInRange('2026-08-30','2026-09-02').length, 4);
is('טווח הפוך = ריק',   F.daysInRange('2026-09-04','2026-09-01'), []);

// זמינות להזעקה. זו כל הסיבה שאנחנו שואלים איפה הוא.
is('באילת — ניתן להזעקה', F.callableWhileAway('באילת'), true);
is('בארץ — לא',           F.callableWhileAway('בארץ'), false);
is('בחו״ל — לא',          F.callableWhileAway('בחו״ל'), false);

// אימות
const LEAVE = F.formById(null, 'leave');
is('חסר תאריך = שגיאה',
   F.validate(LEAVE, { to:'2026-09-02', where:'באילת' }).length > 0, true);
is('סיום לפני התחלה = שגיאה',
   F.validate(LEAVE, { from:'2026-09-05', to:'2026-09-01', where:'באילת' })
    .some(x => /מוקדם/.test(x)), true);
is('בחירה לא מוכרת = שגיאה',
   F.validate(LEAVE, { from:'2026-09-01', to:'2026-09-02', where:'בירח' })
    .length > 0, true);
is('טופס תקין = בלי שגיאות',
   F.validate(LEAVE, { from:'2026-09-01', to:'2026-09-02', where:'באילת' }), []);

// מי בחופשה בתאריך — רק מאושרות נספרות.
const SUBS = [
  { form_id:'leave', status:'approved', by_uid:'u2', by_name:'טל',
    values:{ from:'2026-08-24', to:'2026-08-27', where:'בחו״ל' } },
  { form_id:'leave', status:'submitted', by_uid:'u4', by_name:'דנה',
    values:{ from:'2026-08-24', to:'2026-08-27', where:'באילת' } }
];
is('בתוך הטווח — מאושרת נספרת',
   Object.keys(F.awayOn(SUBS, '2026-08-25')), ['u2']);
is('מחוץ לטווח — אף אחד',
   Object.keys(F.awayOn(SUBS, '2026-08-30')), []);
is('בחו״ל מסומן כלא ניתן להזעקה',
   F.awayOn(SUBS, '2026-08-25').u2.callable, false);
is('בקשה שלא אושרה אינה נספרת',
   F.awayOn(SUBS, '2026-08-25').u4, undefined);

// דוח פציעה מסומן סגור בהגדרה, לא לפי בחירת המשתמש.
is('דוח פציעה סגור', !!F.formById(null,'injury').private, true);
is('בקשת חופשה אינה סגורה', !!F.formById(null,'leave').private, false);
is('דוח אי החתמה דורש חתימה', F.formById(null,'noclock').sign, true);
// שונה במכוון. כשהחתימה הייתה ציור באצבע בכל טופס מחדש,
// בקשת חופשה לא הצדיקה אותה. עכשיו החתימה שמורה והחתימה
// היא הקשה אחת — ובקשה חתומה היא בקשה שאי אפשר להתכחש לה.
is('בקשת חופשה נחתמת גם היא', F.formById(null,'leave').sign, true);
is('לחופשה יש שרשרת חתימות',  F.formById(null,'leave').kind, 'vacation');
is('ממתין למפקד התחנה נחשב פתוח',
   F.isPending({ status: 'pending_station' }), true);
is('מאושר אינו פתוח', F.isPending({ status: 'approved' }), false);

console.log(bad ? '\n' + bad + ' כשלים' : '\nכל כללי העסק תקינים');
process.exit(bad ? 1 : 0);
