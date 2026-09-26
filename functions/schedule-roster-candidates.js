'use strict';

// A manager-facing draft only. The signed source author remains the sole writer.
// Never infer scheduling roles or sub-stations from a name, crew or job title.
function buildRosterCandidates({ stationId, users, previous, policy, indexes }) {
  const subs = policy && policy.sub_stations || {};
  const rotationGroups = policy && policy.rotation && Array.isArray(policy.rotation.groups)
    ? policy.rotation.groups : [];
  const allowedRoles = new Set();
  Object.values(subs).forEach((sub) => {
    (Array.isArray(sub && sub.requirements) ? sub.requirements : []).forEach((item) => {
      if (item && typeof item.role === 'string') allowedRoles.add(item.role);
    });
  });
  const prior = new Map();
  (Array.isArray(previous) ? previous : []).forEach((person) => {
    if (!person || typeof person.id !== 'string' || prior.has(person.id)) {
      if (person && typeof person.id === 'string') prior.set(person.id, null);
      return;
    }
    prior.set(person.id, person);
  });
  const employeeCounts = new Map();
  (Array.isArray(users) ? users : []).forEach((user) => {
    const employee = String(user && user.employee_number || '').trim();
    if (employee) employeeCounts.set(employee, (employeeCounts.get(employee) || 0) + 1);
  });
  return (Array.isArray(users) ? users : []).map((user) => {
    const uid = String(user && user.uid || '');
    const employee = String(user && user.employee_number || '').trim();
    const name = String(user && user.full_name || '').trim();
    const index = indexes && indexes.get(employee);
    const identityValid = !!uid && !!employee && !!name
      && employeeCounts.get(employee) === 1 && index
      && index.uid === uid && index.stationId === stationId
      && index.active === true && index.retired !== true;
    const old = prior.get(uid);
    const sub = old && typeof old.sub_station === 'string' ? old.sub_station : '';
    const roles = old && Array.isArray(old.roles) ? old.roles : [];
    const group = old && typeof old.group === 'string' ? old.group : null;
    const assignmentValid = !!old && Object.prototype.hasOwnProperty.call(subs, sub)
      && roles.length > 0 && roles.every((role) => allowedRoles.has(role))
      && (!rotationGroups.length || rotationGroups.includes(group));
    const status = !identityValid ? 'identity_conflict'
      : assignmentValid ? 'carried_for_review' : 'needs_assignment';
    return {
      uid, employee_number: employee, full_name: name,
      sub_station: assignmentValid ? sub : '',
      roles: assignmentValid ? Array.from(new Set(roles)).sort() : [],
      active: old && typeof old.active === 'boolean' ? old.active : true,
      group: rotationGroups.length && !rotationGroups.includes(group) ? null : group,
      status
    };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name, 'he')
    || a.uid.localeCompare(b.uid));
}

module.exports = { buildRosterCandidates };
