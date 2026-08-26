// בדל Firestore. מחזיר נתונים אמיתיים למספיק נתיבים כדי שהמסכים
// יגיעו לתצוגה שלהם ולא רק למצב הריק — מסך ריק עובר כל בדיקה
// גם כשהקוד שמצייר אותו שבור.

const PROFILE = {
  full_name: 'אלדד יונה', employee_number: '1', email: 'eldad50@gmail.com',
  phone: '054-924-7119', role: 'firefighter', crew: 'C',
  station: 'eilat_102', district: 'south', is_active: true
};

const QUALS = [
  ['q1', { name: 'נהג מפעיל משאבה', order: 1, active: true }],
  ['q2', { name: 'נושם אוויר דחוס', order: 2, active: true }],
  ['q3', { name: 'חובש',            order: 3, active: true }]
];

const ROSTER = [
  ['u1', { full_name: 'אלדד יונה',  role: 'commander',   crew: 'C', is_active: true }],
  ['u2', { full_name: 'טל חודרה',   role: 'firefighter', crew: 'A', is_active: true }],
  ['u3', { full_name: 'משה טויטו',  role: 'firefighter', crew: 'A', is_active: true }],
  ['u4', { full_name: 'דנה לוי',    role: 'firefighter', crew: 'B', is_active: true }],
  ['u5', { full_name: 'עזב מזמן',   role: 'firefighter', crew: 'B', is_active: false }]
];

// מסמכי users עבור בורר תיקון השעות. המספרים וה-uid שונים
// כדי שבדיקת race תוכל לעבור לאדם אחר ולחזור למשתמש המחובר.
const USERS = [
  ['u2', { full_name:'טל חודרה', employee_number:'17', role:'firefighter',
           crew:'A', is_active:true }],
  ['u4', { full_name:'דנה לוי', employee_number:'21', role:'firefighter',
           crew:'B', is_active:true }]
];

// קריאת פתע פתוחה, שנשלחה למשתמש הבדיקה. מאפשרת לוודא שהחלון
// באמת קופץ, ושהמונים במסך המפקד סופרים נכון.
const CALLOUTS = [
  ['co1', { by_uid: 'u1', by_name: 'אלדד יונה', by_role_he: 'מפקד משמרת',
            target: 'crew:C', target_he: "משמרת ג'", crew: 'C',
            text: 'שריפה במתחם התעשייה. התייצבות מיידית בתחנה.',
            uids: ['stub-uid', 'u2', 'u3'], active: true, when_he: '14:20',
            acks: { u2: { resp: 'coming', name: 'טל חודרה', at: '' } },
            created_key: new Date().toISOString() }]
];

// אבטחות. שלוש מצבים שונים כדי שכל מסלול במסך ייבדק:
// אחת פתוחה עם נרשמים, אחת משובצת עם המשתמש עצמו, אחת שעברה.
const GUARDS = [
  // מסומנת כנתון הדגמה — כדי לוודא שהמחיקה מוצאת בדיוק את
  // אלה, ורק אותן.
  ['gdemo', { title: 'אבטחת בדיקה', kind: 'sport', date: '2099-05-05',
              start: '10:00', end: '12:00', slots: 1, status: 'open',
              signups: {}, assigned: [], __demo: true,
              created_key: '2099-05-01T08:00:00.000Z' }],
  ['g1', { title: 'משחק ליגה', kind: 'sport', place: 'טוטו טרנר',
           date: '2099-01-10', start: '18:00', end: '23:00', slots: 2,
           need_quals: [], notes: '', status: 'open',
           signups: { u2: { name: 'טל חודרה', crew: 'A', at: '' },
                      u4: { name: 'דנה לוי',  crew: 'B', at: '' } },
           assigned: [], by_uid: 'u1', by_name: 'אלדד יונה',
           created_key: '2099-01-01T08:00:00.000Z' }],
  ['g2', { title: 'הופעה בפארק', kind: 'show', place: 'פארק העיר',
           date: '2099-02-14', start: '20:00', end: '01:00', slots: 2,
           need_quals: ['q1'], notes: 'רכב סער', status: 'staffed',
           signups: {}, assigned: ['stub-uid', 'u3'],
           by_uid: 'u1', by_name: 'אלדד יונה',
           created_key: '2099-01-02T08:00:00.000Z' }],
  ['g3', { title: 'עבודות חמות', kind: 'hotwork', place: 'מספנה',
           date: '2020-03-05', start: '08:00', end: '14:00', slots: 1,
           need_quals: [], notes: '', status: 'done',
           signups: {}, assigned: ['u2'],
           by_uid: 'u1', by_name: 'אלדד יונה',
           created_key: '2020-03-01T08:00:00.000Z' }]
];

