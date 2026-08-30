'use strict';

// Pure, deterministic proposal engine for a station's static crew board.
//
// Safety boundary:
//   * no Firebase/Admin SDK, network, I/O or writes
//   * every product policy is explicit; unsupported or missing input blocks
//   * all three crew snapshots are required so global person limits stay global
//   * output contains operational IDs and reason codes only

const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const ALGORITHM_VERSION = 'static-board-mcmf-v1';
const TARGET_KIND = 'static_crew_board_v1';
const CREWS = Object.freeze(['A', 'B', 'C']);
const MEMBER_ROLE_IDS = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader', 'deputy',
  'commander', 'station_commander', 'hr_coordinator'
]);
const MAX_MEMBERS = 5000;
const MAX_SLOTS = 500;
const MAX_VEHICLES = 100;
const MAX_QUALIFICATIONS = 500;
const MAX_QUALIFICATIONS_PER_MEMBER = 64;
const MAX_QUALIFICATION_RELATIONS = 250000;
const MAX_CANDIDATE_EDGES = 250000;
const MAX_SLOTS_PER_PERSON = 20;
const MAX_PRIOR_LOAD = 100;
const MAX_ID_LENGTH = 128;
const VEHICLE_STATES = Object.freeze(['ok', 'minor', 'ungraded', 'limited', 'blocked']);
const FORBIDDEN_KEYS = Object.freeze([
  'name', 'full_name', 'fullname', 'email', 'phone', 'telephone', 'mobile',
  'display_name', 'first_name', 'last_name', 'by_name', 'address', 'national_id',
  'emp', 'emp_number', 'employee_number', 'notes', 'note', 'comment', 'comments'
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueSorted(values) {
  return Array.from(new Set(values || [])).sort(compareText);
}

function compareText(a, b) {
  const left = String(a), right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plainObject(value)) return value;
  const out = {};
  Object.keys(value).sort(compareText).forEach(function (key) {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
  });
  return out;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function normalizedInputForDigest(input) {
  const copy = JSON.parse(JSON.stringify(input));
  copy.target_crews = copy.target_crews.slice().sort(compareText);
  copy.sources.members.items = copy.sources.members.items.map(function (member) {
    member.qualification_ids = member.qualification_ids.slice().sort(compareText);
    return member;
  }).sort(function (a, b) { return compareText(a.uid, b.uid); });
  copy.sources.board.command_slots.sort(function (a, b) {
    return compareText(a.slot_id, b.slot_id);
  });
  copy.sources.board.vehicles = copy.sources.board.vehicles.map(function (vehicle) {
    vehicle.slots.sort(function (a, b) { return compareText(a.slot_id, b.slot_id); });
    return vehicle;
  }).sort(function (a, b) { return compareText(a.vehicle_id, b.vehicle_id); });
  copy.sources.qualifications.ids.sort(compareText);
  copy.sources.vehicle_statuses.items.sort(function (a, b) {
    return compareText(a.vehicle_id, b.vehicle_id);
  });
  Object.keys(copy.policies.allowed_roles_by_slot_id).forEach(function (slotId) {
    copy.policies.allowed_roles_by_slot_id[slotId].sort(compareText);
  });
  return copy;
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_ID_LENGTH && value === value.trim() &&
    !/[\/\u0000-\u001f\u007f]/.test(value);
}

function exactKeys(value, expected, errors) {
  if (!plainObject(value)) {
    errors.push('INVALID_OBJECT');
    return false;
  }
  const allowed = new Set(expected);
  expected.forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push('MISSING_REQUIRED_FIELD');
  });
  Object.keys(value).forEach(function (key) {
    if (!allowed.has(key)) errors.push('UNKNOWN_FIELD');
  });
  return true;
}

function privacyViolations(value, out) {
  const violations = out || [];
  if (Array.isArray(value)) {
    value.forEach(function (item) { privacyViolations(item, violations); });
    return violations;
  }
  if (!plainObject(value)) return violations;
  Object.keys(value).forEach(function (key) {
    if (FORBIDDEN_KEYS.indexOf(String(key).toLowerCase()) !== -1) violations.push(key);
    privacyViolations(value[key], violations);
  });
  return violations;
}

function validateEnvelope(envelope, stationId, contractStationId, errors) {
  if (!plainObject(envelope)) {
    errors.push('INVALID_SOURCE_ENVELOPE');
    return false;
  }
  ['station_id', 'contract_station_id', 'snapshot_id', 'source_revision', 'complete']
    .forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(envelope, key)) errors.push('MISSING_REQUIRED_FIELD');
    });
  if (envelope.station_id !== stationId || envelope.contract_station_id !== contractStationId) {
    errors.push('STATION_MISMATCH');
  }
  if (!validId(envelope.snapshot_id) || !validId(envelope.source_revision)) {
    errors.push('INVALID_SOURCE_REVISION');
  }
  if (envelope.complete !== true) errors.push('INCOMPLETE_SOURCE');
  return true;
}

