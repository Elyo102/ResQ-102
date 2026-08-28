// מודד את טעינת נתוני הכשירות במסך הסידור ברשת איטית מדומה.
// הנתונים סינתטיים בלבד. הבדיקה שומרת גם על גבולות ההרשאה,
// מצב "לא ניתן לחשב", ומניעת פרסום של טעינת זהות ישנה.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const lagMs = 180;
const maxFitnessSpanMs = 700;
const measureOnly = process.argv.includes('--measure-only');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'text/javascript', '.png':'image/png', '.jpg':'image/jpeg' };
const fitnessPattern = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/schedule.html');
  const file = path.join(root, urlPath === '/' ? 'schedule.html' : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let passed = true;
function check(ok, message) {
  passed = passed && !!ok;
  console.log((ok ? '✓ ' : '✗ ') + message);
}

function expectedSuffixes(crews) {
  return ['/quals', '/roster', '/member_quals', '/config/redline', '/config/board']
    .concat(crews.map(crew => '/shifts/' + crew));
}

let browser = null;

async function newContext(options) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const moduleName = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, moduleName);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(config => {
    window.__SMOKE_ROLE = config.role;
    window.__SMOKE_UID = config.uid || 'stub-uid';
    window.__SMOKE_LAG = config.lag;
    window.__SMOKE_LAG_PLAN = (config.lagPlan || []).slice();
    window.__SMOKE_FAIL_PATHS = config.failPaths || [];
    window.__SMOKE_PARSE_FAIL_PATHS = config.parseFailPaths || [];
    window.__SMOKE_MISSING_PATHS = config.missingPaths || [];
    window.__SMOKE_QUAL_PREFIX_BY_STATION = config.qualPrefixes || {};
    window.__PERF_STARTED = Date.now();
  }, options);
  return context;
}

