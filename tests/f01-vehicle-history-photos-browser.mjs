// F-01: vehicle history / damageReport / subjectReport must not prefetch
// fault photos. Isolation only — stubbed Firebase, no production traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzkAAAAASUVORK5CYII=';
const png2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';

const N = 501;
const vehicles = [{ id: 'v1', name: 'רכב בדיקה F01', kind: 'fire', active: true }];
const faults = [];
for (let i = 0; i < N; i++) {
  faults.push({
    id: 'f' + i,
    vehicle_id: 'v1',
    vehicle_name: 'רכב בדיקה F01',
    kind: 'damage',
    title: 'תקלה עם תמונות ' + i,
    status: i % 3 === 0 ? 'fixed' : 'open',
    severity: 'minor',
    photos: 2,
    by_uid: 'u1',
    by_name: 'בודק',
    created_key: '2026-09-0' + String((i % 9) + 1) + 'T10:00:00.000Z',
    side: 'right',
    x: 0.2 + (i % 5) * 0.1,
    y: 0.3 + (i % 4) * 0.1
  });
}
faults.push({
  id: 'f-none',
  vehicle_id: 'v1',
  kind: 'vehicle',
  title: 'בלי תמונות',
  status: 'open',
  severity: 'minor',
  photos: 0,
  by_uid: 'u1',
  by_name: 'בודק',
  created_key: '2026-09-10T10:00:00.000Z'
});
faults.push({
  id: 'f-unlocated', vehicle_id: 'v1', kind: 'damage',
  title: 'תקלה ללא מיקום עם תמונות', status: 'open', severity: 'minor',
  photos: 2, by_uid: 'u1', by_name: 'בודק',
  created_key: '2026-09-11T10:00:00.000Z'
});

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json'
};
const server = http.createServer((request, response) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
const tap = loc => loc.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
let passed = 0;
const metrics = { historyOpenMs: [], detailOpenMs: [], historyPhotoGets: 0, detailPhotoGets: 0 };

function instrumentFirestore(body) {
  for (const signature of ['export function getDocs(q){', 'export function getDoc(ref){', 'export function onSnapshot(']) {
    assert.ok(body.includes(signature), signature);
  }
  body = body.replace('export function getDoc(ref){', `export function getDoc(ref){
    const hp = String(ref && ref.path || '');
    if (hp.endsWith('/config/board')) {
      return Promise.resolve(docSnap({ vehicles: (window.__F01_FIXTURE && window.__F01_FIXTURE.vehicles) || [], command: [] }, 'board'));
    }
    return Promise.resolve(docSnap({ full_name: 'F01 Viewer', role: 'commander', is_active: true }, 'viewer'));
  `);
  body = body.replace('export function getDocs(q){', `export function getDocs(q){
    const hp = String(q && q.path || '');
    window.__F01_GETDOCS = window.__F01_GETDOCS || [];
    window.__F01_GETDOCS.push({ path: hp, t: Date.now() });
    if (/\\/photos$/.test(hp)) {
      window.__F01_PHOTO_GETS = (window.__F01_PHOTO_GETS || 0) + 1;
      const parts = hp.split('/');
      const faultId = parts[parts.length - 2];
      const sid = parts[1];
      const rows = [
        ['p0', { data: (window.__F01_FIXTURE && window.__F01_FIXTURE.png) || '', w: 1, h: 1, sid, faultId }],
        ['p1', { data: (window.__F01_FIXTURE && window.__F01_FIXTURE.png2) || '', w: 1, h: 1, sid, faultId }]
      ];
      const lag = Number(window.__F01_PHOTO_LAG_MS || 0);
      return new Promise(resolve => setTimeout(() => resolve(listSnap(rows)), lag));
    }
    if (hp.endsWith('/faults')) {
      const rows = ((window.__F01_FIXTURE && window.__F01_FIXTURE.faults) || []).map(v => [v.id, v]);
      return Promise.resolve(listSnap(rows));
    }
    if (hp.endsWith('/vehicles')) return Promise.resolve(listSnap([]));
    if (hp.endsWith('/vehicle_views')) {
      const rows = ((window.__F01_FIXTURE && window.__F01_FIXTURE.views) || []).map(v => [v.id, v]);
      return Promise.resolve(listSnap(rows));
    }
    if (hp.endsWith('/handovers')) return Promise.resolve(listSnap([]));
    return Promise.resolve(listSnap([]));
  `);
  body = body.replace('export function onSnapshot(', 'export function originalOnSnapshot(');
  body += `
export function onSnapshot(ref, cb){
  window.__F01_ONSNAP = (window.__F01_ONSNAP || 0) + 1;
  const hp = String(ref && ref.path || '');
  if (/\\/photos/.test(hp)) window.__F01_PHOTO_ONSNAP = (window.__F01_PHOTO_ONSNAP || 0) + 1;
  if (typeof cb === 'function') {
    if (hp.endsWith('/faults')) {
      const rows = ((window.__F01_FIXTURE && window.__F01_FIXTURE.faults) || []).map(v => [v.id, v]);
      cb(listSnap(rows));
    } else cb(listSnap([]));
  }
  return () => {};
}
`;
  return body;
}

function exposeModuleHooks(html, page) {
  const anchor = 'async function loadShots(f, box){';
  assert.equal(html.split(anchor).length - 1, 1, 'loadShots anchor');
  const extra = page === 'vehicle'
    ? ', openFault, get faultsRef(){ return faults; }'
    : '';
  const expose =
    'window.__F01_HOOKS = { get bump(){ return bumpIdentity; }, get shots(){ return shots; }, ' +
    'get inflight(){ return shotsInflight; }, get gen(){ return AUTH_GEN; }, get sid(){ return SID; }, ' +
    'setSid(v){ SID = v; }' + extra + ' };\n' + anchor;
  return html.replace(anchor, expose);
}

async function withPage(url, fn) {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 900 },
    locale: 'he-IL'
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error && error.message || error)));
  await context.addInitScript(({ vehicles, faults, png, png2 }) => {
    window.__SMOKE_ROLE = 'commander';
    window.__F01_FIXTURE = {
      vehicles,
      faults,
      png,
      png2,
      views: vehicles.map(v => ({
        id: v.id + '__right',
        vehicle_id: v.id,
        side: 'right',
        photo: png,
        w: 1,
        h: 1
      }))
    };
    window.__F01_GETDOCS = [];
    window.__F01_PHOTO_GETS = 0;
    window.__F01_ONSNAP = 0;
    window.__F01_PHOTO_ONSNAP = 0;
  }, { vehicles, faults, png, png2 });
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === origin) {
      if (u.pathname === '/vehicle.html' || u.pathname === '/faults.html') {
        let body = fs.readFileSync(path.join(root, u.pathname.slice(1)), 'utf8');
        body = exposeModuleHooks(body, u.pathname === '/vehicle.html' ? 'vehicle' : 'faults');
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
        return;
      }
      await route.continue();
      return;
    }
    if (u.hostname === 'www.gstatic.com' && u.pathname.includes('/firebasejs/')) {
      const file = path.join(root, 'tests/stub', u.pathname.split('/').pop());
      let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};';
      if (u.pathname.endsWith('/firebase-auth.js')) {
        body = body.replace(/['"][^'"\s]+@[^'"\s]+['"]/g, "'f01-test@example.invalid'");
      }
      if (u.pathname.endsWith('/firebase-firestore.js')) body = instrumentFirestore(body);
      await route.fulfill({ status: 200, contentType: 'text/javascript', body });
      return;
    }
    await route.abort();
  });
  try {
    await page.goto(origin + '/' + url, { waitUntil: 'load' });
    await page.locator('#work:not(.hide)').waitFor({ timeout: 15000 });
    await fn(page);
    assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
    passed++;
  } finally {
    await context.close();
  }
}

