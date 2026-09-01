// בדיקה עצמאית · push-token-handoff + transfer-recipients
//
// שני החסמים הראשונים ש-Codex מצא בחבילת ההתראות (seq255).
// יחידה · פרטיות · מוטציות.
//
// שתי הבדיקות שאסור להן ליפול:
//   העברת מכשירים אינה מעבירה שם מלא ומספר עובד לתחנה זרה
//   רכזת שביצעה פעולה אינה מקבלת עליה התראה, וגם לא פעמיים
//
// יציאה: 0 עבר · 1 נפל · 2 לא רץ.

import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const FN = join(__TESTS, '..', 'functions');
const require_ = createRequire(import.meta.url);

const handoffPath = join(FN, 'push-token-handoff.js');
const recipientsPath = join(FN, 'transfer-recipients.js');
for (const p of [handoffPath, recipientsPath]) {
  if (!fs.existsSync(p)) { console.log('NOT RUN — חסר ' + p); process.exit(2); }
}
const H = require_(handoffPath);
const R = require_(recipientsPath);
const indexSrc = fs.readFileSync(join(FN, 'index.js'), 'utf8');
const alertsSrc = fs.readFileSync(join(__TESTS, '..', 'alerts.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    'קיבלתי ' + JSON.stringify(got) + ' במקום ' + JSON.stringify(want));
}
function throws(name, fn, code) {
  try { fn(); ok(name, false, 'לא נזרקה שגיאה'); }
  catch (e) { ok(name, e.code === code, 'קוד ' + e.code + ' במקום ' + code); }
}

const CLOCK = () => Date.UTC(2026, 8, 1, 6, 0, 0);
const handoff = H.createTokenHandoff({ clock: CLOCK });
const resolver = R.createRecipientResolver({ clock: CLOCK });

// מסמך טוקנים אמיתי, בדיוק כפי ש-alerts.html:385 כותב אותו.
const srcDoc = (over) => ({ exists: true, data: Object.assign({
  uid: 'uid-eldad', emp: '102', crew: 'A', role: 'firefighter',
  full_name: 'אלדד יונה',
  tokens: [{ token: 'tok-phone', platform: 'web' },
           { token: 'tok-tablet', platform: 'web' }],
  prefs: { swap_mine: true, guard_all: false },
  updated_at: '2026-08-30T10:00:00.000Z'
}, over || {}) });

const plan = (over) => handoff.planHandoff(Object.assign({
  subject_uid: 'uid-eldad',
  source_station_id: 'station-102',
  target_station_id: 'station-201',
  source_doc: srcDoc(),
  target_doc: { exists: false },
  transfer: { request_id: 'req-1', revision: 3 }
}, over || {}));

/* ========== 1 · ⭐⭐ שני שדות בלבד חוצים תחנה ========== */
{
  const r = plan();
  const target = r.ops.filter(o => o.op === 'set')[0];

  eq('1.1 סוג הפעולה', r.kind, 'moved');
  eq('1.2 שני שדות בלבד בנוסף ל-uid',
    Object.keys(target.data).sort(), ['prefs', 'tokens', 'uid']);

  const json = JSON.stringify(r);
  ok('1.3 ⭐⭐ שם מלא אינו חוצה תחנה', json.indexOf('אלדד') === -1);
  ok('1.4 ⭐ מספר עובד אינו חוצה', json.indexOf('"emp"') === -1);
  ok('1.5 משמרת אינה חוצה — היא של התחנה הישנה', json.indexOf('"crew"') === -1);
  ok('1.6 תפקיד אינו חוצה — הוא של התחנה הישנה', json.indexOf('"role"') === -1);
  eq('1.7 והטוקנים כן', target.data.tokens.map(t => t.token),
    ['tok-phone', 'tok-tablet']);
  eq('1.8 עם התיאור של המכשיר עצמו', target.data.tokens[0].platform, 'web');
  eq('1.9 וההעדפות כן', target.data.prefs, { swap_mine: true, guard_all: false });

  // ⭐ שדה חדש שמישהו יוסיף למסמך בעתיד — אינו חוצה, כי
  // הרשימה סגורה ואינה מכירה אותו מלכתחילה.
  const future = plan({ source_doc: srcDoc({
    id_number: '040404040', home_address: 'שדרות התמרים 5' }) });
  const futureJson = JSON.stringify(future);
  ok('1.10 ⭐⭐ שדה עתידי שנוסף למסמך אינו חוצה',
    futureJson.indexOf('040404040') === -1
    && futureJson.indexOf('התמרים') === -1);
}

/* ========== 2 · ⭐ אטומיות · שתי הפעולות יחד ========== */
{
  const r = plan();
  eq('2.1 שתי פעולות בדיוק', r.ops.length, 2);
  eq('2.2 כתיבה ליעד', [r.ops[0].op, r.ops[0].station_id], ['set', 'station-201']);
  eq('2.3 ומחיקה מהמקור', [r.ops[1].op, r.ops[1].station_id], ['delete', 'station-102']);
  eq('2.4 ⭐ ומסומן שהן חייבות עסקה אחת', r.requires_single_transaction, true);
  eq('2.5 שתיהן על אותו מסמך', [r.ops[0].doc, r.ops[1].doc], ['uid-eldad', 'uid-eldad']);
}

/* ====== 3 · ⭐ אין טוקן במקור אינו מבטל את ההעברה ====== */
{
  const none = plan({ source_doc: { exists: false } });
  eq('3.1 ⭐ אין מכשיר — אין פעולות', none.ops, []);
  eq('3.2 ⭐⭐ וההעברה נשארת תקפה', none.transfer_still_valid, true);
  eq('3.3 עם סוג מפורש', none.kind, 'no-token');
  ok('3.4 ומדווח', none.warnings.some(w => w.code === H.WARN.NO_SOURCE_TOKENS));

  const empty = plan({ source_doc: srcDoc({ tokens: [] }) });
  eq('3.5 רשימה ריקה זהה', empty.kind, 'no-token');
  eq('3.6 וגם היא אינה מבטלת', empty.transfer_still_valid, true);
}

/* ========= 4 · ⭐ החלה חוזרת · מיזוג · כפילויות ========= */
{
  const already = plan({
    source_doc: { exists: false },
    target_doc: { exists: true, data: { uid: 'uid-eldad',
      tokens: [{ token: 'tok-phone' }, { token: 'tok-tablet' }] } }
  });
  eq('4.1 ⭐ הרצה חוזרת אחרי שהעסקה נכתבה — אפס פעולות', already.ops, []);
  eq('4.2 וסוג no-op', already.kind, 'noop');

  const overlap = plan({ target_doc: { exists: true, data: { uid: 'uid-eldad',
    tokens: [{ token: 'tok-phone', platform: 'android' }] } } });
  const t = overlap.ops[0].data.tokens;
  eq('4.3 ⭐ טוקן שקיים בשניהם נספר פעם אחת', t.length, 2);
  eq('4.4 והרשומה של היעד היא ששרדה', t[0].platform, 'android');
  ok('4.5 והכפילות דווחה',
    overlap.warnings.some(w => w.code === H.WARN.TOKEN_ALREADY_AT_TARGET));

  const a = plan(), b = plan();
  eq('4.6 ⭐ אותו קלט נותן אותן פעולות בדיוק',
    JSON.stringify(a.ops), JSON.stringify(b.ops));
  eq('4.7 והטוקנים ממוינים', t.map(x => x.token), ['tok-phone', 'tok-tablet']);
}

/* ============ 5 · העדפות ============ */
{
  const conflict = plan({ target_doc: { exists: true, data: { uid: 'uid-eldad',
    tokens: [], prefs: { swap_mine: false, old_key: true } } } });
  const p = conflict.ops[0].data.prefs;
  eq('5.1 ⭐ העדפת המקור מנצחת — היא זו שהאדם תחזק', p.swap_mine, true);
  eq('5.2 והעדפת יעד שאין לה מקבילה נשמרת', p.old_key, true);
  ok('5.3 ⭐ ואי-ההסכמה מדווחת ואינה נבלעת',
    conflict.warnings.some(w => w.code === H.WARN.PREFS_CONFLICT
      && w.pref === 'swap_mine'));
}

/* =========== 6 · זהות · תחנה זרה · קלט פגום =========== */
{
  throws('6.1 ⭐ מסמך של משתמש אחר במקור נדחה',
    () => plan({ source_doc: srcDoc({ uid: 'uid-someone-else' }) }),
    H.CODE.FOREIGN_UID);
  throws('6.2 ⭐ ומסמך של משתמש אחר ביעד נדחה',
    () => plan({ target_doc: { exists: true,
      data: { uid: 'uid-other', tokens: [] } } }), H.CODE.FOREIGN_UID);
  throws('6.3 מסמך שנושא תחנה זרה נדחה',
    () => plan({ source_doc: srcDoc({ station_id: 'station-999' }) }),
    H.CODE.FOREIGN_STATION);
  throws('6.4 מקור ויעד זהים נדחים',
    () => plan({ target_station_id: 'station-102' }), H.CODE.SAME_STATION);
  throws('6.5 בלי clock אין מודול',
    () => H.createTokenHandoff({}), H.CODE.SHAPE);

  const junk = plan({ source_doc: srcDoc({ tokens: [
    { token: 'tok-good' }, { platform: 'web' }, null, 'tok-bare', 42] }) });
  eq('6.6 רשומות פגומות נזרקות, התקינות שורדות',
    junk.ops[0].data.tokens.map(x => x.token), ['tok-bare', 'tok-good']);
  ok('6.7 והזריקה מדווחת',
    junk.warnings.filter(w => w.code === H.WARN.DROPPED_INVALID_TOKEN).length === 3);

  const many = [];
  for (let i = 0; i < 21; i += 1) many.push({ token: 'tok-' + i });
  throws('6.8 יותר מדי מכשירים נדחה',
    () => plan({ source_doc: srcDoc({ tokens: many }) }), H.CODE.TOO_MANY_TOKENS);
}

/* ===== 7 · ⭐⭐ מבקרי היעד · המבצע אינו מקבל, ואף אחד פעמיים ===== */
const ROSTER = [
  { uid: 'u-hr', station_id: 'station-201', active: true, role: 'hr_coordinator' },
  { uid: 'u-cmd', station_id: 'station-201', active: true, role: 'station_commander' },
  // אדם אחד עם שני התפקידים — בדיוק חסם הכפילות של Codex.
  { uid: 'u-both', station_id: 'station-201', active: true,
    role: 'hr_coordinator', roles: ['station_commander'] },
  { uid: 'u-ff', station_id: 'station-201', active: true, role: 'firefighter' },
  { uid: 'u-gone', station_id: 'station-201', active: false, role: 'hr_coordinator' },
  { uid: 'u-elsewhere', station_id: 'station-999', active: true, role: 'station_commander' }
];
{
  const r = resolver.resolveReviewers({
    station_id: 'station-201', roster: ROSTER,
    actor_uid: 'u-hr', subject_uid: 'uid-eldad' });

  eq('7.1 ⭐⭐ המבצע אינו מקבל התראה על עצמו',
    r.recipients.indexOf('u-hr'), -1);
  eq('7.2 ⭐⭐ ובעל שני התפקידים מקבל פעם אחת',
    r.recipients.filter(x => x === 'u-both').length, 1);
  eq('7.3 הנמענים', r.recipients, ['u-both', 'u-cmd']);
  eq('7.4 כבאי רגיל אינו מבקר',
    r.excluded.filter(x => x.uid === 'u-ff')[0].reason, R.REASON.ROLE_NOT_REVIEWER);
  eq('7.5 רכזת לא פעילה אינה מקבלת',
    r.excluded.filter(x => x.uid === 'u-gone')[0].reason, R.REASON.INACTIVE);
  eq('7.6 ⭐ מפקד מתחנה אחרת אינו מקבל',
    r.excluded.filter(x => x.uid === 'u-elsewhere')[0].reason, R.REASON.NOT_MEMBER);
  eq('7.7 והמבצע מדווח בסיבה שלו',
    r.excluded.filter(x => x.uid === 'u-hr')[0].reason, R.REASON.IS_ACTOR);

  const subj = resolver.resolveReviewers({
    station_id: 'station-201',
    roster: ROSTER.concat([{ uid: 'uid-eldad', station_id: 'station-201',
      active: true, role: 'station_commander' }]),
    actor_uid: 'u-hr', subject_uid: 'uid-eldad' });
  eq('7.8 ⭐ הנושא אינו מקבל התראה על עצמו גם אם הוא מבקר',
    subj.recipients.indexOf('uid-eldad'), -1);
  eq('7.9 ומדווח', subj.excluded.filter(x => x.uid === 'uid-eldad')[0].reason,
    R.REASON.IS_SUBJECT);

  const dup = resolver.resolveReviewers({
    station_id: 'station-201', roster: ROSTER.concat([ROSTER[1]]),
    actor_uid: null, subject_uid: null });
  eq('7.10 ⭐ שורה כפולה בסגל נספרת פעם אחת',
    dup.recipients.filter(x => x === 'u-cmd').length, 1);
  eq('7.11 והנמענים ממוינים', dup.recipients, dup.recipients.slice().sort());
}

/* ===== 8 · ⭐ אפס נמענים אינו מפיל את ההעברה ===== */
{
  const empty = resolver.resolveReviewers({
    station_id: 'station-201', roster: [], actor_uid: 'u-hr', subject_uid: null });
  eq('8.1 ⭐⭐ אין מבקר — אין נמענים, ואין שגיאה', empty.recipients, []);
  eq('8.2 ⭐⭐ וההעברה נשארת תקפה', empty.transfer_still_valid, true);
  ok('8.3 עם אזהרה', empty.warnings.some(w => w.code === R.WARN.NO_RECIPIENTS));

  const onlyActor = resolver.resolveReviewers({
    station_id: 'station-201',
    roster: [{ uid: 'u-hr', station_id: 'station-201', active: true,
      role: 'hr_coordinator' }],
    actor_uid: 'u-hr', subject_uid: null });
  eq('8.4 המבקר היחיד הוא המבצע', onlyActor.recipients, []);
  ok('8.5 ⭐ וזה מדווח בנפרד — זה מצב שונה מ„אין מבקר"',
    onlyActor.warnings.some(w => w.code === R.WARN.ONLY_ACTOR));
  ok('8.6 בעוד תחנה ריקה לגמרי אינה מדווחת ONLY_ACTOR',
    !empty.warnings.some(w => w.code === R.WARN.ONLY_ACTOR));
}

/* ===== 9 · ⭐ הרחבת קהל אינה משתמעת ===== */
{
  throws('9.1 ⭐⭐ בקשה לשלוח לתפקיד שאינו מבקר נדחית',
    () => resolver.resolveReviewers({ station_id: 'station-201', roster: ROSTER,
      roles: ['hr_coordinator', 'deputy'] }), R.CODE.ROLE_UNKNOWN);
  throws('9.2 וגם לכבאי',
    () => resolver.resolveReviewers({ station_id: 'station-201', roster: ROSTER,
      roles: ['firefighter'] }), R.CODE.ROLE_UNKNOWN);

  const narrow = resolver.resolveReviewers({ station_id: 'station-201',
    roster: ROSTER, roles: ['station_commander'] });
  eq('9.3 צמצום קהל מותר', narrow.recipients, ['u-both', 'u-cmd']);
  eq('9.4 והרכזת אינה בו',
    narrow.excluded.filter(x => x.uid === 'u-hr')[0].reason, R.REASON.ROLE_NOT_REVIEWER);
  eq('9.5 שני התפקידים הקפואים בלבד', R.REVIEWER_ROLES,
    ['hr_coordinator', 'station_commander']);
}

/* ===== 10 · ⭐ כשירות ברגע השליחה, לא ברגע ההכרעה ===== */
{
  const live = (over) => ({ exists: true, data: Object.assign({
    station_id: 'station-201', active: true, role: 'hr_coordinator' }, over || {}) });

  eq('10.1 מבקר חי כשיר', resolver.stillEligible({
    station_id: 'station-201', uid: 'u-hr', live_user: live() }).eligible, true);
  eq('10.2 ⭐ מי שהוסר מתפקידו בין ההכרעה לשליחה — נחסם',
    resolver.stillEligible({ station_id: 'station-201', uid: 'u-hr',
      live_user: live({ role: 'firefighter' }) }).reason, R.REASON.ROLE_NOT_REVIEWER);
  eq('10.3 ⭐ מי שעזב את התחנה — נחסם',
    resolver.stillEligible({ station_id: 'station-201', uid: 'u-hr',
      live_user: live({ station_id: 'station-777' }) }).reason, R.REASON.NOT_MEMBER);
  eq('10.4 מי שהושבת — נחסם',
    resolver.stillEligible({ station_id: 'station-201', uid: 'u-hr',
      live_user: live({ active: false }) }).reason, R.REASON.INACTIVE);
  eq('10.5 מסמך שנעלם — נחסם',
    resolver.stillEligible({ station_id: 'station-201', uid: 'u-hr',
      live_user: { exists: false } }).reason, R.REASON.NOT_MEMBER);
  eq('10.6 והמבצע נחסם גם כאן',
    resolver.stillEligible({ station_id: 'station-201', uid: 'u-hr',
      live_user: live(), actor_uid: 'u-hr' }).reason, R.REASON.IS_ACTOR);
}

/* ===== 11 · פרטיות · התוצאה היא UID בלבד ===== */
{
  const rich = ROSTER.map(p => Object.assign({}, p, {
    full_name: 'דוד כהן', email: 'david@x.co.il', phone: '050-1234567',
    emp_number: '204' }));
  const r = resolver.resolveReviewers({ station_id: 'station-201',
    roster: rich, actor_uid: 'u-hr', subject_uid: null });
  const json = JSON.stringify(r);
  ok('11.1 ⭐ אין שם', json.indexOf('דוד') === -1);
  ok('11.2 אין מייל', json.indexOf('@') === -1);
  ok('11.3 אין טלפון', json.indexOf('050-') === -1);
  ok('11.4 אין מספר עובד', json.indexOf('"204"') === -1);
  // ⭐ הנמענים הם מחרוזות UID ותו לא. אין לצדם אובייקט שיכול
  // לשאת תפקיד, שם או כל שדה אחר.
  ok('11.5 ⭐ הנמענים הם UID בלבד',
    r.recipients.every(x => typeof x === 'string'));
  ok('11.6 ⭐ ואין התפקיד שבזכותו כל אדם נבחר',
    r.excluded.every(x => Object.keys(x).sort().join(',') === 'reason,uid'));
  eq('11.7 האודיט נושא את התפקידים שנשאלו, לא את של האנשים',
    r.audit.roles_queried, ['hr_coordinator', 'station_commander']);
  ok('11.8 והמפתח roles חסום בסורק עצמו',
    R.assertNoLeak && (() => { try { R.assertNoLeak({ roles: ['x'] }, 'p');
      return false; } catch (e) { return e.code === R.CODE.LEAK; } })());

  throws('11.9 שדה אסור נחסם',
    () => R.assertNoLeak({ ok: 1, full_name: 'x' }, 'p'), R.CODE.LEAK);
  throws('11.10 ⭐ שם עברי בערך תמים נחסם',
    () => R.assertNoLeak({ label: 'אלדד יונה' }, 'p'), R.CODE.LEAK);
  throws('11.11 ⭐ מייל בערך תמים נחסם',
    () => H.assertNoPii({ label: 'a@b.co.il' }, 'p'), H.CODE.PII);
}

/* ===== 12 · טענות על המקור האמיתי ===== */
{
  ok('12.1 ⭐ pushToOne עדיין קורא push_tokens/{uid} תחת התחנה',
    /push_tokens\/' \+ uid/.test(indexSrc));
  ok('12.2 ⭐ ומסמך הטוקנים עדיין נושא שם מלא ומספר עובד',
    /uid: ME\.uid, emp: ME\.emp, crew: ME\.crew, role: ROLE/.test(alertsSrc)
    && /full_name: ME\.full_name/.test(alertsSrc));
  ok('12.3 והוא עדיין נושא tokens ו-prefs — שני השדות שכן חוצים',
    /tokens: tokens, prefs: prefs/.test(alertsSrc));
  ok('12.4 pushToOne עדיין מכבד prefs',
    indexSrc.includes('if (!must && prefs[type] === false) return { sent: 0 };'));
}

/* ===== 13 · מוטציות ===== */
{
  const srcH = fs.readFileSync(handoffPath, 'utf8');
  const srcR = fs.readFileSync(recipientsPath, 'utf8');
  const tmp = join(__TESTS, '_mut_handoff.cjs');
  function mutate(src, from, to, label, exercise) {
    if (src.indexOf(from) === -1) { ok(label, false, 'טקסט לא נמצא'); return; }
    fs.writeFileSync(tmp, src.split(from).join(to));
    let caught = false;
    try { delete require_.cache[require_.resolve(tmp)]; exercise(require_(tmp)); }
    catch (e) { caught = true; }
    fs.unlinkSync(tmp);
    ok(label, caught, 'המוטציה עברה בלי שאיש שם לב');
  }

  mutate(srcH, "    if (NEVER_CARRIED.indexOf(key) !== -1) continue;", "",
    '13.1 ⭐⭐ שדה אסור שמתחיל לחצות תחנה — נתפס',
    (M) => {
      const h = M.createTokenHandoff({ clock: CLOCK });
      const r = h.planHandoff({ subject_uid: 'uid-eldad',
        source_station_id: 'a', target_station_id: 'b',
        source_doc: { exists: true, data: { uid: 'uid-eldad', tokens: [
          { token: 't1', full_name: 'אלדד יונה' }] } },
        target_doc: { exists: false } });
      if (JSON.stringify(r).indexOf('אלדד') !== -1) throw new Error('caught');
    });

  mutate(srcH, "      requires_single_transaction: true,",
    "      requires_single_transaction: false,",
    '13.2 ⭐ ויתור על דרישת העסקה האחת — נתפס',
    (M) => {
      const h = M.createTokenHandoff({ clock: CLOCK });
      const r = h.planHandoff({ subject_uid: 'u', source_station_id: 'a',
        target_station_id: 'b',
        source_doc: { exists: true, data: { tokens: [{ token: 't' }] } },
        target_doc: { exists: false } });
      if (r.requires_single_transaction !== true) throw new Error('caught');
    });

  mutate(srcH, "        transfer_still_valid: true,\n        audit: auditOf(uid, from, to, input.transfer, 0)",
    "        transfer_still_valid: false,\n        audit: auditOf(uid, from, to, input.transfer, 0)",
    '13.3 ⭐⭐ „אין מכשיר" שמתחיל לבטל את ההעברה — נתפס',
    (M) => {
      const h = M.createTokenHandoff({ clock: CLOCK });
      const r = h.planHandoff({ subject_uid: 'u', source_station_id: 'a',
        target_station_id: 'b', source_doc: { exists: false },
        target_doc: { exists: false } });
      if (r.transfer_still_valid !== true) throw new Error('caught');
    });

  mutate(srcH, "String(doc.data.uid) !== String(uid)", "false",
    '13.4 ⭐ מסמך של משתמש אחר שמתחיל לעבור — נתפס',
    (M) => {
      const h = M.createTokenHandoff({ clock: CLOCK });
      h.planHandoff({ subject_uid: 'u', source_station_id: 'a',
        target_station_id: 'b',
        source_doc: { exists: true, data: { uid: 'other', tokens: [{ token: 't' }] } },
        target_doc: { exists: false } });
      throw new Error('caught');
    });

  mutate(srcR, "      if (actor && uid === actor) { excluded.push({ uid, reason: REASON.IS_ACTOR }); continue; }", "",
    '13.5 ⭐⭐ המבצע שמתחיל לקבל התראה על עצמו — נתפס',
    (M) => {
      const res = M.createRecipientResolver({ clock: CLOCK });
      const r = res.resolveReviewers({ station_id: 'station-201', roster: ROSTER,
        actor_uid: 'u-hr', subject_uid: null });
      if (r.recipients.indexOf('u-hr') !== -1) throw new Error('caught');
    });

  mutate(srcR, "      if (seen.has(uid)) { excluded.push({ uid, reason: REASON.DUPLICATE }); continue; }", "",
    '13.6 ⭐⭐ בעל שני תפקידים שמתחיל לקבל פעמיים — נתפס',
    (M) => {
      const res = M.createRecipientResolver({ clock: CLOCK });
      const r = res.resolveReviewers({ station_id: 'station-201',
        roster: ROSTER.concat([ROSTER[1]]), actor_uid: null, subject_uid: null });
      if (r.recipients.filter(x => x === 'u-cmd').length !== 1) throw new Error('caught');
    });

  mutate(srcR, "        if (REVIEWER_ROLES.indexOf(r) === -1) {", "        if (false) {",
    '13.7 ⭐⭐ הרחבת קהל שמתחילה להיות מותרת — נתפסת',
    (M) => {
      const res = M.createRecipientResolver({ clock: CLOCK });
      res.resolveReviewers({ station_id: 'station-201', roster: ROSTER,
        roles: ['firefighter'] });
      throw new Error('caught');
    });

  mutate(srcR, "      if (raw.active !== true) { excluded.push({ uid, reason: REASON.INACTIVE }); continue; }", "",
    '13.8 אדם מושבת שמתחיל לקבל — נתפס',
    (M) => {
      const res = M.createRecipientResolver({ clock: CLOCK });
      const r = res.resolveReviewers({ station_id: 'station-201', roster: ROSTER,
        actor_uid: null, subject_uid: null });
      if (r.recipients.indexOf('u-gone') !== -1) throw new Error('caught');
    });

  mutate(srcR, "      if (raw.station_id !== sid) { excluded.push({ uid, reason: REASON.NOT_MEMBER }); continue; }", "",
    '13.9 ⭐ אדם מתחנה אחרת שמתחיל לקבל — נתפס',
    (M) => {
      const res = M.createRecipientResolver({ clock: CLOCK });
      const r = res.resolveReviewers({ station_id: 'station-201', roster: ROSTER,
        actor_uid: null, subject_uid: null });
      if (r.recipients.indexOf('u-elsewhere') !== -1) throw new Error('caught');
    });

  mutate(srcR, "    if (!REVIEWER_ROLES.some((r) => held.has(r))) {", "    if (false) {",
    '13.10 ⭐ כשירות ברגע השליחה שמפסיקה לבדוק תפקיד — נתפסת',
    (M) => {
      const res = M.createRecipientResolver({ clock: CLOCK });
      const v = res.stillEligible({ station_id: 's', uid: 'u',
        live_user: { exists: true, data: { station_id: 's', active: true,
          role: 'firefighter' } } });
      if (v.eligible !== false) throw new Error('caught');
    });
}

/* ---------------------------- סיכום ---------------------------- */
console.log('');
console.log('transfer-handoff · מכשירי התראות ומבקרי היעד');
console.log('עברו ' + pass + ' · נפלו ' + fail);
if (fail) { console.log(''); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
process.exit(0);
