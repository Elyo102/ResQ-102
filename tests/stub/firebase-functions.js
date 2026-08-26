export function getFunctions(){ return {}; }

// קריאות שרת נשלטות בידי בדיקת הדפדפן. ברירת המחדל מצליחה,
// ואפשר להזריק מערך תוצאות/שגיאות דרך window.__CALLABLE_PLAN.
// כל ניסיון נשמר, כולל requestId, כדי לבדוק retry idempotent
// ומניעת שליחה כפולה בלי להתחבר לשרת אמיתי.
export function httpsCallable(_functions, name){
  if (typeof window !== 'undefined') {
    window.__CALLABLE_FACTORIES = window.__CALLABLE_FACTORIES || [];
    window.__CALLABLE_FACTORIES.push(name);
  }
  return payload => {
    if (typeof window !== 'undefined') {
      window.__CALLABLE_CALLS = window.__CALLABLE_CALLS || [];
      window.__CALLABLE_CALLS.push({ name, payload });
      window.__CALLABLE_INFLIGHT = (window.__CALLABLE_INFLIGHT || 0) + 1;
      window.__CALLABLE_MAX_INFLIGHT = Math.max(
        window.__CALLABLE_MAX_INFLIGHT || 0,
        window.__CALLABLE_INFLIGHT
      );
    }

    const plans = (typeof window !== 'undefined' && window.__CALLABLE_PLAN) || {};
    const list = Array.isArray(plans[name]) ? plans[name] : [];
    const step = list.length ? list.shift() : { data:{ ok:true, id:'stub-message' } };
    const delay = Number(step && step.delay) || 0;

    return new Promise((resolve, reject) => setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.__CALLABLE_INFLIGHT = Math.max(0, (window.__CALLABLE_INFLIGHT || 1) - 1);
      }
      if (step && step.reject) {
        reject({ code:step.code || 'functions/unavailable', message:step.message || 'stub failure' });
        return;
      }
      resolve({ data:(step && step.data) || { ok:true, id:'stub-message' } });
    }, delay));
  };
}
