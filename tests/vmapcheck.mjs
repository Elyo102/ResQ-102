// מפת הרכב: התמונה, הנקודות עליה, והמעבר בין צדדים.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');


const ROOT=__APP, STUB=__j(__TESTS, "stub");
let PORT=0;
const T={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);
  if(p==='/')p='/index.html'; const f=path.join(ROOT,p);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);r.end('no');return;}
  r.writeHead(200,{'Content-Type':T[path.extname(f)]||'text/plain'});r.end(fs.readFileSync(f));});
await new Promise(r=>srv.listen(0,r));
PORT=srv.address().port;
const b=await chromium.launch();
let bad=0;
function ck(what,got,want){const ok=String(got)===String(want);if(!ok)bad++;
  console.log((ok?'✓':'✗')+' '+what+': '+got+(ok?'':'  — ציפיתי '+want));}

for (const role of ['commander','firefighter']) {
  const ctx=await b.newContext({viewport:{width:900,height:1000}});
  await ctx.route('**/firebasejs/**',r=>{const n=r.request().url().split('/').pop().split('?')[0];
    const f=path.join(STUB,n); r.fulfill({status:200,contentType:'text/javascript',
      body:fs.existsSync(f)?fs.readFileSync(f,'utf8'):'export default {};'});});
  await ctx.addInitScript('window.__SMOKE_ROLE='+JSON.stringify(role)+';');
  const pg=await ctx.newPage();
  const errs=[]; pg.on('console',m=>{if(m.type()==='error')errs.push(m.text());});

  await pg.goto('http://localhost:'+PORT+'/vehicle.html?v=v2&side=right',{waitUntil:'load'});
  await pg.waitForTimeout(1800);
  await pg.click('#coNo').catch(()=>{}); await pg.waitForTimeout(300);

  console.log('--- '+role);
  ck('תמונת רקע מוצגת', await pg.isVisible('.stage img.base').catch(()=>false), 'true');
  ck('נקודות על צד ימין', await pg.$$eval('.pin',e=>e.length).catch(()=>0), 2);
  // הפגיעה הסגורה יושבת על "אחור" ולכן לא נספרת כאן — וזו
  // בדיוק ההפרדה בין צדדים שצריך לוודא.
  ck('רשימה מתחת', await pg.$$eval('#list .f',e=>e.length).catch(()=>0)>0, 'true');

  // הלשוניות נבנות מחדש בכל ציור, ולכן מחזיקים אינדקס ולא
  // ידית. ידית שנשמרה מצביעה על אלמנט שכבר הוסר.
  const tab = async i => {
    await pg.click('#sideChips button:nth-of-type(' + (i+1) + ')');
    await pg.waitForTimeout(450);
  };

  // מעבר לצד "אחור": נקודה אחת, והיא סגורה.
  await tab(2);
  ck('נקודות על אחור', await pg.$$eval('.pin',e=>e.length).catch(()=>0), 1);
  ck('הנקודה מסומנת כטופלה',
     await pg.$$eval('.pin.done',e=>e.length).catch(()=>0), 1);

  // צד בלי תמונה: מצב ריק מפורש, ואפשרות להעלות.
  await tab(0);
  ck('מצב "אין תמונה"', await pg.isVisible('.empty').catch(()=>false), 'true');
  ck('כפתור העלאה לכולם',
     await pg.$$eval('#photoActs button',e=>e.length).catch(()=>0), 1);

  // החלפת תמונה קיימת — סגל בלבד.
  await tab(1);
  ck('כפתור החלפה', await pg.$$eval('#photoActs button',e=>e.length).catch(()=>0),
     role==='commander' ? 1 : 0);

  // לחיצה על נקודה פותחת את הכרטיס.
  await pg.click('.pin'); await pg.waitForTimeout(400);
  ck('כרטיס נפתח', await pg.isVisible('#ov.on').catch(()=>false), 'true');
  ck('בורר חומרה בכרטיס',
     await pg.$$eval('#dlgBody select',e=>e.length).catch(()=>0),
     role==='commander' ? 1 : 0);

  ck('שגיאות מסוף', errs.length, 0);
  await ctx.close();
}

// ---------- ייבוא הסט המצורף ----------
//
// נבדק בנפרד, כי הוא מופיע רק כשאין אף תמונה לרכב — וזה
// בדיוק המצב שהמשתמש נמצא בו ביום הראשון.
{
  const ctx=await b.newContext({viewport:{width:900,height:1000}});
  await ctx.route('**/firebasejs/**',r=>{const n=r.request().url().split('/').pop().split('?')[0];
    const f=path.join(STUB,n); r.fulfill({status:200,contentType:'text/javascript',
      body:fs.existsSync(f)?fs.readFileSync(f,'utf8'):'export default {};'});});
  await ctx.addInitScript('window.__SMOKE_ROLE="commander";');
  const pg=await ctx.newPage();
  await pg.goto('http://localhost:'+PORT+'/vehicle.html?v=v1&side=front',{waitUntil:'load'});
  await pg.waitForTimeout(1800);
  await pg.click('#coNo').catch(()=>{}); await pg.waitForTimeout(300);
  console.log('--- ייבוא');
  ck('כפתור ייבוא לרכב בלי תמונות',
     await pg.$$eval('#importRow button',e=>e.length).catch(()=>0), 1);
  // v2 כבר יש לו שתי תמונות — הכפתור חייב להיעלם.
  await pg.goto('http://localhost:'+PORT+'/vehicle.html?v=v2&side=right',{waitUntil:'load'});
  await pg.waitForTimeout(1800);
  await pg.click('#coNo').catch(()=>{}); await pg.waitForTimeout(300);
  ck('הכפתור נעלם כשיש כבר סט',
     await pg.$$eval('#importRow button',e=>e.length).catch(()=>0), 0);
  await ctx.close();
}

console.log('\n'+(bad? bad+' כשלים במפת הרכב':'מפת הרכב תקינה'));
await b.close(); srv.close();
process.exit(bad?1:0);
