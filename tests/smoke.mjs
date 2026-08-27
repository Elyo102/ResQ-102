// בדיקת עשן: מרים שרת מקומי, טוען כל דף בדפדפן אמיתי, ומדווח
// על כל שגיאת קוד. ה-SDK של Firebase מוחלף בבדל מקומי, כי
// שרתי Google אינם נגישים מכאן — וכך שגיאות בקוד שלנו צפות
// במקום להיבלע בכישלון רשת.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');



const ROOT = process.argv[2] || __APP;
const STUB = __j(__TESTS, "stub");
let PORT = 0;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, r));
PORT = server.address().port;

const ROLE  = process.env.SMOKE_ROLE || 'super';
const PAGES = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();

// מה שאני מבטיח שקיים — נבדק, לא מונח. בלי זה אני יכול לדווח
// "הדף נקי" על דף שחסר בו בדיוק השדה שהמשתמש מחפש.
const MUST_ALL = {
  'admin.html': ['#rEmail','#rName','#rPhone','#rRole','#rShift','#rEmp',
                 '#rStation','#rSuper','#rDistrict','#btnRole','#list',
                 '#btnUsers','#btnReindex'],
  'login.html': ['#loginEmp','#loginPass','#btnLogin','#btnForgot','#fName',
                 '#fEmail','#fPhone','#fDistrict','#fStation','#fPass',
                 '#btnFirst','#btnBootstrap','#verNow','#btnUpdate','#fShift','#fCode',
                 '#bulletinBoard','#boardTabs','#bulletinFeed','#bulletinForm',
                 '#bulletinCategory','#bulletinText','#bulletinSubmit',
                 '#bulletinStatus','#bulletinRetry','#bulletinLoadMore',
                 '#bulletinCompose','#bulletinEmpty','#bulletinIdentity',
                 '#accountDetails'],
  // חיפוש העובד עבר למסך משלו. השדות נבדקים שם עכשיו — אם
  // הם היו נמחקים מכאן בלי להיבדק שם, המעבר היה "מוצלח"
  // בדיוק עד שמישהו היה מנסה לחפש.
  'people.html': ['#qName','#btnDoSearch','#results','#resCard','#sMsg',
                  '#roster','#rosterCard','#rosterNote'],
  'vehicle.html': ['#vehChips','#sideChips','#stageWrap','#legend',
                   '#photoActs','#basePick','#list','#ov','#dlgBody'],
  'import.html': ['#knob','#master','#mState','#ready',
                  '#hPaste','#hDry','#hRun','#hMsg','#hSum'],
  'access.html': ['#sid','#btnLoad','#rows','#tbl'],
  'quals.html': ['#rlBoxes','#catList','#addRow','#newQual','#btnAdd',
                 '#minHead','#rlQuals','#btnSaveRL','#rows','#tbl'],
  'board.html': ['#chain','#fleet','#verdict','#why','#btnAddVeh','#ov','#dlg'],
  'swaps.html': ['#myDate','#hisDate','#btnPick','#btnSend','#mineList','#modePeer','#modeOpen','#myCrewLine','#hisCrewLine',
                 '#apprCard','#apprList','#ov','#dlg',
                 '#wantCrew','#openList'],
  'alerts.html': ['#pState','#btnOn','#prefs','#btnSavePrefs','#bcList','#keyCard'],
  'attendance.html': ['#moLabel','#prev','#next','#tHours','#tDays','#tSug',
                      '#rows','#btnStart','#btnManual','#state','#ov','#dlg',
                      '#btnView','#btnSync','#btnRecalc'],
  'schedule.html': ['#grid','#dows','#moLabel','#prev','#next',
                    '#fitCard','#fitBoxes','#ovrCard','#ovKind','#ovDate',
                    '#ovCrew','#ovNote','#ovAdd','#ovList'],
  'check.html': ['#who','#dir','#search','#fns','#btnRun','#btnAgain',
                 '#mkey','#btnScan','#btnReport','#runOut','#btnDeploy','#dep','#depSum','#btnSeed','#btnWipe','#seed'],
  'guards.html': ['#tabOpen','#tabMine','#tabLoad','#tabLog','#openList',
                  '#newCard','#nTitle','#nDate','#nSlots','#btnNew',
                  '#balList','#rankList','#logTbl','#ov','#dlg'],
  'faults.html': ['#tabOpen','#tabShift','#tabFleet','#tabHist','#openList',
                  '#nKind','#nTitle','#nDesc','#nSev','#nShot','#btnNew',
                  '#hoSign','#hoState','#hoSummary','#hoVeh','#hoGear',
                  '#hoDamage','#hoRepair','#hoTasks','#hoAnchors','#hoNotes','#hoLog',
                  '#hoAcceptWrap','#hoMsg','#btnAccept',
                  '#fleetList','#anchorCard','#aName','#btnAnchor',
                  '#histList','#lb','#rep','#dlgTitle','#dlgBody'],
  'forms.html': ['#tabNew','#tabMine','#tabAppr','#tabAway','#fPick',
                 '#fFields','#btnSubmit','#mineList','#apprList',
                 '#awayDate','#awayList','#sig','#sigClear'],
  'forms.html': ['#tabNew','#tabMine','#tabAway','#fPick','#fFields',
                 '#btnSubmit','#mineList','#awayDate','#awayList'],
  'stats.html': ['#winBar','#vLead','#vTbl','#lLead','#lList','#scoreWhy'],
  'unlock.html': []
};

