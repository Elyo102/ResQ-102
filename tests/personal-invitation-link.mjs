import assert from 'node:assert/strict';
import { personalInvitationLink, consumePersonalInvitation } from '../invitation-link.js';

const id = 'A'.repeat(22), secret = 'B'.repeat(43);
const link = personalInvitationLink('https://resq.test/app/admin.html', id, secret);
assert.equal(link, 'https://resq.test/app/login.html#invite=' + id + '.' + secret);
assert.equal(new URL(link).search, '');
const win = { location:{ href:link, hash:new URL(link).hash }, history:{
  state:null, replaceState(_state, _title, path) { this.path = path; }
} };
assert.deepEqual(consumePersonalInvitation(win), { invite_id:id, secret });
assert.equal(win.history.path, '/app/login.html');
assert.equal(consumePersonalInvitation({ location:{ href:'https://resq.test/app/login.html', hash:'' },
  history:{ replaceState() { throw new Error('should not strip'); } } }), null);
assert.throws(() => personalInvitationLink('https://resq.test/app/', id, 'not-a-secret'));
console.log('Personal invitation link checks passed');
