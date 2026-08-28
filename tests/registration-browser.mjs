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
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ?
    'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, resolve));
const base = 'http://localhost:' + server.address().port;

let passed = 0;
function check(value, message) {
  if (!value) throw new Error(message);
  passed++;
  console.log('✓ ' + message);
}

async function open(browser, setup, pagePath = '/login.html') {
  const context = await browser.newContext({
    viewport:{ width:390, height:844 }, locale:'he-IL',
    reducedMotion:'reduce'
  });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(value => Object.assign(window, value), setup);
  const page = await context.newPage();
  await page.goto(base + pagePath, { waitUntil:'load' });
  return { context, page };
}

async function fillRequest(page) {
  await page.locator('#fName').fill('כבאי בדיקה');
  await page.locator('#fPhone').fill('0501234567');
  await page.locator('#fDistrict').selectOption('south');
  await page.locator('#fStation').selectOption('eilat_102');
  await page.locator('#fShift').selectOption('A');
}

function identityPlan(claims) {
  return { whoAmI:[{ data:{ signedIn:true, uid:'stub-uid',
                            claims_on_server:claims || {} } }] };
}

const browser = await chromium.launch();
try {
  // חשבון שנדחה נשאר קיים ב-Auth, אבל מסמך הבקשה נמחק.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'pending', __REGISTRATION_REQUEST_EXISTS:false,
      __CALLABLE_PLAN:identityPlan({})
    });
    await page.locator('#btnResubmit').waitFor({ state:'visible' });
    await page.locator('#btnResubmit').click();
    check(await page.locator('#paneFirst').isVisible(),
          'rejected account opens the existing-account request form');
    check(await page.locator('#newPasswordFields').isHidden(),
          're-submit does not ask for a new password');
    check(!(await page.locator('#fEmail').isEditable()),
          're-submit locks the email to the signed-in account');
    check(await page.locator('#fCode').count() === 0,
          'registration exposes no immediate station-code path');
    check(await page.locator('#btnResubmitCancel').isVisible(),
          're-submit provides an explicit recovery control');
    await fillRequest(page);
    await page.locator('#btnFirst').click();
    await page.locator('#waitView').waitFor({ state:'visible' });
    const result = await page.evaluate(() => ({
      writes:(window.__FIRESTORE_WRITES || []).filter(x =>
        x.path === 'registration_requests/stub-uid'),
      auth:window.__AUTH_CALLS || [], calls:window.__CALLABLE_CALLS || []
    }));
    check(result.writes.length === 1,
          're-submit writes one request under the existing uid');
    check(result.writes[0].value.status === 'pending' &&
          result.writes[0].value.email === 'eldad50@gmail.com',
          're-submit keeps the current schema and authenticated email');
    check(!result.auth.some(x => x.name === 'createUserWithEmailAndPassword'),
          're-submit does not create a second Auth account');
    check(!result.auth.some(x => x.name === 'deleteUser'),
          'successful re-submit never deletes the existing account');
    check(result.calls.filter(x => x.name === 'whoAmI').length === 1,
          're-submit checks live server claims exactly once');
    check(!result.calls.some(x => x.name === 'joinWithCode'),
          're-submit never calls the non-atomic station-code path');
    await context.close();
  }

  // בקשה שנוצרה בלשונית אחרת בזמן מילוי הטופס אינה נדרסת.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'pending', __REGISTRATION_REQUEST_EXISTS:false,
      __CALLABLE_PLAN:identityPlan({})
    });
    await page.locator('#btnResubmit').waitFor({ state:'visible' });
    await page.locator('#btnResubmit').click();
    await fillRequest(page);
    await page.evaluate(() => { window.__REGISTRATION_REQUEST_EXISTS = true; });
    await page.locator('#btnFirst').click();
    await page.locator('#waitView').waitFor({ state:'visible' });
    const writes = await page.evaluate(() => window.__FIRESTORE_WRITES || []);
    check(!writes.some(x => x.path === 'registration_requests/stub-uid'),
          'an existing pending request is not overwritten');
    await context.close();
  }

  // אם אי אפשר לאמת claims חיים, הפעולה נכשלת סגור.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'pending', __REGISTRATION_REQUEST_EXISTS:false,
      __CALLABLE_PLAN:{ whoAmI:[{ reject:true, code:'functions/unavailable' }] }
    });
    await page.locator('#btnResubmit').waitFor({ state:'visible' });
    await page.locator('#btnResubmit').click();
    await fillRequest(page);
    await page.locator('#btnFirst').click();
    await page.locator('#msg.err').waitFor({ state:'visible' });
    const state = await page.evaluate(() => ({
      writes:window.__FIRESTORE_WRITES || [], auth:window.__AUTH_CALLS || []
    }));
    check(state.writes.length === 0,
          'server-identity failure writes no request');
    check(!state.auth.some(x => x.name === 'deleteUser'),
          'server-identity failure preserves the existing account');
    check(await page.locator('#btnResubmitCancel').isVisible(),
          'server-identity failure leaves a visible recovery control');
    await page.locator('#btnResubmitCancel').click();
    await page.locator('#waitView').waitFor({ state:'visible' });
    check(await page.locator('#btnLogoutWait').isVisible(),
          'recovery returns to a screen with sign-out');
    await context.close();
  }

  // כשל Firestore מוחק רק חשבון חדש, לא חשבון שהוגש מחדש.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'pending', __REGISTRATION_REQUEST_EXISTS:false,
      __FIRESTORE_WRITE_FAIL_PATHS:['registration_requests/'],
      __CALLABLE_PLAN:identityPlan({})
    });
    await page.locator('#btnResubmit').waitFor({ state:'visible' });
    await page.locator('#btnResubmit').click();
    await fillRequest(page);
    await page.locator('#btnFirst').click();
    await page.locator('#msg.err').waitFor({ state:'visible' });
    const calls = await page.evaluate(() => window.__AUTH_CALLS || []);
    check(!calls.some(x => x.name === 'deleteUser'),
          'Firestore failure never deletes a reused Auth account');
    await context.close();
  }

  // emp לבדו אינו שיוך שלם ואסור שיטען את מסך הבית.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'pending', __REGISTRATION_REQUEST_EXISTS:false,
      __CALLABLE_PLAN:identityPlan({ emp:'17' })
    });
    await page.locator('#btnResubmit').waitFor({ state:'visible' });
    await page.locator('#btnResubmit').click();
    await fillRequest(page);
    await page.locator('#btnFirst').click();
    await page.locator('#waitView').waitFor({ state:'visible' });
    const state = await page.evaluate(() => ({
      writes:window.__FIRESTORE_WRITES || [], auth:window.__AUTH_CALLS || []
    }));
    check(state.writes.length === 0,
          'employee-only live claims fail closed without creating a request');
    check(!state.auth.some(x => x.name === 'getIdToken'),
          'employee-only claims do not reload as an approved account');
    check((await page.locator('#waitTtl').textContent()).includes('אינו שלם'),
          'partial live claims show the safe assignment recovery state');
    await context.close();
  }

  // גם בניתוב הראשוני emp לבדו נכשל סגור ולא טוען את הבית.
  {
    const { context, page } = await open(browser, { __SMOKE_ROLE:'emp_only' });
    await page.locator('#waitView').waitFor({ state:'visible' });
    check(await page.locator('#homeView').isHidden(),
          'initial employee-only token never opens the home screen');
    check((await page.locator('#waitTtl').textContent()).includes('אינו שלם'),
          'initial employee-only token opens assignment recovery');
    check(await page.locator('#btnLogoutWait').isVisible(),
          'initial partial token still offers sign-out');
    await context.close();
  }

  // שיוך מלא ומנהל-על ממשיכים להיכנס כרגיל.
  for (const role of ['firefighter', 'super']) {
    const { context, page } = await open(browser, { __SMOKE_ROLE:role });
    await page.locator('#homeView').waitFor({ state:'visible' });
    check(await page.locator('#bulletinBoard').isVisible(),
          role + ' complete token still opens the home screen');
    await context.close();
  }

  // שיוך מלא בטוקן השרת מרענן את הטוקן ולא יוצר בקשה חדשה.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'pending', __REGISTRATION_REQUEST_EXISTS:false,
      __AUTH_HOLD_TOKEN:true,
      __CALLABLE_PLAN:identityPlan({
        emp:'17', role:'firefighter', stationId:'eilat_102'
      })
    });
    await page.locator('#btnResubmit').waitFor({ state:'visible' });
    await page.locator('#btnResubmit').click();
    await fillRequest(page);
    await page.locator('#btnFirst').click();
    await page.waitForFunction(() => (window.__AUTH_CALLS || []).some(x =>
      x.name === 'getIdToken'));
    const state = await page.evaluate(() => ({
      writes:window.__FIRESTORE_WRITES || [], auth:window.__AUTH_CALLS || []
    }));
    check(state.writes.length === 0,
          'complete live claims create no duplicate request');
    check(state.auth.some(x => x.name === 'getIdToken' && x.detail.force === true),
          'complete live claims force a fresh token before reload');
    await context.close();
  }

  // המסלול הקיים של הרשמה ראשונה עדיין מסתיים בבקשת pending.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'pending', __SMOKE_SIGNED_OUT:true
    });
    await page.locator('#tabFirst').waitFor({ state:'visible' });
    await page.locator('#tabFirst').click();
    await fillRequest(page);
    await page.locator('#fEmail').fill('new@example.com');
    await page.locator('#fPass').fill('StrongPass1');
    await page.locator('#fPass2').fill('StrongPass1');
    await page.locator('#btnFirst').click();
    await page.locator('#waitView').waitFor({ state:'visible' });
    const state = await page.evaluate(() => ({
      writes:window.__FIRESTORE_WRITES || [], auth:window.__AUTH_CALLS || [],
      calls:window.__CALLABLE_CALLS || []
    }));
    check(state.writes.filter(x =>
      x.path === 'registration_requests/stub-uid').length === 1,
      'first registration still creates one pending request');
    check(state.auth.filter(x =>
      x.name === 'createUserWithEmailAndPassword').length === 1,
      'first registration still creates one Auth account');
    check(!state.calls.some(x => x.name === 'whoAmI'),
      'first registration does not use the re-submit identity check');
    check(!state.calls.some(x => x.name === 'joinWithCode'),
      'first registration waits for manual approval without station-code join');
    await context.close();
  }

  // המסלול הקיים של משתמש חדש נשאר תקין ומנקה יצירה חלקית.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'newuser', __SMOKE_SIGNED_OUT:true,
      __REGISTRATION_REQUEST_EXISTS:false,
      __FIRESTORE_WRITE_FAIL_PATHS:['registration_requests/']
    });
    await page.locator('#tabFirst').waitFor({ state:'visible' });
    await page.locator('#tabFirst').click();
    await fillRequest(page);
    await page.locator('#fEmail').fill('new@example.com');
    await page.locator('#fPass').fill('StrongPass1');
    await page.locator('#fPass2').fill('StrongPass1');
    await page.locator('#btnFirst').click();
    await page.locator('#msg.err').waitFor({ state:'visible' });
    const calls = await page.evaluate(() => window.__AUTH_CALLS || []);
    check(calls.filter(x => x.name === 'createUserWithEmailAndPassword').length === 1,
          'first registration still creates one Auth account');
    check(calls.filter(x => x.name === 'deleteUser').length === 1,
          'confirmed failed first request cleans up only the account created now');
    await context.close();
  }

  // אם הכתיבה הצליחה ורק התשובה אבדה, החשבון והבקשה נשמרים.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'newuser', __SMOKE_SIGNED_OUT:true,
      __REGISTRATION_REQUEST_EXISTS:false,
      __FIRESTORE_WRITE_FAIL_AFTER_COMMIT_PATHS:['registration_requests/']
    });
    await page.locator('#tabFirst').waitFor({ state:'visible' });
    await page.locator('#tabFirst').click();
    await fillRequest(page);
    await page.locator('#fEmail').fill('new@example.com');
    await page.locator('#fPass').fill('StrongPass1');
    await page.locator('#fPass2').fill('StrongPass1');
    await page.locator('#btnFirst').click();
    await page.locator('#waitView').waitFor({ state:'visible' });
    const state = await page.evaluate(() => ({
      calls:window.__AUTH_CALLS || [], exists:window.__REGISTRATION_REQUEST_EXISTS === true
    }));
    check(!state.calls.some(x => x.name === 'deleteUser'),
          'lost write response preserves the new Auth account');
    check(state.exists,
          'lost write response is verified as a saved request');
    await context.close();
  }

  // אם גם קריאת האימות נכשלה, נשמר החשבון ומוצג מצב התאוששות.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'newuser', __SMOKE_SIGNED_OUT:true,
      __REGISTRATION_REQUEST_EXISTS:false,
      __REGISTRATION_REQUEST_READ_FAIL:true,
      __FIRESTORE_WRITE_FAIL_PATHS:['registration_requests/']
    });
    await page.locator('#tabFirst').waitFor({ state:'visible' });
    await page.locator('#tabFirst').click();
    await fillRequest(page);
    await page.locator('#fEmail').fill('new@example.com');
    await page.locator('#fPass').fill('StrongPass1');
    await page.locator('#fPass2').fill('StrongPass1');
    await page.locator('#btnFirst').click();
    await page.locator('#waitView').waitFor({ state:'visible' });
    const state = await page.evaluate(() => ({
      calls:window.__AUTH_CALLS || [], title:document.getElementById('waitTtl').textContent
    }));
    check(!state.calls.some(x => x.name === 'deleteUser'),
          'ambiguous write result preserves the new Auth account');
    check(state.title.includes('לא אומת'),
          'ambiguous write result presents a safe recovery state');
    await context.close();
  }

  // לאחר ניתוק/רענון, כרטיס processing מציג את התוכנית שננעלה
  // ולא ברירות מחדל חדשות. ההמשך שולח רק מזהי התאוששות.
  {
    const fingerprint = 'f'.repeat(64);
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'super',
      __REGISTRATION_REQUESTS:[['u-locked-plan', {
        full_name:'כבאי תוכנית', email:'locked@example.com', phone:'0500000000',
        districtId:'south', stationId:'eilat_102', shift:'A',
        status:'processing', request_id:'request-locked-plan-0001',
        server_generation:'server-generation-locked-plan',
        resumable:true,
        operation_id:'approve-locked-plan-operation',
        plan_fingerprint:fingerprint,
        locked_plan:{ kind:'approve', role:'commander', shift:'B',
          stationId:'eilat_102', districtId:'south', emp:'8123' }
      }]],
      __CALLABLE_PLAN:{
        resumeIdentityOperation:[{ data:{ ok:true, uid:'u-locked-plan',
          role:'commander', emp:'8123', message:'האישור השמור הושלם.' } }]
      }
    }, '/admin.html');
    const card = page.locator('#list .req').first();
    await card.waitFor({ state:'visible' });
    const text = await card.textContent();
    check(text.includes('מפקד משמרת') && text.includes('משמרת B') && text.includes('8123'),
      'processing reload shows the exact locked commander/B/8123 plan');
    check(await card.locator('[data-f="role"],[data-f="shift"],[data-f="emp"]').count() === 0,
      'locked registration plan has no editable role, shift or employee fields');
    await page.evaluate(() => { window.confirm = () => true; });
    await card.locator('[data-act="resume"]').evaluate(el => el.click());
    await page.waitForFunction(() => (window.__CALLABLE_CALLS || [])
      .some(x => x.name === 'resumeIdentityOperation'));
    const calls = await page.evaluate(() => window.__CALLABLE_CALLS || []);
    const resume = calls.filter(x => x.name === 'resumeIdentityOperation')[0];
    check(!!resume && JSON.stringify(Object.keys(resume.payload).sort()) ===
      JSON.stringify(['operation_id','plan_fingerprint','uid']),
      'resume sends only uid, operation id and plan fingerprint');
    check(resume.payload.uid === 'u-locked-plan' &&
      resume.payload.operation_id === 'approve-locked-plan-operation' &&
      resume.payload.plan_fingerprint === fingerprint,
      'resume payload matches the locked plan exactly');
    await context.close();
  }

  // needs_recovery בלי operation אינה תוכנית שאפשר להמשיך. המסך
  // מציע סגירה שרתית מדויקת ואינו ממציא תוכנית או מזהי resume.
  {
    const { context, page } = await open(browser, {
      __SMOKE_ROLE:'super',
      __REGISTRATION_REQUESTS:[['u-orphan-review', {
        full_name:'כבאי בקשה תקועה', email:'orphan@example.com', phone:'0500000000',
        districtId:'south', stationId:'eilat_102', shift:'A',
        status:'needs_recovery', request_id:'request-orphan-review-0001',
        server_generation:'server-orphan-review-0001',
        operation_id:'stale-operation-that-no-longer-exists',
        plan_fingerprint:'a'.repeat(64),
        locked_plan:{ kind:'approve', role:'commander', shift:'C',
          stationId:'other_99', districtId:'north', emp:'9999' },
        recovery_reason:'orphan_processing_request'
      }]],
      __CALLABLE_PLAN:{
        rejectRegistration:[{ data:{ ok:true, uid:'u-orphan-review' } }]
      }
    }, '/admin.html');
    const card = page.locator('#list .req').first();
    await card.waitFor({ state:'visible' });
    const text = await card.textContent();
    check(text.includes('אין לבקשה תוכנית שרתית'),
      'orphan recovery is explained without inventing a locked plan');
    check(await card.locator('[data-act="resume"],[data-f="role"],[data-f="shift"],[data-f="emp"]').count() === 0,
      'orphan recovery exposes neither resume nor editable identity fields');
    check(await card.locator('[data-act="dismiss"]').count() === 1,
      'orphan recovery offers an explicit server-side dismissal');
    await page.evaluate(() => { window.confirm = () => true; });
    await card.locator('[data-act="dismiss"]').evaluate(el => el.click());
    await page.waitForFunction(() => (window.__CALLABLE_CALLS || [])
      .some(x => x.name === 'rejectRegistration'));
    const calls = await page.evaluate(() => window.__CALLABLE_CALLS || []);
    const dismiss = calls.filter(x => x.name === 'rejectRegistration')[0];
    check(!!dismiss && dismiss.payload.uid === 'u-orphan-review' &&
      dismiss.payload.request_id === 'request-orphan-review-0001' &&
      dismiss.payload.request_generation === 'server-orphan-review-0001' &&
      !calls.some(x => x.name === 'resumeIdentityOperation'),
      'orphan dismissal uses exact request identity and never calls resume');
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log('Registration browser checks passed: ' + passed);
