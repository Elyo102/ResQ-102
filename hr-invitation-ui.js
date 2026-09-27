import { personalInvitationLink } from './invitation-link.js?v=42h43';

export function mountHrInvitation(root, { issue, revoke, stationOptions, getActor, requestId }) {
  let disposed=false, busy=false, intent=null, inviteId='';
  root.innerHTML='<h2>הזמנת HR אישית</h2><p>מנהל־על בלבד. ההזמנה נעולה למייל ולתחנה, בתוקף ל־72 שעות ובשימוש יחיד. ללא משמרת וללא הרשאת מנהל־על. נדרשים אימות מייל, תקנון ואישור סופי.</p>'+
    '<label>שם מלא<input data-field="name" maxlength="160" autocomplete="off"></label>'+
    '<label>מייל<input data-field="email" type="email" dir="ltr" autocomplete="off"></label>'+
    '<label>תחנה<select data-field="station"></select></label>'+
    '<button type="button" data-action="issue">צור קישור HR אישי</button>'+
    '<label hidden data-link-box>קישור אישי — לשיתוף עם הנמענת בלבד<input data-link readonly dir="ltr" autocomplete="off"></label>'+
    '<p data-status role="status" aria-live="polite"></p>'+
    '<button type="button" data-action="revoke" hidden>בטל הזמנה</button>'+
    '<button type="button" data-action="new" class="ghost">נקה טופס להזמנה חדשה</button>';
  const field=n=>root.querySelector('[data-field="'+n+'"]'), action=n=>root.querySelector('[data-action="'+n+'"]');
  const status=root.querySelector('[data-status]'), link=root.querySelector('[data-link]'), box=root.querySelector('[data-link-box]');
  field('station').innerHTML=stationOptions;
  function lock() { ['name','email','station'].forEach(n=>field(n).disabled=busy||!!intent); ['issue','revoke','new'].forEach(n=>action(n).disabled=busy); action('issue').disabled=busy||!!inviteId; }
  action('issue').onclick=async()=>{
    if(busy||disposed||inviteId)return;
    busy=true; lock(); const actor=getActor();
    try {
      if(!actor)throw Error('נדרשת כניסת מנהל־על.');
      if(!intent)intent=Object.freeze({request_id:requestId(),full_name:field('name').value.trim(),email:field('email').value.trim().toLowerCase(),station_id:field('station').value});
      lock(); status.textContent='מנפיק הזמנה…';
      const result=await issue(intent);
      if(disposed||getActor()!==actor)return;
      if(!result?.ok)throw Error('לא התקבל אישור מהשרת.');
      inviteId=result.invite_id; action('revoke').hidden=result.state==='REDEEMED'; link.value=''; box.hidden=true;
      if(result.secret_available){link.value=personalInvitationLink(location.href,result.invite_id,result.secret);box.hidden=false;status.textContent='הקישור נוצר. לא נשלח מייל ולא הוענקו הרשאות. העתיקו ושלחו לנמענת בערוץ פרטי.';}
      else status.textContent=result.state==='REDEEMED' ? 'ההזמנה כבר מומשה. בדקו את בקשת ההרשמה או החשבון הקיים; אין להנפיק חשבון כפול.' : 'ההזמנה כבר קיימת, אך הקישור אינו ניתן לשחזור. אם אבד, בטלו אותה לפני הנפקה חדשה.';
    }catch(error){if(!disposed&&getActor()===actor)status.textContent='הפעולה לא הושלמה: '+(error.message||'אפשר לנסות שוב עם אותה בקשה.');}
    finally{if(!disposed&&getActor()===actor){busy=false;lock();}}
  };
  action('revoke').onclick=async()=>{
    if(busy||!inviteId||disposed)return;
    busy=true;lock();const actor=getActor();
    try{const result=await revoke({invite_id:inviteId});if(disposed||getActor()!==actor)return;
      if(!result?.ok)throw Error('לא התקבל אישור ביטול.');
      link.value='';box.hidden=true;inviteId='';intent=null;action('revoke').hidden=true;status.textContent='ההזמנה בוטלה. אפשר להנפיק חדשה; קיימת הגבלת קצב.';
    }catch(error){if(!disposed&&getActor()===actor)status.textContent='הביטול לא אושר: '+error.message;}
    finally{if(!disposed&&getActor()===actor){busy=false;lock();}}
  };
  action('new').onclick=()=>{if(busy||disposed)return;
    intent=null;inviteId='';link.value='';box.hidden=true;action('revoke').hidden=true;
    field('name').value='';field('email').value='';status.textContent='הטופס נוקה; הזמנות קיימות לא בוטלו. הזנת אותו מייל ותחנה מאפשרת איתור הזמנה קיימת.';lock();};
  return ()=>{disposed=true;link.value='';root.replaceChildren();};
}
