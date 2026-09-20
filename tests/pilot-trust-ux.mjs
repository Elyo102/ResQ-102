/* ======================================================================
 *  pilot-trust-ux — מה שהמסך מבטיח חייב להיות מה שהמערכת עושה
 *
 *  ארבע טענות, ולכל אחת יש מקום בקוד שאפשר להצביע עליו:
 *
 *    1. המשתמש אינו רואה קוד שגיאה טכני. הוא הולך ל-console.
 *    2. מצב האימון אומר מה שקורה, כולל רשימת הפטורים — ואינו מבטיח
 *       „שום דבר לא יוצא החוצה", שזה פשוט לא נכון.
 *    3. אין הבטחת סנכרון offline, כי אין תור לקוח.
 *    4. הסרה רכה אומרת „הוסר" ולא „נמחק".
 *
 *  למה בדיקת מקור ולא בדיקת דפדפן: אלה טענות על **כל** המסכים, ולא
 *  על מסלול אחד. בדיקת דפדפן מוכיחה מסך אחד; היא רצה במקביל לזו
 *  (callout-lifecycle-browser) ואינה מחליפה אותה. מה שנבדק כאן הוא
 *  שאין מסך שנשכח.
 * ====================================================================== */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

/* מחרוזות שהמשתמש רואה — בלי הערות. הערה שמסבירה למה נמנעים
 * ממילה אינה שימוש במילה, ובדיקה שאינה מבחינה ביניהן תכשיל על
 * ההסבר במקום על הבאג. */
const bare = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const visibleStrings = (source) =>
  [...bare(source).matchAll(/'([^']*[\u0590-\u05FF][^']*)'/g)].map(m => m[1]);

