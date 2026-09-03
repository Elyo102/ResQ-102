/* ====================================================================
 *  hosting-glob · תרגום תבניות Firebase Hosting לביטוי רגולרי
 *
 *  שתי בדיקות שונות שואלות „האם התבנית הזאת תופסת את הנתיב הזה":
 *  `headercheck` (איזה כלל כותרת מנצח) ו-`releasegate` (האם קובץ
 *  כללים עולה לאוויר). ⭐ שתי מימושים נפרדים של אותה סמנטיקה הם
 *  שתי מראות שיסטו זו מזו — וכשהן יסטו, אחת מהן תיתן ביטחון שווא.
 *  לכן מימוש אחד, במקום אחד.
 *
 *  ⚠ מה שהמודול הזה **אינו**: הוא אינו Firebase. הוא מימוש של
 *  הסמנטיקה כפי שהיא מתועדת ונמדדה, ולא הספרייה עצמה. הוא נועד
 *  לתפוס סדר שגוי ותבנית חסרה — לא להחליף מדידה מול הכתובת החיה.
 * ==================================================================== */

/* ⭐ הכלל החשוב כאן: תבנית שאיני יודע לתרגם **זורקת**. היא אינה
 * נחשבת „לא מתאימה". אחרת מישהו יוסיף `!(...)` לרשימה, המתרגם
 * ישתוק, והבדיקה תדווח ירוק על שער פתוח. */
export function globToRegExp(pattern) {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    // ‎@(a|b|c) — בדיוק אחד מהם.
    if (ch === '@' && pattern[i + 1] === '(') {
      const close = pattern.indexOf(')', i + 2);
      if (close === -1) throw new Error('סוגר חסר ב-@( בתבנית: ' + pattern);
      const alts = pattern.slice(i + 2, close).split('|');
      out += '(?:' + alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = close + 1;
      continue;
    }

    // extglob שאיני מממש. לא לנחש.
    if ('!*+?'.includes(ch) && pattern[i + 1] === '(') {
      throw new Error('תבנית extglob שאינה נתמכת (' + ch + '(): ' + pattern);
    }

    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 3; }
      else { out += '.*'; i += 2; }
      continue;
    }
    if (ch === '*') { out += '[^/]*'; i += 1; continue; }
    if (ch === '?') { out += '[^/]'; i += 1; continue; }

    if ('[]{}'.includes(ch)) {
      throw new Error('תבנית עם ' + ch + ' שאינה נתמכת: ' + pattern);
    }

    out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp('^' + out + '$');
}

/* רשימת `ignore` נבדקת מול נתיב **יחסי לשורש**, בלי לוכסן מוביל —
 * כך Firebase סורק את התיקייה. רשימת `headers` נבדקת מול נתיב URL,
 * **עם** לוכסן מוביל. שני הכללים שונים, ולכן אין כאן נרמול אוטומטי:
 * מי שקורא מעביר את הצורה הנכונה. */
export function matchesAny(patterns, path) {
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    if (globToRegExp(p).test(path)) return p;
  }
  return null;
}
