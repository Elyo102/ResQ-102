// ============================================================
//  לוח מודעות — לוגיקה טהורה
// ============================================================
//  רץ בלי דפדפן, רשת או Firebase. כאן נבדקים החוזים שאם הם
//  נשברים, שני לוחות יכולים להתערבב או זמן/תפקיד יוצגו שגוי.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(testsDir, '..');
const B = await import(pathToFileURL(join(appDir, 'bulletin.js')).href);
const R = await import(pathToFileURL(join(appDir, 'roles.js')).href);

let pass = 0, fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name +
              (ok || !detail ? '' : '   \x1b[2m' + detail + '\x1b[0m'));
  if (ok) pass++;
  else { fail++; failures.push(name); }
}
function equal(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
        'קיבלתי ' + JSON.stringify(got) + ' · ציפיתי ' + JSON.stringify(want));
}
function head(text) { console.log('\n\x1b[1m--- ' + text + '\x1b[0m'); }

head('1 · טקסט וקטגוריות');
equal('הודעה תקינה מתקבלת ונחתכת בקצוות',
      B.validateBulletinText('  ציוד הגיע למחסן  '),
      { ok:true, text:'ציוד הגיע למחסן', error:'' });
equal('הודעה ריקה נחסמת', B.validateBulletinText('  \n ').error, 'empty');
const htmlText = '<img src=x onerror=alert(1)>';
const htmlResult = B.validateBulletinText(htmlText);
check('HTML זדוני נשאר טקסט חוקי ולא מפיל את המאמת',
      htmlResult.ok === true && htmlResult.text === htmlText);
check('בדיוק 2,000 תווים מתקבלים',
      B.validateBulletinText('א'.repeat(2000)).ok === true);
equal('2,001 תווים נחסמים',
      B.validateBulletinText('א'.repeat(2001)).error, 'too_long');
equal('הטקסט מנורמל ל-NFC כמו בשרת',
      B.validateBulletinText('e\u0301').text, '\u00e9');

const categories = Array.isArray(B.CATEGORIES) ? B.CATEGORIES : [];
equal('חמש הקטגוריות הן החוזה של השרת',
      categories.map(c => c.id),
      ['general','supplies','equipment','vehicle','maintenance']);
check('לכל קטגוריה תווית עברית',
      categories.every(c => typeof c.label === 'string' && /[\u0590-\u05ff]/.test(c.label)));
check('לכל קטגוריה אייקון תצוגה',
      categories.every(c => typeof c.icon === 'string' && c.icon.length > 0));
check('רשימת הקטגוריות אינה ניתנת לשינוי בטעות', Object.isFrozen(categories));

head('2 · שם תפקיד וזמן');
equal('תפקיד כבאי מוצג בעברית', R.roleHe('firefighter'), 'לוחם אש');
equal('מפקד משמרת מוצג בעברית', R.roleHe('commander'), 'קצין / מפקד משמרת');
equal('תפקיד לא מוכר אינו מומצא', R.roleHe('external_role'), 'external_role');

const iso = '2026-08-25T09:30:00.125Z';
const millis = Date.parse(iso);
equal('זמן Firestore עם toMillis', B.messageTimeMs({ toMillis:() => millis }), millis);
equal('זמן Firestore עם seconds/nanoseconds',
      B.messageTimeMs({ seconds:Math.floor(millis / 1000), nanoseconds:125000000 }), millis);
equal('אובייקט Date', B.messageTimeMs(new Date(iso)), millis);
equal('מספר אלפיות שנייה', B.messageTimeMs(millis), millis);
equal('חותמת ISO', B.messageTimeMs(iso), millis);

head('3 · בידוד תחנה ולוח');
const draftMain = B.draftStorageKey('uid-a', 'eilat_102', 'rashit');
const draftShahmon = B.draftStorageKey('uid-a', 'eilat_102', 'shahmon');
const draftOtherStation = B.draftStorageKey('uid-a', 'beer_sheva_101', 'rashit');
const draftOtherUser = B.draftStorageKey('uid-b', 'eilat_102', 'rashit');
check('טיוטה מבודדת בין לוחות באותה תחנה', draftMain !== draftShahmon);
check('טיוטה מבודדת בין תחנות', draftMain !== draftOtherStation);
check('טיוטה מבודדת בין משתמשים באותו מכשיר', draftMain !== draftOtherUser);
equal('מפתח טיוטה יציב', B.draftStorageKey('uid-a', 'eilat_102', 'rashit'), draftMain);
check('מפתח טיוטה משתמש בגרסת v2', draftMain.startsWith('resq_bulletin_draft:v2:'));