function validateAssignmentMap(value, slotIds, memberByUid, errors) {
  if (!plainObject(value)) {
    errors.push('INVALID_ASSIGNMENT_MAP');
    return;
  }
  Object.keys(value).forEach(function (slotId) {
    const uid = value[slotId];
    if (!slotIds.has(slotId)) errors.push('UNKNOWN_SLOT_REFERENCE');
    if (!validId(uid) || !memberByUid.has(uid)) errors.push('UNKNOWN_MEMBER_REFERENCE');
    else if (memberByUid.get(uid).active !== true) errors.push('INACTIVE_MEMBER_REFERENCE');
  });
}

function validateInputUnsafe(input) {
  const errors = [];
  if (privacyViolations(input).length) errors.push('PII_FIELD_FORBIDDEN');
  if (!exactKeys(input, [
    'schema_version', 'algorithm_version', 'target_kind', 'station_id',
    'contract_station_id', 'target_crews', 'sources', 'policies'
  ], errors)) return { errors: uniqueSorted(errors) };

  if (input.schema_version !== SCHEMA_VERSION) errors.push('UNSUPPORTED_SCHEMA_VERSION');
  if (input.algorithm_version !== ALGORITHM_VERSION) errors.push('UNSUPPORTED_ALGORITHM_VERSION');
  if (input.target_kind !== TARGET_KIND) errors.push('UNSUPPORTED_TARGET_KIND');
  if (!validId(input.station_id) || !validId(input.contract_station_id)) {
    errors.push('INVALID_STATION_ID');
  } else if (input.station_id !== input.contract_station_id) errors.push('STATION_MISMATCH');

  if (!Array.isArray(input.target_crews) || !input.target_crews.length ||
      input.target_crews.some(function (crew) { return CREWS.indexOf(crew) === -1; }) ||
      uniqueSorted(input.target_crews).length !== input.target_crews.length) {
    errors.push('INVALID_TARGET_CREWS');
  }

  if (!exactKeys(input.sources, [
    'members', 'board', 'qualifications', 'current_assignments',
    'locked_assignments', 'vehicle_statuses'
  ], errors)) return { errors: uniqueSorted(errors) };

  const sources = input.sources;
  const sourceNames = Object.keys(sources);
  sourceNames.forEach(function (key) {
    validateEnvelope(sources[key], input.station_id, input.contract_station_id, errors);
  });
  if (sourceNames.every(function (key) { return plainObject(sources[key]); })) {
    const snapshotIds = uniqueSorted(sourceNames.map(function (key) {
      return sources[key].snapshot_id;
    }));
    if (snapshotIds.length !== 1) errors.push('SNAPSHOT_MISMATCH');
  }

  validateMembers(sources.members, input.station_id, errors);
  const boardModel = validateBoard(sources.board, errors);
  const qualificationIds = validateQualifications(sources.qualifications, errors);
  const memberModel = buildMemberModel(sources.members, qualificationIds, errors);
  boardModel.slots.forEach(function (slot) {
    if (slot.required_qualification_id && !qualificationIds.has(slot.required_qualification_id)) {
      errors.push('UNKNOWN_QUALIFICATION_REFERENCE');
    }
  });
  const slotIds = boardModel.slotIds;
  validateCrewMaps(sources.current_assignments, 'by_crew', slotIds, memberModel.byUid, errors);
  validateCrewMaps(sources.locked_assignments, 'by_crew', slotIds, memberModel.byUid, errors);
  validateLocks(sources.current_assignments, sources.locked_assignments, errors);
  const vehicleStates = validateVehicleStatuses(sources.vehicle_statuses, boardModel.vehicleIds, errors);
  const policyModel = validatePolicies(input.policies, slotIds, boardModel.slots, errors);

  if (memberModel.members.length > MAX_MEMBERS) errors.push('MEMBER_LIMIT_EXCEEDED');
  if (boardModel.slots.length > MAX_SLOTS) errors.push('SLOT_LIMIT_EXCEEDED');
  if (boardModel.vehicleIds.size > MAX_VEHICLES) errors.push('VEHICLE_LIMIT_EXCEEDED');
  if (qualificationIds.size > MAX_QUALIFICATIONS) errors.push('QUALIFICATION_LIMIT_EXCEEDED');
  if (memberModel.relationCount > MAX_QUALIFICATION_RELATIONS) {
    errors.push('QUALIFICATION_RELATION_LIMIT_EXCEEDED');
  }

  return {
    errors: uniqueSorted(errors),
    members: memberModel.members,
    memberByUid: memberModel.byUid,
    slots: boardModel.slots,
    slotById: boardModel.slotById,
    qualificationIds: qualificationIds,
    vehicleStates: vehicleStates,
    policies: policyModel
  };
}

