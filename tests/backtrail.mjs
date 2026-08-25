// כפתור "חזרה".
//
// אלדד: "כל לחיצה על חזרה מחזירה אותי אל מסך הכניסה."
//
// הבדיקה הזו לא הייתה קיימת, ולכן הבאג חי. היא הולכת מסלול
// אמיתי ובודקת לאן הכפתור באמת מוביל — ולא אם הוא קיים.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');


const ROOT=__APP, STUB=__j(__TESTS, "stub"), PORT=8299;
const T={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);
  if(p==='/')p='/index.html'; const f=path.join(ROOT,p);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);r.end('no');return;}
  r.writeHead(200,{'Content-Type':T[path.extname(f)]||'text/plain'});r.end(fs.readFileSync(f));});
await new Promise(r=>srv.listen(PORT,r));

const b=await chromium.launch();
const ctx=await b.newContext();
await ctx.route('**/firebasejs/**',r=>{const n=r.request().url().split('/').pop().split('?')[0];
  const f=path.join(STUB,n); r.fulfill({status:200,contentType:'text/javascript',
    body:fs.existsSync(f)?fs.readFileSync(f,'utf8'):'export default {};'});});
await ctx.addInitScript('window.__SMOKE_ROLE = "commander";');
const pg=await ctx.newPage();

let bad=0;
const here = () => pg.url().split('/').pop().split('?')[0];

async function go(file){
  await pg.goto('http://localhost:'+PORT+'/'+file,{waitUntil:'load'});
  await pg.waitForTimeout(1200);
  await pg.click('#coNo').catch(()=>{});
  await pg.waitForTimeout(200);
}
async function back(){
  await pg.click('#appNav button.back');
  await pg.waitForTimeout(1300);
  await pg.click('#coNo').catch(()=>{});
  await pg.waitForTimeout(150);
}
function check(what, got, want){
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok?'✓':'✗')+' '+what+': '+got+(ok?'':'  — ציפיתי '+want));
}

// 1. במסך הכניסה אין לאן לחזור, ולכן אין כפתור. כפתור שלא
//    עושה כלום גרוע מכפתור שלא קיים.
await go('login.html');
const onLogin = await pg.isVisible('#appNav button.back').catch(()=>false);
check('כפתור חזרה במסך הכניסה מוסתר', onLogin ? 'מוצג' : 'מוסתר', 'מוסתר');

// 2. המסלול: כניסה → תקלות → סידור. חזרה צריכה להגיע לתקלות,
//    ולא למסך הכניסה. זה הבאג המקורי.
await go('faults.html');
await go('schedule.html');
await back();
check('חזרה מהסידור', here(), 'faults.html');

// 3. עוד חזרה — עד מסך הכניסה, צעד אחד בכל פעם.
await back();
check('חזרה מהתקלות', here(), 'login.html');

// 4. לולאה: א → ב → א. המסלול הוא דרך ולא יומן, ולכן חזרה
//    מ-א צריכה לצאת מהלולאה ולא להסתובב בתוכה.
await go('login.html');
await go('faults.html');
await go('schedule.html');
await go('faults.html');
await back();
check('חזרה אחרי לולאה', here(), 'login.html');

console.log('\n'+(bad? bad+' כשלים בכפתור החזרה' : 'כפתור החזרה מתנהג כמצופה'));
await b.close(); srv.close();
process.exit(bad?1:0);
