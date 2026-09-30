// Real Windows DPAPI + ACL tests for listener/win-protect.mjs and credential-store.mjs (security provisioning verdict Q3).
// Windows only; skipped elsewhere. A fresh folder under the user's own %TEMP% stands in for the user profile (the store
// refuses any path with a 'work' segment, so the approved work area cannot host it); it is removed at the end.
// Synthetic secrets only; no real credential, no network. t192u: the store lives in <home>\AppData\Local\resq-listeners.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWindowsProtector} from './listener/win-protect.mjs';
import {createCredentialStore} from './listener/credential-store.mjs';

const win=process.platform==='win32';
const skip=win?false:'Windows only';
const icacls=args=>execFileSync('C:\\Windows\\System32\\icacls.exe',args,{stdio:'ignore',windowsHide:true});

test('Windows listener credential: DPAPI CurrentUser round trip, ACL lock-down, fail-closed ACL checks',{skip},async t=>{
  const top=join(fs.realpathSync.native(tmpdir()),'resq-win-listener-'+randomUUID());fs.mkdirSync(join(top,'AppData','Local'),{recursive:true});   // store base: <home>\AppData\Local (t192u)
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
      const store=createCredentialStore({home:top,accountHome:top,protector:p});store.ensureDir();
      p.checkAcl(store.dir,{directory:true});assert.equal(store.dir,join(top,'AppData','Local','resq-listeners'));assert.equal(store.verify(),null);
      const w=store.writeCredential('Codex',{uid:'syntheticUid01',projectId:'resq-agent-control-20260928',revokedAfter:1790000000,refreshToken:'SYNTH-'+'z'.repeat(60)});
      assert.doesNotMatch(fs.readFileSync(w.path,'utf8'),/SYNTH-/);
      assert.equal(store.readCredential('Codex').refreshToken,'SYNTH-'+'z'.repeat(60));
      store.writeConfig('Codex',{inboxRoot:'C:\\Users\\User\\ResQ-Inbox',delivery:false});assert.equal(store.readConfig('Codex').delivery,false);
    });
    await t.test('ACL: an extra principal on the file or the folder, or re-enabled inheritance, makes reads fail closed',()=>{
      const store=createCredentialStore({home:top,accountHome:top,protector:p});
      const file=store.paths('Codex').credential;
      icacls([file,'/grant','*S-1-1-0:(R)']);
      assert.throws(()=>store.readCredential('Codex'),e=>e.code==='ACL_OTHER_PRINCIPAL');
      icacls([file,'/remove:g','*S-1-1-0']);assert.equal(store.readCredential('Codex').uid,'syntheticUid01');
      icacls([store.dir,'/grant','*S-1-5-32-545:(OI)(CI)(R)']);
      assert.throws(()=>store.readCredential('Codex'),e=>e.code==='ACL_OTHER_PRINCIPAL');
      icacls([store.dir,'/remove:g','*S-1-5-32-545']);assert.equal(store.readCredential('Codex').uid,'syntheticUid01');
      // real aclMany (one spawn for folder + files): the per-tick check sees the extra principal with its SID and mask
      icacls([file,'/grant','*S-1-1-0:(R)']);
      const f=store.verify();assert.equal(f.code,'ACL_OTHER_PRINCIPAL');assert.equal(f.sid,'S-1-1-0');assert.equal(f.path,file);assert.ok(Number.isSafeInteger(f.mask));
      icacls([file,'/remove:g','*S-1-1-0']);assert.equal(store.verify(),null);
      icacls([store.dir,'/inheritance:e']);
      assert.throws(()=>store.readCredential('Codex'),e=>/^ACL_/.test(e.code));assert.match(store.verify().code,/^ACL_/);
      // no auto-repair (security F): an EXISTING folder is verified, never locked down again
      assert.throws(()=>store.ensureDir(),e=>/^ACL_/.test(e.code));
      icacls([store.dir,'/inheritance:r']);   // the owner's manual fix
      assert.equal(store.verify(),null);assert.equal(store.readCredential('Codex').uid,'syntheticUid01');
    });
    await t.test('INBOX_ACL_WRITABLE on real ACLs: RX for Users is fine; Modify for Users is a finding',()=>{
      const store=createCredentialStore({home:top,accountHome:top,protector:p});
      const inbox=join(top,'inbox');fs.mkdirSync(inbox);
      icacls([inbox,'/inheritance:r','/grant:r','*'+p.aclMany([store.dir])[0].me+':(OI)(CI)(F)','*S-1-5-32-545:(OI)(CI)(RX)']);
      assert.equal(store.inboxFinding([inbox]),null);
      icacls([inbox,'/grant','*S-1-5-32-545:(OI)(CI)(M)']);
      const f=store.inboxFinding([inbox]);assert.equal(f.code,'INBOX_ACL_WRITABLE');assert.equal(f.sid,'S-1-5-32-545');assert.equal(f.path,inbox);
      // the runner tick: ONE aclMany call over store + inbox (real PowerShell, 20 s cap)
      const g=store.verify({inboxPaths:[inbox]});assert.equal(g.code,'INBOX_ACL_WRITABLE');assert.equal(g.type,'Allow');assert.equal(g.path,inbox);
    });
    await t.test('acl-watch.ps1 (read-only): locked folder 0; a file inheriting from the locked folder 0; extra principal on the file 2; file under an unlocked parent 2; missing 3',()=>{
      const store=createCredentialStore({home:top,accountHome:top,protector:p});
      const script=new URL('./listener/acl-watch.ps1',import.meta.url);
      const watch=path=>{try{execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(script),'-Path',path],{stdio:'ignore',windowsHide:true});return 0;}catch(e){return e.status;}};
      const file=store.paths('Codex').credential;
      assert.equal(watch(store.dir),0);
      assert.equal(watch(file),0,'a file that inherits only the account from the locked folder is OK (t192u false positive fixed)');
      icacls([file,'/grant','*S-1-1-0:(R)']);assert.equal(watch(file),2);assert.equal(watch(store.dir),2);
      icacls([file,'/remove:g','*S-1-1-0']);assert.equal(watch(file),0);
      const loose=join(top,'loose');fs.mkdirSync(loose);const lf=join(loose,'x.txt');fs.writeFileSync(lf,'x');
      assert.equal(watch(lf),2,'inheriting from a parent with inheritance ON is not OK');
      assert.equal(watch(join(top,'nope-'+randomUUID())),3);
    });
  }finally{
    try{icacls([top,'/reset','/T','/Q']);}catch{}
    fs.rmSync(top,{recursive:true,force:true});
    assert.equal(fs.existsSync(top),false);
  }
});
