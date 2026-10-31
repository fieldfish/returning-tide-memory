import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import { ContinuityStore } from './lib/store.mjs'
import { Capture, pendingUserMessage } from './lib/capture.mjs'
import { Embedding } from './lib/embedding.mjs'
import { Extraction, EXTRACTION_SYSTEM, normalizeUsage } from './lib/extraction.mjs'
import {Evidence,EVIDENCE_SYSTEM} from './lib/evidence.mjs'
import {ExecutionLedger} from './lib/execution.mjs'
import {Scenes} from './lib/scenes.mjs'
import {WorkingMemory} from './lib/working-memory.mjs'
import {ToolContext} from './lib/tool-context.mjs'
import {Situations} from './lib/situations.mjs'
import {SituationIndex} from './lib/situation-index.mjs'
import {ActivityArchive} from './lib/activity-archive.mjs'
import {ContextFrame} from './lib/context-frame.mjs'
import {Consolidation,CONSOLIDATION_SYSTEM} from './lib/consolidation.mjs'
import {toolOutcome} from './lib/dsh-events.mjs'
import {createManager} from './lib/manager.mjs'
import {sessionTitle} from './lib/session-title.mjs'
import { hash, fail, clip, page, integer, text } from './lib/util.mjs'

export const name = 'continuity-core'
export const inject = ['tools','agents','sessions','llm','systemPrompt']
const str = description => ({ type:'string',description })
const num = description => ({ type:'integer',description })
const object = (properties,required=[]) => ({type:'object',properties,required,additionalProperties:false})
const SID = a => a?.session?.id || a?.id

