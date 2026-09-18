// 42H.20 §8.1 · HR 265-hour visibility — informational only.
//
// Renders the KPI tile count and a small always-visible alert list on the
// HR workforce screen, driven only by the server's `getHrOverHoursAlert`
// callable (which itself reads a single pre-aggregated report document —
// see functions/hr-hours-service.js). No approve/reject action exists here
// by design: this component never calls back to the server, it only reads.

const disconnected = { currentSession: () => null, subscribeIdentity: () => () => {} };

function sessionKey(adapter) {
  try {
    const s = adapter.currentSession();
    return s && (s.super === true || s.role === 'hr_coordinator')
      ? JSON.stringify([s.uid, s.stationId, s.role, s.super === true, s.epoch]) : null;
  } catch (_) { return null; }
}

function validResponse(value) {
  return value && typeof value === 'object'
    && (value.month === null || typeof value.month === 'string')
    && (value.hour_limit === null || (typeof value.hour_limit === 'number' && Number.isFinite(value.hour_limit)))
    && Array.isArray(value.over_employees) && value.over_employees.length <= 200
    && value.over_employees.every(e => e && typeof e === 'object'
      && typeof e.uid === 'string' && typeof e.employee_number === 'string'
      && typeof e.full_name === 'string' && !!e.full_name
      && typeof e.total_hours === 'number' && Number.isFinite(e.total_hours));
}

export function createHrOverHoursAlertUI(root, adapter = disconnected) {
  const q = key => root.querySelector(`[data-oh="${key}"]`);
  let owner = null, generation = 0, disposed = false;
  const alive = (g, key) => !disposed && g === generation && key === owner && key === sessionKey(adapter);

  function render(data) {
    q('count').textContent = data ? String(data.over_employees.length) : '—';
    const box = q('alert');
    if (!data || data.over_employees.length === 0) {
      box.hidden = true; q('list').replaceChildren(); return;
    }
    box.hidden = false;
    const limit = data.hour_limit ?? 265;
    q('meta').textContent = `דוח ${data.month || ''} · סף ${limit} שעות · לידיעה ומעקב בלבד — אינו חוסם סידור, פרסום או אישור.`;
    const list = q('list'); list.replaceChildren();
    for (const e of data.over_employees) {
      const li = document.createElement('li');
      li.textContent = `${e.full_name}${e.employee_number ? ' · מספר עובד ' + e.employee_number : ''} — ${e.total_hours} שעות`;
      list.append(li);
    }
  }

  async function load() {
    if (!owner) return;
    const g = generation, key = owner;
    try {
      const out = await adapter.overHoursAlert();
      if (!alive(g, key)) return;
      if (!validResponse(out)) throw Error('invalid response');
      render(out);
    } catch (_) {
      if (alive(g, key)) render(null);
    }
  }

  const unsubscribe = adapter.subscribeIdentity(() => {
    const next = sessionKey(adapter); if (next === owner) return;
    owner = next; ++generation; render(null);
    if (owner) void load();
  });
  owner = sessionKey(adapter); render(null);
  if (owner) void load();
  return { destroy() { disposed = true; ++generation; unsubscribe(); } };
}
