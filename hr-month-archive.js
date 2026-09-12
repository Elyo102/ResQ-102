// Local-only export. No transport, persistence, links or authorization of its own.
const enc = new TextEncoder();
const MAX = 128 * 1024 * 1024;
const months = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const states = {missing:'לא הוגש דוח',draft:'ממתין לאישור העובד',submitted:'ממתין לאישור פיקודי',approved:'מאושר'};
export function folderName(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('חודש לא תקין');
  return 'דוחות שעות - '+months[Number(month.slice(5))-1]+' '+month.slice(0,4);
}
export function safeName(value) {
  return String(value).normalize('NFC').replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/g,'_').replace(/[. ]+$/g,'').slice(0,70)||'ללא שם';
}
const concat = parts => { const n=parts.reduce((s,p)=>s+p.length,0); if(n>MAX)throw Error('הארכיון גדול מדי; לא הורד קובץ חלקי.'); const out=new Uint8Array(n);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out; };
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
// ZIP32, stored method, UTF-8 filenames, deterministic DOS date. No ZIP64 truncation.
export function zipFiles(files) {
  if(!files.length||files.length>3010)throw Error('מספר קבצים לא תקין');
  const local=[],central=[],seen=new Set();let offset=0;
  for(const f of files){
    if(!(f.bytes instanceof Uint8Array)||typeof f.name!=='string'||f.name.split('/').some(s=>!s||s==='.'||s==='..')||/[\\\u0000-\u001f]/.test(f.name)||seen.has(f.name))throw Error('שם קובץ לא תקין');
    seen.add(f.name);const name=enc.encode(f.name);if(name.length>65535)throw Error('שם ארוך מדי');
    const h=new Uint8Array(30),v=new DataView(h.buffer),sum=crc(f.bytes);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);
    v.setUint32(14,sum,true);v.setUint32(18,f.bytes.length,true);v.setUint32(22,f.bytes.length,true);v.setUint16(26,name.length,true);
    local.push(h,name,f.bytes);
    const c=new Uint8Array(46),d=new DataView(c.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,sum,true);d.setUint32(20,f.bytes.length,true);d.setUint32(24,f.bytes.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);central.push(c,name);
    offset+=h.length+name.length+f.bytes.length;if(offset>MAX)throw Error('הארכיון גדול מדי; לא הורד קובץ חלקי.');
  }
  const size=central.reduce((s,p)=>s+p.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);
  v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
  return concat([...local,...central,end]);
}
// Browser-shaped Hebrew is rasterized deliberately: printable but not searchable PDF text.
function imagePdf(images){
  const parts=[enc.encode('%PDF-1.4\n')],offsets=[0];let size=parts[0].length;
  const add=(id,body)=>{offsets[id]=size;const b=concat([enc.encode(id+' 0 obj\n'),...body,enc.encode('\nendobj\n')]);parts.push(b);size+=b.length;};
  add(1,[enc.encode('<< /Type /Catalog /Pages 2 0 R >>')]);
  add(2,[enc.encode('<< /Type /Pages /Count '+images.length+' /Kids ['+images.map((_,i)=>(3+i*3)+' 0 R').join(' ')+'] >>')]);
  images.forEach((img,i)=>{const id=3+i*3,content=enc.encode('q 595 0 0 842 0 0 cm /Im0 Do Q');
    add(id,[enc.encode('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 '+(id+1)+' 0 R >> >> /Contents '+(id+2)+' 0 R >>')]);
    add(id+1,[enc.encode('<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+img.length+' >>\nstream\n'),img,enc.encode('\nendstream')]);
    add(id+2,[enc.encode('<< /Length '+content.length+' >>\nstream\n'),content,enc.encode('\nendstream')]);
  });
  const xref=size;parts.push(enc.encode('xref\n0 '+offsets.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF'));
  return concat(parts);
}
export async function renderPdf(title, lines, guard=()=>{}) {
  guard();await document.fonts.ready;guard();
  const canvas=document.createElement('canvas');canvas.width=1240;canvas.height=1754;
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('לא ניתן ליצור PDF במכשיר זה');
  const images=[];let y=0,page=0;
  const bidi=text=>text.replace(/[A-Za-z0-9][A-Za-z0-9.:\/_@-]*/g,token=>'\u2066'+token+'\u2069');
  const begin=()=>{if(++page>100)throw Error('הדוח ארוך מדי');ctx.fillStyle='#fff';ctx.fillRect(0,0,1240,1754);ctx.fillStyle='#172334';ctx.direction='rtl';ctx.textAlign='right';ctx.font='bold 30px Arial';ctx.fillText(title,1170,70,1100);ctx.font='22px Arial';y=125;};
  const finish=async()=>{guard();ctx.fillText('ResQ · עמוד '+page,1170,1690);const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('יצירת PDF נכשלה')),'image/jpeg',0.9));guard();const b=new Uint8Array(await blob.arrayBuffer());guard();images.push(b);if(images.reduce((s,a)=>s+a.length,0)>MAX)throw Error('הדוח גדול מדי');};
  try {begin();for(const value of lines){
    const str=String(value??'');if(str.length>20000)throw Error('טקסט ארוך מדי בדוח');
    for(const paragraph of str.split(/\r?\n/)) {let line='';
      for(const ch of paragraph){if(ctx.measureText(line+ch).width>1090){if(y>1620){await finish();begin();}ctx.fillText(bidi(line),1170,y);y+=31;line='';}line+=ch;}
      if(y>1620){await finish();begin();}ctx.fillText(bidi(line),1170,y);y+=35;
    }
    y+=8;
  }await finish();guard();return imagePdf(images);}finally{canvas.width=0;canvas.height=0;images.length=0;}
}
const num=v=>v===null?'לא זמין':String(v);
function validateDetailedReport(p, month, message) {
  const number=v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0;
  if(!p||typeof p.full_name!=='string'||!p.full_name.trim()||typeof p.employee_number!=='string'||!p.employee_number.trim()
    ||typeof p.crew!=='string'||typeof p.historical!=='boolean'||!number(p.stored_total_hours)||!number(p.current_detail_total_hours)
    ||!Array.isArray(p.warnings)||p.warnings.some(w=>typeof w!=='string')||!Array.isArray(p.rows)||p.rows.length>31
    ||p.rows.some(r=>!r||typeof r.date!=='string'||!r.date.startsWith(month+'-')||!number(r.hours)
      ||['day_type_he','start','end','start2','end2','site_name','notes','overtime_reason','reason'].some(k=>typeof r[k]!=='string')
      ||![null,0,1,2].includes(r.end_day)||![null,0,1,2].includes(r.end_day2)))throw Error(message);
  const dates=new Set(),days=new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate();
  for(const r of p.rows){const day=Number(r.date.slice(8));if(!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||day<1||day>days||dates.has(r.date))throw Error('תאריך נוכחות לא תקין');dates.add(r.date);}
}
function reportLines(p){
  const lines=['שם: '+p.full_name+' | מספר עובד: '+p.employee_number+' | משמרת: '+p.crew,
    p.historical?'רשומת עבר של עובד שאינו פעיל בתחנה.':'רשומת עובד פעיל בתחנה.',
    'מצב: '+states[p.state], 'שעות בדוח השמור: '+num(p.stored_total_hours),'שעות בפירוט הנוכחי: '+num(p.current_detail_total_hours),
    'פירוט נוכחות נוכחי — אינו צילום היסטורי ממועד האישור.',
    ...(p.warnings.length?['אזהרות נתונים: '+p.warnings.join(', ')]:[])];
  if(p.state==='missing')lines.push('לא הוגש דוח לחודש זה. רשומות נוכחות, אם קיימות, אינן אישור הגשה.');
  for(const r of p.rows){lines.push(r.date+' | '+r.day_type_he+' | '+r.start+' עד '+r.end+(r.end_day?' (יום +'+r.end_day+')':'')+' | '+r.site_name+' | שעות: '+num(r.hours));
    if(r.start2||r.end2)lines.push('מקטע נוסף: '+r.start2+' עד '+r.end2+(r.end_day2?' (יום +'+r.end_day2+')':''));
    for(const k of ['notes','overtime_reason','reason'])if(r[k])lines.push(r[k]);
  }return lines;
}
const csvCell=v=>'"'+String(v??'').replace(/^[\s]*[=+\-@]/,m=>"'"+m).replace(/"/g,'""')+'"';
// Produces one freshly-authorized PDF at a time for the explicit local-folder
// exporter. It keeps no browser persistence and never returns stale cache data.
export async function* buildLocalMonthFiles(adapter, month, {guard=()=>{},progress=()=>{},pdf=renderPdf}={}) {
  folderName(month); const deadline=Date.now()+45*60000,people=[],seen=new Set(),cursors=new Set();let cursor,pages=0;
  const check=()=>{guard();if(Date.now()>deadline)throw Error('זמן ההפקה הסתיים; לא נוצר ייצוא חלקי נוסף.');};
  try {
    do {
      check();if(++pages>120)throw Error('יותר מדי עמודי עובדים.');
      const page=await adapter.listMonth({month,...(cursor?{cursor}:{})});check();
      if(page?.month!==month||!Array.isArray(page.items)||page.items.length>25||!(page.next_cursor===null||typeof page.next_cursor==='string'&&page.next_cursor))throw Error('רשימת דוחות לא תקינה');
      for(const person of page.items){if(!person||typeof person.uid!=='string'||!person.uid||seen.has(person.uid)||!Object.hasOwn(states,person.state))throw Error('יש עובד שפרטיו דורשים בדיקה.');seen.add(person.uid);people.push(person);}
      if(people.length>3000||page.next_cursor&&page.next_cursor===cursor||page.next_cursor&&page.items.length===0)throw Error('לא ניתן להשלים את רשימת העובדים.');
      cursor=page.next_cursor;if(cursor){if(cursors.has(cursor))throw Error('סמן עמוד חוזר');cursors.add(cursor);}progress('נמצאו '+people.length+' עובדים');
    } while(cursor);
    if(!people.length)throw Error('אין עובדים להפקה בחודש שנבחר.');
    for(let i=0;i<people.length;i++){
      check();const value=await adapter.getEmployeeMonth({month,uid:people[i].uid},{forceFresh:true});check();const report=value?.report;
      if(value?.freshness?.source!=='server'||!report||report.uid!==people[i].uid||report.month!==month||!Object.hasOwn(states,report.state)
        ||!Array.isArray(report.rows)||report.rows.length>31||!Array.isArray(report.warnings)||report.detail_provenance!=='current_attendance_not_historical_snapshot'
        )throw Error('לא התקבל דוח עדכני ותקין.');
      validateDetailedReport(report,month,'לא התקבל דוח עדכני ותקין.');
      const bytes=await pdf(folderName(month)+' — '+report.full_name,[...reportLines(report),'זמן הפקה: '+new Date().toISOString()],check);check();
      progress('הוכן '+(i+1)+' מתוך '+people.length+' דוחות');
      yield {kind:'hours',uid:report.uid,employeeNumber:report.employee_number,fullName:report.full_name,
        month,name:'דוח שעות '+month+'.pdf',bytes};
    }
    check();await adapter.listMonth({month});check();
  } finally {people.length=0;adapter.clearReportCache?.();}
}
export async function buildMonthArchive(adapter, month, {guard=()=>{},progress=()=>{},pdf=renderPdf}={}) {
  const folder=folderName(month),started=new Date().toISOString(),deadline=Date.now()+15*60000,files=[],people=[],seen=new Set(),cursors=new Set();let cursor,bytes=0,pages=0;
  const check=()=>{guard();if(Date.now()>deadline)throw Error('זמן ההפקה הסתיים; לא הורד ארכיון חלקי.');};
  const add=(name,b)=>{bytes+=b.length;if(bytes>MAX)throw Error('הארכיון גדול מדי; לא הורד ארכיון חלקי.');files.push({name:folder+'/'+name,bytes:b});};
  try {
    do{check();if(++pages>120)throw Error('יותר מדי עמודי עובדים; לא הורד ארכיון חלקי.');const page=await adapter.listMonth({month,...(cursor?{cursor}:{})});check();
      if(page?.month!==month||!Array.isArray(page.items)||page.items.length>25||!(page.next_cursor===null||typeof page.next_cursor==='string'&&page.next_cursor))throw Error('רשימת דוחות לא תקינה');
      for(const p of page.items){if(!p||typeof p.uid!=='string'||!p.uid||seen.has(p.uid)||!Object.hasOwn(states,p.state))throw Error('יש עובד שפרטיו דורשים בדיקה; לא נוצר ארכיון חלקי.');seen.add(p.uid);people.push(p);}
      if(people.length>3000||page.next_cursor&&page.next_cursor===cursor||page.next_cursor&&page.items.length===0)throw Error('לא ניתן להשלים את רשימת העובדים.');
      cursor=page.next_cursor;if(cursor){if(cursors.has(cursor))throw Error('סמן עמוד חוזר');cursors.add(cursor);}progress('נמצאו '+people.length+' עובדים');
    }while(cursor);
    if(!people.length)throw Error('אין עובדים להפקה בחודש שנבחר.');
    const summary=[['שם','מספר עובד','משמרת','מצב','פעילות','שעות שמורות','שעות בפירוט נוכחי']],missing=[];
    for(let i=0;i<people.length;i++){check();const value=await adapter.getEmployeeMonth({month,uid:people[i].uid},{forceFresh:true});check();const p=value?.report;
      if(value?.freshness?.source!=='server'||!p||p.uid!==people[i].uid||p.month!==month||!Object.hasOwn(states,p.state)||!Array.isArray(p.rows)||p.rows.length>31||!Array.isArray(p.warnings)||p.detail_provenance!=='current_attendance_not_historical_snapshot')throw Error('לא התקבל דוח עדכני ותקין; ההפקה נעצרה.');
      validateDetailedReport(p,month,'פרטי הדוח אינם תקינים; לא הורד ארכיון חלקי.');
      const title=folder+' — '+p.full_name;
      const data=await pdf(title,[...reportLines(p),'תחילת הפקה: '+started],check);check();
      add('דוחות/'+String(i+1).padStart(4,'0')+' - '+safeName(p.full_name)+' - '+safeName(p.employee_number)+'.pdf',data);
      summary.push([p.full_name,p.employee_number,p.crew,states[p.state],p.historical?'רשומת עבר':'פעיל',num(p.stored_total_hours),num(p.current_detail_total_hours)]);
      if(p.state==='missing')missing.push(p.full_name+' | '+p.employee_number+' | '+(p.historical?'רשומת עבר':'פעיל'));
      progress('הוכנו '+(i+1)+' מתוך '+people.length+' דוחות');
    }
    add('סיכום.csv',enc.encode('\ufeff'+summary.map(row=>row.map(csvCell).join(',')).join('\r\n')));
    add('סיכום.pdf',await pdf(folder+' — סיכום',summary.map(row=>row.join(' | ')),check));check();
    add('לא הגישו.pdf',await pdf(folder+' — לא הגישו',missing.length?missing:['כל העובדים ברשימה הגישו דוח; ראו סטטוס אישור בסיכום.'],check));check();
    const completed=new Date().toISOString();
    add('מידע על ההפקה.txt',enc.encode('תחילת הפקה: '+started+'\nסיום קריאות: '+completed+'\nמספר עובדים: '+people.length+'\nהיקף: רשומות העובדים הזמינות בתחנה בעת ההפקה, לרבות רשומות עבר שנשמרו.\nהנתונים נקראו במהלך פרק זמן, אינם תמונת מצב אטומית ואינם גרסה היסטורית חתומה.\nPDF חזותי להדפסה; טקסט ניתן לעיבוד בסיכום CSV.\nהקבצים המקומיים אינם ניתנים לביטול מרחוק.'));
    check();await adapter.listMonth({month});check(); // Fresh server authorization before delivery, never cached.
    const result=zipFiles(files);check();return {bytes:result,name:folder+'.zip',count:people.length};
  }finally{files.length=0;people.length=0;adapter.clearReportCache?.();}
}
