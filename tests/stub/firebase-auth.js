// משתמש מדומה: מנהל מערכת שהוא גם לוחם אש. בלעדיו כל דף מזהה
// "לא מחובר", מפנה למסך הכניסה, והבדיקה בוחנת דף ריק.
// הפרופיל נקבע מבחוץ, כדי שאותה בדיקה תרוץ גם כמנהל, גם ככבאי
// רגיל, וגם כמי שנרשם ועדיין לא אושר.
const ROLES = {
  super: { role: 'firefighter', super: true, emp: '1',
           stationId: 'eilat_102', districtId: 'south', shift: 'C' },
  firefighter: { role: 'firefighter', emp: '17',
                 stationId: 'eilat_102', districtId: 'south', shift: 'A' },
  team:        { role: 'team_leader', emp: '18',
                 stationId: 'eilat_102', districtId: 'south', shift: 'A' },
  // מפקד משמרת ב'. לא מנהל-על ולא רכז — ולכן נעול למשמרת שלו.
  commander:   { role: 'commander', emp: '5',
                 stationId: 'eilat_102', districtId: 'south', shift: 'B' },
  // רכז כוח אדם. יש לו משמרת, ובכל זאת רואה את שלושתן.
  hr:          { role: 'hr_coordinator', emp: '3',
                 stationId: 'eilat_102', districtId: 'south', shift: 'A' },
  // סגן מפקד משמרת ב'. סמכויותיו זהות למפקד ונעול לאותה משמרת.
  deputy:      { role: 'deputy', emp: '9',
                 stationId: 'eilat_102', districtId: 'south', shift: 'B' },
  // מפקד התחנה. רואה את שלוש המשמרות ומאשר ירידה מקו אדום.
  stcmd:       { role: 'station_commander', emp: '2',
                 stationId: 'eilat_102', districtId: 'south', shift: '' },
  district:    { role: 'district_commander', emp: '900',
                 stationId: 'eilat_102', districtId: 'south', shift: '' },
  emp_only:    { emp: '17' },
  pending: {},
  newuser: {}
};

const WHO = (typeof window !== 'undefined' && window.__SMOKE_ROLE) || 'super';
const SIGNED_OUT = WHO === 'none' ||
  (typeof window !== 'undefined' && window.__SMOKE_SIGNED_OUT === true);

const CLAIMS = Object.assign({
  email: 'eldad50@gmail.com',
  email_verified: true,
  firebase: { sign_in_provider: 'password' }
}, ROLES[WHO] || ROLES.super);

const USER = {
  uid: (typeof window !== 'undefined' && window.__SMOKE_UID) || 'stub-uid',
  email: 'eldad50@gmail.com',
  emailVerified: true,
  getIdTokenResult: () => Promise.resolve({ claims: CLAIMS }),
  getIdToken: force => {
    markAuth('getIdToken', { force:force === true });
    if (typeof window !== 'undefined' && window.__AUTH_HOLD_TOKEN === true) {
      return new Promise(() => {});
    }
    return Promise.resolve('stub-token');
  }
};

const observers = new Set();
const AUTH = { currentUser: SIGNED_OUT ? null : USER };
function markAuth(name, detail){
  if (typeof window === 'undefined') return;
  window.__AUTH_CALLS = window.__AUTH_CALLS || [];
  window.__AUTH_CALLS.push({ name:name, detail:detail || null });
}
export function getAuth(){ return AUTH; }
export function onAuthStateChanged(a, cb){
  observers.add(cb);
  setTimeout(() => cb(AUTH.currentUser), 20);
  return () => observers.delete(cb);
}
export function signInWithEmailAndPassword(){
  markAuth('signInWithEmailAndPassword');
  AUTH.currentUser = USER;
  setTimeout(() => observers.forEach(cb => cb(USER)), 0);
  return Promise.resolve({ user: USER });
}
export function createUserWithEmailAndPassword(){
  markAuth('createUserWithEmailAndPassword');
  AUTH.currentUser = USER;
  setTimeout(() => observers.forEach(cb => cb(USER)), 0);
  return Promise.resolve({ user: USER });
}
export function signOut(){
  markAuth('signOut');
  AUTH.currentUser = null;
  setTimeout(() => observers.forEach(cb => cb(null)), 0);
  return Promise.resolve();
}
export function deleteUser(){
  markAuth('deleteUser');
  AUTH.currentUser = null;
  setTimeout(() => observers.forEach(cb => cb(null)), 0);
  return Promise.resolve();
}
export function updatePassword(){ return Promise.resolve(); }
export function reauthenticateWithCredential(){ return Promise.resolve(); }
export function sendEmailVerification(){ return Promise.resolve(); }
export function setPersistence(){ return Promise.resolve(); }
export function signInWithCustomToken(){ return Promise.resolve({ user: USER }); }
export const EmailAuthProvider = { credential: () => ({}) };
export const browserLocalPersistence = {};
