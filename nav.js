// סרגל ניווט משותף.
//
// עד עכשיו כל מסך היה כתובת נפרדת שאלדד שלח ידנית. זו לא
// מערכת — זו ערימת דפים, וכבאי לא יזכור אף אחת מהכתובות.
//
// הסרגל הזה יושב בראש כל מסך, ומראה רק את מה שהתפקיד של
// המשתמש מתיר. מי שאינו רשאי — לא רואה את הכפתור מלכתחילה,
// וגם אם יקליד את הכתובת ידנית, כללי האבטחה בשרת יעצרו אותו.
// ההסתרה כאן היא נוחות, לא הגנה.

// נקודת הצבע היא זיהוי מהיר של מדור, לא קישוט. כפתור צבעוני
// שלם לכל מדור היה גורם לארבעה כפתורים להתחרות זה בזה, ואז
// אף אחד לא בולט.
const ITEMS = [
  { href: 'login.html',    label: 'לוח מודעות',  who: 'any',    dot: '#e8590c', group: 'mine' },
  { href: 'schedule-management.html', label: 'סידור', who: 'member', dot: '#4d94ff', group: 'mine' },
  { href: 'callout.html',  label: 'קריאת פתע',   who: 'shift_command', dot: '#f0523f', group: 'mine' },
  { href: 'board.html',    label: 'ציוות',       who: 'member', dot: '#c77dff', group: 'station' },
  { href: 'attendance.html', label: 'נוכחות',     who: 'member', dot: '#ffd166', group: 'mine' },
  { href: 'attendance-shadow.html', label: 'בקרת שעות', who: 'attendance_audit', dot: '#00b8a9', group: 'admin' },
  { href: 'hr.html', label: 'משאבי אנוש', who: 'hr', dot: '#0099cc', group: 'admin' },
  { href: 'hr-requests.html', label: 'פנייה למשאבי אנוש', who: 'member', dot: '#0099cc', group: 'mine' },
  { href: 'hr-documents.html', label: 'נהלים ומסמכים', who: 'member', dot: '#0099cc', group: 'mine' },
  { href: 'guards.html',   label: 'אבטחות',      who: 'member', dot: '#7cb342', group: 'station' },
  { href: 'faults.html',   label: 'תקלות',       who: 'member', dot: '#ff7043', group: 'mine' },
  { href: 'forms.html',    label: 'טפסים',       who: 'member', dot: '#26a69a', group: 'mine' },
  { href: 'sign.html',     label: 'חתימות',      who: 'member', dot: '#9575cd', group: 'station' },
  { href: 'swaps.html',    label: 'החלפות',      who: 'member', dot: '#4dd0e1', group: 'mine' },
  { href: 'feedback.html', label: 'חוות דעת',    who: 'member', dot: '#f06292', group: 'mine' },
  { href: 'quals.html',    label: 'כשירויות',    who: 'member', dot: '#e0a23c', group: 'station' },
  { href: 'alerts.html',   label: 'התראות',      who: 'member', dot: '#b0bec5', group: 'station' },
  { href: 'people.html',   label: 'עובדים',      who: 'member', dot: '#8d6e63', group: 'station' },
  { href: 'access.html',   label: 'גישה',   who: 'staff',  dot: '#35c46b', group: 'admin' },
  { href: 'admin.html',    label: 'ניהול',       who: 'staff',  dot: '#f0523f', group: 'admin' },
  { href: 'stats.html',    label: 'נתונים',      who: 'staff',  dot: '#ba68c8', group: 'admin' },
  { href: 'import.html',   label: 'קליטה',       who: 'super',  dot: '#66bb6a', group: 'admin' },
  { href: 'check.html',    label: 'בדיקה', who: 'super',  dot: '#9aa0a6', group: 'admin' },
  { href: 'maintenance.html', label: 'תחזוקת מערכת', who: 'super', dot: '#00a884', group: 'admin' }
];

// שלוש קבוצות תצוגה בלבד. ההרשאה נשארת בשדה who של כל פריט.
// קבוצה שאין בה אף פריט מותר אינה מוצגת.
const GROUPS = [
  { id: 'mine',    label: 'המשמרת שלי',   dot: '#4d94ff' },
  { id: 'station', label: 'התחנה והצוות', dot: '#7cb342' },
  { id: 'admin',   label: 'בקרה וניהול',  dot: '#f0523f' }
];

