import { APP_VERSION } from './version.js?v=42h25';

// התקנה על מסך הבית.
//
// שני עולמות, ורק אחד מהם משתף פעולה:
//
//   אנדרואיד   הדפדפן מציע להתקין בעצמו, ונותן לנו אירוע
//              שאפשר לתפוס ולהציג כפתור משלנו
//   אייפון     אין אירוע ואין ממשק. הדרך היחידה היא שהמשתמש
//              ילחץ שיתוף ← הוסף למסך הבית, ואם לא נגיד לו
//              את זה במפורש — הוא לא ימצא
//
// לכן זה לא "כפתור התקנה" אלא שני מסלולים שונים שנראים דומה.
//
// ולמה בכלל: כבאי לא יזכור כתובת. אייקון על המסך הוא ההבדל
// בין מערכת שנכנסים אליה לבין קישור ששולחים בוואטסאפ.

let deferred = null;
let updateCoordinator = null;
let updateReadyInfo = null;
const updateGuards = new Set();

export function registerPwaUpdateGuard(guard) {
  if (typeof guard !== 'function') throw new TypeError('update guard must be a function');
  updateGuards.add(guard);
  return function () { updateGuards.delete(guard); };
}

function updateBlockReason(documentLike) {
  const doc = documentLike || (typeof document !== 'undefined' ? document : null);
  if (doc && typeof doc.querySelectorAll === 'function') {
    const files = doc.querySelectorAll('input[type="file"]');
    for (const input of files) {
      if (input && input.files && input.files.length) return 'יש קובץ שנבחר ועדיין לא נשמר.';
    }
    if (doc.querySelector('[data-pwa-update-blocked="true"]')) {
      return 'יש פעולה או טיוטה שעדיין לא הסתיימה.';
    }
  }
  for (const guard of updateGuards) {
    let result;
    try { result = guard(); }
    catch (_) { return 'לא ניתן לוודא שהמסך מוכן לעדכון.'; }
    if (result === false) return 'יש פעולה או טיוטה שעדיין לא הסתיימה.';
    if (typeof result === 'string' && result.trim()) return result.trim();
    if (result && result.safe === false) {
      return String(result.reason || 'יש פעולה או טיוטה שעדיין לא הסתיימה.');
    }
  }
  return '';
}

export async function fetchLatestReleaseVersion(options) {
  const o = options || {};
  const fetchLike = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const now = typeof o.now === 'function' ? o.now : Date.now;
  if (!fetchLike) throw new Error('version-fetch-unavailable');
  const response = await fetchLike('./version.json?update_check=' + now(), { cache:'no-store' });
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    throw new Error('version-fetch-failed');
  }
  const body = await response.json();
  const version = body && typeof body.v === 'string' ? body.v.trim() : '';
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) {
    throw new Error('version-invalid');
  }
  return version;
}

export async function applyReadyUpdate(options) {
  const o = options || {};
  const blocked = updateBlockReason(o.document);
  if (blocked) return { updated:false, blocked, reason:'blocked' };
  let version;
  try {
    version = await fetchLatestReleaseVersion({ fetch:o.fetch, now:o.now });
  } catch (_) {
    return { updated:false, blocked:'', reason:'version-unavailable' };
  }
  const blockedAfterFetch = updateBlockReason(o.document);
  if (blockedAfterFetch) return { updated:false, blocked:blockedAfterFetch, reason:'blocked' };
  const runningVersion = String(o.runningVersion || APP_VERSION);
  if (version === runningVersion) {
    return { updated:false, blocked:'', reason:'version-not-advanced', version };
  }
  const refresh = typeof o.refresh === 'function' ? o.refresh : refreshInstalledApp;
  let result;
  try {
    result = await refresh(Object.assign({}, o.refreshOptions, {
      document:o.document,
      version,
      runningVersion,
      candidate:o.candidate || null,
      requireCandidate:true
    }));
  } catch (_) {
    return { updated:false, blocked:'', reason:'activation-failed', version };
  }
  const updated = !!(result && result.workerActivated === true && result.reloadDeferred !== true);
  return { updated, blocked:result && result.blocked ? result.blocked : '',
    reason:updated ? 'updated' : (result && result.reloadDeferred === true ? 'reload-deferred' : 'activation-failed'),
    version, result };
}

