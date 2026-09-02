export function getFunctions(){ return {}; }

function defaultCallableStep(name){
  if (name === 'getLegacyScheduleCompatibilityContext') {
    return { data:{
      mode:'shadow',
      rotations:[
        { crew:'A', position_in_cycle:0, cycle_days:3,
          anchor_date:'2026-01-01', is_active:true,
          shift_start:'07:00', shift_end:'07:00', shift_hours:24 },
        { crew:'B', position_in_cycle:1, cycle_days:3,
          anchor_date:'2026-01-01', is_active:true },
        { crew:'C', position_in_cycle:2, cycle_days:3,
          anchor_date:'2026-01-01', is_active:true }
      ],
      overrides:{
        '2026-08-14':{ date:'2026-08-14', kind:'swap', crew:'A', extra_crews:[] },
        '2026-08-20':{ date:'2026-08-20', kind:'training', crew:'', extra_crews:[] },
        '2026-08-25':{ date:'2026-08-25', kind:'standby', crew:'', extra_crews:['B'] }
      }
    } };
  }
  return { data:{ ok:true, id:'stub-message' } };
}

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
    const step = list.length ? list.shift() : defaultCallableStep(name);
    const delay = Number(step && step.delay) || 0;

    return new Promise((resolve, reject) => setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.__CALLABLE_INFLIGHT = Math.max(0, (window.__CALLABLE_INFLIGHT || 1) - 1);
      }
      if (step && step.reject) {
        reject({ code:step.code || 'functions/unavailable', message:step.message || 'stub failure' });
        return;
      }
      resolve({ data:(step && step.data) || defaultCallableStep(name).data });
    }, delay));
  };
}