// מה שהשרת מתיר בפועל. מפקד מחוז אינו staff באף כלל אבטחה
// היום — הצגת הכפתורים לו הייתה שולחת אותו לשלושה מסכים
// שכולם נחסמים, ואחד מהם אף מציג הודעה שגויה.
//
// הרשימות מגיעות מ-roles.js ואינן נכתבות כאן שוב. חמישה
// עותקים של אותה רשימה היו פירושם שתפקיד חדש נוסף בארבעה
// מקומות ונשכח בחמישי.
import { STAFF_ROLES, MEMBER_ROLES } from './roles.js?v=42h20';
import { assertPresentationOnly } from './role-view.js?v=42h20';
import { consumeActualRoleViewNavigation, isPreviewSafePage } from './role-view-page.js?v=42h20';

if (typeof location !== 'undefined' && typeof sessionStorage !== 'undefined') {
  const cleanRoleViewUrl = consumeActualRoleViewNavigation(location.href, sessionStorage);
  if (cleanRoleViewUrl && typeof history !== 'undefined') {
    history.replaceState(history.state, '', cleanRoleViewUrl);
  }
}

function displayIdentity(claims, presentation) {
  if (claims && claims.super === true && assertPresentationOnly(presentation)) {
    return { super:false, role:presentation.role_id };
  }
  return claims || {};
}

function allowed(who, claims, presentation) {
  const display = displayIdentity(claims, presentation);
  const isSuper = display.super === true;
  if (who === 'any')    return true;
  if (who === 'super')  return isSuper;
  if (who === 'hr') return isSuper || display.role === 'hr_coordinator';
  if (who === 'staff')  return isSuper || STAFF_ROLES.indexOf(display.role) !== -1;
  if (who === 'shift_command') {
    return isSuper || display.role === 'commander' || display.role === 'deputy';
  }
  // דוח הצל כולל השוואה בין סידור לשעות אישיות. הוא אינו מסך
  // סגל כללי: רק רכזת כוח אדם ומפקד התחנה צריכים לראות אותו.
  if (who === 'attendance_audit') {
    return isSuper || display.role === 'hr_coordinator' ||
           display.role === 'station_commander';
  }
  // בדיוק אותה רשימה כמו member() בכללי האבטחה. מפקד מחוז אינו
  // כלול, ולכן אסור להציג לו "סידור עבודה" — הוא ייחסם בשרת.
  if (who === 'member') {
    return isSuper || MEMBER_ROLES.indexOf(display.role) !== -1;
  }
  return false;
}

// ---------- מסלול הניווט ----------
//
// **למה לא window.history.back().**
//
// אלדד: "כל לחיצה על חזרה מחזירה אותי למסך הכניסה." זה נכון,
// וזו לא תקלה בכפתור — זו התנהגות ההיסטוריה של הדפדפן כאן.
// שלושה דברים במערכת קוראים ל-location.replace, שמחליף את
// הרשומה הנוכחית במקום להוסיף אחת:
//
//   index.html   מפנה ל-login.html
//   login.html   מפנה למסך שביקשת אחרי התחברות
//   כל מסך       מפנה ל-login אם אין התחברות
//
// אחרי כל אלה ההיסטוריה של הדפדפן מכילה לעיתים רשומה אחת
// בלבד, ו-back() יוצא מהאפליקציה או נופל חזרה למסך הכניסה.
// באפליקציה על מסך הבית זה מחמיר, כי כל פתיחה מתחילה
// היסטוריה נקייה.
//
// לכן המסלול נשמר כאן, ולא נלקח מהדפדפן. הוא נמחק כשסוגרים
// את האפליקציה — זו דרך ולא העדפה, ואין סיבה שתשרוד.

const TRAIL = 'resq_trail';

function readTrail() {
  try { return JSON.parse(sessionStorage.getItem(TRAIL) || '[]'); }
  catch (e) { return []; }
}

function writeTrail(a) {
  try { sessionStorage.setItem(TRAIL, JSON.stringify(a.slice(-12))); }
  catch (e) {}
}

export function clearNavigationTrail() {
  try { sessionStorage.removeItem(TRAIL); }
  catch (e) {}
}

// Safari's edge-swipe follows the browser history, while ResQ's visible Back
// button follows the bounded in-app trail above.  When Safari restores the
// login document from history, consume exactly one trail step and return a
// closed, authorized plan.  This helper is deliberately pure: login.html
// decides whether the navigation really was back/forward before applying it.
export function planNativeBackRecovery(trail, claims) {
  if (!Array.isArray(trail) || trail.length < 3 || trail.length > 12) return null;
  const clean = [];
  for (const value of trail) {
    if (typeof value !== 'string') return null;
    const item = ITEMS.find(function (entry) { return entry.href === value; });
    if (!item || !allowed(item.who, claims || {})) return null;
    if (clean[clean.length - 1] !== value) clean.push(value);
  }
  if (clean.length < 3 || clean[0] !== 'login.html') return null;
  const current = clean[clean.length - 1];
  const target = clean[clean.length - 2];
  if (current === 'login.html' || target === 'login.html') return null;
  return Object.freeze({
    target: target,
    remaining: Object.freeze(clean.slice(0, -2))
  });
}

