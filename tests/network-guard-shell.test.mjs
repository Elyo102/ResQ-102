import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import guard from './lib/network-guard.cjs';

const scripts = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).scripts;
const allowed = guard.isRegisteredShellCommand;
test('exact registered npm chain permits && without weakening the command registry', () => {
  assert.match(scripts['test:all:inner'], /&&/);
  assert.equal(allowed(scripts['test:all:inner'], scripts), true);
  assert.equal(allowed('"' + scripts['test:all:inner'] + '"', scripts), true);
  assert.equal(allowed('npm run test:all', scripts), true);
  assert.equal(allowed('npm run unregistered-command', scripts), false);
  assert.equal(allowed('node first.mjs && node arbitrary.mjs', scripts), false);
  assert.equal(allowed(scripts['test:all:inner'], undefined), false);
});
test('single/triple ampersands and shell metacharacters remain denied even if registered', () => {
  for (const command of ['node a.mjs & node b.mjs', 'node a.mjs &&& node b.mjs',
    'node a.mjs | node b.mjs', 'node a.mjs > output', 'node a.mjs < input',
    'node a.mjs; node b.mjs', 'node a.mjs\nnode b.mjs', 'node $SHELL', 'node `command`']) {
    assert.equal(allowed(command, { deliberatelyUnsafe: command }), false, command);
  }
});
