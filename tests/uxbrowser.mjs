import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/login.html');
  const file = path.join(root, urlPath === '/' ? 'login.html' : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('no'); return; }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await context.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
await context.addInitScript('window.__SMOKE_ROLE = "none";');
const page = await context.newPage();
await page.goto('http://localhost:' + port + '/login.html', { waitUntil:'load' });
await page.waitForTimeout(6800);

async function check(value, message) {
  if (!value) throw new Error(message);
  console.log('✓ ' + message);
}
await page.locator('#tabLogin').focus();
await page.keyboard.press('ArrowRight');
await check(await page.locator('#tabFirst').getAttribute('aria-selected') === 'true', 'ArrowRight activates registration');
await check(await page.evaluate(() => document.activeElement?.id === 'tabFirst'), 'registration tab receives focus');
await check(await page.locator('#paneFirst').isVisible(), 'registration panel is visible');
await page.keyboard.press('Home');
await check(await page.locator('#tabLogin').getAttribute('aria-selected') === 'true', 'Home returns to login');
await check(await page.locator('#paneLogin').isVisible(), 'login panel is visible');
await context.close();

const attendanceContext = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await attendanceContext.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await attendanceContext.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
await attendanceContext.addInitScript('window.__SMOKE_ROLE = "super";');
const attendance = await attendanceContext.newPage();
// The shared fixture contains August records, not a query-filtering database.
// Fix this page's date only; timers and the product's month guard remain real.
await attendance.clock.setFixedTime(new Date('2026-08-25T12:00:00Z'));
await attendance.goto('http://localhost:' + port + '/attendance.html', { waitUntil:'load' });
await attendance.locator('.days .btn').first().waitFor({ state:'visible', timeout:8000 });
await attendance.addStyleTag({ content:'#coWrap{display:none!important}' });
const source = attendance.locator('.days .btn').first();
await check((await source.getAttribute('data-date')).startsWith('2026-08-'), 'attendance fixture row belongs to August 2026');
await check((await attendance.locator('#moLabel').textContent()).includes('אוגוסט 2026'), 'attendance displayed month matches the fixture');
await source.focus();
await attendance.keyboard.press('Enter');
await check(await attendance.locator('#ov').getAttribute('aria-hidden') === 'false', 'attendance dialog opens semantically');
await attendance.waitForFunction(() => document.activeElement?.id === 'dType');
await check(await attendance.evaluate(() => document.activeElement?.id === 'dType'), 'attendance dialog focuses its first control');
await check((await attendance.locator('#dType option[value="swap"]').textContent()).includes('נימוק חובה'),
            'attendance marks reason-required day types before selection');
await attendance.locator('#dType').selectOption('swap');
await check(await attendance.locator('#dOtBox').evaluate(el => !el.classList.contains('hide') && el.classList.contains('req')),
            'attendance shows a blocking red reason state while the required reason is empty');
await check(await attendance.locator('#dOtReason').evaluate(el => el.required &&
  el.getAttribute('aria-required') === 'true' && el.getAttribute('aria-invalid') === 'true'),
            'attendance exposes the missing required reason to assistive technology');
await attendance.locator('#dOtReason').fill('צורך תפעולי');
await check(await attendance.locator('#dOtBox').evaluate(el => !el.classList.contains('req')) &&
  await attendance.locator('#dOtReason').getAttribute('aria-invalid') === 'false',
            'attendance clears the blocking reason state as soon as a reason is entered');
await attendance.locator('#dType').selectOption('regular');
await check(await attendance.locator('#dOtReason').evaluate(el => !el.required &&
  el.getAttribute('aria-required') === 'false' && el.getAttribute('aria-invalid') === 'false'),
            'attendance clears required semantics when the selected day no longer needs a reason');
