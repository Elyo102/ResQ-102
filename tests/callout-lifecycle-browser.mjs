import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const types = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/login.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('callout-server-address');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await context.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript',
    body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await context.route('**://fonts.googleapis.com/**', route =>
  route.fulfill({ status:200, contentType:'text/css', body:'' }));
await context.addInitScript(() => {
  window.__SMOKE_ROLE = 'firefighter';
  window.__SMOKE_UID = 'identity-a';
  window.__SMOKE_MODE = 'trial';
  window.__SMOKE_PROFILE_BY_UID = {
    'identity-a':{ full_name:'זהות א', station:'station-102' },
    'identity-b':{ full_name:'זהות ב', station:'station-102' }
  };
  Object.defineProperty(navigator, 'userActivation', {
    configurable:true,
    value:Object.freeze({ hasBeenActive:false, isActive:false })
  });
});

const page = await context.newPage();
const errors = [];
const calloutWarnings = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'warning' && message.text().includes('callout watch:')) {
    calloutWarnings.push(message.text());
  }
});
await page.goto(`http://127.0.0.1:${address.port}/login.html`, { waitUntil:'load' });
await page.locator('#homeView').waitFor({ state:'visible', timeout:10000 });
await page.waitForTimeout(80);

function active(pathPart) {
  return page.evaluate(part => Object.entries(window.__FIRESTORE_ACTIVE_PATHS || {})
    .filter(([key]) => part === '/callouts' ? key.endsWith('/callouts') : key.includes(part))
    .reduce((sum, [, value]) => sum + Number(value || 0), 0), pathPart);
}

let pass = 0;
let fail = 0;
function check(ok, label, detail = '') {
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + label + (ok || !detail ? '' : ` — ${detail}`));
}

check(await active('/callouts') === 1,
      'one callout listener exists after initial login');
check(await active('config/mode') === 1,
      'one mode listener exists after initial login');
/* ======================================================================
 *  חיווי מצב האימון — תגית בכותרת, לא באנר רוחב-מסך
 * ====================================================================== */

check(!(await page.locator('body').evaluate(el => el.classList.contains('has-mode-bar'))),
      'the wide banner is gone, and with it the offset it forced on every screen');
check(await page.locator('#modeChip').isVisible(),
      'a compact chip sits in the header instead');
check(await page.locator('#appNav #modeChip').count() === 1,
      'and it really is inside the header, not floating over the page');
check(await page.locator('#modeChip').getAttribute('aria-label') === 'מצב אימון פעיל',
      'its aria-label says what the mode is',
      await page.locator('#modeChip').getAttribute('aria-label'));
check((await page.locator('#modeChip').innerText()).includes('אימון'),
      'and so does the visible label', await page.locator('#modeChip').innerText());

/* ⭐ 44×44 הוא המינימום שאצבע פוגעת בו. תגית שאי אפשר ללחוץ עליה
 * בטלפון היא תגית שההסבר שמאחוריה לא קיים. */
const chipBox = await page.locator('#modeChip').boundingBox();
check(chipBox.width >= 44 && chipBox.height >= 44,
      'the chip is at least 44×44', JSON.stringify(chipBox));

check(await page.locator('#modeChipNote').isHidden(),
      'the explanation starts closed — the point was to reduce noise');
await page.locator('#modeChip').click();
await page.locator('#modeChipNote').waitFor({ state:'visible' });
check((await page.locator('#modeChipNote').innerText())
        .includes('פעולות נשמרות לבדיקה ונשלחות רק לחשבון הבדיקה המאושר'),
      'pressing it explains what trial mode actually does',
      await page.locator('#modeChipNote').innerText());
check(await page.locator('#modeChip').getAttribute('aria-expanded') === 'true',
      'and the control says it is expanded');
await page.keyboard.press('Escape');
await page.locator('#modeChipNote').waitFor({ state:'hidden' });
check(await page.locator('#modeChip').getAttribute('aria-expanded') === 'false',
      'Escape closes it again');

