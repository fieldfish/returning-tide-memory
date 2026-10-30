'use strict'
const token=location.hash.slice(1)||sessionStorage.getItem('continuity-manager-token')||'';if(token)sessionStorage.setItem('continuity-manager-token',token);history.replaceState(null,'',location.pathname)
const $=id=>document.getElementById(id),state={overview:null,library:null,taskPage:null,taskDetail:null,situationPage:null,extractionConfig:null}
let busy=false
const labels={planned:'待执行',not_started:'确认未执行',running:'执行中',succeeded:'宿主报告成功',failed:'明确失败',uncertain:'结果未知',reviewed:'已核查',abandoned:'放弃重放',result_recorded:'已收到结果'}
const memoryLabels={ready:'已准备，尚不代表已使用',cleared:'已清空临时召回',unavailable:'召回不可用',busy:'召回尚未结束','index-incomplete':'索引补建中','no-admissible-evidence':'没有符合自动准入的候选',empty:'尚无工作集'}
const slotLabels={background:'背景',goal:'计划／目标',progress:'进度表述',question:'未解问题','self-report':'自述',interpretation:'后来理解','source-claim':'外部来源说法'}
const modeLabels={unknown:'类型未定',experience:'经历类记录',creative:'创作类记录',mixed:'混合记录'}
const readableProjection=value=>String(value||'').replace(/\[(explicit|model-consolidated):([a-z-]+)\]/g,(_all,origin,slot)=>(origin==='model-consolidated'?'模型整理 · ':'')+(slotLabels[slot]||slot)+'：')
const phaseLabels={requested:'已记录请求','host-returned':'宿主已返回','host-error':'宿主返回错误','host-outcome-unknown':'结果仍未知',reported:'观察报告','host-node':'任务节点'}
async function api(action,args={}){const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action,...args})});const v=await r.json();if(!v.ok)throw Error(v.message||v.error);return v.result}
function notice(s){$('notice').textContent=s}
async function work(fn){if(busy)return;busy=true;document.querySelectorAll('button,input,select').forEach(b=>b.disabled=true);try{await fn()}catch(e){notice('未完成：'+e.message)}finally{busy=false;document.querySelectorAll('button,input,select').forEach(b=>b.disabled=false);taskNav();activityNav()}}
function select(id,items,value,label){const el=$(id);el.replaceChildren();for(const item of items){const o=document.createElement('option');o.value=value(item);o.textContent=label(item);el.append(o)}}
function text(tag,value,cls){const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e}
async function refresh(){const prior=$('library').value;state.overview=await api('overview');select('library',state.overview.libraries,l=>l.id,l=>l.name);if([...$('library').options].some(o=>o.value===prior))$('library').value=prior;select('session',state.overview.sessions,a=>a.id,a=>a.title+' · '+a.status);await inspect();notice('已刷新。本机管理不会发送模型消息。')}
const chosen=()=>{if(!state.library)throw Error('请先选择或创建记忆库');return {library_id:state.library.id}}
function taskNav(){if(busy)return;$('taskPrevious').disabled=!state.taskPage?.offset;$('taskNext').disabled=state.taskPage?.next_offset==null;for(const id of ['taskRead','taskPause','taskResume'])$(id).disabled=!$('task').value;$('situationPrevious').disabled=!state.situationPage?.offset;$('situationNext').disabled=state.situationPage?.next_offset==null;$('situationRead').disabled=!$('situation').value}
function situations(page,offset=0){state.situationPage={...page,offset};select('situation',page.items,s=>s.id,s=>s.title+' · 第'+s.revision+'版');$('situationDetail').replaceChildren();$('situationPage').textContent=page.total?'共 '+page.total+' 个情境':'尚无情境档案'}
function tasks(page){const prior=$('task').value;state.taskPage=page;state.taskDetail=null;$('steps').replaceChildren();select('task',page.tasks,t=>t.id,t=>t.title+(t.paused?' · 已暂停':''));if([...$('task').options].some(o=>o.value===prior))$('task').value=prior;$('taskPage').textContent=page.total?`共 ${page.total} 个任务 · 当前 ${page.offset+1}—${page.offset+page.tasks.length}`:'还没有任务记录';taskNav()}
async function inspect(){
 if(!$('library').value){state.library=null;$('summary').textContent='还没有记忆库。可以先创建一个独立测试库。';return}
 const r=await api('inspect',{library_id:$('library').value});state.library=r.library
 const md=r.memory_dynamics
 $('dynamicsState').textContent=(md?.enabled?'已应用到检索排序；原文与人格保留。':'当前只查看反馈；尚未应用到检索排序。')+`\n纠正线索：${md?.total_cues??0} 条 · 已索引：${md?.indexed_cues??'尚未核对模型'} · 待补建：${md?.pending_cues??'未知'}\n索引状态：${md?.maintenance?.paused?'已暂停 / '+md.maintenance.error:'正常'}`
 $('dynamicsDetail').textContent=''
 const si=r.situation_index
 $('situationIndexState').textContent=!si?.enabled?'情境语义检索尚未启用。':`已索引：${si.indexed_situations} 个 · 待补建：${si.pending_situations} 个\n服务状态：${si.maintenance.paused?'已暂停 / '+si.maintenance.error:'正常'}${si.model_key_known?'':' · 尚未核对模型'}`
 $('situationSearchResults').replaceChildren()
 const aa=r.activity_archive
 $('activityState').textContent=!aa?'此宿主未提供活动归档。':`${aa.enabled?'新活动采集已启用':'新活动采集未启用'} · 结构化记录：${aa.payloads} 条 · 片段与任务节点：${aa.reports} 条\n采集状态：${aa.maintenance.paused?'已暂停 / '+aa.maintenance.error:'正常'}\n已有原文保留，结构化补充和字段处理说明按需读取。`
 activities(await api('activity-list',{library_id:r.library.id}),0)
 $('summary').textContent=`${r.library.name}\n归属会话：${r.library.owner||'尚未绑定'}\n库状态：${r.library.error||'正常'} · 当前执行：${r.active?'正在进行':'空闲'}\n经历原文：${r.records} 条 · 已索引分片：${r.embedding.indexed_parts??'未知'} · 待索引：${r.embedding.pending_parts??'未知'}`
 const box=$('recovery');box.replaceChildren();const pending=[...r.recovery.operations.map(o=>({...o,kind:'operation'})),...r.recovery.legacy.map(o=>({...o,kind:'legacy'}))]
 if(!pending.length)box.append(text('p','没有待核查的操作。'))
 for(const op of pending){const row=text('div','', 'item');row.append(text('strong',op.name||'旧版未追踪中断'),text('div',op.call_id||op.id,'small'));const choice=document.createElement('select');for(const [id,label] of [['','请选择核查结果'],['abandon-no-replay','放弃重放，不记为成功'],['verified-applied','已核对，操作成功'],['verified-not-applied','已核对，没有执行']]){const option=document.createElement('option');option.value=id;option.textContent=label;choice.append(option)}row.append(choice);const note=document.createElement('input');note.placeholder='核查依据或放弃重放的原因';row.append(note);const b=text('button','记录人工核查');b.onclick=()=>work(async()=>{await api('review',{...chosen(),operation_session:op.session,call_id:op.call_id,legacy_id:op.id,decision:choice.value,note:note.value});await inspect();notice('已记录核查，没有重新执行原操作。')});row.append(b);if(op.kind==='operation'){const v=text('button','尝试只读核验');v.onclick=()=>work(async()=>{const result=await api('verify',{...chosen(),operation_session:op.session,call_id:op.call_id});await inspect();notice(result.status==='unknown'?(result.reason||'外部证据不足，保持待核查。'):'核验结果：'+result.status+'；没有重放动作。')});row.append(v)}box.append(row)}
 tasks(r.task_page)
 $('summary').textContent+='\n尚未分片：'+(r.embedding.unprepared_records??'未知')+' 条原文'
 const cfg=r.extraction?.config||{source:'dsh',maxCallsPerDay:12,maxInputChars:12000,maxOutputTokens:1800};state.extractionConfig=cfg;for(const id of ['source','model','provider','baseURL','apiKeyEnv','maxCallsPerDay','maxInputChars','maxOutputTokens'])$(id).value=cfg[id]??'';$('evidenceEnabled').checked=!!cfg.evidenceEnabled;$('situationsEnabled').checked=!!cfg.situationsEnabled
 situations(r.situation_page||{items:[],total:0,next_offset:null})
 $('memorySummary').textContent='情境整理：'+(!r.consolidation?.enabled?'未启用':r.consolidation.paused?'已暂停':'等待空闲处理')+' · 已处理片段：'+(r.consolidation?.completed_parts??0)+'\n整理提示：'+(r.consolidation?.error||'正常')+'\n工作记忆：'+(r.working?.enabled?(r.working.frame?.expired?'工作集已到期':memoryLabels[r.working.frame?.status]||'尚无工作集'):'未启用')+'\n向量维护：'+(r.embedding.maintenance?.paused?'已暂停 · '+r.embedding.maintenance.error:'正常')
 const usage=$('usage');usage.replaceChildren();usage.append(text('p','最近调用；未知用量保留“未知”，估算是字符口径，不作为账单。'))
 const table=document.createElement('table'),head=document.createElement('tr');for(const s of ['来源','状态','实报输入 / 输出','估算输入'])head.append(text('th',s));table.append(head)
 for(const u of r.usage){const row=document.createElement('tr');for(const s of [u.source,u.status,`${u.input??'未知'} / ${u.output??'未知'}`,u.estimated_input??'—'])row.append(text('td',s));table.append(row)}usage.append(table)
}
$('refresh').onclick=()=>work(refresh);$('library').onchange=()=>work(inspect)
$('create').onclick=()=>work(async()=>{const name=prompt('新库名称');if(!name)return;await api('create',{name});await refresh()})
$('rename').onclick=()=>work(async()=>{const name=prompt('记忆库的新名称',state.library?.name);if(!name)return;await api('rename',{...chosen(),name,expected_revision:state.library.revision});await refresh()})
for(const action of ['bind','handoff'])$(action).onclick=()=>work(async()=>{if(!confirm(`将“${state.library?.name}”${action==='bind'?'绑定':'交接'}到所选会话？交接会正常停止旧执行，并保留排队输入。`))return;await api(action,{...chosen(),session:$('session').value,expected_revision:state.library.revision});await refresh()})
for(const action of ['pause','resume'])$(action).onclick=()=>work(async()=>{await api(action,chosen());await inspect();notice(action==='pause'?'已暂停此库。':'已恢复；没有重放失败任务。')})
$('backup').onclick=()=>work(async()=>{const r=await api('backup');notice('校验快照已生成：'+r.directory)})
$('restore').onclick=()=>work(async()=>{const r=await api('restore-copy',{snapshot:$('snapshot').value,destination:$('destination').value});notice('已创建未绑定、暂停的副本：'+r.directory)})
async function readTask(){const r=await api('task',{...chosen(),task_id:$('task').value}),box=$('steps');state.taskDetail=r.task;box.replaceChildren();box.append(text('p',r.task.paused?'此任务已暂停，保留原有进度。':'任务状态：'+r.task.status));for(const s of r.task.steps){const row=text('div','', 'item');row.append(text('strong',s.title+' · '+(labels[s.status]||s.status)),text('div',s.tool+' · 尝试记录 '+s.attempts+' 条','small'));if(s.operation){row.append(text('div','调用：'+s.operation.call_id,'small'));const detail=document.createElement('details');detail.append(text('summary','查看执行凭据'),text('pre',JSON.stringify(s.operation,null,2)));row.append(detail)}if(['failed','not_started'].includes(s.status)){const b=text('button','核对后允许一次新尝试');b.onclick=()=>work(async()=>{const note=prompt('请写下核查依据；本按钮不会执行该步骤');if(!note)return;await api('retry',{...chosen(),task_id:r.task.id,step_id:s.id,note});notice('已授权一次新尝试，没有发起执行。')});row.append(b)}box.append(row)}}
$('taskRead').onclick=()=>work(readTask)
$('task').onchange=()=>work(readTask)
for(const [id,action] of [['taskPause','task-pause'],['taskResume','task-resume']])$(id).onclick=()=>work(async()=>{await readTask();await api(action,{...chosen(),task_id:state.taskDetail.id,expected_revision:state.taskDetail.revision});await readTask();notice(action==='task-pause'?'任务已暂停，未强行取消在途操作。':'已允许继续任务；没有重放旧调用。')})
$('taskPrevious').onclick=()=>work(async()=>tasks(await api('tasks',{...chosen(),offset:Math.max(0,state.taskPage.offset-30)})))
$('taskNext').onclick=()=>work(async()=>{if(state.taskPage.next_offset!=null)tasks(await api('tasks',{...chosen(),offset:state.taskPage.next_offset}))})
$('configure').onclick=()=>work(async()=>{const source=$('source').value,config={source,model:$('model').value,maxCallsPerDay:Number($('maxCallsPerDay').value),maxInputChars:Number($('maxInputChars').value),maxOutputTokens:Number($('maxOutputTokens').value),minIntervalMs:state.extractionConfig?.minIntervalMs??60000,evidenceEnabled:$('evidenceEnabled').checked,situationsEnabled:$('situationsEnabled').checked};if(source==='dsh')config.provider=$('provider').value;else{config.baseURL=$('baseURL').value;config.apiKeyEnv=$('apiKeyEnv').value}await api('configure',{...chosen(),config});await inspect();notice('配置已保存，两类后台整理均保持暂停；未调用模型。')})
$('extractResume').onclick=()=>work(async()=>{await api('extraction-resume',chosen());notice('已允许空闲整理，受预算和宿主空闲条件约束。')})
$('extractPause').onclick=()=>work(async()=>{await api('extraction-pause',chosen());notice('整理已暂停。')})
$('consolidationResume').onclick=()=>work(async()=>{await api('consolidation-resume',chosen());await inspect();notice('已允许空闲情境整理；与认识整理、证据核验共用日预算。')})
$('consolidationPause').onclick=()=>work(async()=>{await api('consolidation-pause',chosen());await inspect();notice('情境整理已暂停。')})
$('workingClear').onclick=()=>work(async()=>{await api('working-clear',chosen());await inspect();notice('已退出临时召回，原文、人格和宿主聊天保留。')})
$('embeddingResume').onclick=()=>work(async()=>{await api('embedding-resume',chosen());await inspect();notice('已允许再次使用向量服务，没有重放任何旧任务。')})
$('situationPrevious').onclick=()=>work(async()=>{const offset=Math.max(0,state.situationPage.offset-10);situations(await api('situations',{...chosen(),offset}),offset)})
$('situationNext').onclick=()=>work(async()=>{const offset=state.situationPage.next_offset;if(offset!=null)situations(await api('situations',{...chosen(),offset}),offset)})
$('situationRead').onclick=()=>work(async()=>{const r=await api('situation',{...chosen(),id:$('situation').value}),box=$('situationDetail');box.replaceChildren();box.append(text('strong',r.title),text('p','第'+r.revision+'版 · 关联原文'+r.source_count+'条'));for(const a of r.statements){const row=text('div','','item');row.append(text('strong',(a.origin==='model-consolidated'?'模型整理 · ':'有出处表述 · ')+(slotLabels[a.slot]||a.slot)),text('p',a.body),text('div','原文编号：'+a.refs.join('、'),'small'));box.append(row)}if(r.omitted)box.append(text('p','另有'+r.omitted+'条未在短包中展开，可用情境读取工具继续核对。'))})
$('extractResume').textContent='开始空闲认识整理';$('extractPause').textContent='暂停认识整理'
$('dynamicsRead').onclick=()=>work(async()=>{
 const r=await api('memory-dynamics',{...chosen(),id:$('dynamicsId').value,query:$('dynamicsQuery').value}),box=$('dynamicsDetail'),a=r.assessment
 const phase={fresh:'近期或使用反馈的权重较高',fading:'时间权重逐渐降低',dormant:'时间权重接近底值，原文仍保留'}
 box.textContent=(phase[a.phase]||a.phase)+'\n'+(a.auto_blocked?'当前线索有纠正或失效反馈，暂不自动带入旧卡。':'当前线索没有生效的负向反馈。')+'\n当前排序系数：'+a.factor.toFixed(3)+'\n'+r.note+'\n\n'+(r.recent.length?r.recent.map(e=>[e.kind+(e.retracted?' · 已撤销':''),e.cue?'线索：'+e.cue:'',e.reason,'依据：'+e.refs.join('、')].filter(Boolean).join('\n')).join('\n\n'):'尚无实际使用反馈。')
})
$('correctionResume').onclick=()=>work(async()=>{await api('correction-index-resume',chosen());await inspect();notice('已清理纠正线索的派生向量，空闲时重建；原文与反馈保留。')})
work(refresh)
$('situationIndexWarm').onclick=()=>work(async()=>{await api('situation-index-warm',chosen());await inspect();notice('已处理一批情境索引；原文与情境内容保留。')})
$('situationIndexResume').onclick=()=>work(async()=>{await api('situation-index-resume',chosen());await inspect();notice('已允许重用修复后的情境向量服务。')})
$('situationSearch').onclick=()=>work(async()=>{
 const r=await api('situation-search',{...chosen(),query:$('situationQuery').value}),box=$('situationSearchResults');box.replaceChildren();box.append(text('p',r.note))
 if(!r.results.length)box.append(text('p',r.available?'本次没有达到门槛的候选；仍可能有尚未索引或未命中的旧事。':'当前情境检索不可用，请先核对状态。'))
 for(const c of r.results){
   const row=text('div','','item'),read=text('button','查看情境');row.append(text('strong',c.title),text('p',readableProjection(c.summary)),text('div','候选分数：'+c.score+' · '+(modeLabels[c.mode]||c.mode),'small'),read)
   read.onclick=()=>work(async()=>{const d=await api('situation',{...chosen(),id:c.id});const detail=text('div','','summary');detail.append(text('strong',d.title));for(const a of d.statements)detail.append(text('p',a.body),text('div','原文编号：'+a.refs.join('、'),'small'));read.disabled=true;row.append(detail)})
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
 $('activityPage').textContent=page.total?'共 '+page.total+' 条记录':'尚无结构化活动记录';$('activityDetail').textContent='';$('activityReadPosition').textContent=''
}
async function readActivity(offset=0){
 const id=$('activityRecord').value,part=$('activityPart').value,r=await api('activity-read',{...chosen(),id,part,offset,limit:1200})
 state.activityDetail=r;state.activityDetailId=id;state.activityDetailPart=part;$('activityDetail').textContent=r.text
 $('activityReadPosition').textContent='字符 '+r.offset+'—'+(r.offset+Array.from(r.text).length)+' / '+r.total_characters+(r.next_offset==null?' · 本条读取结束':' · 可继续翻页')
}
$('activityRecord').onchange=$('activityPart').onchange=()=>{state.activityDetail=null;$('activityDetail').textContent='';$('activityReadPosition').textContent='';activityNav()}
$('activityRefresh').onclick=()=>work(inspect)
$('activityResume').onclick=()=>work(async()=>{const r=await api('activity-resume',chosen());await inspect();notice('已补扫 '+r.backfill.scanned+' 条原生事件；没有执行旧工具。')})
$('activityPrevious').onclick=()=>work(async()=>{const offset=Math.max(0,state.activityPage.offset-5);activities(await api('activity-list',{...chosen(),offset}),offset)})
$('activityNext').onclick=()=>work(async()=>{const offset=state.activityPage.next_offset;if(offset!=null)activities(await api('activity-list',{...chosen(),offset}),offset)})
$('activityRead').onclick=()=>work(()=>readActivity(0))
$('activityReadNext').onclick=()=>work(async()=>{const offset=state.activityDetail?.next_offset;if(offset!=null)await readActivity(offset)})