// תקלות. אחת משביתה עם צילום, אחת מגבילה, אחת סגורה, והערת
// חפיפה — כדי שכל ענף במסך ייבדק.
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// ארבע תמונות הרכב. תמונת פיקסל אחד מספיקה לבדיקה: מה שנבדק
// הוא שהתמונה נטענת ושהנקודות יושבות עליה באחוזים, לא איך היא
// נראית.
const VIEWS = [
  ['v2__right', { vehicle_id:'v2', side:'right', photo:PNG1, w:1600, h:900,
                  by_uid:'u1', by_name:'אלדד יונה',
                  created_key:'2026-08-01T07:00:00.000Z' }],
  ['v2__rear',  { vehicle_id:'v2', side:'rear', photo:PNG1, w:1600, h:1200,
                  by_uid:'u1', by_name:'אלדד יונה',
                  created_key:'2026-08-01T07:05:00.000Z' }]
];

const FAULTS = [
  ['f1', { kind:'vehicle', vehicle_id:'v1', vehicle_name:'רכב אלמוג',
           title:'נזילת שמן מתחת למנוע', desc:'שלולית מתחת לרכב אחרי החניה.',
           severity:'blocking', status:'open', photos:1,
           by_uid:'u1', by_name:'אלדד יונה', crew:'C', date:'2026-08-23',
           created_key:'2026-08-23T07:40:00.000Z' }],
  ['f2', { kind:'vehicle', vehicle_id:'v2', vehicle_name:'רכב געש',
           title:'פנס אחורי שמאלי שרוף', desc:'', severity:'limiting',
           status:'in_repair', photos:0,
           by_uid:'u2', by_name:'טל חודרה', crew:'A', date:'2026-08-20',
           created_key:'2026-08-20T11:05:00.000Z' }],
  ['f3', { kind:'gear', vehicle_id:'', vehicle_name:'',
           title:'מסכה מספר 4 — רצועה קרועה', desc:'הוחלפה.',
           severity:'minor', status:'fixed', photos:0,
           by_uid:'u3', by_name:'משה טויטו', crew:'A', date:'2026-08-18',
           created_key:'2026-08-18T09:00:00.000Z',
           fixed_by_name:'משה טויטו', fix_note:'הוחלפה רצועה מהמלאי' }],
  // פגיעה. לא נסגרת, לא מדורגת — נמחקת רק אחרי תיקון במוסך.
  ['d1', { kind:'damage', vehicle_id:'v2', vehicle_name:'רכב געש',
           title:'מכה בדופן ימין אחורי', desc:'נגיעה בעמוד בחניון.',
           severity:'minor', status:'open', photos:0,
           side:'right', x:0.34, y:0.58,
           by_uid:'u3', by_name:'משה טויטו', crew:'A', date:'2026-08-17',
           created_key:'2026-08-17T16:40:00.000Z' }],
  // שתי נקודות נוספות על אותו צד, כדי שהמיספור והמיון ייבדקו
  // ולא רק "נקודה אחת מצוירת".
  ['d2', { kind:'damage', vehicle_id:'v2', vehicle_name:'רכב געש',
           title:'שריטה מתחת לידית דלת', desc:'לא פוגע בתפקוד.',
           severity:'unset', status:'open', photos:0,
           side:'right', x:0.62, y:0.47,
           by_uid:'u2', by_name:'טל חודרה', crew:'A', date:'2026-08-19',
           created_key:'2026-08-19T08:15:00.000Z' }],
  ['d3', { kind:'damage', vehicle_id:'v2', vehicle_name:'רכב געש',
           title:'שפשוף בפגוש אחורי', desc:'תוקן במוסך.',
           severity:'minor', status:'fixed', photos:0,
           side:'rear', x:0.5, y:0.72,
           by_uid:'u1', by_name:'אלדד יונה', crew:'C', date:'2026-08-10',
           created_key:'2026-08-10T12:00:00.000Z' }],
  // דווחה בידי כבאי — ממתינה להערכת ראש המשמרת.
  ['f5', { kind:'vehicle', vehicle_id:'a1', vehicle_name:'טרנזיט לבן',
           title:'רעש מהבלמים', desc:'חריקה בבלימה חזקה.',
           severity:'unset', status:'open', photos:0,
           by_uid:'u2', by_name:'טל חודרה', crew:'A', date:'2026-08-23',
           created_key:'2026-08-23T06:10:00.000Z' }],
  ['f4', { kind:'note', vehicle_id:'', vehicle_name:'',
           title:'מים בעמדת הכיבוי נסגרו לתחזוקה', desc:'חוזר מחר בבוקר.',
           severity:'minor', status:'open', photos:0,
           by_uid:'u4', by_name:'דנה לוי', crew:'B', date:'2026-08-22',
           created_key:'2026-08-22T18:20:00.000Z' }]
];

