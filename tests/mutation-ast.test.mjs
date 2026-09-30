import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMutation, applyAstMutation, describeSelectedMutation, semanticNodes } from './lib/mutation-ast.mjs';
import { parse } from 'acorn';
const original = 'function first(){return {value:true}} function other(){return {value:true}}';
const modified = 'function first(){return {value:false}} function other(){return {value:true}}';
const descriptor = describeMutation(original, modified);
test('AST descriptor changes exactly the intended function property', () => assert.equal(applyAstMutation(original, descriptor), modified));
test('comments and strings cannot satisfy a missing selector', () => {
  assert.throws(() => applyAstMutation('// '+original+'\nconst s='+JSON.stringify(original), descriptor), /SELECTOR_CARDINALITY/);
});
test('zero matches, duplicate semantic scopes and wrong scope fail closed', () => {
  for (const source of ['function first(){return {value:0}}', original.replace('first', 'wrong'),
    'function outer(){function first(){return {value:true}}} function outer2(){function first(){return {value:true}}}'])
    assert.throws(() => applyAstMutation(source, descriptor), /SELECTOR_CARDINALITY/);
});
test('two identical selectors fail rather than choosing first', () => {
  const source = 'function first(){return [{value:true},{value:true}]}';
  assert.throws(() => applyAstMutation(source, descriptor), /SELECTOR_CARDINALITY/);
});
test('syntax errors, no-op and multi-node edits are invalid mutants', () => {
  assert.throws(() => applyAstMutation(original, { ...descriptor, replacementText: ']' }), SyntaxError);
  assert.throws(() => describeMutation(original, original), /CHANGE_COUNT/);
  assert.throws(() => describeMutation(original, original.replaceAll('true', 'false')), /CHANGE_COUNT/);
});
test('replacement AST mismatch fails even when output is parseable', () => {
  assert.throws(() => applyAstMutation(original, { ...descriptor, replacementText: 'null' }), /EXPECTED_AST_CHANGE/);
});
test('statement removal preserves unrelated bytes and Windows line endings', () => {
  const before = 'function first(){\r\n  check();\r\n  keep();\r\n}', after = before.replace('check();', '');
  assert.equal(applyAstMutation(before, describeMutation(before, after)), after);
});
test('one statement insertion is anchored uniquely and changes no sibling AST', () => {
  const before = 'function run(){const changes=read();use(changes);}';
  const node = semanticNodes(parse(before, { ecmaVersion: 'latest' })).find(row => row.node.type === 'VariableDeclaration').node;
  const descriptor = describeSelectedMutation(before, node, 'if(!allowed)return;\n', 'insert-before');
  assert.equal(applyAstMutation(before, descriptor), before.replace('const changes', 'if(!allowed)return;\nconst changes'));
  assert.throws(() => applyAstMutation(before, { ...descriptor, replacementText: 'if(!allowed)return;extra();' }), /EXPECTED_AST_CHANGE/);
});
test('whole-program and function selectors are rejected', () => {
  const source = 'function run(){return true}';
  const node = semanticNodes(parse(source, { ecmaVersion: 'latest' })).find(row => row.node.type === 'FunctionDeclaration').node;
  assert.throws(() => describeSelectedMutation(source, node, 'function run(){return false}'), /BROAD_SELECTOR/);
});
