import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const unix = value => String(value).split(sep).join('/');
const read = path => readFileSync(path, 'utf8');

function filesIn(dir, accept) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && accept(entry.name))
    .map(entry => resolve(dir, entry.name));
}

const candidates = [
  ...filesIn(here, name => name.endsWith('.mjs') && name !== 'test-inventory.mjs'),
  ...filesIn(join(root, 'functions'), name => /(?:\.integration)?\.test\.js$/.test(name))
];
const byBase = new Map(candidates.map(path => [unix(relative(root, path)), path]));

function registryText() {
  const paths = [
    join(here, 'package.json'),
    join(root, 'functions', 'package.json'),
    join(root, 'rules-test', 'package.json')
  ];
  const workflows = join(root, '.github', 'workflows');
  if (existsSync(workflows)) {
    for (const entry of readdirSync(workflows, { withFileTypes: true })) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) paths.push(join(workflows, entry.name));
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.bat') paths.push(join(root, entry.name));
  }
  return paths.filter(existsSync).map(read).join('\n');
}

const registered = new Set();
const registry = registryText();
for (const [name, path] of byBase) {
  if (registry.includes(name) || registry.includes(path.split(sep).at(-1))) registered.add(path);
}

// A registered runner may import a helper or launch a mutation target. Follow
// only exact candidate basenames from reachable source; an unreferenced comment
// in an unreachable file can never make that file reachable.
const queue = [...registered];
while (queue.length) {
  const source = read(queue.shift());
  for (const [name, path] of byBase) {
    if (registered.has(path)) continue;
    const basename = name.slice(name.lastIndexOf('/') + 1);
    if (source.includes(basename)) {
      registered.add(path);
      queue.push(path);
    }
  }
}

const orphaned = [...byBase]
  .filter(([, path]) => !registered.has(path))
  .map(([name]) => name)
  .sort();

assert.deepEqual(orphaned, [],
  'Test files are not registered by package scripts, CI, an emulator runner, or a reachable test helper:\n' +
  orphaned.map(name => '  - ' + name).join('\n'));

console.log('Test inventory PASS ' + JSON.stringify({ candidates: candidates.length, registered: registered.size }));
