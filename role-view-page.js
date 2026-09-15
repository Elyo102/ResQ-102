import { resolveRoleView } from './role-view.js?v=42h19';

export const ROLE_VIEW_STORAGE_KEY = 'resq_role_view_v1';
export const ROLE_VIEW_ACTUAL_PARAM = 'resq_actual';

const PREVIEW_SAFE = Object.freeze([
  'login.html',
  'schedule-management.html'
]);

export function isPreviewSafePage(pageId) {
  return PREVIEW_SAFE.indexOf(String(pageId || '').replace(/^\.\//, '')) !== -1;
}

function actualPageView() {
  return Object.freeze({
    selected: 'actual', preview: false, presentation: null, readOnly: false,
    showScheduleManagement: false
  });
}

export function clearRoleViewStorage(storage) {
  try { storage.removeItem(ROLE_VIEW_STORAGE_KEY); } catch (_) {}
}

export function consumeActualRoleViewNavigation(urlLike, storage) {
  let url;
  try { url = new URL(String(urlLike || ''), 'https://resq.invalid/'); }
  catch (_) { return ''; }
  if (url.searchParams.get(ROLE_VIEW_ACTUAL_PARAM) !== 'notification') return '';
  clearRoleViewStorage(storage);
  url.searchParams.delete(ROLE_VIEW_ACTUAL_PARAM);
  return url.pathname + url.search + url.hash;
}

export function resolvePageRoleView(input = {}) {
  if (!isPreviewSafePage(input.pageId)) return actualPageView();
  let stored = '';
  try { stored = input.storage.getItem(ROLE_VIEW_STORAGE_KEY) || ''; } catch (_) {}
  const view = resolveRoleView({
    uid: input.user && input.user.uid,
    claims: input.claims,
    stored
  });
  if (!view.preview && stored) clearRoleViewStorage(input.storage);
  return Object.freeze({
    selected: view.selected,
    preview: view.preview,
    presentation: view.presentation,
    readOnly: view.preview,
    showScheduleManagement: view.preview &&
      (view.selected === 'commander' || view.selected === 'deputy')
  });
}
