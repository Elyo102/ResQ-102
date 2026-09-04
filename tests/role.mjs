// בדיקת תפקידים: מוודאת שכל תפקיד רואה בדיוק את מה שמותר לו.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');


const ROOT=process.env.ROLE_ROOT||__APP, STUB=__j(__TESTS, "stub");
let PORT=0;
const T={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);
  if(p==='/')p='/index.html';const f=path.join(ROOT,p);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);r.end('no');return;}
  r.writeHead(200,{'Content-Type':T[path.extname(f)]||'text/plain'});r.end(fs.readFileSync(f));});
await new Promise(r=>srv.listen(0,r));
PORT=srv.address().port;

const EXPECT = {
  // quals: מה מסך הכשירויות אמור להראות.
  //   work   — המסך עצמו נפתח
  //   edit   — כלי העריכה (הוספה, שמירת קו אדום, כפתורי "ערוך")
  super:       { nav:['לוח מודעות','סידור','נוכחות','תקלות','טפסים','החלפות','חוות דעת','ציוות','אבטחות','חתימות','כשירויות','התראות','עובדים','בקרת שעות','גישה','ניהול','נתונים','קליטה','בדיקה'],
                 adminSees:['reqCard','usersCard'],
                 shadow:true,
                 quals:{ work:true, edit:true },
                 board:{ work:true, edit:true },
                 swaps:{ work:true, appr:true, pend:2 },
                 alerts:{ work:true, send:true, key:true, opts:4 },
                 callout:{ card:true, opts:5, pick:false },
                 guards:{ work:true, create:false },
                 faults:{ work:true, anchor:true, sev:true, grade:true },
                 forms:{ work:true, appr:true, count:4 }, stats:true,
                 waiver:{ shown:true, btns:1 } },
  firefighter: { nav:['לוח מודעות','סידור','נוכחות','תקלות','טפסים','החלפות','חוות דעת','ציוות','אבטחות','חתימות','כשירויות','התראות','עובדים'], adminSees:[],
                 shadow:false,
                 quals:{ work:true, edit:false },
                 board:{ work:true, edit:false },
                 swaps:{ work:true, appr:false },
                 alerts:{ work:true, send:true, key:false, opts:1 },
                 callout:{ card:false, opts:0, pick:false },
                 guards:{ work:true, create:false },
                 faults:{ work:true, anchor:false, sev:false, grade:false },
                 forms:{ work:true, appr:false, count:4 }, stats:false,
                 // כבאי רואה שהמשמרת מתחת לקו, ואין לו מה ללחוץ.
                 waiver:{ shown:true, btns:0 } },
  commander:   { nav:['לוח מודעות','סידור','נוכחות','תקלות','טפסים','החלפות','חוות דעת','ציוות','אבטחות','חתימות','כשירויות','התראות','עובדים','גישה','ניהול','נתונים'],
                 adminSees:[],
                 shadow:false,
                 quals:{ work:true, edit:true },
                 board:{ work:true, edit:true }, crews:['B'],
                 swaps:{ work:true, appr:true, pend:1 },
                 alerts:{ work:true, send:true, key:false, opts:1 },
                 callout:{ card:true, opts:2, pick:false },
                 guards:{ work:true, create:false },
                 faults:{ work:true, anchor:true, sev:true, grade:true },
                 forms:{ work:true, appr:true, count:4 }, stats:true },
  hr:          { nav:['לוח מודעות','סידור','נוכחות','תקלות','טפסים','החלפות','חוות דעת','ציוות','אבטחות','חתימות','כשירויות','התראות','עובדים','בקרת שעות','גישה','ניהול','נתונים'],
                 adminSees:[],
                 shadow:true,
                 quals:{ work:true, edit:true },
                 board:{ work:true, edit:true }, crews:['A','B','C'],
                 swaps:{ work:true, appr:true, pend:2 },
                 alerts:{ work:true, send:true, key:false, opts:4 },
                 callout:{ card:true, opts:5, pick:false },
                 guards:{ work:true, create:false },
                 faults:{ work:true, anchor:true, sev:true, grade:true },
                 forms:{ work:true, appr:true, count:4 }, stats:true },
  // סגן מפקד משמרת: אותן סמכויות כמו מפקד, נעול למשמרת ב'.
  deputy:      { nav:['לוח מודעות','סידור','נוכחות','תקלות','טפסים','החלפות','חוות דעת','ציוות','אבטחות','חתימות','כשירויות','התראות','עובדים','גישה','ניהול','נתונים'],
                 adminSees:[],
                 shadow:false,
                 quals:{ work:true, edit:true },
                 board:{ work:true, edit:true }, crews:['B'],
                 swaps:{ work:true, appr:true, pend:1 },
                 callout:{ card:true, opts:2, pick:false },
                 guards:{ work:true, create:false },
                 faults:{ work:true, anchor:true, sev:true, grade:true },
                 forms:{ work:true, appr:true, count:4 }, stats:true,
                 waiver:{ shown:true, btns:1 },
                 alerts:{ work:true, send:true, key:false, opts:1 } },
  // מפקד תחנה: רואה את שלוש המשמרות, כמו רכז כוח אדם.
  stcmd:       { nav:['לוח מודעות','סידור','נוכחות','תקלות','טפסים','החלפות','חוות דעת','ציוות','אבטחות','חתימות','כשירויות','התראות','עובדים','בקרת שעות','גישה','ניהול','נתונים'],
                 adminSees:[],
                 shadow:true,
                 quals:{ work:true, edit:true },
                 board:{ work:true, edit:true }, crews:['A','B','C'],
                 swaps:{ work:true, appr:true, pend:2 },
                 callout:{ card:true, opts:5, pick:false },
                 guards:{ work:true, create:false },
                 faults:{ work:true, anchor:true, sev:true, grade:true },
                 forms:{ work:true, appr:true, count:4 }, stats:true,
                 // רכז כוח אדם רואה את הבקשה ואינו מכריע בה
                 // מפקד התחנה על משמרת א׳ עם בקשה ממתינה: אשר / דחה.
                 waiver:{ shown:true, btns:2 },
                 alerts:{ work:true, send:true, key:false, opts:4 } },
  pending:     { nav:['לוח מודעות'], adminSees:[],
                 shadow:false,
                 quals:{ work:false, edit:false },
                 board:{ work:false, edit:false },
                 swaps:{ work:false, appr:false },
                 alerts:{ work:false, send:false, key:false },
                 callout:{ card:false, opts:0, pick:false },
                 guards:{ work:false, create:false },
                 faults:{ work:false, anchor:false },
                 forms:{ work:false, appr:false }, stats:false }
};

