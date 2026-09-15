import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function firebaseToolsModule(relative) {
  const suffix = path.join('firebase-tools', 'lib', ...relative.split('/'));
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', suffix),
    process.env.RESQ_FIREBASE_TOOLS_ROOT && path.join(process.env.RESQ_FIREBASE_TOOLS_ROOT, 'lib', ...relative.split('/')),
    path.join('/usr/local/lib/node_modules', suffix),
    path.join('/usr/lib/node_modules', suffix)
  ].filter(Boolean);
  const target = candidates.find((candidate) => fs.existsSync(candidate));
  if (!target) throw new Error('firebase-tools module is unavailable; install the pinned CLI globally');
  return require(target);
}

async function authenticateFirebaseTools(project) {
  const auth = firebaseToolsModule('auth.js');
  const authGate = firebaseToolsModule('requireAuth.js');
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI has no signed-in account');
  const options = { project };
  auth.setActiveAccount(options, account);
  await authGate.requireAuth(options);
}

export function indexSignature(index) {
  const name = String(index?.name || '');
  const match = name.match(/\/collectionGroups\/([^/]+)\/indexes\//);
  const collectionGroup = String(index?.collectionGroup || (match && match[1]) || '');
  const fields = Array.isArray(index?.fields) ? index.fields
    .filter((field) => field?.fieldPath !== '__name__').map((field) => {
      if (field.arrayConfig) return `${field.fieldPath}:ARRAY_CONTAINS`;
      if (field.order) return `${field.fieldPath}:${field.order}`;
      return `${field.fieldPath}:UNKNOWN`;
    }) : [];
  return `${collectionGroup}|${String(index?.queryScope || '')}|${fields.join(',')}`;
}

export function evaluateRequiredIndexes(indexes, requiredSignatures) {
  assert.ok(Array.isArray(indexes), 'raw index response must be an array');
  const required = [...new Set(requiredSignatures.map(String))];
  const matching = indexes.filter((index) => required.includes(indexSignature(index)));
  for (const index of matching) {
    if (typeof index.state !== 'string' || !index.state) {
      throw new Error('required index state is missing: ' + indexSignature(index));
    }
    if (['ERROR', 'NEEDS_REPAIR'].includes(index.state)) {
      throw new Error('required index failed: ' + indexSignature(index) + ':' + index.state);
    }
  }
  const bySignature = new Map(matching.map((index) => [indexSignature(index), index]));
  const missing = required.filter((signature) => !bySignature.has(signature));
  const pending = matching.filter((index) => index.state !== 'READY')
    .map((index) => indexSignature(index) + ':' + index.state);
  return Object.freeze({ ready:missing.length === 0 && pending.length === 0, missing, pending });
}

export async function waitForRequiredIndexes(options) {
  const now = options.now || Date.now;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  while (true) {
    const result = evaluateRequiredIndexes(await options.listIndexes(), options.requiredSignatures);
    if (result.ready) return result;
    if (now() >= deadline) {
      throw new Error('required indexes not READY before deadline: ' + JSON.stringify(result));
    }
    await wait(Math.min(options.pollMs, Math.max(1, deadline - now())));
  }
}

export function assertNoActiveFunctionRollout(result) {
  if (!result || !Array.isArray(result.functions) || !Array.isArray(result.unreachable)) {
    throw new Error('raw Cloud Functions response is malformed');
  }
  if (result.unreachable.length) throw new Error('Cloud Functions regions are unreachable');
  const missing = result.functions.filter((fn) => typeof fn.state !== 'string' || !fn.state);
  if (missing.length) throw new Error('Cloud Function state is missing');
  const busy = result.functions.filter((fn) => fn.state !== 'ACTIVE');
  if (busy.length) throw new Error('Cloud Function rollout is active: '
    + busy.map((fn) => `${fn.name}:${fn.state}`).join(','));
  return Object.freeze({ active:result.functions.length });
}

async function main(argv) {
  const [mode, project, timeoutRaw, pollRaw, ...signatures] = argv;
  if (!project) throw new Error('usage: firebase-release-state.mjs <indexes|functions> <project> ...');
  if (mode === 'indexes') {
    if (!signatures.length) throw new Error('at least one required index signature is required');
    await authenticateFirebaseTools(project);
    const { FirestoreApi } = firebaseToolsModule('firestore/api.js');
    const api = new FirestoreApi();
    const result = await waitForRequiredIndexes({
      listIndexes:() => api.listIndexes(project, '(default)'),
      requiredSignatures:signatures,
      timeoutMs:Number(timeoutRaw), pollMs:Number(pollRaw)
    });
    console.log('Required Firestore indexes READY ' + JSON.stringify(result));
    return;
  }
  if (mode === 'functions') {
    await authenticateFirebaseTools(project);
    const cloudFunctionsV2 = firebaseToolsModule('gcp/cloudfunctionsv2.js');
    console.log('Cloud Functions rollout preflight PASS '
      + JSON.stringify(assertNoActiveFunctionRollout(await cloudFunctionsV2.listAllFunctions(project))));
    return;
  }
  throw new Error('unknown release-state mode: ' + mode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
