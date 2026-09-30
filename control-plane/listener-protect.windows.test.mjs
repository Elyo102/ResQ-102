// Real Windows DPAPI + ACL tests for listener/win-protect.mjs and credential-store.mjs (security provisioning verdict Q3).
// Windows only; skipped elsewhere. A fresh folder under the user's own %TEMP% stands in for the user profile (the store
// refuses any path with a 'work' segment, so the approved work area cannot host it); it is removed at the end.
// Synthetic secrets only; no real credential, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createWindowsProtector} from './listener/win-protect.mjs';
import {createCredentialStore} from './listener/credential-store.mjs';

const win=process.platform==='win32';
const skip=win?false:'Windows only';
const icacls=args=>execFileSync('C:\\Windows\\System32\\icacls.exe',args,{stdio:'ignore',windowsHide:true});

test('Windows listener credential: DPAPI CurrentUser round trip, ACL lock-down, fail-closed ACL checks',{skip},async t=>{
  const top=join(fs.realpathSync.native(tmpdir()),'resq-win-listener-'+randomUUID());fs.mkdirSync(top);
  const p=createWindowsProtector();
  try{
    await t.test('DPAPI: ciphertext differs from plaintext, round trips, tampered blob rejected',()=>{
      const secret=Buffer.from('synthetic-refresh-'+randomUUID());
      const blob=p.protect(secret);assert.ok(blob.length>secret.length);assert.equal(blob.indexOf(secret),-1);
      assert.deepEqual(p.unprotect(blob),secret);
      const bad=Buffer.from(blob);bad[bad.length-5]^=0xff;
      assert.throws(()=>p.unprotect(bad),e=>e.code==='PROTECTOR_UNPROTECT_FAILED');
    });
    await t.test('store: ensureDir locks the folder (owner=me, no inheritance, me only); credential written, read back, never plain',()=>{
      const store=createCredentialStore({home:top,protector:p});store.ensureDir();
      p.checkAcl(store.dir,{directory:true});
      const w=store.writeCredential('Codex',{uid:'syntheticUid01',projectId:'resq-agent-control-20260928',revokedAfter:1790000000,refreshToken:'SYNTH-'+'z'.repeat(60)});
      assert.doesNotMatch(fs.readFileSync(w.path,'utf8'),/SYNTH-/);
      assert.equal(store.readCredential('Codex').refreshToken,'SYNTH-'+'z'.repeat(60));
      store.writeConfig('Codex',{inboxRoot:'C:\\Users\\User\\ResQ-Inbox',delivery:false});assert.equal(store.readConfig('Codex').delivery,false);
    });
    await t.test('ACL: an extra principal on the file or the folder, or re-enabled inheritance, makes reads fail closed',()=>{
      const store=createCredentialStore({home:top,protector:p});
      const file=store.paths('Codex').credential;
      icacls([file,'/grant','*S-1-1-0:(R)']);
      assert.throws(()=>store.readCredential('Codex'),e=>e.code==='ACL_OTHER_PRINCIPAL');
      icacls([file,'/remove:g','*S-1-1-0']);assert.equal(store.readCredential('Codex').uid,'syntheticUid01');
      icacls([store.dir,'/grant','*S-1-5-32-545:(OI)(CI)(R)']);
      assert.throws(()=>store.readCredential('Codex'),e=>e.code==='ACL_OTHER_PRINCIPAL');
      icacls([store.dir,'/remove:g','*S-1-5-32-545']);assert.equal(store.readCredential('Codex').uid,'syntheticUid01');
      icacls([store.dir,'/inheritance:e']);
      assert.throws(()=>store.readCredential('Codex'),e=>/^ACL_/.test(e.code));
      store.ensureDir();assert.equal(store.readCredential('Codex').uid,'syntheticUid01');
    });
  }finally{
    try{icacls([top,'/reset','/T','/Q']);}catch{}
    fs.rmSync(top,{recursive:true,force:true});
    assert.equal(fs.existsSync(top),false);
  }
});