export function createPwaUpdateCoordinator(options) {
  const o = options || {};
  const serviceWorker = o.serviceWorker ||
    (typeof navigator !== 'undefined' ? navigator.serviceWorker : null);
  const windowLike = o.window || (typeof window !== 'undefined' ? window : null);
  const documentLike = o.document || (typeof document !== 'undefined' ? document : null);
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const interval = Number.isFinite(o.intervalMs) ? Math.max(1000, o.intervalMs) : 300000;
  const retry = Number.isFinite(o.retryMs) ? Math.max(1000, o.retryMs) : 30000;
  const onReady = typeof o.onReady === 'function' ? o.onReady : function () {};
  let registration = null;
  let started = false;
  let stopped = false;
  let hadController = Boolean(serviceWorker && serviceWorker.controller);
  let lastSuccess = -Infinity;
  let lastFailure = -Infinity;
  let inFlight = null;
  let watchedWorker = null;
  let lastReadyWorker = null;

  function ready(reason, worker) {
    if (stopped || !hadController || !registration) return;
    const candidate = worker || registration.waiting || watchedWorker || null;
    if (candidate && candidate === lastReadyWorker) return;
    lastReadyWorker = candidate;
    onReady({ reason, registration, worker:candidate });
  }
  function inspectWorker() {
    if (!watchedWorker) return;
    if (watchedWorker.state === 'installed') ready('installed', watchedWorker);
  }
  function watch(worker) {
    if (!worker || worker === watchedWorker) return;
    if (watchedWorker && watchedWorker.removeEventListener) {
      watchedWorker.removeEventListener('statechange', inspectWorker);
    }
    watchedWorker = worker;
    if (worker.addEventListener) worker.addEventListener('statechange', inspectWorker);
    inspectWorker();
  }
  function detect() {
    if (!registration) return;
    if (registration.waiting) ready('waiting', registration.waiting);
    watch(registration.installing);
  }
  function onUpdateFound() { detect(); }
  function onControllerChange() {
    if (hadController) {
      const candidate = watchedWorker && watchedWorker.state === 'activated'
        ? watchedWorker
        : (serviceWorker && serviceWorker.controller);
      ready('controllerchange', candidate);
    }
    else hadController = true;
  }
  async function check() {
    if (stopped || !registration || typeof registration.update !== 'function') return false;
    if (inFlight) return inFlight;
    const t = now();
    if (t - lastSuccess < interval || t - lastFailure < retry) return false;
    inFlight = Promise.resolve().then(() => registration.update()).then(function () {
      lastSuccess = now();
      detect();
      return true;
    }, function () {
      lastFailure = now();
      return false;
    }).finally(function () { inFlight = null; });
    return inFlight;
  }
  function onPageShow() { void check(); }
  function onVisibility() {
    if (!documentLike || documentLike.visibilityState === 'visible') void check();
  }
  function start(nextRegistration) {
    if (started || stopped) return api;
    registration = nextRegistration || null;
    started = true;
    if (!registration) return api;
    if (registration.addEventListener) registration.addEventListener('updatefound', onUpdateFound);
    if (serviceWorker && serviceWorker.addEventListener) {
      serviceWorker.addEventListener('controllerchange', onControllerChange);
    }
    if (windowLike && windowLike.addEventListener) windowLike.addEventListener('pageshow', onPageShow);
    if (documentLike && documentLike.addEventListener) {
      documentLike.addEventListener('visibilitychange', onVisibility);
    }
    detect();
    void check();
    return api;
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (registration && registration.removeEventListener) registration.removeEventListener('updatefound', onUpdateFound);
    if (serviceWorker && serviceWorker.removeEventListener) serviceWorker.removeEventListener('controllerchange', onControllerChange);
    if (windowLike && windowLike.removeEventListener) windowLike.removeEventListener('pageshow', onPageShow);
    if (documentLike && documentLike.removeEventListener) documentLike.removeEventListener('visibilitychange', onVisibility);
    if (watchedWorker && watchedWorker.removeEventListener) watchedWorker.removeEventListener('statechange', inspectWorker);
  }
  const api = Object.freeze({ start, stop, check });
  return api;
}

function updateOutcomeMessage(outcome) {
  if (outcome && outcome.blocked) {
    return outcome.blocked + ' שמור או סיים אותה ואז נסה שוב.';
  }
  return 'העדכון לא הושלם. אפשר לנסות שוב כשיש חיבור יציב.';
}

