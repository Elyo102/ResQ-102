import {createFirebaseAdapter} from './firebase-adapter.mjs';
import {mountPrivateDashboard} from './private-view.mjs';
import {firebaseConfig} from './firebase-config.mjs';
const root=document.getElementById('private-root');
try {
  const [app,auth,firestore]=await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js')
  ]);
  const adapter=await createFirebaseAdapter({sdk:{...app,...auth,...firestore},config:firebaseConfig});
  const dispose=mountPrivateDashboard({root,...adapter});
  // Hidden tabs are handled by the controller; remove private DOM when leaving.
  window.addEventListener('pagehide',dispose,{once:true});
  window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
} catch {
  root.textContent='לא ניתן לפתוח חיבור מאובטח כרגע. בדוק את החיבור ורענן את העמוד. לא מוצגים נתוני הדגמה.';
}
