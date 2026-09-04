// Only finite technical categories leave the browser. Error text, stack,
// frames, URLs and request bodies are deliberately neither read nor sent.
// The server independently enforces its matching telemetry contract.
export const TELEMETRY_KINDS = Object.freeze([
  'client-error', 'unhandled-rejection', 'callable-failed', 'manual'
]);
export const TELEMETRY_SCREENS = Object.freeze([
  'unknown', 'access.html', 'admin.html', 'alerts.html', 'attendance-shadow.html',
  'attendance.html', 'board.html', 'check.html', 'faults.html', 'feedback.html',
  'forms.html', 'guards.html', 'import.html', 'index.html', 'login.html',
  'people.html', 'quals.html', 'schedule-management.html', 'schedule.html',
  'sign.html', 'stats.html', 'swaps.html', 'unlock.html', 'vehicle.html'
]);
export const TELEMETRY_VERSIONS = Object.freeze(['unknown', '42G.0']);
export const TELEMETRY_CODES = Object.freeze([
  'unknown', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
  'URIError', 'EvalError', 'AggregateError',
  ...['cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded',
    'not-found', 'already-exists', 'permission-denied', 'resource-exhausted',
    'failed-precondition', 'aborted', 'out-of-range', 'unimplemented', 'internal',
    'unavailable', 'data-loss', 'unauthenticated'].map(code => 'functions/' + code)
]);
// Explicit public onCall names only; never accept a free-form action label.
export const TELEMETRY_CALLABLES = Object.freeze([
  'unknown',
  'approveRegistration', 'assignGuard', 'backupToSheetNow',
  'bootstrapSuperAdmin', 'broadcastBulletinMessage', 'bulkImport',
  'cancelStationTransfer', 'checkTestMail', 'claimPushToken',
  'closeCallout', 'createStationTransfer', 'decideStationTransfer',
  'getAttendanceShadowStatus', 'getEffectiveWorkdays', 'getGuardLoadStatistics', 'getJoinCode',
  'getLegacyScheduleCompatibilityContext', 'getMyGuardAttendance', 'getMyScheduleV2',
  'getScheduleDraftPreview', 'getScheduleGuardBoard', 'getScheduleGuardManagerBoard',
  'getScheduleManagerAccess', 'getScheduleManagerSetup', 'getScheduleModeOptions',
  'getScheduleRuntimeStatus', 'getSilentMode', 'getStationScheduleRange',
  'getStationScheduleV2', 'guardSignup', 'hideBulletinMessage',
  'hideBulletinReply', 'joinWithCode', 'listStationTransfers',
  'listUsersWithClaims', 'loginWithEmployeeNumber', 'manageScheduleGuard',
  'postBulletinMessage', 'previewScheduleCutover', 'previewSchedulePolicy',
  'previewScheduleSource', 'promoteScheduleToNew', 'publishSchedule', 'reindexDirectory',
  'rejectRegistration', 'replyToBulletinMessage', 'reportIncident',
  'requestPasswordReset', 'respondToSchedule', 'resumeIdentityOperation',
  'rollbackSchedule', 'runAttendanceShadowNow', 'runReportNow',
  'runSchedulePlanner', 'saveSchedulePolicy', 'saveScheduleSource',
  'searchStationTransferCandidates', 'sendBroadcast', 'sendCallout',
  'sendTestMail', 'setAttendanceShadowMode', 'setJoinCode',
  'setScheduleManagerAccess', 'setScheduleRuntimeMode', 'setSilentMode',
  'setUserRole', 'submitFeedback', 'unlockAccount',
  'whoAmI'
]);

function allowed(value, values, fallback = 'unknown') {
  return typeof value === 'string' && values.includes(value) ? value : fallback;
}

export function screenName(href) {
  const source = typeof href === 'string' ? href
    : (typeof location !== 'undefined' ? location.pathname : '');
  const pathname = source.split(/[?#]/, 1)[0];
  return allowed(pathname.split('/').pop(), TELEMETRY_SCREENS);
}

export function buildReport(kind, error, context) {
  const ctx = context || {};
  const err = error && typeof error === 'object' ? error : {};
  return Object.freeze({
    kind: allowed(kind, TELEMETRY_KINDS, 'manual'),
    screen: screenName(ctx.href),
    version: allowed(ctx.version, TELEMETRY_VERSIONS),
    code: allowed(err.code, TELEMETRY_CODES, allowed(err.name, TELEMETRY_CODES)),
    callable: allowed(ctx.callable, TELEMETRY_CALLABLES)
  });
}

export function createIncidentReporter(options) {
  const o = options || {};
  const callable = typeof o.report === 'function' ? o.report : null;
  const cap = Number(o.maxPerLoad);
  const maxPerLoad = Number.isInteger(cap) ? Math.min(10, Math.max(0, cap)) : 10;
  const seen = new Set();
  let sent = 0;
  let installed = false;

  async function send(kind, error, context, owner) {
    // Even a hostile Error getter must not create another rejection or
    // replace the application's original exception.
    try {
      if (!callable) return false;
      const permit = typeof o.authorize === 'function' ? await o.authorize(owner) : true;
      if (!permit) return false;
      const body = buildReport(kind, error, Object.assign({ version: o.version }, context || {}));
      if (body.code === 'functions/unauthenticated') return false;
      const key = JSON.stringify(body);
      if (seen.has(key) || sent >= maxPerLoad) return false;
      seen.add(key);
      sent += 1;
      await callable(body, permit);
      return true;
    } catch (ignore) {
      return false;
    }
  }

  function install(target) {
    const win = target || (typeof window !== 'undefined' ? window : null);
    if (!win || installed) return;
    installed = true;
    win.addEventListener('error', event => {
      void send('client-error', event && event.error, {});
    });
    win.addEventListener('unhandledrejection', event => {
      void send('unhandled-rejection', event && event.reason, {});
    });
  }

  function wrapCallable(name, fn) {
    return async function wrapped(data) {
      try {
        return await fn(data);
      } catch (error) {
        void send('callable-failed', error, { callable: name });
        throw error;
      }
    };
  }

  return Object.freeze({
    install, wrapCallable,
    callableFailure: (name, error, owner) => send('callable-failed', error, { callable: name }, owner),
    report: (error, context) => send('manual', error, context || {}),
    stats: () => ({ sent, seen: seen.size, maxPerLoad })
  });
}

export function installIncidentReporter(options) {
  const o = options || {};
  const report = o.fns && typeof o.httpsCallable === 'function'
    ? o.httpsCallable(o.fns, 'reportIncident') : null;
  const reporter = createIncidentReporter({
    report: report ? body => report(body) : null,
    version: o.version, maxPerLoad: o.maxPerLoad
  });
  reporter.install(o.window);
  return reporter;
}