// 320 · 360 · 390 — הכותרת לא נשברת ואין גלישה אופקית.
for (const width of [320, 360, 390]) {
  await page.setViewportSize({ width, height:844 });
  await page.waitForTimeout(60);
  const fit = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    chip: document.getElementById('modeChip').getBoundingClientRect(),
    nav: document.getElementById('appNav').getBoundingClientRect()
  }));
  check(fit.overflow <= 1, 'header does not overflow at ' + width, JSON.stringify(fit));
  check(fit.chip.width >= 44 && fit.chip.height >= 44,
        'the chip keeps its touch target at ' + width, JSON.stringify(fit.chip));
  check(fit.chip.left >= fit.nav.left - 1 && fit.chip.right <= fit.nav.right + 1,
        'and stays inside the header at ' + width, JSON.stringify(fit));
}
await page.setViewportSize({ width:390, height:844 });
await page.waitForTimeout(60);

// Safari can emit pageshow from bfcache more than once around auth recovery.
// Every route must replace the previous runtime instead of accumulating it.
await page.evaluate(() => {
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted:true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted:true }));
});
await page.waitForTimeout(220);
check(await active('/callouts') === 1,
      'repeated persisted pageshow keeps exactly one callout listener');
check(await active('config/mode') === 1,
      'repeated persisted pageshow keeps exactly one mode listener');

// A delayed route for A must never reclaim the screen after B becomes the
// current Firebase identity. This is deterministic: A's token result is held
// while B completes, then A is released.
await page.evaluate(() => {
  window.__SMOKE_EMIT_AUTH('firefighter', 'identity-a', { __token_delay_ms:250 });
  window.__SMOKE_EMIT_AUTH('firefighter', 'identity-b');
});
await page.waitForTimeout(330);
check((await page.locator('#pageTitle').textContent()).includes('זהות ב'),
      'a delayed old identity cannot reclaim the rendered home screen');
check(await active('/callouts') === 1 && await active('config/mode') === 1,
      'the winning identity owns one callout and one mode listener');

// Same UID, different claims: only the epoch distinguishes these routes.
// Without the epoch fence, the late firefighter route removes the admin group
// installed by the newer commander route.
await page.evaluate(() => {
  window.__SMOKE_EMIT_AUTH('firefighter', 'identity-b', { __token_delay_ms:250 });
  window.__SMOKE_EMIT_AUTH('commander', 'identity-b');
});
await page.waitForTimeout(330);
check(await page.locator('#door-admin').count() === 1,
      'a delayed same-UID route cannot overwrite newer claims');

// Simulate a large iPhone safe inset and scroll until the sticky header
// engages. The mode chip now rides inside the header, so the header itself
// may remain at top:0; the chip must sit below the safe inset.
await page.evaluate(() => {
  document.documentElement.style.setProperty('--resq-safe-top-override', '47px');
  window.scrollTo(0, document.documentElement.scrollHeight);
});
await page.waitForTimeout(80);
const stickyGeometry = await page.evaluate(() => {
  const chip = document.getElementById('modeChip').getBoundingClientRect();
  const nav = document.getElementById('appNav').getBoundingClientRect();
  return { modeTop:chip.top, modeBottom:chip.bottom, navTop:nav.top, navBottom:nav.bottom };
});
check(stickyGeometry.modeTop >= 46,
      'the mode chip stays below a 47px safe inset',
      JSON.stringify(stickyGeometry));
check(stickyGeometry.modeTop >= stickyGeometry.navTop - 1
        && stickyGeometry.modeBottom <= stickyGeometry.navBottom + 1,
      'and the chip rides inside it rather than stacking above it',
      JSON.stringify(stickyGeometry));

// A shared phone changes identity while both unsubscribe functions throw.
// Cleanup must continue and the replacement still becomes the sole owner.
await page.evaluate(() => {
  window.__FIRESTORE_UNSUB_THROW_PATHS = ['/callouts', 'config/mode'];
  window.__SMOKE_EMIT_AUTH('firefighter', 'identity-a');
});
await page.waitForTimeout(220);
check(await active('/callouts') === 1,
      'identity replacement survives a throwing callout unsubscribe');
check(await active('config/mode') === 1,
      'identity replacement survives a throwing mode unsubscribe');