const FAULT_PHOTOS = [
  ['p0', { data: PNG1, w: 1, h: 1, by_uid: 'u1',
           created_key: '2026-08-23T07:40:00.000Z' }]
];

// הגשות טפסים: חופשה מאושרת, חופשה ממתינה, ודוח פציעה סגור.
const SUBS = [
  ['s1', { form_id:'leave', form_he:'בקשת חופשה',
    values:{ from:'2026-08-24', to:'2026-08-27', where:'בחו״ל',
             phone:'050-0000000', why:'' },
    signature:'', is_private:false, status:'approved',
    by_uid:'u2', by_name:'טל חודרה', by_emp:'17', crew:'A',
    decided_by_name:'אלדד יונה',
    created_key:'2026-08-18T09:00:00.000Z' }],
  ['s2', { form_id:'leave', form_he:'בקשת חופשה',
    values:{ from:'2026-09-01', to:'2026-09-03', where:'באילת' },
    signature:'', is_private:false, status:'submitted',
    by_uid:'u4', by_name:'דנה לוי', by_emp:'21', crew:'B',
    created_key:'2026-08-22T12:00:00.000Z' }],
  ['s3', { form_id:'injury', form_he:'דוח פציעה',
    values:{ date:'2026-08-19', time:'14:20', where:'חצר התחנה',
             what:'החלקה על רצפה רטובה', hurt:'קרסול ימין', med:'כן' },
    signature:'', is_private:true, status:'submitted',
    by_uid:'u3', by_name:'משה טויטו', by_emp:'19', crew:'A',
    created_key:'2026-08-19T15:00:00.000Z' }]
];

// ---------- תאריכים יחסיים ----------
//
// רוב הנתונים המדומים יושבים על תאריכים קבועים, וזה בסדר:
// הם רק צריכים להיראות. שתי רשומות הן יוצאות דופן — המסך
// משווה אותן ל**היום**, ולכן תאריך קבוע בהן מתיישן.
//
// היתר קו אדום תקף ליום אחד בלבד (כך כתוב במסך עצמו). היתר
// של אתמול פשוט לא קיים היום, והבדיקה של מפקד התחנה הייתה
// נכשלת כל בוקר — לא בגלל באג אלא בגלל שעבר יום.
function dayKey(shift){
  const d = new Date();
  d.setDate(d.getDate() + (shift || 0));
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}
const TODAY = dayKey(0), YESTERDAY = dayKey(-1);

// היתר לרדת מקו אדום, ממתין לאישור מפקד התחנה.
const WAIVERS = [
  ['A_' + TODAY, { crew:'A', date:TODAY, status:'pending',
    by_uid:'u4', by_name:'דנה לוי',
    created_key: TODAY + 'T07:05:00.000Z' }]
];

// מסירות אחריות. אחת מאתמול, כדי שהלוג יראה משהו.
const HANDOVERS = [
  ['A_' + YESTERDAY, { crew:'A', date:YESTERDAY,
    from_uid:'u4', from_name:'דנה לוי', to_uid:'u2', to_name:'טל חודרה',
    assessment:'שער כניסה נתקע פעמיים. מוקד עודכן.',
    accepted_key: YESTERDAY + 'T07:12:00.000Z' }]
];

