import {createPrivateController} from './private-controller.mjs';
const taskText={local_tests:'בדיקות מקומיות',git_change:'שינוי קוד',pull_request_review:'סקירת בקשת שינוי',deployment_check:'בדיקת פריסה'};
const kindText={heartbeat:'אות חיים',task_started:'התחלת משימה',test_passed:'בדיקה עברה',test_failed:'בדיקה נכשלה',commit_created:'נוצר קומיט',task_completed:'משימה הושלמה',task_failed:'משימה נכשלה'};
const phaseText={signed_out:'יש להתחבר לחשבון הבעלים',denied:'אין הרשאה לצפות בדשבורד',connecting:'מתחבר למקור הפרטי…',connected:'מחובר למקור האירועים הפרטי',offline:'החיבור אינו מאומת — פעילות חיה אינה ידועה',error:'החיבור הופסק — המידע הפרטי הוסתר',paused:'התצוגה מושהית; עבודת הסוכנים לא נעצרה'};
export function signInErrorText(error){
  const messages={
    'auth/popup-blocked':'חלון ההתחברות נחסם. אפשר חלונות קופצים לאתר הזה ולחץ שוב על התחברות.',
    'auth/popup-closed-by-user':'חלון ההתחברות נסגר לפני השלמת הכניסה. אפשר לנסות שוב.',
    'auth/cancelled-popup-request':'בקשת ההתחברות בוטלה. לחץ שוב על התחברות.',
    'auth/web-storage-unsupported':'הדפדפן חוסם אחסון הדרוש להתחברות. נסה לפתוח את הקישור בחלון Safari רגיל.',
    'auth/unauthorized-domain':'כתובת האתר אינה מורשית להתחברות. נדרש תיקון בהגדרות המערכת.',
    'auth/network-request-failed':'ההתחברות לא הושלמה עקב בעיית רשת. בדוק את החיבור ונסה שוב.'
  };
  return Object.hasOwn(messages,error?.code)?messages[error.code]:'לא ניתן להתחבר כרגע. נסה שוב.';
}
export function mountPrivateDashboard({root,auth,subscribe}){
  if(!root || !auth?.onIdentity || !auth?.signIn || !auth?.signOut)throw Error('INVALID_ADAPTER');
  const doc=root.ownerDocument;
  const node=(tag,text,cls)=>{const n=doc.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,id)=>{const n=node('button',text);n.type='button';n.id=id;return n;};
  const title=node('h1','ResQ — בקרת סוכנים פרטית');
  const message=node('p','','health');message.setAttribute('role','status');
  const login=button('התחברות עם Google','private-login'),logout=button('התנתקות','private-logout');
  const pause=button('השהיית תצוגה','private-pause'),clear=button('ניקוי תצוגה','private-clear');
  const controls=node('div',null,'controls');controls.append(login,logout,pause,clear);
  const cards=node('section',null,'agents');cards.setAttribute('aria-label','מצב הסוכנים');
  const log=node('div',null,'private-terminal');log.id='private-terminal';log.setAttribute('role','log');log.setAttribute('aria-live','off');log.tabIndex=0;
  const hint=node('p','ניקוי והשהיה משפיעים על התצוגה בלבד. אין כאן שליטה מרחוק על הסוכנים.','hint');
  root.replaceChildren(title,message,controls,cards,log,hint);
  let state=null,paused=false,hidden=new Set(),disposed=false,actionVersion=0,actionNotice=null;
  function render(next){
    if(disposed)return;if(state?.phase!==next.phase)actionNotice=null;
    state=next;message.textContent=actionNotice??phaseText[next.phase];
    const allowed=['connected','connecting','paused','offline','error'].includes(next.phase);
    login.hidden=allowed;logout.hidden=!allowed;pause.hidden=!allowed;clear.hidden=!allowed;
    cards.replaceChildren();log.replaceChildren();
    if(!allowed){hidden.clear();paused=false;pause.textContent='השהיית תצוגה';return;}
    hidden=new Set([...hidden].filter(id=>next.events.some(e=>e.id===id)));
    for(const a of next.agents){const card=node('article',null,'agent');card.append(node('h2',a.agent),node('p',a.status),node('small',a.task?taskText[a.task]:'אין משימה חיה מאומתת'));cards.append(card);}
    for(const e of next.events){if(hidden.has(e.id))continue;const row=node('div',null,'entry');row.dataset.agent=e.agent;
      row.append(node('time',new Date(e.at).toLocaleTimeString('he-IL')),node('strong',e.agent),node('span',`${kindText[e.kind]} · ${taskText[e.task]}`));log.append(row);}
    if(!log.childElementCount)log.append(node('p','אין אירועים להצגה'));
  }
  const controller=createPrivateController({subscribe,render});
  const visibility=()=>controller.setVisible(!doc.hidden&&!paused);
  doc.addEventListener('visibilitychange',visibility);visibility();
  const offAuth=auth.onIdentity(user=>{if(!disposed){actionVersion++;actionNotice=null;login.disabled=false;controller.setIdentity(user);}});
  login.onclick=async()=>{const action=++actionVersion;actionNotice=null;if(state)message.textContent=phaseText[state.phase];login.disabled=true;try{await auth.signIn();}catch(error){if(!disposed&&action===actionVersion){actionNotice=signInErrorText(error);message.textContent=actionNotice;}}finally{if(!disposed&&action===actionVersion)login.disabled=false;}};
  logout.onclick=async()=>{const action=++actionVersion;actionNotice=null;controller.setIdentity(null);try{await auth.signOut();}catch{if(!disposed&&action===actionVersion){actionNotice='המידע הוסתר, אך ניתוק החשבון לא אושר. נסה להתנתק שוב.';message.textContent=actionNotice;logout.hidden=false;}}};
  pause.onclick=()=>{paused=!paused;pause.textContent=paused?'חידוש תצוגה':'השהיית תצוגה';pause.setAttribute('aria-pressed',String(paused));visibility();};
  clear.onclick=()=>{for(const e of state?.events||[])hidden.add(e.id);if(state)render(state);};
  return ()=>{disposed=true;actionVersion++;actionNotice=null;controller.dispose();if(typeof offAuth==='function')offAuth();doc.removeEventListener('visibilitychange',visibility);state=null;hidden.clear();root.replaceChildren();};
}