const reasonCallout = {
  id:'reason-callout',
  data:{ active:true, uids:['identity-a'], text:'קריאה לבדיקת נימוק',
    by_name:'מפקד', created_key:new Date().toISOString(), acks:{} }
};
await page.evaluate(row => {
  window.__FIRESTORE_WRITES = [];
  window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [row]);
}, reasonCallout);
await page.locator('#coWrap.on').waitFor({ state:'visible' });
await page.waitForFunction(() => (window.__FIRESTORE_WRITES || []).length === 1);
const seenWrite = await page.evaluate(() => window.__FIRESTORE_WRITES[0]);
check(Boolean(seenWrite.value.seen_at) && seenWrite.options?.merge === true,
      'displaying a callout records a merge-only seen timestamp without answering',
      JSON.stringify(seenWrite));
check(await page.locator('#coWrap').evaluate(el => el.classList.contains('on')),
      'recording seen does not hide the unanswered callout');
await page.locator('#coNo').click();
check(await page.locator('#coReasonWrap').isVisible(),
      'rejecting a callout opens a mandatory reason field');
check(await page.locator('#coBtns').isHidden(),
      'and the two first answers step aside so the reason is the only question on screen');

// חמשת הנימוקים המהירים, בדיוק כפי שהוכרעו.
const offered = await page.$$eval('#coReasons button', els => els.map(el => el.textContent));
check(JSON.stringify(offered) === JSON.stringify(
        ['מחלה מאושרת', 'שירות מילואים', 'פטור מאושר', 'איני זמין בתחנה', 'אחר']),
      'the five agreed quick reasons are offered, in order', JSON.stringify(offered));

/* ⭐ הכפתור מנוטרל — לא „פעיל ואז נכשל". לחיצה עליו אינה
 * כותבת כלום, וזה מה שנבדק כאן ולא רק ה-attribute. */
check(await page.locator('#coSend').isDisabled(),
      'the send button is disabled until a reason is chosen');
await page.locator('#coSend').click({ force:true });
check((await page.evaluate(() => window.__FIRESTORE_WRITES || [])).length === 1,
      'an empty rejection reason writes nothing');

// „אחר" הוא היחיד שפותח טקסט חופשי, והוא עדיין דורש תוכן.
await page.locator('#coReasons button[data-reason="other"]').click();
check(await page.locator('#coReason').isVisible(),
      'choosing "other" opens the free-text field');
check(await page.locator('#coSend').isDisabled(),
      'and an empty "other" still cannot be sent');
await page.locator('#coReasons button[data-reason="sick"]').click();
check(await page.locator('#coReason').isHidden(),
      'choosing a listed reason closes the free-text field again');
check(!(await page.locator('#coSend').isDisabled()),
      'a chosen reason enables sending');
await page.locator('#coSend').click();
await page.waitForFunction(() => (window.__FIRESTORE_WRITES || []).length === 2);
const rejection = await page.evaluate(() => window.__FIRESTORE_WRITES[1]);
check(rejection.value.resp === 'no' && rejection.value.reason === 'מחלה מאושרת',
      'a rejection stores the required bounded reason', JSON.stringify(rejection));

// והאדם רואה שזה קרה. זה כל ההבדל בין מסך שענה למסך שקרס.
await page.locator('#coDone').waitFor({ state:'visible' });
check((await page.locator('#coDone').innerText()).includes('הדחייה נשלחה'),
      'the rejection is confirmed on screen and not merely by the dialog vanishing',
      await page.locator('#coDone').innerText());
check(await page.locator('#coBtns').isHidden() && await page.locator('#coReasonWrap').isHidden(),
      'and nothing is left to press twice');
check(rejection.options?.merge === true,
      'the final answer merges into and preserves the original seen receipt');
check(rejection.path.endsWith('/callouts/reason-callout/responses/identity-a'),
      'a response is isolated in its own recipient document', rejection.path);
await page.evaluate(() => window.__FIRESTORE_DELIVER_CAPTURED('/callouts', []));

/* ======================================================================
 *  אישור הגעה — שולח, הצליח, נכשל
 * ====================================================================== */
await page.evaluate(() => { window.__FIRESTORE_WRITES = []; });
await page.evaluate(row => window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [row]), {
  id:'accept-callout',
  data:{ active:true, uids:['identity-a'], text:'קריאה לבדיקת אישור',
    by_name:'מפקד', created_key:new Date().toISOString(), acks:{} }
});
await page.locator('#coWrap.on').waitFor({ state:'visible' });

