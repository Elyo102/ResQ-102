// SDK and Google Identity Services are injected for local regression tests.
// This adapter never writes events and never persists or logs OAuth access tokens.
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
