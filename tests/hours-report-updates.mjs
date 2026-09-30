import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../report.js',import.meta.url),'utf8');
const {reportHtml,REPORT_CSS}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const head={month:'2026-09',station_name:'Must not substitute for a missing row station'};
for(const type of ['reserve','reserve_shift','sick','vacation','course']){
 const html=reportHtml(head,[{date:'2026-09-30',day_type:type,start:'07:00',end:'09:00',end_day:1,site_name:'<Synthetic>',hours:34.5}]);
 for(const label of ['שעת כניסה','שעת יציאה','תחנה'])assert(html.includes('<th>'+label+'</th>'));
 assert(html.includes('&lt;Synthetic&gt;'));assert(html.includes('למחרת'));
 assert(html.includes('day-'+(type==='reserve_shift'?'reserve':type)));
}
const missing=reportHtml(head,[{date:'2026-09-30',day_type:'reserve_shift',hours:8.5}]);
assert(missing.includes('<td>לא צוינה</td>'));assert(missing.includes('<td>—</td><td>—</td>'));
const sameDay=reportHtml(head,[{date:'2026-09-30',start:'07:00',end:'09:00',end_day:0}]);
assert(!sameDay.includes('למחרת'));
const split=reportHtml(head,[{date:'2026-09-30',start:'07:00',end:'09:00',end_day:0,start2:'23:00',end2:'01:00',end_day2:1}]);
assert(split.includes('23:00–01:00'));assert(split.includes('למחרת'));
assert(REPORT_CSS.includes('print-color-adjust:exact'));
console.log('Hours report updates: labels, escaped/missing station, explicit offsets, five category colors PASS. Synthetic data only.');
