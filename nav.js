// סרגל ניווט משותף.
//
// עד עכשיו כל מסך היה כתובת נפרדת שאלדד שלח ידנית. זו לא
// מערכת — זו ערימת דפים, וכבאי לא יזכור אף אחת מהכתובות.
//
// הסרגל הזה יושב בראש כל מסך, ומראה רק את מה שהתפקיד של
// המשתמש מתיר. מי שאינו רשאי — לא רואה את הכפתור מלכתחילה,
// וגם אם יקליד את הכתובת ידנית, כללי האבטחה בשרת יעצרו אותו.
// ההסתרה כאן היא נוחות, לא הגנה.

// נקודת הצבע היא זיהוי מהיר של מדור, לא קישוט. כפתור צבעוני
// שלם לכל מדור היה גורם לארבעה כפתורים להתחרות זה בזה, ואז
// אף אחד לא בולט.
const ITEMS = [
  { href: 'login.html',    label: 'הבית',        who: 'any',    dot: '#e8590c' },
  { href: 'schedule.html', label: 'סידור', who: 'member', dot: '#4d94ff' },
  { href: 'board.html',    label: 'ציוות',       who: 'member', dot: '#c77dff' },
  { href: 'attendance.html', label: 'נוכחות',     who: 'member', dot: '#ffd166' },
  { href: 'guards.html',   label: 'אבטחות',      who: 'member', dot: '#7cb342' },
  { href: 'faults.html',   label: 'תקלות',       who: 'member', dot: '#ff7043' },
  { href: 'forms.html',    label: 'טפסים',       who: 'member', dot: '#26a69a' },
  { href: 'swaps.html',    label: 'החלפות',      who: 'member', dot: '#4dd0e1' },
  { href: 'quals.html',    label: 'כשירויות',    who: 'member', dot: '#e0a23c' },
  { href: 'alerts.html',   label: 'התראות',      who: 'member', dot: '#b0bec5' },
  { href: 'access.html',   label: 'גישה',   who: 'staff',  dot: '#35c46b' },
  { href: 'admin.html',    label: 'ניהול',       who: 'staff',  dot: '#f0523f' },
  { href: 'stats.html',    label: 'נתונים',      who: 'staff',  dot: '#ba68c8' },
  { href: 'check.html',    label: 'בדיקה', who: 'super',  dot: '#9aa0a6' }
];

// מה שהשרת מתיר בפועל. מפקד מחוז אינו staff באף כלל אבטחה
// היום — הצגת הכפתורים לו הייתה שולחת אותו לשלושה מסכים
// שכולם נחסמים, ואחד מהם אף מציג הודעה שגויה.
const STAFF_ROLES = ['deputy', 'commander', 'station_commander',
                     'hr_coordinator'];

function allowed(who, claims) {
  const isSuper = claims.super === true || claims.role === 'super_admin';
  if (who === 'any')    return true;
  if (who === 'super')  return isSuper;
  if (who === 'staff')  return isSuper || STAFF_ROLES.indexOf(claims.role) !== -1;
  // בדיוק אותה רשימה כמו member() בכללי האבטחה. מפקד מחוז אינו
  // כלול, ולכן אסור להציג לו "סידור עבודה" — הוא ייחסם בשרת.
  if (who === 'member') {
    return isSuper ||
           ['firefighter', 'deputy', 'commander', 'station_commander',
     'hr_coordinator'].indexOf(claims.role) !== -1;
  }
  return false;
}

function styleOnce() {
  if (document.getElementById('navStyle')) return;
  const st = document.createElement('style');
  st.id = 'navStyle';
  // גובה הכפתור 44 פיקסלים — המינימום שאצבע פוגעת בו באמינות
  // על מסך טלפון, וכבאי לא ייגש למערכת ממחשב.
  st.textContent = [
    // align-self:stretch נחוץ כי בדף הכניסה הגוף הוא flex ממורכז,
    // ובלעדיו הסרגל היה מתכווץ לרוחב התוכן שלו.
    '#appNav{position:sticky;top:0;z-index:900;display:flex;gap:8px;',
    '  align-items:center;flex-wrap:wrap;box-sizing:border-box;',
    '  align-self:stretch;flex:none;',
    '  background:var(--card);border-bottom:1px solid var(--line);',
    '  padding:12px 16px;margin:-18px -18px 18px;',
    '  font-family:"Segoe UI",Arial,sans-serif;direction:rtl}',
    '#appNav .brand{font-weight:800;font-size:17px;color:var(--txt);',
    '  letter-spacing:-.01em;margin-inline-end:8px;white-space:nowrap}',
    '#appNav .brand b{color:var(--accent);font-weight:800}',
    // כללי הרוחב והשוליים כתובים במפורש: לדפים יש חוקים גורפים
    // כמו button{width:100%} שאחרת בולעים את הכפתור לשורה שלמה.
    '#appNav button.back{display:inline-flex;align-items:center;gap:6px;',
    '  width:auto;margin:0;flex:none;',
    '  background:transparent;border:1px solid var(--line-hover);color:var(--dim);',
    '  font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;',
    '  padding:10px 14px;border-radius:10px;white-space:nowrap}',
    '#appNav button.back:hover{background:var(--line);color:var(--txt)}',
    '#appNav button.back:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '#appNav a{display:inline-flex;align-items:center;gap:8px;',
    '  color:var(--dim);text-decoration:none;font-size:15.5px;font-weight:600;',
    '  padding:11px 18px;border-radius:10px;white-space:nowrap;',
    '  width:auto;margin:0;flex:none;',
    '  background:var(--chip);border:1px solid var(--line);',
    '  transition:transform .12s ease,background .12s ease,color .12s ease}',
    '#appNav a:hover{transform:translateY(-1px);background:var(--line);color:var(--txt)}',
    '#appNav a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '#appNav a i{width:8px;height:8px;border-radius:50%;flex:none}',
    '#appNav a.on{background:var(--accent);border-color:var(--accent);color:var(--on-accent);',
    '  box-shadow:0 3px 12px rgba(232,89,12,.32)}',
    '#appNav a.on i{background:var(--on-accent)}',
    '#appNav .me{margin-inline-start:auto;color:var(--muted);font-size:13px;',
    '  white-space:nowrap}',
    '@media (prefers-reduced-motion:reduce){',
    '  #appNav a{transition:none}',
    '  #appNav a:hover{transform:none}}',
    '@media (max-width:520px){',
    '  #appNav{gap:6px;padding:10px 12px}',
    '  #appNav a{font-size:14px;padding:10px 13px}',
    '  #appNav .me{width:100%;margin-inline-start:0;order:9;padding-top:2px}}'
  ].join('');
  document.head.appendChild(st);
}

