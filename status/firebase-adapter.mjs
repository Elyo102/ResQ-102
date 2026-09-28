// SDK injected for local regression tests; this adapter never writes events.
export const PROJECT = 'resq-agent-control-20260928';
export const APP_ID = '1:802712493259:web:5634c433be7c020b7c4f4e';
export async function createFirebaseAdapter({sdk, config}) {
  if (config?.projectId !== PROJECT || config.authDomain !== PROJECT+'.firebaseapp.com'
      || config.appId !== APP_ID
      || typeof config.apiKey !== 'string' || !config.apiKey) throw Error('INVALID_PRIVATE_CONFIG');
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
  const google=new sdk.GoogleAuthProvider();
  google.setCustomParameters({prompt:'select_account'});
  const validSession=user=>typeof user?.uid==='string' && user.uid.length>0
    && user.emailVerified===true && user.providerData?.some(p=>p.providerId==='google.com');
  let authorizedUid=null,epoch=0;
  const authorized=()=>validSession(auth.currentUser) && authorizedUid!==null && auth.currentUser.uid===authorizedUid;
  return {
    auth:{
      onIdentity(fn){
        const stop=sdk.onIdTokenChanged(auth,user=>{
          const ticket=++epoch;authorizedUid=null;fn(null);
          if(!user)return;
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
              if(ticket!==epoch || auth.currentUser?.uid!==user.uid)return;
              authorizedUid=user.uid;fn({uid:user.uid,backendAuthorized:true});
            }catch{
              if(ticket===epoch && auth.currentUser?.uid===user.uid)fn({uid:user.uid,backendAuthorized:false});
            }finally{clearTimeout(timer);}
          })();
        });
        return()=>{epoch++;authorizedUid=null;stop();};
      },
      async signIn(){const result=await sdk.signInWithPopup(auth,google);
        if(!validSession(result.user)){await sdk.signOut(auth);throw Error('VERIFIED_GOOGLE_REQUIRED');}},
      signOut(){epoch++;authorizedUid=null;return sdk.signOut(auth);}
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