// משימות תחזוקה פתוחות.
const TASKS_EXTRA = [
  ['t1', { kind:'task_st', vehicle_id:'', vehicle_name:'',
    title:'בדיקת עמדות כיבוי בקומה 2', desc:'לא בוצע החודש.',
    severity:'minor', status:'open', photos:0,
    by_uid:'u1', by_name:'אלדד יונה', crew:'C', date:'2026-08-21',
    created_key:'2026-08-21T10:00:00.000Z' }],
  ['t2', { kind:'task_eq', vehicle_id:'', vehicle_name:'',
    title:'כיול מד גז נייד', desc:'',
    severity:'limiting', status:'open', photos:0,
    by_uid:'u2', by_name:'טל חודרה', crew:'A', date:'2026-08-19',
    created_key:'2026-08-19T14:30:00.000Z' }]
];

// רכבי עיגון.
const VEHICLES = [
  ['a1', { name:'טרנזיט לבן', plate:'12-345-67', kind:'anchor' }],
  ['a2', { name:'טנדר לוגיסטי', plate:'98-765-43', kind:'anchor' }]
];

const MEMBER_QUALS = [
  ['u1', { quals: ['q1', 'q3'] }],
  ['u2', { quals: ['q2'] }],
  ['u4', { quals: ['q1', 'q2'] }]
];

const REDLINE = { min_headcount: 3, min_quals: { q1: 1, q2: 2 } };

const BOARD = {
  command: [
    { id: 'c1', rank: 'מפקד משמרת',     req: ''   },
    { id: 'c2', rank: 'סגן מפקד משמרת', req: ''   },
    { id: 'c3', rank: 'קצין אשכול',     req: ''   },
    { id: 'c4', rank: 'קצין חומ״ס',     req: 'q3' }
  ],
  vehicles: [
    { id: 'v1', name: 'רכב אלמוג', role: 'חומ״ס', slots: [
      { id: 's11', job: 'נהג מפעיל משאבה', req: 'q1' },
      { id: 's12', job: 'כבאי בכיר',       req: 'q2' },
      { id: 's13', job: 'ר. משמרת',        req: ''   }
    ]},
    { id: 'v2', name: 'רכב געש', role: 'חילוץ', slots: [
      { id: 's21', job: 'נהג מפעיל משאבה', req: 'q1' },
      { id: 's22', job: 'כבאי',            req: 'q2', site: 'shahmon' },
      { id: 's23', job: 'ר. משמרת',        req: '',   site: 'rashit'  }
    ]},
    { id: 'v3', name: 'רכב סער', role: 'כיבוי', slots: [
      { id: 's31', job: 'חובש',     req: 'q3' },
      { id: 's32', job: 'ר. משמרת', req: ''   }
    ]}
  ]
};

// u1 אלדד: q1,q3 · u2 טל: q2 · u4 דנה: q1,q2
// s12 דורש q2 ומאויש ב-u1 שאין לו — זו אי-ההתאמה שהמסך אמור לצבוע.
const SHIFT = { assign: {
  c1: 'u1', c2: 'u4', c3: 'u2',
  s11: 'u4', s12: 'u1',
  s21: 'u4', s22: 'u2', s23: 'stub-uid',
  s31: 'u1'
} };

// מחזור סידור: שלוש משמרות במחזור של שלושה ימים, מעוגן לתאריך
// קבוע. בלעדיו לוח החודש נטען ריק — וכל בדיקה עליו עוברת בלי
// לבדוק כלום.
const ROTATIONS = [
  ['r1', { crew: 'A', position_in_cycle: 0, cycle_days: 3,
           anchor_date: '2026-01-01', is_active: true,
           shift_start: '07:00', shift_end: '07:00', shift_hours: 24 }],
  ['r2', { crew: 'B', position_in_cycle: 1, cycle_days: 3,
           anchor_date: '2026-01-01', is_active: true }],
  ['r3', { crew: 'C', position_in_cycle: 2, cycle_days: 3,
           anchor_date: '2026-01-01', is_active: true }]
];

