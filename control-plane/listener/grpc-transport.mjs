// gRPC transport for the listener push mode (LD only). Push-trigger review (gRPC conditions):
// - The ONLY module that imports @grpc/grpc-js / @grpc/proto-loader (exact pins in control-plane/package.json +
//   package-lock.json; install ONLY with `npm ci --ignore-scripts`).
// - Protos are vendored from googleapis at a pinned commit (listener/protos/protos.sha256.json). Every file's sha256
//   is verified BEFORE loading; any mismatch, missing or extra file fails closed with PROTO_HASH.
// - Production target is the constant firestore.googleapis.com:443 over TLS with the default root store
//   (credentials.createSsl() with no arguments). HTTP proxies are disabled (grpc.enable_http_proxy:0), so no proxy
//   is taken from the environment. Insecure credentials exist ONLY for the local emulator (127.0.0.1:8191/8199,
//   demo-* project), which the runner CLI never selects.
// - Auth is per call: the caller passes the listener's Firebase ID token as a Bearer in the call metadata. No ADC,
//   no google-auth-library, no service account, no channel-level call credentials.
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,relative,sep} from 'node:path';
import {fail,PROJECT} from './listener-auth.mjs';

export const PRODUCTION_TARGET='firestore.googleapis.com:443';
export const EMULATOR_TARGETS=Object.freeze(['127.0.0.1:8191','127.0.0.1:8199']);
export const PROTO_COMMIT='93d6085996d0b4ff7e7e86ca9945d5524bb380d1';
export const PROTO_DIR=fileURLToPath(new URL('./protos/',import.meta.url));
export const CHANNEL_OPTIONS=Object.freeze({'grpc.enable_http_proxy':0,'grpc.max_receive_message_length':4<<20,'grpc.max_send_message_length':1<<20,
  'grpc.keepalive_time_ms':60000,'grpc.keepalive_timeout_ms':20000});

function listFiles(dir){
  const out=[];
  for(const name of readdirSync(dir)){
    const p=join(dir,name);const st=lstatSync(p);
    if(st.isSymbolicLink())fail('PROTO_HASH');
    if(st.isDirectory())out.push(...listFiles(p));else if(st.isFile())out.push(p);
  }
  return out;
}
// Returns the verified manifest. Exported for the unit test.
export function verifyProtos(dir=PROTO_DIR){
  let manifest;try{manifest=JSON.parse(readFileSync(join(dir,'protos.sha256.json'),'utf8'));}catch{fail('PROTO_HASH');}
  if(manifest?.commit!==PROTO_COMMIT||!manifest.files||typeof manifest.files!=='object')fail('PROTO_HASH');
  const onDisk=listFiles(join(dir,'google')).map(p=>relative(dir,p).split(sep).join('/')).sort();
  const listed=Object.keys(manifest.files).sort();
  if(onDisk.length!==listed.length||onDisk.some((f,i)=>f!==listed[i]))fail('PROTO_HASH');
  for(const f of listed){
    const h=createHash('sha256').update(readFileSync(join(dir,f))).digest('hex');
    if(h!==manifest.files[f])fail('PROTO_HASH');
  }
  return manifest;
}
// mode 'production' | 'emulator'. Returns {listen(metadataObject) -> duplex call, close()}.
export function createFirestoreGrpc({mode,projectId,emulatorHost}){
  let target,creds;
  if(mode==='production'){if(projectId!==PROJECT)fail('PROJECT_REJECTED');target=PRODUCTION_TARGET;creds=grpc.credentials.createSsl();}
  else if(mode==='emulator'){
    if(!/^demo-[a-z0-9-]{1,60}$/.test(projectId??''))fail('EMULATOR_PROJECT_REJECTED');
    if(!EMULATOR_TARGETS.includes(emulatorHost))fail('EMULATOR_HOST_REJECTED');
    target=emulatorHost;creds=grpc.credentials.createInsecure();
  }else fail('MODE_REJECTED');
  verifyProtos();
  const def=protoLoader.loadSync('google/firestore/v1/firestore.proto',{includeDirs:[PROTO_DIR],keepCase:false,longs:String,enums:String,defaults:false,oneofs:true});
  const Firestore=grpc.loadPackageDefinition(def).google.firestore.v1.Firestore;
  const client=new Firestore(target,creds,{...CHANNEL_OPTIONS});
  return Object.freeze({
    target,
    listen(headers){
      const md=new grpc.Metadata();
      for(const [k,v] of Object.entries(headers))md.set(k,v);
      return client.listen(md);
    },
    close(){try{client.close();}catch{}}
  });
}
