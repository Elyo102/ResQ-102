// שכבת SaaS — בדיקות דפדפן על המסך האמיתי והמודול האמיתי (saas-admin.html +
// saas-admin-ui.js). Firebase וה-callables מדומים; שום קצה מרוחק לא נגיש.
// הרצה: RESQ_CHROMIUM=<path> node tests/saas-admin-browser.mjs
// theme.css נטען מהעותק ב-RESQ_REPO (ברירת מחדל: /tmp/resq-join) אם אינו לצד הדף.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { isCleanText, eolProblems } from './eol-guard.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.RESQ_REPO ? path.resolve(process.env.RESQ_REPO) : '/tmp/resq-join';
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const launch = process.env.RESQ_CHROMIUM ? { headless: true, executablePath: process.env.RESQ_CHROMIUM } : { headless: true };
const browser = await chromium.launch(launch);
let passed = 0;
function check(name, value) { assert(value, name); passed++; console.log('PASS ' + name); }
async function noOverflow(page) { return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1); }
async function minTouch(page, selector) {
  return page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).filter((b) => b.offsetParent !== null).every((b) => b.offsetHeight >= 44), selector);
}
function moduleTag(file, globalName) {
  const src = read(file).replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ');
  const names = [...read(file).matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  return { type: 'module', content: src + '\nwindow.' + globalName + ' = { ' + names.join(', ') + ' };' };
}
async function pageFor(name) {
  const html = read(name);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(8000);
  await page.route('**/*', (route) => route.abort());
  const localHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1] || '';
    if (!/\.css(?:\?|$)/i.test(href) || /^(?:https?:|\/\/)/i.test(href)) return '';
    const rel = href.split('?')[0];
    const candidates = [path.resolve(root, rel), path.resolve(repo, rel)];
    const file = candidates.find((f) => fs.existsSync(f));
    return file ? '<style>' + fs.readFileSync(file, 'utf8') + '</style>' : '';
  });
  await page.setContent(localHtml);
  return { page, html };
}
const FIXTURE = {
  ok: true,
  organization: { organization_id: 'org_south', name: 'ארגון בדיקה <b>x</b>', district_id: 'south', station_ids: ['eilat_102'], revision: 2, created_at_ms: 1, updated_at_ms: 1 },
  subscription: { subscription_id: 'sub_000001', plan_id: 'station', status: 'active', revision: 2, provider_linked: true, created_at_ms: 1, updated_at_ms: 1 },
  plan: { plan_id: 'station', stations: 1, active_users: 400, storage_mb: 4096, pushes_per_month: 50000, placeholder_not_agreed: true },
  quotas: [{ metric: 'stations', limit: 1, used: 1, remaining: 0, over: false }, { metric: 'active_users', limit: 400, used: 12, remaining: 388, over: false },
    { metric: 'storage_mb', limit: 4096, used: 4100, remaining: 0, over: true }, { metric: 'pushes_per_month', limit: 50000, used: 320, remaining: 49680, over: false }],
  usage: { period: '2027-01', stations: 1, active_users: 12, storage_mb: 4100, pushes_per_month: 320 },
  audit: [{ event_id: 'e2', action: 'set_status', actor_uid: 'super1', request_id: 'r2', details: { action: 'activate', from_status: 'evaluation', status: 'active', simulated: true }, at_ms: 1_800_000_100_000 },
    { event_id: 'e1', action: 'create_organization', actor_uid: 'super1', request_id: 'r1', details: { plan_id: 'station' }, at_ms: 1_800_000_000_000 }]
};
try {
  const html = read('saas-admin.html'), ui = read('saas-admin-ui.js');
  /* ---- מקור ---- */
  check('page head follows admin/maintenance conventions (rtl, viewport, theme.css, one initAppCheck, module script)',
    /<html lang="he" dir="rtl">/.test(html) && /name="viewport"/.test(html) && html.includes('./theme.css?v=42h27') && (html.match(/await initAppCheck\(app\);/g) || []).length === 1 && /<script type="module">/.test(html));
  check('every local import carries the release query', [...html.matchAll(/from '\.\/([^']+)'/g)].every((m) => /\?v=42h27$/.test(m[1])));
  check('page gates on claims.super === true, renders nav with its own name, never signs out', /claims\.super !== true/.test(html) && html.includes("renderNav(claims, 'saas-admin.html', user.email || '')") && /renderStuckNav\(''\)/.test(html) && !/signOut/.test(html));
  check('UI module never assigns innerHTML/outerHTML or uses insertAdjacentHTML/document.write', !/\.(?:innerHTML|outerHTML)\s*[=+]|insertAdjacentHTML\(|document\.write\(/.test(ui));
  check('no "שלם" anywhere and no charge claim', !/שלם/.test(html) && !/שלם/.test(ui) && !/חויב|בוצע חיוב/.test(ui));
  check('simulation label present in the module', ui.includes('סימולציה מקומית — לא חיוב'));
  check('page is at most 350 lines and carries no lone CR or control characters (CRLF tolerated)',
    html.split('\n').length <= 350 && isCleanText(fs.readFileSync(path.join(root, 'saas-admin.html'), 'utf8')) && isCleanText(html + ui));

  /* ---- deny (non-super) ---- */
  {
    const { page } = await pageFor('saas-admin.html');
    await page.evaluate(() => { document.getElementById('loading').classList.add('hide'); document.getElementById('deny').classList.remove('hide'); document.getElementById('denyWho').textContent = 'מחובר כ־בודק א׳ · אין הרשאת מנהל-על'; });
    check('non-super sees the deny card and no admin root', await page.locator('#deny').isVisible() && !(await page.locator('#saasRoot').isVisible()) && await page.locator('#deny').textContent().then((t) => t.includes('מנהל-העל בלבד')));
    await page.close();
  }

  /* ---- super overview from fixture ---- */
  {
    const { page } = await pageFor('saas-admin.html');
    await page.evaluate(() => { document.getElementById('loading').classList.add('hide'); document.getElementById('saasRoot').classList.remove('hide'); });
    await page.addScriptTag(moduleTag('saas-admin-ui.js', 'SaasAdmin'));
    await page.waitForFunction(() => !!window.SaasAdmin);
    await page.evaluate((fixture) => {
      window.calls = []; window.fixture = fixture; window.failNext = null;
      const wrap = (name) => async (d) => { calls.push([name, JSON.parse(JSON.stringify(d))]); if (failNext) { const r = failNext; failNext = null; const e = new Error('server'); e.details = { reason: r }; throw e; }
        if (name === 'list') return { ok: true, organizations: [fixture.organization], next_cursor: null };
        if (name === 'overview') return fixture;
        if (name === 'create') return { ok: true, duplicate: false, organization_id: d.organization_id, status: 'evaluation', revision: 1 };
        return { ok: true, duplicate: name === 'attach', status: fixture.subscription.status, revision: fixture.subscription.revision }; };
      window.admin = SaasAdmin.createSaasAdmin(document.getElementById('saasRoot'), { calls: { list: wrap('list'), overview: wrap('overview'), create: wrap('create'), attach: wrap('attach'), changePlan: wrap('changePlan'), setStatus: wrap('setStatus'), webhook: wrap('webhook') } });
      return admin.refresh();
    }, FIXTURE);
    await page.selectOption('#saasOrg', 'org_south');
    await page.waitForFunction(() => !!document.getElementById('soName'));
    check('organization name rendered as text, never as markup', await page.locator('#soName').textContent().then((t) => t.includes('<b>x</b>')) && await page.locator('#soName b').count() === 0);
    check('plan, status, revision and station ids shown', await page.locator('#soPlan').textContent().then((t) => t.includes('station')) && await page.locator('#soStatus').textContent().then((t) => t === 'פעיל') && await page.locator('#soRevision').textContent().then((t) => t === '2') && await page.locator('#soStations').textContent().then((t) => t === 'eilat_102'));
    check('quota table has four metrics and marks the over-quota row', await page.locator('#soQuotas tbody tr').count() === 4 && await page.locator('#soQuotas tbody tr.over').count() === 1 && await page.locator('#soQuotas tbody tr.over').textContent().then((t) => t.includes('4100')));
    check('audit history lists events newest first with Hebrew action labels', await page.locator('#soAudit li').count() === 2 && await page.locator('#soAudit li').first().textContent().then((t) => t.includes('שינוי סטטוס (סימולציה)')));
    check('simulation block is labelled and has the four status buttons', await page.locator('#soSim h3').textContent().then((t) => t === 'סימולציה מקומית — לא חיוב') && await page.locator('#soSim button[data-action]').count() === 4);
    check('rendered page text never says "שלם" or claims a charge', await page.locator('#saasRoot').textContent().then((t) => !/שלם/.test(t) && !/בוצע חיוב/.test(t)));
    check('placeholder disclaimer visible', await page.locator('#saasOverview').textContent().then((t) => t.includes('placeholder')));
    for (const w of [320, 360, 390]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(30);
      check('no horizontal overflow at ' + w, await noOverflow(page));
      check('all buttons/inputs/selects at least 44px at ' + w, await minTouch(page, '#saasRoot button, #saasRoot input, #saasRoot select'));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // הפעולות
    await page.locator('#soSim button[data-action="suspend"]').click();
    await page.waitForFunction(() => calls.some((c) => c[0] === 'setStatus'));
    const st = await page.evaluate(() => calls.find((c) => c[0] === 'setStatus')[1]);
    check('suspend sends exactly request_id/organization_id/action/expected_revision with a fresh opaque id', Object.keys(st).sort().join(',') === 'action,expected_revision,organization_id,request_id' && st.action === 'suspend' && st.expected_revision === 2 && /^saas_[0-9a-f]{48}$/.test(st.request_id));
    await page.waitForFunction(() => document.getElementById('saasStatus').textContent.includes('סימולציה'));
    check('success message says simulation, not payment', await page.locator('#saasStatus').textContent().then((t) => t.includes('סימולציה מקומית') && !/שלם|חיוב בוצע/.test(t)));
    await page.selectOption('#soPlanPick', 'district');
    await page.locator('#soPlanChange').click();
    await page.waitForFunction(() => calls.some((c) => c[0] === 'changePlan'));
    const pc = await page.evaluate(() => calls.find((c) => c[0] === 'changePlan')[1]);
    check('plan change sends plan_id only (no price/amount/currency) with expected_revision', pc.plan_id === 'district' && pc.expected_revision === 2 && !('price' in pc) && !('amount' in pc) && !('currency' in pc));
    await page.locator('#soStationId').fill('beersheba_103');
    await page.locator('#soAttach').click();
    await page.waitForFunction(() => calls.some((c) => c[0] === 'attach'));
    check('attach sends station_id and organization_id, duplicate receipt reported as already done', await page.evaluate(() => calls.find((c) => c[0] === 'attach')[1].station_id === 'beersheba_103') && await page.locator('#saasStatus').textContent().then((t) => t.includes('כבר בוצעה')));
    await page.evaluate(() => { failNext = 'subscription-suspended'; });
    await page.locator('#soWebhook').click();
    await page.waitForFunction(() => document.getElementById('saasStatus').classList.contains('err'));
    check('server reason codes are mapped to Hebrew text without leaking raw messages', await page.locator('#saasStatus').textContent().then((t) => t.includes('המנוי מושהה') && !t.includes('server')));
    check('webhook simulation sends event_type only (no payload/signature from the browser)', await page.evaluate(() => { const c = calls.find((x) => x[0] === 'webhook')[1]; return Object.keys(c).sort().join(',') === 'event_type,organization_id,request_id'; }));
    // יצירה
    await page.locator('#scOrgId').fill('org_north'); await page.locator('#scName').fill('ארגון ב׳'); await page.locator('#scDistrict').fill('north'); await page.selectOption('#scPlan', 'evaluation');
    await page.locator('#scSubmit').click();
    await page.waitForFunction(() => calls.some((c) => c[0] === 'create'));
    const cr = await page.evaluate(() => calls.find((c) => c[0] === 'create')[1]);
    check('create payload has exactly the contract keys and a catalog plan id', Object.keys(cr).sort().join(',') === 'district_id,name,organization_id,plan_id,request_id' && cr.plan_id === 'evaluation' && cr.organization_id === 'org_north');
    check('module helpers: quotaRows percent/over, errorText fallback, request ids unique', await page.evaluate(() => {
      const rows = SaasAdmin.quotaRows(fixture); const ids = new Set(Array.from({ length: 50 }, () => SaasAdmin.newRequestId()));
      return rows.length === 4 && rows[2].over === true && rows[1].percent === 3 && SaasAdmin.errorText(new Error('x')) === 'x' && SaasAdmin.errorText({ details: { reason: 'provider' } }).includes('ספק') && ids.size === 50;
    }));
    await page.close();
  }
  /* ---- disabled layer (server says saas-disabled) ---- */
  {
    const { page } = await pageFor('saas-admin.html');
    await page.evaluate(() => {
      document.getElementById('loading').classList.add('hide');
      document.getElementById('disabled').classList.remove('hide');
    });
    const text = await page.locator('#disabled').textContent();
    check('a disabled layer shows an explanation panel, not an admin interface',
      await page.locator('#disabled').isVisible() && !(await page.locator('#saasRoot').isVisible()) &&
      text.includes('כבויה בשרת') && text.includes('אין כאן חיוב'));
    check('the disabled panel offers no action button', await page.locator('#disabled button').count() === 0);
    await page.close();
  }
  check('the page reveals the admin root only after a successful server call',
    /reason === 'saas-disabled'/.test(html) &&
    html.indexOf("await admin.refresh();") < html.indexOf("$('saasRoot').classList.remove('hide');"));
  check('the page holds no client-side enabled flag — the server decides',
    !/SAAS_ENABLED|saasEnabled|isEnabled/.test(html));

  console.log('SaaS admin browser: ' + passed + ' PASS (actual markup and module, mock Firebase/callables).');
} finally { await browser.close(); }
