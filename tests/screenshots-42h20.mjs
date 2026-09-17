// 42H.20 · "Required validation: Playwright screenshots at 320, 360, and
// 390px for home, import preview/review, and published schedule."
//
// Not a pass/fail test - a capture script that reuses the exact same
// stub-server/prepare() harness as schedule-management-browser.mjs so the
// screenshots reflect the real, currently-committed markup and CSS, not a
// hand-built mock. Writes PNGs to ./screenshots-out/.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots-out');
fs.mkdirSync(outDir, { recursive: true });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
function shiftDay(iso, amount) {
  const date = new Date(iso + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname === '/' ? 'login.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  response.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

async function prepare(context, role, plans) {
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(({ roleName, callablePlans }) => {
    window.__SMOKE_ROLE = roleName;
    window.__CALLABLE_PLAN = callablePlans;
  }, { roleName: role, callablePlans: plans });
}

function day(date, label, me) {
  return {
    date,
    sub_stations:[{
      sub_station:'eilat', label:'אילת', minimum:2, coverage:'ready', below_minimum:false,
      people:[
        { uid:'stub-uid', person:'אלדד יונה', role_label:'לוחם', hours:'07:00-07:00', is_me:me },
        { uid:'crew_1', person:'טל חודרה', role_label:'נהג', hours:'07:00-07:00', is_me:false }
      ]
    }],
    events: label ? [{ id:'event_' + date, title:label, hours:'10:00-12:00', includes_me:me,
      people:[{ uid:'stub-uid', person:'אלדד יונה', is_me:me }] }] : [],
    guards_status:'ready', guards:[]
  };
}
function monthRange(anchor) {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { from: anchor.slice(0, 7) + '-01', to: anchor.slice(0, 7) + '-' + pad(last), last };
}
function rangeDays(anchor, decorate) {
  const bounds = monthRange(anchor);
  const out = [];
  for (let index = 1; index <= bounds.last; index++) {
    out.push(decorate(anchor.slice(0, 7) + '-' + String(index).padStart(2, '0')));
  }
  return out;
}
const stationRange = {
  mode:'new', active:true, source:'v2', publication_id:'p_live', revision:4,
  from:monthRange(today).from, to:monthRange(today).to,
  days:rangeDays(today, (date) => day(date, date === today ? 'קורס חילוץ' : '', date === today))
};
const mine = {
  mode:'new', active:true, publication_id:'p_live', revision:4,
  days:[{
    date:today, sub_station:'main', sub_station_label:'אילת', role:'firefighter',
    role_label:'לוחם', hours:'07:00-07:00', shift:'משמרת א', qualifications:['חובש'],
    crew:[{ uid:'crew_1', person:'טל חודרה', role_label:'נהג' }],
    change:null, answer:null, requires_answer:false
  }],
  events:[], guards_status:'ready', guards:[], pending_answers:0
};
const statusFirefighter = { mode:'new', configured:true, manager:false, active:{ publication_id:'p_live', revision:4 } };
const statusManager = { mode:'new', configured:true, manager:true,
  active:{ publication_id:'p_live', revision:4, previous_publication_id:null, can_rollback:false } };
const setup = {
  mode:'new', configured:true,
  policy:{ id:'policy_1', active_policy_id:'policy_1', version:'v1', digest:'abc',
    rest:{ min_gap_days:2 }, rotation:null, max_shifts_per_month:12,
    sub_stations:[{
      id:'main', label:'אילת', minimum:2,
      requirements:[{ role:'driver', label:'נהג', count:1, required:true }, { role:'firefighter', label:'לוחם', count:1, required:true }]
    }] },
  source:{ id:'source_1', version:'1', revision:'7' },
  people:[
    { id:'stub-uid', name:'אלדד יונה', sub_station:'main', roles:['firefighter'] },
    { id:'crew_1', name:'טל חודרה', sub_station:'main', roles:['driver','firefighter'] }
  ]
};
const draftPreview = {
  draft_id:'draft_1', expected_content_digest:'digest_preview_1',
  from:today, to:shiftDay(today, 30), week_start:today,
  days:Array.from({ length:7 }, (_, index) => {
    const value = new Date(today + 'T00:00:00.000Z');
    value.setUTCDate(value.getUTCDate() + index);
    return day(value.toISOString().slice(0, 10), index === 2 ? 'תרגיל תחנתי' : '', index === 0);
  })
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' }).catch(() => chromium.launch());
const widths = [320, 360, 390];

try {
  // 1) home / bulletin board (login.html doubles as the post-auth home screen)
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, locale: 'he-IL' });
    await prepare(ctx, 'firefighter', {});
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:' + port + '/login.html', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    // dismiss any callout/urgent-call modal so the plain home screen is captured
    const dismiss = page.locator('button:has-text("לא זמין"), button:has-text("סגור"), [aria-label="סגור"]').first();
    if (await dismiss.count()) { await dismiss.click().catch(() => {}); await page.waitForTimeout(300); }
    await page.screenshot({ path: path.join(outDir, 'home-' + width + '.png') });
    await ctx.close();
    console.log('captured home-' + width + '.png');
  }

  // 2) published station schedule
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, locale: 'he-IL' });
    await prepare(ctx, 'firefighter', {
      getScheduleRuntimeStatus: [{ data: statusFirefighter }],
      getMyScheduleV2: [{ data: mine }],
      getStationScheduleRange: [{ data: stationRange }]
    });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:' + port + '/schedule-management.html', { waitUntil: 'load' });
    await page.locator('#stationBoard .hcell').first().waitFor({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'published-schedule-' + width + '.png') });
    await ctx.close();
    console.log('captured published-schedule-' + width + '.png');
  }

  // 3) import preview/review card (draft -> preview -> approval, before publish)
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, locale: 'he-IL' });
    await prepare(ctx, 'firefighter', {
      getScheduleRuntimeStatus: [{ data: statusManager }],
      getScheduleManagerSetup: [{ data: setup }],
      getMyScheduleV2: [{ data: mine }],
      getStationScheduleRange: [{ data: stationRange }],
      runSchedulePlanner: [{ data: { draft_id: 'draft_1', from: today, to: shiftDay(today, 30), summary: { filled:610, blocking_gaps:0, days_below_minimum:0, manual_warning_assignments:1, manual_warnings:1, rejected_manual:0 } } }],
      getScheduleDraftPreview: [{ data: draftPreview }]
    });
    const page = await ctx.newPage();
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    await page.goto('http://127.0.0.1:' + port + '/schedule-management.html?tab=manage', { waitUntil: 'load' });
    await page.locator('#appMain:not(.hide)').waitFor({ timeout: 10000 }).catch(() => {});
    await page.locator('#runPlanner').click({ timeout: 10000 }).catch(() => {});
    await page.locator('#draftPreviewCard').waitFor({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'import-preview-review-' + width + '.png') });
    await ctx.close();
    console.log('captured import-preview-review-' + width + '.png');
  }
} finally {
  await browser.close();
  server.close();
}
console.log('done -> ' + outDir);
