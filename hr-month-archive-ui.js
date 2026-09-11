import { buildMonthArchive } from './hr-month-archive.js?v=42h13';
export function createMonthArchiveUI(root,adapter){
  const button=document.createElement('button');button.type='button';button.textContent='הורדת כל דוחות החודש';
  const status=document.createElement('p');status.setAttribute('role','status');
  const note=document.createElement('p');note.className='hr-meta';note.textContent='ZIP עם תיקיית חודש ושנה, PDF חזותי לכל עובד וסיכום CSV. כולל עובדים שלא הגישו. הקבצים נשמרים במחשב ואינם ניתנים לביטול מרחוק. הנתונים אינם גרסה היסטורית חתומה.';
  root.querySelector('.hr-toolbar').after(button,status,note);
  const month=root.querySelector('[data-hr="month"]');let generation=0,busy=false,dead=false,url=null;
  const key=()=>{const s=adapter.currentSession();return s&&(s.super===true||s.role==='hr_coordinator')?JSON.stringify([s.uid,s.stationId,s.role,s.super===true,s.epoch]):null;};
  const clear=()=>{++generation;busy=false;if(url){URL.revokeObjectURL(url);url=null;}status.textContent='';button.disabled=dead||!key();};
  const unsubscribe=adapter.subscribeIdentity(clear);month.addEventListener('change',clear);window.addEventListener('pagehide',clear);
  button.addEventListener('click',async()=>{
    if(busy||dead||!key())return;const owner=key(),selected=month.value,g=++generation;busy=true;button.disabled=true;
    const guard=()=>{if(dead||g!==generation||owner!==key()||selected!==month.value)throw Error('ההפקה בוטלה עקב שינוי המשתמש או החודש.');};
    try{const result=await buildMonthArchive(adapter,selected,{guard,progress:text=>{guard();status.textContent=text;}});guard();
      url=URL.createObjectURL(new Blob([result.bytes],{type:'application/zip'}));guard();
      const a=document.createElement('a');a.href=url;a.download=result.name;a.hidden=true;document.body.append(a);a.click();a.remove();
      status.textContent='הוכנו '+result.count+' דוחות. ההורדה הועברה לדפדפן; חלצו את ZIP לקבלת התיקייה.';
      const current=url;setTimeout(()=>{URL.revokeObjectURL(current);if(url===current)url=null;},60000);
    }catch(e){if(g===generation)status.textContent=e.message||'ההפקה נכשלה; לא הורד ארכיון חלקי.';}
    finally{if(g===generation){busy=false;button.disabled=!key();}}
  });clear();
  return {destroy(){dead=true;clear();unsubscribe();month.removeEventListener('change',clear);window.removeEventListener('pagehide',clear);button.remove();status.remove();note.remove();}};
}