function validateMembers(source, stationId, errors) {
  if (!exactKeys(source, [
    'station_id', 'contract_station_id', 'snapshot_id', 'source_revision', 'complete', 'items'
  ], errors)) return;
  if (!Array.isArray(source.items)) {
    errors.push('INVALID_MEMBERS');
    return;
  }
  const seen = new Set();
  source.items.forEach(function (member) {
    if (!exactKeys(member, [
      'uid', 'station_id', 'active', 'home_crew', 'role_id',
      'qualification_ids', 'prior_load'
    ], errors)) return;
    if (!validId(member.uid) || seen.has(member.uid)) errors.push('DUPLICATE_OR_INVALID_MEMBER_ID');
    seen.add(member.uid);
    if (member.station_id !== stationId) errors.push('STATION_MISMATCH');
    if (typeof member.active !== 'boolean') errors.push('INVALID_MEMBER_ACTIVE');
    if (CREWS.indexOf(member.home_crew) === -1) errors.push('INVALID_MEMBER_CREW');
    if (MEMBER_ROLE_IDS.indexOf(member.role_id) === -1) errors.push('INVALID_ROLE_ID');
    if (!Array.isArray(member.qualification_ids) ||
        member.qualification_ids.length > MAX_QUALIFICATIONS_PER_MEMBER ||
        member.qualification_ids.some(function (id) { return !validId(id); }) ||
        uniqueSorted(member.qualification_ids).length !== member.qualification_ids.length) {
      errors.push('INVALID_MEMBER_QUALIFICATIONS');
    }
    if (!Number.isInteger(member.prior_load) || member.prior_load < 0 ||
        member.prior_load > MAX_PRIOR_LOAD) errors.push('INVALID_PRIOR_LOAD');
  });
}

function buildMemberModel(source, qualificationIds, errors) {
  const members = Array.isArray(source.items) ? source.items.slice().sort(function (a, b) {
    return compareText(a.uid, b.uid);
  }) : [];
  const byUid = new Map();
  let relationCount = 0;
  members.forEach(function (member) {
    if (validId(member.uid) && !byUid.has(member.uid)) byUid.set(member.uid, member);
    const ids = Array.isArray(member.qualification_ids) ? member.qualification_ids : [];
    relationCount += ids.length;
    ids.forEach(function (id) {
      if (!qualificationIds.has(id)) errors.push('UNKNOWN_QUALIFICATION_REFERENCE');
    });
  });
  return { members: members, byUid: byUid, relationCount: relationCount };
}

function validateBoard(source, errors) {
  exactKeys(source, [
    'station_id', 'contract_station_id', 'snapshot_id', 'source_revision',
    'complete', 'command_slots', 'vehicles'
  ], errors);
  const slots = [], slotIds = new Set(), slotById = new Map(), vehicleIds = new Set();
  function addSlot(slot, vehicleId) {
    if (!exactKeys(slot, ['slot_id', 'required_qualification_id'], errors)) return;
    if (!validId(slot.slot_id) || slotIds.has(slot.slot_id)) errors.push('DUPLICATE_OR_INVALID_SLOT_ID');
    if (slot.required_qualification_id !== '' && !validId(slot.required_qualification_id)) {
      errors.push('INVALID_SLOT_QUALIFICATION');
    }
    slotIds.add(slot.slot_id);
    const normalized = {
      slot_id: slot.slot_id,
      required_qualification_id: slot.required_qualification_id,
      vehicle_id: vehicleId || ''
    };
    slots.push(normalized);
    slotById.set(slot.slot_id, normalized);
  }
  if (!Array.isArray(source.command_slots)) errors.push('INVALID_COMMAND_SLOTS');
  else source.command_slots.forEach(function (slot) { addSlot(slot, ''); });
  if (!Array.isArray(source.vehicles)) errors.push('INVALID_VEHICLES');
  else source.vehicles.forEach(function (vehicle) {
    if (!exactKeys(vehicle, ['vehicle_id', 'slots'], errors)) return;
    if (!validId(vehicle.vehicle_id) || vehicleIds.has(vehicle.vehicle_id)) {
      errors.push('DUPLICATE_OR_INVALID_VEHICLE_ID');
    }
    vehicleIds.add(vehicle.vehicle_id);
    if (!Array.isArray(vehicle.slots)) errors.push('INVALID_VEHICLE_SLOTS');
    else vehicle.slots.forEach(function (slot) { addSlot(slot, vehicle.vehicle_id); });
  });
  slots.sort(function (a, b) { return compareText(a.slot_id, b.slot_id); });
  return { slots: slots, slotIds: slotIds, slotById: slotById, vehicleIds: vehicleIds };
}

