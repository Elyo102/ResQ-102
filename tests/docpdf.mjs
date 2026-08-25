// ============================================================
//  הפקת מסמך חתום
// ============================================================
//  המסמך המודפס הוא מה שיוצג בוועדה, בתיק האישי או מול
//  משאבי אנוש. שני דברים חייבים להיות נכונים בו תמיד:
//  שהוא מראה את מה שנחתם ולא משהו אחר, ושחתימה בשם אדם
//  אחר מסומנת ככזאת. השאר הוא עיצוב.

import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
import { pathToFileURL } from 'url';

const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');

const D = await import(pathToFileURL(__j(__APP, 'docpdf.js')).href);
const F = await import(pathToFileURL(__j(__APP, 'forms.js')).href);

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

const IMG = 'data:image/png;base64,AAAA';

const sub = {
  id: 'sub_1',
  form_id: 'leave', form_he: 'בקשת חופשה', kind: 'vacation',
  values: { from: '2026-09-10', to: '2026-09-12', where: 'בארץ',
            why: 'חתונה של אחי' },
  signatures: {
    employee:  { image: IMG, uid: 'u1', name: 'אלדד יונה', emp: '101',
                 role: 'firefighter', at: '2026-09-01T07:30:00.000Z' },
    commander: { image: IMG, uid: 'u2', name: 'רחמים חנן', emp: '201',
                 role: 'commander',   at: '2026-09-01T09:15:00.000Z' }
  },
  status: 'approved',
  by_uid: 'u1', by_name: 'אלדד יונה', by_emp: '101', crew: 'א',
  created_key: '2026-09-01T07:30:00.000Z',
  decided_by_name: 'רחמים חנן', decided_key: '2026-09-01T09:15:00.000Z'
};

const leave = F.formById(null, 'leave');
const LABELS = { employee: 'הכבאי', commander: 'ראש המשמרת',
                 station_commander: 'מפקד התחנה' };

head('1 · מה נכנס למסמך');

const d = D.submissionDoc(sub, leave, {
  station: 'תחנה 102 · אילת', statusHe: 'אושרה',
  crewHe: 'משמרת א', labels: LABELS });

is('הכותרת היא שם הטופס', d.title, 'בקשת חופשה');
is('מספר המסמך נשמר',      d.docId, 'sub_1');
is('שם המגיש בפרטים',
   d.meta.filter(r => r[0] === 'שם המגיש')[0][1], 'אלדד יונה');
is('כל שדות הטופס שמולאו נכנסו', d.rows.length, 4);
is('תאריך מוצג בעברית ולא ISO',
   d.rows.filter(r => r[0] === 'מתאריך')[0][1], '10.9.2026');
is('טקסט חופשי עובר כמו שהוא',
   d.rows.filter(r => r[0] === 'הערה')[0][1], 'חתונה של אחי');

head('2 · החתימות');

is('שני שלבים חתומים',  d.signatures.filter(s => s.rec && s.rec.image).length, 2);
is('התוויות בעברית',    d.signatures[0].label, 'הכבאי');
is('החותם השני הוא ראש המשמרת', d.signatures[1].rec.name, 'רחמים חנן');
// מפקד התחנה אינו בשרשרת של חופשה בארץ, ולכן אינו מופיע
// כבלוק ריק. בלוק ריק במסמך מודפס נראה כמו חתימה שחסרה.
is('מפקד התחנה אינו מופיע בחופשה בארץ', d.signatures.length, 2);

const abroad = JSON.parse(JSON.stringify(sub));
abroad.values.where = 'בחו״ל';
abroad.signatures.station_commander =
  { image: IMG, uid: 'u3', name: 'מפקד התחנה', emp: '301',
    role: 'station_commander', at: '2026-09-02T10:00:00.000Z' };
const dA = D.submissionDoc(abroad, leave, { labels: LABELS });
is('בחו״ל — שלוש חתימות', dA.signatures.length, 3);

head('3 · חתימה בשם אדם אחר');

const onb = JSON.parse(JSON.stringify(sub));
onb.signatures.employee.on_behalf_of   = 'u1';
onb.signatures.employee.on_behalf_name = 'אלדד יונה';
onb.signatures.employee.reason         = 'לא חתם עד סוף החודש';
const hOnb = D.buildDocHtml(D.submissionDoc(onb, leave, { labels: LABELS }));
is('המסמך אומר בשם מי נחתם', hOnb.indexOf('נחתם בשם') !== -1, true);
is('והסיבה מודפסת',          hOnb.indexOf('לא חתם עד סוף החודש') !== -1, true);

head('4 · מסמך ישן, לפני מבנה השרשרת');

const legacy = { id: 'old_1', form_he: 'דוח נזק', values: { where: 'החניון' },
                 signature: IMG, by_name: 'אלדד יונה', by_emp: '101',
                 created_key: '2025-04-02T06:00:00.000Z' };
const dL = D.submissionDoc(legacy, F.formById(null, 'damage_rep'), { labels: LABELS });
is('חתימה שטוחה עדיין מוצגת', dL.signatures.length, 1);
is('ולא כ"לא נחתם"',          !!dL.signatures[0].rec.image, true);

head('5 · שדה שנשמר בהגשה ואינו קיים בטופס היום');

// טופס שהשתנה אחרי שנחתם. מה שנחתם — נחתם, והמסמך חייב
// להראות אותו. השמטה שקטה כאן פירושה מסמך שאינו העתק.
const extra = JSON.parse(JSON.stringify(sub));
extra.values.old_field = 'ערך משדה שהוסר';
const dE = D.submissionDoc(extra, leave, { labels: LABELS });
is('שדה שהוסר מהטופס עדיין מודפס',
   dE.rows.filter(r => r[1] === 'ערך משדה שהוסר').length, 1);

head('6 · ה-HTML עצמו');

const html = D.buildDocHtml(d);
is('מסמך שלם',            html.slice(0, 15), '<!DOCTYPE html>');
is('כיוון ימין לשמאל',    html.indexOf('dir="rtl"') !== -1, true);
is('הכותרת בתוך title',   html.indexOf('<title>בקשת חופשה</title>') !== -1, true);
is('תמונת החתימה מוטמעת', html.indexOf(IMG) !== -1, true);
is('בלי משאבים חיצוניים',
   /https?:\/\//.test(html.replace(/data:[^"']*/g, '')), false);
is('החתימות לא נחתכות בין עמודים',
   html.indexOf('page-break-inside:avoid') !== -1, true);

// הזרקת HTML דרך שדה טופס. מי שכותב <script> בשדה "הערה"
// לא אמור להריץ אותו במסמך של מישהו אחר.
const evil = JSON.parse(JSON.stringify(sub));
evil.values.why = '<script>alert(1)</script>';
const hEvil = D.buildDocHtml(D.submissionDoc(evil, leave, { labels: LABELS }));
is('🔒 HTML בשדה טופס אינו מורץ',
   hEvil.indexOf('<script>alert') === -1, true);
is('והוא כן מוצג כטקסט',
   hEvil.indexOf('&lt;script&gt;') !== -1, true);

console.log('\n\x1b[1m════════════════════════════════════\x1b[0m');
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m  ✓ כל ' + pass + ' הבדיקות עברו\x1b[0m');
} else {
  console.log('\x1b[31m\x1b[1m  ✗ ' + fail + ' נכשלו · ' + pass + ' עברו\x1b[0m');
  bad.forEach(b => console.log('    ' + b));
}
console.log('\x1b[1m════════════════════════════════════\x1b[0m\n');
process.exit(fail === 0 ? 0 : 1);