function showUpdateReady(info, message) {
  updateReadyInfo = info || updateReadyInfo;
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('pwaUpdateBar');
  if (existing) {
    const existingNote = existing.querySelector('.tx span');
    const existingButton = existing.querySelector('.go');
    if (existingNote && message) existingNote.textContent = message;
    if (existingButton) existingButton.disabled = false;
    return;
  }
  style();
  const bar = document.createElement('div');
  bar.id = 'pwaUpdateBar';
  bar.setAttribute('role', 'status');
  const text = document.createElement('div');
  text.className = 'tx';
  const title = document.createElement('b');
  title.textContent = 'גרסה חדשה של ResQ מוכנה';
  const note = document.createElement('span');
  note.textContent = message || 'אפשר לעדכן עכשיו בלי לאבד פעולה שלא נשמרה.';
  const button = document.createElement('button');
  button.className = 'go';
  button.type = 'button';
  button.textContent = 'עדכן עכשיו';
  text.append(title, note);
  bar.append(text, button);
  document.body.appendChild(bar);
  button.addEventListener('click', async function () {
    const blocked = updateBlockReason(document);
    if (blocked) {
      note.textContent = blocked + ' שמור או סיים אותה ואז נסה שוב.';
      return;
    }
    button.disabled = true;
    note.textContent = 'מעדכן את האפליקציה…';
    const outcome = await applyReadyUpdate({
      document,
      candidate:updateReadyInfo && updateReadyInfo.worker
    });
    if (!outcome.updated) {
      button.disabled = false;
      note.textContent = updateOutcomeMessage(outcome);
    }
  });
}

// עדכון מוכן מופעל אוטומטית רק כשהמסך נקי. אם יש קובץ, טיוטה
// או פעולה בתהליך, משאירים למשתמש כפתור מפורש במקום לרענן.
// Promise יחיד מונע מכמה אירועי updatefound/controllerchange להפעיל
// את אותו עדכון פעמיים.
export function applyDetectedUpdate(info, options) {
  const o = options || {};
  const documentLike = o.document || (typeof document !== 'undefined' ? document : null);
  const candidate = info && info.worker;
  if (!candidate) {
    return Promise.resolve({ updated:false, blocked:'', reason:'candidate-missing' });
  }
  const blocked = updateBlockReason(documentLike);
  if (blocked) {
    return Promise.resolve({ updated:false, blocked, reason:'blocked' });
  }
  return applyReadyUpdate({
    document:documentLike,
    candidate,
    fetch:o.fetch,
    now:o.now,
    runningVersion:o.runningVersion,
    refresh:o.refresh,
    refreshOptions:o.refreshOptions
  });
}

export function createUpdateReadyHandler(options) {
  const o = options || {};
  let inFlight = null;
  return function handleUpdateReady(info) {
    updateReadyInfo = info || updateReadyInfo;
    const documentLike = o.document || (typeof document !== 'undefined' ? document : null);
    const show = typeof o.show === 'function' ? o.show : showUpdateReady;
    const apply = typeof o.apply === 'function' ? o.apply : applyDetectedUpdate;
    const blocked = updateBlockReason(documentLike);
    if (!info || !info.worker || blocked) {
      const message = blocked
        ? blocked + ' שמור או סיים אותה ואז עדכן.'
        : 'העדכון מוכן להפעלה.';
      show(info, message);
      return Promise.resolve({ updated:false, blocked, reason:blocked ? 'blocked' : 'candidate-missing' });
    }
    if (inFlight) return inFlight;
    const operation = Promise.resolve().then(function () {
      return apply(info, {
        document:documentLike,
        fetch:o.fetch,
        now:o.now,
        runningVersion:o.runningVersion,
        refresh:o.refresh,
        refreshOptions:o.refreshOptions
      });
    }).then(function (outcome) {
      if (!outcome.updated && outcome.reason !== 'version-not-advanced') {
        show(info, updateOutcomeMessage(outcome));
      }
      return outcome;
    }).catch(function () {
      const outcome = { updated:false, blocked:'', reason:'activation-failed' };
      show(info, updateOutcomeMessage(outcome));
      return outcome;
    });
    const finalized = operation.finally(function () {
      if (inFlight === finalized) inFlight = null;
    });
    inFlight = finalized;
    return finalized;
  };
}

// A waiting worker may first be discovered while login, registration or another
// protected operation is active. The coordinator deliberately reports each
// candidate once, so the host page calls this after it reaches a stable view.
export function retryPendingPwaUpdate() {
  if (!updateReadyInfo || !updateReadyInfo.worker) {
    return Promise.resolve({ updated:false, blocked:'', reason:'candidate-missing' });
  }
  return handleUpdateReady(updateReadyInfo);
}