function validateQualifications(source, errors) {
  exactKeys(source, [
    'station_id', 'contract_station_id', 'snapshot_id', 'source_revision', 'complete', 'ids'
  ], errors);
  if (!Array.isArray(source.ids) || source.ids.some(function (id) { return !validId(id); }) ||
      uniqueSorted(source.ids).length !== source.ids.length) {
    errors.push('DUPLICATE_OR_INVALID_QUALIFICATION_ID');
    return new Set();
  }
  return new Set(source.ids);
}

function validateCrewMaps(source, field, slotIds, memberByUid, errors) {
  exactKeys(source, [
    'station_id', 'contract_station_id', 'snapshot_id', 'source_revision', 'complete', field
  ], errors);
  const byCrew = source[field];
  if (!exactKeys(byCrew, CREWS, errors)) {
    errors.push('MISSING_CREW_SNAPSHOT');
    return;
  }
  CREWS.forEach(function (crew) {
    validateAssignmentMap(byCrew[crew], slotIds, memberByUid, errors);
  });
}

function validateLocks(currentSource, lockSource, errors) {
  if (!plainObject(currentSource.by_crew) || !plainObject(lockSource.by_crew)) return;
  CREWS.forEach(function (crew) {
    const current = currentSource.by_crew[crew] || {};
    const locks = lockSource.by_crew[crew] || {};
    Object.keys(locks).forEach(function (slotId) {
      if (current[slotId] !== locks[slotId]) errors.push('LOCK_DOES_NOT_MATCH_CURRENT');
    });
  });
}

function validateVehicleStatuses(source, vehicleIds, errors) {
  exactKeys(source, [
    'station_id', 'contract_station_id', 'snapshot_id', 'source_revision', 'complete', 'items'
  ], errors);
  const states = new Map(), seen = new Set();
  if (!Array.isArray(source.items)) {
    errors.push('INVALID_VEHICLE_STATUSES');
    return states;
  }
  source.items.forEach(function (item) {
    if (!exactKeys(item, ['vehicle_id', 'state'], errors)) return;
    if (!vehicleIds.has(item.vehicle_id)) errors.push('UNKNOWN_VEHICLE_REFERENCE');
    if (seen.has(item.vehicle_id)) errors.push('DUPLICATE_VEHICLE_STATUS');
    if (VEHICLE_STATES.indexOf(item.state) === -1) errors.push('INVALID_VEHICLE_STATE');
    seen.add(item.vehicle_id);
    states.set(item.vehicle_id, item.state);
  });
  vehicleIds.forEach(function (id) {
    if (!seen.has(id)) errors.push('MISSING_VEHICLE_STATUS');
  });
  return states;
}