async function runScenario(options) {
  const crews = options.crews.slice();
  const context = await newContext({
    role:options.role,
    uid:options.uid || 'stub-uid',
    lag:Number(options.lag || 0),
    lagPlan:[],
    failPaths:options.failPaths || [],
    parseFailPaths:options.parseFailPaths || [],
    missingPaths:options.missingPaths || [],
    qualPrefixes:options.qualPrefixes || {}
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));

  await page.goto('http://127.0.0.1:' + port + '/schedule.html', { waitUntil:'load' });
  await page.waitForFunction(count =>
    document.querySelectorAll('#fitBoxes .p').length === count,
  crews.length, { timeout:15000 });
  await page.waitForFunction(count => {
    const pattern = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;
    const events = (window.__DATA_EVENTS || []).filter(event => pattern.test(event.path || ''));
    return events.length === count && events.every(event => event.finished > 0);
  }, 5 + crews.length, { timeout:15000 });

  const result = await page.evaluate(() => {
    const pattern = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;
    const events = (window.__DATA_EVENTS || []).filter(event => pattern.test(event.path || ''));
    const starts = events.map(event => event.started).filter(Boolean);
    const finishes = events.map(event => event.finished).filter(Boolean);
    return {
      interactiveMs: Date.now() - window.__PERF_STARTED,
      fitnessSpanMs: starts.length && finishes.length
        ? Math.max(...finishes) - Math.min(...starts) : 0,
      fitnessPaths: events.map(event => event.path),
      boxes: Array.from(document.querySelectorAll('#fitBoxes .p')).map(box => ({
        text:(box.textContent || '').trim(),
        unavailable:box.classList.contains('unavailable')
      })),
      calendarDays:document.querySelectorAll('#grid .day:not(.pad)').length,
      unfitDays:document.querySelectorAll('#grid .day.unfit').length,
      unknownDays:Array.from(document.querySelectorAll('#grid .day.fit-unknown')).map(day => ({
        title:day.title || '', aria:day.getAttribute('aria-label') || ''
      })),
      mainVisible:!document.getElementById('mainView').classList.contains('hide'),
      blockedVisible:!document.getElementById('blocked').classList.contains('hide')
    };
  });
  result.pageErrors = pageErrors;

  console.log('\nSchedule fitness benchmark · ' + options.name);
  console.log('lag per data request:', Number(options.lag || 0) + 'ms');
  console.log('time to rendered fitness:', result.interactiveMs + 'ms');
  console.log('fitness data span:', result.fitnessSpanMs + 'ms');
  console.log('fitness data paths:', JSON.stringify(result.fitnessPaths));

  const suffixes = expectedSuffixes(crews);
  suffixes.forEach(suffix => {
    check(result.fitnessPaths.filter(value => value.endsWith(suffix)).length === 1,
          options.name + ' reads ' + suffix + ' exactly once');
  });
  check(result.fitnessPaths.length === suffixes.length,
        options.name + ' reads only the expected fitness sources');
  const actualCrews = result.fitnessPaths.filter(value => value.includes('/shifts/'))
    .map(value => value.split('/').pop());
  check(JSON.stringify(actualCrews) === JSON.stringify(crews),
        options.name + ' reads only the visible crew snapshot');
  check(result.boxes.length === crews.length,
        options.name + ' keeps one fitness card per visible crew');
  check(result.calendarDays >= 28,
        options.name + ' keeps the rendered monthly calendar');
  check(result.mainVisible && !result.blockedVisible && result.pageErrors.length === 0,
        options.name + ' completes without blocking or a page error');

  const unavailableCrews = options.unavailableCrews || [];
  const actualUnavailable = crews.filter((crew, index) => result.boxes[index].unavailable);
  check(JSON.stringify(actualUnavailable) === JSON.stringify(unavailableCrews),
        options.name + ' marks exactly the unavailable crews');
  result.boxes.forEach((box, index) => {
    if (unavailableCrews.includes(crews[index])) {
      check(box.text.includes('לא ניתן לחשב כשירות') &&
            !box.text.includes('לא כשירה') && !box.text.includes(' כשירה'),
            options.name + ' never invents a readiness verdict for ' + crews[index]);
    } else {
      check(box.text.includes('לא כשירה'),
            options.name + ' keeps the known readiness verdict for ' + crews[index]);
    }
  });
  if (unavailableCrews.length) {
    check(result.unknownDays.length > 0 && result.unknownDays.every(day =>
      day.title.includes('לא ניתן לחשב כשירות') &&
      day.aria.includes('לא ניתן לחשב כשירות') &&
      !day.title.includes('לא כשירה')),
    options.name + ' exposes unknown readiness in calendar title and ARIA');
  } else {
    check(result.unknownDays.length === 0 && result.unfitDays > 0,
          options.name + ' keeps normal calendar readiness markers');
  }
  if (options.enforceSpeed && !measureOnly) {
    check(result.fitnessSpanMs <= maxFitnessSpanMs,
          options.name + ' loads fitness without a serial request waterfall');
  }

  await context.close();
  return result;
}

