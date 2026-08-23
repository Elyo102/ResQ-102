// התקנה על מסך הבית.
//
// שני עולמות, ורק אחד מהם משתף פעולה:
//
//   אנדרואיד   הדפדפן מציע להתקין בעצמו, ונותן לנו אירוע
//              שאפשר לתפוס ולהציג כפתור משלנו
//   אייפון     אין אירוע ואין ממשק. הדרך היחידה היא שהמשתמש
//              ילחץ שיתוף ← הוסף למסך הבית, ואם לא נגיד לו
//              את זה במפורש — הוא לא ימצא
//
// לכן זה לא "כפתור התקנה" אלא שני מסלולים שונים שנראים דומה.
//
// ולמה בכלל: כבאי לא יזכור כתובת. אייקון על המסך הוא ההבדל
// בין מערכת שנכנסים אליה לבין קישור ששולחים בוואטסאפ.

let deferred = null;

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

export function isIOS() {
  const ua = String(navigator.userAgent || '');
  // אייפד מודרני מדווח על עצמו כמק. מגע הוא מה שמבדיל.
  return /iPhone|iPad|iPod/.test(ua) ||
         (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// רושם את ה-Service Worker. אותו עובד שמטפל בהתראות מטפל גם
// במטמון — דפדפן מרשה אחד לכל תחום.
export function registerSW() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('./firebase-messaging-sw.js')
    .catch(function (e) {
      console.warn('SW registration: ' + (e && e.message));
      return null;
    });
}

// מציג שורת הזמנה להתקנה. מחזיר true אם הוצגה.
//
// לא מציג למי שכבר התקין, ולא למי שסגר את ההצעה — הצעה
// שחוזרת בכל כניסה היא הצעה שמכבים.
export function offerInstall(opts) {
  const o = opts || {};
  if (isStandalone()) return false;

  let dismissed = false;
  try { dismissed = localStorage.getItem('resq_install_off') === '1'; }
  catch (ignore) {}
  if (dismissed && !o.force) return false;

  const ios = isIOS();
  if (!ios && !deferred && !o.force) return false;   // אנדרואיד בלי אירוע

  const bar = document.createElement('div');
  bar.id = 'pwaBar';
  bar.innerHTML =
    '<div class="ic">📲</div>' +
    '<div class="tx">' +
      '<b>התקן את ResQ על מסך הבית</b>' +
      '<span>' + (ios
        ? 'לחץ על כפתור השיתוף למטה, ואז «הוסף למסך הבית».'
        : 'ייפתח כמו אפליקציה, בלי שורת כתובת.') + '</span>' +
    '</div>' +
    (ios ? '' : '<button class="go" id="pwaGo">התקן</button>') +
    '<button class="x" id="pwaX" aria-label="סגור">&times;</button>';

  style();
  document.body.appendChild(bar);

  const go = document.getElementById('pwaGo');
  if (go) {
    go.onclick = async function () {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (ignore) {}
      deferred = null;
      bar.remove();
    };
  }
  document.getElementById('pwaX').onclick = function () {
    try { localStorage.setItem('resq_install_off', '1'); } catch (ignore) {}
    bar.remove();
  };
  return true;
}

function style() {
  if (document.getElementById('pwaStyle')) return;
  const st = document.createElement('style');
  st.id = 'pwaStyle';
  st.textContent = [
    '#pwaBar{position:fixed;inset-inline:12px;bottom:12px;z-index:9000;',
    '  display:flex;align-items:center;gap:12px;direction:rtl;',
    '  background:#1e2126;border:1px solid #2c3036;border-radius:13px;',
    '  padding:13px 15px;box-shadow:0 10px 34px rgba(0,0,0,.45);',
    '  font-family:"Segoe UI",Arial,sans-serif;max-width:520px;',
    '  margin-inline:auto}',
    '#pwaBar .ic{font-size:26px;flex:none;line-height:1}',
    '#pwaBar .tx{flex:1;min-width:0}',
    '#pwaBar .tx b{display:block;color:#e8eaed;font-size:14.5px;',
    '  font-weight:700;margin-bottom:2px}',
    '#pwaBar .tx span{display:block;color:#9aa0a6;font-size:12.5px;',
    '  line-height:1.6}',
    '#pwaBar .go{flex:none;width:auto;margin:0;background:#e8590c;',
    '  border:1px solid #e8590c;color:#fff;border-radius:9px;',
    '  padding:10px 18px;font-family:inherit;font-size:14px;',
    '  font-weight:700;cursor:pointer}',
    '#pwaBar .x{flex:none;width:auto;margin:0;background:transparent;',
    '  border:0;color:#9aa0a6;font-size:22px;cursor:pointer;',
    '  padding:0 4px;line-height:1}',
    '#pwaBar .x:hover{color:#e8eaed}',
    '@media (max-width:420px){',
    '  #pwaBar{gap:9px;padding:11px 12px}',
    '  #pwaBar .ic{font-size:21px}}'
  ].join('');
  document.head.appendChild(st);
}

// נקרא פעם אחת בכל מסך. תופס את אירוע ההתקנה של אנדרואיד
// לפני שהדפדפן מציג את ההצעה שלו, ורושם את העובד.
export function initPWA(opts) {
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
  });
  registerSW();

  // ההצעה מחכה לרגע שהמשתמש כבר בפנים. שורה שקופצת על מסך
  // הכניסה מפריעה למי שרק רוצה להתחבר.
  if (opts && opts.offer) {
    setTimeout(function () { offerInstall(); }, 2500);
  }
}