export function recoverNativeBack(claims) {
  const plan = planNativeBackRecovery(readTrail(), claims);
  if (!plan) return '';
  writeTrail(plan.remaining);
  return plan.target;
}

// המסלול הוא **דרך ולא יומן**: אם חזרת למסך שכבר היית בו,
// הזנב נחתך. בלי זה מעבר הלוך-ושוב בין שני מסכים היה בונה
// רשימה אינסופית, ו"חזרה" היה לוקח צעד אחורה בתוך לולאה
// במקום לצאת ממנה.
function track(current) {
  if (!current) return readTrail();
  const t = readTrail();
  const i = t.indexOf(current);
  if (i !== -1) t.length = i + 1;
  else t.push(current);
  writeTrail(t);
  return t;
}

function labelOf(href) {
  const it = ITEMS.filter(function (x) { return x.href === href; })[0];
  return it ? it.label : '';
}

function goBack() {
  const t = readTrail();
  t.pop();                        // המסך הנוכחי
  const to = t.pop() || 'login.html';   // היעד — יוסיף את עצמו מחדש
  writeTrail(t);
  window.location.href = './' + to;
}

function styleOnce() {
  if (document.getElementById('navStyle')) return;
  const st = document.createElement('style');
  st.id = 'navStyle';
  // גובה הכפתור 44 פיקסלים — המינימום שאצבע פוגעת בו באמינות
  // על מסך טלפון, וכבאי לא ייגש למערכת ממחשב.
  st.textContent = [
    // align-self:stretch נחוץ כי בדף הכניסה הגוף הוא flex ממורכז,
    // ובלעדיו הסרגל היה מתכווץ לרוחב התוכן שלו.
    '#appNav{--resq-safe-top:var(--resq-safe-top-override,env(safe-area-inset-top,0px));',
    '  --resq-safe-right:env(safe-area-inset-right,0px);',
    '  --resq-safe-left:env(safe-area-inset-left,0px);',
    '  position:sticky;top:0;z-index:900;display:flex;gap:8px;',
    '  align-items:center;flex-wrap:wrap;box-sizing:border-box;',
    '  align-self:stretch;flex:none;',
    '  background:var(--card);border-bottom:1px solid var(--line);',
    '  padding:calc(12px + var(--resq-safe-top))',
    '    calc(16px + var(--resq-safe-right)) 12px',
    '    calc(16px + var(--resq-safe-left));margin:-18px -18px 18px;',
    '  font-family:"Segoe UI",Arial,sans-serif;direction:rtl}',
    '#appNav .brand{font-weight:800;font-size:17px;color:var(--txt);',
    '  letter-spacing:-.01em;margin-inline-end:8px;white-space:nowrap}',
    '#appNav .brand b{color:var(--accent-txt);font-weight:800}',
    // כללי הרוחב והשוליים כתובים במפורש: לדפים יש חוקים גורפים
    // כמו button{width:100%} שאחרת בולעים את הכפתור לשורה שלמה.
    '#appNav button.back{display:inline-flex;align-items:center;gap:6px;',
    '  width:auto;min-height:44px;margin:0;flex:none;box-sizing:border-box;',
    '  background:transparent;border:1px solid var(--line-hover);color:var(--dim);',
    '  font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;',
    '  padding:10px 14px;border-radius:10px;white-space:nowrap}',
    '#appNav button.back:hover{background:var(--line);color:var(--txt)}',
    '#appNav button.back:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '#appNav a{display:inline-flex;align-items:center;gap:8px;',
    '  color:var(--dim);text-decoration:none;font-size:15.5px;font-weight:600;',
    '  min-height:44px;box-sizing:border-box;padding:11px 18px;border-radius:10px;white-space:nowrap;',
    '  width:auto;margin:0;flex:none;',
    '  background:var(--chip);border:1px solid var(--line);',
    '  transition:transform .12s ease,background .12s ease,color .12s ease}',
    '#appNav a:hover{transform:translateY(-1px);background:var(--line);color:var(--txt)}',
    '#appNav a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '#appNav a i{width:8px;height:8px;border-radius:50%;flex:none}',
    '#appNav a.on{background:var(--accent);border-color:var(--accent);color:var(--accent-on);',
    '  box-shadow:0 3px 12px rgba(232,89,12,.32)}',
    '#appNav a.on i{background:var(--accent-on)}',
    '#appNav button.door{display:inline-flex;align-items:center;gap:8px;',
    '  width:auto;min-height:44px;margin:0;flex:none;box-sizing:border-box;',
    '  background:var(--chip);border:1px solid var(--line);color:var(--dim);',
    '  font-family:inherit;font-size:15.5px;font-weight:700;cursor:pointer;',
    '  padding:11px 18px;border-radius:10px;white-space:nowrap}',
    '#appNav button.door:hover{background:var(--line);color:var(--txt)}',
    '#appNav button.door:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '#appNav button.door i{width:8px;height:8px;border-radius:50%;flex:none}',
    '#appNav button.door.here{border-color:var(--accent);color:var(--accent-txt)}',
    '#appNav button.door[aria-expanded="true"]{background:var(--accent);',
    '  border-color:var(--accent);color:var(--accent-on);',
    '  box-shadow:0 3px 12px rgba(232,89,12,.32)}',
    '#appNav button.door[aria-expanded="true"] i{background:var(--accent-on)}',
    '#appNav .navPanel{width:100%;order:5;display:flex;flex-wrap:wrap;gap:6px;',
    '  padding:10px 0 2px;margin:0;box-sizing:border-box}',
    '#appNav .navPanel[hidden]{display:none}',
    '#appNav .me{margin-inline-start:auto;color:var(--muted);font-size:13px;',
    '  white-space:nowrap}',
    '#appNav .bell{margin-inline-start:auto;display:inline-flex;align-items:center;',
    '  justify-content:center;width:44px;height:44px;min-width:44px;min-height:44px;',
    '  border-radius:10px;border:1px solid var(--line);background:var(--chip);',
    '  color:var(--txt);text-decoration:none;flex:none}',
    '#appNav .bell svg{width:20px;height:20px;fill:none;stroke:currentColor;',
    '  stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '#appNav .bell[aria-disabled="true"]{opacity:.5;cursor:not-allowed}',
    '#appNav .bell:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '@media (max-width:620px){#appNav .bell{margin-inline-start:6px}}',
    // 42H.20 §5.4 · נקודה על פעמון מונעת רק ממספר אמית שהועבר מבחוץ (alerts-feed.js) — לעולם לא מעצמו.
    '#appNav .bell{position:relative}',
    '#appNav .bell .badge{position:absolute;top:2px;inset-inline-end:2px;min-width:16px;height:16px;',
    '  border-radius:999px;background:var(--bad);color:var(--bad-on);font-size:10px;font-weight:800;',
    '  line-height:16px;text-align:center;padding:0 3px;pointer-events:none}',
    // במצב ניסוי פס המצב הוא בעל ה-safe-area העליון. הסרגל שמתחתיו
    // מקבל ריפוד רגיל בלבד, כדי שה-inset לא ייספר פעמיים.
    'body.has-mode-bar #appNav{top:calc(var(--resq-safe-top) + var(--resq-mode-bar-height,0px));padding-top:12px}',
    // במסך רחב המכולה שקופה: הקישורים נשארים ילדים ישירים של
    // הסרגל, ומתנהגים בדיוק כמו קודם. שום שינוי במחשב.
    '#navLinks{display:contents}',
    '#navToggle{display:none}',
    '@media (prefers-reduced-motion:reduce){',
    '  #appNav a{transition:none}',
    '  #appNav a:hover{transform:none}}',
    // בדפים המצומצמים הגוף עובר ל־12px ריפוד כבר ב־620px. חישוב
    // ה־full-bleed מול רוחב החלון מונע גלישה לצד, בלי להניח ריפוד קבוע.
    '@media (max-width:620px){',
    '  #appNav{margin:-12px calc(50% - 50vw) 14px}}',

    // ----------------------------------------------------------------
    //  טלפון
    // ----------------------------------------------------------------
    //
    // ארבעה־עשר יעדים בשורה גמישה נשברו לשלוש שורות משוננות
    // שתפסו רבע מהמסך — **קבוע**, כי הסרגל דביק. אלדד צילם את
    // זה בדיוק.
    //
    // שני תיקונים:
    //
    //   1. **רשת ולא זרימה.** ארבע עמודות שוות, כך שהכפתורים
    //      מיושרים בקו אנכי אחד. שורה גמישה מיישרת לפי אורך
    //      המילה, ולכן "כשירויות" ו"גישה" אף פעם לא מתחילים
    //      באותו מקום
    //   2. **סגור כברירת מחדל.** בשורה אחת רואים איפה אתה
    //      ולוחצים "תפריט" כדי לעבור. כבאי מסתכל על המסך, לא
    //      על הניווט
    '@media (max-width:620px){',
    '  #appNav{gap:6px;padding:calc(8px + var(--resq-safe-top))',
    '    calc(10px + var(--resq-safe-right)) 8px',
    '    calc(10px + var(--resq-safe-left))}',
    '  body.has-mode-bar #appNav{padding-top:8px}',
    '  #appNav .brand{font-size:15px;margin-inline-end:0}',
    '  #appNav button.back{padding:8px 10px;font-size:13px}',
    '  #navToggle{display:inline-flex;align-items:center;gap:6px;min-height:44px;',
    '    margin-inline-start:auto;width:auto;flex:none;',
    '    background:var(--chip);border:1px solid var(--line);color:var(--txt);',
    '    font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;',
    '    padding:9px 12px;border-radius:10px;white-space:nowrap}',
    '  #navToggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    // accent-txt ולא accent: הכיתוב הזה יושב על צ'יפ אפור,
    // ושם הכתום הבהיר של הערכה היומית נופל מתחת לסף
    // הקריאוּת. זו התווית שאומרת באיזה מסך אתה נמצא.
    '  #navToggle b{color:var(--accent-txt);font-weight:700}',
    '  #navLinks{display:flex;flex-direction:column;gap:6px;',
    '    width:100%;order:5;padding-top:2px;max-height:55vh;max-height:55dvh;',
    '    overflow-y:auto;overscroll-behavior:contain}',
    '  #appNav button.door{width:100%;justify-content:flex-start;',
    '    font-size:14.5px;padding:10px 12px}',
    '  #appNav .navPanel{display:grid;grid-template-columns:repeat(3,1fr);',
    '    gap:6px;padding:2px 0 6px;order:0}',
    '  #navLinks.closed{display:none}',
    '  #appNav a{font-size:13.5px;padding:9px 5px;justify-content:center;',
    '    gap:5px;text-align:center;line-height:1.15}',
    '  #appNav a i{width:7px;height:7px}',
    '  #themeBtn{width:100%;min-height:44px;padding:9px 5px;font-size:13.5px}',
    '  #appNav .me{width:100%;order:6;margin-inline-start:0;font-size:12px}',
    '  #appNav .me.closed{display:none}}',
    // מסך צר במיוחד: שלוש עמודות. ארבע היו דוחסות את
    // "כשירויות" לשתי שורות, והיישור היה נשבר שוב.
    '@media (min-width:421px) and (max-width:620px){',
    '  #appNav .navPanel{grid-template-columns:repeat(4,1fr)}}',
    '#resqDock,#resqDockPanel{display:none}',
    'body.dock-modal-open{overflow:hidden}',
    '@media (max-width:620px){',
    'body.has-resq-dock{padding-bottom:calc(82px + env(safe-area-inset-bottom,0px))!important}',
    '#resqDock{position:fixed;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;',
    'inset:auto 0 0;z-index:970;padding:8px',
    ' calc(10px + var(--resq-safe-right-override,env(safe-area-inset-right,0px)))',
    ' calc(8px + env(safe-area-inset-bottom,0px))',
    ' calc(10px + var(--resq-safe-left-override,env(safe-area-inset-left,0px)));',
    'gap:6px;background:var(--card);border-top:1px solid var(--line);box-shadow:0 -8px 24px rgba(0,0,0,.1);direction:rtl}',
    '#resqDock a,#resqDock button{display:flex;align-items:center;justify-content:center;min-width:0;',
    'min-height:52px;margin:0;padding:6px 4px;border:0;border-radius:12px;background:transparent;',
    'color:var(--dim);font:700 12px/1.2 "Segoe UI",Arial,sans-serif;text-decoration:none}',
    '#resqDock .on{background:var(--accent-soft);color:var(--accent-txt)}',
    '#resqDockPanel{position:fixed;display:flex;inset:0;z-index:980;align-items:flex-end;',
    'background:rgba(7,12,20,.46);padding:14px',
    ' calc(14px + var(--resq-safe-right-override,env(safe-area-inset-right,0px)))',
    ' calc(76px + env(safe-area-inset-bottom,0px))',
    ' calc(14px + var(--resq-safe-left-override,env(safe-area-inset-left,0px)))}',
    '#resqDockPanel[hidden]{display:none}',
    '#resqDockSheet{width:min(100%,520px);max-height:62vh;overflow:auto;margin:0 auto;',
    'background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px;direction:rtl}',
    '#resqDockSheet h2{margin:0 0 10px;font-size:18px;color:var(--txt)}',
    '#resqDockSheet .dockGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
    '#resqDockSheet a,#resqDockSheet button{display:flex;align-items:center;justify-content:center;',
    'min-height:46px;width:100%;box-sizing:border-box;margin:0;padding:9px;border:1px solid var(--line);',
    'border-radius:11px;background:var(--chip);color:var(--txt);font:700 14px "Segoe UI",Arial,sans-serif;text-decoration:none}',
    '#resqDockSheet .dockTheme{grid-column:1/-1}}'
  ].join('');
  document.head.appendChild(st);
}

// current — שם הקובץ הנוכחי, למשל 'admin.html'.
// who     — טקסט קצר שמזהה את המשתמש, מוצג בקצה הסרגל.
export function renderNav(claims, current, who, presentation, unreadCount) {
  styleOnce();
  claims = claims || {};

  const old = document.getElementById('appNav');
  if (old) old.remove();
  const oldDock = document.getElementById('resqDock');
  const oldDockPanel = document.getElementById('resqDockPanel');
  if (oldDock) oldDock.remove();
  if (oldDockPanel) oldDockPanel.remove();
  document.body.classList.remove('has-resq-dock', 'dock-modal-open');

  const nav = document.createElement('nav');
  nav.id = 'appNav';
  nav.setAttribute('aria-label', 'ניווט ראשי');

  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = '<b>ResQ</b> \u00b7 102';
  nav.appendChild(brand);

  // 42H.20 §3 · פעמון התראות ליד השם, לכל תפקיד פעיל. מקשר
  // למסך ההתראות הקיים בלבד — לא בונה מחדש מנגנון התראות,
  // ולא ממציא מונה שאין לו מקור אמת מחובר.
  const bell = document.createElement('a');
  bell.className = 'bell';
  bell.setAttribute('aria-label', 'התראות');
  const bellPreviewBlocked = assertPresentationOnly(presentation) && !isPreviewSafePage('alerts.html');
  if (!bellPreviewBlocked) bell.href = './alerts.html';
  if (bellPreviewBlocked) {
    bell.setAttribute('aria-disabled', 'true');
    bell.tabIndex = -1;
    bell.title = 'מעבר בין מסכים ייפתח לאחר יציאה מתצוגת התפקיד';
    bell.addEventListener('click', function (event) { event.preventDefault(); });
  }
  if (current === 'alerts.html') bell.setAttribute('aria-current', 'page');
  bell.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
    '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  // 42H.20 §5.4 · הנקודה מוצגת רק כשהמספר האמית עובר מהעמוד עצמו (alerts-feed.js's unreadFeedCount) —
  // אף עמוד לא מנחש כאן מספר מומצא.
  const count = Number(unreadCount);
  if (Number.isFinite(count) && count > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = count > 99 ? '99+' : String(count);
    bell.appendChild(badge);
    bell.setAttribute('aria-label', 'התראות ויש ' + count + ' שלא נצפו');
  }
  nav.appendChild(bell);

  // חזרה. מופיע רק כשיש לאן לחזור — כפתור שלא עושה כלום גרוע
  // מכפתור שלא קיים.
  const trail = track(current);
  if (trail.length > 1) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back';
    back.textContent = '→ ' + (labelOf(trail[trail.length - 2]) || 'חזרה');
    back.onclick = goBack;
    nav.appendChild(back);
  }

  // כפתור "תפריט" — נראה בטלפון בלבד (CSS), ומחזיק את שם
  // המסך הנוכחי. סרגל מקופל בלי שם המסך היה חוסך מקום ומוחק
  // את התשובה לשאלה "איפה אני".
  const cur = ITEMS.filter(function (x) { return x.href === current; })[0];
  const tg = document.createElement('button');
  tg.type = 'button';
  tg.id = 'navToggle';
  tg.setAttribute('aria-expanded', 'false');
  tg.setAttribute('aria-controls', 'navLinks');
  tg.setAttribute('aria-label', 'פתיחת תפריט הניווט');
  tg.innerHTML = 'תפריט' + (cur ? ' · <b>' + cur.label + '</b>' : '');
  nav.appendChild(tg);

  const links = document.createElement('div');
  links.id = 'navLinks';
  links.className = 'closed';   // מתעלמים ממנו במסך רחב

  function linkFor(it) {
    const a = document.createElement('a');
    const previewBlocked = assertPresentationOnly(presentation) && !isPreviewSafePage(it.href);
    if (!previewBlocked) a.href = './' + it.href;
    if (previewBlocked) {
      a.setAttribute('aria-disabled', 'true');
      a.tabIndex = -1;
      a.title = 'מעבר בין מסכים ייפתח לאחר יציאה מתצוגת התפקיד';
      a.addEventListener('click', function (event) { event.preventDefault(); });
    }

    const dot = document.createElement('i');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.background = it.dot;
    a.appendChild(dot);
    a.appendChild(document.createTextNode(it.label));

    if (it.href === current) {
      a.className = 'on';
      a.setAttribute('aria-current', 'page');
    }
    return a;
  }

  // רק קבוצה אחת פתוחה בכל רגע, כדי לא לדחוף את תוכן המסך.
  const doors = [];
  function closeDoors(keep) {
    doors.forEach(function (d) {
      if (d.panel === keep) return;
      d.panel.hidden = true;
      d.door.setAttribute('aria-expanded', 'false');
    });
  }

  GROUPS.forEach(function (g) {
    const items = ITEMS.filter(function (it) {
      return it.group === g.id && allowed(it.who, claims, presentation);
    });
    if (!items.length) return;

    const here = items.some(function (it) { return it.href === current; });
    const door = document.createElement('button');
    door.type = 'button';
    door.id = 'door-' + g.id;
    door.className = here ? 'door here' : 'door';
    door.setAttribute('aria-expanded', 'false');
    door.setAttribute('aria-controls', 'panel-' + g.id);

    const dot = document.createElement('i');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.background = g.dot;
    door.appendChild(dot);
    door.appendChild(document.createTextNode(g.label));

    const panel = document.createElement('div');
    panel.id = 'panel-' + g.id;
    panel.className = 'navPanel';
    panel.setAttribute('aria-labelledby', door.id);
    panel.hidden = true;
    items.forEach(function (it) { panel.appendChild(linkFor(it)); });

    door.onclick = function () {
      const willOpen = panel.hidden;
      closeDoors(willOpen ? panel : null);
      panel.hidden = !willOpen;
      door.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    };

    doors.push({ door: door, panel: panel });
    links.appendChild(door);
    links.appendChild(panel);
  });

  links.appendChild(themeButton());
  nav.appendChild(links);

  let me = null;
  if (who) {
    me = document.createElement('div');
    me.className = 'me closed';
    me.textContent = who;
    nav.appendChild(me);
  }

  tg.onclick = function () {
    const nowClosed = links.classList.toggle('closed');
    if (me) me.classList.toggle('closed', nowClosed);
    tg.setAttribute('aria-expanded', nowClosed ? 'false' : 'true');
    tg.setAttribute('aria-label', nowClosed ? 'פתיחת תפריט הניווט' : 'סגירת תפריט הניווט');
  };

  nav.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    const openDoor = doors.filter(function (d) { return !d.panel.hidden; })[0];
    if (openDoor) {
      closeDoors(null);
      openDoor.door.focus();
      return;
    }
    if (links.classList.contains('closed')) return;
    links.classList.add('closed');
    if (me) me.classList.add('closed');
    tg.setAttribute('aria-expanded', 'false');
    tg.setAttribute('aria-label', 'פתיחת תפריט הניווט');
    tg.focus();
  });

  document.body.insertBefore(nav, document.body.firstChild);

  const dock = document.createElement('nav');
  dock.id = 'resqDock';
  dock.setAttribute('aria-label', 'ניווט מהיר');
  const dockPanel = document.createElement('div');
  dockPanel.id = 'resqDockPanel';
  dockPanel.hidden = true;
  const dockSheet = document.createElement('div');
  dockSheet.id = 'resqDockSheet';
  dockSheet.setAttribute('role', 'dialog');
  dockSheet.setAttribute('aria-modal', 'true');
  dockSheet.setAttribute('aria-labelledby', 'resqDockTitle');
  dockPanel.appendChild(dockSheet);
  let dockTrigger = null;

  function closeDockPanel(){
    dockPanel.hidden = true;
    document.body.classList.remove('dock-modal-open');
    if (dockTrigger) dockTrigger.setAttribute('aria-expanded', 'false');
    const restore = dockTrigger;
    dockTrigger = null;
    if (restore) restore.focus();
  }

  function openDockPanel(groupId, trigger){
    const group = GROUPS.find(function (item) { return item.id === groupId; });
    const items = ITEMS.filter(function (item) {
      return item.href !== 'login.html' && item.group === groupId && allowed(item.who, claims, presentation);
    });
    dockSheet.replaceChildren();
    const title = document.createElement('h2');
    title.id = 'resqDockTitle';
    title.textContent = group ? group.label : 'עוד';
    dockSheet.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'dockGrid';
    items.forEach(function (item) { grid.appendChild(linkFor(item)); });
    if (groupId === 'admin') {
      const theme = themeButton('dockThemeBtn');
      theme.classList.add('dockTheme');
      grid.appendChild(theme);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'סגור';
    close.onclick = closeDockPanel;
    grid.appendChild(close);
    dockSheet.appendChild(grid);
    dockTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    dockPanel.hidden = false;
    document.body.classList.add('dock-modal-open');
    const first = grid.querySelector('a,button');
    if (first) first.focus();
  }

  const home = document.createElement('a');
  home.href = './login.html';
  home.textContent = 'בית';
  if (current === 'login.html') {
    home.className = 'on';
    home.setAttribute('aria-current', 'page');
  }
  dock.appendChild(home);

  [
    { id:'mine', label:'המשמרת' },
    { id:'station', label:'התחנה' },
    { id:'admin', label:'עוד' }
  ].forEach(function (entry) {
    const permitted = ITEMS.filter(function (item) {
      return item.href !== 'login.html' && item.group === entry.id && allowed(item.who, claims, presentation);
    });
    if (!permitted.length && entry.id !== 'admin') return;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.label;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'resqDockPanel');
    if (permitted.some(function (item) { return item.href === current; })) {
      button.className = 'on';
    }
    button.onclick = function () {
      if (!dockPanel.hidden && dockTrigger === button) closeDockPanel();
      else openDockPanel(entry.id, button);
    };
    dock.appendChild(button);
  });

  dockPanel.onclick = function (event) {
    if (event.target === dockPanel) closeDockPanel();
  };
  dockPanel.onkeydown = function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDockPanel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dockSheet.querySelectorAll('a,button'))
      .filter(function (item) { return !item.disabled && item.offsetParent !== null; });
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.body.appendChild(dockPanel);
  document.body.appendChild(dock);
  document.body.classList.add('has-resq-dock');
}

