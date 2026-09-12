import { exportLocalFiles } from './hr-local-export.js?v=42h15';

// Deliberately not mounted by any existing page. Adapter must provide freshly
// authorized bytes; this UI is not a server authorization boundary.
export function createLocalExportUI(root, adapter, { monthElement } = {}) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'ייצוא לתיקייה מקומית';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'עצירת הייצוא'; cancel.hidden = true;
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const note = document.createElement('p');
  note.textContent = 'ייצוא ידני לתיקיית ריצה חדשה. אין לערוך את התיקייה בזמן הכתיבה. קבצים שנשמרו אינם נמחקים ביציאה ואינם ניתנים לביטול מרחוק. הורדת ZIP הקיימת נשארת זמינה.';
  root.append(button, cancel, status, note);
  let generation = 0, busy = false, dead = false, suspended = false;
  const supported = typeof window.showDirectoryPicker === 'function';
  const key = () => {
    const s = adapter.currentSession();
    return s && typeof s.stationId==='string' && s.stationId.trim() && (s.super === true || s.role === 'hr_coordinator')
      ? JSON.stringify([s.uid, s.stationId, s.role, s.super === true, s.epoch]) : null;
  };
  const render = () => { button.disabled = !supported || !key() || busy || dead || suspended; cancel.hidden = !busy; };
  const invalidate = () => { ++generation; status.textContent = ''; render(); };
  const hide = () => { suspended = true; invalidate(); };
  const show = () => { suspended = false; invalidate(); };
  const unsubscribe = adapter.subscribeIdentity(invalidate);
  monthElement?.addEventListener('change', invalidate);
  window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
  cancel.onclick = () => { invalidate(); status.textContent = 'עוצר; קבצים שכבר נכתבו יישארו בתיקיית הריצה.'; };
  button.onclick = async () => {
    if (button.disabled) return;
    const owner = key(), month = monthElement?.value || '', g = ++generation;
    busy = true; render();
    const guard = () => { if (dead || suspended || generation !== g || owner !== key() || month !== (monthElement?.value || '')) throw Error('Export context changed.'); };
    try {
      // Must be invoked synchronously in the click handler, before any await.
      const selection = window.showDirectoryPicker({ mode: 'readwrite' });
      const dir = await selection; guard();
      const files = await adapter.exportFiles(month, { guard }); guard();
      const stationId=JSON.parse(owner)[1];
      const result = await exportLocalFiles(dir, files, { stationId, guard,
        progress: p => { guard(); status.textContent = 'נשמרו ואומתו ' + p.completed + ' קבצים.'; } });
      guard(); status.textContent = 'הייצוא הושלם: ' + result.files.length + ' קבצים ומניפסט מאומת.';
    } catch (e) {
      if (!dead && !suspended && g === generation) status.textContent = e.name === 'AbortError' ? 'בחירת התיקייה בוטלה.' : 'הייצוא נעצר; ייתכן שנשמרו קבצים חלקיים. לא נמחקו קבצים.';
    } finally { busy = false; render(); }
  };
  if (!supported) status.textContent = 'הדפדפן אינו תומך בבחירת תיקייה. אפשר להשתמש בהורדת ZIP הקיימת.';
  render();
  return { destroy() { dead = true; invalidate(); unsubscribe(); monthElement?.removeEventListener('change', invalidate);
    window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); button.remove(); cancel.remove(); status.remove(); note.remove(); } };
}
