# F-01 — Vehicle history photos (lazy load)

## סיכום
פתיחת היסטוריית רכב / `damageReport` / `subjectReport` / כרטיסי רשימה **לא** קוראת יותר `getDocs` על `.../photos`.
טעינת כל התמונות של תקלה בודדת קורית רק בפתיחת פירוט (לחיצה על «הצג» ב-`faults.html`, או `openFault` ב-`vehicle.html`).

## לפני / אחרי (מודל + mock)

| מסלול | לפני (מודל ~501 תקלות, ~251 עם photos) | אחרי (מדידה ב-mock) |
|---|---|---|
| פתיחת היסטוריה / damageReport | 501 × `getDocs(/photos)` בתרחיש הבדיקה | **0** |
| פתיחת תקלה אחת (detail) | (כבר חלק מה-251) | **1** `getDocs` + כל התמונות מצוירות |
| `vehicle.html` renderList | N × getDocs לכל כרטיס עם photos | **0** |
| `vehicle.html` openFault | 1 (חלש, בלי SID/AUTH_GEN) | **1** עם מפתח `SID:faultId` + AUTH_GEN |

קובץ מספרי מהרצה אחת: `docs/F01-metrics.json`. הבדיקה עצמה אינה משנה קבצים.


## תוצאות הרצה (mock, Asia/Jerusalem)
```json
{
  "N_faults_with_photos": 501,
  "before_model_photo_getDocs_on_history_open": 501,
  "after_history_photo_getDocs": 0,
  "after_detail_photo_getDocs": 1,
  "history_open_ms_p50": 357,
  "history_open_ms_p95": 357,
  "detail_open_ms_p50": 44,
  "detail_open_ms_p95": 44
}
```
- לפני (מודל N=501): **501** getDocs(/photos) בפתיחת היסטוריה
- אחרי: **0** בפתיחת היסטוריה; **1** בפתיחת תקלה אחת
- הזמנים הם דגימה אחת ב־mock, ולכן ערכי p50/p95 הזהים אינם מדד ביצועי ייצור.

## מה תוקן
- `faults.html` `faultCard`: placeholder ממספר `photos` בלבד; `loadShots` רק בלחיצה.
- `vehicle.html`: בלי prefetch ב-`renderList`; טעינה רק ב-`openFault` (`loadPhotos:true`).
- `vehicle.html` `loadShots`: מפתח מטמון `stationId:faultId`, `shotsInflight`, `AUTH_GEN` + `bumpIdentity` (ניקוי shots/inflight + revoke object URLs אם היו), דחיית תשובה מאוחרת **לפני** כתיבה למטמון ולפני paint.
- גם תקלה בלי נקודת מיקום נפתחת מהרשימה; סגירת פרטים ומעבר זהות מבטלים תשובה מאוחרת, וטעינת רשימת תחנה קודמת לא צובעת את התחנה החדשה.
- בלי `onSnapshot` על photos / היסטוריה מלאה.
- נשאר Firestore photos תחת `member(sid)` — בלי Storage signed URL / callable לעקיפת Rules.

## מדידת board / faults (הצעה בלבד — לא יושם rewrite)
- `board.html` `loadStatic`: 6 × `getDocs` מקבילים — `faults`, `redline_waivers`, `quals`, `roster`, `member_quals`, `sub_stations` (+ `getDoc` ל-board/mode וכו׳ מחוץ לרשימה הזו).
- `faults.html` `loadAll`: אוסף faults + board + vehicles + handovers (לא photos).
- **הצעה:** אין pagination על photos (כבר lazy). ל-board — לאחד/להקטין רק אם מדידת שטח (לא production station-102) תוכיח p95 אינטראקטיבי מעל יעד; מועמדים חלשים ל-lazy: `member_quals` / `redline_waivers` אם המסך לא מציג אותם מיד. **לא יושם** כאן — measure+propose בלבד.

## בדיקות
```bash
cd tests
node f01-vehicle-history-photos-browser.mjs
```
(דורש Playwright כמו שאר ה-browser harnesses.)

## סיכונים / לא נבדק
- UX: בהיסטוריה צריך לחיצה נוספת להצגת תמונות (מכוון).
- לא נמדד על station-102 / production (בידוד בלבד; cost probe OFF).
- `subjectReport` משתמש באותו `faultCard` — מכוסה בקוד; תרחיש Playwright מפורש רק ל-damageReport + vehicle openFault.
- זיכרון base64 של תמונות אחרי detail — ללא שינוי מודל נתונים.

## סטטוס
| פריט | סטטוס |
|---|---|
| F-01 lazy history photos | WRITTEN / LOCAL_TESTED |
| AUTH_GEN port ל-vehicle.html | WRITTEN / LOCAL_TESTED |
| Regression harness | WRITTEN / LOCAL_TESTED |
| Board pagination | OPEN (הצעה בלבד) |
| Deploy / production verify | OPEN — לא deploy, לא push |
