// Real Windows path tests for task-inbox.mjs (security code review a0d4f05, condition 6). Windows only; skipped elsewhere.
// Run on LD with RESQ_WIN_INBOX_BASE set to an existing folder inside the approved work area. Everything is created
// under a fresh sub-folder of that base and removed at the end (junctions first, never followed).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createInbox,fixedHeader} from './task-inbox.mjs';

const win=process.platform==='win32';
const base=process.env.RESQ_WIN_INBOX_BASE;
const skip=!win?'Windows only':!base||!isAbsolute(base)||!fs.existsSync(base)?'RESQ_WIN_INBOX_BASE not set to an existing absolute folder':false;
const ID='3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const code=c=>e=>e?.code===c||String(e?.message).includes(c);

test('Windows inbox paths: junction component, \\\\?\\ prefix, 8.3 short names, UNC',{skip},async t=>{
  const work=fs.realpathSync.native(base);const top=join(work,'resq-win-inbox-'+randomUUID());fs.mkdirSync(top);
  const junctions=[];const junction=(target,path)=>{fs.symlinkSync(target,path,'junction');junctions.push(path);};
  try{
    await t.test('baseline: a plain C:\\ root works; temp file removed; header written',()=>{
      const root=join(top,'plain');fs.mkdirSync(root);
      const file=createInbox({root,agentKey:'grok'}).deliver(ID,'payload');
      assert.equal(fs.readFileSync(file,'utf8'),fixedHeader(ID,'grok')+'payload');assert.deepEqual(fs.readdirSync(join(root,'grok')),[ID+'.task.txt']);
    });
    await t.test('junction as the root, as a middle component, and as the agent folder: rejected, nothing written through it',()=>{
      const real=join(top,'real');fs.mkdirSync(join(real,'nested'),{recursive:true});const outside=join(top,'outside');fs.mkdirSync(outside);
      const j=join(top,'junction-root');junction(real,j);
      assert.equal(fs.lstatSync(j).isSymbolicLink(),true,'node reports the junction as a link');
      assert.throws(()=>createInbox({root:j,agentKey:'grok'}),code('INBOX_LINK_REJECTED'));
      assert.throws(()=>createInbox({root:join(j,'nested'),agentKey:'grok'}),code('INBOX_LINK_REJECTED'));
      const r2=join(top,'r2');fs.mkdirSync(r2);junction(outside,join(r2,'grok'));
      const inbox=createInbox({root:r2,agentKey:'grok'});
      assert.throws(()=>inbox.deliver(ID,'x'),code('INBOX_LINK_REJECTED'));assert.throws(()=>inbox.markCancelled(ID),code('INBOX_LINK_REJECTED'));
      assert.deepEqual(fs.readdirSync(outside),[]);assert.deepEqual(fs.readdirSync(real),['nested']);
    });
    await t.test('\\\\?\\ and \\\\.\\ device prefixes are rejected before any file access',()=>{
      const root=join(top,'plain');
      for(const p of ['\\\\?\\'+root,'\\\\.\\'+root,'\\\\?\\UNC\\localhost\\'+root[0]+'$'+root.slice(2)])
        assert.throws(()=>createInbox({root:p,agentKey:'grok'}),code('INBOX_ROOT_WINDOWS_FORM'),p);
      assert.throws(()=>createInbox({root:root.replace(/\\/g,'/'),agentKey:'grok'}),code('INBOX_ROOT_WINDOWS_FORM'));   // C:/... forward slashes
      assert.throws(()=>createInbox({root:root.slice(0,2)+'relative',agentKey:'grok'}),/ABSOLUTE/);                   // drive-relative C:foo
    });
    await t.test('8.3 short names are not canonical: rejected (as root and as a component)',t2=>{
      const longName=join(top,'long-directory-name-for-short-name-test');fs.mkdirSync(join(longName,'inner'),{recursive:true});
      // /s + verbatim arguments: cmd strips only the outer quotes, the path stays quoted (node would escape inner quotes).
      const short=execFileSync('cmd.exe',['/d','/s','/c',`"for %I in ("${longName}") do @echo %~sI"`],{encoding:'utf8',windowsVerbatimArguments:true}).trim();
      t2.diagnostic('short form: '+short);
      if(!short||short.toLowerCase()===longName.toLowerCase()){t2.skip('8.3 short names are disabled on this volume');return;}
      assert.equal(fs.existsSync(short),true);
      assert.throws(()=>createInbox({root:short,agentKey:'grok'}),code('INBOX_ROOT_NOT_CANONICAL'));
      assert.throws(()=>createInbox({root:join(short,'inner'),agentKey:'grok'}),code('INBOX_ROOT_NOT_CANONICAL'));
      assert.equal(fs.existsSync(join(longName,'grok')),false);
      createInbox({root:longName,agentKey:'grok'});   // the long canonical form itself is accepted
    });
    await t.test('UNC paths (\\\\localhost\\C$\\..., \\\\server\\share) are rejected',t2=>{
      const root=join(top,'plain');const unc='\\\\localhost\\'+root[0]+'$'+root.slice(2);
      t2.diagnostic('UNC reachable here: '+(()=>{try{return fs.existsSync(unc);}catch{return false;}})());
      for(const p of [unc,'\\\\127.0.0.1\\'+root[0]+'$'+root.slice(2),'\\\\server\\share\\inbox'])assert.throws(()=>createInbox({root:p,agentKey:'grok'}),code('INBOX_ROOT_WINDOWS_FORM'),p);
    });
  }finally{
    for(const j of junctions.reverse()){try{fs.unlinkSync(j);}catch{try{fs.rmdirSync(j);}catch{}}}
    for(const j of junctions)assert.equal(fs.existsSync(j),false,'junction removed: '+j);
    fs.rmSync(top,{recursive:true,force:true});assert.equal(fs.existsSync(top),false);
  }
});
