// =====================================================================
//  App Check — הוכחה שהבקשה הגיעה מהאפליקציה ולא מסקריפט
// =====================================================================
//
//  כללי האבטחה בודקים **מי** אתה. App Check בודק **מאיפה** הבקשה
//  הגיעה. שתי שאלות שונות: כלל תקין עדיין מרשה למי שהשיג טוקן
//  להריץ סקריפט שקורא נתונים בלולאה, מהיר משכל אדם.
//
//  הקובץ הזה מאותחל מכל מסך בשורה אחת, מיד אחרי initializeApp.
//
//  ⚙️ שלושה צעדים, בסדר הזה. הפוך — והאפליקציה נחסמת לכולם:
//
//  1. ספק reCAPTCHA Enterprise מסוג SCORE רשום ב-Firebase
//     ומוגבל לדומיינים של ResQ בלבד.
//
//  2. לאחר הפריסה מחכים יום-יומיים. בקונסולה, תחת Metrics,
//     בודקים שבקשות Firestore ו-Auth מסווגות
//     כ-Verified. **אל תפעיל אכיפה כל עוד יש שם Unverified.**
//
//  3. רק כשהמונה נקי — הפעל Enforce על Firestore ועל Functions.
//
//  כל עוד המפתח ריק, הקובץ אינו עושה דבר. זו החלטה מכוונת:
//  אתחול חלקי היה גרוע ממצב שבו הוא כבוי, כי הוא היה מייצר
//  טוקנים לא תקפים ומכשיל בקשות בלי סיבה נראית לעין.

export const RECAPTCHA_SITE_KEY = '6Lfk8JotAAAAAFizQN_Bxb_d7hKei8EntKGyeZhN';

// מפתח ניפוי לפיתוח מקומי. reCAPTCHA לא עובד מ-localhost, ולכן
// בפיתוח משתמשים בטוקן ניפוי שנרשם בקונסולה תחת Debug tokens.
// חייב להישאר false בייצור.
const USE_DEBUG_TOKEN = false;

let ready = null;

export function initAppCheck(app) {
  if (!RECAPTCHA_SITE_KEY) return null;   // לא מוגדר — לא נוגעים
  if (ready) return ready;

  ready = (async () => {
    try {
      const m = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js');

      if (USE_DEBUG_TOKEN) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;

      const ac = m.initializeAppCheck(app, {
        provider: new m.ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
        // חידוש אוטומטי. בלעדיו הטוקן פג באמצע משמרת, והכבאי
        // רואה שגיאת הרשאה בלי שום דבר שהשתנה אצלו.
        isTokenAutoRefreshEnabled: true
      });

      console.log('App Check Enterprise פעיל');
      return ac;
    } catch (e) {
      // כישלון כאן לא יפיל את המסך. אם האכיפה מופעלת בשרת,
      // הבקשות ייחסמו ממילא ויופיע מסך שגיאה ברור; ואם היא
      // כבויה, אין סיבה למנוע מכבאי לדווח שעות בגלל
      // שסקריפט של גוגל לא נטען.
      console.warn('App Check לא אותחל: ' + (e && e.message));
      return null;
    }
  })();

  // Observability starts only after the existing App Check setup settles.
  // Never await this optional import or change the App Check return value.
  void ready.then(() => import('./monitoring-bootstrap.js?v=42h0'))
    .then(m => m.startMonitoring(app)).catch(() => {});
  return ready;
}