// ---------- בהיר / כהה ----------
//
// שלושה מצבים ולא שניים: "לפי הטלפון" הוא ברירת המחדל, ורק
// מי שרוצה משהו אחר בוחר. מתג של שני מצבים היה מכריח כל אחד
// לבחור, ואז מי שהחליף פעם אחת נשאר תקוע בבחירה גם כשהטלפון
// שלו כבר עבר למצב אחר.
//
// הבחירה נשמרת במכשיר בלבד. היא העדפה של עין, לא נתון של
// המערכת, ואין סיבה שתיסע בין מכשירים.

// תווית טקסט ולא סמל. סמלי שמש וירח אינם קיימים בכל גופן
// מערכת, ומי שהגופן שלו לא מכיר אותם רואה ריבוע ריק —
// כפתור שאי אפשר לדעת מה הוא עושה.
const MODES = [
  { id: 'auto',  label: 'אוטו׳', he: 'לפי הטלפון' },
  { id: 'dark',  label: 'כהה',   he: 'כהה תמיד' },
  { id: 'light', label: 'בהיר',  he: 'בהיר תמיד' }
];

export function readTheme() {
  try { return localStorage.getItem('resq_theme') || 'auto'; }
  catch (e) { return 'auto'; }
}

export function applyTheme(mode) {
  const r = document.documentElement;
  if (mode === 'dark' || mode === 'light') r.setAttribute('data-theme', mode);
  else r.removeAttribute('data-theme');
  try { localStorage.setItem('resq_theme', mode); } catch (e) {}
}

