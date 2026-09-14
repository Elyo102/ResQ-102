import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'schedule-management.js'), 'utf8');
const tree = parse(source, { ecmaVersion:'latest', sourceType:'module' });
const mutationCalls = new Set([
  'modeSet', 'cutoverPromote', 'sourceSave', 'policySave', 'run',
  'importSheet', 'displaySet', 'editApply', 'qualSave', 'qualDelete',
  'qualPerson', 'gapPolicy', 'publish', 'rollback', 'respond'
]);

function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    if (Array.isArray(value)) value.forEach(item => {
      if (item && typeof item.type === 'string') out.push(item);
    });
    else if (value && typeof value.type === 'string') out.push(value);
  }
  return out;
}

const calls = [];
function walk(node, functions = []) {
  const isFunction = /Function(?:Declaration|Expression)$/.test(node.type)
    || node.type === 'ArrowFunctionExpression';
  const stack = isFunction ? functions.concat(node) : functions;
  if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
      && !node.callee.computed && node.callee.object?.name === 'call'
      && mutationCalls.has(node.callee.property?.name)) {
    calls.push({ name:node.callee.property.name, node, owner:stack.at(-1) || null });
  }
  children(node).forEach(child => walk(child, stack));
}
walk(tree);

const present = new Set(calls.map(item => item.name));
assert.deepEqual([...present].sort(), [...mutationCalls].sort(),
  'the closed mutation-call inventory changed; classify every added or removed write');

const guard = source.match(/function\s+scheduleMutationAllowed\s*\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
assert.match(guard,
  /return\s+state\.authResolving\s*!==\s*true\s*&&\s*!\(state\.roleView\s*&&\s*state\.roleView\.readOnly\)\s*;/,
  'scheduleMutationAllowed must deny auth transition and shared page readOnly state');

function synchronousAuthClose(program) {
  const handler = program.body.find(node =>
    node.type === 'FunctionDeclaration' && node.id?.name === 'handleIdToken');
  if (!handler) return null;
  const assignment = handler.body.body.find(node =>
    node.type === 'ExpressionStatement' &&
    node.expression?.type === 'AssignmentExpression' &&
    node.expression.operator === '=' &&
    node.expression.left?.type === 'MemberExpression' &&
    node.expression.left.object?.name === 'state' &&
    node.expression.left.property?.name === 'authResolving' &&
    node.expression.right?.type === 'Literal' &&
    node.expression.right.value === true);
  let firstAwait = null;
  const findAwait = node => {
    if (!node || firstAwait) return;
    if (node.type === 'AwaitExpression') { firstAwait = node; return; }
    children(node).forEach(findAwait);
  };
  findAwait(handler.body);
  return assignment && firstAwait && assignment.start < firstAwait.start ? assignment : null;
}
const authClose = synchronousAuthClose(tree);
assert.ok(authClose, 'handleIdToken must set authResolving=true synchronously before its first await');
const withoutAuthClose = source.slice(0, authClose.start) + source.slice(authClose.end);
const mutatedTree = parse(withoutAuthClose, { ecmaVersion:'latest', sourceType:'module' });
assert.equal(synchronousAuthClose(mutatedTree), null,
  'removing the synchronous auth-transition close must be caught');

const unguarded = [];
for (const item of calls) {
  if (!item.owner) { unguarded.push(item.name + ':top-level'); continue; }
  const prefix = source.slice(item.owner.start, item.node.start);
  if (!/scheduleMutationAllowed\s*\(/.test(prefix)) {
    unguarded.push(item.name + '@' + item.node.start);
  }
}
assert.deepEqual(unguarded, [],
  'every mutation call, including retry and employee response, needs an in-function readOnly guard');

for (const item of calls) {
  const owner = source.slice(item.owner.start, item.owner.end);
  const mutated = owner.replace(/scheduleMutationAllowed\s*\([^)]*\)/, 'true');
  assert.notEqual(mutated, owner, `${item.name}: mutation setup did not remove a real guard`);
  const callAt = mutated.indexOf('call.' + item.name);
  assert.ok(callAt >= 0);
  assert.equal(/scheduleMutationAllowed\s*\(/.test(mutated.slice(0, callAt)), false,
    `${item.name}: removed guard must be caught`);
}

console.log('role-view schedule write source: PASS; ' + calls.length + ' write sites guarded');
