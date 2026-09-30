import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GATE_TARGETS, resolveContainedGate, assertApplicationGate } from './lib/gate-contract.mjs';
import { describeGates } from './reproducibility.mjs';

const prefix = ['test:reproducibility', 'test:inventory', 'pages:source'];
const chain = names => names.map(name => 'npm run ' + name).join(' && ');
function fixture() {
  return {
    all: 'node run-contained.mjs all',
    'all:inner': chain([...prefix, 'static', 'browser']),
    'test:all': 'node run-contained.mjs test:all',
    'test:all:inner': 'npm run test:reproducibility && npm run test:rules && npm run test:e2e'
  };
}
const rules = { test: 'node one.mjs && node ../functions/two.test.js' };

test('closed frozen mapping resolves exactly the three public gates', () => {
  assert.equal(Object.isFrozen(GATE_TARGETS), true);
  assert.deepEqual(Object.keys(GATE_TARGETS).sort(), ['all', 'reserve:contained', 'test:all']);
  assert.equal(resolveContainedGate('all'), 'all:inner');
  assert.equal(resolveContainedGate('test:all'), 'test:all:inner');
  assert.equal(resolveContainedGate('reserve:contained'), 'reserve:contained:inner');
  assert.throws(() => { GATE_TARGETS.all = 'unreviewed'; }, TypeError);
});

for (const value of ['all:inner', 'test:all:inner', 'reserve:contained:inner', '__proto__', 'constructor', 'toString',
  'hasOwnProperty', 'unknown', '', ' all', 'all ', undefined, null, 0, true,
  [], ['all'], {}, new String('all'), { toString: () => 'all' }]) {
  test('resolver rejects unknown/prototype/inner/nonstring gate: ' + String(value), () => {
    assert.throws(() => resolveContainedGate(value));
  });
}

test('valid prefix plus product steps satisfies both shared consumers', () => {
  assert.equal(assertApplicationGate(fixture()), true);
  assert.equal(describeGates(fixture(), rules).rulesEntries, 2);
  assert.equal(assertApplicationGate({ ...fixture(), 'all:inner': chain([...prefix, 'static']) }), true);
});

const mutations = [
  ['missing wrapper', value => { delete value.all; }],
  ['direct chain bypass', value => { value.all = value['all:inner']; }],
  ['wrong public target', value => { value.all = 'node run-contained.mjs test:all'; }],
  ['direct inner target', value => { value.all = 'npm run all:inner'; }],
  ['wrapper extra command', value => { value.all += ' && npm run static'; }],
  ['missing inner', value => { delete value['all:inner']; }],
  ['nonstring inner', value => { value['all:inner'] = prefix; }],
  ['missing reproducibility', value => { value['all:inner'] = chain(['test:inventory', 'pages:source', 'static', 'browser']); }],
  ['missing inventory', value => { value['all:inner'] = chain(['test:reproducibility', 'pages:source', 'static', 'browser']); }],
  ['missing pages', value => { value['all:inner'] = chain(['test:reproducibility', 'test:inventory', 'static', 'browser']); }],
  ['swapped prefix', value => { value['all:inner'] = chain(['test:inventory', 'test:reproducibility', 'pages:source', 'static']); }],
  ['moved pages after product', value => { value['all:inner'] = chain(['test:reproducibility', 'test:inventory', 'static', 'pages:source']); }],
  ['product interleaved in prefix', value => { value['all:inner'] = chain(['test:reproducibility', 'static', 'test:inventory', 'pages:source']); }],
  ['duplicate prefix later', value => { value['all:inner'] = chain([...prefix, 'static', 'test:inventory']); }],
  ['duplicate product step', value => { value['all:inner'] = chain([...prefix, 'static', 'static']); }],
  ['no product step', value => { value['all:inner'] = chain(prefix); }],
  ['commented dead prefix', value => { value['all:inner'] = '# ' + value['all:inner']; }],
  ['dead quoted chain', value => { value['all:inner'] = 'echo "' + value['all:inner'] + '"'; }],
  ['shell alternative', value => { value['all:inner'] = value['all:inner'].replace(' && ', ' || '); }],
  ['shell semicolon', value => { value['all:inner'] += '; npm run extra'; }],
  ['shell substitution', value => { value['all:inner'] += ' && npm run $(other)'; }],
  ['comment suffix', value => { value['all:inner'] += ' # ignored'; }],
  ['blank command', value => { value['all:inner'] += ' && '; }],
  ['nonexact delimiter', value => { value['all:inner'] = value['all:inner'].replace(' && ', '&&'); }],
  ['leading whitespace', value => { value['all:inner'] = ' ' + value['all:inner']; }],
  ['trailing whitespace', value => { value['all:inner'] += ' '; }],
  ['embedded newline', value => { value['all:inner'] += '\n'; }],
  ['embedded carriage return', value => { value['all:inner'] += '\r'; }],
  ['embedded CRLF', value => { value['all:inner'] += '\r\n'; }],
  ['Unicode line separator', value => { value['all:inner'] += '\u2028'; }],
  ['Unicode paragraph separator', value => { value['all:inner'] += '\u2029'; }]
];
for (const [name, mutate] of mutations) {
  test('application contract and reproducibility reject: ' + name, () => {
    const value = fixture();
    const before = JSON.stringify(value);
    mutate(value);
    assert.notEqual(JSON.stringify(value), before, 'mutation applied');
    assert.throws(() => assertApplicationGate(value), /APPLICATION_GATE_CHANGED/);
    assert.throws(() => describeGates(value, rules), /APPLICATION_GATE_CHANGED/);
  });
}

test('actual package retains the shared application contract and focused gate parity', () => {
  const scripts = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).scripts;
  assert.equal(assertApplicationGate(scripts), true);
  assert.equal(describeGates(scripts, rules).rulesEntries, 2);
});