export async function createPlugin(ctx, config = {}, options = {}) {
  const resources={}
  try{return await initializePlugin(ctx,config,options,resources)}
  catch(error){
    const failures=[]
    if(resources.dispose){try{await resources.dispose()}catch(e){failures.push(e)}}
    else for(const close of [()=>resources.embedding?.close(),()=>resources.store?.close()])try{await close()}catch(e){failures.push(e)}
    if(failures.length)throw new AggregateError([error,...failures],'插件初始化失败，资源清理也有错误')
    throw error
  }
}
async function initializePlugin(ctx,config,options,resources){
  if (!ctx.tools?.register || !ctx.agents?.get || !ctx.sessions?.flush || typeof ctx.on!=='function' || typeof ctx.effect!=='function') fail('HOST_API_UNAVAILABLE','缺少官方会话、工具或生命周期接口；未改动原人格或配置')
  let isLoop=options.isAgentLoopRequest
  if(!isLoop){
    try{isLoop=(await import('@deepseek-ai/dsh-llm')).isAgentLoopRequest}
    catch(e){
      if(!config.runtimePackageJson)fail('HOST_API_UNAVAILABLE','找不到现场DSH SDK；需提供runtimePackageJson')
      const require=createRequire(resolve(config.runtimePackageJson))
      isLoop=(await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)).isAgentLoopRequest
    }
  }
  if(typeof isLoop!=='function') fail('HOST_API_UNAVAILABLE','需要 isAgentLoopRequest 以区分主模型和辅助调用')
  // Reuse the host's own schema rules. Missing SDK support is not proof of invalid arguments.
  let validateToolArguments=options.validateJsonSchemaValue
  if(typeof validateToolArguments!=='function'){
    try{validateToolArguments=(await import('@deepseek-ai/dsh-tools')).validateJsonSchemaValue}
    catch{if(config.runtimePackageJson)try{const require=createRequire(resolve(config.runtimePackageJson));validateToolArguments=(await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)).validateJsonSchemaValue}catch{}}
  }
  const store = new ContinuityStore(resolve(config.dataDirectory || join(process.env.DSH_HOME || join(homedir(),'.dsh'),'continuity-core')),options.storeOptions)
  resources.store=store
  store.ownerLabel=id=>{const title=sessionTitle(ctx.agents.get(id));return title?title+' ('+id+')':id}
  const embedding=new Embedding(store,{legacySessionId:config.legacySessionId,memoryDynamics:config.memoryDynamics,...config.embedding}),capture = new Capture(store), held = new Map(), seen = new Map(), streams = new Set(), childStreams = new Map(), disposers = [], transfers = new Set()
  resources.embedding=embedding
  let closed = false
  const lifecycle=new AbortController(),maintenanceTimers=new Map(),embeddingTimers=new Map(),embeddingJobs=new Map()
  const administrativeHandlers=new Map()
  let manager=null
  const libraryFor = session => typeof session==='string' ? store.binding(session)?.library || null : null
  function managedAncestor(agent) {
    const visited=new Set(),self=SID(agent)
    let parent=agent?.session?.header?.parentSession
    while(typeof parent==='string'&&parent&&!visited.has(parent)&&parent!==self){
      visited.add(parent)
      const id=libraryFor(parent)
      if(id)return {session:parent,id}
      parent=ctx.agents.get(parent)?.session?.header?.parentSession
    }
    return null
  }
  const entryBrief = e=>({key:e.key,revision:e.revision,kind:e.kind,body:clip(e.body,200),refs:e.refs.slice(0,3),reference_count:e.refs.length,excerpt:Array.from(e.body).length>200})
  const taskBrief = e=>({task:e.task,revision:e.revision,status:e.value.status,progress:clip(e.value.progress,300),next_step:clip(e.value.next_step||'',200),refs:e.refs.slice(0,3),reference_count:e.refs.length})
  const notifyError = (session,code) => { ctx.logger?.warn?.(`[continuity-core] ${session}: ${code}`);try{ctx.emit?.('api-session/error',session,`接续插件：${code}，已暂停，等待手动处理`)}catch{} }
  const owned = exec => { const session=SID(exec.agent), id=libraryFor(session); if(!id)fail('NOT_BOUND','本会话尚未绑定记忆库');store.assertOwner(id,session);return {id,session} }
  const releaseMain = session => { const run=held.get(session);if(run){store.finish(run.id,run.token);held.delete(session)} }
  function hasRunningChildren(session) {
    const children=(ctx.agents.list?.()||[]).filter(a=>a.status==='running'&&managedAncestor(a)?.session===session)
    return children.length>0||[...childStreams.values()].some(v=>v.owner===session)
  }
  function assertNoRunningChildren(session) {
    if(hasRunningChildren(session))fail('CHILD_STILL_RUNNING','原会话仍有子代理运行；请先停止并核对，不自动强行接手')
  }
  const extraction = new Extraction(store,{fetcher:options.fetcher,now:options.now,dshCall:async args=>{
    if(typeof ctx.llm.prepareCall!=='function')fail('DSH_API_UNAVAILABLE','宿主缺少prepareCall')
    const prepared=await ctx.llm.prepareCall({provider:args.provider,model:args.model,maxTokens:args.maxOutputTokens,temperature:0},args.signal)
    if(prepared.retryPolicy?.mode!=='normal'||prepared.retryPolicy.maxRetries!==0)fail('NO_RETRY_GUARANTEE','DSH提供方的重试策略不是0；请先配置，插件未改宿主设置')
    let output='',usage=null,finished=false
    for await(const chunk of prepared.stream({...prepared.config,system:args.system,messages:[{role:'user',content:[{type:'text',text:args.input}]}],sessionId:args.session,signal:args.signal})) {
      if(chunk.type==='text-delta')output+=chunk.text
      if(chunk.type==='usage')usage=chunk.usage
      if(chunk.type==='finish'){if(chunk.reason?.kind!=='stop')fail('DSH_GENERATION_FAILED','DSH提炼未正常结束');finished=true}
    }
    if(!finished)fail('INCOMPLETE_OUTPUT','DSH流缺少完成标记')
    return {text:output,usage}
  }})
  const evidence=new Evidence(store,embedding,extraction)
  const execution=new ExecutionLedger(store,{verifiers:options.verifiers})
  const activityArchive=new ActivityArchive(store,config.activityArchive);capture.activityArchive=activityArchive
  const scenes=new Scenes(store),situations=new Situations(store,scenes)
  const situationIndex=new SituationIndex(store,situations,embedding,config.situationIndex)
  const working=new WorkingMemory(store,embedding,scenes,config.workingMemory,situationIndex),contextFrame=new ContextFrame(store,working,situations,execution,activityArchive)
  const toolContext=new ToolContext(working)
  const consolidation=new Consolidation(store,situations,extraction,situationIndex)
  store.db.exec('CREATE TABLE IF NOT EXISTS cm_maintenance_turns(library TEXT PRIMARY KEY,last_kind TEXT NOT NULL)')
  resources.dispose=dispose
  function attach(agent) {
    const session=SID(agent),id=libraryFor(session)
    if(!id||seen.get(agent)?.library===id)return
    const previous=seen.get(agent);if(typeof previous?.dispose==='function')previous.dispose();seen.delete(agent)
    const prompt=agent.ctx?.systemPrompt
    if(typeof prompt?.context!=='function')fail('HOST_API_UNAVAILABLE','会话缺少systemPrompt.context，未使用未经核对的注入路径')
    const registered=[],disposeContexts=()=>{const failures=[];for(const d of registered.splice(0).reverse())try{if(typeof d==='function')d()}catch(e){failures.push(e)}if(failures.length)throw new AggregateError(failures,'恢复上下文清理失败')}
    const addContext=spec=>{const d=prompt.context(spec);registered.push(d);return d}
    try{
    if(working.config.enabled){
      addContext({name:'continuity-core:memory-frame',order:900,required:true,interpolate:false,text:()=>closed?'':contextFrame.render(id,session)})
    }else{
    addContext({name:'continuity-core:recovery',order:900,required:true,interpolate:false,text:()=>{
      if(closed||store.library(id).owner!==session)return ''
      return store.restore(id,session)?.text || ''
    }})
    addContext({name:'continuity-core:review-procedure',order:910,required:true,interpolate:false,text:()=>{
      if(closed||store.library(id).owner!==session||!store.binding(session)?.review||!store.pending(id).length)return ''
      return '记忆维护流程：后台新候选不是既定人格或已证实事实。本次自然回复前，请用cm_self get查看待审项，并核对refs原文。逐项独立判断：认可则cm_self accept；证据不足、不愿认可或暂时不适合则cm_self defer并简述理由。不能无依据地认可，也不要默默跳过。无需向用户播报内部过程，不额外唤醒或主动发消息。'
    }})
    addContext({name:'continuity-core:interrupted-actions',order:920,required:true,interpolate:false,text:()=>closed||store.library(id).owner!==session?'':store.recovery.context(id)})
    addContext({name:'continuity-core:execution',order:930,required:true,interpolate:false,text:()=>closed||store.library(id).owner!==session?'':execution.context(id)})
    addContext({name:'continuity-core:working',order:940,required:true,interpolate:false,text:()=>closed?'':working.context(id,session)})
    }
    seen.set(agent,{library:id,dispose:disposeContexts})
    }catch(error){try{disposeContexts()}catch(cleanup){throw new AggregateError([error,cleanup],'恢复上下文挂载与清理均失败')}throw error}
  }
  function maintenanceChoice(id){
    const candidates=[{kind:'extract',service:extraction},{kind:'consolidate',service:consolidation}].map(c=>({...c,due:c.service.dueIn(id)})).filter(c=>c.due!==null)
    const last=store.db.prepare('SELECT last_kind FROM cm_maintenance_turns WHERE library=?').get(id)?.last_kind
    candidates.sort((a,b)=>a.due-b.due||(a.kind===last?1:0)-(b.kind===last?1:0))
    return candidates[0]||null
  }
  async function idleExtraction(agent) {
    const session=SID(agent),id=libraryFor(session)
    if(closed||!id||store.library(id).owner!==session||store.library(id).error||transfers.has(id)||store.busy(id)||extraction.jobs.has(id)||consolidation.jobs.has(id)||hasRunningChildren(session)||agent.status!=='idle')return
    const chosen=maintenanceChoice(id);if(!chosen)return;if(chosen.due>0){scheduleExtraction(agent);return}
    try {
      assertNoRunningChildren(session)
      if(typeof agent.runMaintenance!=='function')fail('HOST_API_UNAVAILABLE','宿主不支持空闲维护，不能保证提炼与主会话串行')
      store.db.prepare('INSERT INTO cm_maintenance_turns VALUES(?,?) ON CONFLICT(library) DO UPDATE SET last_kind=excluded.last_kind').run(id,chosen.kind)
      await agent.runMaintenance(signal=>chosen.service.run(id,session,signal))
    }catch(e){
      if(closed||e.code==='CHILD_STILL_RUNNING')return
      if(chosen.kind==='extract'){extraction.pause(id);store.db.prepare('UPDATE extraction SET error=? WHERE library=?').run(e.code||'EXTRACTION_FAILED',id)}
      else consolidation.pause(id,e.code||'CONSOLIDATION_FAILED')
      ctx.logger?.warn?.('[continuity-core] '+chosen.kind+'维护已暂停，聊天与原文采集继续；'+(e.code||'MAINTENANCE_FAILED'))
    }
    finally{scheduleExtraction(agent);scheduleEmbedding(agent)}
  }
  function scheduleExtraction(agent){
    if(closed)return
    const session=SID(agent),id=libraryFor(session)
    if(!id||maintenanceTimers.has(id)||agent.status!=='idle'||store.library(id).owner!==session||store.library(id).error||hasRunningChildren(session))return
    const chosen=maintenanceChoice(id);if(!chosen)return
    const timer=setTimeout(()=>{maintenanceTimers.delete(id);void idleExtraction(agent)},Math.max(25,chosen.due));timer.unref?.();maintenanceTimers.set(id,timer)
  }
  async function idleEmbedding(agent){
    const session=SID(agent),id=libraryFor(session)
    if(closed||!id||embeddingJobs.has(id)||agent.status!=='idle'||store.busy(id)||store.library(id).owner!==session||store.library(id).error||transfers.has(id)||hasRunningChildren(session))return
    const controller=new AbortController(),signal=AbortSignal.any([lifecycle.signal,controller.signal]);embeddingJobs.set(id,controller)
    try{
      if(!embedding.health(id).paused)try{await embedding.warm(id,session,signal)}catch(e){if(!closed&&!signal.aborted){embedding.markFailure(id,e.code||'EMBEDDING_FAILED');ctx.logger?.warn?.('[continuity-core] 原文向量维护已暂停；聊天和原文采集可继续')}}
      if(!closed&&!signal.aborted&&agent.status==='idle'&&store.library(id).owner===session&&situationIndex.enabled&&!situationIndex.health(id).paused)try{await situationIndex.warm(id,session,signal)}catch(e){if(!closed&&!signal.aborted)ctx.logger?.warn?.('[continuity-core] 情境向量维护已暂停；原文检索和聊天继续')}
    }finally{if(embeddingJobs.get(id)===controller)embeddingJobs.delete(id);scheduleEmbedding(agent)}
  }
  function scheduleEmbedding(agent){
    if(closed)return
    const session=SID(agent),id=libraryFor(session)
    if(!id||embeddingTimers.has(id)||agent.status!=='idle'||store.library(id).owner!==session||store.library(id).error||transfers.has(id)||hasRunningChildren(session))return
    const rawPending=!embedding.health(id).paused&&embedding.status(id).index_work_remaining
    const situationPending=situationIndex.enabled&&!situationIndex.health(id).paused&&situationIndex.status(id).index_work_remaining
    if(!rawPending&&!situationPending)return
    const timer=setTimeout(()=>{embeddingTimers.delete(id);void idleEmbedding(agent)},500);timer.unref?.();embeddingTimers.set(id,timer)
  }
  function register(toolName,description,schema,execute) {
    const handler=async(args,exec)=>{
      if(closed||exec.signal?.aborted)fail('CANCELLED','插件停止或调用已取消')
      if(managedAncestor(exec.agent))fail('CHILD_MEMORY_DENIED','子代理不能直接操作主会话的记忆库；请把结果交回主会话')
      if(!args||typeof args!=='object'||Array.isArray(args))fail('INVALID_INPUT','参数必须为对象')
      for(const key of Object.keys(args))if(!Object.hasOwn(schema.properties,key))fail('INVALID_INPUT','未知参数')
      for(const key of schema.required)if(args[key]===undefined)fail('INVALID_INPUT','缺少参数')
      const result=await execute(args,exec),session=SID(exec.agent),library=libraryFor(session)
      if(library&&toolName==='cm_task'&&['plan','activate','resume'].includes(args.action)){
        const task=result.task
        working.signalEvent(library,session,args.action==='plan'?'task-start':'task-switch',(task?.id||args.task_id)+':'+(task?.revision??''),clip(task?.title||args.title||'继续当前任务',200))
      }
      if(library&&toolName==='cm_checkpoint'&&args.action==='write')working.signalEvent(library,session,'task-switch',args.task+':'+result.checkpoint.revision,clip(args.task+' '+args.value.progress+' '+(args.value.next_step||''),400))
      if(library&&((toolName==='cm_task'&&['plan','activate','pause','resume'].includes(args.action))||(toolName==='cm_checkpoint'&&args.action==='write'))){
        const event=exec.agent.session?.snapshotEvents?.().at(-1)
        const key=exec.callId||hash([toolName,args.action,result.task?.id,result.task?.revision,result.checkpoint?.task,result.checkpoint?.revision])
        let node=result
        if(result.task?.id){const full=execution.status(library,result.task.id);node={task:{id:full.id,title:full.title,revision:full.revision,status:full.status,paused:!!full.paused,steps:full.steps.map(s=>({id:s.id,title:s.title,tool:s.tool,position:s.position,status:s.status,active:!!s.active}))}}}
        const receipt=activityArchive.taskNode(library,session,toolName+':'+args.action,node,event?{session,seq:event.seq}:null,key)
        if(receipt)try{situations.observe(library,session,receipt.id)}catch(error){store.log(library,'activity-association-failed',{id:receipt.id,code:error.code||'ASSOCIATION_FAILED'})}
      }
      return {ok:true,...result}
    }
    administrativeHandlers.set(toolName,handler)
    const d=ctx.tools.register({name:toolName,description,parameters:schema,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:handler})
    if(typeof d==='function')disposers.push(d)
  }
  register('cm_library','管理独立命名的记忆库。create/list/bind/handoff/rename/settings/status/resume。首次绑定显式进行，不修改原人格。handoff只能在新会话发起，等旧执行真正停止后交接。报错暂停后可在未绑定的维护会话显式resume指定库，必须先核对原会话空闲，不重启DSH。',object({action:str('操作'),name:str('库名'),library_id:str('库ID'),expected_revision:num('库版本'),settings:{type:'object',additionalProperties:true}},['action']),async(args,exec)=>{
    const session=SID(exec.agent)
    if(args.action==='list')return {libraries:store.list()}
    if(args.action==='create')return {library:store.create(args.name)}
    if(args.action==='resume'&&!libraryFor(session)&&args.library_id){
      const lib=store.library(args.library_id),owner=ctx.agents.get(lib.owner)
      if(!owner||owner.status!=='idle')fail('OLD_SESSION_UNVERIFIED','必须先核对原会话已加载且空闲')
      assertNoRunningChildren(lib.owner);store.resume(lib.id,lib.owner);store.log(lib.id,'maintenance-session-resume',{requester:session});return {library:store.library(lib.id)}
    }
    if(args.action==='bind') {
      if(typeof exec.agent.ctx?.systemPrompt?.context!=='function')fail('HOST_API_UNAVAILABLE','缺少恢复上下文接口')
      if(typeof exec.agent.session?.snapshotEvents!=='function')fail('HOST_API_UNAVAILABLE','缺少原文读取接口')
      try{return store.tx(()=>{
        const lib=store.bind(session,args.library_id,args.expected_revision),backfill=capture.backfill(lib.id,exec.agent.session)
        if(config.legacySessionId===session&&config.suppressInitialRestoreOnLegacySession===true)store.db.prepare('UPDATE bindings SET restore=0 WHERE session=?').run(session)
        attach(exec.agent);return {library:lib,backfill}
      })}catch(e){capture.cursors.delete(`${args.library_id}:${session}`);throw e}
    }
    if(args.action==='handoff') {
      const lib=store.library(args.library_id);store.casLibrary(lib.id,args.expected_revision)
      if(!lib.owner||lib.owner===session)fail('INVALID_INPUT','请用bind或选择另一个前任会话')
      const old=ctx.agents.get(lib.owner)
      if(!old||typeof old.cancel!=='function'||typeof old.whenIdle!=='function')fail('OLD_SESSION_UNVERIFIED','需要先加载原会话以核对执行；不能凭不存在就接手')
      if(old.inbox?.nextTurn?.length||old.inbox?.nextStep?.length)fail('PENDING_INPUT','原会话还有排队输入，先处理后再交接')
      if(typeof exec.agent.ctx?.systemPrompt?.context!=='function')fail('HOST_API_UNAVAILABLE','目标会话缺少恢复上下文接口')
      if(transfers.has(lib.id))fail('BUSY','正在交接')
      transfers.add(lib.id)
      try {
        old.cancel({kind:'hook',reason:'continuity-core handoff'},{keepInbox:true})
        // No timeout force-unlock: the old executor may still be changing the desktop.
        await old.whenIdle();exec.signal?.throwIfAborted();assertNoRunningChildren(lib.owner)
        releaseMain(lib.owner);await ctx.sessions.flush(old.session)
        const backfill=capture.backfill(lib.id,old.session)
        if(old.inbox?.nextTurn?.length||old.inbox?.nextStep?.length)fail('PENDING_INPUT','等待期间原会话收到新输入，未交接')
        const current=situations.handoff(lib.id,lib.owner,session,args.expected_revision);attach(exec.agent)
        return {library:current,backfill,previous_session:lib.owner}
      }finally{transfers.delete(lib.id)}
    }
    const {id}=owned(exec)
    if(args.action==='embedding-resume'){const health=embedding.resume(id,session);scheduleEmbedding(exec.agent);return {embedding:health}}
    if(args.action==='rename')return {library:store.rename(id,args.name,args.expected_revision)}
    if(args.action==='settings')return {library:store.settings(id,session,args.settings||{})}
    if(args.action==='resume'){store.resume(id,session);return {library:store.library(id)}}
    if(args.action==='recovery')return {recovery:store.recovery.pending(id),writes_require_review:store.recovery.needsReview(id)}
    if(args.action==='status')return {library:store.library(id),activity:store.busy(id),activity_archive:activityArchive.status(id),recovery:store.recovery.pending(id),extraction:extraction.status(id),consolidation:consolidation.status(id),embedding:embedding.status(id),situation_index:situationIndex.status(id),recent:store.recent(id,null,5).map(r=>({id:r.id,session:r.session,role:r.role,time:r.time})),pending:store.pending(id).slice(0,10).map(entryBrief),tasks:store.tasks(id).slice(0,5).map(taskBrief)}
    fail('INVALID_INPUT','未知记忆库操作')
  })
  register('cm_read','按本库原文ID读取，按字符分页；limit不是条数。state_links只是认识版本线索，不表示整篇原文过时；activity指向同一工具事件的结构化记录，需时用cm_activity read另取。',object({id:str('原文ID'),offset:num('字符偏移'),limit:num('字符上限，默认2000，最多6000')},['id']),async(a,e)=>{const{id}=owned(e),record=store.read(id,a.id,a.offset??0,a.limit??2000),links=evidence.stateHistory.related(id,[record.id]).links,activity=activityArchive.descriptor(id,record.id);return {...record,...(links.length?{state_links:links}:{}),...(activity?{activity}:{})}})
  register('cm_task','结构化任务执行接续。plan定义1—20个有序步骤，每步含id/title/tool；activate用task_id、step_id、expected_revision选择下一未完成步骤；pause/resume用task_id和expected_revision暂停或继续，不取消在途工具、不重放。list/status精简分页，offset默认0、limit最多5。不能用文字把步骤标为完成。verify仅调用已注册的可信只读核验器，未知时不重放。失败后须人工授权一次新尝试。',object({action:{type:'string',enum:['plan','activate','pause','resume','list','status','verify']},title:str('任务标题'),steps:{type:'array',items:object({id:str('步骤ID'),title:str('步骤标题'),tool:str('实际工具名')},['id','title','tool'])},task_id:str('任务ID'),step_id:str('步骤ID'),expected_revision:num('任务版本'),call_id:str('未知调用ID'),operation_session:str('未知调用所属原会话，可在交接后指定'),offset:num('分页偏移，默认0'),limit:num('每页条数，默认5，最多5')},['action']),async(a,e)=>{
    const{id,session}=owned(e)
    if(a.action==='plan'){const task=execution.plan(id,session,a.title,a.steps);return {task:execution.summary(id,task.id)}}
    if(a.action==='list'){const offset=a.offset??0,limit=a.limit??5;integer(offset,'offset');integer(limit,'limit',1,5);const page=execution.listPage(id,offset,limit);return {...page,tasks:page.tasks.map(t=>({id:t.id,title:clip(t.title,60),revision:t.revision,paused:!!t.paused}))}}
    if(a.action==='status')return {task:execution.summary(id,a.task_id,a.offset??0,a.limit??5)}
    if(a.action==='activate'){execution.activate(id,session,a.task_id,a.step_id,a.expected_revision);return {task:execution.summary(id,a.task_id)}}
    if(a.action==='pause'||a.action==='resume'){execution.setPaused(id,session,a.task_id,a.action==='pause',a.expected_revision);return {task:execution.summary(id,a.task_id)}}
    if(a.action==='verify')return execution.verify(id,a.operation_session||session,a.call_id,{signal:e.signal})
  })
  register('cm_lookup','本库本地向量与关键词混合检索；最多5条，每条含id、来源标题、排序分、摘要、时间、quote原文短句且不超过120字符。排序分不是概率，quote只证明原话；按id用cm_read核实全文。检索故障不锁聊天，修复后用cm_library embedding-resume。',object({query:str('查询'),limit:num('默认3，最多5')},['query']),async(a,e)=>{const{id,session}=owned(e);if(store.library(id).error)fail('LIBRARY_PAUSED','本库已暂停；核对故障后手动resume');try{const events=e.agent.session?.snapshotEvents?.()||[],turn=events.findLast(ev=>ev.type==='turn/start');return await embedding.lookup(id,session,a.query,a.limit??3,e.signal,turn?{session,fromSeq:turn.seq}:null)}catch(error){embedding.markFailure(id,error.code);throw error}})
  register('cm_evidence','核验原文：supported/contradicted/insufficient。scope默认source，仅核对选定来源；current-state须给1—2个state_keys，自动补有效认可版本原文，at可选过去时点，只有旧版引用时保守返回未证实。引用含邻近原句与字符范围。额外调用模型，共用整理预算，需evidenceEnabled=true；失败不自动重试。',object({action:{type:'string',enum:['verify','status','resume']},query:str('核验问题'),ids:{type:'array',items:{type:'string'},description:'可选最多3个原文ID'},scope:{type:'string',enum:['source','current-state']},state_keys:{type:'array',items:{type:'string'},description:'current-state须给1—2个稳定认识键'},at:str('current-state可选含时区ISO过去时点')},[]),async(a,e)=>{
    const{id,session}=owned(e)
    if(a.action==='status')return {enabled:!!extraction.status(id)?.config.evidenceEnabled,...evidence.status(id)}
    if(a.action==='resume')return evidence.resume(id)
    if(a.action&&a.action!=='verify')fail('INVALID_INPUT','未知证据操作')
    if(store.library(id).error)fail('LIBRARY_PAUSED','本库已暂停')
    assertNoRunningChildren(session)
    const turn=e.agent.session?.snapshotEvents?.().findLast(ev=>ev.type==='turn/start')
    return evidence.verify(id,session,a.query,a.ids,e.signal,turn?{session,fromSeq:turn.seq}:null,{scope:a.scope,state_keys:a.state_keys,at:a.at})
  })
  register('cm_self','维护有出处的认识版本。propose候选、accept认可、defer暂存。get默认是最新版本，可能仍是未认可候选；timeline按key查看当前认可、旧版、待审与过期，at可查过去时点，before_revision翻旧版本。related按refs找关联认识。history/get/timeline/related结果按字符分页，list简览。认可不等于外部事实已验证。',object({action:{type:'string',enum:['propose','accept','defer','get','list','history','timeline','related'],description:'认识操作'},key:str('稳定短键'),kind:str('identity/relationship/preference/goal/boundary/question/fact/lesson/transient'),body:str('陈述，区分表达和已验证事实'),reason:str('依据与不确定性'),refs:{type:'array',items:{type:'string'}},expected_revision:num('propose为上一版本、首次0；accept/defer可用作目标revision的别名'),revision:num('accept/defer目标版本；get可选旧版'),expires:num('临时状态过期Unix毫秒'),at:str('timeline可选含时区ISO时间，不晚于现在'),before_revision:num('timeline翻页，仅读取此版本之前的历史'),offset:num('返回内容字符偏移'),limit:num('返回内容字符上限，默认2000，最多6000')},['action']),async(a,e)=>{
    const{id,session}=owned(e)
    if(a.action==='propose')return {entry:store.propose(id,{...a,expectedRevision:a.expected_revision??0})}
    if(['accept','defer'].includes(a.action)&&a.revision!==undefined&&a.expected_revision!==undefined&&a.revision!==a.expected_revision)fail('INVALID_INPUT','revision与expected_revision不一致；认可/暂存时两者都表示目标候选版本')
    if(a.action==='accept')return {entry:store.accept(id,session,a.key,a.revision??a.expected_revision)}
    if(a.action==='get'){const item=store.entry(id,a.key,a.revision??null);return {entry:item?{key:item.key,revision:item.revision,...page(JSON.stringify(item),a.offset??0,a.limit??2000)}:null}}
    if(a.action==='list')return {current:store.current(id).slice(0,20).map(entryBrief),pending:store.pending(id).slice(0,20).map(entryBrief),note:'简览最多各20条；get可按key/version分页读取'}
    if(a.action==='history')return {history:page(JSON.stringify(store.history(id,a.key)),a.offset??0,a.limit??2000)}
    if(a.action==='timeline')return {timeline:page(JSON.stringify(evidence.stateHistory.timeline(id,a.key,{at:a.at,before_revision:a.before_revision})),a.offset??0,a.limit??2000)}
    if(a.action==='related')return {relations:page(JSON.stringify(evidence.stateHistory.related(id,a.refs)),a.offset??0,a.limit??2000)}
    if(a.action==='defer')return {review:store.defer(id,session,a.key,a.revision??a.expected_revision,a.reason)}
    fail('INVALID_INPUT','未知自我状态操作')
  })
  register('cm_checkpoint','保存真实任务进度。read查看，write写入新版本，write必须带task、value和refs。value.status只用planned/running/paused/blocked/review/done/cancelled；value.progress写已经核实的进度；未done/cancelled时必须带value.next_step。只恢复线索，不自动重放动作。',object({action:{type:'string',enum:['read','write'],description:'read查看或write保存'},task:str('任务键，同一任务沿用原键'),value:{type:'object',properties:{status:{type:'string',enum:['planned','running','paused','blocked','review','done','cancelled'],description:'计划planned，进行running，暂停paused，受阻blocked，待审review，完成done，取消cancelled'},progress:str('已经发生或完成的进度，不把计划写成结果'),next_step:str('下一步；status不是done/cancelled时必填')},required:['status','progress'],additionalProperties:true},refs:{type:'array',items:{type:'string'},description:'write必填，1—20个支持当前进度的本库原文ID'},expected_revision:num('上一版本，首次0；更新时先read核对'),offset:num('read字符偏移'),limit:num('read字符上限')},['action']),async(a,e)=>{const{id,session}=owned(e);if(a.action==='read'){const tasks=store.tasks(id);return a.task?{task:page(JSON.stringify(tasks.find(t=>t.task===a.task)||null),a.offset??0,a.limit??2000)}:{tasks:tasks.slice(0,10).map(taskBrief)}};if(a.action==='write')return {checkpoint:store.checkpoint(id,session,a.task,a.value,a.refs,a.expected_revision??0)};fail('INVALID_INPUT','未知检查点操作')})
  register('cm_extraction','配置提炼及手动resume/pause/status。situationsEnabled另允许后台情境整理，与提炼、证据核验共用日调用预算；配置保存后两类整理均暂停，分别resume。密钥仅用环境变量引用，不填写密钥值。失败和限额后不自动重试或换源。',object({action:str('configure/resume/pause/status'),config:{type:'object',additionalProperties:true}},['action']),async(a,e)=>{
    const{id,session}=owned(e)
    if(a.action==='configure')return store.tx(()=>{const result=extraction.configure(id,session,a.config);consolidation.pause(id);return result})
    if(a.action==='resume'){const state=extraction.resume(id,session);scheduleExtraction(e.agent);return {extraction:state}}
    if(a.action==='pause'){extraction.pause(id);return {extraction:extraction.status(id)}}
    if(a.action==='status')return {extraction:extraction.status(id),consolidation:consolidation.status(id)}
    fail('INVALID_INPUT','未知提炼操作')
  })
  register('cm_report','按需查看接续与认识变更记录、用量和状态的简览，不主动弹成长报告。完整文档通过CLI显式导出。',object({}),async(_a,e)=>{const{id}=owned(e),r=store.report(id);return {report:{library:r.library,records:r.records,states:r.states.slice(0,10).map(entryBrief),pending:r.pending.slice(0,10).map(entryBrief),tasks:r.tasks.slice(0,5).map(taskBrief),audit:r.audit.slice(0,20),usage:r.usage.slice(0,20)}}})
  register('cm_delete','用户明确要求后删除本库一条记录及引用它的状态组，防止从同一来源重新导回。DSH原日志和既有备份不随之删除。',object({id:str('原文ID'),confirm:{type:'boolean',description:'用户明确确认删除'}},['id','confirm']),async(a,e)=>{if(a.confirm!==true)fail('CONFIRM_REQUIRED','未确认删除');const{id,session}=owned(e);return store.removeRecord(id,session,a.id)})

  register('cm_scene','按原文ID读取当时同一会话的相邻聊天片段，带说话者、时间、出处和截取位置；只是原文视图，不生成情绪或因果结论。',object({id:str('原文ID'),window:num('前后各0—3条，默认2'),max_chars:num('结果总字符预算，800—6000，默认3000')},['id']),async(a,e)=>{const{id}=owned(e);return scenes.build(id,a.id,{window:a.window??2,maxChars:a.max_chars??3000})})
  register('cm_activity','记录宿主可见活动。status/list/read看记录，resume核对后恢复并重扫当前原生会话；不执行或重放动作。observe保存视频/游戏/网页/桌面片段报告，需title、body、1—5条refs、idempotency_key；视频另需source及start_ms/end_ms。字幕/工具结果/主体自述只是依据类型，记录成功不证明已观看或完成。不要编造未观察内容。原文与结构化载荷分开，read按字符分页。',object({action:{type:'string',enum:['status','list','read','resume','observe']},part:{type:'string',enum:['payload','metadata'],description:'read部分，默认payload；遮蔽及省略详情用metadata分页读取'},id:str('read的原文ID'),kind:{type:'string',enum:['video','game','browser','desktop']},title:str('活动标题'),body:str('确实可见的片段或如实标为自述，不把计划写为完成'),refs:{type:'array',items:{type:'string'},description:'1—5条本库有效原文依据'},source:str('视频URL或活动来源，不会自动访问'),start_ms:num('媒体片段开始毫秒，不是墙钟时间'),end_ms:num('媒体片段结束毫秒'),evidence_type:{type:'string',enum:['agent-report','subtitle','tool-output']},observed_at:str('可选报告中的观察时间，ISO含时区；未知省略'),idempotency_key:str('库内同一活动片段沿用唯一键；改内容另存修订'),offset:num('list条数或read字符偏移'),limit:num('list最多10；read默认1200字符，最多6000')},['action']),async(a,e)=>{
    const{id,session}=owned(e)
    if(a.action==='status')return {activity:activityArchive.status(id)}
    if(a.action==='list')return {activity:activityArchive.list(id,{offset:a.offset??0,limit:a.limit??5})}
    if(a.action==='read')return {activity:activityArchive.payload(id,a.id,{offset:a.offset??0,limit:a.limit??1200,part:a.part??'payload'})}
    if(a.action==='resume'){activityArchive.resume(id,session);const backfill=capture.backfill(id,e.agent.session,{rescan:true});return {activity:activityArchive.status(id),backfill,note:'只重扫原生日志，不执行工具或重放任务。'}}
    if(a.action==='observe'){
      if(a.kind==='video'&&!a.source)fail('INVALID_INPUT','视频报告需要来源链接或标识')
      const event=e.agent.session?.snapshotEvents?.().at(-1),activity=activityArchive.report(id,session,a,event?{session,seq:event.seq}:null)
      try{situations.observe(id,session,activity.id)}catch(error){store.log(id,'activity-association-failed',{id:activity.id,code:error.code||'ASSOCIATION_FAILED'})}
      return {activity}
    }
    fail('INVALID_INPUT','未知活动操作')
  })
  register('cm_working','status/clear查看或清空临时工作集。focus用query声明当前任务/注意点并触发召回；换任务前用检查点保存真实进度，不宣称旧任务完成。feedback记录引用cited/帮助helpful/重申reaffirmed/纠正corrected/失效invalidated，需id、1—3条后续原文refs和reason；cited依据需含被引用ID。负向反馈必须给具体cue，检索时可高置信语义匹配，不宣判整篇无效。feedback-status分页查反馈；feedback-retract需feedback_id、refs、reason；feedback-resume恢复已核对的纠正索引。link需id/target_id、relation、subject/topic/scope、两端精确原句与reason；changed为变化、corrected为有归属的纠正、disputed为争议、contextual区分情境，不认证事实。link-status查看两端：摘要与关系详情都按offset/limit字符分页；relation_cursor选择下一批关系（原样传relation_page.next_cursor），不重复发送已读批次；link-retract需link_id/refs/reason。曝光和读取不算强化，不改人格或原文。',object({action:{type:'string',enum:['status','clear','focus','feedback','feedback-status','feedback-retract','feedback-resume','link','link-status','link-retract']},id:str('被使用的原文ID；link为旧原文，link-status为任一端'),target_id:str('link的另一条原文ID'),relation:{type:'string',enum:['changed','corrected','disputed','contextual']},subject:str('说法归属主体'),topic:str('被关联的具体事项'),scope:str('适用情境，避免不同场景混为矛盾'),source_quote:str('旧原文内精确片段，最多160字符'),target_quote:str('另一原文内精确片段，最多160字符'),link_id:str('link-retract的关联ID'),kind:{type:'string',enum:['cited','helpful','reaffirmed','corrected','invalidated']},refs:{type:'array',items:{type:'string'},description:'1—3条实际后续记录，不含被回忆的原文本身'},reason:str('具体依据，不写空泛奖励'),cue:str('具体线索，纠正或失效必填，至少2字符'),feedback_id:str('撤销的反馈ID'),query:str('focus的当前注意点，或反馈状态查询线索'),offset:num('字符分页起点'),limit:num('字符分页上限，默认1200，最多3000'),relation_cursor:str('link-status关系分页游标，原样传入上一页relation_page.next_cursor'),relation_limit:num('link-status关系每页条数，1—20，默认5')},['action']),async(a,e)=>{
    const{id,session}=owned(e),dynamics=embedding.memoryDynamics
    if(a.action==='link'||a.action==='link-retract'){
      const relation=a.action==='link'?embedding.claimLinks.record(id,session,a):embedding.claimLinks.retract(id,session,a)
      working.invalidate(id,session,'claim-link-updated');return {relation}
    }
    if(a.action==='link-status'){
      integer(a.limit??1200,'limit',1,3000)
      const pageLimit=a.relation_limit??5
      integer(pageLimit,'relation_limit',1,20)
      const cursor=a.relation_cursor??null
      const full=cursor==null?embedding.claimLinks.status(id,a.id,{limit:pageLimit}):null
      const relation=cursor==null?full.relation_page:embedding.claimLinks.relations(id,a.id,{cursor,limit:pageLimit})
      const payload=(cursor==null?{groups:full.groups,more:full.more,note:full.note}:{note:relation.note})
      payload.links=relation.items
      return {relations:page(JSON.stringify(payload),a.offset??0,a.limit??1200),relation_page:{has_more:relation.has_more,next_cursor:relation.next_cursor,returned:relation.returned,recorded_total:relation.recorded_total,limit:relation.limit,displayed_characters:JSON.stringify(payload).length,note:'关系详情在这段字符分页内；next_cursor只选下一批，不重复已读关系。'}}
    }
    if(a.action==='focus'){
      text(a.query,'query',800);working.invalidate(id,session,'focus-change');working.signalEvent(id,session,'task-switch','explicit-focus:'+hash(a.query),a.query)
      store.log(id,'working-focus-declared',{query:a.query,task_completion_asserted:false});return {focus:clip(a.query,160),recall_scheduled:working.config.enabled,note:'已声明当前注意点；下一模型步骤按预算召回，未标记任务完成。'}
    }
    if(a.action==='feedback-resume'){working.invalidate(id,session,'feedback-index-resumed');return {correction_index:dynamics.resume(id,session)}}
    if(a.action==='feedback'||a.action==='feedback-retract'){
      const feedback=a.action==='feedback'?dynamics.record(id,session,a):dynamics.retract(id,session,a)
      working.invalidate(id,session,'feedback-updated');return {feedback}
    }
    if(a.action==='feedback-status'){integer(a.limit??1200,'limit',1,3000);return {feedback:page(JSON.stringify(a.id?dynamics.describe(id,a.id,a.query||''):dynamics.recent(id)),a.offset??0,a.limit??1200)}}
    if(a.action==='clear')working.invalidate(id,session,'manual-clear')
    if(!['clear','status'].includes(a.action))fail('INVALID_INPUT','未知工作记忆操作')
    return {...working.status(id,session),memory_dynamics:{...dynamics.status(id,embedding.cached),note:'仅有出处的使用反馈影响排序；曝光和读取不加权，淡出不删除。'}}
  })
  const sourceIds={type:'array',items:{type:'string'},description:'1—20个本库原文ID，不能用当前整理文字冒充出处'}
  register('cm_situation','持续情境档案。create/update追加有出处的表述，不改原话；interpretation是后来解读，creative是创作。focus明确当前情境，后续捕获原文仅建立关联，不自动断言完成。get短包/read分页原文档；timeline版本。link默认possible；part-of为子情境，merged也不删除源且可用unlink撤销，出现后续依赖时先核对。',object({
    action:{type:'string',enum:['create','update','attach','focus','get','read','list','timeline','related','link','unlink','maintenance-status','maintenance-resume','maintenance-pause','search','index-status','index-warm','index-resume']},
    query:str('search情境摘要语义检索词，最多1000字符；只返回候选，不自动合并'),
    id:str('情境ID；unlink时为关系ID'),target_id:str('link另一情境ID'),title:str('情境名称，最多160字符'),
    mode:{type:'string',enum:['unknown','experience','creative','mixed']},status:{type:'string',enum:['active','paused','closed']},
    refs:sourceIds,assertions:{type:'array',items:object({slot:{type:'string',enum:['background','goal','progress','question','self-report','interpretation','source-claim']},body:str('带不确定性和归属的表述'),refs:sourceIds,event_time:str('事情所述时间，ISO含时区；未知省略'),attributed_to:str('自述者或外部说法来源')},['slot','body','refs'])},
    expected_revision:num('update/link情境版本；unlink关系版本'),expected_target_revision:num('link另一端版本'),reason:str('修改或关联依据'),
    kind:{type:'string',enum:['source','creative','self-report','interpretation','observation','possible','related','merged','part-of']},clear:{type:'boolean',description:'focus时true明确退出当前情境'},
    revision:num('get/read指定旧版'),at:str('get/read按记录时点回看，ISO含时区'),before_revision:num('timeline仅读此前版本'),offset:num('list条数或read字符偏移'),limit:num('list/timeline最多10；read默认2000，最多6000'),max_chars:num('get短包预算，350—3000，默认650')
  },['action']),async(a,e)=>{
    const {id,session}=owned(e),opts={revision:a.revision,at:a.at}
    if(a.action==='search')return {situations:await situationIndex.lookup(id,session,a.query,a.limit??3,e.signal)}
    if(a.action==='index-status')return {situation_index:situationIndex.status(id)}
    if(a.action==='index-warm')return {situation_index:await situationIndex.warm(id,session,e.signal)}
    if(a.action==='index-resume'){const health=situationIndex.resume(id,session);scheduleEmbedding(e.agent);return {situation_index:health}}
    if(a.action==='maintenance-status')return {maintenance:consolidation.status(id)}
    if(a.action==='maintenance-resume'){const maintenance=consolidation.resume(id,session);scheduleExtraction(e.agent);return {maintenance}}
    if(a.action==='maintenance-pause'){consolidation.pause(id);return {maintenance:consolidation.status(id)}}
    if(a.action==='create'){const d=situations.create(id,session,{title:a.title,refs:a.refs,mode:a.mode,assertions:a.assertions});return {situation:situations.capsule(id,d.id)}}
    if(a.action==='update'){const d=situations.revise(id,session,a.id,{expected_revision:a.expected_revision,title:a.title,status:a.status,mode:a.mode,append_assertions:a.assertions,refs:a.refs,reason:a.reason});return {situation:situations.capsule(id,d.id)}}
    if(a.action==='attach')return situations.attach(id,session,a.id,a.refs,{kind:a.kind})
    if(a.action==='focus'){const result=situations.focus(id,session,a.clear===true?null:a.id);if(result.id)working.signalEvent(id,session,'task-switch',result.id,situations.get(id,result.id).title);return result}
    if(a.action==='get'){const d=situations.get(id,a.id,opts);return {situation:situations.capsule(id,a.id,{revision:d.revision,maxChars:a.max_chars??650}),relations:situations.relations(id,a.id).slice(0,3)}}
    if(a.action==='read')return {document:page(JSON.stringify(situations.get(id,a.id,opts)),a.offset??0,a.limit??2000)}
    if(a.action==='list')return situations.list(id,{offset:a.offset??0,limit:a.limit??5})
    if(a.action==='related')return {candidates:situations.related(id,a.refs,a.limit??3).map(d=>({id:d.id,revision:d.revision,title:clip(d.title,45),status:d.status,hits:d.hits,source_count:d.source_count})),note:'按原文归属查情境；相似候选不自动合成一次经历。'}
    if(a.action==='timeline')return situations.timeline(id,a.id,{before_revision:a.before_revision,limit:a.limit??5})
    if(a.action==='link')return situations.link(id,session,a.id,a.target_id,{kind:a.kind,expected_revision:a.expected_revision,expected_target_revision:a.expected_target_revision,refs:a.refs,reason:a.reason})
    if(a.action==='unlink')return situations.unlink(id,session,a.id,a.expected_revision)
    fail('INVALID_INPUT','未知情境操作')
  })

  disposers.push(ctx.on('agent/pre-step',async(payload,next)=>{
    const {agent,signal}=payload,session=SID(agent),id=libraryFor(session)
    const ancestor=managedAncestor(agent)
    if(ancestor){
      if(transfers.has(ancestor.id)||store.library(ancestor.id).owner!==ancestor.session)fail('HANDOFF_IN_PROGRESS','记忆库交接中，不能启动新的子代理')
      if(id)fail('CHILD_MEMORY_DENIED','子代理不能绑定主会话的记忆库')
      return next()
    }
    if(!id)return next()
    if(agent.session?.header?.parentSession)fail('SUBAGENT_NOT_ALLOWED','子代理不能取得这份库的运行权')
    store.assertOwner(id,session)
    if(transfers.has(id))fail('HANDOFF_IN_PROGRESS','记忆库交接中')
    embeddingJobs.get(id)?.abort()
    const fresh=!held.has(session)
    if(fresh)held.set(session,{id,token:store.begin(id,session,'main')})
    try {
      signal?.throwIfAborted();capture.backfill(id,agent.session);attach(agent);const decision=await next()
      if(decision.kind!=='enter'){if(fresh)releaseMain(session);return decision}
      if(working.config.enabled){
        const user=store.db.prepare("SELECT seq,text FROM records WHERE library=? AND session=? AND role='user' ORDER BY seq DESC LIMIT 1").get(id,session)
        const events=agent.session?.snapshotEvents?.()||[],turn=events.findLast(ev=>ev.type==='turn/start'),turnSeq=turn?.seq??user?.seq??0
        const incoming=pendingUserMessage(payload.messages)
        const persisted=user?events.findLast(ev=>ev.type==='user/message'&&ev.seq===user.seq):null
        const persistedId=(persisted?.data?.message||persisted?.data)?.id
        const userKey=incoming?'message:'+(incoming.id||hash([turnSeq,incoming.text])):typeof persistedId==='string'?'message:'+persistedId:null
        const event=working.takeTrigger(id,session,turnSeq)
        if(incoming||user||event)await working.prepare({library:id,session,query:event?.query||incoming?.text||user?.text||'',userSeq:incoming?null:user?.seq??turnSeq,userKey,turnSeq,signal,event})
      }
      return decision
    }
    catch(e){if(fresh)releaseMain(session);store.pause(id,e.code||'PRE_STEP_FAILED');throw e}
  },{prepend:true}))
  disposers.push(ctx.on('agent/request-error',async({agent,failure},next)=>{
    const session=SID(agent),id=libraryFor(session);if(!id)return next()
    // End this failed request without retrying. A provider transport failure is
    // not evidence that durable memory is corrupt; do not persistently lock it.
    // Keep the activity lease until turn/end or idle, and never erase an earlier
    // capture/vector/ownership error while handling a model failure.
    if(['TRANSPORT','TIMEOUT','ABORTED'].includes(failure?.code)){
      store.log(id,'main-request-ended',{session,code:failure.code,retry:false})
      ctx.logger?.warn?.(`[continuity-core] ${session}: ${failure.code}; 当前请求结束，不自动重试；未锁定记忆库`)
      return undefined
    }
    if(store.library(id).error)return undefined
    store.pause(id,'MAIN_REQUEST_FAILED');notifyError(session,'MAIN_REQUEST_FAILED');return undefined
  },{prepend:true}))
  disposers.push(ctx.on('session/event',(session,event)=>{
    if(!event&&session?.session){for(const ev of session.events||[session.event])if(ev)onEvent(session.session,ev);return}
    if(Array.isArray(event)){for(const ev of event)onEvent(session,ev);return}onEvent(session,event)
  }))
  function onEvent(session,event) {
    if(closed||!session||!event)return
    const id=libraryFor(session.id);if(!id){const ancestor=managedAncestor(ctx.agents.get(session.id));if(ancestor){execution.observe(ancestor.id,session.id,event);store.recovery.observe(ancestor.id,session.id,event)}return}if(store.library(id).owner!==session.id)return
    try {
      execution.observe(id,session.id,event)
      store.recovery.observe(id,session.id,event)
      const captured=capture.event(id,session.id,event)
      if(captured)try{situations.observe(id,session.id,captured)}catch(e){store.log(id,'situation-association-failed',{session:session.id,code:e.code||'SITUATION_FAILED'});ctx.logger?.warn?.('[continuity-core] 情境关联未完成；原文已保存')}
      if(event.type==='compaction/end'){working.invalidate(id,session.id,'compaction');store.markCompacted(session.id);store.log(id,'compaction-ended',{session:session.id,seq:event.seq})}
      if(event.type==='assistant/message'){
        if(captured)store.markRestored(session.id)
        const usage=normalizeUsage(event.data?.usage,'dsh')
        store.db.prepare('INSERT OR IGNORE INTO usage(id,library,source,status,input,output,cache_read,cache_write,time) VALUES(?,?,?,?,?,?,?,?,?)').run(hash(`${session.id}:${event.seq}`),id,'main','completed',usage?.input??null,usage?.output??null,usage?.cache_read??null,usage?.cache_write??null,typeof event.time==='number'?event.time:Date.parse(event.time))
      }
      if(event.type==='turn/end')releaseMain(session.id)
    }catch(e){store.pause(id,e.code||'CAPTURE_FAILED');notifyError(session.id,e.code||'CAPTURE_FAILED')}
  }
  disposers.push(ctx.on('agent/created',({agent,source})=>{const id=libraryFor(SID(agent));if(id){if(source==='compact')store.markCompacted(SID(agent));attach(agent);scheduleEmbedding(agent)}}))
  disposers.push(ctx.on('agent/status',({agent,status})=>{if(status==='idle'){releaseMain(SID(agent));void idleExtraction(agent);void idleEmbedding(agent)}else{const id=libraryFor(SID(agent));if(id)embeddingJobs.get(id)?.abort()}}))
  disposers.push(ctx.on('agent/disposed',({agent})=>{releaseMain(SID(agent));toolContext.clear(SID(agent));const d=seen.get(agent)?.dispose;if(typeof d==='function')d();seen.delete(agent)}))
  // Proof sources for "the tool body never ran": the resolved definition identity and the host's own
  // FS edit-intent stage. A tool body can throw the same codes, so neither name nor code is enough.
  const nativeDefinitions=new Map(),nativeNames=new Set(['edit','write'])
  const lookupDefinition=(name,scope)=>{
    if(typeof ctx.tools?.get!=='function')return {available:false}
    try{return {available:true,definition:ctx.tools.get(name,scope)}}catch{return {available:false}}
  }
  const snapshotDefinition=definition=>{
    if(!definition||typeof definition.execute!=='function')return null
    try{return {definition,execute:definition.execute,parameters:JSON.stringify(definition.parameters)}}catch{return null}
  }
  const matchesDefinition=(captured,definition)=>{
    if(!captured||captured.definition!==definition||captured.execute!==definition?.execute)return false
    try{return captured.parameters===JSON.stringify(definition.parameters)}catch{return false}
  }
  const captureNative=name=>{const current=lookupDefinition(name);if(current.available&&!nativeDefinitions.has(name)){const captured=snapshotDefinition(current.definition);if(captured)nativeDefinitions.set(name,captured)}}
  for(const name of nativeNames)captureNative(name)
  const definitelyInvalidArguments=(schema,args)=>{
    if(!schema||typeof validateToolArguments!=='function')return false
    try{const violations=validateToolArguments(schema,args,'');return Array.isArray(violations)&&violations.length>0}catch{return false}
  }
  const editIntents=new Map()
  const rememberIntent=(key,value)=>{editIntents.set(key,value);while(editIntents.size>64)editIntents.delete(editIntents.keys().next().value)}
  for(const operation of ['edit','write'])disposers.push(ctx.on('fs/'+operation+'-intent',async(target,actor,next)=>{
    const session=actor?.agent?SID(actor.agent):null,callId=actor?.callId,key=session&&callId?session+'\u0000'+callId:null
    const record={tool:actor?.name||null,operation,rejected:false,code:null}
    try{const value=await next();if(key)rememberIntent(key,{...record,accepted:true,intentKind:value?.kind??null});return value}
    catch(error){const rejected={...record,rejected:true,code:error?.code||'FS_INTENT_REJECTED'};if(key)rememberIntent(key,rejected);throw error}
  },{prepend:true}))
  // A child may perform a task, but only the parent owns this library and its recovery state.
  disposers.push(ctx.on('tools/execute',async(exec,next)=>{
    const session=SID(exec.agent),id=libraryFor(session)
    if(managedAncestor(exec.agent)&&/^cm_/.test(exec.name||''))fail('CHILD_MEMORY_DENIED','子代理不能直接操作主会话的记忆库')
    if(id){store.assertOwner(id,session);store.recovery.assertTool(id,exec.name,exec.arguments)}
    const parent=managedAncestor(exec.agent);if(parent)store.recovery.assertTool(parent.id,exec.name,exec.arguments)
    const managed=id||parent?.id
    if(!managed)return next()
    const before=lookupDefinition(exec.name,exec.agent),global=lookupDefinition(exec.name)
    // A global-identical visible definition is the strongest identity a plugin can observe. The first
    // observed global identity is frozen so a later replacement cannot inherit trust; a scoped shadow
    // is a different object and never qualifies.
    const sameGlobal=before.available&&global.available&&before.definition!==undefined&&before.definition===global.definition
    if(sameGlobal&&nativeNames.has(exec.name))captureNative(exec.name)
    const trustedNative=sameGlobal&&nativeNames.has(exec.name)&&matchesDefinition(nativeDefinitions.get(exec.name),before.definition)
    const invalidArguments=before.available&&!!before.definition&&definitelyInvalidArguments(before.definition.parameters,exec.arguments)
    const trust=()=>{const after=lookupDefinition(exec.name,exec.agent),afterGlobal=lookupDefinition(exec.name),intent=session&&exec.callId?editIntents.get(session+'\u0000'+exec.callId):undefined
      if(session&&exec.callId)editIntents.delete(session+'\u0000'+exec.callId)
      const stableNative=trustedNative&&after.available&&afterGlobal.available&&after.definition===afterGlobal.definition&&matchesDefinition(nativeDefinitions.get(exec.name),after.definition)
      const sameIntent=!!intent&&intent.tool===exec.name&&intent.operation===exec.name
      return {unknownTool:before.available&&after.available&&before.definition===undefined&&after.definition===undefined,nativeEdit:exec.name==='edit'&&stableNative,nativeWrite:exec.name==='write'&&stableNative,invalidArguments:invalidArguments&&stableNative,editIntentRejected:sameIntent&&intent.rejected===true,editIntentAccepted:sameIntent&&intent.accepted===true,editIntentCode:intent?.code||null,writeIntentAccepted:sameIntent&&intent.accepted===true,writeIntentKind:intent?.intentKind??null}}
    const call={callId:exec.callId,name:exec.name,arguments:exec.arguments}
    execution.start(managed,session,call)
    const failureRecall=()=>{if(!/^cm_/.test(exec.name||'')){const owner=parent?.session||session;working.signalEvent(managed,owner,'tool-failure',exec.callId||exec.name,'工具 '+clip(exec.name,100)+' 失败；核对过去相同工具的错误、处理办法与当前任务')}}
    try{const result=await next();execution.complete(managed,session,exec.callId,result,{trust:trust()});if(toolOutcome(result).isError)failureRecall();else if(id)try{toolContext.observe(managed,session,exec.name,exec.arguments)}catch(error){store.log(managed,'tool-context-hint-failed',{code:error.code||'CONTEXT_HINT_FAILED',main_chat_blocked:false})}return result}
    catch(error){execution.complete(managed,session,exec.callId,{error:{code:error.code,message:'Host tool execution failed'}},{thrown:true,trust:trust()});failureRecall();throw error}
  },{prepend:true}))
  disposers.push(ctx.on('llm/stream',async function*(request,next){
    const session=request.sessionId,id=libraryFor(session)
    const ancestor=managedAncestor(ctx.agents.get(session))
    if(ancestor){
      if(id)fail('CHILD_MEMORY_DENIED','子代理不能取得主会话的记忆库')
      if(transfers.has(ancestor.id)||store.library(ancestor.id).owner!==ancestor.session)fail('HANDOFF_IN_PROGRESS','记忆库交接中，不能运行子代理')
      const current=childStreams.get(session)
      childStreams.set(session,{count:(current?.count||0)+1,owner:ancestor.session})
      try{yield*next()}finally{const stream=childStreams.get(session);if(stream?.count<=1)childStreams.delete(session);else childStreams.set(session,{...stream,count:stream.count-1})}
      return
    }
    if(!id){if(!session&&store.db.prepare('SELECT 1 FROM activity LIMIT 1').get())fail('UNATTRIBUTED_MODEL_CALL','活动期间出现无法归属的辅助模型调用，无法保证单库串行');yield*next();return}
    store.assertOwner(id,session)
    const busy=store.busy(id),extracting=request.system===EXTRACTION_SYSTEM,consolidating=request.system===CONSOLIDATION_SYSTEM,verifying=request.system===EVIDENCE_SYSTEM,auxiliary=extracting||verifying||consolidating
    if(streams.has(id)||(!auxiliary&&!isLoop(request)&&request.purpose!=='compaction')||(extracting&&busy?.kind!=='extract')||(consolidating&&(busy?.kind!=='consolidate'||!consolidation.jobs.has(id)))||(verifying&&(!evidence.jobs.has(id)||!['main','verify'].includes(busy?.kind))))fail('SECOND_MODEL_NOT_ALLOWED','同库只允许一个主模型或串行整理/核验调用')
    streams.add(id);try{yield*next()}finally{streams.delete(id)}
  },{prepend:true}))
  for(const agent of ctx.agents.list?.()||[]){attach(agent);scheduleEmbedding(agent)}
  try{if(config.manager?.enabled===true)manager=await createManager({store,execution,extraction,embedding,situations,situationIndex,activityArchive,working,consolidation,agents:ctx.agents,invoke:(name,args,exec)=>administrativeHandlers.get(name)(args,exec),port:config.manager.port??0})}
  catch(error){try{await dispose()}catch(cleanup){throw new AggregateError([error,cleanup],'插件初始化和清理均失败')}throw error}
  async function dispose(){
    if(closed)return;closed=true;lifecycle.abort()
    working.close()
    toolContext.clear()
    const errors=[],cleanup=async fn=>{try{await fn()}catch(e){errors.push(e)}}
    await cleanup(()=>manager?.close())
    for(const timer of maintenanceTimers.values())clearTimeout(timer);maintenanceTimers.clear()
    for(const timer of embeddingTimers.values())clearTimeout(timer);embeddingTimers.clear()
    await cleanup(()=>consolidation.stop());await cleanup(()=>extraction.stop());await cleanup(()=>evidence.stop())
    await cleanup(()=>embedding.exclusive(null,async()=>{}))
    // Do not erase uncertain active run markers on unload; next start requires manual review.
    for(const d of disposers.reverse())if(typeof d==='function')await cleanup(d)
    for(const entry of seen.values())if(typeof entry.dispose==='function')await cleanup(entry.dispose)
    await cleanup(()=>embedding.close());await cleanup(()=>store.close())
    if(errors.length)throw new AggregateError(errors,'插件清理有失败；其余资源均已执行清理流程')
  }
  ctx.effect(()=>dispose)
  return {store,capture,activityArchive,extraction,embedding,evidence,execution,scenes,working,situations,situationIndex,contextFrame,consolidation,manager,idleExtraction,idleEmbedding,dispose}
}
export async function apply(ctx,config){await createPlugin(ctx,config)}
