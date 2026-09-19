# אייקונים — Android

**תבנית — לא נוצר פרויקט; `npx cap add` לא הורץ; build NOT RUN.**

אין קבצי תמונה בתיקייה הזאת. משתמשים באותם קבצים שה-PWA כבר מגישה מהשורש
של הריפו (מקור אחד, בלי כפילות):

| שימוש | קובץ בשורש הריפו | הערה |
|---|---|---|
| `ic_launcher` (legacy) | `resq-512.png` | מוקטן ל-mipmap-*dpi על ידי כלי ה-Asset Studio, לא ידנית |
| `ic_launcher` adaptive foreground | `resq-maskable.png` | כבר עם שוליים בטוחים (`purpose: maskable` ב-manifest.json) |
| adaptive background | צבע אחיד `#0f1b33` (`theme_color` של manifest.json) | — |
| splash | `resq-logo.png` על רקע `#15171a` (`background_color`) | — |
| התראה (small icon) | נגזרת מונוכרומטית של `resq-192.png` | Android דורש צללית לבנה; יש ליצור בכלי, לא בריפו |

RTL: ה-WebView מקבל את `dir="rtl"` מהדף עצמו; `android:supportsRtl="true"` בתבנית
ה-manifest נועד רק לרכיבי המערכת (splash, דיאלוגים).

אסור להוסיף כאן PNG שאינו קיים בשורש — `tests/public-assets.json` מגדיר מה ציבורי.