await attendance.locator('#dType').focus();
await attendance.keyboard.press('Shift+Tab');
await check(await attendance.evaluate(() => document.activeElement?.id === 'dCancel'), 'Shift+Tab wraps to the last dialog control');
await attendance.keyboard.press('Tab');
await check(await attendance.evaluate(() => document.activeElement?.id === 'dType'), 'Tab remains trapped inside the dialog');
await attendance.keyboard.press('Escape');
await check(await attendance.locator('#ov').getAttribute('aria-hidden') === 'true', 'Escape closes the attendance dialog');
await check(await source.evaluate(el => document.activeElement === el), 'attendance dialog restores focus to its source');
const sourceDate = await source.getAttribute('data-date');
await attendance.keyboard.press('Enter');
await attendance.waitForFunction(() => document.activeElement?.id === 'dType');
await attendance.locator('#dSave').focus();
await attendance.keyboard.press('Enter');
await attendance.locator('#ov').waitFor({ state:'hidden', timeout:5000 });
await attendance.waitForFunction(date => document.activeElement?.dataset?.date === date, sourceDate);
await check(await attendance.evaluate(date => document.activeElement?.dataset?.date === date, sourceDate),
            'attendance save restores focus after the row is rebuilt');
await attendanceContext.close();

const correctionContext = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await correctionContext.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await correctionContext.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
await correctionContext.addInitScript(() => {
  window.__SMOKE_ROLE = 'super';
  const token = { seconds:1800000000, nanoseconds:7 };
  const contextResult = { station_id:'eilat_102', target_uid:'u2', employee_number:'17', month:'2026-08',
    target:{ full_name:'טל חודרה', crew:'A', role:'firefighter', inactive:false },
    report:{ exists:true, status:'draft', expected_version:token },
    days:[{ date:'2026-08-01', record_id:'17_2026-08-01', expected_version:token, can_correct:true,
      record:{ day_type:'regular', shape:'regular', start:'07:00', end:'07:00', end_day:1,
        start2:'', end2:'', end_day2:0, sub_station:'', overtime_reason:'', notes:'', reason:'',
        hours:24, day_type_he:'רגיל', site_name:'', reason_required:false, status:'draft' } }],
    missing_dates:Array.from({length:30},(_,i)=>'2026-08-'+String(i+2).padStart(2,'0')),
    eligibility:{ can_create:true, can_recalculate:true, can_reopen:false, historical:false, reopening_valid:false },
    snapshot_at_ms:1800000000000 };
  window.__CALLABLE_PLAN = {
    getAttendanceCorrectionContext:[{data:structuredClone(contextResult)},{data:structuredClone(contextResult)},
      {data:structuredClone(contextResult)},{data:structuredClone(contextResult)}],
    correctAttendanceDay:[{data:{ correction_id:'a'.repeat(64), changed_count:1, outcome:'recorded', notification_status:'intent_only', duplicate:false }}],
    listAttendanceCorrectionAudit:[{data:{ station_id:'eilat_102',target_uid:'u2',employee_number:'17',month:'2026-08',
      items:[{event_id:'a'.repeat(64),operation:'update',actor_uid:'stub-uid',actor_name:'אלדד יונה',created_at_ms:1800000000000,
        reason:'תיקון מאושר לצורך בדיקת הממשק',dates:['2026-08-01']}],next_cursor:'a'.repeat(64) }},
      {data:{ station_id:'eilat_102',target_uid:'u2',employee_number:'17',month:'2026-08',
        items:[{event_id:'b'.repeat(64),operation:'recalculate',actor_uid:'stub-uid',actor_name:'אלדד יונה',created_at_ms:1800000001000,
          reason:'חישוב מחדש לאחר בדיקה',dates:['2026-08-01']}],next_cursor:null }}],
    getAttendanceCorrectionAudit:[{data:{ event_id:'a'.repeat(64),operation:'update',actor_uid:'stub-uid',actor_name:'אלדד יונה',
      created_at_ms:1800000000000,reason:'תיקון מאושר לצורך בדיקת הממשק',station_id:'eilat_102',target_uid:'u2',employee_number:'17',month:'2026-08',
      changes:[{date:'2026-08-01',before:{start:'07:00'},after:{start:'08:00'}}] }}]
  };
});
const correction = await correctionContext.newPage();
await correction.clock.setFixedTime(new Date('2026-08-25T12:00:00Z'));
await correction.goto('http://localhost:' + port + '/attendance.html', { waitUntil:'load' });
await correction.addStyleTag({ content:'#coWrap{display:none!important}' });
await correction.locator('#pickWho').waitFor({state:'visible',timeout:8000});
await correction.locator('#pickWho').selectOption('u2');
await correction.locator('#pickGo').click();
await correction.locator('.days .btn').first().waitFor({state:'visible',timeout:8000});
await check(await correction.locator('#timerCard').evaluate(el=>el.classList.contains('hide')), 'HR view hides employee-only shift timer');
await check(await correction.locator('#btnFill').evaluate(el=>el.classList.contains('hide')) &&
  await correction.locator('#btnSync').evaluate(el=>el.classList.contains('hide')), 'HR view hides employee-only fill and schedule sync');
