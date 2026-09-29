'use strict';

// A release-scoped constant, never supplied by a request or a mutable DB setting.
// Missing/corrupt configuration disables NEW records, not access to saved data.
let configuration;
try { configuration = require('./reserve-shift-policy.json'); } catch (_) { configuration = null; }
const creationEnabled = configuration?.creationEnabled === true;
function assertReserveShiftTransition(candidate, before) {
  if (candidate?.day_type === 'reserve_shift' && before?.day_type !== 'reserve_shift' && !creationEnabled) {
    const error = new Error('יצירת משמרת בזמן מילואים אינה פעילה כרגע. דיווחים קיימים נשארים זמינים.');
    error.code = 'failed-precondition';
    throw error;
  }
}
module.exports = Object.freeze({ creationEnabled, assertReserveShiftTransition });