try {
  await withPage('faults.html', async page => {
    await page.locator('#vehicleIssues button').first().waitFor({ timeout: 10000 });
    const before = await page.evaluate(() => window.__F01_PHOTO_GETS || 0);
    const tHist0 = Date.now();
    await tap(page.locator('#vehicleIssues button').filter({ hasText: 'רכב בדיקה F01' }).first());
    await page.locator('#rep.on').waitFor();
    await page.locator('#dlgBody .f').first().waitFor();
    await page.waitForTimeout(150);
    const afterOpen = await page.evaluate(() => ({
      photos: window.__F01_PHOTO_GETS || 0,
      cards: document.querySelectorAll('#dlgBody .f').length,
      placeholders: [...document.querySelectorAll('#dlgBody .shots button, #dlgBody .shots .ld')]
        .map(el => el.textContent || '')
        .join('|'),
      photoOnsnap: window.__F01_PHOTO_ONSNAP || 0
    }));
    metrics.historyOpenMs.push(Date.now() - tHist0);
    metrics.historyPhotoGets = afterOpen.photos - before;
    assert.equal(afterOpen.photos, before, 'history open must not getDocs(/photos)');
    assert.equal(metrics.historyPhotoGets, 0);
    assert.ok(afterOpen.cards >= N, 'expected history cards');
    assert.match(afterOpen.placeholders, /תמונות/);
    assert.equal(afterOpen.photoOnsnap, 0, 'no onSnapshot on photos');

    const tDet0 = Date.now();
    const showBtn = page.locator('#dlgBody .shots button').first();
    await showBtn.waitFor();
    await tap(showBtn);
    await page.waitForFunction(() => (window.__F01_PHOTO_GETS || 0) >= 1);
    await page.locator('#dlgBody .shots img').first().waitFor({ timeout: 5000 });
    const afterDetail = await page.evaluate(() => ({
      photos: window.__F01_PHOTO_GETS || 0,
      imgs: document.querySelectorAll('#dlgBody .shots img').length,
      keys: Object.keys(window.__F01_HOOKS.shots)
    }));
    metrics.detailOpenMs.push(Date.now() - tDet0);
    metrics.detailPhotoGets = afterDetail.photos - before;
    assert.equal(afterDetail.photos - before, 1, 'exactly one getDocs(/photos) for one fault');
    assert.equal(afterDetail.imgs, 2, 'all photos for that fault rendered');
    assert.ok(afterDetail.keys.every(k => k.includes(':')), 'cache keys SID:faultId');

    await page.evaluate(() => { window.__F01_PHOTO_LAG_MS = 300; });
    const second = page.locator('#dlgBody .shots button').nth(1);
    assert.ok(await second.count(), 'need second fault with photos');
    await tap(second);
    await page.evaluate(() => {
      window.__F01_HOOKS.bump();
      window.__F01_HOOKS.setSid('other-station');
    });
    await page.waitForTimeout(450);
    const foreign = await page.evaluate(() => ({
      shotKeys: Object.keys(window.__F01_HOOKS.shots),
      sid: window.__F01_HOOKS.sid
    }));
    assert.deepEqual(foreign.shotKeys, [], 'shots cache cleared on bumpIdentity');
    assert.equal(foreign.sid, 'other-station');
    await page.evaluate(() => { window.__F01_PHOTO_LAG_MS = 0; });
    console.log('✓ faults.html history: 0 photo getDocs; detail: 1; bump discards late');
  });

  await withPage('vehicle.html?v=v1', async page => {
    await page.locator('#list .f, #vehChips button').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(150);
    const listState = await page.evaluate(() => ({
      photos: window.__F01_PHOTO_GETS || 0,
      listImgs: document.querySelectorAll('#list .shots img').length,
      skeleton: [...document.querySelectorAll('#list .shots .ld')]
        .map(el => el.textContent || '')
        .join('|')
    }));
    assert.equal(listState.photos, 0, 'vehicle renderList must not getDocs(/photos)');
    assert.equal(listState.listImgs, 0, 'no list photo imgs before openFault');

    const pin = page.locator('.pin').first();
    if (await pin.count()) {
      await tap(pin);
    } else {
      await page.evaluate(() => {
        const f = window.__F01_HOOKS.faultsRef.find(x => Number(x.photos || 0) > 0);
        window.__F01_HOOKS.openFault(f, 1);
      });
    }
    await page.locator('#ov.on').waitFor({ timeout: 5000 });
    await page.waitForFunction(() => (window.__F01_PHOTO_GETS || 0) >= 1);
    await page.locator('#ov.on .shots img').first().waitFor({ timeout: 5000 });
    const detail = await page.evaluate(() => ({
      photos: window.__F01_PHOTO_GETS || 0,
      imgs: document.querySelectorAll('#ov.on .shots img').length,
      cacheKeys: Object.keys(window.__F01_HOOKS.shots),
      authGen: window.__F01_HOOKS.gen
    }));
    assert.equal(detail.photos, 1, 'openFault → exactly one photos getDocs');
    assert.equal(detail.imgs, 2, 'all photos rendered in detail');
    assert.ok(detail.cacheKeys.length >= 1, 'cache populated');
    assert.ok(detail.cacheKeys.every(k => /:/.test(k)), 'cache keys are SID:faultId');
    assert.ok(detail.authGen >= 1, 'AUTH_GEN active');

    await page.evaluate(() => document.getElementById('dlgX').click());
    await page.evaluate(() => {
      const f = window.__F01_HOOKS.faultsRef.find(x => Number(x.photos || 0) > 0);
      window.__F01_HOOKS.openFault(f, 1);
    });
    await page.locator('#ov.on .shots img').first().waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__F01_PHOTO_GETS || 0), 1, 'cache hit');

    await page.evaluate(() => document.getElementById('dlgX').click());
    const unlocated = page.locator('#list .f').filter({ hasText: 'תקלה ללא מיקום עם תמונות' });
    await unlocated.getByRole('button', { name: /הצג פרטים ותמונות/ }).click();
    await page.locator('#ov.on .shots img').first().waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#ov.on .shots img').count(), 2, 'unlocated fault photos reachable');
    await page.evaluate(() => {
      document.getElementById('dlgX').click();
      window.__F01_PHOTO_LAG_MS = 300;
      const f = window.__F01_FIXTURE.faults.find(x => x.id === 'f1');
      window.__F01_HOOKS.openFault(f, 2);
      document.getElementById('dlgX').click();
    });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => Object.keys(window.__F01_HOOKS.shots).some(k => k.endsWith(':f1'))),
      false, 'closed detail must discard late photos before cache');
    await page.evaluate(() => { window.__F01_PHOTO_LAG_MS = 0; });
    await page.evaluate(() => {
      window.__F01_HOOKS.bump();
      window.__F01_HOOKS.setSid('eilat_102');
      const f = window.__F01_FIXTURE.faults.find(x => Number(x.photos || 0) > 0);
      window.__F01_HOOKS.openFault(f, 1);
    });
    await page.waitForFunction(() => (window.__F01_PHOTO_GETS || 0) >= 4);
    const afterBump = await page.evaluate(() => ({
      photos: window.__F01_PHOTO_GETS || 0,
      keys: Object.keys(window.__F01_HOOKS.shots),
      inflight: Object.keys(window.__F01_HOOKS.inflight),
      gen: window.__F01_HOOKS.gen
    }));
    assert.equal(afterBump.photos, 4, 'after bumpIdentity cache miss → new getDocs');
    assert.ok(afterBump.gen >= 2);
    assert.ok(afterBump.keys.every(k => /:/.test(k)));
    console.log('✓ vehicle.html list: 0 photo getDocs; openFault: 1; cache+AUTH_GEN ok');
  });

  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))];
  };
  const summary = {
    N_faults_with_photos: N,
    before_model_photo_getDocs_on_history_open: N,
    after_history_photo_getDocs: metrics.historyPhotoGets,
    after_detail_photo_getDocs: metrics.detailPhotoGets,
    history_open_ms_p50: pct(metrics.historyOpenMs, 50),
    history_open_ms_p95: pct(metrics.historyOpenMs, 95),
    detail_open_ms_p50: pct(metrics.detailOpenMs, 50),
    detail_open_ms_p95: pct(metrics.detailOpenMs, 95)
  };
  console.log('F01 metrics', summary);
  console.log('Passed', passed, 'scenarios');
} finally {
  await browser.close();
  server.close();
}
