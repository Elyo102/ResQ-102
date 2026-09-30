import {createFirebaseAdapter} from './firebase-adapter.mjs?v=20260930-grok-dispatch4';
import {mountPrivateDashboard} from './private-view.mjs?v=20260930-grok-dispatch4';
import {firebaseConfig} from './firebase-config.mjs?v=20260930-grok-dispatch4';
import {mountDispatchPanel} from './dispatch-view.mjs?v=20260930-grok-dispatch4';
import {mountActiveTasksPanel} from './active-tasks-view.mjs?v=20260930-grok-dispatch4';
const root=document.getElementById('private-root');

const loadGoogleOauth=()=>new Promise((resolve,reject)=>{
  const ready=()=>globalThis.google?.accounts?.oauth2?.initTokenClient;
  if(ready()){resolve(globalThis.google.accounts.oauth2);return;}
  const prior=document.querySelector('script[data-resq-google-identity]');
  const script=prior||document.createElement('script');
  let settled=false;
  const timer=setTimeout(()=>finish(Error('GOOGLE_IDENTITY_TIMEOUT')),12000);
  function cleanup(){clearTimeout(timer);script.removeEventListener('load',loaded);script.removeEventListener('error',failed);}
  function finish(error){if(settled)return;settled=true;cleanup();if(error)reject(error);else resolve(globalThis.google.accounts.oauth2);}
  function loaded(){if(ready())finish();else finish(Error('GOOGLE_IDENTITY_UNAVAILABLE'));}
  function failed(){finish(Error('GOOGLE_IDENTITY_LOAD_FAILED'));}
  script.addEventListener('load',loaded,{once:true});
  script.addEventListener('error',failed,{once:true});
  if(!prior){
    script.src='https://accounts.google.com/gsi/client';
    script.async=true;script.defer=true;script.dataset.resqGoogleIdentity='true';
    document.head.append(script);
  }
});
try {
  const [app,auth,firestore,googleOauth]=await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js'),
    loadGoogleOauth()
  ]);
  const adapter=await createFirebaseAdapter({sdk:{...app,...auth,...firestore},config:firebaseConfig,googleOauth});
  // Dispatch panel: hidden until backend authorization; re-sign-in stays inside the direct click (adapter.auth.signIn).
  const dispatchPanel=mountDispatchPanel({doc:document,api:adapter.dispatch,signIn:()=>adapter.auth.signIn()});
  // Active tasks panel: owner writes (create PENDING / cancel own PENDING) only; progress comes from each agent's listener identity.
  const activeTasksPanel=mountActiveTasksPanel({doc:document,api:adapter.activeTasks,signIn:()=>adapter.auth.signIn()});
  const dispose=mountPrivateDashboard({root,...adapter,dispatchPanel,activeTasksPanel,listenerStatus:activeTasksPanel.listenerStatus});
  // Hidden tabs are handled by the controller; remove private DOM when leaving.
  window.addEventListener('pagehide',dispose,{once:true});
  window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
} catch {
  root.textContent='לא ניתן לפתוח חיבור מאובטח כרגע. בדוק את החיבור ורענן את העמוד. לא מוצגים נתוני הדגמה.';
}