await correction.locator('.days .btn').first().click();
await check(await correction.locator('#dCorrectionReason').isVisible(), 'HR correction requires a dedicated visible reason');
await correction.locator('#dStart').fill('08:00');
await correction.locator('#dCorrectionReason').fill('תיקון שעות לאחר בדיקה מול העובד והמסמכים');
await correction.locator('#dSave').click();
await correction.locator('#ov').waitFor({state:'hidden',timeout:8000});
const correctionCall = await correction.evaluate(() => __CALLABLE_CALLS.find(call=>call.name==='correctAttendanceDay'));
await check(correctionCall.payload.target_uid==='u2' && correctionCall.payload.employee_number==='17' &&
  correctionCall.payload.expected_version.seconds===1800000000 && correctionCall.payload.reason.includes('בדיקה מול העובד') &&
  correctionCall.payload.patch.start==='08:00' && correctionCall.payload.patch.hours===undefined &&
  correctionCall.payload.request_id.startsWith('web_'), 'HR correction sends canonical target, exact CAS and editable fields only');
await correction.locator('#btnView').click();
await check(await correction.locator('#pSend').count()===0, 'HR summary cannot submit an employee declaration');
await correction.locator('#pBack').click();
await correction.evaluate(() => {
  __CALLABLE_PLAN.correctAttendanceDay = [
    {reject:true,code:'functions/unavailable',message:'connection lost'},
    {data:{ correction_id:'c'.repeat(64),changed_count:1,outcome:'recorded',notification_status:'intent_only',duplicate:true }}
  ];
});
await correction.locator('.days .btn').first().click();
await correction.locator('#dStart').fill('09:00');
await correction.locator('#dCorrectionReason').fill('תיקון חוזר לאחר שלא התקבל אישור סופי מהשרת');
await correction.locator('#dSave').click();
await correction.waitForFunction(() => document.querySelector('#msg').textContent.includes('לא התקבל אישור סופי'));
const uncertainId = await correction.evaluate(() => __CALLABLE_CALLS.filter(call=>call.name==='correctAttendanceDay').at(-1).payload.request_id);
await correction.locator('#dStart').fill('10:00');
await correction.locator('#dSave').click();
await check(await correction.evaluate(() => __CALLABLE_CALLS.filter(call=>call.name==='correctAttendanceDay').length===2),
  'changed correction is blocked while an uncertain operation exists');
await correction.locator('#dStart').fill('09:00');
await correction.locator('#dSave').click();
await correction.locator('#ov').waitFor({state:'hidden',timeout:8000});
await check(await correction.evaluate(id => {
  const calls=__CALLABLE_CALLS.filter(call=>call.name==='correctAttendanceDay');
  return calls.length===3 && calls.at(-1).payload.request_id===id;
}, uncertainId), 'uncertain retry reuses the exact correction request id');
await correction.locator('#btnLoadCorrectionAudit').click();
await correction.locator('#btnMoreCorrectionAudit').waitFor({state:'visible',timeout:8000});
await correction.locator('#btnMoreCorrectionAudit').click();
await correction.getByRole('button',{name:/חושב חודש מחדש/}).waitFor({state:'visible',timeout:8000});
await check(await correction.getByRole('button',{name:/חושב חודש מחדש/}).count()===1,
  'correction audit exposes the next page');
