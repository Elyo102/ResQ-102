// סריקת טלפון על כל המסכים.
//
// כל הבדיקות עד היום רצו ב-1150 פיקסל. אלדד הוא זה שגילה
// שהסרגל שובר את המסך בטלפון. זו הסריקה שהייתה צריכה
// לתפוס את זה: כל מסך ברוחב 390, ומחפשים שני דברים
// שאפשר למדוד — גלישה אופקית, ואלמנט שרחב מהמסך.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');


const ROOT=__APP, STUB=__j(__TESTS, "stub");
const srv=http.createServer((q,s)=>{const f=path.join(ROOT,decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);s.end();return;}
  s.writeHead(200,{'Content-Type':/\.js$/.test(f)?'text/javascript':/\.css$/.test(f)?'text/css':'text/html; charset=utf-8'});s.end(d);});});
const PAGES=fs.readdirSync(ROOT).filter(f=>f.endsWith('.html')).sort();
let bad=0;
let browser;
try {
  // פורט אקראי מאפשר להריץ בדיקות דפדפן במקביל בלי להתנגש בתהליך קודם.
  await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+srv.address().port;
  browser=await chromium.launch();
  for (const p of PAGES) {
    const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
    try {
      await ctx.route('**/firebasejs/**',r=>{const n=r.request().url().split('/').pop().split('?')[0];
        const q=path.join(STUB,n); r.fulfill({status:200,contentType:'text/javascript',body:fs.existsSync(q)?fs.readFileSync(q,'utf8'):'export default {};'});});
      await ctx.addInitScript(r=>{window.__SMOKE_ROLE=r;},'super');
      const pg=await ctx.newPage();
      await pg.goto(base+'/'+p,{waitUntil:'load'});
      await pg.waitForTimeout(1600);
      await pg.click('#coNo').catch(()=>{}); await pg.waitForTimeout(250);
      const r = await pg.evaluate(()=>{
        const de=document.documentElement;
        const over=de.scrollWidth-de.clientWidth;
    // מי בדיוק בורח. שם האלמנט, לא רק "יש גלישה".
    //
    // טבלה רחבה בתוך מכולה עם overflow-x:auto **אינה** תקלה —
    // זו הדרך הנכונה: הטבלה נגללת בתוך עצמה והדף לא זז.
    // הגרסה הראשונה של הבדיקה סימנה את שתי הטבלאות האלה
    // באדום, וזה בדיוק סוג האזהרה שמפסיקים לקרוא.
    const scrollable = el => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    const wide=[];
    document.querySelectorAll('body *').forEach(el=>{
      const b=el.getBoundingClientRect();
      if (b.width>de.clientWidth+1 && b.height>0 && !scrollable(el)) {
        wide.push((el.tagName.toLowerCase())+(el.id?'#'+el.id:'')+
                  (el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\s+/)[0]:'')+
                  ' ('+Math.round(b.width)+'px)');
      }
    });
        const nav=document.getElementById('appNav');
        return {over, wide:wide.slice(0,4), nav:nav?Math.round(nav.getBoundingClientRect().height):0};
      });
      const ok = r.over<=0 && !r.wide.length;
      if (!ok) bad++;
      console.log((ok?'✓':'✗')+' '+p.padEnd(17)+' סרגל '+String(r.nav).padStart(3)+'px'+
                  (r.over>0?'  · גלישה '+r.over+'px':'')+
                  (r.wide.length?'  · רחב מדי: '+r.wide.join(' · '):''));
    } finally {
      await ctx.close();
    }
  }
  console.log('\n'+(bad?bad+' מסכים שוברים את רוחב הטלפון':'כל המסכים נכנסים ברוחב טלפון'));
} finally {
  if (browser) await browser.close();
  if (srv.listening) await new Promise(resolve=>srv.close(resolve));
}
process.exitCode=bad?1:0;
