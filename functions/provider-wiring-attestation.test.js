'use strict';
const assert = require('node:assert/strict');
const { SOURCES, PROVIDERS, verifyProviderWiringAttestation: verify,
  candidateProviderWiringReceipt: candidate } = require('./provider-wiring-attestation');
const texts = Object.fromEntries(SOURCES.map(name => [name, '// source ' + name + '\n']));
const receipt = candidate({ readText: name => texts[name] });
let passed = 0;
function check(name, change, expected = false) {
  const files = { ...texts }; const row = structuredClone(receipt);
  change(row, files);
  const seen = [];
  const result = verify({ readText: file => { seen.push(file);
    if (file === 'provider-wiring-attestation.json') return JSON.stringify(row);
    if (!(file in files)) throw Error('missing'); return files[file]; } });
  assert.equal(result.valid, expected, name);
  assert.equal(Object.isFrozen(result), true);
  assert.ok(seen.every(file => file === 'provider-wiring-attestation.json' || SOURCES.includes(file)));
  passed++;
}
check('exact frozen sources', () => {}, true);
check('CRLF checkout canonical parity', (_, files) => { for (const name of SOURCES) files[name] = files[name].replace(/\n/g, '\r\n'); }, true);
for (const file of SOURCES) {
  check('changed ' + file, (_, files) => { files[file] += '// changed'; });
  check('missing source ' + file, (_, files) => { delete files[file]; });
  check('missing receipt entry ' + file, row => { delete row.sources[file]; });
}
check('extra source/path cannot select a file', row => { row.sources['../secret'] = 'a'.repeat(64); });
check('bad digest', row => { row.sources[SOURCES[0]] = 'true'; });
check('wrong schema', row => { row.schema_version = 2; });
check('wrong normalization', row => { row.normalization = 'raw'; });
check('extra top-level property', row => { row.allow = true; });
check('omitted provider', row => { row.providers.pop(); });
check('duplicate provider', row => { row.providers.push(PROVIDERS[0]); });
check('wrong provider', row => { row.providers[0] = 'fake'; });
assert.equal(verify({ readText: () => { throw Error('missing receipt'); } }).valid, false); passed++;
assert.equal(verify({ readText: () => 'not JSON' }).valid, false); passed++;
console.log('Provider source receipt: ' + passed + ' tests passed');