/* ⭐ מצב „שולח…". הכתיבה מוחזקת כדי שאפשר יהיה לראות את הרגע
 * שבין הלחיצה לתשובה — הרגע שבו אדם לוחץ פעם שנייה. */
await page.evaluate(() => { window.__FIRESTORE_HOLD_UPDATES = true; });
await page.locator('#coYes').click();
await page.waitForFunction(() => (window.__FIRESTORE_PENDING_UPDATES || []).length >= 1);
check((await page.locator('#coYes').innerText()).includes('שולח'),
      'the accept button says it is sending', await page.locator('#coYes').innerText());
check(await page.locator('#coYes').isDisabled() && await page.locator('#coNo').isDisabled(),
      'and both answers are locked while it is in flight');
const writesDuringFlight = await page.evaluate(() => window.__FIRESTORE_WRITES.length);
await page.locator('#coYes').click({ force:true });
await page.locator('#coNo').click({ force:true });
check(await page.evaluate(() => window.__FIRESTORE_WRITES.length) === writesDuringFlight,
      'a second press while sending writes nothing at all');

await page.evaluate(() => {
  window.__FIRESTORE_HOLD_UPDATES = false;
  (window.__FIRESTORE_PENDING_UPDATES || []).splice(0).forEach(p => p.resolve());
});
await page.locator('#coDone').waitFor({ state:'visible' });
check((await page.locator('#coDone').innerText()).includes('אישרת הגעה'),
      'accepting confirms on screen instead of only closing the dialog',
      await page.locator('#coDone').innerText());
await page.evaluate(() => window.__FIRESTORE_DELIVER_CAPTURED('/callouts', []));
await page.waitForTimeout(2100);
check(!(await page.locator('#coWrap').evaluate(el => el.classList.contains('on'))),
      'and the dialog releases the screen on its own afterwards');

/* כשל: המשתמש רואה עברית, ולעולם לא קוד. */
await page.evaluate(() => {
  window.__FIRESTORE_WRITES = [];
  window.__FIRESTORE_WRITE_FAIL_PATHS = ['/responses/'];
});
await page.evaluate(row => window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [row]), {
  id:'failing-callout',
  data:{ active:true, uids:['identity-a'], text:'קריאה שתיכשל',
    by_name:'מפקד', created_key:new Date().toISOString(), acks:{} }
});
await page.locator('#coWrap.on').waitFor({ state:'visible' });
await page.locator('#coYes').click();
await page.locator('#coErr').waitFor({ state:'visible' });
const failureText = await page.locator('#coErr').innerText();
check(!/firestore\/|functions\/|permission-denied|unavailable|[a-z]+\/[a-z-]+/.test(failureText),
      'the failure message carries no technical error code at all', failureText);
check(failureText.includes('התשובה לא נשמרה') && failureText.includes('אינו זמין'),
      'and it says in Hebrew what happened', failureText);
check(!(await page.locator('#coYes').isDisabled()),
      'a failed answer leaves the buttons usable for a real retry');
await page.evaluate(() => {
  window.__FIRESTORE_WRITE_FAIL_PATHS = [];
  window.__FIRESTORE_DELIVER_CAPTURED('/callouts', []);
});

const callout = {
  id:'held-callout',
  data:{ active:true, uids:['identity-a'], text:'קריאה ישנה',
    by_name:'מפקד', created_key:new Date().toISOString(), acks:{} }
};
await page.evaluate(() => window.__FIRESTORE_DELIVER_CAPTURED('/callouts', []));
await page.waitForTimeout(20);
const warningsBeforeLateError = calloutWarnings.length;
await page.evaluate(row => {
  window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [row], { oldest:true });
  window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [], { oldest:true, error:true });
}, callout);
await page.waitForTimeout(30);
check(!(await page.locator('#coWrap').evaluate(el => el.classList.contains('on'))),
      'late snapshot and late error from a disposed owner cannot reopen the overlay',
      await page.locator('#coText').textContent());
