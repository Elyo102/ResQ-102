// Service Worker להתראות פוש.
//
// חייב לשבת בשורש התיקייה שממנה מוגש האתר. ב-GitHub Pages
// הכתובת היא elyo102.github.io/ResQ-102/, ולכן התחום שלו הוא
// /ResQ-102/ — בדיוק מה שהאפליקציה צריכה.
//
// הקובץ הזה רץ מחוץ לדף. הוא לא רואה את המשתנים שלו, לא מייבא
// מודולים, ולא יכול לקרוא firebase-config.js. לכן ההגדרות
// משוכפלות כאן — וזה בכוונה, לא בהיסח דעת. אם מזהה הפרויקט
// ישתנה, צריך לשנות בשני מקומות, וזו העלות של איך שדפדפנים
// בנויים.

// ------------------------------------------------------------------
//  מטמון — האפליקציה על מסך הבית
// ------------------------------------------------------------------
//
// למה כאן ולא ב-Service Worker נפרד: דפדפן מרשה **עובד אחד
// לכל תחום**. רישום עובד שני על אותו תחום היה מבטל את הראשון,
// וההתראות היו מפסיקות לעבוד בלי שאיש ישים לב.
//
// אסטרטגיה: רשת קודם, מטמון כגיבוי.
//
// כבאי שנכנס לסידור בשלוש לפנות בוקר חייב לראות את הסידור
// **הנוכחי**. מטמון-קודם היה מהיר יותר ומציג לו לפעמים סידור
// של אתמול — וסידור ישן גרוע מטעינה איטית.
//
// המטמון קיים בשביל מצב אחר: אין קליטה. אז עדיף מסך ישן עם
// הודעה ברורה מאשר דף שגיאה של הדפדפן.

const CACHE = 'resq-v38';

// רק קבצי המעטפת. נתונים לא נשמרים כאן לעולם — הם מגיעים
// מ-Firestore, שמנהל מטמון משלו ויודע מתי הוא מיושן.
const SHELL = [
  './login.html', './schedule.html', './board.html', './attendance.html',
  './guards.html', './faults.html', './forms.html', './swaps.html',
  './quals.html', './alerts.html', './stats.html', './people.html',
  './vehicle.html', './sign.html',
  './index.html',
  './nav.js', './rotation.js', './readiness.js', './hours.js',
  './guards.js', './faults.js', './forms.js', './stats.js',
  // חתימות, הפקת מסמכים, תפקידים ולוג המשמרת. בלי אלה,
  // מסך הטפסים ומסך ההחלפות נשברים לגמרי במצב לא מקוון —
  // הם מייבאים אותם, וייבוא שנכשל עוצר את כל המודול.
  './signature.js', './signflow.js', './docpdf.js',
  './roles.js', './shiftlog.js', './appcheck.js',
  './push.js', './callout.js', './stations.js', './firebase-config.js',
  './firebase-sw-config.js',
  './theme.css', './pwa.js', './version.js', './vmap.js',
  './manifest.json', './resq-192.png', './favicon.ico'
];

self.addEventListener('install', function (e) {
  // addAll נכשל כולו אם קובץ אחד חסר. כאן כל קובץ נשמר
  // בנפרד, כדי שקובץ שהוסר לא ישבור את ההתקנה כולה.
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return c.add(u).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Firestore, Auth ו-Functions לעולם לא נשמרים. תשובה
  // שמורה מהם היא נתון ישן שמתחזה לנוכחי.
  if (url.origin !== self.location.origin) return;
  if (/firestore|googleapis|identitytoolkit/.test(url.href)) return;
  // מספר הגרסה לעולם לא נשמר. כל המנגנון של "יש עדכון" מבוסס
  // על כך שהקובץ הזה מגיע מהשרת — עותק שמור שלו היה גורם
  // לאפליקציה לדווח "אתה מעודכן" בדיוק כשהיא לא.
  if (/\/version\.json/.test(url.pathname)) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        // דף שלא במטמון ואין רשת. הודעה בעברית עדיפה על
        // מסך הדינוזאור.
        if (req.mode === 'navigate') {
          return new Response(
            '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<body style="margin:0;background:#15171a;color:#e8eaed;' +
            'font-family:Segoe UI,Arial,sans-serif;display:flex;' +
            'align-items:center;justify-content:center;height:100vh;' +
            'text-align:center;padding:24px">' +
            '<div><div style="font-size:44px;margin-bottom:12px">📡</div>' +
            '<div style="font-size:19px;font-weight:700;margin-bottom:8px">' +
            'אין חיבור לרשת</div>' +
            '<div style="font-size:14px;color:#9aa0a6;line-height:1.7">' +
            'המסך הזה עוד לא נשמר במכשיר.<br>' +
            'התחבר לרשת ונסה שוב.</div></div></body></html>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        return new Response('', { status: 504 });
      });
    })
  );
});


importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
importScripts('./firebase-sw-config.js');

firebase.initializeApp(self.RESQ_FIREBASE_CONFIG);

const messaging = firebase.messaging();

// התראה שמגיעה כשהאפליקציה סגורה או ברקע.
//
// השרת שולח data בלבד ולא notification, כדי שהדפדפן לא יצייר
// התראה משלו בנוסף לזו שאנחנו מציירים — אחרת המשתמש מקבל
// שתי התראות זהות על אותו אירוע.
messaging.onBackgroundMessage(function (payload) {
  const d = (payload && payload.data) || {};
  const title = d.title || 'ResQ';
  self.registration.showNotification(title, {
    body: d.body || '',
    icon: './resq-180.png',
    badge: './resq-180.png',
    dir: 'rtl',
    lang: 'he',
    tag: d.tag || 'resq',
    data: { url: d.url || './login.html' },
    // התראה דחופה נשארת על המסך עד שנוגעים בה, ומרטיטה.
    // קריאת פתע היא המקרה שבשבילו זה קיים.
    requireInteraction: d.important === '1',
    renotify: d.important === '1',
    vibrate: d.important === '1'
      ? [300, 120, 300, 120, 500] : undefined
  });
});

// לחיצה על ההתראה פותחת את המסך הרלוונטי. אם האפליקציה כבר
// פתוחה בלשונית — מתמקדים בה במקום לפתוח עוד אחת.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './login.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
            c.navigate(url);
            return c.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
      })
  );
});