const handleUpdateReady = createUpdateReadyHandler();

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

export function isIOS() {
  const ua = String(navigator.userAgent || '');
  // אייפד מודרני מדווח על עצמו כמק. מגע הוא מה שמבדיל.
  return /iPhone|iPad|iPod/.test(ua) ||
         (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// רושם את ה-Service Worker. אותו עובד שמטפל בהתראות מטפל גם
// במטמון — דפדפן מרשה אחד לכל תחום.
export function registerSW() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('./firebase-messaging-sw.js', { updateViaCache: 'none' })
    .catch(function (e) {
      console.warn('SW registration: ' + (e && e.message));
      return null;
    });
}

// מבקש מעובד חדש להפוך לפעיל, אבל לא מחכה לנצח. ההאזנה
// נרשמת לפני ההודעה כדי שגם מעבר מצב מהיר לא ילך לאיבוד.
export function activateAvailableWorker(worker, serviceWorker, timeoutMs) {
  if (!worker || worker.state === 'activated') return Promise.resolve(true);
  const limit = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5000;

  return new Promise(function (resolve) {
    let done = false;
    let timer = null;

    function cleanup() {
      if (timer !== null) clearTimeout(timer);
      if (worker.removeEventListener) worker.removeEventListener('statechange', onState);
      if (serviceWorker && serviceWorker.removeEventListener) {
        serviceWorker.removeEventListener('controllerchange', onController);
      }
    }
    function finish(ok) {
      if (done) return;
      done = true;
      cleanup();
      resolve(Boolean(ok));
    }
    function onState() {
      if (worker.state === 'activated') finish(true);
      else if (worker.state === 'redundant') finish(false);
    }
    function onController() {
      // A different tab can activate a different worker. Ownership changes are
      // evidence only when this exact candidate reached activated.
      if (worker.state === 'activated') finish(true);
    }

    if (worker.addEventListener) worker.addEventListener('statechange', onState);
    if (serviceWorker && serviceWorker.addEventListener) {
      serviceWorker.addEventListener('controllerchange', onController);
    }
    timer = setTimeout(function () { finish(worker.state === 'activated'); }, limit);

    try { worker.postMessage({ type: 'RESQ_SKIP_WAITING' }); }
    catch (ignore) { finish(false); }
    onState();
  });
}

// רענון יזום מהפרופיל. ניקוי מטמוני ResQ שייך ל-Service Worker
// בלבד, בזמן activate. כך הדף לעולם אינו מוחק בטעות את המטמון
// של העובד החדש בגלל שם גרסה שאינו מסונכרן.
export async function refreshInstalledApp(options) {
  const o = options || {};
  const serviceWorker = o.serviceWorker ||
    (typeof navigator !== 'undefined' ? navigator.serviceWorker : null);
  const locationLike = o.location ||
    (typeof window !== 'undefined' ? window.location : null);
  const now = typeof o.now === 'function' ? o.now : Date.now;
  let workerActivated = false;

  if (o.candidate) {
    workerActivated = await activateAvailableWorker(
      o.candidate, serviceWorker, o.timeoutMs
    );
  }

  if (!o.candidate && serviceWorker && typeof serviceWorker.getRegistration === 'function') {
    let registration = null;
    try { registration = await serviceWorker.getRegistration(); }
    catch (ignore) { workerActivated = false; }

    if (registration) {
      let updateOk = true;
      try { await registration.update(); }
      catch (ignore) { updateOk = false; }
      const candidate = registration.waiting || registration.installing;
      if (candidate) {
        workerActivated = await activateAvailableWorker(
          candidate, serviceWorker, o.timeoutMs
        );
      } else if (!o.requireCandidate && updateOk && String(o.version || '') === String(o.runningVersion || '')) {
        workerActivated = true;
      }
    }
  }

  const blockedBeforeReload = workerActivated ? updateBlockReason(o.document) : '';
  const reloadDeferred = Boolean(workerActivated && blockedBeforeReload);
  if (workerActivated && !reloadDeferred && locationLike && typeof locationLike.replace === 'function') {
    const next = new URL(locationLike.href);
    next.searchParams.set('updated', String(o.version) + '-' + now());
    locationLike.replace(next.toString());
  }
  return {
    workerActivated,
    reloadDeferred,
    blocked:blockedBeforeReload,
    keptCache:null,
    deletedCaches:[],
    cacheCleanup:'service-worker-owned'
  };
}

// מציג שורת הזמנה להתקנה. מחזיר true אם הוצגה.
//
// לא מציג למי שכבר התקין, ולא למי שסגר את ההצעה — הצעה
// שחוזרת בכל כניסה היא הצעה שמכבים.
export function offerInstall(opts) {
  const o = opts || {};
  if (isStandalone()) return false;

  let dismissed = false;
  try { dismissed = localStorage.getItem('resq_install_off') === '1'; }
  catch (ignore) {}
  if (dismissed && !o.force) return false;

  const ios = isIOS();
  if (!ios && !deferred && !o.force) return false;   // אנדרואיד בלי אירוע

  const bar = document.createElement('div');
  bar.id = 'pwaBar';
  bar.innerHTML =
    '<div class="ic">📲</div>' +
    '<div class="tx">' +
      '<b>התקן את ResQ על מסך הבית</b>' +
      '<span>' + (ios
        ? 'לחץ על כפתור השיתוף למטה, ואז «הוסף למסך הבית».'
        : 'ייפתח כמו אפליקציה, בלי שורת כתובת.') + '</span>' +
    '</div>' +
    (ios ? '' : '<button class="go" id="pwaGo">התקן</button>') +
    '<button class="x" id="pwaX" aria-label="סגור">&times;</button>';

  style();
  document.body.appendChild(bar);

  const go = document.getElementById('pwaGo');
  if (go) {
    go.onclick = async function () {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (ignore) {}
      deferred = null;
      bar.remove();
    };
  }
  document.getElementById('pwaX').onclick = function () {
    try { localStorage.setItem('resq_install_off', '1'); } catch (ignore) {}
    bar.remove();
  };
  return true;
}

function style() {
  if (document.getElementById('pwaStyle')) return;
  const st = document.createElement('style');
  st.id = 'pwaStyle';
  st.textContent = [
    '#pwaBar,#pwaUpdateBar{position:fixed;inset-inline:12px;',
    '  bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9000;',
    '  display:flex;align-items:center;gap:12px;direction:rtl;',
    '  background:#1e2126;border:1px solid #2c3036;border-radius:13px;',
    '  padding:13px 15px;box-shadow:0 10px 34px rgba(0,0,0,.45);',
    '  font-family:"Segoe UI",Arial,sans-serif;max-width:520px;',
    '  margin-inline:auto}',
    '#pwaBar .ic{font-size:26px;flex:none;line-height:1}',
    '#pwaBar .tx,#pwaUpdateBar .tx{flex:1;min-width:0}',
    '#pwaBar .tx b,#pwaUpdateBar .tx b{display:block;color:#e8eaed;font-size:14.5px;',
    '  font-weight:700;margin-bottom:2px}',
    '#pwaBar .tx span,#pwaUpdateBar .tx span{display:block;color:#9aa0a6;font-size:12.5px;',
    '  line-height:1.6}',
    '#pwaBar .go,#pwaUpdateBar .go{flex:none;width:auto;margin:0;background:#e8590c;',
    '  border:1px solid #e8590c;color:#fff;border-radius:9px;',
    '  padding:10px 18px;font-family:inherit;font-size:14px;',
    '  font-weight:700;cursor:pointer;min-height:44px}',
    '#pwaUpdateBar .go:disabled{opacity:.62;cursor:wait}',
    '#pwaBar .x{flex:none;width:auto;margin:0;background:transparent;',
    '  border:0;color:#9aa0a6;font-size:22px;cursor:pointer;',
    '  padding:0 4px;line-height:1}',
    '#pwaBar .x:hover{color:#e8eaed}',
    '@media (max-width:420px){',
    '  #pwaBar,#pwaUpdateBar{gap:9px;padding:11px 12px}',
    '  #pwaBar .ic{font-size:21px}}'
  ].join('');
  document.head.appendChild(st);
}

// נקרא פעם אחת בכל מסך. תופס את אירוע ההתקנה של אנדרואיד
// לפני שהדפדפן מציג את ההצעה שלו, ורושם את העובד.
export function initPWA(opts) {
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
  });
  registerSW().then(function (registration) {
    if (!registration || updateCoordinator) return;
    updateCoordinator = createPwaUpdateCoordinator({ onReady:handleUpdateReady });
    updateCoordinator.start(registration);
  });

  // ההצעה מחכה לרגע שהמשתמש כבר בפנים. שורה שקופצת על מסך
  // הכניסה מפריעה למי שרק רוצה להתחבר.
  if (opts && opts.offer) {
    setTimeout(function () { offerInstall(); }, 2500);
  }
}