// חריגות בסידור, כדי שהלוח ייבדק עם שבירה של המחזור ולא רק
// עם הנוסחה המושלמת.
const OVERRIDES = [
  ['2026-08-14', { date:'2026-08-14', kind:'swap', crew:'A', extra_crews:[],
                   note:'ב\' החליפה את א\'' }],
  ['2026-08-20', { date:'2026-08-20', kind:'training', crew:'', extra_crews:[],
                   note:'תרגיל חילוץ' }],
  ['2026-08-25', { date:'2026-08-25', kind:'standby', crew:'', extra_crews:['B'],
                   note:'שריפת יער' }]
];

const SITES = [
  ['rashit',  { name:'ראשית', fixed_hours:0,  order:1 }],
  ['shahmon', { name:'שחמון', fixed_hours:0,  order:2 }],
  ['timna',   { name:'תמנע',  fixed_hours:0,  order:3 }],
  ['yotvata', { name:'יטבתה', fixed_hours:25, order:4 }]
];

// דיווחי נוכחות לחודש אוגוסט 2026 של מספר עובד 1.
const ATTENDANCE = [
  ['1_2026-08-01', { emp_number:'1', uid:'stub-uid', full_name:'אלדד יונה',
                     crew:'C', date:'2026-08-01', month:'2026-08',
                     day_type:'regular', start:'07:00', end:'07:00',
                     sub_station:'', notes:'', status:'draft', hours:24 }],
  ['1_2026-08-04', { emp_number:'1', uid:'stub-uid', full_name:'אלדד יונה',
                     crew:'C', date:'2026-08-04', month:'2026-08',
                     day_type:'regular', start:'07:00', end:'08:00',
                     sub_station:'yotvata', notes:'אבטחת אירוע ספורט · אצטדיון טוטו טרנר', status:'draft', hours:25 }],
  ['1_2026-08-07', { emp_number:'1', uid:'stub-uid', full_name:'אלדד יונה',
                     crew:'C', date:'2026-08-07', month:'2026-08',
                     day_type:'vacation', start:'', end:'',
                     sub_station:'', notes:'', status:'draft', hours:24 }],
  ['1_2026-08-10', { emp_number:'1', uid:'stub-uid', full_name:'אלדד יונה',
                     crew:'C', date:'2026-08-10', month:'2026-08',
                     day_type:'reserve', start:'', end:'',
                     sub_station:'', notes:'יצא מוקדם — אישור ראש משמרת', status:'draft', hours:8.5 }],
  // משמרת מפוצלת
  ['1_2026-08-13', { emp_number:'1', uid:'stub-uid', full_name:'אלדד יונה',
                     crew:'C', date:'2026-08-13', month:'2026-08',
                     day_type:'regular', start:'07:00', end:'13:00', end_day:0,
                     start2:'17:00', end2:'23:00', end_day2:0,
                     sub_station:'', notes:'', status:'draft', hours:12 }],
  // שעות נוספות עם נימוק
  ['1_2026-08-16', { emp_number:'1', uid:'stub-uid', full_name:'אלדד יונה',
                     crew:'C', date:'2026-08-16', month:'2026-08',
                     day_type:'regular', start:'07:00', end:'09:00', end_day:1,
                     sub_station:'', notes:'', status:'draft', hours:26,
                     overtime_reason:'שריפה בשחמון, נשארתי עד ההחלפה' }],
  // שעות נוספות בלי נימוק — חייב להיתפס בסיכום
  ['1_2026-08-19', { emp_number:'1', uid:'stub-uid', full_name:'אלדד יונה',
                     crew:'C', date:'2026-08-19', month:'2026-08',
                     day_type:'regular', start:'07:00', end:'10:00', end_day:1,
                     sub_station:'', notes:'', status:'draft', hours:27 }]
];

const REPORTS = [
  ['5_2026-08', { emp_number:'5', full_name:'טל חודרה', crew:'B',
                  month:'2026-08', status:'submitted', total_hours:192,
                  days:['2026-08-02','2026-08-05'] }],
  ['17_2026-08',{ emp_number:'17', full_name:'משה טויטו', crew:'A',
                  month:'2026-08', status:'submitted', total_hours:168,
                  days:['2026-08-03'] }]
];

// החלפות משמרת במצבים שונים, כדי שכל שלב במסלול ייבדק.
// בקשה פתוחה שמחכה שמישהו יתפוס — המסלול החדש.
const OPEN_SWAP = ['sw9', { from_uid:'u2', from_name:'טל חודרה', from_crew:'A',
  from_date:'2026-09-04', to_uid:'', to_name:'', to_crew:'', to_date:'',
  want_crew:'', note:'חתונה של אח שלי', status:'open',
  created_key:'2026-08-23T06:00:00.000Z' }];

