import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = path.join(root, 'tests/lib/containment-inventory.json');
const metadataOnly = new Set(['tests/playwright.config.mjs']);
const trustedAdapters = new Set(['tests/lib/contained-playwright.cjs', 'tests/lib/contained-test.mjs']);
const ignored = new Set(['node_modules', 'test-results', 'playwright-report', '.git', 'outputs']);

function files(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return [];
    if (entry.isSymbolicLink()) throw Error('CONTAINMENT_SYMLINK: ' + dir + '/' + entry.name);
    const name = dir + '/' + entry.name;
    return entry.isDirectory() ? files(name) : /\.(?:mjs|cjs|js)$/.test(name) ? [name] : [];
  });
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

export function inspectSource(file, source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
  const imports = [], calls = { launch: 0, context: 0, server: 0, child: 0 };
  walk(ast, node => {
    let specifier;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') specifier = node.source?.value;
    if (node.type === 'ImportExpression') specifier = node.source?.value;
    if (node.type === 'CallExpression' && node.arguments?.[0]?.type === 'Literal') specifier = node.arguments[0].value;
    if (typeof specifier === 'string' && /(?:playwright|contained-test|invitation\.fixture)/.test(specifier)) imports.push(specifier);
    if (node.type !== 'CallExpression') return;
    const name = node.callee?.property?.name || node.callee?.name;
    if (['launch', 'launchPersistentContext', 'connectOverCDP'].includes(name)) calls.launch++;
    if (['newContext', 'newPage'].includes(name)) calls.context++;
    if (['createServer', 'createContainedServer'].includes(name)) calls.server++;
    if (['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'].includes(name)) calls.child++;
  });
  const direct = imports.filter(value => /^(?:playwright(?:\/test)?|@playwright\/test)$/.test(value));
  if (direct.length && !trustedAdapters.has(file) && !metadataOnly.has(file)) throw Error('DIRECT_PLAYWRIGHT_ESCAPE: ' + file);
  if (metadataOnly.has(file) && (calls.launch || calls.context)) throw Error('CONFIG_EXECUTOR_ESCAPE: ' + file);
  if ((calls.launch || calls.context) && !trustedAdapters.has(file) && !imports.some(value => /contained-playwright|contained-test|invitation\.fixture/.test(value))) {
    // A source mutation fixture may only contain these names in quoted strings;
    // AST call detection deliberately does not count such strings.
    throw Error('UNCONTAINED_BROWSER_ENTRY: ' + file);
  }
  return { file, imports: [...new Set(imports)].sort(), ...calls };
}

export function inventory() {
  const entries = [];
  for (const file of ['tests', 'functions', 'rules-test'].flatMap(files).sort()) {
    if (file === 'tests/containment-inventory.mjs' || file.endsWith('/containment-inventory.test.mjs')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (!/playwright|\.launch\(|\.newContext\(|\.newPage\(|createServer|child_process/.test(source)) continue;
    const entry = inspectSource(file, source);
    if (entry.imports.length || entry.launch || entry.context || entry.server || entry.child) entries.push(entry);
  }
  return { schema: 1, scope: 'Conservative tests/functions/rules-test JavaScript inventory; runtime guard is still mandatory', entries };
}

export function checkInventory() {
  const actual = inventory();
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  compareInventory(actual, expected);
  return { files: actual.entries.length, browserFiles: actual.entries.filter(e => e.launch || e.context).length };
}

export function compareInventory(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('CONTAINMENT_INVENTORY_CHANGED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkInventory()));
}
