import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createMailDeliveryGuard } = require('../functions/mail-delivery-guard');
const { stationDeliveryDecision } = require('../functions/station-delivery-fence');
const source = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('exports.deliverMail = onDocumentCreated(');
const end = source.indexOf('\n);', start);
assert.ok(start >= 0 && end > start, 'actual SMTP handler found');
const handlerSource = source.slice(start, end + 4);
const asList = v => (!v ? [] : (Array.isArray(v) ? v : [v]))
  .map(x => String(x || '').trim()).filter(x => x.includes('@'));
const clone = v => structuredClone(v);
const fixture = { station_id: 'eilat_102', to: ['owner@example.test'],
  message: { subject: 'fixture', html: '<p>fixture</p>' } };

async function run(options = {}) {
  const original = clone(options.job || fixture);
  let row = clone(original), sends = 0, checks = 0, writes = 0, failures = 0;
  const ref = { id: 'fixture_mail', get: async () => ({ exists: row !== null, data: () => clone(row) }),
    set: async patch => { writes++; row = { ...row, ...clone(patch) }; } };
  const db = { runTransaction: async fn => fn({ get: async () => {
    if (options.terminalBeforeClaim) row.delivery = { state: 'SUCCESS' };
    return ref.get(); }, set: (unused, patch) => ref.set(patch) }),
    collection: name => ({ add: async () => { assert.equal(name, 'mail_failures'); failures++; } }) };
  const guard = createMailDeliveryGuard({ normalizeRecipients: asList,
    runtimeFresh: async () => {
      checks++;
      if (options.readFailures && checks <= options.readFailures) throw Error('offline');
      return options.runtime || { silent: false };
    }, stationFence: { check: async value => stationDeliveryDecision({ ...value, exists: true,
      station: options.station || { active: true, silent: false } }) } });
  const context = { exports: {}, onDocumentCreated: (opts, handler) => handler,
    GMAIL_APP_PASSWORD: { value: () => 'synthetic-secret' }, db,
    FV: { serverTimestamp: () => new Date('2026-09-15T00:00:00Z') },
    mailDeliveryGuard: guard, asList, MAIL_FROM_NAME: 'fixture', MAIL_FROM_ADDR: 'sender@example.test',
    MAIL_ATTEMPTS: 3, mailer: null, setTimeout: callback => callback(),
    console: { log() {}, warn() {} }, getMailer: () => ({ sendMail: async () => {
      sends++; if (options.failFirstSend && sends === 1) throw Error('provider-temporary');
      return { messageId: 'fixture', accepted: ['owner@example.test'], rejected: [] };
    } }) };
  vm.runInNewContext(handlerSource, context, { timeout: 3000 });
  await context.exports.deliverMail({ data: { ref, data: () => clone(original) } });
  return { row, sends, checks, writes, failures };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
await test('actual handler live scoped delivery', async () => {
  const r = await run(); assert.equal(r.sends, 1); assert.equal(r.row.delivery.state, 'SUCCESS');
});
await test('station silence suppresses actual SMTP without failure alert', async () => {
  const r = await run({ station: { active: true, silent: true } });
  assert.equal(r.sends, 0); assert.equal(r.row.delivery.state, 'SUPPRESSED'); assert.equal(r.failures, 0);
});
await test('global silence applies to every copied recipient', async () => {
  const r = await run({ job: { ...fixture, bcc: ['outsider@example.test'] },
    runtime: { silent: true, silent_allow: ['owner@example.test'] } });
  assert.equal(r.sends, 0); assert.equal(r.row.delivery.state, 'SUPPRESSED');
});
await test('failed policy checks cannot send and have truthful attempt count', async () => {
  const r = await run({ readFailures: 3 });
  assert.equal(r.sends, 0); assert.equal(r.checks, 3); assert.equal(r.row.delivery.state, 'ERROR');
  assert.equal(r.row.delivery.attempts, 0); assert.equal(r.row.delivery.check_attempts, 3);
});
await test('temporary policy failure retries before a single send', async () => {
  const r = await run({ readFailures: 1 }); assert.equal(r.sends, 1);
  assert.equal(r.row.delivery.attempts, 1); assert.equal(r.row.delivery.check_attempts, 2);
});
await test('fresh terminal result is not clobbered by PROCESSING', async () => {
  const r = await run({ terminalBeforeClaim: true });
  assert.equal(r.sends, 0); assert.equal(r.writes, 0); assert.equal(r.row.delivery.state, 'SUCCESS');
});
await test('stale malformed event cannot overwrite a terminal receipt', async () => {
  const r = await run({ job: { ...fixture, to: [] }, terminalBeforeClaim: true });
  assert.equal(r.sends, 0); assert.equal(r.writes, 0); assert.equal(r.row.delivery.state, 'SUCCESS');
});
await test('current malformed recipients get ERROR without SMTP', async () => {
  const r = await run({ job: { ...fixture, to: [] } });
  assert.equal(r.sends, 0); assert.equal(r.row.delivery.state, 'ERROR');
  assert.equal(r.row.delivery.attempts, 0);
});
await test('malformed station never becomes platform mail', async () => {
  const r = await run({ job: { ...fixture, station_id: null } });
  assert.equal(r.sends, 0); assert.equal(r.row.delivery.state, 'ERROR');
});
await test('existing provider retries remain bounded and explicitly non-exactly-once', async () => {
  const r = await run({ failFirstSend: true }); assert.equal(r.sends, 2);
  assert.equal(r.row.delivery.attempts, 2); assert.equal(r.checks, 2);
});
console.log('Actual SMTP handler wiring: ' + passed + ' passed (mock Firestore/SMTP, no network)');
