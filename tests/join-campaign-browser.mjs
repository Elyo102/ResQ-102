// קליטה בקישור קבוצתי — בדיקות דפדפן על המסכים האמיתיים והמודולים האמיתיים.
// Firebase, callables, לוח ההעתקה וספק ההתראות — מדומים. שום קצה מרוחק לא נגיש.
// צילומי מסך: RESQ_JOIN_SCREENSHOT_DIR (320/360/390, בהיר וכהה).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const launch = process.env.RESQ_CHROMIUM ? { headless: true, executablePath: process.env.RESQ_CHROMIUM } : { headless: true };
const browser = await chromium.launch(launch);
let passed = 0;
function check(name, value) { assert(value, name); passed++; console.log('PASS ' + name); }
const SHOT_DIR = process.env.RESQ_JOIN_SCREENSHOT_DIR ? path.resolve(process.env.RESQ_JOIN_SCREENSHOT_DIR) : '';
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });
async function shots(page, name, selector, widths = [320, 360, 390]) {
  if (!SHOT_DIR) return;
  // הנפשות הכניסה של login.html משאירות opacity 0 בצילום; מסיימים אותן ומקבעים את השרשרת.
  await page.evaluate((sel) => {
    document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} });
    let el = document.querySelector(sel);
    while (el) { el.style.opacity = '1'; el.style.animation = 'none'; el.style.transition = 'none'; el.style.transform = 'none'; el = el.parentElement; }
  }, selector);
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.waitForTimeout(30);
    await page.locator(selector).screenshot({ path: path.join(SHOT_DIR, name + '-' + w + '.png') });
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.setViewportSize({ width: 360, height: 844 });
  await page.locator(selector).screenshot({ path: path.join(SHOT_DIR, name + '-360-dark.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.setViewportSize({ width: 390, height: 844 });
}
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}
async function minTouch(page, selector) {
  return page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).filter((b) => b.offsetParent !== null).every((b) => b.offsetHeight >= 44), selector);
}
function moduleTag(file, globalName) {
  const src = read(file).replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ');
  const names = [...read(file).matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  return { type: 'module', content: src + '\nwindow.' + globalName + ' = { ' + names.join(', ') + ' };\nwindow.dispatchEvent(new Event("' + globalName + ':ready"));' };
}
async function pageFor(name) {
  const html = read(name);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(8000);
  await page.route('**/*', (route) => route.abort());
  const localHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1] || '';
    if (!/\.css(?:\?|$)/i.test(href) || /^(?:https?:|\/\/)/i.test(href)) return '';
    const file = path.resolve(root, href.split('?')[0]);
    return file.startsWith(root + path.sep) && fs.existsSync(file) ? '<style>' + fs.readFileSync(file, 'utf8') + '</style>' : '';
  });
  await page.setContent(localHtml);
  if (name === 'login.html') await page.evaluate(() => document.body.classList.add('art', 'ready'));
  await page.evaluate(() => { document.body.style.opacity = '1'; document.body.style.animation = 'none'; });
  return { page, html };
}
const CATALOG = [{ key: 'driver', label: 'נהגים' }, { key: 'hazmat', label: 'חומ״ס' }, { key: 'shift_lead', label: 'ראש משמרת' }];
try {
  /* ============ login.html?join= ============ */
  {
    const { page } = await pageFor('login.html');
    await page.evaluate(() => { ['bootView', 'authView'].forEach((id) => document.getElementById(id).classList.remove('hide')); document.getElementById('joinPanel').classList.remove('hide'); document.getElementById('authTabs').classList.add('hide'); document.getElementById('paneLogin').classList.add('hide'); });
    await page.addScriptTag(moduleTag('join-ui.js', 'JoinUI'));
    await page.waitForFunction(() => !!window.JoinUI);
    await page.evaluate((catalog) => {
      window.calls = []; window.inspectView = { state: 'active', station_name: 'אילת <b>x</b>', allowed_shifts: ['A', 'C'], qualification_catalog: catalog };
      window.inspectFail = false; window.redeemError = null; window.verified = false; window.user = null; window.verifySent = 0; window.routed = 0;
      const token = 'AAAAAAAAAAAAAAAA.' + 'B'.repeat(43);
      window.panel = JoinUI.createJoinPanel(document.getElementById('joinPanel'), {
        token,
        inspect: async (d) => { calls.push(['inspect', d]); if (inspectFail) throw new Error('offline'); return inspectView; },
        redeem: async (d) => { calls.push(['redeem', JSON.parse(JSON.stringify(d))]); if (redeemError) { const e = new Error('server'); e.details = { reason: redeemError }; throw e; } return { ok: true, replayed: calls.filter((c) => c[0] === 'redeem').length > 1 }; },
        currentUser: () => user,
        createAccount: async (email) => { user = { uid: 'w1', email, emailVerified: false }; },
        signIn: async (email) => { user = { uid: 'w1', email, emailVerified: false }; },
        sendVerification: async () => { verifySent++; },
        refreshUser: async () => { if (user) user.emailVerified = verified; },
        claims: async () => ({}),
        hasAssignment: (c) => !!c.role, pwOk: (p) => p.length >= 8,
        onRedeemed: async () => { routed++; }
      });
    }, CATALOG);
    // מצבי קצה
    for (const state of ['paused', 'expired', 'revoked', 'full', 'not_found']) {
      await page.evaluate((s) => { inspectView = { state: s }; panel.load(); }, state);
      await page.waitForFunction((s) => document.getElementById('joinPanel').dataset.joinState === s, state);
      check('join state screen: ' + state, await page.locator('#joinTitle').textContent().then((t) => t.length > 3) && await page.locator('#joinForm').count() === 0);
      if (state === 'expired') await shots(page, 'login-join-expired', '#joinPanel');
    }
    await page.evaluate(() => { inspectFail = true; panel.load(); });
    await page.waitForFunction(() => document.getElementById('joinPanel').dataset.joinState === 'network');
    check('network failure shows retry, not a dead screen', await page.locator('#joinPanel button', { hasText: 'נסה שוב' }).count() === 1);
    await page.evaluate((catalog) => { inspectFail = false; inspectView = { state: 'active', station_name: 'אילת <b>x</b>', allowed_shifts: ['A', 'C'], qualification_catalog: catalog }; }, CATALOG);
    await page.locator('#joinPanel button', { hasText: 'נסה שוב' }).click();
    await page.waitForFunction(() => document.getElementById('joinPanel').dataset.joinState === 'active');
    check('station name is rendered as text, never as markup', await page.locator('#joinTitle').textContent().then((t) => t.includes('<b>x</b>')) && await page.locator('#joinTitle b').count() === 0);
    check('only campaign shifts are offered (A, C)', await page.locator('input[name="joinShift"]').evaluateAll((els) => els.map((e) => e.value).join(',')) === 'A,C');
    check('catalog qualifications rendered from the server catalog', await page.locator('.join-qual').count() === 3);
    check('submit is locked before the account exists', await page.locator('#joinSubmit').isDisabled());
    check('no horizontal overflow at 390', await noOverflow(page));
    await shots(page, 'login-join-form', '#joinPanel');
    check('all controls are at least 44px tall', await minTouch(page, '#joinPanel button, #joinPanel input:not([type=checkbox]):not([type=radio])'));
    // חשבון
    await page.locator('#joinEmail').fill('worker@example.test'); await page.locator('#joinPassword').fill('Password123');
    await page.locator('#joinPanel button', { hasText: 'יצירת חשבון' }).click();
    await page.waitForFunction(() => document.getElementById('joinWho'));
    check('after account creation a verification mail is sent and submit stays locked', await page.evaluate(() => verifySent === 1) && await page.locator('#joinSubmit').isDisabled());
    await page.evaluate(() => { verified = true; });
    await page.locator('#joinPanel button', { hasText: 'אימתתי' }).click();
    await page.waitForFunction(() => !document.getElementById('joinSubmit').disabled);
    // פרטים + הצהרה
    await page.locator('#joinName').fill('בודק דמה'); await page.locator('#joinPhone').fill('050-1234567');
    await page.locator('#joinShift_C').check();
    await page.locator('#joinQual_driver').check(); await page.locator('#joinQual_driver_until').fill('2030-01-01'); await page.locator('#joinQual_driver_ref').fill('רישיון C');
    await page.locator('#joinSubmit').click();
    await page.waitForFunction(() => document.getElementById('joinStatus').textContent.includes('נכונות'));
    check('acknowledgement is required before sending', await page.evaluate(() => calls.filter((c) => c[0] === 'redeem').length === 0));
    await page.locator('#joinAck').check();
    await page.evaluate(() => { redeemError = 'campaign-full'; });
    await page.locator('#joinSubmit').click();
    await page.waitForFunction(() => document.getElementById('joinPanel').dataset.joinState === 'full');
    check('server-side full/revoked answer switches to the terminal screen', true);
    await page.evaluate((catalog) => { redeemError = null; inspectView = { state: 'active', station_name: 'אילת', allowed_shifts: ['A', 'C'], qualification_catalog: catalog }; panel.load(); }, CATALOG);
    await page.waitForFunction(() => document.getElementById('joinPanel').dataset.joinState === 'active');
    check('draft (name/phone) survives a re-render', await page.locator('#joinName').inputValue() === 'בודק דמה');
    await page.locator('#joinShift_C').check(); await page.locator('#joinQual_driver').check(); await page.locator('#joinQual_driver_until').fill('2030-01-01'); await page.locator('#joinAck').check();
    await page.locator('#joinSubmit').click();
    await page.waitForFunction(() => document.getElementById('joinStatus').textContent.includes('ממתינה לאישור'));
    const payload = await page.evaluate(() => calls.filter((c) => c[0] === 'redeem').pop()[1]);
    check('redeem payload has exactly the contract keys', Object.keys(payload).sort().join(',') === 'ack,full_name,phone,qualifications,request_id,shift,token');
    check('redeem payload carries no role/station/email', !('role' in payload) && !('station_id' in payload) && !('email' in payload));
    check('shift and declaration come from the form', payload.shift === 'C' && payload.qualifications.length === 1 && payload.qualifications[0].key === 'driver' && payload.qualifications[0].valid_until_ms > Date.now());
    check('success text makes no grant claim', await page.locator('#joinStatus').textContent().then((t) => t.includes('עדיין לא הוענקו הרשאות')));
    check('route continues after redemption', await page.evaluate(() => routed === 1));
    // replay: same request id on retry
    const first = payload.request_id;
    await page.evaluate(() => { try { sessionStorage.setItem('resq_join_request_AAAAAAAAAAAAAAAA', 'jc_replay_0000000000000000'); } catch (e) {} });
    check('request id is a random opaque id (not derived from the token)', /^jc_[0-9a-f]{48}$/.test(first) && !first.includes('AAAAAAAAAAAAAAAA'));
    // סטטוס המתנה ובאנר
    await page.evaluate(() => {
      document.getElementById('waitView').classList.remove('hide');
      JoinUI.renderJoinStatus(document.getElementById('joinStatusBox'), { found: true, shift: 'A', review_state: 'returned', review_note: 'טלפון <script>x</script>', summary: { verified: 1, pending: 1, rejected: 0, expired: 0, declared: 0 } });
      JoinUI.renderReadinessBanner(document.getElementById('readinessBanner'), { operational_ready: false, blockers: ['device_not_ready'] });
      document.getElementById('homeView').classList.remove('hide');
    });
    check('waiting screen shows the correction note as text', await page.locator('#joinStatusBox').textContent().then((t) => t.includes('טלפון <script>x</script>')) && await page.locator('#joinStatusBox script').count() === 0);
    check('readiness banner links to the wizard only when not ready', await page.locator('#readinessBanner a[href="./device-readiness.html"]').count() === 1);
    await page.evaluate(() => JoinUI.renderReadinessBanner(document.getElementById('readinessBanner'), { operational_ready: true, blockers: [] }));
    check('readiness banner hidden when ready', await page.locator('#readinessBanner').evaluate((n) => n.classList.contains('hide')));
    await shots(page, 'login-join-status', '#waitView');
    await page.close();
  }

  /* ============ admin.html — כרטיס קמפיין + אישור מרוכז ============ */
  for (const mode of ['super', 'hr']) {
    const { page } = await pageFor('admin.html');
    await page.evaluate(() => { document.getElementById('work').classList.remove('hide'); document.getElementById('authCard').classList.add('hide'); document.getElementById('joinAdminCard').classList.remove('hide'); });
    await page.addScriptTag(moduleTag('join-admin-ui.js', 'JoinAdmin'));
    await page.waitForFunction(() => !!window.JoinAdmin);
    await page.evaluate((isSuper) => {
      window.calls = []; window.approved = []; window.rows = [];
      for (let i = 0; i < 30; i++) rows.push({ uid: 'u' + i, request_id: 'req_' + i, shift: ['A', 'B', 'C'][i % 3], note: '', full_name: 'בודק ' + i, email: 'w' + i + '@example.test', phone: '05000000' + (i % 10),
        request_status: i % 9 === 8 ? 'approved' : 'pending', request_generation: 'g' + i, email_verified: i % 5 !== 4, account_disabled: false,
        review_state: i % 7 === 6 ? 'returned' : 'none', review_note: i % 7 === 6 ? 'חסר טלפון' : '', review_at_ms: null,
        declarations: i % 2 ? [{ key: 'driver', status: i % 9 === 8 ? 'pending_verification' : 'declared', valid_until_ms: null, reference: null, reject_reason: null, revision: 1 }] : [],
        summary: { verified: 0, pending: 0, rejected: 0, expired: 0, declared: i % 2 }, revision: 1, created_at_ms: 1_800_000_000_000 + i, ack: null });
      const campaign = { campaign_id: 'AAAAAAAAAAAAAAAA', station_id: 'eilat', district_id: 'south', label: 'קליטת ספטמבר', allowed_shifts: ['A', 'B', 'C'], max_registrations: 50, accepted_count: 30, status: 'active', state: 'active', expires_at_ms: Date.now() + 864000000, revision: 1, created_by_role: 'super', created_at_ms: 1, updated_at_ms: 1 };
      window.campaign = campaign;
      window.admin = JoinAdmin.createJoinAdmin(document.getElementById('joinAdminCard'), {
        isSuper, canApprove:true, stationId: 'eilat', stations: [{ id: 'eilat', name: 'אילת' }, { id: 'haifa', name: 'חיפה' }], stationName: (id) => ({ eilat: 'אילת', haifa: 'חיפה' })[id] || id, base: 'https://example.test/app/admin.html',
        calls: {
          create: async (d) => { calls.push(['create', d]); return { ok: true, campaign_id: 'AAAAAAAAAAAAAAAA', token: 'AAAAAAAAAAAAAAAA.' + 'B'.repeat(43), revision: 1, station_id: d.station_id || 'eilat', station_name: 'אילת', expires_at_ms: d.expires_at_ms, allowed_shifts: d.allowed_shifts }; },
          setStatus: async (d) => { calls.push(['setStatus', d]); campaign.status = d.action === 'pause' ? 'paused' : d.action === 'resume' ? 'active' : 'revoked'; campaign.state = campaign.status; campaign.revision++; return { ok: true }; },
          list: async () => ({ ok: true, campaigns: calls.some((c) => c[0] === 'create') ? [campaign] : [] }),
          registrants: async (d) => { calls.push(['registrants', d]); const start = d.cursor ? rows.findIndex((r) => r.created_at_ms === d.cursor) + 1 : 0; const slice = rows.slice(start, start + (d.limit || 50)); return { ok: true, campaign, rows: slice, next_cursor: slice.length === (d.limit || 50) ? slice[slice.length - 1].created_at_ms : null }; },
          review: async (d) => { calls.push(['review', d]); const r = rows.find((x) => x.uid === d.uid); r.review_state = d.action === 'clear' ? 'none' : d.action === 'return' ? 'returned' : 'reminded'; r.review_note = d.reason || ''; r.revision++; return { ok: true }; },
          verify: async (d) => { calls.push(['verify', d]); return { ok: true, holdings_written: true }; }
        },
        approveOne: async (row) => { approved.push(row.uid); if (row.uid === 'u3') throw new Error('request_changed'); const r = rows.find((x) => x.uid === row.uid); r.request_status = 'approved'; return { emp: '10' + row.uid.slice(1) }; },
        rejectOne: async (row) => { calls.push(['reject', row.uid]); }
      });
      window.confirm = () => true; window.prompt = () => 'טלפון שגוי';
    }, mode === 'super');
    if (mode === 'super') {
      await page.locator('#jcLabel').fill('קליטת ספטמבר'); await page.locator('#jcShiftB').uncheck(); await page.locator('#jcMax').fill('50'); await page.locator('#jcDays').fill('14');
      await page.locator('#jcCreate').click();
      await page.waitForFunction(() => !!document.getElementById('joinTokenLink'));
      const created = await page.evaluate(() => calls.find((c) => c[0] === 'create')[1]);
      check('create payload: super sends station_id, shifts uppercase subset, expiry in ms', created.station_id === 'eilat' && created.allowed_shifts.join('') === 'AC' && created.max_registrations === 50 && created.expires_at_ms > Date.now());
      check('join link built on login.html?join=<token> and shown once', await page.locator('#joinTokenLink').inputValue().then((v) => v === 'https://example.test/app/login.html?join=AAAAAAAAAAAAAAAA.' + 'B'.repeat(43)));
      const wa = JoinAdmin_whatsapp(await page.evaluate(() => JoinAdmin.whatsappText('אילת', 'https://x/login.html?join=t', Date.now() + 86400000)));
      check('WhatsApp copy text contains the link and expiry, no API call', wa.includes('https://x/login.html?join=t') && wa.includes('תקף עד'));
      await page.locator('#joinAdminCard button', { hasText: 'הסתר' }).click();
      check('token hidden on demand and not re-shown after list reload', await page.locator('#joinTokenLink').count() === 0);
      await shots(page, 'admin-join-card', '#joinAdminCard');
      await page.locator('#joinAdminCard button', { hasText: 'השהה' }).click();
      await page.waitForFunction(() => calls.some((c) => c[0] === 'setStatus'));
      check('pause sends expected_revision', await page.evaluate(() => calls.find((c) => c[0] === 'setStatus')[1].expected_revision === 1));
      await page.locator('#joinAdminCard button', { hasText: 'חדש' }).click();
      await page.waitForFunction(() => calls.filter((c) => c[0] === 'setStatus').length === 2);
    } else {
      check('hr form has no station selector (server decides)', await page.locator('#jcStation').count() === 0);
      await page.locator('#jcLabel').fill('קליטה'); await page.locator('#jcCreate').click();
      await page.waitForFunction(() => !!document.getElementById('joinTokenLink'));
      check('hr create payload carries no station key', await page.evaluate(() => !('station_id' in calls.find((c) => c[0] === 'create')[1])));
    }
    await page.locator('#joinAdminCard button', { hasText: 'הצג נרשמים' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#joinRegistrants tbody tr').length === 30);
    check(mode + ': registrants table renders 30 rows with derived status', await page.locator('#joinRegistrants tbody tr').count() === 30);
    check(mode + ': exception rows (unverified email / returned / not pending) are marked and not bulk-selectable', await page.evaluate(() => document.querySelectorAll('#joinRegistrants tbody tr.join-exception').length === rows.filter((r) => !JoinAdmin.bulkEligible(r)).length && rows.filter((r) => !JoinAdmin.bulkEligible(r)).length === 13));
    await page.locator('#jrShift').selectOption('B');
    check(mode + ': shift filter narrows the table', await page.locator('#joinRegistrants tbody tr').count() === 10);
    await page.locator('#jrShift').selectOption('all'); await page.locator('#jrSearch').fill('w7@');
    check(mode + ': search filters by email', await page.locator('#joinRegistrants tbody tr').count() === 1);
    await page.locator('#jrSearch').fill('');
    check(mode + ': no horizontal overflow at 390 with a 30-row table', await noOverflow(page));
    await shots(page, 'admin-join-registrants-' + mode, '#joinRegistrants');
    check(mode + ': all action buttons at least 44px', await minTouch(page, '#joinRegistrants button'));
    if (mode === 'super') {
      const eligibleBefore = await page.evaluate(() => rows.filter((r) => JoinAdmin.bulkEligible(r)).map((r) => r.uid));
      await page.locator('#joinAdminCard button', { hasText: 'בחר את כל הכשירים' }).click();
      await page.locator('#jrBulkApprove').click();
      await page.waitForFunction(() => document.querySelector('.join-bulk-result'));
      const approvedList = await page.evaluate(() => approved.slice());
      check('bulk approve calls the existing approve path once per eligible row, sequentially, at most 25', eligibleBefore.length === 17 && approvedList.join(',') === eligibleBefore.join(','));
      check('bulk approve never includes exception rows', !approvedList.includes('u4') && !approvedList.includes('u6') && !approvedList.includes('u8'));
      check('per-row results shown: one failure (u3) reported, others with employee number', await page.locator('.join-bulk-result').textContent().then((t) => t.includes('1 נכשלו') && t.includes('מספר עובד 100')));
      // אימות כשירות — רק super, רק pending_verification
      await page.locator('#jrStatus').selectOption('approved');
      check('verify buttons appear only for pending_verification declarations', await page.locator('#joinRegistrants button', { hasText: 'אמת' }).count() >= 1);
      await page.locator('#joinRegistrants button', { hasText: 'אמת' }).first().click();
      await page.waitForFunction(() => calls.some((c) => c[0] === 'verify'));
      const v = await page.evaluate(() => calls.find((c) => c[0] === 'verify')[1]);
      check('verify payload: campaign, uid, key, action, expected_revision, request_id', Object.keys(v).sort().join(',') === 'action,campaign_id,expected_revision,key,request_id,uid' && v.action === 'verify');
      await page.locator('#jrStatus').selectOption('all');
      await page.locator('#joinRegistrants button', { hasText: 'דחה' }).first().click();
      await page.waitForFunction(() => calls.some((c) => c[0] === 'reject'));
      check('reject stores the reason on the registrant first, then goes through the existing rejectRegistration path', await page.evaluate(() => { const i = calls.findIndex((c) => c[0] === 'review' && c[1].action === 'reject_note'); const j = calls.findIndex((c) => c[0] === 'reject'); return i !== -1 && j > i && calls[i][1].reason === 'טלפון שגוי'; }));
    } else {
      check('hr can approve/reject station registrants but cannot verify qualifications', await page.locator('#joinRegistrants button', { hasText: 'אשר' }).count() > 0 && await page.locator('#joinRegistrants button', { hasText: 'דחה' }).count() > 0 && await page.locator('#joinRegistrants button', { hasText: 'אמת' }).count() === 0 && await page.locator('#jrBulkApprove').count() === 1);
      await page.locator('#joinRegistrants button', { hasText: 'החזר לתיקון' }).first().click();
      await page.waitForFunction(() => calls.some((c) => c[0] === 'review'));
      check('hr can return a registrant for correction with a reason', await page.evaluate(() => { const c = calls.find((x) => x[0] === 'review')[1]; return c.action === 'return' && c.reason === 'טלפון שגוי' && c.expected_revision === 1; }));
    }
    const csv = await page.evaluate(() => JoinAdmin.registrantsCsv(rows.slice(0, 3)));
    check(mode + ': CSV has name/email/phone/shift/status and no employee number or uid', csv.includes('שם') && !csv.includes('u0') && !/מספר עובד/.test(csv) && csv.split('\r\n').length === 4);
    check(mode + ': CSV neutralises formula injection', JoinAdmin_csvSafe(await page.evaluate(() => JoinAdmin.registrantsCsv([{ full_name: '=cmd()', email: '', phone: '', shift: 'A', request_status: 'pending', declarations: [], summary: {} }]))));
    await page.close();
  }

  /* ============ device-readiness.html — פריסה ומצבים (ללא Firebase) ============ */
  {
    const { page } = await pageFor('device-readiness.html');
    await page.evaluate(() => { document.getElementById('work').classList.remove('hide'); });
    check('readiness wizard: three steps, buttons at least 44px, no overflow at 320', await page.locator('.step').count() === 3 && await minTouch(page, '#work button') && (await page.setViewportSize({ width: 320, height: 700 }), await noOverflow(page)));
    check('readiness wizard is honest about iOS home-screen requirement', await page.locator('#work').textContent().then((t) => t.includes('מסך הבית') && t.includes('Safari')));
    await page.setViewportSize({ width: 390, height: 844 });
    await shots(page, 'device-readiness', '.wrap');
    await page.close();
  }
  console.log('Join campaign browser: ' + passed + ' PASS (actual markup and modules, mock Firebase/callables/clipboard).');
} finally { await browser.close(); }
function JoinAdmin_whatsapp(t) { return String(t || ''); }
function JoinAdmin_csvSafe(csv) { return csv.includes('"\'=cmd()"'); }