await correction.getByRole('button',{name:/עודכן יום/}).click();
await correction.locator('#ov').waitFor({state:'visible',timeout:8000});
await check((await correction.locator('#dlg').innerText()).includes('תיקון מאושר לצורך בדיקת הממשק'), 'employee audit opens the immutable correction reason');
await check((await correction.locator('#dlg').innerText()).includes('07:00') &&
  (await correction.locator('#dlg').innerText()).includes('08:00'), 'correction audit shows before and after values');
await check(await correction.evaluate(() => __CALLABLE_CALLS.filter(call=>call.name==='listAttendanceCorrectionAudit').length===2 &&
  __CALLABLE_CALLS.filter(call=>call.name==='getAttendanceCorrectionAudit').length===1), 'audit list and detail use the authenticated server boundary');
await correctionContext.close();

const appContext = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await appContext.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await appContext.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
await appContext.addInitScript('window.__SMOKE_ROLE = "super";');
const swaps = await appContext.newPage();
await swaps.goto('http://localhost:' + port + '/swaps.html', { waitUntil:'load' });
await swaps.addStyleTag({ content:'#coWrap{display:none!important}' });
const take = swaps.getByRole('button', { name:'אני מעוניין להחליף' }).first();
await take.waitFor({ state:'visible', timeout:8000 });
await take.focus();
await take.click();
await swaps.locator('#tkDate').waitFor({ state:'visible', timeout:3000 });
await check(await swaps.locator('#ov').getAttribute('aria-hidden') === 'false',
            'open swap dialog opens semantically');
await swaps.waitForFunction(() => document.activeElement?.id === 'tkDate');
await check(await swaps.evaluate(() => document.activeElement?.id === 'tkDate'),
            'open swap dialog focuses the date');
await swaps.keyboard.press('Shift+Tab');
await check(await swaps.evaluate(() => document.activeElement?.id === 'tkX'),
            'open swap dialog wraps focus backward');
await swaps.keyboard.press('Escape');
await check(await swaps.locator('#ov').getAttribute('aria-hidden') === 'true',
            'Escape closes the open swap dialog');
await check(await take.evaluate(el => document.activeElement === el),
            'open swap dialog restores focus to its source');

const pick = swaps.locator('#btnPick');
await pick.focus();
await pick.click();
await swaps.locator('#pq').waitFor({ state:'visible', timeout:3000 });
await check(await swaps.locator('#ov').getAttribute('aria-hidden') === 'false',
            'picker opens after a previous swap dialog closed');
await swaps.waitForFunction(() => document.activeElement?.id === 'pq');
await check(await swaps.evaluate(() => document.activeElement?.id === 'pq'),
            'picker focuses its search field');
await swaps.keyboard.press('Escape');
await check(await pick.evaluate(el => document.activeElement === el),
            'picker restores focus to the picker button');

await take.focus();
await take.click();
await swaps.locator('#tkDate').fill('2026-09-03');
await swaps.locator('#tkGo').click();
await swaps.locator('#ov').waitFor({ state:'hidden', timeout:5000 });
await swaps.waitForFunction(() => document.activeElement?.id === 'openMsg');
await check(await swaps.evaluate(() => document.activeElement?.id === 'openMsg'),
            'successful open swap keeps focus after the list is rebuilt');

