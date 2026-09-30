import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import cp from 'node:child_process';
import path from 'node:path';
import {createSyntheticComposition,shippedPreloads} from './lib/synthetic-preload-composition.mjs';

const orders=[['network','read'],['read','network']];
function installed(order,sources){const rig=createSyntheticComposition(sources);for(const name of order)rig.load(name);return rig;}
function networkProof(rig){
  let caught;try{new rig.net.Socket().connect({host:'example.invalid',port:443});}catch(error){caught=error;}
  assert.equal(caught?.code,'RESQ_EGRESS_DENIED','composition must reach network denial');
  assert.match(rig.snapshot().ledger,/unregistered-or-nonloopback-socket/,'composition ledger must retain socket denial');
  assert.equal(rig.snapshot().counts.socket,0);
  rig.process.exit(0);assert.equal(rig.snapshot().lastExit,1);
}
for(const order of orders){
  const label=order.join(' then ');
  test(label+': pinned reads and module hooks remain usable',()=>{
    const rig=installed(order);assert.equal(rig.fs.readFileSync('/repo/data.txt','utf8'),'pinned-content');
    assert.equal(rig.moduleAllowed(),'module.exports=42;');
    new rig.net.Socket().connect({host:'127.0.0.1',port:8191});assert.equal(rig.snapshot().counts.socket,1);
    rig.process.exit(0);assert.equal(rig.snapshot().lastExit,0);assert.equal(rig.snapshot().ledger,'');
  });
  test(label+': cached require is idempotent and never unwraps',()=>{
    const rig=installed(order),socket=rig.net.Socket.prototype.connect,read=rig.fs.readFileSync,exit=rig.process.exit;
    assert.notEqual(socket,rig.originals.socket);assert.notEqual(read,rig.originals.read);assert.notEqual(exit,rig.originals.exit);
    for(const name of order)assert.equal(rig.load(name),rig.load(name));
    assert.equal(rig.net.Socket.prototype.connect,socket);assert.equal(rig.fs.readFileSync,read);assert.equal(rig.process.exit,exit);assert.equal(rig.snapshot().hooks,1);
    networkProof(rig);
  });
  test(label+': caught network denial stays in synthetic ledger at exit zero',()=>networkProof(installed(order)));
  for(const [name,action] of [
    ['TLS',r=>r.tls.connect({host:'example.invalid',port:443})],
    ['DNS',r=>r.dns.lookup('example.invalid',()=>{})],
    ['UDP',r=>new r.dgram.Socket().send('x',443,'example.invalid')],
    ['child',r=>r.child.exec('not-permitted')],
  ])test(label+': '+name+' cannot reach native mock adapter',()=>{
    const rig=installed(order);assert.throws(()=>action(rig),error=>error.code==='RESQ_EGRESS_DENIED');
    assert.deepEqual(rig.snapshot().counts,{socket:0,tls:0,dns:0,udp:0,child:0,fetch:0});
    assert.notEqual(rig.snapshot().ledger,'');rig.process.exit(0);assert.equal(rig.snapshot().lastExit,1);
  });
  for(const [name,action] of [['content',r=>r.fs.readFileSync('/repo/outside.txt')],['module',r=>r.moduleDenied()]])
    test(label+': '+name+' denial remains sticky',()=>{const rig=installed(order);assert.throws(()=>action(rig),error=>error.code==='MUTATION_READ_BOUNDARY');rig.process.exit(0);assert.equal(rig.snapshot().lastExit,1);assert.ok(rig.snapshot().output.includes('RESQ_MUTATION_READ_DENIED\n'));});
}
test('unknown imports and adapter properties fail closed',()=>{const rig=installed(orders[0]);assert.throws(()=>rig.require('node:unknown'),/SYNTHETIC_UNKNOWN_API/);assert.throws(()=>rig.require('node:fs').unsupported,/SYNTHETIC_UNKNOWN_API/);});
test('simulated composition leaves host environment, methods and ledger unchanged',()=>{
  const env=JSON.stringify(process.env),methods=[fs.readFileSync,fs.appendFileSync,net.Socket.prototype.connect,dns.lookup,tls.connect,cp.spawn,process.exit,globalThis.fetch];
  const ledger=process.env.RESQ_CONTAINMENT_DIR?path.join(process.env.RESQ_CONTAINMENT_DIR,'violations.log'):null;
  const before=ledger&&fs.existsSync(ledger)?fs.readFileSync(ledger):null;
  for(const order of orders)networkProof(installed(order));
  assert.equal(JSON.stringify(process.env),env);assert.deepEqual([fs.readFileSync,fs.appendFileSync,net.Socket.prototype.connect,dns.lookup,tls.connect,cp.spawn,process.exit,globalThis.fetch],methods);
  assert.deepEqual(ledger&&fs.existsSync(ledger)?fs.readFileSync(ledger):null,before);
});
function mutate(source,needle,replacement){assert.equal(source.split(needle).length,2,'mutation anchor must be unique');return source.replace(needle,replacement);}
test('proof rejects removed socket enforcement',()=>{const sources=shippedPreloads();const needle="checkEndpoint(options.host || 'localhost', options.port);\n    return originalConnect.apply(this, args);";const changed={...sources,network:mutate(sources.network.replace(/\r\n/g,'\n'),needle,"return originalConnect.apply(this, args);")};const rig=installed(orders[0],changed);assert.throws(()=>networkProof(rig),error=>error instanceof assert.AssertionError&&error.code==='ERR_ASSERTION'&&error.operator==='strictEqual'&&error.actual===undefined&&error.expected==='RESQ_EGRESS_DENIED'&&error.message.startsWith('composition must reach network denial'));assert.equal(rig.snapshot().counts.socket,1);});
test('proof rejects missing central ledger append',()=>{const sources=shippedPreloads();const line="fs.appendFileSync(violationFile, JSON.stringify({ pid: process.pid, reason: String(reason).slice(0, 160) }) + '\\n');";const changed={...sources,network:mutate(sources.network,line,'/* disabled append */')};const rig=installed(orders[0],changed);assert.throws(()=>networkProof(rig),error=>error instanceof assert.AssertionError&&error.code==='ERR_ASSERTION'&&error.operator==='match'&&error.actual===''&&error.message.startsWith('composition ledger must retain socket denial'));});
test('proof rejects removed read-denial sticky exit enforcement',()=>{
  const sources=shippedPreloads();let read=mutate(sources.read,'process.exit = code => exit(violated ? 1 : code);','process.exit = code => exit(code);');
  read=mutate(read,"process.on('exit', () => { if (violated) process.exitCode = 1; });","process.on('exit', () => {});");
  const rig=installed(orders[0],{...sources,read});
  assert.throws(()=>rig.fs.readFileSync('/repo/outside.txt'),error=>error.code==='MUTATION_READ_BOUNDARY');
  rig.process.exit(0);assert.throws(()=>assert.equal(rig.snapshot().lastExit,1,'read denial must force nonzero exit'),error=>error instanceof assert.AssertionError&&error.code==='ERR_ASSERTION'&&error.operator==='strictEqual'&&error.actual===0&&error.expected===1&&error.message.startsWith('read denial must force nonzero exit'));
});
for(const expression of ["require('node:unknown')","require('node:fs').unsupported()"])
  test('actual VM source denies unknown API: '+expression,()=>{
    const sources=shippedPreloads(),rig=createSyntheticComposition({...sources,network:sources.network+"\nprocess.stdout.write('UNKNOWN_ACTION_REACHED');\n"+expression+';'});
    assert.throws(()=>rig.load('network'),error=>error instanceof Error&&error.message==='SYNTHETIC_UNKNOWN_API');
    assert.ok(rig.snapshot().output.includes('UNKNOWN_ACTION_REACHED'));
    assert.deepEqual(rig.snapshot().counts,{socket:0,tls:0,dns:0,udp:0,child:0,fetch:0});
  });
test('proof rejects removal of read-preload ledger append compatibility',()=>{
  const sources=shippedPreloads(),start=sources.read.indexOf('fs.appendFileSync = function(value, data) {'),end=sources.read.indexOf('\nfunction approved(',start);
  assert.ok(start>0&&end>start);const block=sources.read.slice(start,end);
  const rig=installed(orders[0],{...sources,read:mutate(sources.read,block,'/* removed exact ledger compatibility */')});
  assert.throws(()=>networkProof(rig),error=>error instanceof assert.AssertionError&&error.code==='ERR_ASSERTION'&&error.operator==='strictEqual'&&error.actual==='MUTATION_READ_BOUNDARY'&&error.expected==='RESQ_EGRESS_DENIED'&&error.message.startsWith('composition must reach network denial'));
  assert.ok(rig.snapshot().output.includes('RESQ_MUTATION_READ_DENIED\n'));assert.equal(rig.snapshot().ledger,'');assert.equal(rig.snapshot().counts.socket,0);
});
