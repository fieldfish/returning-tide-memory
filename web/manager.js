import {ui} from './i18n.mjs'
'use strict'
const token=location.hash.slice(1)||sessionStorage.getItem('continuity-manager-token')||'';if(token)sessionStorage.setItem('continuity-manager-token',token);history.replaceState(null,'',location.pathname)
const $=id=>document.getElementById(id),state={overview:null,library:null,taskPage:null,taskDetail:null,situationPage:null,extractionConfig:null}
let busy=false
const labels={planned:ui('待执行'),not_started:ui('确认未执行'),running:ui('执行中'),succeeded:ui('宿主报告成功'),failed:ui('明确失败'),uncertain:ui('结果未知'),reviewed:ui('已核查'),abandoned:ui('放弃重放'),result_recorded:ui('已收到结果')}
const memoryLabels={ready:ui('已准备，尚不代表已使用'),cleared:ui('已清空临时召回'),unavailable:ui('召回不可用'),busy:ui('召回尚未结束'),'index-incomplete':ui('索引补建中'),'no-admissible-evidence':ui('没有符合自动准入的候选'),empty:ui('尚无工作集')}
const slotLabels={background:ui('背景'),goal:ui('计划／目标'),progress:ui('进度表述'),question:ui('未解问题'),'self-report':ui('自述'),interpretation:ui('后来理解'),'source-claim':ui('外部来源说法')}
const modeLabels={unknown:ui('类型未定'),experience:ui('经历类记录'),creative:ui('创作类记录'),mixed:ui('混合记录')}
const readableProjection=value=>String(value||'').replace(/\[(explicit|model-consolidated):([a-z-]+)\]/g,(_all,origin,slot)=>(origin==='model-consolidated'?ui('模型整理 · '):'')+(slotLabels[slot]||slot)+'：')
const phaseLabels={requested:ui('已记录请求'),'host-returned':ui('宿主已返回'),'host-error':ui('宿主返回错误'),'host-outcome-unknown':ui('结果仍未知'),reported:ui('观察报告'),'host-node':ui('任务节点')}
async function api(action,args={}){const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action,...args})});const v=await r.json();if(!v.ok)throw Error(v.message||v.error);return v.result}
function notice(s){$('notice').textContent=s}
async function work(fn){if(busy)return;busy=true;document.querySelectorAll('button,input,select').forEach(b=>b.disabled=true);try{await fn()}catch(e){notice(ui('未完成：')+e.message)}finally{busy=false;document.querySelectorAll('button,input,select').forEach(b=>b.disabled=false);taskNav();activityNav();ownership()}}
function select(id,items,value,label){const el=$(id);el.replaceChildren();for(const item of items){const o=document.createElement('option');o.value=value(item);o.textContent=label(item);el.append(o)}}
function text(tag,value,cls){const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e}
const sessionStatus={idle:ui('空闲'),running:ui('运行中'),error:ui('异常')}
const titleOf=session=>session?.title&&session.title!==session.id?session.title:ui('未命名会话')
function sessionLabel(session){const title=titleOf(session),matching=state.overview.sessions.filter(other=>titleOf(other)===title),duplicate=matching.length>1,suffix=session.id.slice(-8),ambiguous=matching.some(other=>other.id!==session.id&&other.id.slice(-8)===suffix);return title+(duplicate?' · '+(ambiguous?session.id:suffix):'')+' · '+(sessionStatus[session.status]||session.status)}
function sessionDetails(){const owner=state.library?.owner;$('sessionDetails').textContent=ui('当前主会话 ID：')+(owner||ui('尚未绑定'))+ui('\n所选会话 ID：')+($('session').value||ui('尚未选择'));ownership()}
function ownership(){
 const lib=state.library,owner=lib?.owner,target=$('session').value,session=state.overview?.sessions.find(s=>s.id===owner),title=lib?.owner_title||session?.title||ui('主会话未加载或尚未命名'),different=!!owner&&!!target&&owner!==target
 $('ownerBanner').textContent=lib?ui('当前主会话：')+(owner?title:ui('尚未绑定'))+(different?ui(' · 所选会话不同；不会自动抢占，需显式交接。'):ui(' · 一库一主，其他窗口不会自动接管。')):ui('还没有记忆库。可以先创建一个独立库。')
 $('ownerBanner').classList.toggle('warning',different)
 if(!busy){$('bind').disabled=!lib||!!owner||!target;$('handoff').disabled=!lib||!owner||!different}
}
$('recoveryJump').onclick=()=>{$('recoveryPanel').scrollIntoView({behavior:'smooth',block:'start'});$('recoveryPanel').focus({preventScroll:true})}
function healthBanners(r){
 const incomplete=r.embedding.index_work_remaining||r.working?.frame?.status==='index-incomplete',count=r.recovery.operations.length+r.recovery.legacy.length
 $('indexBanner').hidden=!incomplete
 $('indexBanner').textContent=ui('索引未完成，原文仍在，召回结果可能不全。')+ui` 已索引 ${r.embedding.indexed_parts??0}，待索引 ${r.embedding.pending_parts??0}，尚未分片 ${r.embedding.unprepared_records??0}。`
 $('recoveryBanner').hidden=!count
 $('recoveryMessage').textContent=ui`有 ${count} 项操作结果待核对。仅写操作受限，聊天和已识别的只读查阅仍可用；不会自动重放。`
 const cards=$('recallCards');if(cards){cards.replaceChildren();for(const c of r.recall_cards||[]){const row=text('div','','item'),title=c.title.replace(/^(对话|旧文件|旧笔记|工具|笔记)·/,(_all,label)=>ui(label)+' · ');row.append(text('strong',title),text('div',c.id+' · '+c.score+' · '+c.time,'small'),text('p',c.summary),text('blockquote',c.quote||''));cards.append(row)}}
}
// Refresh only operational indicators; never overwrite forms or a human review in progress.
setInterval(async()=>{if(busy||document.hidden||!state.library)return;const id=state.library.id;try{const r=await api('health',{library_id:id});if(state.library?.id!==id||busy)return;state.library=r.library;healthBanners(r);ownership()}catch{notice(ui('状态刷新失败，请点击刷新核对；未改动记忆。'))}},10000)
async function refresh(){const prior=$('library').value,priorSession=$('session').value;state.overview=await api('overview');select('library',state.overview.libraries,l=>l.id,l=>l.name);if([...$('library').options].some(o=>o.value===prior))$('library').value=prior;select('session',state.overview.sessions,a=>a.id,sessionLabel);for(const option of $('session').options)option.title=option.value;const owner=state.overview.libraries.find(l=>l.id===$('library').value)?.owner,target=state.overview.sessions.some(s=>s.id===priorSession)?priorSession:owner;if([...$('session').options].some(o=>o.value===target))$('session').value=target;await inspect();notice(ui('已刷新。本机管理不会发送模型消息。'))}
$('session').onchange=sessionDetails
const chosen=()=>{if(!state.library)throw Error(ui('请先选择或创建记忆库'));return {library_id:state.library.id}}
function taskNav(){if(busy)return;$('taskPrevious').disabled=!state.taskPage?.offset;$('taskNext').disabled=state.taskPage?.next_offset==null;for(const id of ['taskRead','taskPause','taskResume'])$(id).disabled=!$('task').value;$('situationPrevious').disabled=!state.situationPage?.offset;$('situationNext').disabled=state.situationPage?.next_offset==null;$('situationRead').disabled=!$('situation').value}
function situations(page,offset=0){state.situationPage={...page,offset};select('situation',page.items,s=>s.id,s=>s.title+ui(' · 第')+s.revision+ui('版'));$('situationDetail').replaceChildren();$('situationPage').textContent=page.total?ui('共 ')+page.total+ui(' 个情境'):ui('尚无情境档案')}
function tasks(page){const prior=$('task').value;state.taskPage=page;state.taskDetail=null;$('steps').replaceChildren();select('task',page.tasks,t=>t.id,t=>t.title+(t.paused?ui(' · 已暂停'):''));if([...$('task').options].some(o=>o.value===prior))$('task').value=prior;$('taskPage').textContent=page.total?ui`共 ${page.total} 个任务 · 当前 ${page.offset+1}—${page.offset+page.tasks.length}`:ui('还没有任务记录');taskNav()}
async function inspect(){
 if(!$('library').value){state.library=null;$('summary').textContent=ui('还没有记忆库。可以先创建一个独立库。');sessionDetails();return}
 const r=await api('inspect',{library_id:$('library').value});state.library=r.library
 healthBanners(r)
 const md=r.memory_dynamics
 $('dynamicsState').textContent=(md?.enabled?ui('已应用到检索排序；原文与人格保留。'):ui('当前只查看反馈；尚未应用到检索排序。'))+ui`\n纠正线索：${md?.total_cues??0} 条 · 已索引：${md?.indexed_cues??ui('尚未核对模型')} · 待补建：${md?.pending_cues??ui('未知')}\n索引状态：${md?.maintenance?.paused?ui('已暂停 / ')+md.maintenance.error:ui('正常')}`
 $('dynamicsDetail').textContent=''
 const si=r.situation_index
 $('situationIndexState').textContent=!si?.enabled?ui('情境语义检索尚未启用。'):ui`已索引：${si.indexed_situations} 个 · 待补建：${si.pending_situations} 个\n服务状态：${si.maintenance.paused?ui('已暂停 / ')+si.maintenance.error:ui('正常')}${si.model_key_known?'':ui(' · 尚未核对模型')}`
 $('situationSearchResults').replaceChildren()
 const aa=r.activity_archive
 $('activityState').textContent=!aa?ui('此宿主未提供活动归档。'):ui`${aa.enabled?ui('新活动采集已启用'):ui('新活动采集未启用')} · 结构化记录：${aa.payloads} 条 · 片段与任务节点：${aa.reports} 条\n采集状态：${aa.maintenance.paused?ui('已暂停 / ')+aa.maintenance.error:ui('正常')}\n已有原文保留，结构化补充和字段处理说明按需读取。`
 activities(await api('activity-list',{library_id:r.library.id}),0)
 const ownerSession=state.overview.sessions.find(s=>s.id===r.library.owner),ownerTitle=r.library.owner_title||(ownerSession&&ownerSession.title!==ownerSession.id?ownerSession.title:null)
 $('summary').textContent=ui`${r.library.name}\n当前主会话：${ownerTitle||(r.library.owner?ui('主会话未加载或尚未命名'):ui('尚未绑定'))}\n库状态：${r.library.error||ui('正常')} · 当前执行：${r.active?ui('正在进行'):ui('空闲')}\n经历原文：${r.records} 条 · 已索引分片：${r.embedding.indexed_parts??ui('未知')} · 待索引：${r.embedding.pending_parts??ui('未知')}`
 sessionDetails()
 const box=$('recovery');box.replaceChildren();const pending=[...r.recovery.operations.map(o=>({...o,kind:'operation'})),...r.recovery.legacy.map(o=>({...o,kind:'legacy'}))]
 if(!pending.length)box.append(text('p',ui('没有待核查的操作。')))
 for(const op of pending){const row=text('div','', 'item');row.append(text('strong',op.name||ui('旧版未追踪中断')),text('div',op.call_id||op.id,'small'));const choice=document.createElement('select');for(const [id,label] of [['',ui('请选择核查结果')],['abandon-no-replay',ui('放弃重放，不记为成功')],['verified-applied',ui('已核对，操作成功')],['verified-not-applied',ui('已核对，没有执行')]]){const option=document.createElement('option');option.value=id;option.textContent=label;choice.append(option)}row.append(choice);const note=document.createElement('input');note.placeholder=ui('核查依据或放弃重放的原因');row.append(note);const b=text('button',ui('记录人工核查'));b.onclick=()=>work(async()=>{await api('review',{...chosen(),operation_session:op.session,call_id:op.call_id,legacy_id:op.id,decision:choice.value,note:note.value});await inspect();notice(ui('已记录核查，没有重新执行原操作。'))});row.append(b);if(op.kind==='operation'){const v=text('button',ui('尝试只读核验'));v.onclick=()=>work(async()=>{const result=await api('verify',{...chosen(),operation_session:op.session,call_id:op.call_id});await inspect();notice(result.status==='unknown'?(result.reason||ui('外部证据不足，保持待核查。')):ui('核验结果：')+result.status+ui('；没有重放动作。'))});row.append(v)}box.append(row)}
 tasks(r.task_page)
 $('summary').textContent+=ui('\n尚未分片：')+(r.embedding.unprepared_records??ui('未知'))+ui(' 条原文')
 const cfg=r.extraction?.config||{source:'dsh',maxCallsPerDay:12,maxInputChars:12000,maxOutputTokens:1800};state.extractionConfig=cfg;for(const id of ['source','model','provider','baseURL','apiKeyEnv','maxCallsPerDay','maxInputChars','maxOutputTokens'])$(id).value=cfg[id]??'';$('evidenceEnabled').checked=!!cfg.evidenceEnabled;$('situationsEnabled').checked=!!cfg.situationsEnabled
 situations(r.situation_page||{items:[],total:0,next_offset:null})
 $('memorySummary').textContent=ui('情境整理：')+(!r.consolidation?.enabled?ui('未启用'):r.consolidation.paused?ui('已暂停'):ui('等待空闲处理'))+ui(' · 已处理片段：')+(r.consolidation?.completed_parts??0)+ui('\n整理提示：')+(r.consolidation?.error||ui('正常'))+ui('\n工作记忆：')+(r.working?.enabled?(r.working.frame?.expired?ui('工作集已到期'):memoryLabels[r.working.frame?.status]||ui('尚无工作集')):ui('未启用'))+ui('\n向量维护：')+(r.embedding.maintenance?.paused?ui('已暂停 · ')+r.embedding.maintenance.error:ui('正常'))
 const usage=$('usage');usage.replaceChildren();usage.append(text('p',ui('最近调用；未知用量保留“未知”，估算是字符口径，不作为账单。')))
 const table=document.createElement('table'),head=document.createElement('tr');for(const s of [ui('来源'),ui('状态'),ui('实报输入 / 输出'),ui('估算输入')])head.append(text('th',s));table.append(head)
 for(const u of r.usage){const row=document.createElement('tr');for(const s of [u.source,u.status,`${u.input??ui('未知')} / ${u.output??ui('未知')}`,u.estimated_input??'—'])row.append(text('td',s));table.append(row)}usage.append(table)
}
$('refresh').onclick=()=>work(refresh);$('library').onchange=()=>work(inspect)
$('create').onclick=()=>work(async()=>{const name=prompt(ui('新库名称'));if(!name)return;await api('create',{name});await refresh()})
$('rename').onclick=()=>work(async()=>{const name=prompt(ui('记忆库的新名称'),state.library?.name);if(!name)return;await api('rename',{...chosen(),name,expected_revision:state.library.revision});await refresh()})
for(const action of ['bind','handoff'])$(action).onclick=()=>work(async()=>{const from=state.library?.owner_title||state.library?.owner||ui('尚未绑定'),to=state.overview.sessions.find(s=>s.id===$('session').value)?.title||$('session').value;if(!confirm(ui`记忆库“${state.library?.name}”：从“${from}”到“${to}”。确认交接？旧执行会正常停止，排队输入保留。`))return;await api(action,{...chosen(),session:$('session').value,expected_revision:state.library.revision});await refresh()})
for(const action of ['pause','resume'])$(action).onclick=()=>work(async()=>{await api(action,chosen());await inspect();notice(action==='pause'?ui('已暂停此库。'):ui('已恢复；没有重放失败任务。'))})
$('backup').onclick=()=>work(async()=>{const r=await api('backup');notice(ui('校验快照已生成：')+r.directory)})
$('restore').onclick=()=>work(async()=>{const r=await api('restore-copy',{snapshot:$('snapshot').value,destination:$('destination').value});notice(ui('已创建未绑定、暂停的副本：')+r.directory)})
async function readTask(){const r=await api('task',{...chosen(),task_id:$('task').value}),box=$('steps');state.taskDetail=r.task;box.replaceChildren();box.append(text('p',r.task.paused?ui('此任务已暂停，保留原有进度。'):ui('任务状态：')+r.task.status));for(const s of r.task.steps){const row=text('div','', 'item');row.append(text('strong',s.title+' · '+(labels[s.status]||s.status)),text('div',s.tool+ui(' · 尝试记录 ')+s.attempts+ui(' 条'),'small'));if(s.operation){row.append(text('div',ui('调用：')+s.operation.call_id,'small'));const detail=document.createElement('details');detail.append(text('summary',ui('查看执行凭据')),text('pre',JSON.stringify(s.operation,null,2)));row.append(detail)}if(['failed','not_started'].includes(s.status)){const b=text('button',ui('核对后允许一次新尝试'));b.onclick=()=>work(async()=>{const note=prompt(ui('请写下核查依据；本按钮不会执行该步骤'));if(!note)return;await api('retry',{...chosen(),task_id:r.task.id,step_id:s.id,note});notice(ui('已授权一次新尝试，没有发起执行。'))});row.append(b)}box.append(row)}}
$('taskRead').onclick=()=>work(readTask)
$('task').onchange=()=>work(readTask)
for(const [id,action] of [['taskPause','task-pause'],['taskResume','task-resume']])$(id).onclick=()=>work(async()=>{await readTask();await api(action,{...chosen(),task_id:state.taskDetail.id,expected_revision:state.taskDetail.revision});await readTask();notice(action==='task-pause'?ui('任务已暂停，未强行取消在途操作。'):ui('已允许继续任务；没有重放旧调用。'))})
$('taskPrevious').onclick=()=>work(async()=>tasks(await api('tasks',{...chosen(),offset:Math.max(0,state.taskPage.offset-30)})))
$('taskNext').onclick=()=>work(async()=>{if(state.taskPage.next_offset!=null)tasks(await api('tasks',{...chosen(),offset:state.taskPage.next_offset}))})
$('configure').onclick=()=>work(async()=>{const source=$('source').value,config={source,model:$('model').value,maxCallsPerDay:Number($('maxCallsPerDay').value),maxInputChars:Number($('maxInputChars').value),maxOutputTokens:Number($('maxOutputTokens').value),minIntervalMs:state.extractionConfig?.minIntervalMs??60000,evidenceEnabled:$('evidenceEnabled').checked,situationsEnabled:$('situationsEnabled').checked};if(source==='dsh')config.provider=$('provider').value;else{config.baseURL=$('baseURL').value;config.apiKeyEnv=$('apiKeyEnv').value}await api('configure',{...chosen(),config});await inspect();notice(ui('配置已保存，两类后台整理均保持暂停；未调用模型。'))})
$('extractResume').onclick=()=>work(async()=>{await api('extraction-resume',chosen());notice(ui('已允许空闲整理，受预算和宿主空闲条件约束。'))})
$('extractPause').onclick=()=>work(async()=>{await api('extraction-pause',chosen());notice(ui('整理已暂停。'))})
$('consolidationResume').onclick=()=>work(async()=>{await api('consolidation-resume',chosen());await inspect();notice(ui('已允许空闲情境整理；与认识整理、证据核验共用日预算。'))})
$('consolidationPause').onclick=()=>work(async()=>{await api('consolidation-pause',chosen());await inspect();notice(ui('情境整理已暂停。'))})
$('workingClear').onclick=()=>work(async()=>{await api('working-clear',chosen());await inspect();notice(ui('已退出临时召回，原文、人格和宿主聊天保留。'))})
$('embeddingResume').onclick=()=>work(async()=>{await api('embedding-resume',chosen());await inspect();notice(ui('已允许再次使用向量服务，没有重放任何旧任务。'))})
$('situationPrevious').onclick=()=>work(async()=>{const offset=Math.max(0,state.situationPage.offset-10);situations(await api('situations',{...chosen(),offset}),offset)})
$('situationNext').onclick=()=>work(async()=>{const offset=state.situationPage.next_offset;if(offset!=null)situations(await api('situations',{...chosen(),offset}),offset)})
$('situationRead').onclick=()=>work(async()=>{const r=await api('situation',{...chosen(),id:$('situation').value}),box=$('situationDetail');box.replaceChildren();box.append(text('strong',r.title),text('p',ui('第')+r.revision+ui('版 · 关联原文')+r.source_count+ui('条')));for(const a of r.statements){const row=text('div','','item');row.append(text('strong',(a.origin==='model-consolidated'?ui('模型整理 · '):ui('有出处表述 · '))+(slotLabels[a.slot]||a.slot)),text('p',a.body),text('div',ui('原文编号：')+a.refs.join('、'),'small'));box.append(row)}if(r.omitted)box.append(text('p',ui('另有')+r.omitted+ui('条未在短包中展开，可用情境读取工具继续核对。')))})
$('extractResume').textContent=ui('开始空闲认识整理');$('extractPause').textContent=ui('暂停认识整理')
$('dynamicsRead').onclick=()=>work(async()=>{
 const r=await api('memory-dynamics',{...chosen(),id:$('dynamicsId').value,query:$('dynamicsQuery').value}),box=$('dynamicsDetail'),a=r.assessment
 const phase={fresh:ui('近期或使用反馈的权重较高'),fading:ui('时间权重逐渐降低'),dormant:ui('时间权重接近底值，原文仍保留')}
 box.textContent=(phase[a.phase]||a.phase)+'\n'+(a.auto_blocked?ui('当前线索有纠正或失效反馈，暂不自动带入旧卡。'):ui('当前线索没有生效的负向反馈。'))+ui('\n当前排序系数：')+a.factor.toFixed(3)+'\n'+r.note+'\n\n'+(r.recent.length?r.recent.map(e=>[e.kind+(e.retracted?ui(' · 已撤销'):''),e.cue?ui('线索：')+e.cue:'',e.reason,ui('依据：')+e.refs.join('、')].filter(Boolean).join('\n')).join('\n\n'):ui('尚无实际使用反馈。'))
})
$('correctionResume').onclick=()=>work(async()=>{await api('correction-index-resume',chosen());await inspect();notice(ui('已清理纠正线索的派生向量，空闲时重建；原文与反馈保留。'))})
work(refresh)
$('situationIndexWarm').onclick=()=>work(async()=>{await api('situation-index-warm',chosen());await inspect();notice(ui('已处理一批情境索引；原文与情境内容保留。'))})
$('situationIndexResume').onclick=()=>work(async()=>{await api('situation-index-resume',chosen());await inspect();notice(ui('已允许重用修复后的情境向量服务。'))})
$('situationSearch').onclick=()=>work(async()=>{
 const r=await api('situation-search',{...chosen(),query:$('situationQuery').value}),box=$('situationSearchResults');box.replaceChildren();box.append(text('p',r.note))
 if(!r.results.length)box.append(text('p',r.available?ui('本次没有达到门槛的候选；仍可能有尚未索引或未命中的旧事。'):ui('当前情境检索不可用，请先核对状态。')))
 for(const c of r.results){
   const row=text('div','','item'),read=text('button',ui('查看情境'));row.append(text('strong',c.title),text('p',readableProjection(c.summary)),text('div',ui('候选分数：')+c.score+' · '+(modeLabels[c.mode]||c.mode),'small'),read)
   read.onclick=()=>work(async()=>{const d=await api('situation',{...chosen(),id:c.id});const detail=text('div','','summary');detail.append(text('strong',d.title));for(const a of d.statements)detail.append(text('p',a.body),text('div',ui('原文编号：')+a.refs.join('、'),'small'));read.disabled=true;row.append(detail)})
   box.append(row)
 }
})
function activityNav(){
 if(busy)return
 $('activityPrevious').disabled=!state.activityPage?.offset;$('activityNext').disabled=state.activityPage?.next_offset==null
 $('activityRead').disabled=!$('activityRecord').value
 $('activityReadNext').disabled=state.activityDetail?.next_offset==null||state.activityDetailId!==$('activityRecord').value||state.activityDetailPart!==$('activityPart').value
}
function activities(page,offset){
 state.activityPage={...page,offset};state.activityDetail=null;select('activityRecord',page.items,r=>r.id,r=>r.title+' · '+(phaseLabels[r.phase]||r.phase))
 $('activityPage').textContent=page.total?ui('共 ')+page.total+ui(' 条记录'):ui('尚无结构化活动记录');$('activityDetail').textContent='';$('activityReadPosition').textContent=''
}
async function readActivity(offset=0){
 const id=$('activityRecord').value,part=$('activityPart').value,r=await api('activity-read',{...chosen(),id,part,offset,limit:1200})
 state.activityDetail=r;state.activityDetailId=id;state.activityDetailPart=part;$('activityDetail').textContent=r.text
 $('activityReadPosition').textContent=ui('字符 ')+r.offset+'—'+(r.offset+Array.from(r.text).length)+' / '+r.total_characters+(r.next_offset==null?ui(' · 本条读取结束'):ui(' · 可继续翻页'))
}
$('activityRecord').onchange=$('activityPart').onchange=()=>{state.activityDetail=null;$('activityDetail').textContent='';$('activityReadPosition').textContent='';activityNav()}
$('activityRefresh').onclick=()=>work(inspect)
$('activityResume').onclick=()=>work(async()=>{const r=await api('activity-resume',chosen());await inspect();notice(ui('已补扫 ')+r.backfill.scanned+ui(' 条原生事件；没有执行旧工具。'))})
$('activityPrevious').onclick=()=>work(async()=>{const offset=Math.max(0,state.activityPage.offset-5);activities(await api('activity-list',{...chosen(),offset}),offset)})
$('activityNext').onclick=()=>work(async()=>{const offset=state.activityPage.next_offset;if(offset!=null)activities(await api('activity-list',{...chosen(),offset}),offset)})
$('activityRead').onclick=()=>work(()=>readActivity(0))
$('activityReadNext').onclick=()=>work(async()=>{const offset=state.activityDetail?.next_offset;if(offset!=null)await readActivity(offset)})
