// Dependency-injected lifecycle permits deterministic failure tests without launching Java.
export async function runOwnedLifecycle(io, mode = 'integration') {
  if (!['integration', 'startup-only'].includes(mode)) throw Error('OWNED_EMULATOR_MODE');
  let child = null, failure = null, result;
  try {
    await io.assertFree();
    child = await io.spawn();
    await io.awaitReady(child);
    if (mode === 'integration') {
      await io.activate(child);
      result = await io.runIntegration(child);
    }
  } catch (error) { failure = error; }
  const cleanupErrors = [];
  let stopped = !child, closed = !child;
  for (const [name, action] of [
    ['revoke', () => io.revoke()],
    ['stop', async () => { if (child) await io.stop(child); stopped = true; }],
    ['verifyClosed', async () => { if (child) await io.verifyClosed(child); closed = true; }],
    ['remove', () => { if (stopped && closed && cleanupErrors.length === 0) return io.remove(); }],
  ]) {
    try { await action(); } catch (error) { cleanupErrors.push(error); io.poison('owned-cleanup-' + name); }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'OWNED_EMULATOR_CLEANUP_FAILED');
  if (failure) throw failure;
  return result;
}

export function startupCapture(limit = 131072) {
  let retained = Buffer.alloc(0), endpoint = false, ready = false;
  return Object.freeze({
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      retained = Buffer.concat([retained, bytes.subarray(-limit)]).subarray(-limit);
      const text = retained.toString();
      endpoint ||= text.includes('http://127.0.0.1:8080');
      ready ||= text.includes('Dev App Server is now running.');
    },
    get ready() { return endpoint && ready; },
    get retainedBytes() { return retained.length; },
  });
}

export function interruptHandler({ revoke, abort, cancel, poison }) {
  let interrupted = false;
  return () => {
    if (interrupted) return;
    interrupted = true;
    try { revoke(); } catch (_) { poison('owned-interrupt-revoke'); }
    abort();
    try { cancel(); } catch (_) { poison('owned-interrupt-cancel'); }
  };
}