// current — שם הקובץ הנוכחי, למשל 'admin.html'.
// who     — טקסט קצר שמזהה את המשתמש, מוצג בקצה הסרגל.
export function renderNav(claims, current, who) {
  styleOnce();
  claims = claims || {};

  const old = document.getElementById('appNav');
  if (old) old.remove();

  const nav = document.createElement('nav');
  nav.id = 'appNav';

  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = '<b>ResQ</b> \u00b7 102';
  nav.appendChild(brand);

  // חזרה. מופיע רק כשיש לאן לחזור — כפתור שלא עושה כלום גרוע
  // מכפתור שלא קיים.
  if (window.history.length > 1) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back';
    back.textContent = '→ חזרה';
    back.onclick = function () { window.history.back(); };
    nav.appendChild(back);
  }

  ITEMS.forEach(function (it) {
    if (!allowed(it.who, claims)) return;
    const a = document.createElement('a');
    a.href = './' + it.href;

    const dot = document.createElement('i');
    dot.style.background = it.dot;
    a.appendChild(dot);
    a.appendChild(document.createTextNode(it.label));

    if (it.href === current) a.className = 'on';
    nav.appendChild(a);
  });

  nav.appendChild(themeButton());

  if (who) {
    const m = document.createElement('div');
    m.className = 'me';
    m.textContent = who;
    nav.appendChild(m);
  }

  document.body.insertBefore(nav, document.body.firstChild);
}

// ---------- בהיר / כהה ----------
//
// שלושה מצבים ולא שניים: "לפי הטלפון" הוא ברירת המחדל, ורק
// מי שרוצה משהו אחר בוחר. מתג של שני מצבים היה מכריח כל אחד
// לבחור, ואז מי שהחליף פעם אחת נשאר תקוע בבחירה גם כשהטלפון
// שלו כבר עבר למצב אחר.
//
// הבחירה נשמרת במכשיר בלבד. היא העדפה של עין, לא נתון של
// המערכת, ואין סיבה שתיסע בין מכשירים.

// תווית טקסט ולא סמל. סמלי שמש וירח אינם קיימים בכל גופן
// מערכת, ומי שהגופן שלו לא מכיר אותם רואה ריבוע ריק —
// כפתור שאי אפשר לדעת מה הוא עושה.
const MODES = [
  { id: 'auto',  label: 'אוטו׳', he: 'לפי הטלפון' },
  { id: 'dark',  label: 'כהה',   he: 'כהה תמיד' },
  { id: 'light', label: 'בהיר',  he: 'בהיר תמיד' }
];

export function readTheme() {
  try { return localStorage.getItem('resq_theme') || 'auto'; }
  catch (e) { return 'auto'; }
}

export function applyTheme(mode) {
  const r = document.documentElement;
  if (mode === 'dark' || mode === 'light') r.setAttribute('data-theme', mode);
  else r.removeAttribute('data-theme');
  try { localStorage.setItem('resq_theme', mode); } catch (e) {}
}

function themeButton() {
  const cur = readTheme();
  const m = MODES.filter(function (x) { return x.id === cur; })[0] || MODES[0];

  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'themeBtn';
  b.textContent = m.label;
  b.title = 'תצוגה: ' + m.he + ' — לחץ להחלפה';
  b.setAttribute('aria-label', b.title);
  b.onclick = function () {
    const i = MODES.findIndex(function (x) { return x.id === readTheme(); });
    const next = MODES[(i + 1) % MODES.length];
    applyTheme(next.id);
    b.textContent = next.label;
    b.title = 'תצוגה: ' + next.he + ' — לחץ להחלפה';
    b.setAttribute('aria-label', b.title);
  };
  return b;
}

export function clearNav() {
  const old = document.getElementById('appNav');
  if (old) old.remove();
}

// סרגל מינימלי למסכי "אין הרשאה". בלעדיו המשתמש תקוע עם
// כפתור התנתקות בלבד, ואין לו דרך לחזור למסך הבית.
export function renderStuckNav(who) {
  renderNav({}, '', who);
}