const forms = await appContext.newPage();
await forms.goto('http://localhost:' + port + '/forms.html', { waitUntil:'load' });
await forms.locator('#tabNew').waitFor({ state:'visible', timeout:8000 });
await forms.addStyleTag({ content:'#coWrap{display:none!important}' });
await forms.locator('#tabNew').focus();
await forms.keyboard.press('ArrowRight');
await check(await forms.locator('#tabMine').getAttribute('aria-selected') === 'true',
            'forms ArrowRight activates the next visible tab');
await check(await forms.evaluate(() => document.activeElement?.id === 'tabMine'),
            'forms active tab receives keyboard focus');
await check(await forms.locator('#viewMine').isVisible(),
            'forms selected panel is visible');
await forms.keyboard.press('End');
await check(await forms.locator('#tabAway').getAttribute('aria-selected') === 'true',
            'forms End activates the last visible tab');
await check(await forms.locator('#viewAway').isVisible(),
            'forms last panel is visible');
await forms.keyboard.press('Home');
await check(await forms.locator('#tabNew').getAttribute('aria-selected') === 'true',
            'forms Home returns to the first tab');

const sign = await appContext.newPage();
await sign.goto('http://localhost:' + port + '/sign.html', { waitUntil:'load' });
await sign.locator('#tabQueue').waitFor({ state:'visible', timeout:8000 });
await sign.addStyleTag({ content:'#coWrap{display:none!important}' });
await sign.locator('#tabQueue').focus();
await sign.keyboard.press('ArrowRight');
await check(await sign.locator('#tabMine').getAttribute('aria-selected') === 'true',
            'sign ArrowRight activates the saved-signature tab');
await check(await sign.evaluate(() => document.activeElement?.id === 'tabMine'),
            'sign active tab receives keyboard focus');
await check(await sign.locator('#viewMine').isVisible(),
            'sign selected panel is visible');
await sign.waitForFunction(() => {
  const canvas = document.getElementById('pad');
  return canvas && canvas.width > 0 && canvas.height > 0;
});
await check(await sign.evaluate(() => {
  const canvas = document.getElementById('pad');
  return canvas.width > 0 && canvas.height > 0;
}), 'sign canvas initializes with a usable backing size after it becomes visible');
const padBox = await sign.locator('#pad').boundingBox();
await sign.mouse.move(padBox.x + 18, padBox.y + 30);
await sign.mouse.down();
await sign.mouse.move(padBox.x + 90, padBox.y + 70, { steps:4 });
await sign.mouse.up();
await check(await sign.locator('#btnSave').isEnabled(),
            'drawing on the visible sign canvas enables saving');
await sign.locator('#btnClear').click();
await check(await sign.locator('#btnSave').isDisabled(),
            'clearing the sign canvas resets its save state');
await sign.locator('#tabMine').focus();
await sign.keyboard.press('Home');
await check(await sign.locator('#tabQueue').getAttribute('aria-selected') === 'true',
            'sign Home returns to the signing queue');
await check(await sign.locator('#viewQueue').isVisible(),
            'sign queue panel is visible again');
await appContext.close();

const firefighterContext = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await firefighterContext.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await firefighterContext.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
await firefighterContext.addInitScript('window.__SMOKE_ROLE = "firefighter";');
const firefighterForms = await firefighterContext.newPage();
await firefighterForms.goto('http://localhost:' + port + '/forms.html', { waitUntil:'load' });
await firefighterForms.locator('#tabNew').waitFor({ state:'visible', timeout:8000 });
await check(await firefighterForms.locator('#tabAppr').isHidden(),
            'firefighter approval tab stays hidden');
await firefighterForms.locator('#tabNew').focus();
await firefighterForms.keyboard.press('End');
await check(await firefighterForms.locator('#tabAway').getAttribute('aria-selected') === 'true',
            'firefighter End reaches the last visible tab');
await firefighterForms.keyboard.press('ArrowLeft');
await check(await firefighterForms.locator('#tabMine').getAttribute('aria-selected') === 'true',
            'firefighter keyboard skips the hidden approval tab');
await firefighterContext.close();

await browser.close();
server.close();
