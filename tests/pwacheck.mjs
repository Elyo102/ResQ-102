import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');


const ROOT=__APP, STUB=__j(__TESTS, "stub"), PORT=8321;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript',
            '.json':'application/manifest+json','.png':'image/png','.ico':'image/x-icon'};
const srv=http.createServer((q,s)=>{const f=path.join(ROOT,decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);s.end();return;}
  s.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'text/plain'});s.end(d);});});
await new Promise(r=>srv.listen(PORT,r));
const b=await chromium.launch();
const ctx=await b.newContext();
await ctx.route('**/firebasejs/**',r=>{const n=r.request().url().split('/').pop().split('?')[0];
  const p=path.join(STUB,n); r.fulfill({status:200,contentType:'text/javascript',body:fs.existsSync(p)?fs.readFileSync(p,'utf8'):'export default {};'});});
await ctx.addInitScript(()=>{window.__SMOKE_ROLE='commander';});
const pg=await ctx.newPage();
await pg.goto('http://localhost:'+PORT+'/login.html',{waitUntil:'load'});
await pg.waitForTimeout(1200);

const man = await pg.evaluate(async () => {
  const l = document.querySelector('link[rel=manifest]');
  if (!l) return { err: 'אין קישור למניפסט' };
  const r = await fetch(l.href);
  const j = await r.json();
  return { name: j.name, display: j.display, dir: j.dir,
           icons: j.icons.length, shortcuts: (j.shortcuts||[]).length,
           start: j.start_url };
});
console.log('מניפסט:', JSON.stringify(man, null, 0));

const meta = await pg.evaluate(() => ({
  apple: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'),
  title: (document.querySelector('meta[name="apple-mobile-web-app-title"]')||{}).content,
  theme: (document.querySelector('meta[name="theme-color"]')||{}).content,
  touch: !!document.querySelector('link[rel="apple-touch-icon"]')
}));
console.log('תגיות אייפון:', JSON.stringify(meta));

// אייפון: השורה חייבת להופיע כי אין אירוע התקנה
const ios = await b.newContext({ userAgent:
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
await ios.route('**/firebasejs/**',r=>{const n=r.request().url().split('/').pop().split('?')[0];
  const p=path.join(STUB,n); r.fulfill({status:200,contentType:'text/javascript',body:fs.existsSync(p)?fs.readFileSync(p,'utf8'):'export default {};'});});
await ios.addInitScript(()=>{window.__SMOKE_ROLE='commander';});
const ip=await ios.newPage();
await ip.goto('http://localhost:'+PORT+'/login.html',{waitUntil:'load'});
await ip.waitForTimeout(3600);
const bar = await ip.isVisible('#pwaBar').catch(()=>false);
const txt = await ip.textContent('#pwaBar').catch(()=>'');
console.log('שורת התקנה באייפון:', bar, '·', txt.replace(/\s+/g,' ').trim().slice(0,80));
await b.close(); srv.close();
