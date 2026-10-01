import {getApp} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {getAuth,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {getFunctions,httpsCallable} from './monitored-functions.js?v=42h47';
import {createNotificationReminder,clearPushConfiguration} from './notification-reminder.js?v=42h47';
let controller=null,auth=null,epoch=0,context=null,lastUid='',session='',authReady=false;
function sessionFor(uid){try{const prior=JSON.parse(sessionStorage.getItem('resq.push-entry')||'null');if(prior?.uid===uid)return prior.session;
  const value=crypto.randomUUID();sessionStorage.setItem('resq.push-entry',JSON.stringify({uid,session:value}));return value;}catch(_){return crypto.randomUUID();}}
async function enter(){const user=auth.currentUser,captured=epoch;if(!user||!context?.allowed){controller.stop();return;}
  const result=await user.getIdTokenResult();if(captured!==epoch||auth.currentUser!==user)return;
  const claims=result.claims||{},allowed=context.allowed&&(claims.super===true||!!(claims.emp&&claims.stationId&&claims.role));
  await controller.enter({uid:user.uid,session,allowed,href:claims.stationId?'./device-readiness.html':'./alerts.html'});
}
export function configureNotificationReminder(next){
  if(context?.allowed===next.allowed&&auth)return;
  if(!auth){auth=getAuth(getApp());const fns=getFunctions(getApp(),'europe-west1');
    controller=createNotificationReminder({verify:async()=>{const r=await httpsCallable(fns,'registrationTermsConsent')({action:'status'});return r.data?.ok===true&&r.data.accepted===true&&r.data.status==='approved';}});
    onAuthStateChanged(auth,user=>{authReady=true;epoch++;controller.stop();if(lastUid&&lastUid!==user?.uid)clearPushConfiguration();lastUid=user?.uid||'';
      if(!user){try{sessionStorage.removeItem('resq.push-entry');}catch(_){}session='';return;}session=sessionFor(user.uid);enter().catch(()=>{});});
  }
  context=next;
  if(!next.allowed){epoch++;controller.stop();return;}
  if(!session&&auth.currentUser)session=sessionFor(auth.currentUser.uid);
  if(authReady)enter().catch(()=>{});
}
