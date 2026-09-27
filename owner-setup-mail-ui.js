export function mountSetupMail(root, { call, getActor, requestId }) {
  let users=[], selected=new Set(), visible=[], preview=null, operation=null, busy=false, disposed=false;
  root.innerHTML='<h3>מייל אישי עם מספר עובד ובחירת סיסמה</h3><p>מנהל־על בלבד. עד 20 עובדים בפעולה; ללא שינוי חשבונות או מספרי עובד. מצב אימון עשוי לדכא משלוח.</p>'+
    '<label>חיפוש לפי שם, מייל או מספר<input data-search autocomplete="off"></label>'+
    '<label>בחרו נמענים מהרשימה<select data-users multiple size="8" style="height:auto"></select></label>'+
    '<p data-count role="status">טענו את רשימת המשתמשים למעלה.</p>'+
    '<button type="button" data-preview>בדוק נמענים והצג תצוגה מקדימה</button>'+
    '<div data-results aria-live="polite"></div><button type="button" data-send disabled>שלח מיילים לנמענים המוצגים</button>'+
    '<button type="button" data-status disabled class="ghost">בדוק מצב משלוח</button>'+
    '<button type="button" data-new disabled class="ghost">בחירת קבוצה חדשה</button><div data-history></div>';
  const el=name=>root.querySelector('[data-'+name+']');
  const labels={'PENDING':'בתור — טרם נשלח','PROCESSING':'בטיפול','PREPARING':'בהכנה — נסו לבדוק מצב שוב','SUCCESS':'התקבל אצל ספק הדואר — לא אישור הגעה לתיבה',
    'SUPPRESSED':'דוכא לפי מדיניות מצב האימון/התחנה','ERROR':'שליחה נכשלה','UNKNOWN':'תוצאה לא אומתה — בדקו מצב','NOT_STARTED':'לא התחיל','COOLDOWN':'מוגבל לשליחה חוזרת בעוד שעה','RATE_LIMITED':'מכסת השעה הסתיימה','RETRY_LIMIT':'מכסת הניסיונות הסתיימה','PREVIEW_CHANGED':'פרטי החשבון השתנו — נדרשת קבוצה חדשה ותצוגה מקדימה עדכנית','RETRY_READY':'ההכנה פגה — ניתן לנסות שוב באותה פעולה'};
  function controls(){el('search').disabled=busy||!!operation;el('users').disabled=busy||!!operation;el('preview').disabled=busy||selected.size===0||selected.size>20||!!operation;el('send').disabled=busy||!preview?.length||!preview.every(r=>r.eligible);el('status').disabled=busy||!operation;el('new').disabled=busy||!operation;}
  function render(){const query=el('search').value.trim().toLocaleLowerCase();visible=users.filter(u=>([u.full_name,u.email,u.claims?.emp].join(' ').toLocaleLowerCase()).includes(query));
    el('users').replaceChildren();for(const user of visible){const option=document.createElement('option');option.value=user.uid;option.textContent=(user.full_name||user.email)+' · '+(user.claims?.emp||'טרם הוקצה')+' · '+(user.email||'');option.selected=selected.has(user.uid);option.disabled=!user.claims?.emp||user.claims?.super===true;el('users').append(option);}
    el('count').textContent='נבחרו '+selected.size+' מתוך 20 לכל היותר';controls();}
  el('search').oninput=render;
  el('users').onchange=()=>{for(const u of visible)selected.delete(u.uid);for(const option of el('users').selectedOptions)selected.add(option.value);preview=null;el('results').replaceChildren();render();};
  function rows(items, isPreview){el('results').replaceChildren();for(const r of items){const user=users.find(u=>u.uid===r.uid);const p=document.createElement('p');p.textContent=isPreview?(r.eligible? r.full_name+' · '+r.email+' · מספר עובד '+r.emp+' · '+r.station_id:'לא כשיר לשליחה: '+(user?.full_name||user?.email||'משתמש')):(user?.full_name||user?.email||'משתמש')+' — '+(labels[r.state]||'מצב לא ידוע');el('results').append(p);}}
  async function run(action){if(busy||disposed)return;const actor=getActor();if(!actor)return;busy=true;controls();
    try{let payload;if(action==='preview')payload={action,uids:[...selected]};else{if(!operation)operation={request_id:requestId(),uids:[...selected],expected:Object.fromEntries(preview.map(r=>[r.uid,r.fingerprint]))};payload={action,...operation};if(action==='status')delete payload.expected;}
      const result=await call(payload);if(disposed||getActor()!==actor)return;if(!result?.ok||!Array.isArray(result.rows))throw Error('לא התקבלה תשובת שרת תקינה.');
      if(action==='preview')preview=result.rows;rows(result.rows,action==='preview');
    }catch(_){if(!disposed&&getActor()===actor)el('results').textContent='התוצאה לא אומתה. הבחירה ומזהה הפעולה נשמרו; בדקו מצב או נסו שוב. אין להסיק שנשלח מייל.';}
    finally{if(!disposed&&getActor()===actor){busy=false;controls();}}
  }
  el('preview').onclick=()=>run('preview');el('send').onclick=()=>run('send');el('status').onclick=()=>run('status');controls();
  el('new').onclick=()=>{
    if(busy||!operation||disposed)return;
    const saved=structuredClone(operation), actor=getActor(), card=document.createElement('section'), note=document.createElement('p'), status=document.createElement('button'), retry=document.createElement('button');
    note.textContent='קבוצה קודמת ('+saved.uids.length+' נמענים): '+el('results').textContent+' — בחירה חדשה אינה מבטלת הודעות בתור. במצב לא ברור בדקו כאן לפני משלוח נוסף.';
    status.type=retry.type='button';status.textContent='בדוק מצב קבוצה קודמת';retry.textContent='נסה שוב את אותה פעולה קודמת';
    async function recover(action){status.disabled=retry.disabled=true;try{const payload={...saved,action};if(action==='status')delete payload.expected;const result=await call(payload);if(disposed||getActor()!==actor)return;
      if(!result?.ok||!Array.isArray(result.rows))throw Error('response');note.textContent=result.rows.map(r=>(users.find(u=>u.uid===r.uid)?.email||'משתמש')+' — '+(labels[r.state]||'מצב לא ידוע')).join('\n');
    }catch(_){if(!disposed&&getActor()===actor)note.textContent='מצב הקבוצה לא אומת. מזהה הפעולה נשמר לניסיון חוזר.';}finally{if(!disposed&&getActor()===actor)status.disabled=retry.disabled=false;}}
    status.onclick=()=>recover('status');retry.onclick=()=>recover('send');card.append(note,status,retry);el('history').prepend(card);
    operation=null;preview=null;selected.clear();el('results').replaceChildren();el('search').value='';render();
  };
  return {setUsers(next){if(disposed||busy||operation)return;users=next;selected=new Set([...selected].filter(uid=>users.some(u=>u.uid===uid)));preview=null;render();},dispose(){disposed=true;root.replaceChildren();}};
}
