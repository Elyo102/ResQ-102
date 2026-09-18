// Display-only role preview for the super administrator.
// Presentation values from this module are never authorization claims.

export const ROLE_VIEW_OPTIONS = Object.freeze([
  Object.freeze({ id: 'actual', label: 'התצוגה שלי (מנהל־על)' }),
  Object.freeze({ id: 'firefighter', label: 'כבאי' }),
  Object.freeze({ id: 'deputy', label: 'סגן מפקד משמרת' }),
  Object.freeze({ id: 'commander', label: 'מפקד משמרת' }),
  Object.freeze({ id: 'hr_coordinator', label: 'משאבי אנוש' })
]);

const BY_ID = new Map(ROLE_VIEW_OPTIONS.map(option => [option.id, option]));
function boundedText(value, max) {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  return clean && clean.length <= max ? clean : '';
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalAuthorityValue(value, state, depth = 0) {
  state.entries += 1;
  if (state.entries > 512 || depth > 32) throw new Error('role-view-claims-too-complex');
  if (value == null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (state.seen.has(value)) throw new Error('role-view-claims-cycle');
    state.seen.add(value);
    const out = value.map(item => canonicalAuthorityValue(item, state, depth + 1));
    state.seen.delete(value);
    return ['array', out];
  }
  if (type === 'object') {
    if (state.seen.has(value)) throw new Error('role-view-claims-cycle');
    state.seen.add(value);
    const out = Object.keys(value).sort().map(key =>
      [key, canonicalAuthorityValue(value[key], state, depth + 1)]
    );
    state.seen.delete(value);
    return ['object', out];
  }
  return '[' + type + ']';
}

export function roleViewClaimsEpoch(claims) {
  const source = claims && typeof claims === 'object' ? claims : {};
  const keys = [
    'super','personal_lab_control','role','roles','admin','permissions',
    'stationId','station_id','districtId','district_id','shift','emp',
    'email','email_verified'
  ];
  try {
    const state = { entries:0, seen:new WeakSet() };
    const epoch = 'rv1:' + JSON.stringify(
      keys.map(key => [key, canonicalAuthorityValue(source[key], state)])
    );
    return epoch.length <= 4096 ? epoch : '';
  } catch (_) { return ''; }
}

function actualView() {
  return Object.freeze({
    selected: 'actual',
    preview: false,
    presentation: null,
    storageRecord: null
  });
}

function presentationFor(selected) {
  const option = BY_ID.get(selected);
  return Object.freeze({ kind: 'role_view', role_id: selected, label: option.label });
}

export function assertPresentationOnly(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(',') !== 'kind,label,role_id') return false;
  if (value.kind !== 'role_view' || !BY_ID.has(value.role_id) || value.role_id === 'actual') return false;
  if (value.label !== BY_ID.get(value.role_id).label) return false;
  return true;
}

export function parseRoleViewStorage(raw) {
  if (raw == null || raw === '') return null;
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch (_) { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ownerUid = boundedText(value.owner_uid, 128);
  const authTime = nonNegativeInteger(value.auth_time);
  const claimsEpoch = boundedText(value.claims_epoch, 4096);
  const selected = boundedText(value.selected, 40);
  if (!ownerUid || authTime === null || !claimsEpoch ||
      selected === 'actual' || !BY_ID.has(selected)) return null;
  return Object.freeze({
    owner_uid: ownerUid,
    auth_time: authTime,
    claims_epoch: claimsEpoch,
    selected
  });
}

export function resolveRoleView(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const claims = input.claims && typeof input.claims === 'object' ? input.claims : {};
  if (claims.super !== true) return actualView();
  const uid = boundedText(input.uid, 128);
  const authTime = nonNegativeInteger(claims.auth_time);
  const claimsEpoch = roleViewClaimsEpoch(claims);
  if (!uid || authTime === null || !claimsEpoch) return actualView();

  const requested = input.requested == null ? '' : boundedText(input.requested, 40);
  let selected = requested;
  if (!selected) {
    const stored = parseRoleViewStorage(input.stored);
    if (!stored || stored.owner_uid !== uid ||
        stored.auth_time !== authTime || stored.claims_epoch !== claimsEpoch) return actualView();
    selected = stored.selected;
  }
  if (selected === 'actual' || !BY_ID.has(selected)) return actualView();
  const presentation = presentationFor(selected);
  if (!assertPresentationOnly(presentation)) return actualView();
  return Object.freeze({
    selected,
    preview: true,
    presentation,
    storageRecord: Object.freeze({
      owner_uid: uid,
      auth_time: authTime,
      claims_epoch: claimsEpoch,
      selected
    })
  });
}

export function roleViewLabel(selected) {
  return BY_ID.get(boundedText(selected, 40))?.label || ROLE_VIEW_OPTIONS[0].label;
}
