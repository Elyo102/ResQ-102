import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';

export function shippedPreloads() {
  return Object.freeze({
    network:fs.readFileSync(new URL('./network-guard.cjs',import.meta.url),'utf8'),
    read:fs.readFileSync(new URL('./mutation-read-preload.cjs',import.meta.url),'utf8'),
  });
}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const unknown=()=>{throw Error('SYNTHETIC_UNKNOWN_API');};
function strict(values){return new Proxy(values,{
  get(target,key){if(typeof key==='symbol')return Reflect.get(target,key);if(!Object.hasOwn(target,key))unknown();return target[key];},
  set(target,key,value){if(!Object.hasOwn(target,key))unknown();target[key]=value;return true;},
});}

// Executes shipped source, not a rewritten guard. Every effectful dependency
// below is synthetic. This proves composition logic, not native OS isolation.
export function createSyntheticComposition(sources=shippedPreloads()) {
  const root='/repo', directory='/repo/evidence', ledger=directory+'/violations.log';
  const fileURLToPath=value=>{const url=new URL(value);if(url.protocol!=='file:'||url.host||url.search||url.hash||/%2f|%5c/i.test(url.pathname))unknown();return decodeURIComponent(url.pathname);};
  const networkFile='/repo/tests/lib/network-guard.cjs', readFile='/repo/tests/lib/mutation-read-preload.cjs';
  const entry='/repo/entry.cjs', data='/repo/data.txt', capability='/repo/capability.json';
  const disk=new Map(), directories=new Set(['/','/repo','/repo/evidence','/repo/tests','/repo/tests/lib','/repo/functions','/repo/rules-test']);
  const normalize=value=>path.posix.resolve(value instanceof URL?fileURLToPath(value):String(value));
  const put=(name,bytes)=>disk.set(normalize(name),Buffer.from(bytes));
  put(networkFile,sources.network);put(readFile,sources.read);put(entry,'module.exports=42;');put(data,'pinned-content');put('/repo/outside.txt','outside');
  for(const folder of ['tests','functions','rules-test'])put('/repo/'+folder+'/package.json',JSON.stringify({scripts:{}}));
  const permitted=[entry,data,...['tests','functions','rules-test'].map(folder=>'/repo/'+folder+'/package.json')];
  const cap=JSON.stringify({version:1,root,entry,files:permitted.map(name=>({path:name,sha256:hash(disk.get(name))}))});put(capability,cap);
  const missing=()=>{throw Object.assign(Error('SYNTHETIC_ENOENT'),{code:'ENOENT'});};
  const file=name=>disk.get(normalize(name))??missing();
  const handles=new Map();let nextFD=10;
  const stats=name=>{
    const target=normalize(name);if(!disk.has(target)&&!directories.has(target))missing();
    return {isSymbolicLink:()=>false,isFile:()=>disk.has(target),isDirectory:()=>directories.has(target),size:disk.get(target)?.length??0};
  };
  const memoryFs=strict({
    realpathSync(name){const target=normalize(name);stats(target);return target;},
    lstatSync:stats,statSync:stats,existsSync:name=>disk.has(normalize(name))||directories.has(normalize(name)),
    mkdirSync(name){directories.add(normalize(name));},
    readdirSync(name){const prefix=normalize(name)+'/';return [...new Set([...disk.keys(),...directories].filter(item=>item.startsWith(prefix)).map(item=>item.slice(prefix.length).split('/')[0]))];},
    readFileSync(name,options){const bytes=Buffer.from(file(name));const encoding=typeof options==='string'?options:options?.encoding;return encoding?bytes.toString(encoding):bytes;},
    writeFileSync(name,bytes){put(name,bytes);},
    // Node's public append path uses public open/write/close. This matters when
    // the read preload blocks public open but retains its exact ledger adapter.
    appendFileSync(name,bytes){const fd=memoryFs.openSync(name,'a');try{memoryFs.writeSync(fd,bytes);}finally{memoryFs.closeSync(fd);}},
    openSync(name,flag){const target=normalize(name);if(flag==='a'&&!disk.has(target))put(target,'');else file(target);const fd=nextFD++;handles.set(fd,{target,position:flag==='a'?file(target).length:0});return fd;},
    closeSync(fd){if(!handles.delete(fd))unknown();},
    readSync(fd,buffer,offset,length,position){const handle=handles.get(fd);if(!handle)unknown();const start=position===null?handle.position:position;const bytes=file(handle.target).subarray(start,start+length);bytes.copy(buffer,offset);if(position===null)handle.position+=bytes.length;return bytes.length;},
    writeSync(fd,text){const handle=handles.get(fd);if(!handle)unknown();const bytes=Buffer.from(text);put(handle.target,Buffer.concat([file(handle.target),bytes]));return bytes.length;},
    unlinkSync(name){disk.delete(normalize(name));},
    readFile:unknown,createReadStream:unknown,open:unknown,read:unknown,readv:unknown,readvSync:unknown,
    promises:strict({readFile:unknown,open:unknown}),
  });
  const counts={socket:0,tls:0,dns:0,udp:0,child:0,fetch:0};
  class Socket {connect(){counts.socket++;return this;}}
  class Server {listen(){unknown();}}
  class Datagram {send(){counts.udp++;}connect(){counts.udp++;}}
  class Resolver {}
  const dnsMethods=['lookupService','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse'];
  const rawDNS=()=>{counts.dns++;unknown();};
  const dns=strict({lookup:rawDNS,...Object.fromEntries(dnsMethods.map(key=>[key,rawDNS])),Resolver,
    promises:strict({lookup:rawDNS,...Object.fromEntries(dnsMethods.map(key=>[key,rawDNS])),Resolver})});
  const net=strict({Socket,Server});
  const tls=strict({connect(){counts.tls++;return {};}});
  const dgram=strict({Socket:Datagram});
  const child=strict(Object.fromEntries(['spawn','spawnSync','execFile','execFileSync','fork','exec','execSync'].map(key=>[key,()=>{counts.child++;unknown();}])));
  const listeners=new Map(),output=[];let lastExit=null;
  const env={NODE_OPTIONS:'--require '+networkFile,RESQ_CONTAINMENT_DIR:directory,
    RESQ_MUTATION_READ_CAPABILITY:capability,RESQ_MUTATION_READ_CAPABILITY_SHA:hash(cap),
    FIRESTORE_EMULATOR_HOST:'127.0.0.1:8191',GCLOUD_PROJECT:'demo-resq',GOOGLE_CLOUD_PROJECT:'demo-resq'};
  const simulatedProcess=strict({env,platform:'linux',pid:123,ppid:122,argv:['/node',entry],execArgv:[],execPath:'/node',exitCode:undefined,
    stdout:strict({write:text=>{output.push(String(text));return true;}}),
    nextTick:fn=>fn(),kill:unknown,cwd:()=>root,
    on(event,fn){if(!listeners.has(event))listeners.set(event,[]);listeners.get(event).push(fn);return this;},
    exit(code){this.exitCode=code;for(const fn of listeners.get('exit')||[])fn();lastExit=this.exitCode;},
  });
  const hooks=[];
  const moduleAPI=strict({syncBuiltinESMExports(){},registerHooks(value){hooks.push(value);return {};},
    builtinModules:['fs','path','crypto','url','module','net','tls','dns','dgram','child_process','os']});
  const adapters=new Map([
    ['node:fs',memoryFs],['node:path',strict(Object.fromEntries(['resolve','join','dirname','basename','relative','isAbsolute','sep'].map(key=>[key,path.posix[key]])))],['node:crypto',strict({createHash:crypto.createHash})],
    ['node:url',strict({fileURLToPath})],['node:module',moduleAPI],['node:net',net],['node:tls',tls],
    ['node:dns',dns],['node:dgram',dgram],['node:child_process',child],['node:os',strict({tmpdir:()=>'/tmp'})],
    ['./owned-emulator-contract.cjs',strict({})],
  ]);
  const context=vm.createContext({process:simulatedProcess,Buffer,URL,
    fetch:()=>{counts.fetch++;unknown();},setTimeout:unknown,setInterval:unknown,clearTimeout:unknown});
  const cache=new Map();
  const closedRequire=name=>{if(!adapters.has(name))unknown();return adapters.get(name);};
  const originals={socket:Socket.prototype.connect,read:memoryFs.readFileSync,exit:simulatedProcess.exit};
  function load(which){
    if(!['network','read'].includes(which))unknown();
    if(cache.has(which))return cache.get(which).exports;
    const filename=which==='network'?networkFile:readFile;
    const module={exports:{}};cache.set(which,module);
    context.__load={module,filename,dirname:path.posix.dirname(filename),require:closedRequire};
    try{
      new vm.Script('(function(require,module,exports,__filename,__dirname){\n'+sources[which]+'\n})(__load.require,__load.module,__load.module.exports,__load.filename,__load.dirname);',{filename})
        .runInContext(context,{timeout:1000});
      return module.exports;
    }catch(error){cache.delete(which);throw error;}finally{delete context.__load;}
  }
  return Object.freeze({load,fs:memoryFs,net,tls,dns,dgram,child,process:simulatedProcess,originals,
    snapshot:()=>({counts:{...counts},ledger:disk.get(ledger)?.toString()||'',output:[...output],lastExit,hooks:hooks.length}),
    require:closedRequire,
    moduleAllowed:()=>{const hook=hooks.at(-1);const result=hook.resolve('./entry.cjs',{parentURL:'file:///repo/entry.cjs'},()=>({url:'file:///repo/entry.cjs'}));return hook.load(result.url,{},()=>({format:'commonjs',source:'WRONG'})).source.toString();},
    moduleDenied:()=>hooks.at(-1).resolve('unapproved-package',{parentURL:'file:///repo/entry.cjs'},unknown),
  });
}
