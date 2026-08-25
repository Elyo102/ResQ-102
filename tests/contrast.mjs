// בדיקת ניגודיות — הפער שגילה אלדד ולא הכלים.
//
// כל הבדיקות עד היום רצו בערכה הכהה, כי היא ברירת המחדל.
// הערכה הבהירה נבדקה בעין פעם אחת, וכל צבע שנוסף אחריה
// נכתב מול הרקע הכהה בלבד. התוצאה חזרה שלוש פעמים באותו
// דפוס: צבע בהיר קבוע (#ffffff, #e8c78a, #7bc47f) על רקע
// שהוא כהה בלילה ובהיר ביום — ולכן ביום הטקסט נעלם.
//
// זה לא נראה כמו באג. זה נראה כמו טקסט חסר, או כמו מסך
// "לא מסודר" — וזו בדיוק המילה שבה אלדד תיאר את זה.
//
// הבדיקה טוענת כל מסך **בערכה הבהירה**, עוברת על כל צומת
// טקסט גלוי, ומחשבת את יחס הניגודיות מול הרקע האפקטיבי
// (ההורה הראשון שיש לו רקע לא שקוף).
//
// הסף הוא WCAG AA: 4.5 לטקסט רגיל, 3.0 לטקסט גדול
// (18.66px ומעלה מודגש, או 24px ומעלה). לא בגלל תקן —
// בגלל שזה הסף שמתחתיו טקסט מפסיק להיקרא במסך טלפון
// באור יום, וזה בדיוק תנאי העבודה של כבאי בחצר התחנה
// באילת.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');



const ROOT = __APP, STUB = __j(__TESTS, "stub"), PORT = 8293;
const T = { '.html':'text/html; charset=utf-8', '.js':'text/javascript',
            '.css':'text/css', '.json':'application/json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('no'); return; }
  r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'text/plain' });
  r.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(PORT, r));

const SCREENS = ['login.html','schedule.html','board.html','attendance.html',
                 'guards.html','faults.html','forms.html','swaps.html',
                 'quals.html','alerts.html','stats.html','people.html',
                 'vehicle.html','admin.html','access.html','import.html',
                 'check.html'];

// חריגים מתועדים. כל אחד כאן הוא החלטה, לא השתקה.
const ALLOW = [
  // מציין מקום בשדה קלט — אמור להיות דהוי, וזו כל מטרתו.
  { why: 'placeholder', test: n => n.ph },
  // טקסט מושבת. הדהייה **היא** המידע.
  { why: 'disabled',    test: n => n.dis }
];

function lum(c){
  const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]);
}
function ratio(a, b){
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
}

const b = await chromium.launch();
let bad = 0, checked = 0;

for (const screen of SCREENS) {
  const ctx = await b.newContext({ viewport:{ width:390, height:900 }, locale:'he-IL' });
  await ctx.route('**/firebase-*.js', r => {
    const n = path.basename(new URL(r.request().url()).pathname);
    r.fulfill({ status:200, contentType:'text/javascript',
                body: fs.readFileSync(path.join(STUB, n), 'utf8') });
  });
  await ctx.route('https://www.gstatic.com/**', r => {
    const n = path.basename(new URL(r.request().url()).pathname)
      .replace('-compat','').replace('.js','') + '.js';
    const p = path.join(STUB, n);
    r.fulfill({ status:200, contentType:'text/javascript',
                body: fs.existsSync(p) ? fs.readFileSync(p,'utf8') : '' });
  });
  const pg = await ctx.newPage();
  // super — הוא רואה הכי הרבה מסכים, ולכן הכי הרבה טקסט.
  // הערכה הבהירה נכפית מראש, לפני הציור הראשון.
  await pg.addInitScript(() => {
    window.__SMOKE_ROLE = 'super';
    try { localStorage.setItem('resq_theme','light'); } catch(e){}
    document.documentElement.setAttribute('data-theme','light');
  });
  await pg.goto('http://localhost:'+PORT+'/'+screen, { waitUntil:'load' });
  await pg.waitForTimeout(1700);

  const found = await pg.evaluate(() => {
    const out = [];
    const parse = (s) => {
      const m = String(s).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(x => parseFloat(x));
      return { rgb: [p[0],p[1],p[2]], a: p.length > 3 ? p[3] : 1 };
    };
    // הרקע האפקטיבי: ההורה הראשון עם רקע לא שקוף. טקסט על
    // אלמנט שקוף יורש את מה שמאחוריו, וחישוב מול "שקוף"
    // היה מחזיר תשובה חסרת משמעות.
    const bgOf = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a >= 0.95) return c.rgb;
        n = n.parentElement;
      }
      const c = parse(getComputedStyle(document.body).backgroundColor);
      return c ? c.rgb : [255,255,255];
    };
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    let t;
    while ((t = walk.nextNode())) {
      const txt = (t.nodeValue || '').trim();
      if (!txt) continue;
      const el = t.parentElement;
      if (!el) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (parseFloat(st.opacity) < 0.35) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // אלמנט שאב שלו מוסתר לא מדווח על עצמו — בדיקת גובה
      // מול offsetParent תופסת גם את זה.
      if (!el.offsetParent && st.position !== 'fixed') continue;
      const key = el.tagName + '|' + st.color + '|' + txt.slice(0,20);
      if (seen.has(key)) continue;
      seen.add(key);
      const fg = parse(st.color);
      if (!fg || fg.a < 0.95) continue;
      const size = parseFloat(st.fontSize);
      const weight = parseInt(st.fontWeight, 10) || 400;
      out.push({
        txt: txt.slice(0, 34), fg: fg.rgb, bg: bgOf(el), size,
        big: size >= 24 || (size >= 18.66 && weight >= 700),
        ph: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA',
        dis: !!el.closest('[disabled],.disabled,:disabled'),
        where: el.className || el.tagName.toLowerCase()
      });
    }
    return out;
  });

  const hits = [];
  for (const n of found) {
    if (ALLOW.some(a => a.test(n))) continue;
    checked++;
    const r = ratio(n.fg, n.bg);
    const need = n.big ? 3.0 : 4.5;
    if (r < need) hits.push({ ...n, r: Math.round(r*100)/100, need });
  }

  if (!hits.length) {
    console.log('✓ ' + screen.padEnd(17) + found.length + ' צמתי טקסט');
  } else {
    bad += hits.length;
    console.log('✗ ' + screen.padEnd(17) + hits.length + ' מתחת לסף');
    for (const h of hits.slice(0, 6)) {
      console.log('    ' + h.r + ':1 (נדרש ' + h.need + ') · ' +
                  String(h.where).slice(0, 26) + ' · "' + h.txt + '"');
      console.log('      טקסט rgb(' + h.fg.join(',') + ')  רקע rgb(' + h.bg.join(',') + ')');
    }
    if (hits.length > 6) console.log('    ועוד ' + (hits.length - 6) + '.');
  }
  await ctx.close();
}

await b.close(); srv.close();
console.log('');
if (bad) {
  console.log('נמצאו ' + bad + ' מקומות שבהם טקסט לא נקרא בערכה הבהירה.');
  process.exit(1);
}
console.log('כל הטקסט במערכת נקרא בערכה הבהירה · ' + checked + ' נבדקו');
