import { httpsCallable as rawHttpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
export { getFunctions } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

function captureFailure(name) {
  try {
    const detail = { name, onFailure: null };
    window.dispatchEvent(new CustomEvent('resq:callable-start', { detail }));
    return typeof detail.onFailure === 'function' ? detail.onFailure : null;
  } catch (ignore) { return null; }
}

function observe(callback, error) {
  try { if (callback) callback(error); } catch (ignore) {}
}

// Preserve factory options, receiver, arguments and callable properties.
// Only rejected business calls gain a bounded, non-blocking technical report.
export function httpsCallable(...factoryArgs) {
  const callable = Reflect.apply(rawHttpsCallable, this, factoryArgs);
  const name = factoryArgs[1];
  if (name === 'reportIncident') return callable;
  return new Proxy(callable, {
    apply(target, receiver, args) {
      const onFailure = captureFailure(name);
      let result;
      try { result = Reflect.apply(target, receiver, args); }
      catch (error) { observe(onFailure, error); throw error; }
      return result.then(value => value, error => {
        observe(onFailure, error);
        throw error;
      });
    }
  });
}
