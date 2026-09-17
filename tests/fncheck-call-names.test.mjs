import assert from 'node:assert/strict';
import { collectCallNames } from './fncheck-call-names.mjs';

assert.deepEqual([...collectCallNames(`
  const state = {
    async assignmentState({ uid }) {},
    async linkState({ uid }) {}
  };
  state.assignmentState({});
`)], [], 'object method definitions and member calls are not free calls');

assert.deepEqual([...collectCallNames('missingCall();')], ['missingCall'],
  'unknown free calls remain candidates');

assert.deepEqual([...collectCallNames(`
  const state = { async assignmentState() {} };
  assignmentState();
`)], ['assignmentState'], 'a method cannot hide a same-named free call');

assert.deepEqual([...collectCallNames('new MissingConstructor();')], ['MissingConstructor'],
  'unknown constructors remain candidates');

assert.deepEqual([...collectCallNames(`
  const text = 'fakeCall()'; // anotherFakeCall()
  const state = { async method() { nestedMissing(); } };
`)], ['nestedMissing'], 'nested calls survive while text and comments are ignored');

assert.throws(() => collectCallNames('const broken = ;'), SyntaxError,
  'invalid syntax fails closed');
