// סרגל ניווט משותף.
//
// עד עכשיו כל מסך היה כתובת נפרדת שאלדד שלח ידנית. זו לא
// מערכת — זו ערימת דפים, וכבאי לא יזכור אף אחת מהכתובות.
//
// הסרגל הזה יושב בראש כל מסך, ומראה רק את מה שהתפקיד של
// המשתמש מתיר. מי שאינו רשאי — לא רואה את הכפתור מלכתחילה,
// וגם אם יקליד את הכתובת ידנית, כללי האבטחה בשרת יעצרו אותו.
// ההסתרה כאן היא נוחות, לא הגנה.

const ITEMS = [
  { href: 'login.html',    label: 'הבית',        who: 'any'   },
  { href: 'schedule.html', label: 'סידור עבודה', who: 'member'},
  { href: 'access.html',   label: 'בקרת גישה',   who: 'staff' },
  { href: 'admin.html',    label: 'ניהול',       who: 'staff' },
  { href: 'check.html',    label: 'בדיקת מערכת', who: 'super' }
];

const STAFF_ROLES = ['commander', 'hr_coordinator', 'district_commander'];

function allowed(who, claims) {
  const isSuper = claims.super === true || claims.role === 'super_admin';
  if (who === 'any')    return true;
  if (who === 'super')  return isSuper;
  if (who === 'staff')  return isSuper || STAFF_ROLES.indexOf(claims.role) !== -1;
  if (who === 'member') return isSuper || !!claims.role;
  return false;
}

function styleOnce() {
  if (document.getElementById('navStyle')) return;
  const st = document.createElement('style');
  st.id = 'navStyle';
  st.textContent = [
    '#appNav{position:sticky;top:0;z-index:900;display:flex;gap:6px;',
    '  align-items:center;flex-wrap:wrap;',
    '  background:#1a1d21;border-bottom:1px solid #2c3036;',
    '  padding:8px 14px;margin:-18px -18px 18px;',
    '  font-family:"Segoe UI",Arial,sans-serif;direction:rtl}',
    '#appNav .brand{font-weight:700;font-size:15px;color:#e8eaed;',
    '  margin-inline-end:10px;white-space:nowrap}',
    '#appNav a{color:#9aa0a6;text-decoration:none;font-size:14px;',
    '  padding:7px 12px;border-radius:6px;white-space:nowrap}',
    '#appNav a:hover{background:#24282d;color:#e8eaed}',
    '#appNav a.on{background:#e8590c;color:#fff}',
    '#appNav .me{margin-inline-start:auto;color:#9aa0a6;font-size:12.5px;',
    '  white-space:nowrap}'
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
  brand.textContent = 'תחנה 102';
  nav.appendChild(brand);

  ITEMS.forEach(function (it) {
    if (!allowed(it.who, claims)) return;
    const a = document.createElement('a');
    a.href = './' + it.href;
    a.textContent = it.label;
    if (it.href === current) a.className = 'on';
    nav.appendChild(a);
  });

  if (who) {
    const m = document.createElement('div');
    m.className = 'me';
    m.textContent = who;
    nav.appendChild(m);
  }

  document.body.insertBefore(nav, document.body.firstChild);
}

export function clearNav() {
  const old = document.getElementById('appNav');
  if (old) old.remove();
}