function validatePolicies(policies, slotIds, slots, errors) {
  const required = [
    'multi_slot_policy', 'cross_crew_policy', 'qualification_policy', 'rest_policy',
    'vehicle_fault_policy', 'redline_policy', 'allowed_roles_by_slot_id',
    'preservation_policy', 'objective_order', 'tie_break_policy', 'authorization_policy'
  ];
  if (!exactKeys(policies, required, errors)) return {};
  if (required.some(function (key) {
    return !Object.prototype.hasOwnProperty.call(policies, key);
  })) return {};

  exactKeys(policies.multi_slot_policy, ['mode', 'max_slots_per_person'], errors);
  if (policies.multi_slot_policy.mode !== 'limit' ||
      !Number.isInteger(policies.multi_slot_policy.max_slots_per_person) ||
      policies.multi_slot_policy.max_slots_per_person < 1 ||
      policies.multi_slot_policy.max_slots_per_person > MAX_SLOTS_PER_PERSON) {
    errors.push('UNSUPPORTED_MULTI_SLOT_POLICY');
  }

  exactKeys(policies.cross_crew_policy, ['mode', 'allow_without_rest_evaluation'], errors);
  if (['deny', 'allow'].indexOf(policies.cross_crew_policy.mode) === -1 ||
      typeof policies.cross_crew_policy.allow_without_rest_evaluation !== 'boolean' ||
      (policies.cross_crew_policy.mode === 'allow' &&
       policies.cross_crew_policy.allow_without_rest_evaluation !== true)) {
    errors.push('UNSUPPORTED_CROSS_CREW_POLICY');
  }

  exactKeys(policies.qualification_policy, ['mode'], errors);
  if (['hard', 'warning'].indexOf(policies.qualification_policy.mode) === -1) {
    errors.push('UNSUPPORTED_QUALIFICATION_POLICY');
  }
  exactKeys(policies.rest_policy, ['mode'], errors);
  if (policies.rest_policy.mode !== 'not_applicable_static_board') {
    errors.push('UNSUPPORTED_REST_POLICY');
  }
  exactKeys(policies.redline_policy, ['mode'], errors);
  if (policies.redline_policy.mode !== 'information_only') errors.push('UNSUPPORTED_REDLINE_POLICY');

  exactKeys(policies.vehicle_fault_policy, ['states'], errors);
  if (!exactKeys(policies.vehicle_fault_policy.states, VEHICLE_STATES, errors)) {
    errors.push('INVALID_VEHICLE_FAULT_POLICY');
  } else VEHICLE_STATES.forEach(function (state) {
    if (['include', 'exclude'].indexOf(policies.vehicle_fault_policy.states[state]) === -1) {
      errors.push('INVALID_VEHICLE_FAULT_POLICY');
    }
  });

  if (!plainObject(policies.allowed_roles_by_slot_id)) errors.push('INVALID_ROLE_POLICY');
  else {
    const roleKeys = Object.keys(policies.allowed_roles_by_slot_id);
    if (roleKeys.length !== slotIds.size || roleKeys.some(function (id) { return !slotIds.has(id); })) {
      errors.push('INCOMPLETE_ROLE_POLICY');
    }
    roleKeys.forEach(function (slotId) {
      const roles = policies.allowed_roles_by_slot_id[slotId];
      if (!Array.isArray(roles) || roles.some(function (role) {
        return MEMBER_ROLE_IDS.indexOf(role) === -1;
      }) ||
          uniqueSorted(roles).length !== roles.length) errors.push('INVALID_ROLE_POLICY');
    });
  }

  exactKeys(policies.preservation_policy, ['mode'], errors);
  if (['minimize_changes', 'replace_all'].indexOf(policies.preservation_policy.mode) === -1) {
    errors.push('UNSUPPORTED_PRESERVATION_POLICY');
  }

  const expectedObjectives = [
    'maximize_hard_constraint_fill', 'minimize_changes',
    'minimize_cross_crew', 'balance_load'
  ];
  if (!Array.isArray(policies.objective_order) || policies.objective_order.length !== 4 ||
      policies.objective_order[0] !== expectedObjectives[0] ||
      uniqueSorted(policies.objective_order).length !== 4 ||
      policies.objective_order.some(function (item) { return expectedObjectives.indexOf(item) === -1; })) {
    errors.push('UNSUPPORTED_OBJECTIVE_ORDER');
  }
  if (policies.tie_break_policy !== 'slot_id_then_uid') errors.push('UNSUPPORTED_TIE_BREAK_POLICY');

  if (exactKeys(policies.authorization_policy, [
    'preview_permission', 'approve_permission', 'apply_permission'
  ], errors)) {
    if (policies.authorization_policy.preview_permission !== 'mayPreview' ||
        policies.authorization_policy.approve_permission !== 'mayApprove' ||
        policies.authorization_policy.apply_permission !== 'mayApply') {
      errors.push('UNSUPPORTED_AUTHORIZATION_CONTRACT');
    }
  }

  slots.forEach(function (slot) {
    if (slot.required_qualification_id && !validId(slot.required_qualification_id)) {
      errors.push('INVALID_SLOT_QUALIFICATION');
    }
  });
  return policies;
}

function validateInput(input) {
  try {
    return validateInputUnsafe(input);
  } catch (_error) {
    return { errors: ['INVALID_INPUT'] };
  }
}

function edgeEligibility(member, crew, slot, policies, vehicleStates) {
  const reasons = [];
  if (member.active !== true) return { eligible: false, reasons: ['INACTIVE_MEMBER'] };
  const crossCrew = member.home_crew !== crew;
  if (crossCrew && policies.cross_crew_policy.mode === 'deny') reasons.push('CROSS_CREW_FORBIDDEN');
  const allowedRoles = policies.allowed_roles_by_slot_id[slot.slot_id] || [];
  if (allowedRoles.length && allowedRoles.indexOf(member.role_id) === -1) {
    reasons.push('ROLE_NOT_ALLOWED');
  }
  const hasQualification = !slot.required_qualification_id ||
    member.qualification_ids.indexOf(slot.required_qualification_id) !== -1;
  if (!hasQualification && policies.qualification_policy.mode === 'hard') {
    reasons.push('QUALIFICATION_MISSING');
  }
  if (slot.vehicle_id) {
    const state = vehicleStates.get(slot.vehicle_id);
    if (policies.vehicle_fault_policy.states[state] === 'exclude') reasons.push('VEHICLE_EXCLUDED');
  }
  return {
    eligible: reasons.length === 0,
    reasons: reasons,
    warning: !hasQualification && policies.qualification_policy.mode === 'warning'
      ? 'QUALIFICATION_MISSING_WARNING' : '',
    crossCrew: crossCrew
  };
}

function objectiveWeights(order, slotCount) {
  const maxima = { minimize_changes: 1, minimize_cross_crew: 1, balance_load: 120 };
  const objectives = order.slice(1);
  const weights = {};
  let lowerMaximum = 0;
  for (let index = objectives.length - 1; index >= 0; index--) {
    const objective = objectives[index];
    weights[objective] = lowerMaximum + 1;
    lowerMaximum += slotCount * maxima[objective] * weights[objective];
  }
  return weights;
}