async function runIdentityRace() {
  const oldStation = 'eilat_102';
  const newStation = 'other_99';
  const context = await newContext({
    role:'super', uid:'old-uid', lag:0,
    lagPlan:new Array(5).fill(20)
      .concat(new Array(8).fill(700), new Array(11).fill(40)),
    failPaths:[], parseFailPaths:[], missingPaths:[],
    qualPrefixes:{ [oldStation]:'ישן ', [newStation]:'חדש ' }
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
  await page.goto('http://127.0.0.1:' + port + '/schedule.html', { waitUntil:'load' });
  await page.waitForFunction(station => {
    const pattern = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;
    return (window.__DATA_EVENTS || []).filter(event =>
      event.path.includes('/' + station + '/') && pattern.test(event.path || '')).length === 8;
  }, oldStation, { timeout:12000 });

  await page.evaluate(station => {
    window.__SMOKE_EMIT_AUTH('firefighter', 'new-uid', {
      stationId:station, districtId:'south', shift:'A', emp:'77'
    });
  }, newStation);
  await page.waitForFunction(station => {
    const pattern = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;
    const current = (window.__DATA_EVENTS || []).filter(event =>
      event.path.includes('/' + station + '/') && pattern.test(event.path || ''));
    return current.length === 6 && current.every(event => event.finished > 0) &&
      document.querySelectorAll('#fitBoxes .p').length === 1;
  }, newStation, { timeout:12000 });
  await page.waitForTimeout(850);

  const result = await page.evaluate(({ oldStation, newStation }) => {
    const pattern = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;
    const events = (window.__DATA_EVENTS || []).filter(event => pattern.test(event.path || ''));
    const paths = events.map(event => event.path);
    return {
      oldReads:paths.filter(value => value.includes('/' + oldStation + '/')).length,
      newReads:paths.filter(value => value.includes('/' + newStation + '/')).length,
      newShiftPaths:paths.filter(value => value.includes('/' + newStation + '/shifts/')),
      boxes:document.querySelectorAll('#fitBoxes .p').length,
      text:(document.getElementById('fitBoxes').textContent || '').trim(),
      unknown:document.querySelectorAll('#fitBoxes .p.unavailable').length,
      oldCalloutActive:(window.__FIRESTORE_ACTIVE_PATHS || {})[
        'stations/' + oldStation + '/callouts'] || 0,
      newCalloutActive:(window.__FIRESTORE_ACTIVE_PATHS || {})[
        'stations/' + newStation + '/callouts'] || 0,
      unsubscribes:window.__FIRESTORE_UNSUBSCRIBES || 0
    };
  }, { oldStation, newStation });
  check(result.oldReads === 8 && result.newReads === 6,
        'identity race exercised an old 8-read and new 6-read context');
  check(result.newShiftPaths.length === 1 && result.newShiftPaths[0].endsWith('/shifts/A'),
        'identity race keeps the new firefighter inside crew A');
  check(result.boxes === 1 && result.text.includes('חדש ') &&
        !result.text.includes('ישן ') && result.unknown === 0,
        'a slow old identity cannot overwrite the new fitness state or names');
  check(result.oldCalloutActive === 0 && result.newCalloutActive === 1 &&
        result.unsubscribes >= 1,
        'identity change stops the old callout listener and keeps one new listener');
  check(pageErrors.length === 0, 'identity race produces no page error');
  await context.close();
}

async function runSignOutRace() {
  const context = await newContext({
    role:'super', uid:'old-uid', lag:0,
    lagPlan:new Array(5).fill(20).concat(new Array(8).fill(600)),
    failPaths:[], parseFailPaths:[], missingPaths:[], qualPrefixes:{}
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
  await page.goto('http://127.0.0.1:' + port + '/schedule.html', { waitUntil:'load' });
  await page.waitForFunction(() => {
    const pattern = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;
    return (window.__DATA_EVENTS || []).filter(event => pattern.test(event.path || '')).length === 8;
  }, null, { timeout:12000 });
  await page.route('**/login.html*', route => route.abort('aborted'));
  await page.evaluate(() => window.__SMOKE_EMIT_AUTH(null));
  await page.waitForTimeout(750);
  const result = await page.evaluate(() => ({
    boxes:document.querySelectorAll('#fitBoxes .p').length,
    cardHidden:document.getElementById('fitCard').style.display === 'none',
    mainHidden:document.getElementById('mainView').classList.contains('hide'),
    name:(document.getElementById('meName').textContent || '').trim(),
    calloutActive:(window.__FIRESTORE_ACTIVE_PATHS || {})[
      'stations/eilat_102/callouts'] || 0
  }));
  check(result.boxes === 0 && result.cardHidden && result.mainHidden &&
        result.name === '' && result.calloutActive === 0,
        'sign-out during a read clears session state and stops stale publication');
  check(pageErrors.length === 0, 'sign-out race produces no page error');
  await context.close();
}

const earlyStages = [
  { name:'profile', index:0, path:'stations/eilat_102/users/old-uid' },
  { name:'rotations', index:1, path:'stations/eilat_102/rotations' },
  { name:'overrides', index:2, path:'stations/eilat_102/shift_overrides' },
  { name:'swaps', index:3, path:'stations/eilat_102/swaps' },
  { name:'guards', index:4, path:'stations/eilat_102/guards' }
];

async function runEarlyAuthRace(stage, signOut) {
  const oldStation = 'eilat_102';
  const newStation = 'other_99';
  const context = await newContext({
    role:'super', uid:'old-uid', lag:0,
    lagPlan:new Array(stage.index).fill(20)
      .concat([650], new Array(40).fill(20)),
    failPaths:[], parseFailPaths:[], missingPaths:[],
    qualPrefixes:{ [newStation]:'חדש ' }
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
  await page.goto('http://127.0.0.1:' + port + '/schedule.html', { waitUntil:'load' });
  await page.waitForFunction(target => (window.__DATA_EVENTS || []).some(event =>
    event.path === target && event.started > 0 && event.finished === 0),
  stage.path, { timeout:12000 });

  let transitionNav = null;
  if (signOut) {
    await page.route('**/login.html*', route => route.abort('aborted'));
    transitionNav = await page.evaluate(() => {
      window.__SMOKE_EMIT_AUTH(null);
      const nav = document.getElementById('appNav');
      return {
        who:((nav && nav.querySelector('.me') || {}).textContent || '').trim(),
        paths:Array.from(nav ? nav.querySelectorAll('a') : []).map(a =>
          new URL(a.href).pathname.split('/').pop())
      };
    });
  } else {
    transitionNav = await page.evaluate(station => {
      window.__SMOKE_EMIT_AUTH('firefighter', 'new-uid', {
        stationId:station, districtId:'south', shift:'A', emp:'77'
      });
      const nav = document.getElementById('appNav');
      return {
        who:((nav && nav.querySelector('.me') || {}).textContent || '').trim(),
        paths:Array.from(nav ? nav.querySelectorAll('a') : []).map(a =>
          new URL(a.href).pathname.split('/').pop())
      };
    }, newStation);
    await page.waitForFunction(station => {
      const active = window.__FIRESTORE_ACTIVE_PATHS || {};
      return document.querySelectorAll('#fitBoxes .p').length === 1 &&
        (active['stations/' + station + '/callouts'] || 0) === 1;
    }, newStation, { timeout:12000 });
  }
  await page.waitForTimeout(750);

  const result = await page.evaluate(({ oldStation, newStation }) => {
    const active = window.__FIRESTORE_ACTIVE_PATHS || {};
    const listens = window.__FIRESTORE_LISTENS || [];
    const text = (document.getElementById('fitBoxes').textContent || '').trim();
    return {
      mainHidden:document.getElementById('mainView').classList.contains('hide'),
      name:(document.getElementById('meName').textContent || '').trim(),
      boxes:document.querySelectorAll('#fitBoxes .p').length,
      text:text,
      oldCalloutListens:listens.filter(path =>
        path === 'stations/' + oldStation + '/callouts').length,
      oldCalloutActive:active['stations/' + oldStation + '/callouts'] || 0,
      newCalloutActive:active['stations/' + newStation + '/callouts'] || 0
    };
  }, { oldStation, newStation });

  const prefix = (signOut ? 'early sign-out at ' : 'early identity change at ') + stage.name;
  check(transitionNav.who === '' &&
        JSON.stringify(transitionNav.paths) === JSON.stringify(['login.html']),
        prefix + ' replaces the old identity navigation immediately');
  check(result.oldCalloutListens === 0 && result.oldCalloutActive === 0,
        prefix + ' never starts a listener for the stale station');
  if (signOut) {
    check(result.mainHidden && result.name === '' && result.boxes === 0,
          prefix + ' keeps all stale session data hidden');
  } else {
    check(!result.mainHidden && result.boxes === 1 && result.text.includes('חדש ') &&
          result.newCalloutActive === 1,
          prefix + ' publishes only the replacement identity');
  }
  check(pageErrors.length === 0, prefix + ' produces no page error');
  await context.close();
}

async function runMissingConfigWithShiftFailure() {
  const context = await newContext({
    role:'super', uid:'stub-uid', lag:20, lagPlan:[],
    failPaths:['/shifts/B'], parseFailPaths:[],
    missingPaths:['/config/redline', '/config/board'], qualPrefixes:{}
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
  await page.goto('http://127.0.0.1:' + port + '/schedule.html', { waitUntil:'load' });
  await page.waitForFunction(() => {
    const pattern = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;
    const events = (window.__DATA_EVENTS || []).filter(event => pattern.test(event.path || ''));
    return events.length === 8 && events.every(event => event.finished > 0) &&
      document.querySelectorAll('#fitBoxes .p.unavailable').length === 1;
  }, null, { timeout:12000 });
  const result = await page.evaluate(() => ({
    cards:Array.from(document.querySelectorAll('#fitBoxes .p')).map(card => ({
      text:(card.textContent || '').trim(),
      unavailable:card.classList.contains('unavailable')
    })),
    unknownDays:document.querySelectorAll('#grid .day.fit-unknown').length
  }));
  check(result.cards.length === 1 && result.cards[0].unavailable &&
        result.cards[0].text.includes('לא ניתן לחשב כשירות'),
        'missing readiness configuration keeps only the failed shift warning visible');
  check(result.cards.every(card => !card.text.includes('לא כשירה') &&
        !card.text.includes(' כשירה')) && result.unknownDays > 0,
        'unknown configuration never becomes an invented positive verdict');
  check(pageErrors.length === 0,
        'missing configuration with a shift failure produces no page error');
  await context.close();
}

try {
  browser = await chromium.launch();
  await runScenario({ name:'firefighter', role:'firefighter', crews:['A'],
                      lag:lagMs, enforceSpeed:true });
  await runScenario({ name:'super', role:'super', crews:['A','B','C'],
                      lag:lagMs, enforceSpeed:true });

  if (!measureOnly) {
    for (const [name, role, crews] of [
      ['team leader', 'team', ['A']],
      ['deputy', 'deputy', ['B']],
      ['commander', 'commander', ['B']],
      ['HR', 'hr', ['A','B','C']],
      ['station commander', 'stcmd', ['A','B','C']]
    ]) {
      await runScenario({ name, role, crews, lag:0 });
    }

    for (const source of ['/quals', '/roster', '/member_quals',
                          '/config/redline', '/config/board']) {
      await runScenario({ name:'read failure ' + source, role:'super',
        crews:['A','B','C'], lag:20, failPaths:[source],
        unavailableCrews:['A','B','C'] });
    }
    for (const crew of ['A','B','C']) {
      await runScenario({ name:'read failure shift ' + crew, role:'super',
        crews:['A','B','C'], lag:20, failPaths:['/shifts/' + crew],
        unavailableCrews:[crew] });
    }
    await runScenario({ name:'malformed roster', role:'super', crews:['A','B','C'],
      lag:20, parseFailPaths:['/roster'], unavailableCrews:['A','B','C'] });
    await runScenario({ name:'malformed shift B', role:'super', crews:['A','B','C'],
      lag:20, parseFailPaths:['/shifts/B'], unavailableCrews:['B'] });
    await runScenario({ name:'missing board document', role:'super', crews:['A','B','C'],
      lag:20, missingPaths:['/config/board'] });
    await runScenario({ name:'missing shift B document', role:'super', crews:['A','B','C'],
      lag:20, missingPaths:['/shifts/B'] });
    await runMissingConfigWithShiftFailure();
    for (const stage of earlyStages) {
      await runEarlyAuthRace(stage, false);
      await runEarlyAuthRace(stage, true);
    }
    await runIdentityRace();
    await runSignOutRace();
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}

process.exitCode = passed ? 0 : 1;
