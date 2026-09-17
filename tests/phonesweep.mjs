// סריקת טלפון על כל המסכים.
//
// כל הבדיקות עד היום רצו ב-1150 פיקסל. אלדד הוא זה שגילה
// שהסרגל שובר את המסך בטלפון. זו הסריקה שהייתה צריכה
// לתפוס את זה: כל מסך בשלושה רחבי טלפון (320/360/390 - קטן,
// אמצעי, גדול), ומחפשים שני דברים שאפשר למדוד — גלישה
// אופקית, ואלמנט שרחב מהמסך.
//
// עד 42H.20 (סעיף העיצוב, פריטים 1+6) הסריקה רצה רק ב-390
// ורק כ-`npm run browser:mobile` נפרד - סקריפט שאיש לא מריץ
// כברירת מחדל. עכשיו היא חלק מ-`browser`, ורצה בשלושת
// הרחבים שאלדד ביקש, לא רק באחד.
//
// אותה סריקה בודקת עכשיו גם 44x44 - לפי הכרעה מפורשת של
// אלדד, לא ניחוש: חייבים לעמוד ב-44x44 button/[role=button]/
// [role=tab]/קישורים/select/input(לא hidden)/textarea, וכל
// אלמנט שקיבל click listener אמיתי בזמן ריצה (לא רק selector
// סטטי - patch ל-addEventListener לפני שקוד האפליקציה רץ,
// כדי לתפוס גם אלמנטים שהופכים ללחיצים רק ב-JS). שני חריגים
// טבעיים, בלי רשימת קבצים: קישור טקסט בתוך פסקה רציפה
// (isInlineTextLink למטה - יש טקסט אמיתי נוסף באותו אלמנט-אב
// חוץ מהקישור עצמו), ואלמנט מוסתר/מושבת. input[type=hidden]
// עצמו לא נבדק (הוא ממילא לא נראה), אבל אם יש לו label - ה-
// label נכנס לבדיקה במקומו, בדיוק כמו שאלדד ביקש. חריג מפורש
// (data-touch-target-exempt) עובר את אותה בדיקת "קישור בתוך
// טקסט רציף" - אם הוא לא עומד בה, זה כשל, לא פטור.
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
let touchBad=0;
let browser;
try {
  // פורט אקראי מאפשר להריץ בדיקות דפדפן במקביל בלי להתנגש בתהליך קודם.
  await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+srv.address().port;
  browser=await chromium.launch();
  for (const width of [320, 360, 390]) {
  for (const p of PAGES) {
    const source=fs.readFileSync(path.join(ROOT,p),'utf8');
    const scripts=[...source.matchAll(/<script[^>]+src=["']\.\/([^"']+\.js)/g)]
      .map(match=>match[1]);
    const hasNav=source.includes("from './nav.js") || scripts.some(file=>{
      const full=path.join(ROOT,file);
      return fs.existsSync(full) && fs.readFileSync(full,'utf8').includes("from './nav.js");
    });
    if(width===320 && hasNav && !/name=["']viewport["'][^>]+viewport-fit=cover/.test(source)){
      bad++;
      console.log('✗ '+p+' טוען ניווט בלי viewport-fit=cover');
    }
    const ctx=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
    try {
      await ctx.route('**/firebasejs/**',r=>{const n=r.request().url().split('/').pop().split('?')[0];
        const q=path.join(STUB,n); r.fulfill({status:200,contentType:'text/javascript',body:fs.existsSync(q)?fs.readFileSync(q,'utf8'):'export default {};'});});
      await ctx.addInitScript(r=>{window.__SMOKE_ROLE=r;},'super');
      // patch לפני שקוד האפליקציה נטען, כדי לתפוס גם אלמנטים
      // שהופכים ללחיצים רק דרך JS (לא [onclick] סטטי).
      await ctx.addInitScript(()=>{
        window.__clickTargets=new Set();
        const orig=EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener=function(type,...rest){
          if(type==='click' && this instanceof Element) window.__clickTargets.add(this);
          return orig.call(this,type,...rest);
        };
      });
      const pg=await ctx.newPage();
      await pg.goto(base+'/'+p,{waitUntil:'load'});
      await pg.waitForTimeout(1600);
      // The optional callout dialog is absent on most pages. Do not spend the
      // default action timeout waiting for an element that is not displayed.
      const decline = pg.locator('#coNo');
      if (await decline.isVisible()) await decline.click({timeout:1000}).catch(()=>{});
      await pg.waitForTimeout(250);
      const r = await pg.evaluate(()=>{
        const de=document.documentElement;
        const nav=document.getElementById('appNav');
        // Chromium does not emulate iOS env(safe-area-*).  The production CSS
        // exposes the resolved inset through a private variable so this check
        // can exercise the exact layout formula with a 47px notch.
        if(nav) nav.style.setProperty('--resq-safe-top','47px');
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
        const first=nav&&nav.firstElementChild;
        const navBox=nav&&nav.getBoundingClientRect();
        const safe=nav?parseFloat(getComputedStyle(nav).paddingTop):0;
        const safeOk=!nav || (safe>=55 && first && first.getBoundingClientRect().top>=navBox.top+47);

    // --- 44x44 (הכרעת אלדד, לא ניחוש) ---
    const isVisible=(el)=>{
      const st=getComputedStyle(el);
      if(st.display==='none'||st.visibility==='hidden') return false;
      if(el.hasAttribute('hidden')) return false;
      if(parseFloat(st.opacity)===0) return false;
      const b=el.getBoundingClientRect();
      return b.width>0 && b.height>0;
    };
    const isDisabled=(el)=>!!(el.disabled || el.getAttribute('aria-disabled')==='true' || el.closest('[disabled]'));
    const FLOW_TAGS=new Set(['P','LI','TD','DD','SPAN','TH','BLOCKQUOTE','FIGCAPTION']);
    const isInlineTextLink=(el)=>{
      if(el.tagName!=='A') return false;
      const d=getComputedStyle(el).display;
      if(d==='block'||d==='flex'||d==='grid'||d==='inline-flex'||d==='inline-grid') return false;
      const parent=el.parentElement;
      if(!parent || !FLOW_TAGS.has(parent.tagName)) return false;
      const parentText=(parent.textContent||'').trim();
      const ownText=(el.textContent||'').trim();
      return (parentText.length-ownText.length) > 3;
    };
    const describe=(el)=>{
      const b=el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        sel: el.id?('#'+el.id):(el.className && typeof el.className==='string' ? '.'+el.className.trim().split(/\s+/)[0] : ''),
        text: (el.textContent||'').trim().slice(0,24),
        w: Math.round(b.width), h: Math.round(b.height)
      };
    };
    const candidates=new Set(document.querySelectorAll(
      'button,[role="button"],[role="tab"],a[href],select,input:not([type="hidden"]),textarea,[onclick]'
    ));
    (window.__clickTargets||new Set()).forEach(el=>{ if(document.body.contains(el)) candidates.add(el); });
    document.querySelectorAll('input[type="hidden"]').forEach(inp=>{
      let label=null;
      if(inp.id) label=document.querySelector('label[for="'+CSS.escape(inp.id)+'"]');
      if(!label) label=inp.closest('label');
      if(label) candidates.add(label);
    });
    const touch=[]; const bogusExempt=[];
    candidates.forEach(el=>{
      if(!isVisible(el) || isDisabled(el)) return;
      const exempt=el.getAttribute('data-touch-target-exempt');
      if(exempt!==null){
        if(!isInlineTextLink(el)) bogusExempt.push(describe(el));
        return;
      }
      if(isInlineTextLink(el)) return;
      const b=el.getBoundingClientRect();
      if(b.width<44 || b.height<44) touch.push(describe(el));
    });

        return {over, wide:wide.slice(0,4), nav:nav?Math.round(navBox.height):0, safeOk, touch, bogusExempt};
      });
      const ok = r.over<=0 && !r.wide.length && r.safeOk && !r.touch.length && !r.bogusExempt.length;
      if (!ok) bad++;
      console.log((ok?'✓':'✗')+' ['+width+'] '+p.padEnd(17)+' סרגל '+String(r.nav).padStart(3)+'px'+
                  (r.over>0?'  · גלישה '+r.over+'px':'')+
                  (r.wide.length?'  · רחב מדי: '+r.wide.join(' · '):'')+
                  (!r.safeOk?'  · אזור המכשיר אינו מוגן':''));
      if (r.touch.length) {
        touchBad += r.touch.length;
        for (const t of r.touch) {
          console.log('    44x44: '+p+' · '+t.tag+t.sel+' "'+t.text+'" · '+t.w+'x'+t.h+'px');
        }
        
      }
      if (r.bogusExempt.length) {
        touchBad += r.bogusExempt.length;
        for (const t of r.bogusExempt) {
          console.log('    חריג לא תקין: '+p+' · '+t.tag+t.sel+' "'+t.text+'" - data-touch-target-exempt מוצהר אך אינו קישור בתוך טקסט רציף');
        }
      }
    } finally {
      await ctx.close();
    }
  }
  }
  console.log('\n'+(bad?bad+' בדיקות מסך/רוחב שוברות את רוחב הטלפון (320/360/390)':'כל המסכים נכנסים בכל שלושת רחבי הטלפון (320/360/390)'));
  console.log(touchBad?touchBad+' רכיבים אינטראקטיביים מתחת ל-44x44 (או חריג לא תקין), ב-320/360/390':'כל הרכיבים האינטראקטיביים עומדים ב-44x44 בכל שלושת הרוחבים');
} finally {
  if (browser) await browser.close();
  if (srv.listening) await new Promise(resolve=>srv.close(resolve));
}
process.exitCode=(bad||touchBad)?1:0;
