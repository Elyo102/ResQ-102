// Course requests are HR requests, never editable attendance credit.
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const definite = new Set(['invalid-argument', 'permission-denied', 'unauthenticated', 'failed-precondition']);
export function mountManualDateChooser(root, { month, today, current, choose, course, cancel }) {
  root.innerHTML = '<h3 id="dlgTitle">דיווח ידני</h3><label for="manualDate">תאריך בחודש המוצג</label>' +
    '<input id="manualDate" type="date" required><p id="manualError" role="status"></p>' +
    '<div class="acts"><button type="button" class="btn go" id="manualChoose">פתיחת היום</button>' +
    '<button type="button" class="btn" id="manualCourse">בקשת קורס לתקופה</button>' +
    '<button type="button" class="btn" id="manualCancel">ביטול</button></div>';
  const q = id => root.querySelector('#' + id), input = q('manualDate');
  input.min = month + '-01';
  input.max = new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5,7)), 0)).toISOString().slice(0,10);
  input.value = validDate(today) && today.startsWith(month + '-') ? today : input.min;
  const date = () => validDate(input.value) && input.value.startsWith(month + '-') && current();
  q('manualChoose').onclick = () => { if (date()) choose(input.value); else q('manualError').textContent = 'בחרו תאריך בחודש המוצג; אם החודש השתנה פתחו מחדש.'; };
  q('manualCourse').onclick = () => { if (date()) course(input.value); else q('manualError').textContent = 'בחרו תאריך בחודש המוצג.'; };
  q('manualCancel').onclick = cancel;
}
export function createCourseEntry({ capture, current, currentView = current, send, uuid = () => crypto.randomUUID() }) {
  let pending = null, busy = false, active = 0, draft = null, refresh = () => {};
  const mount = function (root, from, cancel) {
    const origin = capture(), generation = ++active;
    draft = { origin, root };
    // A reload is not permission to recreate an uncertain operation. Keep it
    // within this owner session until resolved; never transfer it to another user.
    if (pending && !current(pending.origin)) pending = null;
    root.innerHTML = '<h3 id="dlgTitle">בקשת קורס למשאבי אנוש</h3>' +
      '<p>הקורס ממתין לאישור HR. שעות ייזקפו רק לאחר אישור, לפי השיבוץ המאושר בתקופה; אין זיכוי כעת.</p>' +
      '<label for="courseFrom">תאריך התחלה</label><input id="courseFrom" type="date" required>' +
      '<label for="courseTo">תאריך סיום</label><input id="courseTo" type="date" required>' +
      '<label for="courseNote">הערה (לא חובה)</label><textarea id="courseNote" maxlength="1000"></textarea>' +
      '<p id="courseMessage" role="status" aria-live="polite"></p><div class="acts">' +
      '<button type="button" class="btn go" id="courseSend">שליחה לאישור HR</button>' +
      '<button type="button" class="btn" id="courseCancel">סגירה</button></div>';
    const q = id => root.querySelector('#' + id), live = () => generation === active && root.isConnected && current(origin) && currentView(origin) && !!root.querySelector('#courseSend');
    const message = text => { if (live()) q('courseMessage').textContent = text; };
    const controls = () => { if (!live()) return; for (const id of ['courseFrom','courseTo','courseNote']) q(id).disabled = busy || !!pending;
      q('courseSend').disabled = busy; q('courseSend').textContent = pending ? 'ניסיון חוזר באותה בקשה' : 'שליחה לאישור HR'; };
    refresh = controls;
    q('courseFrom').value = pending?.payload.from_date || from; q('courseTo').value = pending?.payload.to_date || from;
    q('courseNote').value = pending?.payload.text || ''; controls();
    q('courseCancel').onclick = () => { ++active; draft = null; cancel(); };
    q('courseSend').onclick = async () => {
      if (!live() || busy) return;
      if (!pending) {
        const start = q('courseFrom').value, end = q('courseTo').value;
        if (!validDate(start) || !validDate(end) || end < start || (Date.parse(end)-Date.parse(start))/86400000 >= 400) {
          message('יש להזין טווח תאריכים תקין, עד 400 ימים.'); return;
        }
        pending = Object.freeze({ origin, payload: Object.freeze({ request_id: uuid(), send_now: false,
          kind: 'course', from_date: start, to_date: end, subject: 'קורס · ' + start + ' — ' + end, text: q('courseNote').value.trim() }) });
      }
      const operation = pending; busy = true; controls(); message('שומר את הבקשה…');
      try {
        const result = await send(operation.payload);
        if (!live() || !current(operation.origin) || pending !== operation) return;
        if (!result || !/^[a-f0-9]{64}$/.test(result.case_id || '') || !Number.isSafeInteger(result.revision) || result.revision < 1
            || !['saved','no_change'].includes(result.outcome)) throw Error('uncertain');
        pending = null; draft = null; message('הבקשה נקלטה וממתינה להחלטת HR. לא נוספו שעות לדוח. ניתן לעקוב במסך פניות למשאבי אנוש.');
        q('courseSend').hidden = true;
      } catch (error) {
        if (!live() || pending !== operation) return;
        if (definite.has(String(error?.code || '').replace(/^functions\//,''))) {
          pending = null; message('הבקשה לא התקבלה. בדקו את הפרטים וההרשאה לפני ניסיון נוסף.');
        } else message('תוצאת השמירה אינה ידועה. ניסיון חוזר ישתמש באותה בקשה ולא ייצור דיווח נוסף.');
      } finally { busy = false; refresh(); }
    };
  };
  mount.updateGuard = () => !(busy || (pending && current(pending.origin)) ||
    (draft && current(draft.origin) && currentView(draft.origin) && draft.root.querySelector('#courseSend')));
  return mount;
}
