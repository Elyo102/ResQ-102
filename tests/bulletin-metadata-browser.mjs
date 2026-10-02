// Render-only malformed metadata regression, using local Firebase stubs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './lib/contained-playwright.cjs';
import { createContainedServer } from './lib/localize-worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const source = fs.readFileSync(path.join(stub, 'firebase-firestore.js'), 'utf8');
const needle = 'created_at:stamp(iso), created_key:iso';
assert.equal(source.split(needle).length - 1, 2, 'Both live helper seams must match');
const metadataStub = source.replaceAll(needle,
  needle + ', ...(window.__BULLETIN_TEST_METADATA || {})');
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
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    return route.fulfill({ status:200, contentType:'text/javascript',
      body:name === 'firebase-firestore.js' ? metadataStub :
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
  const threadMessage = page.locator('[data-message-id="br2"]');
  await threadMessage.locator('[data-testid="bulletin-replies-toggle"]').click();
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-message-id="br2"] [data-testid="bulletin-reply"]').length === 2);
  await page.locator('#bulletinCompose').click();
  const draft = 'Preserve this unsent draft through malformed metadata';
  await page.locator('#bulletinText').fill(draft);

  async function push(reply, id, text, malformed = false) {
    await page.evaluate(async ({ reply, id, text, malformed }) => {
      if (malformed) {
        // This is a Firestore-storable map, not a function/proxy fixture.
        const bad = { toString:1, valueOf:1 };
        window.__BULLETIN_TEST_METADATA = Object.fromEntries([
          'by_name', 'author_name', 'by_role', 'author_role', 'by_crew', 'reply_count', 'category'
        ].map(key => [key, bad]));
      }
      try {
        await window[reply ? '__FIRESTORE_PUSH_BULLETIN_REPLY' : '__FIRESTORE_PUSH_BULLETIN']({
          boardId:'rashit', messageId:'br2', id, text, iso:'2099-01-01T12:00:00.000Z'
        });
      } finally {
        delete window.__BULLETIN_TEST_METADATA;
      }
    }, { reply, id, text, malformed });
  }
  async function visibleText(selector, expected) {
    const row = page.locator(selector);
    await row.waitFor({ state:'visible', timeout:5000 });
    assert.ok((await row.innerText()).includes(expected), 'Message/reply body remains intact');
    return row;
  }
  async function settled() {
    await page.waitForFunction(() =>
      document.getElementById('bulletinFeed')?.getAttribute('aria-busy') === 'false' &&
      !Array.from(document.querySelectorAll('.bulletin-reply-state'))
        .some(node => node.textContent.includes('טוען')));
    assert.equal(await page.locator('#bulletinText').inputValue(), draft);
    assert.equal(await threadMessage.locator('[data-testid="bulletin-replies-toggle"]')
      .getAttribute('aria-expanded'), 'true', 'The original reply thread stays open');
    assert.equal(await threadMessage.locator('[data-testid="bulletin-thread"]').count(), 1);
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    const counts = await page.locator('[data-testid="bulletin-replies-toggle"]').allTextContents();
    assert.ok(counts.every(text => !/NaN|Infinity|\[object Object\]/.test(text)),
      'Reply toggles must not display invalid count strings');
  }

  await push(false, 'metadata-valid-message', 'Valid metadata message sibling');
  const expand = page.locator('#bulletinFeedToggle');
  if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
  await push(false, 'metadata-bad-message', 'Malformed metadata message body', true);
  const badMessage = await visibleText('[data-message-id="metadata-bad-message"]', 'Malformed metadata message body');
  assert.equal(await badMessage.locator('.bulletin-author-name').innerText(), 'חבר צוות');
  assert.equal(await badMessage.locator('.bulletin-author-role').count(), 0);
  assert.equal(await badMessage.locator('[data-testid="bulletin-replies-toggle"]').count(), 0,
    'Malformed count falls back to zero');
  assert.ok((await badMessage.getAttribute('class')).split(' ').includes('category-general'));
  await visibleText('[data-message-id="metadata-valid-message"]', 'Valid metadata message sibling');
  await settled();

  await push(true, 'metadata-valid-reply', 'Valid metadata reply sibling');
  await push(true, 'metadata-bad-reply', 'Malformed metadata reply body', true);
  const badReply = await visibleText('[data-reply-id="metadata-bad-reply"]', 'Malformed metadata reply body');
  assert.equal(await badReply.locator('.bulletin-reply-name').innerText(), 'חבר צוות');
  assert.equal(await badReply.locator('.bulletin-reply-role').count(), 0);
  await visibleText('[data-reply-id="metadata-valid-reply"]', 'Valid metadata reply sibling');
  await settled();

  await push(false, 'metadata-later-message', 'Later valid metadata message');
  await push(true, 'metadata-later-reply', 'Later valid metadata reply');
  await visibleText('[data-message-id="metadata-later-message"]', 'Later valid metadata message');
  await visibleText('[data-reply-id="metadata-later-reply"]', 'Later valid metadata reply');
  await visibleText('[data-message-id="metadata-bad-message"]', 'Malformed metadata message body');
  await visibleText('[data-reply-id="metadata-bad-reply"]', 'Malformed metadata reply body');
  await settled();
  assert.equal(await page.evaluate(() => Object.hasOwn(window, '__BULLETIN_TEST_METADATA')), false);
  await context.close();
  assert.deepEqual(errors, []);
  console.log('PASS bulletin malformed metadata browser recovery');
} finally {
  try { if (browser) await browser.close(); }
  finally {
    if (server.listening) await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}
