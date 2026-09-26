'use strict';

// Called only by the completed identity transaction. Never includes a password
// or reset token. Delivery is handled asynchronously by the existing mail gate.
function approvalMailJob(operation, serverTimestamp) {
  const op = operation || {}, profile = op.desired_profile || {};
  if (op.kind !== 'approve' || !/^[A-Za-z0-9_-]{1,128}$/.test(String(op.op_id || '')) ||
      !/^[1-9][0-9]{0,5}$/.test(String(op.desired_emp || '')) ||
      typeof profile.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) ||
      typeof profile.stationId !== 'string' || !/^[a-z0-9_-]{2,80}$/.test(profile.stationId)) {
    throw new TypeError('Completed approval mail data is invalid');
  }
  return Object.freeze({
    id:'approval-' + op.op_id,
    document:{
      to:[profile.email.toLowerCase()], station_id:profile.stationId,
      message:{ subject:'ResQ — החשבון אושר ומספר העובד שלך',
        text:'החשבון שלך ב־ResQ אושר.\nמספר העובד שלך: ' + op.desired_emp +
          '\nהתחבר/י עם מספר העובד והסיסמה שבחרת בעת ההרשמה.\n' +
          'שכחת את הסיסמה? במסך הכניסה בחר/י ״שכחתי סיסמה״ לקבלת קישור מאובטח למייל המאומת.\n' +
          'המערכת אינה שומרת או שולחת את הסיסמה שלך.' },
      created_at:serverTimestamp
    }
  });
}

module.exports = Object.freeze({ approvalMailJob });
