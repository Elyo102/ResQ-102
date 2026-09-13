'use strict';

const { createOpsMemberIdentity } = require('./ops-member-identity');
const OPEN_LIMIT = 24;
const OPEN_QUERY_LIMIT = OPEN_LIMIT + 1;
const OPEN_STATES = Object.freeze(['open','in_repair']);
const FAULT_ROLES = Object.freeze(['team_leader','deputy_team_leader','deputy','commander','station_commander','super_admin']);

function createHomeCommandCenter({ db, HttpsError, clock = Date.now }) {
  if (!db || typeof db.collection !== 'function' || typeof HttpsError !== 'function') throw new TypeError('db and HttpsError required');
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const root = sid => db.collection('stations').doc(sid);
  const clean = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

  async function live(ctx) {
    return db.runTransaction(tx => identity.requireLive(tx, ctx));
  }
  function fault(doc) {
    let value = null;
    try {
      value = doc && doc.exists !== false && typeof doc.data === 'function' ? doc.data() : null;
    } catch (_) {
      return null;
    }
    if (!value || !OPEN_STATES.includes(value.status)) return null;
    const title = clean(value.title, 160);
    if (!title) return null;
    const rawSeverity = clean(value.severity, 20);
    const severity = rawSeverity === 'critical' || rawSeverity === 'blocking' ? 'blocking'
      : rawSeverity === 'major' || rawSeverity === 'limiting' ? 'limiting'
      : rawSeverity === 'minor' ? 'minor' : 'unset';
    return Object.freeze({
      id:clean(doc.id, 120), title, severity,
      summary:clean(value.vehicle_name || value.subject || value.kind || 'תקלה פתוחה', 180),
      needs_grading:severity === 'unset'
    });
  }
  function tasksFor(ctx, total, partial, needsGrading) {
    if (!total || !FAULT_ROLES.includes(ctx.role)) return [];
    return [Object.freeze({
      id:'open-faults', kind:'faults',
      title:needsGrading ? needsGrading + ' תקלות ממתינות להערכת חומרה'
        : total === 1 ? 'תקלה פתוחה אחת לבדיקה' : (partial ? 'לפחות ' : '') + total + ' תקלות פתוחות לבדיקה',
      summary:needsGrading ? 'יש לקבוע חומרה לפני תחילת המשמרת.' : 'מומלץ לעבור עליהן לפני תחילת המשמרת.',
      target_roles:[ctx.role], priority:'high',
      action:Object.freeze({ type:'open_fault', id:'open-faults' })
    })];
  }
  async function get(req) {
    const ctx = identity.context(req);
    if (req.data !== undefined && (req.data === null || typeof req.data !== 'object' || Array.isArray(req.data) || Object.keys(req.data).length)) {
      throw new HttpsError('invalid-argument', 'המסך הראשי אינו מקבל שדות מהלקוח.');
    }
    const member = await live(ctx);
    const faults = root(ctx.sid).collection('faults');
    const query = faults.where('status', 'in', OPEN_STATES)
      .orderBy('created_key', 'desc').limit(OPEN_QUERY_LIMIT);
    const blockingOpenQuery = faults.where('status', '==', 'open')
      .where('severity', 'in', ['blocking','critical']).limit(1);
    const blockingRepairQuery = faults.where('status', '==', 'in_repair')
      .where('severity', 'in', ['blocking','critical']).limit(1);
    const [snapshot, blockingOpenSnapshot, blockingRepairSnapshot] = await Promise.all([
      query.get(), blockingOpenQuery.get(), blockingRepairQuery.get()
    ]);
    const docs = snapshot.docs || [];
    const rows = docs.slice(0, OPEN_LIMIT).map(fault).filter(Boolean);
    await live(ctx);
    const urgent = [...(blockingOpenSnapshot.docs || []), ...(blockingRepairSnapshot.docs || [])]
      .map(fault).filter(Boolean)[0] || null;
    const partial = docs.length > OPEN_LIMIT;
    const ungraded = rows.filter(row => row.severity === 'unset').length;
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new HttpsError('internal', 'שעון השרת אינו זמין.');
    return Object.freeze({
      revision:'home-command-v1', generated_at:new Date(now).toISOString(),
      identity:Object.freeze({ role:ctx.role, employee_number:member.employee_number || '' }),
      urgent:urgent ? Object.freeze({
        id:urgent.id, title:urgent.title, summary:urgent.summary, severity:'critical',
        action:Object.freeze({ type:'open_fault', id:urgent.id })
      }) : null,
      tasks:Object.freeze(tasksFor(ctx, rows.length, partial, ungraded)),
      shift:Object.freeze({ open_faults:rows.length, partial })
    });
  }
  return Object.freeze({ get });
}

module.exports = Object.freeze({ createHomeCommandCenter, OPEN_LIMIT });
