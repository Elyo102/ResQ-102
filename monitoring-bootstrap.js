// Shared, best-effort telemetry only. No business request waits for this module.
import { createIncidentReporter } from './incident-client.js?v=42h3';
import { MEMBER_ROLES } from './roles.js?v=42h3';
import { APP_VERSION } from './version.js?v=42h3';

let reporter = null;
let auth = null;
let appContext = null;
let functionsSDK = null;
let rawReport = null;

function sameUser(permit) {
  return !!permit && !!auth && auth.currentUser === permit.user;
}

function operationalClaims(claims) {
  return !!claims && (claims.super === true || MEMBER_ROLES.includes(claims.role))
    && typeof claims.stationId === 'string'
    && /^[A-Za-z0-9_-]{2,120}$/.test(claims.stationId);
}

async function authorize(owner) {
  // Capture before the first await: never retain an anonymous error until a
  // different person signs in, and never reuse stale claims across an event.
  const user = owner ? owner.user : (auth && auth.currentUser);
  if (!user || typeof user.getIdTokenResult !== 'function') return false;
  if (!auth || auth.currentUser !== user) return false;
  const token = owner ? await owner.token : await user.getIdTokenResult();
  const claims = token && token.claims;
  if (!auth || auth.currentUser !== user || !operationalClaims(claims)) return false;
  const superUser = claims.super === true;
  return {
    user,
    stationId: claims.stationId,
    role: superUser ? 'super_admin' : claims.role,
    super: superUser
  };
}

async function report(body, permit) {
  if (!sameUser(permit)) return false;
  if (!functionsSDK) {
    functionsSDK = import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js')
      .catch(error => { functionsSDK = null; throw error; });
  }
  const sdk = await functionsSDK;
  if (!sameUser(permit)) return false;
  const latest = await permit.user.getIdTokenResult();
  const claims = latest && latest.claims;
  if (!sameUser(permit) || !operationalClaims(claims)
      || claims.stationId !== permit.stationId
      || (claims.super === true) !== permit.super
      || (!permit.super && claims.role !== permit.role)) return false;
  if (!rawReport) rawReport = sdk.httpsCallable(sdk.getFunctions(appContext, 'europe-west1'), 'reportIncident');
  // The raw SDK call is deliberately outside the monitored facade. The
  // server performs the authoritative live-membership transaction check.
  return rawReport(body);
}

export function startMonitoring(app) {
  if (!app || reporter) return;
  appContext = app;
  reporter = createIncidentReporter({ report, authorize, version: APP_VERSION, maxPerLoad: 10 });
  reporter.install();
  if (typeof window !== 'undefined') window.addEventListener('resq:callable-start', event => {
    try {
      const detail = event && event.detail;
      const user = auth && auth.currentUser;
      if (!detail || typeof detail.name !== 'string' || !user
          || typeof user.getIdTokenResult !== 'function') return;
      const owner = { user, token: Promise.resolve(user.getIdTokenResult()).catch(() => null) };
      const name = detail.name;
      detail.onFailure = error => {
        if (auth && auth.currentUser === user) void reporter.callableFailure(name, error, owner);
      };
    } catch (ignore) {}
  });
  // SDK authentication is loaded in the background. Until it is available,
  // authorize() drops events rather than queueing them for a future account.
  void import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')
    .then(sdk => { auth = sdk.getAuth(appContext); })
    .catch(() => {});
}