let passed = 0;
const failures = [];
function check(name, value, detail) {
  if (value) { passed += 1; console.log('✓ ' + name); }
  else { failures.push(name); console.log('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

/* ---------- 1 · המילון ---------- */

const dictionary = read('error-text.js');

check('the dictionary covers every code the pilot package was asked to cover',
  ['unavailable', 'permission-denied', 'unauthenticated', 'deadline-exceeded',
    'resource-exhausted', 'aborted', 'failed-precondition', 'offline',
    'unsupported-browser', 'push-permission-denied']
    .every(code => new RegExp("'?" + code + "'?\\s*:").test(dictionary)));

/* ⭐ הטענה המרכזית של הקובץ הזה: אף הודעה במילון אינה מכילה קוד.
 * מחרוזת עם לוכסן באמצע מילים לועזיות היא בדיוק הצורה של
 * `functions/unavailable`, וזה מה שאסור שיגיע למסך. */
const messages = [...dictionary.matchAll(/^\s*(?:'[^']+'|[a-z-]+):\s*'([^']*)'/gm)].map(m => m[1]);
check('the dictionary holds at least a dozen actual sentences', messages.length >= 12,
  'found ' + messages.length);
check('and not one of them contains a technical error code',
  messages.every(text => !/[a-z]+\/[a-z-]+/.test(text)),
  JSON.stringify(messages.filter(text => /[a-z]+\/[a-z-]+/.test(text))));
check('every message is Hebrew, not a passed-through English string',
  messages.every(text => /[֐-׿]/.test(text)));
check('the technical detail has somewhere to go, and it is the console',
  /console\.error/.test(dictionary) && /export function logError/.test(dictionary));

/* ---------- 2 · פס הקריסה שב-13 מסכים ---------- */

const CRASH_SCREENS = ['access', 'admin', 'alerts', 'attendance', 'board', 'faults',
  'feedback', 'forms', 'guards', 'login', 'quals', 'stats', 'swaps'];

for (const screen of CRASH_SCREENS) {
  const source = read(screen + '.html');
  const bar = /\(function\(\)\{[\s\S]*?function boom\(what\)\{[\s\S]*?\}\)\(\);/.exec(source);
  if (!bar) { check(screen + '.html carries the shared crash bar', false); continue; }
  const block = bar[0];
  /* ⭐ הבדיקה שמונעת חזרה אחורה: `errRaw` הוא האלמנט שהציג את הקוד.
   * כל עוד הוא נכתב במחרוזת ריקה בלבד, אין דרך שקוד יגיע לשם. */
  const errRawWrites = [...block.matchAll(/errRaw'\)\.textContent\s*=\s*([^;]+);/g)].map(m => m[1].trim());
  check(screen + '.html writes nothing but an empty string into errRaw',
    errRawWrites.length === 1 && errRawWrites[0] === "''", JSON.stringify(errRawWrites));
  check(screen + '.html sends the technical detail to the console instead',
    /console\.error/.test(block) && /r\.code/.test(block));
  check(screen + '.html shows the person a Hebrew sentence',
    /boom\('[^']*[֐-׿]/.test(block));
}

/* ---------- 3 · קריאת פתע ---------- */

const callout = read('callout.js');
const console_ = read('callout-console.js');

check('the callout overlay no longer prints a raw code to the person',
  !/err\.code\s*\|\|\s*err\.message/.test(callout) || !/textContent\s*=\s*'[^']*'\s*\+\s*\n?\s*'\('/.test(callout));
check('and neither does the commander console',
  !/\(error\.code \|\| error\.message/.test(console_), 'still interpolating a code');
check('both take their wording from the one dictionary',
  /from '\.\/error-text\.js/.test(callout) && /from '\.\/error-text\.js/.test(console_));
for (const screen of ['swaps', 'forms', 'sign']) {
  const html = read(screen + '.html');
  check(screen + '.html imports the shared Hebrew error dictionary',
    /from '\.\/error-text\.js\?v=42h25'/.test(html));
  check(screen + '.html logs technical errors instead of showing them',
    /logError\(/.test(html));
  check(screen + '.html does not interpolate e.code/e.message into visible msg/say calls',
    !/msg\([^;\n]*(?:e|err|error)\.(?:code|message)/.test(html)
      && !/say\([^;\n]*(?:e|err|error)\.(?:code|message)/.test(html),
    'visible raw error interpolation remains');
}
check('the five agreed quick reasons exist in the source, in order',
  /'מחלה מאושרת'[\s\S]{0,400}'שירות מילואים'[\s\S]{0,400}'פטור מאושר'[\s\S]{0,400}'איני זמין בתחנה'[\s\S]{0,400}'אחר'/.test(callout));
check('the send button starts disabled and is driven by whether a reason exists',
  /id="coSend" disabled/.test(callout) && /send\.disabled = sending \|\| !reasonText\(\)/.test(callout));
check('an answer confirms on screen rather than only closing the dialog',
  /אישרת הגעה/.test(callout) && /הדחייה נשלחה/.test(callout));
/* ⭐ המקלדת. `visualViewport` הוא האירוע היחיד שבאמת מדווח עליה;
 * בלי המאזין הזה כפתור השליחה יושב מתחת למקלדת ב-320 ו-360. */
check('the on-screen keyboard is actually handled, not assumed away',
  /visualViewport/.test(callout) && /scrollIntoView/.test(callout));
check('the siren promises nothing about overriding silent mode',
  !/מצלצל גם בשקט|עוקף את השקט|עוצמה מרבית/.test(callout + read('callout.html')));

/* ---------- 4 · מצב האימון ---------- */

const modeBar = read('mode-bar.js');
const schedule = read('schedule-management.js');
check('the trial indicator lives in its own file, with no Firebase dependency',
  !/firebasejs/.test(modeBar) && /export function renderModeBar/.test(modeBar));

/* ⭐ החיווי הוא תגית בכותרת, לא באנר רוחב-מסך.
 *
 * הבדיקה מכוונת אל מה שנעלם ולא רק אל מה שנוסף: `has-mode-bar` היה
 * הסימן שדחף את כל התוכן למטה בכל מסך, והקיזוז שלו ב-`nav.js` הוא
 * מה שהיה נשאר יתום אם מישהו יחזיר רק חצי מהשינוי. */
const nav = read('nav.js');
check('the wide banner and the offset it forced are both gone',
  !/position:sticky[^']*width:100%/.test(modeBar)
    && !/has-mode-bar #appNav/.test(nav)
    && !/--resq-mode-bar-height/.test(nav));
check('the chip is a real 44×44 control with an explicit aria-label',
  /min-height:44px;min-width:44px/.test(modeBar)
    && /aria-label/.test(modeBar)
    && /TRIAL_ARIA = '\u05de\u05e6\u05d1 \u05d0\u05d9\u05de\u05d5\u05df \u05e4\u05e2\u05d9\u05dc'/.test(modeBar));
check('pressing it is what opens the explanation, and Escape closes it',
  /aria-expanded/.test(modeBar) && /'keydown'/.test(modeBar) && /Escape/.test(modeBar));
check('the explanation says exactly what trial mode does',
  /\u05e4\u05e2\u05d5\u05dc\u05d5\u05ea \u05e0\u05e9\u05de\u05e8\u05d5\u05ea \u05dc\u05d1\u05d3\u05d9\u05e7\u05d4 \u05d5\u05e0\u05e9\u05dc\u05d7\u05d5\u05ea \u05e8\u05e7 \u05dc\u05d7\u05e9\u05d1\u05d5\u05df \u05d4\u05d1\u05d3\u05d9\u05e7\u05d4 \u05d4\u05de\u05d0\u05d5\u05e9\u05e8/.test(modeBar));
/* התגית נעלמת עם הסרגל בכל בנייה מחדש. בלי ההחזרה הזו המסך חוזר
 * להיראות חי בדיוק ברגע שמישהו מתחלף. */
check('and it is put back every time the header is rebuilt',
  /^\s*attachModeChip\(\);\s*$/m.test(nav) && /export function attachModeChip/.test(modeBar));

/* ⭐ החריג המחייב: לפני פעולה חיה הניסוח המלא עדיין מוצג. תגית
 * מספיקה כדי לזכור; היא אינה מספיקה כדי לא לשדר לתחנה בטעות. */
check('a live broadcast still asks with the full trial wording',
  /TRIAL_BROADCAST_WARNING/.test(console_)
    && /isTrial\(\) && !window\.confirm\(TRIAL_BROADCAST_WARNING\)/.test(console_)
    && /\ud83e\uddea \u05e9\u05d9\u05d3\u05d5\u05e8 \u05d1\u05de\u05e6\u05d1 \u05d0\u05d9\u05de\u05d5\u05df/.test(modeBar));
check('and so does publishing a schedule',
  /TRIAL_PUBLISH_WARNING/.test(schedule)
    && /\ud83e\uddea \u05e4\u05e8\u05e1\u05d5\u05dd \u05d1\u05de\u05e6\u05d1 \u05d0\u05d9\u05de\u05d5\u05df/.test(modeBar));
/* ⭐ הניסוח הקודם אמר „שום דבר לא יוצא החוצה". זה לא נכון:
 * `setSilentMode` מקבל רשימת פטורים של עד 40 מזהים. */
check('and it no longer claims that nothing leaves the station',
  [modeBar, callout].every(source =>
    visibleStrings(source).every(text => !/שום דבר לא יוצא החוצה/.test(text))));
check('it says instead who does receive',
  visibleStrings(modeBar).some(text => /חשבון הבדיקה המאושר/.test(text)));

check('the schedule screen reads the station mode instead of assuming it is live',
  /notifications_mode/.test(schedule) && /renderModeBar/.test(schedule));
check('and it gets that mode from the server, not from a second Firestore listener',
  !/firebase-firestore/.test(schedule));
const runtime = read('functions/schedule-runtime.js');
check('the server reports the station mode from the public document only',
  /db\.doc\('config\/mode'\)/.test(runtime) && !/notificationsMode[\s\S]{0,400}config\/runtime/.test(runtime));
/* שם פרטי בתוך מחרוזת מוצר הוא באג במוצר רב-תחנתי. */
check('no product string names one particular person',
  ![schedule, callout, modeBar, read('import.html')]
    .some(source => visibleStrings(source).some(text => /אלדד/.test(text))));

/* ---------- 5 · „עודכן ע״י" ---------- */

check('the published-at line is derived from server fields and never invented',
  /function publishedLine\(active\)/.test(schedule)
    && /Number\.isFinite\(active\.published_at_ms\)/.test(schedule)
    && /if \(!at\) return '';/.test(schedule));
check('and the server actually returns those two fields',
  /published_at_ms/.test(runtime) && /published_by_name/.test(runtime));
check('the uid of whoever published is not shipped to the browser',
  !/activeView\.published_by\s*=/.test(runtime));

/* ---------- 6 · offline ---------- */

const bulletin = read('bulletin.js');
check('no screen promises that an unsent message waits in a queue',
  !/אפשר לנסות שוב כשהרשת תחזור/.test(bulletin)
    || /אינה ממתינה ברקע/.test(bulletin));
check('and it says plainly that nothing is queued in the background',
  (bulletin.match(/אינה ממתינה ברקע/g) || []).length >= 2);
check('no screen claims data was saved on the device while persistence is off',
  !/מציג מידע שמור/.test(bulletin)
    && !/מוצג המידע האחרון שהגיע למכשיר/.test(bulletin));
/* ⭐ והטענה שמאחורי כל זה: באמת אין תור. אם מישהו יוסיף אחד, הבדיקה
 * הזו תיפול — וזה הרגע לכתוב ניסוח אחר, לא לפני. */
const clientSources = fs.readdirSync(root)
  .filter(name => name.endsWith('.js') && !name.startsWith('firebase-messaging'))
  .map(name => read(name)).join('\n');
check('there is still no client-side queue, which is why the wording says so',
  !/registration\.sync|new SyncManager|persistentLocalCache|enableIndexedDbPersistence/.test(clientSources));

/* ---------- 7 · הסרה רכה ---------- */

const attachments = read('hr-attachments-ui.js');
const documents = read('hr-documents-ui.js');
/* הטענה המדויקת: אף משפט אינו אומר שהפריט נמחק. „אינה נמחקת" הוא
 * ההפך המוחלט מזה, והוא בדיוק המשפט שצריך להיות שם. */
const CLAIMS_DELETION = /(הקובץ|הנוהל|המסמך)\s+נמחק|מחיקת ה(קובץ|נוהל|מסמך)/;
check('removing a file never calls itself a deletion',
  visibleStrings(attachments).every(text => !CLAIMS_DELETION.test(text)));
check('removing a station procedure does not either',
  visibleStrings(documents).every(text => !CLAIMS_DELETION.test(text)));
check('and both say what really happens instead',
  visibleStrings(attachments).some(text => /יוסתר/.test(text))
    && visibleStrings(documents).some(text => /הוסר|יוסתר/.test(text)));
check('and the procedure removal says what really happens to the history',
  /ההיסטוריה נשמרת ואינה נמחקת/.test(documents));
/* ההרשאה במסך חייבת להיות אותה הרשאה שבשרת — ולא `manager`. */
/* ⭐ שתי הרשימות נמשכות מהקוד ומושוות כקבוצות. בדיקה שמחפשת מחרוזת
 * קבועה הייתה עוברת גם אם אחד הצדדים יתרחב; זו נופלת. */
const roleSet = (source, pattern) => {
  const match = pattern.exec(source);
  return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort().join(',') : null;
};
const uiRoles = roleSet(documents, /const procedureAuthority = s =>([^;]*);/);
const serverRoles = roleSet(read('functions/hr-documents.js'), /const procedureAuthority = ctx =>([^;]*);/);
check('the procedure removal button follows the server authority exactly',
  !!uiRoles && uiRoles === serverRoles, 'ui=' + uiRoles + ' server=' + serverRoles);

console.log('');
console.log('NOT RUN here — the screens themselves. This file checks the source across all of');
console.log('them; callout-lifecycle-browser.mjs and hr-documents-browser.mjs check the behaviour.');
console.log('');
if (failures.length) {
  console.error(failures.length + ' pilot trust UX checks failed.');
  process.exit(1);
}
console.log(passed + ' pilot trust UX checks passed.');