function addEdge(graph, from, to, capacity, cost, meta) {
  const forward = { to: to, rev: graph[to].length, capacity: capacity, cost: cost, meta: meta || null };
  const reverse = { to: from, rev: graph[from].length, capacity: 0, cost: -cost, meta: null };
  graph[from].push(forward);
  graph[to].push(reverse);
}

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heapCompare(this.items[parent], item) <= 0) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    if (!this.items.length) return null;
    const first = this.items[0], last = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        if (left >= this.items.length) break;
        let child = left;
        if (right < this.items.length && heapCompare(this.items[right], this.items[left]) < 0) child = right;
        if (heapCompare(this.items[child], last) >= 0) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function heapCompare(a, b) {
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.node - b.node;
}

function minCostMaximumMatching(slotRecords, members, capacities, baseLoads, candidates, costs) {
  const slotCount = slotRecords.length, memberCount = members.length;
  const source = 0, slotOffset = 1, memberOffset = slotOffset + slotCount;
  const sink = memberOffset + memberCount, graph = Array.from({ length: sink + 1 }, function () { return []; });
  const memberIndex = new Map();
  members.forEach(function (member, index) { memberIndex.set(member.uid, index); });
  slotRecords.forEach(function (record, index) {
    addEdge(graph, source, slotOffset + index, 1, 0);
    (candidates.get(record.key) || []).forEach(function (candidate) {
      const personNode = memberOffset + memberIndex.get(candidate.uid);
      addEdge(graph, slotOffset + index, personNode, 1, candidate.cost, {
        kind: 'assignment', key: record.key, uid: candidate.uid,
        warning: candidate.warning || '',
        reason_codes: candidate.reason_codes.slice()
      });
    });
  });
  members.forEach(function (member, index) {
    const capacity = capacities.get(member.uid) || 0;
    const base = baseLoads.get(member.uid) || 0;
    for (let unit = 0; unit < capacity; unit++) {
      addEdge(graph, memberOffset + index, sink, 1,
        (base + unit) * costs.balance_load);
    }
  });

  const potential = Array(graph.length).fill(0);
  let flow = 0;
  while (true) {
    const distance = Array(graph.length).fill(Infinity);
    const previousNode = Array(graph.length).fill(-1);
    const previousEdge = Array(graph.length).fill(-1);
    const heap = new MinHeap();
    distance[source] = 0;
    heap.push({ node: source, distance: 0 });
    while (heap.items.length) {
      const current = heap.pop();
      if (current.distance !== distance[current.node]) continue;
      graph[current.node].forEach(function (edge, edgeIndex) {
        if (edge.capacity <= 0) return;
        const nextDistance = current.distance + edge.cost +
          potential[current.node] - potential[edge.to];
        // Strict improvement only. Replacing a predecessor on equal distance can
        // create a zero-cost predecessor cycle in the residual graph.
        // Determinism comes from canonical node/edge construction and heap order.
        if (nextDistance < distance[edge.to]) {
          distance[edge.to] = nextDistance;
          previousNode[edge.to] = current.node;
          previousEdge[edge.to] = edgeIndex;
          heap.push({ node: edge.to, distance: nextDistance });
        }
      });
    }
    if (!Number.isFinite(distance[sink])) break;
    for (let node = 0; node < graph.length; node++) {
      if (Number.isFinite(distance[node])) potential[node] += distance[node];
    }
    let node = sink;
    while (node !== source) {
      const parent = previousNode[node], edgeIndex = previousEdge[node];
      const edge = graph[parent][edgeIndex];
      edge.capacity -= 1;
      graph[node][edge.rev].capacity += 1;
      node = parent;
    }
    flow++;
  }

  const matched = new Map();
  slotRecords.forEach(function (record, index) {
    graph[slotOffset + index].forEach(function (edge) {
      if (edge.meta && edge.meta.kind === 'assignment' && edge.capacity === 0) {
        matched.set(record.key, {
          uid: edge.meta.uid,
          warning: edge.meta.warning,
          reason_codes: edge.meta.reason_codes.slice()
        });
      }
    });
  });
  return { flow: flow, matched: matched };
}

