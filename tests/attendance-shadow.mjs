import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const runner = read('functions/attendance-shadow-runner.js');
const engine = read('functions/attendance-shadow.js');
const index = read('functions/index.js');
const html = read('attendance-shadow.html');
const rules = read('firestore.rules');
const indexes = JSON.parse(read('firestore.indexes.json'));

let pass = 0, fail = 0;
function check(name, condition) {
  const ok = Boolean(condition);
  console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name);
  if (ok) pass++; else fail++;
}

console.log('\n\x1b[1m--- נוכחות 41A · גבולות בטיחות סטטיים ---\x1b[0m');

for (const name of [
  'getAttendanceShadowStatus', 'setAttendanceShadowMode',
  'runAttendanceShadowNow', 'attendanceShadowDaily'
]) {
  check('השרת מייצא ' + name, index.includes('exports.' + name + ' ='));
}
check('התזמון הקנוני הוא 05:30',
      index.includes("schedule: '30 5 * * *'") && index.includes("timeZone: 'Asia/Jerusalem'"));
check('מצב ברירת המחדל הוא כבוי',
      runner.includes("mode: value.mode === 'shadow' ? 'shadow' : 'off'"));
check('אין API להפעלה אוטומטית',
      runner.includes('auto_activation_allowed: false') && !index.includes('activateAutomaticAttendance'));

check('ה-runner אינו כותב ל-attendance',
      !/attendance['"`]\)\.doc\([^\n]+\)\.(?:set|update|delete)/.test(runner) &&
      !/(?:batch|tx)\.(?:set|update|delete)\([^\n]*attendance/.test(runner));
check('ה-runner אינו כותב ל-monthly_reports',
      !/(?:set|update|delete)[^\n]*monthly_reports/.test(runner));
check('מנוע החישוב טהור ללא Firebase',
      !/firebase-admin|firebase-functions|\.collection\(|\.doc\(/.test(engine));
check('התאמת זהות מצריכה UID ותאריך',
      engine.includes("String(record.uid || '') + '|' + String(record.date || '')") &&
      engine.includes("attendanceByUidDate[entry.uid + '|' + entry.date]") &&
      !engine.includes('record.emp_number === emp'));

check('כל chunk מוגן בבעלות transaction',
      runner.includes('assertRunOwner') && runner.includes('assertReportOwner'));
check('דוח אדם נשמר בדור מבודד',
      runner.includes("collection('attendance_shadow_generations')") &&
      runner.includes('active_generation_id: acquired.generationId'));
check('המסך קורא רק את הדור הפעיל',
      html.includes("expectedGeneration, 'attendance_shadow_people'") &&
      html.includes('report.active_generation_id'));
check('הלקוח אינו מייבא פעולות כתיבה ל-Firestore',
      !/\bsetDoc\b|\bupdateDoc\b|\bdeleteDoc\b|\bwriteBatch\b/.test(html));

check('חומר גלם חסום גם למנהל-על',
      /match \/attendance_shadow_runs\/\{runId\}[\s\S]*?allow read, write: if false;/.test(rules));
check('מסמך דור שרתי חסום ללקוח',
      /match \/attendance_shadow_generations\/\{generationId\}[\s\S]*?allow read, write: if false;/.test(rules));
check('דוח אדם בדור פתוח רק למבקר Shadow',
      /match \/attendance_shadow_generations\/\{generationId\}[\s\S]*?match \/attendance_shadow_people\/\{uid\}[\s\S]*?allow read:\s+if shadowAuditor\(sid\)/.test(rules));
check('מבקר Shadow נבדק מול כרטיס משתמש חי ולא רק מול טוקן',
      rules.includes('/users/$(request.auth.uid)).data') &&
      rules.includes("user.get('is_active', true) != false") &&
      rules.includes("user.get('role', '') == claim('role')"));

const ttlGroups = new Set(indexes.fieldOverrides
  .filter(item => item.ttl === true)
  .map(item => item.collectionGroup));
for (const group of [
  'attendance_shadow_runs', 'attendance_shadow_entries',
  'attendance_shadow_reports', 'attendance_shadow_generations',
  'attendance_shadow_people'
]) {
  check('TTL מוגדר ל-' + group, ttlGroups.has(group));
}
check('שדה issues אינו מאונדקס לחינם', indexes.fieldOverrides.some(item =>
  item.collectionGroup === 'attendance_shadow_people' && item.fieldPath === 'issues' &&
  Array.isArray(item.indexes) && item.indexes.length === 0));

console.log('\n' + (fail ? '✗ ' + fail + ' נכשלו' : '✓ כל ' + pass + ' בדיקות Shadow עברו') + '\n');
process.exit(fail ? 1 : 0);