const SWAPS = [
  ['s1', { from_uid:'u2', from_emp:'17', from_name:'טל חודרה', from_crew:'A',
           from_date:'2026-08-14',
           to_uid:'stub-uid', to_emp:'', to_name:'אלדד יונה', to_crew:'C',
           to_date:'2026-08-19', note:'חתונה של אחותי',
           status:'peer', created_key:'2026-08-10T09:00:00Z' }],
  ['s2', { from_uid:'u4', from_emp:'9', from_name:'דנה לוי', from_crew:'B',
           from_date:'2026-08-16',
           to_uid:'u3', to_emp:'', to_name:'משה טויטו', to_crew:'A',
           to_date:'2026-08-22', note:'',
           status:'cmd_from', peer_name:'משה טויטו',
           created_key:'2026-08-09T09:00:00Z' }],
  ['s3', { from_uid:'u1', from_emp:'1', from_name:'אלדד יונה', from_crew:'C',
           from_date:'2026-08-25',
           to_uid:'u2', to_emp:'', to_name:'טל חודרה', to_crew:'A',
           to_date:'2026-08-28', note:'',
           status:'cmd_to', peer_name:'טל חודרה',
           from_appr_name:'רמי חנן',
           created_key:'2026-08-08T09:00:00Z' }],
  // מאושרת ונוגעת למשתמש הבדל: הוא יוצא ב-1.8 ונכנס ב-5.8.
  ['s4', { from_uid:'stub-uid', from_emp:'1', from_name:'אלדד יונה', from_crew:'C',
           from_date:'2026-08-01',
           to_uid:'u3', to_emp:'14', to_name:'משה טויטו', to_crew:'A',
           to_date:'2026-08-05', note:'',
           status:'approved', peer_name:'משה טויטו',
           from_appr_name:'רמי חנן', to_appr_name:'אייל טויטו',
           created_key:'2026-08-01T09:00:00Z' }],
  ['s5', { from_uid:'u2', from_emp:'17', from_name:'טל חודרה', from_crew:'A',
           from_date:'2026-08-02',
           to_uid:'u1', to_emp:'1', to_name:'אלדד יונה', to_crew:'C',
           to_date:'2026-08-07', note:'',
           status:'rejected', peer_name:'אלדד יונה',
           reject_name:'רמי חנן', reject_reason:'המשמרת נשארת בלי נהג משאבה',
           created_key:'2026-07-30T09:00:00Z' }]
];

function docSnap(data, id){
  return { exists: () => true, data: () => data, id: id || 'stub' };
}
function listSnap(pairs){
  const docs = pairs.map(p => docSnap(p[1], p[0]));
  return {
    empty: docs.length === 0, size: docs.length, docs: docs,
    forEach(fn){ docs.forEach(fn); }
  };
}
const EMPTY_QUERY = listSnap([]);

let seq = 0;

export function getFirestore(){ return {}; }

// doc(db, 'a', 'b', ...)  → הפניה לנתיב
// doc(collectionRef)      → מזהה חדש, כמו ב-SDK האמיתי
export function doc(first, ...rest){
  if (rest.length === 0) return { id: 'gen' + (++seq), path: (first && first.path) || '' };
  return { id: rest[rest.length - 1], path: rest.join('/') };
}
export function collection(db, ...segs){ return { path: segs.join('/') }; }

export function query(base){ return { path: (base && base.path) || '' }; }
export function where(){ return {}; }
export function orderBy(){ return {}; }
export function limit(){ return {}; }

export function getDoc(ref){
  const p = (ref && ref.path) || '';
  return lag(null, p).then(() => getDoc0(ref));
}

