'use strict';
const assert = require('node:assert/strict');
const { approvalMailJob } = require('./approval-mail');

const op = { kind:'approve', op_id:'approve-test1234567890', desired_emp:'407',
  desired_profile:{ email:'Member@Example.test', stationId:'eilat_102' } };
const result = approvalMailJob(op, 'timestamp');
assert.equal(result.id, 'approval-approve-test1234567890');
assert.deepEqual(result.document.to, ['member@example.test']);
assert.equal(result.document.station_id, 'eilat_102');
assert.equal(result.document.message.text.includes('407'), true);
assert.equal(/סיסמה שבחרת/.test(result.document.message.text), true);
assert.equal(result.document.message.text.includes('secret'), false);
assert.throws(() => approvalMailJob({ ...op, desired_emp:'' }, 'timestamp'));
assert.throws(() => approvalMailJob({ ...op, desired_profile:{ email:'bad', stationId:'eilat_102' } }, 'timestamp'));
console.log('Approval mail checks passed');