function themeButton(id) {
  const cur = readTheme();
  const m = MODES.filter(function (x) { return x.id === cur; })[0] || MODES[0];

  const b = document.createElement('button');
  b.type = 'button';
  b.id = id || 'themeBtn';
  b.textContent = m.label;
  b.title = 'תצוגה: ' + m.he + ' — לחץ להחלפה';
  b.setAttribute('aria-label', b.title);
  b.onclick = function () {
    const i = MODES.findIndex(function (x) { return x.id === readTheme(); });
    const next = MODES[(i + 1) % MODES.length];
    applyTheme(next.id);
    b.textContent = next.label;
    b.title = 'תצוגה: ' + next.he + ' — לחץ להחלפה';
    b.setAttribute('aria-label', b.title);
  };
  return b;
}

export function clearNav() {
  const old = document.getElementById('appNav');
  const dock = document.getElementById('resqDock');
  const panel = document.getElementById('resqDockPanel');
  if (old) old.remove();
  if (dock) dock.remove();
  if (panel) panel.remove();
  document.body.classList.remove('has-resq-dock', 'dock-modal-open');
}

// סרגל מינימלי למסכי "אין הרשאה". בלעדיו המשתמש תקוע עם
// כפתור התנתקות בלבד, ואין לו דרך לחזור למסך הבית.
export function renderStuckNav(who) {
  renderNav({}, '', who);
}
