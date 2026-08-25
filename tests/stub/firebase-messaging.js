// בדל Cloud Messaging. הדפדפן של הבדיקה לא רושם Service Worker
// ולא מקבל מזהה אמיתי — הבדיקה בוחנת שהמסך נטען ומציג את המצב
// הנכון, לא שההתראה יוצאת.
export function getMessaging(){ return {}; }
export function getToken(){ return Promise.resolve('stub-token-123'); }
export function onMessage(){ return function(){}; }
export function deleteToken(){ return Promise.resolve(true); }
export function isSupported(){ return Promise.resolve(true); }
