// Pure decision used by the schedule screen before a PWA update may reload it.
// It never mutates state: a pending request remains the owner's recovery proof.
function hasValues(value) {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length);
}

function hasText(doc, id) {
  if (!doc || typeof doc.getElementById !== 'function') return false;
  const input = doc.getElementById(id);
  return Boolean(input && String(input.value || '').trim());
}

function hasChecked(doc, id) {
  if (!doc || typeof doc.getElementById !== 'function') return false;
  const input = doc.getElementById(id);
  return Boolean(input && input.checked);
}

export function scheduleUpdateBlockReason(state, doc) {
  const s = state || {};
  if (s.busy || s.policyBusy || s.sourceBusy || s.modeBusy) return 'schedule-operation';
  if (s.plannerPending || s.rollbackPending || s.importPending || s.editPending ||
      s.pendingCutover || s.displayPending || s.publishRequestId || hasValues(s.intentRequestIds)) {
    return 'schedule-retry-proof';
  }
  if (s.importSelectedFile || s.importMatrix || s.importedDraft || s.importReport ||
      s.importStationMap || hasText(doc, 'importPaste')) return 'schedule-import';
  if (s.draft || s.draftPreview || s.previewStart || hasChecked(doc, 'reviewDraft')
      || hasChecked(doc, 'draftGapAck')) {
    return 'schedule-draft';
  }
  if (s.policyDirty || s.sourceDirty || s.sourcePlan) return 'schedule-settings';
  if ((Array.isArray(s.editList) && s.editList.length) || s.editReport || s.editFormDirty) {
    return 'schedule-edit';
  }
  if (s.plannerFormDirty || s.qualificationsDirty || s.gapPolicyDirty || s.modeFormDirty) {
    return 'schedule-form';
  }
  if (doc && typeof doc.querySelector === 'function' && doc.querySelector('#overrideList .override')) {
    return 'schedule-override';
  }
  return '';
}

export function schedulePwaUpdateGuard(state, doc) {
  const reason = scheduleUpdateBlockReason(state, doc);
  return reason ? { safe:false, reason:'יש שינוי או פעולת סידור שעדיין לא נשמרו.' } : { safe:true };
}