function getDoc0(ref){
  const p = (ref && ref.path) || '';
  if (p.indexOf('config/redline') !== -1) return Promise.resolve(docSnap(REDLINE, 'redline'));
  if (p.indexOf('config/board') !== -1)   return Promise.resolve(docSnap(BOARD, 'board'));
  if (/\/shifts\//.test(p))               return Promise.resolve(docSnap(SHIFT, 'shift'));
  return Promise.resolve(docSnap(PROFILE));
}

SWAPS.push(OPEN_SWAP);

FAULTS.push.apply(FAULTS, TASKS_EXTRA);

// השהיה מלאכותית למדידת ביצועים בלבד. נדלקת רק כשהבדיקה
// מבקשת אותה, ולכן אינה משפיעה על שאר הבדיקות.
const LAG = (typeof window !== 'undefined' && window.__SMOKE_LAG) || 0;
// מדידה: מתי יצאה הבקשה הראשונה, ומתי חזרה האחרונה.
// זה הזמן שהמשתמש מחכה בו למסך ריק.
function mark(path){
  if (typeof window === 'undefined') return;
  if (!window.__T0) window.__T0 = Date.now();
  window.__N = (window.__N || 0) + 1;
  window.__DATA_PATHS = window.__DATA_PATHS || [];
  window.__DATA_PATHS.push(path || '');
}
function done(){
  if (typeof window === 'undefined') return;
  window.__TN = Date.now();
}
function lag(v, path){
  mark(path);
  const plan = (typeof window !== 'undefined') ? window.__SMOKE_LAG_PLAN : null;
  const wait = Array.isArray(plan) && plan.length
    ? Number(plan.shift()) || 0
    : Number(LAG) || 0;
  if (!wait) { done(); return Promise.resolve(v); }
  return new Promise(r => setTimeout(function () { done(); r(v); }, wait));
}

export function getDocs(q){
  const p = (q && q.path) || '';
  const delayed = value => lag(value, p);
  if (/\/quals$/.test(p))        return delayed(listSnap(QUALS));
  if (/\/roster$/.test(p))       return delayed(listSnap(ROSTER));
  if (/\/users$/.test(p))        return delayed(listSnap(USERS));
  if (/\/member_quals$/.test(p)) return delayed(listSnap(MEMBER_QUALS));
  if (/\/rotations$/.test(p))    return delayed(listSnap(ROTATIONS));
  if (/\/shift_overrides$/.test(p)) return delayed(listSnap(OVERRIDES));
  if (/\/sub_stations$/.test(p))    return delayed(listSnap(SITES));
  if (/\/attendance$/.test(p))      return delayed(listSnap(ATTENDANCE));
  if (/\/monthly_reports$/.test(p)) return delayed(listSnap(REPORTS));
  if (/\/swaps$/.test(p))           return delayed(listSnap(SWAPS));
  if (/\/callouts$/.test(p))        return delayed(listSnap(CALLOUTS));
  if (/\/guards$/.test(p))          return delayed(listSnap(GUARDS));
  if (/\/photos$/.test(p))          return delayed(listSnap(FAULT_PHOTOS));
  if (/\/faults$/.test(p))          return delayed(listSnap(FAULTS));
  if (/\/vehicles$/.test(p))        return delayed(listSnap(VEHICLES));
  if (/\/vehicle_views$/.test(p))   return delayed(listSnap(VIEWS));
  if (/\/handovers$/.test(p))       return delayed(listSnap(HANDOVERS));
  if (/\/redline_waivers$/.test(p)) return delayed(listSnap(WAIVERS));
  if (/\/submissions$/.test(p))     return delayed(listSnap(SUBS));
  return delayed(EMPTY_QUERY);
}

export function updateDoc(){ return Promise.resolve(); }

// מאזין מדומה: מוסר את התוצאה פעם אחת ומחזיר פונקציית ביטול.
// מספיק כדי לבדוק שהחלון קופץ ושהרשימות מצוירות; אין כאן
// עדכון חי, ואין בו צורך בבדיקה.
export function onSnapshot(q, next, err){
  const p = (q && q.path) || '';
  const fn = typeof next === 'function' ? next : (next && next.next);
  if (fn) {
    getDocs({ path: p }).then(s => { try { fn(s); } catch (e) {} });
  }
  return function(){};
}

export function addDoc(){ return Promise.resolve({ id: 'new1' }); }
export function setDoc(){ return Promise.resolve(); }
export function deleteDoc(){ return Promise.resolve(); }
export function serverTimestamp(){ return null; }
export function writeBatch(){
  return { set(){}, delete(){}, commit(){ return Promise.resolve(); } };
}