function planStaticBoard(input) {
  const model = validateInput(input);
  if (model.errors.length) return { state: 'blocked', reason_codes: model.errors };
  const frozenInputDigest = digest(normalizedInputForDigest(input));

  const policies = model.policies;
  const targetCrews = uniqueSorted(input.target_crews);
  const targetSet = new Set(targetCrews);
  const currentByCrew = input.sources.current_assignments.by_crew;
  const lockedByCrew = input.sources.locked_assignments.by_crew;
  const maxSlots = policies.multi_slot_policy.max_slots_per_person;
  const used = new Map(), baseLoads = new Map(), lockedResult = new Map();
  model.members.forEach(function (member) {
    used.set(member.uid, 0);
    baseLoads.set(member.uid, member.prior_load);
  });

  CREWS.forEach(function (crew) {
    const assignments = currentByCrew[crew];
    Object.keys(assignments).sort(compareText).forEach(function (slotId) {
      if (!targetSet.has(crew)) used.set(assignments[slotId], (used.get(assignments[slotId]) || 0) + 1);
    });
  });

  const lockErrors = [];
  targetCrews.forEach(function (crew) {
    const locks = lockedByCrew[crew];
    Object.keys(locks).sort(compareText).forEach(function (slotId) {
      const uid = locks[slotId], member = model.memberByUid.get(uid), slot = model.slotById.get(slotId);
      const check = edgeEligibility(member, crew, slot, policies, model.vehicleStates);
      if (!check.eligible || check.warning) lockErrors.push('LOCKED_ASSIGNMENT_INVALID');
      const key = crew + '|' + slotId;
      lockedResult.set(key, {
        uid: uid,
        warning: '',
        reason_codes: ['LOCKED_ASSIGNMENT_PRESERVED']
      });
      used.set(uid, (used.get(uid) || 0) + 1);
    });
  });
  used.forEach(function (count) {
    if (count > maxSlots) lockErrors.push('FIXED_ASSIGNMENTS_EXCEED_PERSON_LIMIT');
  });
  if (lockErrors.length) return { state: 'blocked', reason_codes: uniqueSorted(lockErrors) };

  const slotsToPlan = [];
  targetCrews.forEach(function (crew) {
    model.slots.forEach(function (slot) {
      const key = crew + '|' + slot.slot_id;
      if (!lockedResult.has(key)) slotsToPlan.push({ key: key, crew: crew, slot: slot });
    });
  });
  slotsToPlan.sort(function (a, b) { return compareText(a.key, b.key); });
  const weights = objectiveWeights(policies.objective_order, slotsToPlan.length);
  const candidates = new Map();
  const candidateDiagnostics = new Map();
  let candidateEdgeCount = 0;
  for (let recordIndex = 0; recordIndex < slotsToPlan.length; recordIndex++) {
    const record = slotsToPlan[recordIndex];
    const list = [];
    const rejectionCounts = new Map();
    let activeMemberCount = 0;
    for (let memberIndex = 0; memberIndex < model.members.length; memberIndex++) {
      const member = model.members[memberIndex];
      if (member.active !== true) continue;
      activeMemberCount++;
      const eligibility = edgeEligibility(member, record.crew, record.slot, policies, model.vehicleStates);
      if (!eligibility.eligible) {
        eligibility.reasons.forEach(function (reason) {
          rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + 1);
        });
        continue;
      }
      const currentUid = currentByCrew[record.crew][record.slot.slot_id] || '';
      const change = policies.preservation_policy.mode === 'minimize_changes' && currentUid !== member.uid ? 1 : 0;
      const cost = change * weights.minimize_changes +
        (eligibility.crossCrew ? 1 : 0) * weights.minimize_cross_crew;
      candidateEdgeCount++;
      if (candidateEdgeCount > MAX_CANDIDATE_EDGES) {
        return { state: 'blocked', reason_codes: ['CANDIDATE_EDGE_LIMIT_EXCEEDED'] };
      }
      const selectionReasons = [];
      if (currentUid === member.uid && policies.preservation_policy.mode === 'minimize_changes') {
        selectionReasons.push('CURRENT_ASSIGNMENT_PRESERVED');
      } else {
        selectionReasons.push('SELECTED_BY_DETERMINISTIC_OBJECTIVE');
      }
      selectionReasons.push(eligibility.crossCrew ? 'CROSS_CREW_ASSIGNMENT' : 'HOME_CREW_ASSIGNMENT');
      list.push({
        uid: member.uid,
        cost: cost,
        warning: eligibility.warning,
        reason_codes: selectionReasons
      });
    }
    list.sort(function (a, b) {
      return a.cost - b.cost || compareText(a.uid, b.uid);
    });
    candidates.set(record.key, list);
    candidateDiagnostics.set(record.key, {
      active_member_count: activeMemberCount,
      rejection_counts: rejectionCounts
    });
  }

  const capacities = new Map();
  model.members.forEach(function (member) {
    capacities.set(member.uid, Math.max(0, maxSlots - (used.get(member.uid) || 0)));
    baseLoads.set(member.uid, member.prior_load + (used.get(member.uid) || 0));
  });
  const matching = minCostMaximumMatching(
    slotsToPlan, model.members.filter(function (member) { return member.active === true; }),
    capacities, baseLoads, candidates, weights
  );

  const assignmentsByCrew = {};
  CREWS.forEach(function (crew) {
    assignmentsByCrew[crew] = targetSet.has(crew) ? {} : canonicalize(currentByCrew[crew]);
  });
  lockedResult.forEach(function (value, key) {
    const parts = key.split('|');
    assignmentsByCrew[parts[0]][parts[1]] = value.uid;
  });
  matching.matched.forEach(function (value, key) {
    const parts = key.split('|');
    assignmentsByCrew[parts[0]][parts[1]] = value.uid;
  });

  const unfilled = [], warnings = [];
  slotsToPlan.forEach(function (record) {
    const match = matching.matched.get(record.key);
    if (!match) {
      const eligibleCandidates = candidates.get(record.key) || [];
      const diagnostics = candidateDiagnostics.get(record.key);
      const rejectionReasons = [];
      if (diagnostics) diagnostics.rejection_counts.forEach(function (count, reasonCode) {
        rejectionReasons.push({ reason_code: reasonCode, count: count });
      });
      rejectionReasons.sort(function (a, b) { return compareText(a.reason_code, b.reason_code); });
      unfilled.push({
        crew: record.crew,
        slot_id: record.slot.slot_id,
        reason_code: eligibleCandidates.length
          ? 'PERSON_CAPACITY_EXHAUSTED'
          : diagnostics && diagnostics.active_member_count === 0
            ? 'NO_ACTIVE_MEMBER'
            : 'NO_ELIGIBLE_CANDIDATE',
        eligible_candidate_count: eligibleCandidates.length,
        rejection_reasons: rejectionReasons
      });
    }
    else if (match.warning) warnings.push({
      crew: record.crew, slot_id: record.slot.slot_id, uid: match.uid,
      reason_code: match.warning
    });
  });

  const assignmentExplanations = [];
  lockedResult.forEach(function (value, key) {
    const parts = key.split('|');
    assignmentExplanations.push({
      crew: parts[0], slot_id: parts[1], uid: value.uid,
      reason_codes: value.reason_codes.slice()
    });
  });
  matching.matched.forEach(function (value, key) {
    const parts = key.split('|');
    assignmentExplanations.push({
      crew: parts[0], slot_id: parts[1], uid: value.uid,
      reason_codes: value.reason_codes.slice()
    });
  });
  assignmentExplanations.sort(function (a, b) {
    return compareText(a.crew + '|' + a.slot_id + '|' + a.uid,
      b.crew + '|' + b.slot_id + '|' + b.uid);
  });

  const changes = [];
  targetCrews.forEach(function (crew) {
    model.slots.forEach(function (slot) {
      const before = currentByCrew[crew][slot.slot_id] || '';
      const after = assignmentsByCrew[crew][slot.slot_id] || '';
      if (before !== after) changes.push({
        crew: crew, slot_id: slot.slot_id, from_uid: before, to_uid: after
      });
    });
  });
  changes.sort(function (a, b) {
    return compareText(a.crew + '|' + a.slot_id, b.crew + '|' + b.slot_id);
  });
  unfilled.sort(function (a, b) {
    return compareText(a.crew + '|' + a.slot_id, b.crew + '|' + b.slot_id);
  });
  warnings.sort(function (a, b) {
    return compareText(a.crew + '|' + a.slot_id + '|' + a.uid,
      b.crew + '|' + b.slot_id + '|' + b.uid);
  });

  const proposal = {
    state: 'proposal',
    schema_version: SCHEMA_VERSION,
    algorithm_version: ALGORITHM_VERSION,
    target_kind: TARGET_KIND,
    station_id: input.station_id,
    target_crews: targetCrews,
    source_digest: frozenInputDigest,
    applicable: unfilled.length === 0 && warnings.length === 0,
    assignments_by_crew: canonicalize(assignmentsByCrew),
    assignment_explanations: assignmentExplanations,
    changes: changes,
    unfilled_slots: unfilled,
    warnings: warnings,
    reason_codes: uniqueSorted([
      'REST_NOT_EVALUATED_STATIC_BOARD',
      'REDLINE_INFORMATION_ONLY'
    ].concat(unfilled.length ? ['PROPOSAL_INCOMPLETE'] : [])
      .concat(warnings.length ? ['PROPOSAL_HAS_WARNINGS'] : []))
  };
  proposal.proposal_digest = digest(proposal);
  return proposal;
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  ALGORITHM_VERSION: ALGORITHM_VERSION,
  TARGET_KIND: TARGET_KIND,
  CREWS: CREWS,
  MEMBER_ROLE_IDS: MEMBER_ROLE_IDS,
  LIMITS: Object.freeze({
    members: MAX_MEMBERS,
    slots: MAX_SLOTS,
    vehicles: MAX_VEHICLES,
    qualifications: MAX_QUALIFICATIONS,
    qualifications_per_member: MAX_QUALIFICATIONS_PER_MEMBER,
    qualification_relations: MAX_QUALIFICATION_RELATIONS,
    candidate_edges: MAX_CANDIDATE_EDGES,
    slots_per_person: MAX_SLOTS_PER_PERSON
  }),
  canonicalStringify: canonicalStringify,
  digest: digest,
  privacyViolations: privacyViolations,
  validateInput: validateInput,
  planStaticBoard: planStaticBoard
};