// כבאי רגיל אינו אמור לראות את מסכי הניהול, ולכן אין טעם לדרוש
// בהם שדות — אבל כן חובה שלא יגיע למסך מת.
// מנותק: כל דף פנימי מפנה למסך הכניסה, ולכן אין בו שדות לדרוש.
// הדרישה היחידה היא שהדפים לא ייפלו בדרך.
const MUST = (ROLE === 'none') ? {
  'login.html': MUST_ALL['login.html'],
  'unlock.html': []
} : (ROLE === 'super') ? MUST_ALL : {
  'login.html': MUST_ALL['login.html'],
  'schedule.html': MUST_ALL['schedule.html'],
  // כבאי רגיל רואה את מסך הכשירויות — קריאה לכולם, עריכה לסגל.
  // אלה השדות שחייבים להופיע גם לו.
  'quals.html': ['#rlBoxes','#catList','#rows','#tbl'],
  'board.html': ['#chain','#fleet','#verdict'],
  'attendance.html': ['#moLabel','#rows','#tHours','#state'],
  'swaps.html': ['#myDate','#hisDate','#btnPick','#btnSend','#mineList','#modePeer','#modeOpen','#myCrewLine','#hisCrewLine',
                 '#openList'],
  'alerts.html': ['#pState','#prefs','#bcList'],
  // כבאי רואה את מסך האבטחות ונרשם — אבל לא פותח אבטחה חדשה.
  'guards.html': ['#tabOpen','#tabMine','#tabLoad','#tabLog','#openList',
                  '#balList','#rankList','#logTbl'],
  // כבאי מדווח תקלה — זו כל הנקודה. מה שאין לו: רכבי עיגון.
  'faults.html': ['#tabOpen','#tabShift','#tabFleet','#tabHist','#openList',
                  '#nKind','#nTitle','#nSev','#nShot','#btnNew',
                  '#hoSign','#hoState','#hoSummary','#hoVeh','#hoGear',
                  '#hoDamage','#hoTasks','#hoAnchors','#fleetList','#histList'],
  'unlock.html': []
};
const browser = await chromium.launch();
let bad = 0;

for (const page of PAGES) {
  const ctx = await browser.newContext();

  // כל בקשה ל-SDK של Firebase מוחלפת בבדל מקומי.
  await ctx.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const f = path.join(STUB, name);
    if (fs.existsSync(f)) {
      route.fulfill({ status:200, contentType:'text/javascript',
                      body: fs.readFileSync(f, 'utf8') });
    } else {
      route.fulfill({ status:200, contentType:'text/javascript', body:'export default {};' });
    }
  });
  await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({status:200, contentType:'text/css', body:''}));

  await ctx.addInitScript('window.__SMOKE_ROLE = ' + JSON.stringify(ROLE) + ';');
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('שגיאת קוד: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('קונסולה: ' + m.text()); });
  pg.on('requestfailed', r => {
    if (r.url().includes('localhost:' + PORT)) errs.push('קובץ חסר: ' + r.url());
  });

  try {
    await pg.goto('http://localhost:' + PORT + '/' + page, { waitUntil:'load', timeout:20000 });
    await pg.waitForTimeout(1800);
  } catch (e) { errs.push('טעינה נכשלה: ' + e.message); }

  for (const sel of (MUST[page] || [])) {
    const found = await pg.$(sel);
    if (!found) errs.push('שדה חסר בדף: ' + sel);
  }

  if (page === 'import.html' && ROLE === 'super') {
    for (const sel of ['#rows', '#pwPaste', '#btnDry', '#btnRun', '#sum']) {
      if (await pg.$(sel)) errs.push('בקר קליטה פרטי עדיין קיים: ' + sel);
    }
    try {
      const csv = [
        'שם,מספר עובד,משמרת,תאריך,סוג יום,כניסה,יציאה,כניסה 2,יציאה 2,שעות,מקום,הערה',
        'שם שונה בכוונה,17,A,2026-03-01,משמרת,07:00,07:00,,,24,,'
      ].join('\n');
      await pg.fill('#hPaste', csv);
      await pg.click('#hDry');
      await pg.waitForFunction(() => {
        const value = document.querySelector('#hMsg')?.textContent || '';
        return value.includes('הבדיקה הסתיימה') || value.includes('נכשלה');
      }, { timeout: 5000 });
      const summary = await pg.textContent('#hSum');
      if (!String(summary || '').includes('טל חודרה')) {
        errs.push('ייבוא היסטוריה לא זיהה משתמש לפי employee_number ממסמכי users');
      }
    } catch (e) {
      errs.push('בדיקת ייבוא היסטוריה נכשלה: ' + e.message);
    }
  }

  const real = errs.filter(e => !/ERR_TUNNEL|ERR_NAME|ERR_CONNECTION|net::/.test(e));
  const banner = await pg.$eval('#errBar', el =>
      getComputedStyle(el).display !== 'none' ? el.innerText : '').catch(() => '');

  if (real.length || banner) {
    bad++;
    console.log('\n✗ ' + page);
    real.forEach(e => console.log('    ' + e.slice(0, 240)));
    if (banner) console.log('    פס אדום: ' + banner.replace(/\s+/g,' ').slice(0,240));
  } else {
    console.log('✓ ' + page);
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log(bad ? '\n[' + ROLE + '] ' + bad + ' דפים עם שגיאות'
                : '\n[' + ROLE + '] כל הדפים נקיים');
process.exit(bad ? 1 : 0);
