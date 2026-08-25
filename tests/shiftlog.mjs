// ============================================================
//  לוג המשמרת
// ============================================================
//  זה בא להחליף קבוצת ווטסאפ שבה מתנהל תיאום אמיתי בין
//  מפקדים. שני דברים חייבים להיות נכונים: שההיסטוריה
//  נשמרת כמו שהיא, ושלוחם אש לא יכול לכתוב בה.
//  הכתיבה נאכפת בכללי האבטחה; כאן נבדק כל השאר.

import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
import { pathToFileURL } from 'url';

const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');

const L = await import(pathToFileURL(__j(__APP, 'shiftlog.js')).href);

let pass = 0, fail = 0;
const bad = [];

function is(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name +
              (ok ? '' : '   \x1b[2mקיבלתי ' + JSON.stringify(got) +
                         ' · ציפיתי ' + JSON.stringify(want) + '\x1b[0m'));
  ok ? pass++ : (fail++, bad.push(name));
}
function head(t) { console.log('\n\x1b[1m--- ' + t + '\x1b[0m'); }

const ME = { uid: 'u1', full_name: 'רחמים חנן', role: 'commander',
             crew: 'א', vehicle: 'כבאית 5' };

// ============================================================
head('1 · אימות ההודעה');
// ============================================================

is('הודעה תקינה עוברת',        L.validateMessage('בוקר טוב'), '');
is('🔒 הודעה ריקה נחסמת',      L.validateMessage('') !== '', true);
is('🔒 רווחים בלבד נחסמים',    L.validateMessage('   \n  ') !== '', true);
is('🔒 הודעה ארוכה מדי נחסמת',
   L.validateMessage('א'.repeat(L.MAX_TEXT + 1)) !== '', true);
is('בדיוק על הגבול עוברת',
   L.validateMessage('א'.repeat(L.MAX_TEXT)), '');

// ============================================================
head('2 · מבנה ההודעה');
// ============================================================

const d = L.messageDoc('  שלום  ', ME, '2026-09-01T08:00:00.000Z');
is('רווחים בקצוות נחתכים', d.text, 'שלום');
is('נשמר מי כתב',          d.by_name, 'רחמים חנן');
is('נשמר התפקיד',          d.by_role, 'commander');
is('נשמר הרכב לתצוגה',     d.by_vehicle, 'כבאית 5');
is('🔒 הודעת לקוח היא תמיד chat', d.kind, 'chat');
is('אינה מוסתרת מלכתחילה', d.hidden, false);
is('יש חותמת זמן',         d.created_key, '2026-09-01T08:00:00.000Z');

// לקוח שמנסה לזייף הודעת מערכת. גם אם יעקוף את המסך,
// הכלל בשרת יחסום אותו — אבל המבנה כאן לא נותן לו דרך
// בכלל.
const forged = L.messageDoc('המערכת אומרת', Object.assign({ kind: 'system' }, ME));
is('🔒 אי אפשר לבקש kind אחר דרך me', forged.kind, 'chat');

// ============================================================
head('3 · סדר, הסתרה וקיבוץ');
// ============================================================

const MSGS = [
  { text: 'ג', by_uid: 'u2', created_key: '2026-09-02T09:00:00.000Z' },
  { text: 'א', by_uid: 'u1', created_key: '2026-09-01T08:00:00.000Z' },
  { text: 'ב', by_uid: 'u2', created_key: '2026-09-01T20:00:00.000Z' },
  { text: 'מוסתרת', by_uid: 'u2', hidden: true,
    created_key: '2026-09-02T10:00:00.000Z' }
];

is('מסודר מהישן לחדש',  L.visible(MSGS).map(m => m.text), ['א','ב','ג']);
is('🔒 מוסתרת אינה מוצגת',
   L.visible(MSGS).filter(m => m.text === 'מוסתרת').length, 0);

const days = L.groupByDay(MSGS, new Date(2026, 8, 3));
is('שני ימים',            days.length, 2);
is('היום הראשון קודם',    days[0].dayKey, '2026-09-01');
is('שתי הודעות ביום הראשון', days[0].items.length, 2);
is('תווית יום בעברית',    days[0].label, 'יום שלישי · 1.9.2026');
is('"אתמול" מזוהה',
   L.dayLabel('2026-09-02', new Date(2026, 8, 3)), 'אתמול');
is('"היום" מזוהה',
   L.dayLabel('2026-09-03', new Date(2026, 8, 3)), 'היום');
is('השעה נחתכת מהחותמת', L.timeOf(MSGS[0]), '09:00');

// ============================================================
head('4 · לא-נקראו');
// ============================================================

is('בלי סימון קודם — אפס',
   L.unreadCount(MSGS, '', 'u1'), 0);
is('שתי הודעות אחרי הסימון',
   L.unreadCount(MSGS, '2026-09-01T08:00:00.000Z', 'u3'), 2);
is('מה שאני כתבתי אינו נספר',
   L.unreadCount(MSGS, '2026-08-31T00:00:00.000Z', 'u1'), 2);
is('🔒 מוסתרת אינה נספרת',
   L.unreadCount(MSGS, '2026-09-02T00:00:00.000Z', 'u3'), 1);
is('החדשה ביותר',
   L.newestKey(MSGS), '2026-09-02T09:00:00.000Z');
is('רשימה ריקה אינה מפילה', L.newestKey([]), '');

// אחסון חסום — חלון פרטי, דפדפן שחוסם אחסון. חייב להחזיר
// ריק ולא לזרוק, אחרת המסך כולו נופל.
const savedLS = globalThis.localStorage;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get() { throw new Error('blocked'); }
});
is('אחסון חסום — קריאה מחזירה ריק', L.lastRead('s1'), '');
let threw = false;
try { L.markRead('s1', 'x'); } catch (e) { threw = true; }
is('אחסון חסום — כתיבה אינה זורקת', threw, false);
if (savedLS === undefined) delete globalThis.localStorage;
else Object.defineProperty(globalThis, 'localStorage',
       { configurable: true, value: savedLS });

// ============================================================
head('5 · הודעות המערכת');
// ============================================================

const SW = { from_name: 'אלדד', to_name: 'רמי',
             from_date: '2026-09-12', to_date: '2026-09-14' };

is('פרסום כולל את השם והתאריך',
   L.swapSystemText('open', SW), 'אלדד פרסם בקשת החלפה ל-12.9.');
is('אישור מציין את שני הצדדים ואת שני התאריכים',
   L.swapSystemText('approved', SW),
   '✅ ההחלפה אושרה: אלדד ↔ רמי · 12.9 מול 14.9.');
is('דחייה מציינת את שני הצדדים',
   L.swapSystemText('rejected', SW).indexOf('אלדד') !== -1 &&
   L.swapSystemText('rejected', SW).indexOf('רמי') !== -1, true);
is('בלי שמות — לא נשבר',
   L.swapSystemText('open', {}).indexOf('undefined') === -1, true);
is('מצב לא מוכר מחזיר ריק', L.swapSystemText('nope', SW), '');

console.log('\n\x1b[1m════════════════════════════════════\x1b[0m');
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m  ✓ כל ' + pass + ' הבדיקות עברו\x1b[0m');
} else {
  console.log('\x1b[31m\x1b[1m  ✗ ' + fail + ' נכשלו · ' + pass + ' עברו\x1b[0m');
  bad.forEach(b => console.log('    ' + b));
}
console.log('\x1b[1m════════════════════════════════════\x1b[0m\n');
process.exit(fail === 0 ? 0 : 1);