check(calloutWarnings.length === warningsBeforeLateError,
      'a disposed snapshot error callback performs no stale side effect');

await page.evaluate(row =>
  window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [row]), callout);
await page.locator('#coWrap.on').waitFor({ state:'visible' });
check((await page.locator('#coText').textContent()) === 'קריאה ישנה',
      'the current owner can still display a valid callout');

await page.evaluate(() => { window.__FIRESTORE_HOLD_UPDATES = true; });
await page.locator('#coYes').click();
await page.evaluate(() => window.__SMOKE_EMIT_AUTH('firefighter', 'identity-b'));
await page.waitForTimeout(220);
await page.evaluate(() => window.__FIRESTORE_DELIVER_CAPTURED('/callouts', []));
await page.waitForTimeout(20);
await page.evaluate(() => window.__FIRESTORE_RELEASE_UPDATES(true));
await page.waitForTimeout(30);
const afterHeldAck = await page.evaluate(() => ({
  open:document.getElementById('coWrap').classList.contains('on'),
  error:document.getElementById('coErr').textContent
}));
check(!afterHeldAck.open && !afterHeldAck.error,
      'a held acknowledgement cannot mutate the replacement identity UI',
      JSON.stringify(afterHeldAck));

const replacementCallout = {
  id:'replacement-callout',
  data:{ active:true, uids:['identity-b'], text:'קריאה של הזהות החדשה',
    by_name:'מפקד', created_key:new Date().toISOString(), acks:{} }
};
await page.evaluate(row => {
  window.__FIRESTORE_HOLD_UPDATES = true;
  window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [row]);
}, replacementCallout);
await page.locator('#coWrap.on').waitFor({ state:'visible' });
await page.locator('#coYes').click();
await page.evaluate(() => window.__SMOKE_EMIT_AUTH('firefighter', 'identity-a'));
await page.waitForTimeout(220);
const newOwnerCallout = {
  id:'new-owner-callout',
  data:{ active:true, uids:['identity-a'], text:'קריאה של הזהות החדשה',
    by_name:'מפקד', created_key:new Date().toISOString(), acks:{} }
};
await page.evaluate(row =>
  window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [row]), newOwnerCallout);
await page.locator('#coWrap.on').waitFor({ state:'visible' });
await page.evaluate(() => window.__FIRESTORE_RELEASE_UPDATES(false));
await page.waitForTimeout(30);
const afterSuccessfulOldAck = await page.evaluate(() => ({
  open:document.getElementById('coWrap').classList.contains('on'),
  text:document.getElementById('coText').textContent,
  yesDisabled:document.getElementById('coYes').disabled,
  noDisabled:document.getElementById('coNo').disabled
}));
check(afterSuccessfulOldAck.open &&
      afterSuccessfulOldAck.text === 'קריאה של הזהות החדשה' &&
      !afterSuccessfulOldAck.yesDisabled && !afterSuccessfulOldAck.noDisabled,
      'a successful old acknowledgement cannot close the new owner callout',
      JSON.stringify(afterSuccessfulOldAck));

await page.evaluate(() => window.__SMOKE_EMIT_AUTH(null));
await page.waitForTimeout(80);
check(await active('/callouts') === 0,
      'logout removes the callout listener');
check(await active('config/mode') === 0,
      'logout removes the mode listener');
const cleared = await page.evaluate(() => ({
  open:document.getElementById('coWrap')?.classList.contains('on') || false,
  text:document.getElementById('coText')?.textContent || '',
  from:document.getElementById('coFrom')?.textContent || '',
  yes:document.getElementById('coYes')?.onclick || null,
  no:document.getElementById('coNo')?.onclick || null
}));
check(!cleared.open && !cleared.text && !cleared.from && !cleared.yes && !cleared.no,
      'logout clears the old identity overlay and button handlers');
check(await page.locator('#modeChip').count() === 0,
      'logout removes the mode chip with the rest of the identity');
check(!(await page.locator('body').evaluate(el => el.classList.contains('has-trial-mode'))),
      'and releases the trial marker on the document');
check(errors.length === 0, 'no browser exception occurred', errors.join(' | '));

await context.close();
await browser.close();
await new Promise(resolve => server.close(resolve));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
