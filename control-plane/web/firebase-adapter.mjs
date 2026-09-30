// SDK and Google Identity Services are injected for local regression tests.
// This adapter never writes events and never persists or logs OAuth access tokens.
// Its only writes are owner dispatch requests (create queued / cancel own queued) and owner active tasks
// (create PENDING / cancel own PENDING), enforced by Firestore Rules. It never writes progress or listener docs.
// No GitHub token, no CI trigger and no executor call exists in the browser.
import {mapTaskDoc,mapListenerDocs} from './active-tasks-model.mjs?v=20260930-grok-dispatch4';
export const PROJECT = 'resq-agent-control-20260928';
export const APP_ID = '1:802712493259:web:5634c433be7c020b7c4f4e';

const authError = (code, message) => Object.assign(Error(message), {code});
const oauthError = error => {
  if (error?.type === 'popup_failed_to_open') return authError('auth/popup-blocked', 'GOOGLE_POPUP_BLOCKED');
  if (error?.type === 'popup_closed') return authError('auth/popup-closed-by-user', 'GOOGLE_POPUP_CLOSED');
  return authError('auth/oauth-failed', 'GOOGLE_OAUTH_FAILED');
};

export async function createFirebaseAdapter({sdk, config, googleOauth}) {
  if (config?.projectId !== PROJECT || config.authDomain !== PROJECT+'.firebaseapp.com'
      || config.appId !== APP_ID
      || typeof config.apiKey !== 'string' || !config.apiKey
      || typeof config.googleOAuthClientId !== 'string' || !config.googleOAuthClientId
      || typeof googleOauth?.initTokenClient !== 'function') throw Error('INVALID_PRIVATE_CONFIG');
  const app=sdk.initializeApp(config,'resq-private-control');
  const auth=sdk.getAuth(app);
  try {
    await sdk.setPersistence(auth,sdk.browserSessionPersistence);
  } catch (error) {
    // Storage-blocked browsers may authenticate for this tab only. Configuration,
    // network and unknown failures must not silently change authentication mode.
    if (error?.code !== 'auth/web-storage-unsupported') throw error;
    await sdk.setPersistence(auth,sdk.inMemoryPersistence);
  }
  const db=sdk.initializeFirestore(app,{localCache:sdk.memoryLocalCache()});
  const validSession=user=>typeof user?.uid==='string' && user.uid.length>0
    && user.emailVerified===true && user.providerData?.some(p=>p.providerId==='google.com');
  let authorizedUid=null,epoch=0,pendingSignIn=null;
  let signingOut=false,signOutPromise=null;
  const authorized=()=>!signingOut && !pendingSignIn?.cancelled && validSession(auth.currentUser) && authorizedUid!==null && auth.currentUser.uid===authorizedUid;
  return {
    auth:{
      onIdentity(fn){
        const stop=sdk.onIdTokenChanged(auth,user=>{
          const ticket=++epoch;authorizedUid=null;fn(null);
          if(!user || signingOut || pendingSignIn?.cancelled)return;
          if(!validSession(user)){fn({uid:user.uid,backendAuthorized:false});return;}
          void (async()=>{
            let timer;
            try{
              // Successful missing-document reads still require owner Rules.
              // Never inspect or persist the document payload.
              await Promise.race([
                sdk.getDocFromServer(sdk.doc(db,'events','00000000-0000-0000-0000-000000000000')),
                new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('AUTHORIZATION_TIMEOUT')),10000);})
              ]);
              if(ticket!==epoch || signingOut || pendingSignIn?.cancelled || auth.currentUser?.uid!==user.uid)return;
              authorizedUid=user.uid;fn({uid:user.uid,backendAuthorized:true});
            }catch{
              if(ticket===epoch && auth.currentUser?.uid===user.uid)fn({uid:user.uid,backendAuthorized:false});
            }finally{clearTimeout(timer);}
          })();
        });
        return()=>{epoch++;authorizedUid=null;stop();};
      },
      signIn(){
        if(pendingSignIn || signingOut)return Promise.reject(authError('auth/cancelled-popup-request','SIGN_IN_ALREADY_RUNNING'));
        let resolve,reject;
        const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
        const attempt={resolve,reject,phase:'popup',cancelled:false,exchange:null};
        pendingSignIn=attempt;
        const activePopup=()=>pendingSignIn===attempt && attempt.phase==='popup' && !attempt.cancelled;
        const fail=error=>{if(!activePopup())return;attempt.phase='done';pendingSignIn=null;reject(error);};
        try{
          const tokenClient=googleOauth.initTokenClient({
            client_id:config.googleOAuthClientId,scope:'openid email profile',
            callback(response){
              if(!activePopup())return;
              if(response?.error || typeof response?.access_token!=='string' || !response.access_token){fail(oauthError(response));return;}
              attempt.phase='exchanging';
              attempt.exchange=(async()=>{
                try{
                  const credential=sdk.GoogleAuthProvider.credential(null,response.access_token);
                  const result=await sdk.signInWithCredential(auth,credential);
                  if(attempt.cancelled)return;
                  if(!validSession(result.user)){
                    await sdk.signOut(auth);
                    throw authError('auth/verified-google-required','VERIFIED_GOOGLE_REQUIRED');
                  }
                  resolve();
                }catch(error){if(!attempt.cancelled)reject(error);}
                finally{
                  attempt.phase='done';
                  if(!attempt.cancelled && pendingSignIn===attempt)pendingSignIn=null;
                }
              })();
            },
            error_callback(error){fail(oauthError(error));}
          });
          if(typeof tokenClient?.requestAccessToken!=='function')throw Error('INVALID_GOOGLE_TOKEN_CLIENT');
          // Keep this call in the direct click stack so Safari allows the popup.
          tokenClient.requestAccessToken({prompt:'select_account'});
        }catch(error){
          fail(error?.code?error:oauthError(error));
        }
        return promise;
      },
      signOut(){
        if(signOutPromise)return signOutPromise;
        signingOut=true;epoch++;authorizedUid=null;
        const attempt=pendingSignIn;
        if(attempt){attempt.cancelled=true;attempt.reject(authError('auth/cancelled-popup-request','SIGN_IN_CANCELLED'));}
        signOutPromise=Promise.resolve().then(async()=>{
          // Wait for a credential exchange to settle before clearing its session.
          // Keep retries blocked until the final sign-out is acknowledged.
          if(attempt?.exchange)await attempt.exchange;
          await sdk.signOut(auth);
          if(pendingSignIn===attempt)pendingSignIn=null;
          signingOut=false;
        }).finally(()=>{signOutPromise=null;});
        return signOutPromise;
      }
    },
    dispatch:{
      uid(){return authorized()?authorizedUid:null;},
      // auth_time from the ID token (getIdToken(true) refreshes the token but NOT auth_time).
      async authTime(){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        const result=await auth.currentUser.getIdTokenResult();
        const ms=Date.parse(result?.authTime);return Number.isSafeInteger(ms)?ms:null;
      },
      // Two bounded listeners (queued pins + latest 20); never a listener on all of history.
      watch({next,error}){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        const col=sdk.collection(db,'dispatchRequests');
        const parts={active:null,latest:null};let stopped=false;
        const map=d=>{const x=d.data();const keys=Object.keys(x);
          const base=['agent','taskType','note','status','batchId','createdAt','createdBy'];
          if(!base.every(k=>keys.includes(k))||!keys.every(k=>base.includes(k)||k==='cancelledAt')||typeof x.createdAt?.toMillis!=='function')throw Error('INVALID_DISPATCH');
          return {id:d.id,agent:x.agent,taskType:x.taskType,note:x.note,status:x.status,batchId:x.batchId,createdBy:x.createdBy,
            createdAt:x.createdAt.toMillis(),cancelledAt:typeof x.cancelledAt?.toMillis==='function'?x.cancelledAt.toMillis():null};};
        const listen=(name,q)=>sdk.onSnapshot(q,{includeMetadataChanges:true},snapshot=>{
          if(stopped)return;if(!authorized()){error();return;}
          // No optimistic rows: ignore cache and pending-write snapshots, show server-confirmed state only.
          if(snapshot.metadata.fromCache!==false||snapshot.metadata.hasPendingWrites!==false)return;
          try{parts[name]=snapshot.docs.map(map);}catch{error();return;}
          if(parts.active&&parts.latest)next([...parts.active,...parts.latest]);
        },()=>{if(!stopped)error();});
        // Client feed size 20 (long notes); the Rules still allow list limits up to 50.
        const stops=[listen('active',sdk.query(col,sdk.where('status','==','queued'),sdk.limit(20))),
          listen('latest',sdk.query(col,sdk.orderBy('createdAt','desc'),sdk.limit(20)))];
        return()=>{stopped=true;for(const stop of stops){try{stop();}catch{}}};
      },
      // Atomic batch of creates with client-generated v4 ids; retries reuse the same ids.
      async create(payload,timeoutMs=12000){
        if(!authorized()||payload?.rows?.some(r=>r.data.createdBy!==authorizedUid))throw Error('SERVER_AUTHORIZATION_REQUIRED');
        const batch=sdk.writeBatch(db);
        for(const {id,data} of payload.rows)batch.set(sdk.doc(db,'dispatchRequests',id),{...data,createdAt:sdk.serverTimestamp()});
        let timer;
        try{await Promise.race([batch.commit(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('DISPATCH_TIMEOUT'),{code:'deadline-exceeded'})),timeoutMs);})]);}
        finally{clearTimeout(timer);}
      },
      async verify(ids){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        return Promise.all(ids.map(async id=>{const snap=await sdk.getDocFromServer(sdk.doc(db,'dispatchRequests',id));
          if(!snap.exists())return {id,exists:false};const x=snap.data();
          return {id,exists:true,batchId:x.batchId,agent:x.agent,taskType:x.taskType,createdBy:x.createdBy,status:x.status};}));
      },
      async cancel(id,timeoutMs=12000){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        let timer;
        try{await Promise.race([sdk.updateDoc(sdk.doc(db,'dispatchRequests',id),{status:'cancelled',cancelledAt:sdk.serverTimestamp()}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('DISPATCH_TIMEOUT'),{code:'deadline-exceeded'})),timeoutMs);})]);}
        finally{clearTimeout(timer);}
      }
    },
    // Active tasks (control-plane/ACTIVE-TASKS.md). Owner list: orderBy(timestamp desc) + limit 20 (single-field index).
    // Server-confirmed snapshots only (cached snapshots are reported as {fromCache:true}, never as data), so progress is never optimistic.
    activeTasks:{
      uid(){return authorized()?authorizedUid:null;},
      async authTime(){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        const result=await auth.currentUser.getIdTokenResult();
        const ms=Date.parse(result?.authTime);return Number.isSafeInteger(ms)?ms:null;
      },
      watch({next,error}){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        let stopped=false;
        const map=d=>mapTaskDoc(d.id,d.data());
        const q=sdk.query(sdk.collection(db,'active_tasks'),sdk.orderBy('timestamp','desc'),sdk.limit(20));
        const stop=sdk.onSnapshot(q,{includeMetadataChanges:true},snapshot=>{
          if(stopped)return;if(!authorized()){error();return;}
          // Cached/offline snapshot: tell the view explicitly (it keeps the last server state, marked stale) instead of
          // silently dropping it; never render cached data as current. Snapshots with only local pending writes are ignored.
          if(snapshot.metadata.fromCache!==false){next(null,{fromCache:true});return;}
          if(snapshot.metadata.hasPendingWrites!==false)return;
          let rows;try{rows=snapshot.docs.map(map);}catch{error();return;}next(rows);
        },()=>{if(!stopped)error();});
        return()=>{stopped=true;try{stop();}catch{}};
      },
      // Listener liveness: task_listeners/{codex|grok|gemini}.seenAt, written only by that agent's listener identity.
      watchListeners({next,error}){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        let stopped=false;
        const q=sdk.query(sdk.collection(db,'task_listeners'),sdk.orderBy('seenAt','desc'),sdk.limit(3));
        const stop=sdk.onSnapshot(q,{includeMetadataChanges:true},snapshot=>{
          if(stopped)return;if(!authorized()){error();return;}
          // Cached/offline snapshot: tell the view explicitly (it keeps the last server state, marked stale) instead of
          // silently dropping it; never render cached data as current. Snapshots with only local pending writes are ignored.
          if(snapshot.metadata.fromCache!==false){next(null,{fromCache:true});return;}
          if(snapshot.metadata.hasPendingWrites!==false)return;
          let seen;try{seen=mapListenerDocs(snapshot.docs.map(d=>({id:d.id,data:d.data()})));}catch{error();return;}
          next(seen);
        },()=>{if(!stopped)error();});
        return()=>{stopped=true;try{stop();}catch{}};
      },
      // Single create with a client-generated v4 taskId (== doc id); a retry reuses the same id.
      async create(task,timeoutMs=12000){
        if(!authorized()||task?.dispatchedBy!==authorizedUid)throw Error('SERVER_AUTHORIZATION_REQUIRED');
        const data={taskId:task.taskId,dispatchedBy:task.dispatchedBy,payload:task.payload,targets:{...task.targets},status:'PENDING',
          timestamp:sdk.serverTimestamp(),progress:{}};
        let timer;
        try{await Promise.race([sdk.setDoc(sdk.doc(db,'active_tasks',task.taskId),data),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('ACTIVE_TASK_TIMEOUT'),{code:'deadline-exceeded'})),timeoutMs);})]);}
        finally{clearTimeout(timer);}
      },
      async verify(taskId){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        const snap=await sdk.getDocFromServer(sdk.doc(db,'active_tasks',taskId));
        if(!snap.exists())return {exists:false};const x=snap.data();
        return {exists:true,taskId:x.taskId,dispatchedBy:x.dispatchedBy,payload:x.payload,targets:x.targets,status:x.status};
      },
      async cancel(taskId,timeoutMs=12000){
        if(!authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
        let timer;
        try{await Promise.race([sdk.updateDoc(sdk.doc(db,'active_tasks',taskId),{status:'CANCELLED'}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('ACTIVE_TASK_TIMEOUT'),{code:'deadline-exceeded'})),timeoutMs);})]);}
        finally{clearTimeout(timer);}
      }
    },
    subscribe({limit,next,error}){
      if(limit!==50 || !authorized())throw Error('SERVER_AUTHORIZATION_REQUIRED');
      const q=sdk.query(sdk.collection(db,'events'),sdk.orderBy('createdAt','desc'),sdk.limit(50));
      return sdk.onSnapshot(q,{includeMetadataChanges:true},snapshot=>{
        if(!authorized()){error();return;}
        if(snapshot.metadata.fromCache!==false || snapshot.metadata.hasPendingWrites!==false){next([],{fromCache:true});return;}
        try{
          const rows=snapshot.docs.map(doc=>{
            const data=doc.data();
            if(Object.keys(data).length!==5 || !['agent','kind','task','step','createdAt'].every(k=>Object.hasOwn(data,k))
               || typeof data.createdAt?.toMillis!=='function')throw Error('INVALID_EVENT');
            return {id:doc.id,agent:data.agent,kind:data.kind,task:data.task,step:data.step,at:data.createdAt.toMillis()};
          });
          next(rows,{fromCache:false});
        }catch{error();}
      },()=>error());
    }
  };
}