const b = await chromium.launch();
let bad = 0;

for (const role of Object.keys(EXPECT)) {
  const ctx = await b.newContext();
  await ctx.route('**/firebasejs/**', r => {
    const n = r.request().url().split('/').pop().split('?')[0];
    const f = path.join(STUB, n);
    r.fulfill({status:200, contentType:'text/javascript',
               body: fs.existsSync(f) ? fs.readFileSync(f,'utf8') : 'export default {};'});
  });
  await ctx.addInitScript('window.__SMOKE_ROLE = ' + JSON.stringify(role) + ';');
  const pg = await ctx.newPage();
  // פעולות אופציונליות נוגעות גם במסכים שחסומים לתפקיד הנבדק.
  // ברירת המחדל של Playwright (30 שניות) הפכה כל כפתור שאינו קיים
  // להמתנה ארוכה, ולכן משתמש pending נראה כמו בדיקה תקועה.
  pg.setDefaultTimeout(2_000);
  pg.setDefaultNavigationTimeout(10_000);

  await pg.goto('http://localhost:'+PORT+'/login.html', {waitUntil:'load'});

  // ההבזק: טופס הכניסה נצבע לפני שהתברר שהמשתמש כבר מחובר.
  // נמדד מיד עם הטעינה, לפני ש-onAuthStateChanged הספיק לענות.
  const flash = await pg.isVisible('#authView').catch(()=>false);
  console.log((flash?'✗':'✓') + ' [' + role + '] הבזק מסך כניסה: ' + flash);
  if (flash) bad++;

  await pg.waitForTimeout(1500);
  const nav = await pg.$$eval('#appNav a', els => els.map(e => e.textContent.trim()));
  const want = EXPECT[role].nav;
  const same = nav.length === want.length && nav.every((v,i) => v === want[i]);
  console.log((same?'✓':'✗') + ' [' + role + '] תפריט: ' + JSON.stringify(nav));
  if (!same) { bad++; console.log('    ציפיתי: ' + JSON.stringify(want)); }

  // בקרת שעות Shadow היא מסך רגיש: רק רכז/ת כוח אדם, מפקד
  // תחנה ומנהל-על רואים אותו. תפקיד חסום גם לא מפעיל callable.
  await pg.goto('http://localhost:'+PORT+'/attendance-shadow.html', {waitUntil:'load'});
  await pg.waitForTimeout(500);
  const shMain = await pg.isVisible('#main').catch(()=>false);
  const shDeny = await pg.isVisible('#deny').catch(()=>false);
  const shCalls = await pg.evaluate(() => (window.__CALLABLE_FACTORIES || [])
    .filter(name => /AttendanceShadow/.test(name))).catch(()=>[]);
  const wantShadow = EXPECT[role].shadow;
  const okShadow = shMain === wantShadow && shDeny === !wantShadow &&
                   (wantShadow || shCalls.length === 0);
  console.log((okShadow?'✓':'✗') + ' [' + role + '] בקרת שעות: מסך=' + shMain +
              ' חסום=' + shDeny + ' קריאות-שרת=' + shCalls.length);
  if (!okShadow) bad++;

  await pg.goto('http://localhost:'+PORT+'/admin.html', {waitUntil:'load'});
  await pg.waitForTimeout(1500);
  const shown = [];
  for (const id of ['reqCard','usersCard']) {
    const vis = await pg.isVisible('#'+id).catch(()=>false);
    if (vis) shown.push(id);
  }
  const denied = await pg.$eval('#denyCard', e => getComputedStyle(e).display !== 'none').catch(()=>false);
  const wantAdmin = EXPECT[role].adminSees;
  const okAdmin = shown.length === wantAdmin.length && shown.every(x => wantAdmin.includes(x));
  console.log((okAdmin?'✓':'✗') + ' [' + role + '] ניהול: מוצג=' + JSON.stringify(shown) +
              ' חסום=' + denied);
  if (!okAdmin) bad++;

  // מסך הכשירויות. כבאי רגיל חייב לראות את התוכן ולא לראות
  // אף כלי עריכה — כפתור שנחסם בשרת גרוע מכפתור שלא קיים.
  await pg.goto('http://localhost:'+PORT+'/quals.html', {waitUntil:'load'});
  await pg.waitForTimeout(1500);
  const qWork = await pg.isVisible('#work').catch(()=>false);
  const qAdd  = await pg.isVisible('#addRow').catch(()=>false);
  const qSave = await pg.isVisible('#btnSaveRL').catch(()=>false);
  const qEdit = await pg.$$eval('#rows button', els =>
                  els.filter(e => e.textContent.trim() === 'ערוך').length).catch(()=>0);
  const wantQ = EXPECT[role].quals;
  const gotEdit = qAdd || qSave || qEdit > 0;
  const okQ = qWork === wantQ.work && gotEdit === wantQ.edit;
  console.log((okQ?'✓':'✗') + ' [' + role + '] כשירויות: מסך=' + qWork +
              ' עריכה=' + gotEdit + ' (הוספה=' + qAdd + ' קו-אדום=' + qSave +
              ' ערוך=' + qEdit + ')');
  if (!okQ) { bad++; console.log('    ציפיתי: מסך=' + wantQ.work + ' עריכה=' + wantQ.edit); }

  // ציוות. כבאי רגיל רואה את הלוח ולא רואה אף כלי עריכה —
  // לא "＋ רכב", לא "＋ משבצת" ולא עיפרון על שורה.
  await pg.goto('http://localhost:'+PORT+'/board.html', {waitUntil:'load'});
  await pg.waitForTimeout(1600);
  const bWork = await pg.isVisible('#work').catch(()=>false);
  const bVeh  = await pg.isVisible('#btnAddVeh').catch(()=>false);
  const bPen  = await pg.$$eval('#fleet .x', e => e.length).catch(()=>0);
  const bTool = await pg.$$eval('#fleet .veh .tools .btn', e => e.length).catch(()=>0);
  const bEdit = bVeh || bPen > 0 || bTool > 0;
  const wantB = EXPECT[role].board;
  const okB = bWork === wantB.work && bEdit === wantB.edit;
  console.log((okB?'✓':'✗') + ' [' + role + '] ציוות: לוח=' + bWork +
              ' עריכה=' + bEdit + ' (רכב=' + bVeh + ' עיפרון=' + bPen +
              ' כלים=' + bTool + ')');
  if (!okB) { bad++; console.log('    ציפיתי: לוח=' + wantB.work + ' עריכה=' + wantB.edit); }

  // נעילת מפקד משמרת: אילו כפתורי משמרת בכלל קיימים ונראים.
  if (EXPECT[role].crews) {
    const seen = await pg.$$eval('.sw', els => els
      .filter(e => getComputedStyle(e).display !== 'none')
      .map(e => e.getAttribute('data-crew'))).catch(()=>[]);
    const wantC = EXPECT[role].crews;
    const okC = seen.length === wantC.length && seen.every((v,i) => v === wantC[i]);
    console.log((okC?'✓':'✗') + ' [' + role + '] משמרות גלויות: ' + JSON.stringify(seen));
    if (!okC) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantC)); }
  }

  // החלפות. כבאי רגיל מגיש ורואה את שלו. כרטיס האישורים
  // שייך למפקד בלבד — ומראה רק בקשות של המשמרת שלו.
  await pg.goto('http://localhost:'+PORT+'/swaps.html', {waitUntil:'load'});
  await pg.waitForTimeout(1600);
  const sWork = await pg.isVisible('#work').catch(()=>false);
  const sAppr = await pg.isVisible('#apprCard').catch(()=>false);
  const sRows = await pg.$$eval('#apprList .sw', e=>e.length).catch(()=>0);
  // בקשות פתוחות. כבאי יכול לתפוס בקשה של אחר; מי שפרסם רואה
  // שהיא שלו ואינו יכול לתפוס את עצמו.
  const sOpen = await pg.$$eval('#openList .sw', e=>e.length).catch(()=>0);
  const sTake = await pg.$$eval('#openList button', e=>e.length).catch(()=>0);
  // שתי דרכים למצוא מחליף: בחירת שם, או שידור לכולם. שני
  // כפתורים ולא רשימה נפתחת — הבחירה גלויה בלי לחיצה.
  const sMode = await pg.$$eval('.modes .mode', e=>e.length).catch(()=>0);
  if (EXPECT[role].swaps && EXPECT[role].swaps.work) {
    const okO = sMode === 2;
    console.log((okO?'✓':'✗') + ' [' + role + '] בקשות פתוחות: מוצגות=' +
                sOpen + ' ניתנות לתפיסה=' + sTake + ' מסלולים=' + sMode);
    if (!okO) { bad++; }
  }

  const wantS = EXPECT[role].swaps;
  if (wantS) {
    const okS = sWork === wantS.work && sAppr === wantS.appr &&
                (wantS.pend == null || sRows === wantS.pend);
    console.log((okS?'✓':'✗') + ' [' + role + '] החלפות: מסך=' + sWork +
                ' כרטיס-אישור=' + sAppr + ' ממתינות=' + sRows);
    if (!okS) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantS)); }
  }

  // התראות. כרטיס השליחה מופיע לפי התפקיד: מפקד למשמרת שלו,
  // רכז ומנהל-על לכל התחנה, כבאי למשמרת שלו. מי שאין לו משמרת
  // ואינו סגל — לא רואה אותו בכלל.
  await pg.goto('http://localhost:'+PORT+'/alerts.html', {waitUntil:'load'});
  await pg.waitForTimeout(1600);
  const aWork = await pg.isVisible('#work').catch(()=>false);
  const aSend = await pg.isVisible('#sendCard').catch(()=>false);
  const aKey  = await pg.isVisible('#keyCard').catch(()=>false);
  const aOpts = await pg.$$eval('#target option', e=>e.length).catch(()=>0);
  // קריאת פתע. הכרטיס נפתח למפקד, לרכז ולמנהל-על בלבד. כבאי
  // מקבל קריאות אבל לא שולח אותן.
  const cCard = await pg.isVisible('#coCard').catch(()=>false);
  const cOpts = await pg.$$eval('#coTarget option', e=>e.length).catch(()=>0);
  const cPick = await pg.isVisible('#coPick').catch(()=>false);
  // החלון עצמו: הקבוע בבדיקה שלוח למשתמש הבדיקה, ולכן חייב
  // לקפוץ בכל מסך שיש בו משתמש חבר תחנה.
  const cPop  = await pg.isVisible('#coWrap').catch(()=>false);
  const wantC = EXPECT[role].callout;
  if (wantC) {
    const okC = cCard === wantC.card && cOpts === wantC.opts && cPick === wantC.pick &&
                cPop === (EXPECT[role].alerts && EXPECT[role].alerts.work);
    console.log((okC?'✓':'✗') + ' [' + role + '] קריאת פתע: כרטיס=' + cCard +
                ' יעדים=' + cOpts + ' בחירה-ידנית=' + cPick + ' חלון-קופץ=' + cPop);
    if (!okC) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantC)); }
  }

  // אבטחות. כל חבר תחנה רואה ונרשם; פתיחה ושיבוץ דורשים מינוי חי
  // ונפרד של אחראי/ת סידור, ולכן אינם נגזרים מן התפקיד הראשי כאן.
  await pg.goto('http://localhost:'+PORT+'/guards.html', {waitUntil:'load'});
  await pg.waitForTimeout(1700);
  const gWork = await pg.isVisible('#work').catch(()=>false);
  const gNew  = await pg.isVisible('#newCard').catch(()=>false);
  const gRank = await pg.$$eval('#rankList .rec', e=>e.length).catch(()=>0);
  const gLog  = await pg.$$eval('#logTbl tbody tr', e=>e.length).catch(()=>0);
  const wantG = EXPECT[role].guards;
  if (wantG) {
    const okG = gWork === wantG.work && gNew === wantG.create;
    console.log((okG?'✓':'✗') + ' [' + role + '] אבטחות: מסך=' + gWork +
                ' פתיחה=' + gNew + ' מדורגים=' + gRank + ' לוג=' + gLog);
    if (!okG) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantG)); }
  }

  // תקלות. כל כבאי מדווח — זו כל הנקודה. רכבי עיגון לסגל.
  await pg.goto('http://localhost:'+PORT+'/faults.html', {waitUntil:'load'});
  await pg.waitForTimeout(1700);
  const xWork = await pg.isVisible('#work').catch(()=>false);
  // כרטיס רכבי העיגון יושב בלשונית "מצב הצי". בלי לפתוח אותה
  // הוא מוסתר לכולם, וזה מצב הלשונית — לא ההרשאה.
  //
  // וקודם עונים לקריאת הפתע: היא חוסמת כל לחיצה בדף עד שעונים,
  // וזה בדיוק מה שהיא אמורה לעשות. גילינו את זה כאן.
  await pg.click('#coNo').catch(()=>{});
  await pg.waitForTimeout(300);
  await pg.click('#tabFleet').catch(()=>{});
  await pg.waitForTimeout(350);
  const xAnch = await pg.isVisible('#anchorCard').catch(()=>false);
  // חוזרים ללשונית התקלות. מה שנבדק כאן חי שם, ובלשונית
  // סגורה isVisible יחזיר false לכולם — הרשאה ומצב לשונית
  // נראים אותו דבר, וזה בדיוק סוג הבדיקה שמשקרת.
  await pg.click('#tabOpen').catch(()=>{});
  await pg.waitForTimeout(300);
  // הרשימה מציגה שורת נושא אחת לכל רכב או פריט — הדיווח
  // האחרון בלבד. הכרטיסים המלאים חיים בלוג שנפתח בלחיצה.
  const xOpen = await pg.$$eval('#openList .subj', e=>e.length).catch(()=>0);
  // ולכן בורר החומרה נבדק **אחרי** פתיחת הלוג. בדיקה על
  // הרשימה עצמה הייתה מחזירה 0 לכולם, ואז "אין הרשאה לדרג"
  // ו"הכרטיס בכלל לא כאן" נראים אותו דבר.
  await pg.click('#openList .subj').catch(()=>{});
  await pg.waitForTimeout(350);
  const xLog  = await pg.$$eval('#dlgBody .f', e=>e.length).catch(()=>0);
  const xGrade= await pg.$$eval('#dlgBody .f select', e=>e.length).catch(()=>0);
  await pg.click('#rep .x').catch(()=>{});
  await pg.waitForTimeout(200);
  // בורר החומרה. כבאי מדווח ולא מדרג — הבורר קיים רק לסגל,
  // גם בטופס הדיווח וגם על כרטיס תקלה קיימת.
  const xSev  = await pg.isVisible('#sevWrap').catch(()=>false);
  const xVeh  = await pg.$$eval('#fleetList .v', e=>e.length).catch(()=>0);
  const wantX = EXPECT[role].faults;
  if (wantX) {
    const okX = xWork === wantX.work && xAnch === wantX.anchor &&
                (wantX.sev == null || xSev === wantX.sev) &&
                (wantX.grade == null || (xGrade > 0) === wantX.grade);
    console.log((okX?'✓':'✗') + ' [' + role + '] תקלות: מסך=' + xWork +
                ' עיגון=' + xAnch + ' נושאים=' + xOpen + ' לוג=' + xLog +
                ' רכבים=' + xVeh +
                ' בורר-חומרה=' + xSev + ' דירוג=' + xGrade);
    if (!okX) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantX)); }
  }

  // היתר לרדת מקו אדום. ראש המשמרת מבקש, מפקד התחנה בלבד
  // מכריע — ולכן כפתורי ההכרעה קיימים רק אצלו.
  await pg.goto('http://localhost:'+PORT+'/board.html', {waitUntil:'load'});
  await pg.waitForTimeout(1600);
  await pg.click('#coNo').catch(()=>{});
  await pg.waitForTimeout(250);
  const wShown = await pg.isVisible('#waiver').catch(()=>false);
  const wBtns  = await pg.$$eval('#waiver button', e=>e.length).catch(()=>0);
  const wantW  = EXPECT[role].waiver;
  if (wantW) {
    const okW = wShown === wantW.shown && wBtns === wantW.btns;
    console.log((okW?'✓':'✗') + ' [' + role + '] היתר קו אדום: מוצג=' + wShown +
                ' כפתורים=' + wBtns);
    if (!okW) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantW)); }
  }

  // טפסים. כל כבאי ממלא; רק סגל רואה את לשונית האישורים.
  await pg.goto('http://localhost:'+PORT+'/forms.html', {waitUntil:'load'});
  await pg.waitForTimeout(1600);
  await pg.click('#coNo').catch(()=>{});
  await pg.waitForTimeout(250);
  const mWork = await pg.isVisible('#work').catch(()=>false);
  const mAppr = await pg.isVisible('#tabAppr').catch(()=>false);
  const mForms= await pg.$$eval('#fPick option', e=>e.length).catch(()=>0);
  const wantM = EXPECT[role].forms;
  if (wantM) {
    const okM = mWork === wantM.work && mAppr === wantM.appr &&
                (wantM.count == null || mForms === wantM.count);
    console.log((okM?'✓':'✗') + ' [' + role + '] טפסים: מסך=' + mWork +
                ' אישורים=' + mAppr + ' סוגים=' + mForms);
    if (!okM) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantM)); }
  }

  // אנליטיקה. כלי ניהול — כבאי רגיל לא נכנס.
  await pg.goto('http://localhost:'+PORT+'/stats.html', {waitUntil:'load'});
  await pg.waitForTimeout(1600);
  await pg.click('#coNo').catch(()=>{});
  await pg.waitForTimeout(250);
  const zWork = await pg.isVisible('#work').catch(()=>false);
  const zRows = await pg.$$eval('#vTbl tbody tr', e=>e.length).catch(()=>0);
  const wantZ = EXPECT[role].stats;
  if (wantZ != null) {
    const okZ = zWork === wantZ;
    console.log((okZ?'✓':'✗') + ' [' + role + '] נתונים: מסך=' + zWork +
                ' רכבים=' + zRows);
    if (!okZ) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantZ)); }
  }

  const wantA = EXPECT[role].alerts;
  if (wantA) {
    const okA = aWork === wantA.work && aSend === wantA.send &&
                aKey === wantA.key && (wantA.opts == null || aOpts === wantA.opts);
    console.log((okA?'✓':'✗') + ' [' + role + '] התראות: מסך=' + aWork +
                ' שליחה=' + aSend + ' יעדים=' + aOpts + ' מפתח=' + aKey);
    if (!okA) { bad++; console.log('    ציפיתי: ' + JSON.stringify(wantA)); }
  }

  await ctx.close();
}
// מנותק: אחרי שהמצב מתברר, טופס הכניסה חייב להופיע. ההסתרה
// שמונעת את ההבזק לא רשאית לחסום את מי שבאמת צריך להיכנס.
{
  const ctx = await b.newContext();
  await ctx.route('**/firebasejs/**', r => {
    const n = r.request().url().split('/').pop().split('?')[0];
    const f = path.join(STUB, n);
    r.fulfill({status:200, contentType:'text/javascript',
               body: fs.existsSync(f) ? fs.readFileSync(f,'utf8') : 'export default {};'});
  });
  await ctx.addInitScript('window.__SMOKE_ROLE = "none";');
  const pg = await ctx.newPage();
  await pg.goto('http://localhost:'+PORT+'/login.html', {waitUntil:'load'});
  await pg.waitForTimeout(1500);
  const seen = await pg.isVisible('#authView').catch(()=>false);
  const boot = await pg.isVisible('#bootView').catch(()=>false);
  console.log((seen && !boot ? '✓' : '✗') +
              ' [מנותק] טופס כניסה מוצג: ' + seen + ' · תקוע בטעינה: ' + boot);
  if (!seen || boot) bad++;
  await ctx.close();
}

await b.close(); srv.close();
console.log(bad ? '\n' + bad + ' אי-התאמות' : '\nהתפקידים תואמים');
process.exit(bad?1:0);
