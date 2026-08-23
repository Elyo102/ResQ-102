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

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDY13rUZCN0q2Izo8i59JHKmWvnu_0Tw7Q",
  authDomain: "station-102.firebaseapp.com",
  projectId: "station-102",
  storageBucket: "station-102.firebasestorage.app",
  messagingSenderId: "52676411962",
  appId: "1:52676411962:web:73d3c0b2a51d7524ac2b03"
});

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