const fakeItems = new Map([
  ['resq_bulletin_draft:eilat_102:rashit', 'legacy-secret'],
  [draftMain, 'draft-a'],
  [draftOtherUser, 'draft-b'],
  ['unrelated', 'keep']
]);
const fakeStorage = {
  get length(){ return fakeItems.size; },
  key(index){ return Array.from(fakeItems.keys())[index] ?? null; },
  removeItem(key){ fakeItems.delete(key); }
};
equal('ניקוי legacy מסיר מפתח ישן אחד', B.purgeLegacyBulletinDrafts(fakeStorage), 1);
check('טיוטת legacy אינה מועברת למשתמש מחובר', !fakeItems.has('resq_bulletin_draft:eilat_102:rashit'));
check('ניקוי legacy שומר טיוטות v2 של שני משתמשים',
      fakeItems.has(draftMain) && fakeItems.has(draftOtherUser));

const readMain = B.readStorageKey('uid-a', 'eilat_102', 'rashit');
const readShahmon = B.readStorageKey('uid-a', 'eilat_102', 'shahmon');
const readOtherStation = B.readStorageKey('uid-a', 'beer_sheva_101', 'rashit');
const readOtherUser = B.readStorageKey('uid-b', 'eilat_102', 'rashit');
check('סימון נקרא מבודד בין לוחות', readMain !== readShahmon);
check('סימון נקרא מבודד בין תחנות', readMain !== readOtherStation);
check('סימון נקרא מבודד בין משתמשים באותו מכשיר', readMain !== readOtherUser);
check('סימון נקרא משתמש בגרסת v2', readMain.startsWith('resq_bulletin_read:v2:'));
check('מפתחות טיוטה ולא-נקרא אינם מתנגשים', draftMain !== readMain);

const fakeReadItems = new Map([
  ['resq_bulletin_read:eilat_102:rashit', '123'],
  [readMain, '456'],
  [readOtherUser, '789'],
  ['unrelated', 'keep']
]);
const fakeReadStorage = {
  get length(){ return fakeReadItems.size; },
  key(index){ return Array.from(fakeReadItems.keys())[index] ?? null; },
  removeItem(key){ fakeReadItems.delete(key); }
};
equal('ניקוי legacy מסיר סימון קריאה משותף אחד',
      B.purgeLegacyBulletinReads(fakeReadStorage), 1);
check('ניקוי legacy שומר סימוני v2 של שני משתמשים',
      fakeReadItems.has(readMain) && fakeReadItems.has(readOtherUser));

head('4 · תחנת משנה פעילה');
check('רשומה רגילה פעילה כברירת מחדל', B.subStationAvailable({ name:'ראשית' }));
for (const inactive of [
  { is_active:false }, { active:false }, { archived:true },
  { status:'inactive' }, { status:'ARCHIVED' }
]) {
  check('סימן legacy לארכוב חוסם את התחנה ' + JSON.stringify(inactive),
        !B.subStationAvailable(inactive));
}
check('ערך שאינו רשומה אינו תחנה פעילה', !B.subStationAvailable(null));

head('5 · סדר ולא-נקרא');
const messages = [
  { id:'new', text:'חדש', by_uid:'u2', hidden:false,
    created_at:{ toMillis:() => Date.parse('2026-08-25T09:00:00.000Z') } },
  { id:'old', text:'ישן', by_uid:'u1', hidden:false,
    created_at:{ seconds:Date.parse('2026-08-25T07:00:00.000Z') / 1000, nanoseconds:0 } },
  { id:'hidden', text:'מוסתר', by_uid:'u3', hidden:true,
    created_at:'2026-08-25T10:00:00.000Z' }
];
const ordered = B.sortBulletinMessages(messages);
equal('מיון הלוח הוא מהחדש לישן', ordered.map(m => m.id), ['hidden','new','old']);
equal('המיון אינו משנה את מערך המקור', messages.map(m => m.id), ['new','old','hidden']);
equal('הודעה מוסתרת אינה נספרת כחדשה',
      B.bulletinUnreadCount(messages,
        Date.parse('2026-08-25T06:00:00.000Z'), 'u9'), 2);
equal('מה שאני כתבתי אינו נספר כלא-נקרא',
      B.bulletinUnreadCount(messages,
        Date.parse('2026-08-25T06:00:00.000Z'), 'u2'), 1);
equal('בלי סימון קריאה קודם לא מציגים מספר מטעה',
      B.bulletinUnreadCount(messages, 0, 'u9'), 0);
equal('חותמת החדשה ביותר מחושבת על הפיד הגלוי שנמסר',
      B.newestBulletinTime(messages.filter(m => !m.hidden)),
      Date.parse('2026-08-25T09:00:00.000Z'));

console.log('\n\x1b[1m════════════════════════════════════\x1b[0m');
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m  ✓ כל ' + pass + ' בדיקות לוח המודעות עברו\x1b[0m');
} else {
  console.log('\x1b[31m\x1b[1m  ✗ ' + fail + ' נכשלו · ' + pass + ' עברו\x1b[0m');
  failures.forEach(name => console.log('    ' + name));
}
console.log('\x1b[1m════════════════════════════════════\x1b[0m\n');
process.exit(fail ? 1 : 0);
