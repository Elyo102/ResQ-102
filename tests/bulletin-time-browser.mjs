// Narrow timestamp regression. Local Firebase stubs only; no production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './lib/contained-playwright.cjs';
import { createContainedServer } from './lib/localize-worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const firestoreSource = fs.readFileSync(path.join(stub, 'firebase-firestore.js'), 'utf8');
const needle = 'created_at:stamp(iso), created_key:iso';
assert.equal(firestoreSource.split(needle).length - 1, 2,
  'Both live-injection helpers must retain the expected timestamp seam');
// Patch only the served response, never the shared stub on disk.
const timestampStub = firestoreSource.replaceAll(needle,
  'created_at:(window.__BULLETIN_TEST_TIME ?? stamp(iso)), created_key:iso');
const types = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json',
  '.jpg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml'
};
const server = createContainedServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/login.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport:{ width:390, height:844 }, locale:'he-IL', colorScheme:'light'
  });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    return route.fulfill({
      status:200, contentType:'text/javascript',
      body:name === 'firebase-firestore.js' ? timestampStub :
        fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};'
    });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(() => {
    window.__SMOKE_ROLE = 'firefighter';
    window.__SMOKE_UID = 'stub-uid';
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:' + server.address().port + '/login.html', { waitUntil:'load' });
  await page.locator('#coNo').click({ timeout:1200 }).catch(() => {});
  await page.addStyleTag({ content:'#coWrap{display:none!important}' });
  await page.locator('#bulletinBoard').waitFor({ state:'visible', timeout:10000 });
  const threadMessage = page.locator('#bulletinFeed [data-message-id="br2"]');
  await threadMessage.locator('[data-testid="bulletin-replies-toggle"]').click();
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-message-id="br2"] [data-testid="bulletin-reply"]').length === 2);
  await page.locator('#bulletinCompose').click();
  const draft = 'Timestamp recovery must preserve this unsent draft';
  await page.locator('#bulletinText').fill(draft);

  async function push(helper, input, malformedTime) {
    await page.evaluate(async ({ helper, input, malformedTime }) => {
      if (malformedTime !== undefined) window.__BULLETIN_TEST_TIME = malformedTime;
      try {
        await window[helper](input);
      } finally {
        delete window.__BULLETIN_TEST_TIME;
      }
    }, { helper, input, malformedTime });
  }
  async function settled() {
    await page.waitForFunction(() =>
      document.getElementById('bulletinFeed')?.getAttribute('aria-busy') === 'false' &&
      !Array.from(document.querySelectorAll('.bulletin-reply-state'))
        .some(node => node.textContent.includes('טוען')));
    assert.equal(await page.locator('#bulletinText').inputValue(), draft,
      'Live timestamp updates must preserve the unsent compose draft');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
  }
  async function rendered(selector, iso, text) {
    const row = page.locator(selector);
    await row.waitFor({ state:'visible', timeout:5000 });
    assert.equal(await row.locator('time').getAttribute('datetime'), iso,
      'The row must render a valid timestamp, using created_key when needed');
    assert.ok((await row.innerText()).includes(text), 'The row content must remain visible');
  }

  const siblingIso = '2099-01-01T10:00:00.000Z';
  await push('__FIRESTORE_PUSH_BULLETIN', {
    boardId:'rashit', id:'time-valid-sibling', text:'Valid message sibling', iso:siblingIso
  });
  const expand = page.locator('#bulletinFeedToggle');
  if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();

  const messageIso = '2099-01-01T11:00:00.000Z';
  await push('__FIRESTORE_PUSH_BULLETIN', {
    boardId:'rashit', id:'time-malformed-message', text:'Malformed timestamp message', iso:messageIso
  }, 1e20);
  await rendered('[data-message-id="time-malformed-message"]', messageIso, 'Malformed timestamp message');
  await rendered('[data-message-id="time-valid-sibling"]', siblingIso, 'Valid message sibling');
  await settled();

  const replySiblingIso = '2099-01-01T10:30:00.000Z';
  await push('__FIRESTORE_PUSH_BULLETIN_REPLY', {
    boardId:'rashit', messageId:'br2', id:'time-valid-reply-sibling',
    text:'Valid reply sibling', iso:replySiblingIso
  });
  const replyIso = '2099-01-01T11:30:00.000Z';
  await push('__FIRESTORE_PUSH_BULLETIN_REPLY', {
    boardId:'rashit', messageId:'br2', id:'time-malformed-reply',
    text:'Malformed timestamp reply', iso:replyIso
  }, { seconds:1e17 });
  await rendered('[data-reply-id="time-malformed-reply"]', replyIso, 'Malformed timestamp reply');
  await rendered('[data-reply-id="time-valid-reply-sibling"]', replySiblingIso, 'Valid reply sibling');
  await settled();

  const laterIso = '2099-01-01T12:00:00.000Z';
  await push('__FIRESTORE_PUSH_BULLETIN', {
    boardId:'rashit', id:'time-later-message', text:'Later valid message', iso:laterIso
  });
  await rendered('[data-message-id="time-later-message"]', laterIso, 'Later valid message');
  await push('__FIRESTORE_PUSH_BULLETIN_REPLY', {
    boardId:'rashit', messageId:'br2', id:'time-later-reply', text:'Later valid reply', iso:laterIso
  });
  await rendered('[data-reply-id="time-later-reply"]', laterIso, 'Later valid reply');
  await rendered('[data-message-id="time-malformed-message"]', messageIso, 'Malformed timestamp message');
  await rendered('[data-reply-id="time-malformed-reply"]', replyIso, 'Malformed timestamp reply');
  await settled();
  assert.equal(await page.evaluate(() => Object.hasOwn(window, '__BULLETIN_TEST_TIME')), false);
  await context.close();
  assert.deepEqual(errors, [], 'No page errors through context cleanup');
  console.log('PASS bulletin timestamp browser recovery (message + reply)');
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server.listening) await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}
