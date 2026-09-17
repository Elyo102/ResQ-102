// בדיקת release-stamp.mjs — Release identity Scope 12 (closure batch
// item 3). כל הבדיקה עובדת בזיכרון, על Map של תוכן קבצים, ולא נוגעת
// בדיסק האמיתי (בניגוד ל-CLI עצמו) — כדי שאין סיכון לעצי-עבודה אמיתיים
// גם אם הבדיקה נכשלת באמצע.
//
// שלוש טענות אמיתיות, לא רק "זה רץ בלי שגיאה":
//  1. הרצת stampFiles על המניפסט **הנוכחי** מול תמונת המצב הנוכחית
//     היא no-op מוחלט — שום קובץ לא היה משתנה. זו ההוכחה ל"הקבצים
//     המחוללים עדכניים, קידום אינו דורש build" מהדרישה המקורית.
//  2. הרצת stampFiles על מניפסט בדוי (גרסה/תאריך/מפתח SW שונים
//     לגמרי) מייצרת תוצאה שעוברת את audit() **עם אותו מניפסט הבדוי** —
//     כלומר המחולל באמת מסוגל לקדם גרסה, לא רק "לשמר את הקיים".
//  3. מספר ההתייחסויות המגובות (?v=) לא משתנה בין המניפסטים — קידום
//     גרסה מחליף את הערך בכל מקום, לא מוסיף ולא מוריד התייחסויות.
import assert from 'node:assert/strict';
import { loadSnapshot, audit, MANIFEST, releaseKey } from './version-release.mjs';
import { stampFiles, validateManifest } from '../release-stamp.mjs';

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

const files = loadSnapshot();

test('validateManifest rejects an asset_query that does not match releaseKey(version)', () => {
  const errors = validateManifest({ version: '99Z.1', date: '1.1.2099', asset_query: 'wrong', sw_cache_key: 'x' });
  assert.ok(errors.some((e) => e.includes('asset_query')));
});

test('validateManifest accepts the real, current manifest', () => {
  assert.deepEqual(validateManifest(MANIFEST), []);
});

test('stampFiles on the current manifest against the current snapshot changes nothing (already-generated files are current)', () => {
  const { files: stamped, restamped } = stampFiles(files, MANIFEST);
  let changed = 0;
  for (const [name, content] of stamped) {
    if (files.get(name) !== content) changed += 1;
  }
  assert.equal(changed, 0, 'no file should differ when stamping with the manifest already in effect');
  assert.equal(restamped, 0, 'no ?v= reference should need rewriting when already current');
});

test('the current committed state is what the generator would itself produce, not hand-maintained drift', () => {
  const baseline = audit(files, MANIFEST);
  assert.deepEqual(baseline.errors, []);
});

test('stampFiles genuinely bumps the release: a fake manifest produces files that pass audit() under that same fake manifest', () => {
  const fakeVersion = '99Z.99.9';
  const fakeManifest = {
    version: fakeVersion,
    date: '1.1.2099',
    asset_query: releaseKey(fakeVersion),
    sw_cache_key: 'resq-v' + releaseKey(fakeVersion) + '-release1'
  };
  const { files: stamped, restamped } = stampFiles(files, fakeManifest);
  assert.ok(restamped > 0, 'bumping to a different asset_query must rewrite at least one ?v= reference');

  const result = audit(stamped, fakeManifest);
  assert.deepEqual(result.errors, [], 'files stamped for the fake manifest must satisfy audit() under that manifest');

  // ולא נשאר שום שריד מהמניפסט האמיתי בקבצים שיועדו לעדכון ייעודי.
  assert.ok(stamped.get('version.json').includes(fakeVersion));
  assert.ok(!stamped.get('version.json').includes(MANIFEST.version));
  assert.ok(stamped.get('version.js').includes(fakeVersion));
  assert.ok(stamped.get('firebase-messaging-sw.js').includes(fakeManifest.sw_cache_key));
  assert.ok(!stamped.get('firebase-messaging-sw.js').includes(MANIFEST.sw_cache_key));
});

test('bumping the release does not change how many static references exist, only their value', () => {
  const fakeVersion = '99Z.99.9';
  const fakeManifest = {
    version: fakeVersion, date: '1.1.2099',
    asset_query: releaseKey(fakeVersion),
    sw_cache_key: 'resq-v' + releaseKey(fakeVersion) + '-release1'
  };
  const { files: stamped } = stampFiles(files, fakeManifest);
  const before = audit(files, MANIFEST).count;
  const after = audit(stamped, fakeManifest).count;
  assert.equal(before, after);
});

test('stampFiles throws on an invalid manifest instead of silently writing a mismatched key', () => {
  assert.throws(() => stampFiles(files, { version: '1.0', date: '1.1.2000', asset_query: 'nope', sw_cache_key: 'x' }));
});

console.log('');
console.log(passed + ' release-stamp checks passed.');
