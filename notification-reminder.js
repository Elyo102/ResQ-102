// Advisory device configuration only; never an authorization or delivery receipt.
const KEY='resq.push-config.v1';
export function clearPushConfiguration(){try{localStorage.removeItem(KEY);}catch(_){}}
async function subscriptionHash(){
  if(!navigator.serviceWorker||!crypto.subtle)return '';
  const timeout=promise=>Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve(null),1500))]);
  const registration=await timeout(navigator.serviceWorker.getRegistration(location.origin+'/'));
  const subscription=registration&&await timeout(registration.pushManager.getSubscription());
  if(!subscription?.endpoint)return '';
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(registration.scope+'|'+subscription.endpoint));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function rememberPushConfiguration(uid,isCurrent){
  try{const hash=await subscriptionHash();if(hash&&isCurrent())localStorage.setItem(KEY,JSON.stringify({uid,hash}));}catch(_){}
}
export async function configuredPushDevice(uid){
  try{if(globalThis.Notification?.permission!=='granted')return false;const saved=JSON.parse(localStorage.getItem(KEY)||'null');
    return saved?.uid===uid&&!!saved.hash&&saved.hash===await subscriptionHash();}catch(_){return false;}
}
export function createNotificationReminder({verify,configured=configuredPushDevice,storage=sessionStorage,doc=document,environment=()=>({supported:'Notification'in globalThis,denied:globalThis.Notification?.permission==='denied',ios:/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),standalone:matchMedia('(display-mode: standalone)').matches||navigator.standalone===true})}){
  let generation=0,key='',panel=null,observer=null,escape=null;
  const read=k=>{try{return storage.getItem(k);}catch(_){return null;}};
  const write=(k,v)=>{try{storage.setItem(k,v);}catch(_){}};
  function remove(){observer?.disconnect();observer=null;panel?.remove();panel=null;if(escape)doc.removeEventListener('keydown',escape);escape=null;}
  function stop(){generation++;key='';remove();}
  async function enter({uid,session,allowed,href}){
    const next=uid+'|'+session;if(!allowed){stop();return;}if(next===key)return;
    stop();key=next;const epoch=generation,current=()=>epoch===generation&&key===next;
    const shown='resq.push-reminder.shown:'+next,terms='resq.push-reminder.terms:'+next;
    if(read(shown)==='1')return;
    try{if(read(terms)!=='1'){if(!await verify())return;if(!current())return;write(terms,'1');}
      if(await configured(uid)||!current())return;
    }catch(_){return;}
    const env=environment();
    const urgent=()=>!!doc.querySelector('#coWrap.on');
    function show(){if(!current()||panel||urgent())return;
      panel=doc.createElement('aside');panel.id='resqPushReminder';panel.dir='rtl';panel.setAttribute('aria-label','הפעלת התראות');
      panel.style.cssText='position:fixed;bottom:90px;right:16px;z-index:9000;box-sizing:border-box;width:min(360px,calc(100vw - 32px));padding:20px;border:1px solid #8193a4;border-radius:16px;background:#fff;color:#18354b;box-shadow:0 8px 32px #0004';
      const heading=doc.createElement('h3'),text=doc.createElement('p'),action=doc.createElement('a'),dismiss=doc.createElement('button');
      heading.textContent='חשוב להפעיל התראות במכשיר הזה';
      text.textContent='התראות מסייעות לקבל קריאות ועדכוני תחנה בזמן. הפעלה אינה מבטיחה מסירה; אין להסתמך עליה כערוץ חירום יחיד.';
      if(env.ios&&!env.standalone)text.textContent+=' באייפון: שיתוף ← הוסף למסך הבית, ואז פתחו את ResQ מהסמל והפעילו התראות.';
      else if(env.denied)text.textContent+=' ההרשאה חסומה: יש לאפשר התראות בהגדרות הדפדפן/המכשיר ולחזור להפעלה.';
      else if(!env.supported)text.textContent+=' הדפדפן הזה אינו תומך בהתראות; עברו לדפדפן נתמך או פתחו את האפליקציה ממסך הבית.';
      action.href=href;action.textContent=env.supported&&!env.denied&&(!env.ios||env.standalone)?'הפעל כעת':'הוראות הפעלה';
      action.style.cssText='display:inline-block;padding:10px;color:#fff;background:#bc420d;border-radius:8px;margin-inline-end:12px';
      dismiss.type='button';dismiss.textContent='לא עכשיו';dismiss.onclick=()=>{write(shown,'1');remove();};
      escape=e=>{if(e.key==='Escape'&&!urgent())dismiss.click();};doc.addEventListener('keydown',escape);
      action.onclick=()=>write(shown,'1');panel.append(heading,text,action,dismiss);doc.body.append(panel);write(shown,'1');
    }
    observer=new MutationObserver(()=>{if(panel){const hidden=urgent();if(panel.hidden!==hidden)panel.hidden=hidden;}else show();});
    observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});show();
  }
  return {enter,stop};
}
