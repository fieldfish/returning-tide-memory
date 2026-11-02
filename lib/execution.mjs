/** Durable task intent; operation outcomes come exclusively from the host journal. */
import {uuid,hash,text,integer,fail,clip} from './util.mjs'
import {dshToolEvent,toolOutcome} from './dsh-events.mjs'
const UNCERTAIN=new Set(['TOOL_OUTCOME_UNKNOWN','ABORTED','TIMEOUT','CANCELLED','TRANSPORT'])
const MANAGEMENT=/^cm_(task|library|self|checkpoint|extraction|report|delete|situation|working|scene|activity)$/
function argsHash(value){if(typeof value==='string'){try{value=JSON.parse(value)}catch{}}const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;return hash(JSON.stringify(sort(value??{})))}
export class ExecutionLedger{
 constructor(store,{verifiers={},verificationTimeoutMs=10000,definitiveFailureCodes=['INVALID_INPUT','PERMISSION_DENIED','FS_STALE_VERSION','INVALID_ARGUMENT','TOOL_NOT_FOUND']}={}){
  this.store=store;this.verifiers=new Map(Object.entries(verifiers));this.verificationTimeoutMs=verificationTimeoutMs;this.definitiveFailureCodes=new Set(definitiveFailureCodes)
  this.recoverySeen=new WeakMap();this.recoveryDirty=new Set()
  store.db.exec(`CREATE TABLE IF NOT EXISTS cm_tasks(id TEXT PRIMARY KEY,library TEXT NOT NULL REFERENCES libraries(id),title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cm_task_steps(task TEXT NOT NULL REFERENCES cm_tasks(id),id TEXT NOT NULL,position INTEGER NOT NULL,title TEXT NOT NULL,tool TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0,retry_permit INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task,id),UNIQUE(task,position));`)
  store.db.exec(`CREATE TABLE IF NOT EXISTS cm_checkpoint_attempts(library TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,task TEXT NOT NULL,revision INTEGER NOT NULL,tool TEXT NOT NULL,args_digest TEXT NOT NULL,session TEXT NOT NULL,call_id TEXT NOT NULL,PRIMARY KEY(library,task,revision,tool,args_digest))`)
  const columns=new Set(store.db.prepare('PRAGMA table_info(cm_tool_operations)').all().map(c=>c.name))
  for(const [name,type] of Object.entries({task_id:'TEXT',step_id:'TEXT',result_digest:'TEXT',result_ref:'TEXT',call_ref:'TEXT',failure_code:'TEXT',finished:'INTEGER',evidence:'TEXT',stage:'TEXT'}))if(!columns.has(name))store.db.exec(`ALTER TABLE cm_tool_operations ADD COLUMN ${name} ${type}`)
  store.db.exec('CREATE INDEX IF NOT EXISTS cm_tasks_by_library ON cm_tasks(library,created DESC);CREATE INDEX IF NOT EXISTS cm_operations_by_step ON cm_tool_operations(library,task_id,step_id,time);CREATE INDEX IF NOT EXISTS cm_operations_by_status ON cm_tool_operations(library,status);')
  store.tx(()=>{const affected=store.db.prepare("SELECT library,count(*) n FROM cm_tool_operations WHERE readonly=1 AND status='settled' AND task_id IS NOT NULL AND result_digest IS NULL GROUP BY library").all()
   if(!affected.length)return
   store.db.prepare("UPDATE cm_tool_operations SET status='failed',failure_code='READ_INTERRUPTED' WHERE readonly=1 AND status='settled' AND task_id IS NOT NULL AND result_digest IS NULL").run()
   for(const row of affected)store.log(row.library,'legacy-read-result-reclassified',{count:row.n,from:'settled',to:'failed',reason:'No host result digest; read-only interruption',raw_records_modified:false})
  })
 }
 task(library,id){const r=this.store.db.prepare('SELECT * FROM cm_tasks WHERE library=? AND id=?').get(library,id);if(!r)fail('NOT_FOUND','任务不存在');return r}
 operations(library,task,step){return this.store.db.prepare('SELECT session,call_id,name,status,time,finished,result_digest,result_ref,call_ref,failure_code,stage,decision,note,evidence FROM cm_tool_operations WHERE library=? AND task_id=? AND step_id=? ORDER BY time,call_id').all(library,task,step)}
 stepStatus(library,task,step){
  const ops=this.operations(library,task,step),success=ops.findLast(o=>o.status==='succeeded'||o.status==='reviewed'&&o.decision==='verified-applied')
  if(success)return {status:'succeeded',operation:success,attempts:ops.length}
  const latest=ops.at(-1)
  return {status:latest?.status==='reviewed'?(latest.decision==='verified-not-applied'?'not_started':'abandoned'):latest?.status==='settled'?'result_recorded':latest?.status||'planned',operation:latest||null,attempts:ops.length}
 }
 plan(library,session,title,steps){
  this.store.assertOwner(library,session);text(title,'title',200)
  if(!Array.isArray(steps)||!steps.length||steps.length>20)fail('INVALID_INPUT','任务需要1—20个有序步骤')
  const ids=new Set()
  for(const s of steps){text(s.id,'step id',80);text(s.title,'step title',200);text(s.tool,'tool',100);if(ids.has(s.id)||MANAGEMENT.test(s.tool))fail('INVALID_INPUT','步骤标识重复或使用管理工具');ids.add(s.id)}
  return this.store.tx(()=>{const id=uuid();this.store.db.prepare('INSERT INTO cm_tasks(id,library,title,created) VALUES(?,?,?,?)').run(id,library,title,this.store.now());steps.forEach((s,i)=>this.store.db.prepare('INSERT INTO cm_task_steps(task,id,position,title,tool) VALUES(?,?,?,?,?)').run(id,s.id,i,s.title,s.tool));this.store.log(library,'task-planned',{task:id,steps:steps.length});return this.status(library,id)})
 }
 status(library,id){
  const task=this.task(library,id),steps=this.store.db.prepare('SELECT id,position,title,tool,active FROM cm_task_steps WHERE task=? ORDER BY position').all(id).map(s=>({...s,...this.stepStatus(library,id,s.id)}))
  return {...task,status:steps.every(s=>s.status==='succeeded')?'succeeded':task.paused?'paused':steps.some(s=>s.status==='uncertain')?'needs_review':steps.some(s=>s.active)?'running':'planned',steps}
 }
 list(library,{offset=0,limit=30}={}){integer(offset,'offset');integer(limit,'limit',1,30);this.store.library(library);return this.store.db.prepare('SELECT id,title,revision,paused,created FROM cm_tasks WHERE library=? ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?').all(library,limit,offset)}
 listPage(library,offset=0,limit=5){const tasks=this.list(library,{offset,limit}),total=this.store.db.prepare('SELECT count(*) n FROM cm_tasks WHERE library=?').get(library).n;return {tasks,total,offset,next_offset:offset+tasks.length<total?offset+tasks.length:null}}
 setPaused(library,session,id,paused,revision){
  this.store.assertOwner(library,session);integer(revision,'expected_revision')
  return this.store.tx(()=>{
   const task=this.status(library,id);if(task.revision!==revision)fail('CONFLICT','任务版本已变化')
   if(task.status==='succeeded')fail('TASK_ALREADY_COMPLETED','任务已有完成凭据')
   this.store.db.prepare('UPDATE cm_tasks SET paused=?,revision=revision+1 WHERE id=?').run(paused?1:0,id)
   this.store.log(library,paused?'task-paused':'task-resumed',{task:id,interrupted_running_tools:false,replayed:false})
   return this.status(library,id)
  })
 }
 summary(library,id,offset=0,limit=5){
  integer(offset,'offset');integer(limit,'limit',1,5)
  const task=this.status(library,id),steps=task.steps.slice(offset,offset+limit).map(s=>({id:s.id,title:clip(s.title,40),tool:s.tool,status:s.status,attempts:s.attempts,call_id:s.operation?.call_id||null}))
  return {id:task.id,title:clip(task.title,60),revision:task.revision,status:task.status,paused:!!task.paused,step_count:task.steps.length,offset,next_offset:offset+limit<task.steps.length?offset+limit:null,steps}
 }
 activate(library,session,id,step,revision){
  this.store.assertOwner(library,session)
  return this.store.tx(()=>{
   const task=this.status(library,id);if(task.revision!==revision)fail('CONFLICT','任务版本已变化')
   if(task.paused)fail('PAUSED','任务已暂停')
   const target=task.steps.find(s=>s.id===step);if(!target)fail('NOT_FOUND','步骤不存在')
   if(target.status==='succeeded')fail('STEP_ALREADY_COMPLETED','该步骤已有成功凭据，不再执行')
   if(!['planned','not_started','failed','abandoned'].includes(target.status))fail('STEP_UNRESOLVED','该步骤仍有未结算操作')
   if(task.steps.some(s=>s.position<target.position&&s.status!=='succeeded'))fail('PREVIOUS_STEP_INCOMPLETE','前序步骤尚未成功，不跳过')
   if(this.store.db.prepare("SELECT 1 FROM cm_tool_operations WHERE library=? AND task_id IS NOT NULL AND status='running' LIMIT 1").get(library))fail('TASK_EXECUTION_IN_PROGRESS','已有任务工具在执行，不能切换活动步骤')
   this.store.db.prepare('UPDATE cm_task_steps SET active=0 WHERE task IN (SELECT id FROM cm_tasks WHERE library=?)').run(library)
   this.store.db.prepare('UPDATE cm_task_steps SET active=1 WHERE task=? AND id=?').run(id,step)
   this.store.db.prepare('UPDATE cm_tasks SET revision=revision+1 WHERE id=?').run(id)
   return this.status(library,id)
  })
 }
 prepare(library,session,call){
  const callId=call?.callId||call?.id;if(!callId||typeof call.name!=='string'||MANAGEMENT.test(call.name))return
  const active=this.store.db.prepare('SELECT s.task,s.id,s.tool FROM cm_task_steps s JOIN cm_tasks t ON t.id=s.task WHERE t.library=? AND t.paused=0 AND s.active=1').get(library)
  const associated=active?.tool===call.name&&this.store.library(library).owner===session?active:null
  this.store.db.prepare('INSERT OR IGNORE INTO cm_tool_operations(library,session,call_id,name,args_digest,readonly,status,time,task_id,step_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(library,session,callId,call.name,argsHash(call.arguments),0,'planned',this.store.now(),associated?.task??null,associated?.id??null)
 }
 plannedCall(library,session,call){
  const op=this.store.db.prepare('SELECT * FROM cm_tool_operations WHERE library=? AND session=? AND call_id=?').get(library,session,call.callId||call.id)
  if(!op||op.name!==call.name||op.args_digest!==argsHash(call.arguments))fail('SOURCE_CHANGED','调用ID对应的工具或参数发生变化，未执行')
  if(op.status!=='planned')fail('DUPLICATE_OPERATION','同一调用已经执行或结算，不能重放')
  return op
 }
 rejectArguments(library,session,call,result){
  if(!call.callId&&!call.id)fail('HOST_API_UNAVAILABLE','宿主未提供稳定调用ID，不能跟踪执行')
  this.store.tx(()=>{
   this.prepare(library,session,call)
   const op=this.plannedCall(library,session,call)
   this.complete(library,session,op.call_id,result,{trust:{rejectedBeforeDispatch:true}})
  })
 }
 start(library,session,call,verifiedHostRead=false,resume=null){
  if(MANAGEMENT.test(call.name))return
  const callId=call.callId||call.id
  if(!callId)fail('HOST_API_UNAVAILABLE','宿主未提供稳定调用ID，不能跟踪执行')
  this.prepare(library,session,call)
  try{return this.store.tx(()=>{
   const op=this.plannedCall(library,session,call)
   if(op.task_id){
    const previous=this.operations(library,op.task_id,op.step_id).filter(o=>o.call_id!==callId||o.session!==session)
    if(previous.some(o=>o.status==='succeeded'||o.status==='reviewed'&&o.decision==='verified-applied'))fail('STEP_ALREADY_COMPLETED','已有可靠成功记录；复用结果，禁止重复执行')
    if(previous.some(o=>['running','uncertain'].includes(o.status)))fail('STEP_UNRESOLVED','仍有执行中或结果未知操作')
    const step=this.store.db.prepare('SELECT s.active,t.paused FROM cm_task_steps s JOIN cm_tasks t ON t.id=s.task WHERE s.task=? AND s.id=? AND t.library=?').get(op.task_id,op.step_id,library)
    if(!step?.active||step.paused)fail('TASK_NOT_ACTIVE','步骤已暂停或切换，旧调用未执行')
    if(previous.some(o=>o.status!=='not_started'||o.stage!=='schema-preflight')){const permit=this.store.db.prepare('UPDATE cm_task_steps SET retry_permit=0 WHERE task=? AND id=? AND retry_permit=1').run(op.task_id,op.step_id).changes;if(!permit)fail('RETRY_REQUIRES_HUMAN','先核查并由人工授权一次新尝试；不会自动重试')}
   }
   if(resume&&(!resume.tool||resume.tool===call.name)){
    const added=this.store.db.prepare(`INSERT INTO cm_checkpoint_attempts(library,task,revision,tool,args_digest,session,call_id) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(library,task,revision,tool,args_digest) DO UPDATE SET session=excluded.session,call_id=excluded.call_id
      WHERE EXISTS(SELECT 1 FROM cm_tool_operations old WHERE old.library=cm_checkpoint_attempts.library
        AND old.session=cm_checkpoint_attempts.session AND old.call_id=cm_checkpoint_attempts.call_id
        AND (old.status='not_started' OR (old.status='reviewed' AND old.decision='verified-not-applied')))`).run(library,resume.task,resume.revision,call.name,op.args_digest,session,callId)
    if(!added.changes)fail('CHECKPOINT_ALREADY_ATTEMPTED','这个检查点的同一操作已有尝试。核对凭据，不重放。')
   }
   this.store.db.prepare("UPDATE cm_tool_operations SET status='running',readonly=?,stage=? WHERE library=? AND session=? AND call_id=? AND status='planned'").run(verifiedHostRead?1:0,verifiedHostRead?'verified-host-read':null,library,session,callId)
  })}catch(error){
   try{this.store.db.prepare("UPDATE cm_tool_operations SET status='not_started',failure_code=?,stage='pre-dispatch',finished=? WHERE library=? AND session=? AND call_id=? AND status='planned'").run(error.code||'PRE_EXECUTION_REJECTED',this.store.now(),library,session,callId)}catch{}
   throw error
  }
 }
 confirmReaderEntry(library,session,callId,name,args){
  const result=this.store.db.prepare("UPDATE cm_tool_operations SET readonly=1,stage='verified-provider-entry' WHERE library=? AND session=? AND call_id=? AND name=? AND args_digest=? AND status='running'").run(library,session,callId,name,argsHash(args))
  if(result.changes!==1)fail('SOURCE_CHANGED','Cannot verify this reader invocation')
 }
 /**
  * Whether the host gives proof that no tool body ran (or, for the native edit guard, that no
  * mutation happened). Only explicit host contracts count; a tool body can throw the same error
  * codes, so trust must come from the visible-definition identity plus the host's own stage event.
  */
 proofOf(code,trust,errorName){
  if(code==='INVALID_ARGS'&&trust?.rejectedBeforeDispatch===true)return 'schema-preflight'
  if(code==='UNKNOWN_TOOL'&&trust?.unknownTool===true)return 'pre-dispatch'
  if(code==='INVALID_ARGS'&&errorName==='ToolArgsError'&&trust?.invalidArguments===true&&(trust?.nativeEdit===true||trust?.nativeWrite===true||trust?.nativePwsh===true))return 'pre-validation'
  if(code==='FS_NOT_OBSERVED'&&trust?.nativeEdit===true&&trust?.editIntentRejected===true&&trust?.editIntentCode===code)return 'pre-effect'
  if(code==='FS_NOT_FOUND'&&trust?.nativeEdit===true&&trust?.editIntentRejected===true&&trust?.editIntentCode==='FS_NOT_FOUND')return 'pre-effect'
  if((code==='FS_EDIT_NOT_FOUND'||code==='FS_AMBIGUOUS_EDIT')&&errorName==='FsError'&&trust?.nativeEdit===true&&trust?.editIntentAccepted===true)return 'pre-effect'
  if(code==='FS_NOT_OBSERVED'&&errorName==='FsError'&&trust?.nativeWrite===true&&trust?.writeIntentAccepted===true&&trust?.writeIntentKind==='createIfAbsent')return 'pre-effect'
  return null
 }
 complete(library,session,callId,result,{seq=null,thrown=false,trust=null}={}){
  if(!callId)return
  const s=this.store,op=s.db.prepare('SELECT * FROM cm_tool_operations WHERE library=? AND session=? AND call_id=?').get(library,session,callId)
  if(!op)return
  if(!['planned','running','settled'].includes(op.status)){
   if(seq!==null){s.db.prepare('UPDATE cm_tool_operations SET result_ref=COALESCE(result_ref,?) WHERE library=? AND session=? AND call_id=?').run(JSON.stringify({session,seq,type:'tool/result'}),library,session,callId);if(op.status==='uncertain'&&op.result_digest===null)this.recoveryDirty.add(library+'\u0000'+session)}
   return
  }
  const {code,isError,error}=toolOutcome(result,{thrown})
  const proof=this.proofOf(code,trust,error?.info?.name)
  const unknown=proof?false:UNCERTAIN.has(code)||isError&&!this.definitiveFailureCodes.has(code)
  const readOnly=trust ? trust.readOnly===true : op.readonly===1
  const status=proof?'not_started':op.status==='planned'?'not_started':unknown&&!readOnly?'uncertain':isError?'failed':'succeeded'
  const stage=proof||(status==='uncertain'?'unverified':trust?.readOnly&&isError?'read-only':null)
  // Keep only digests and native event references; do not duplicate credentials/results.
  s.db.prepare('UPDATE cm_tool_operations SET status=?,readonly=?,result_digest=?,result_ref=COALESCE(?,result_ref),failure_code=?,stage=COALESCE(?,stage),finished=? WHERE library=? AND session=? AND call_id=?').run(status,readOnly?1:0,hash(JSON.stringify({isError,code,result:result??null})),seq===null?null:JSON.stringify({session,seq,type:'tool/result'}),typeof code==='string'?clip(code,100):null,stage,s.now(),library,session,callId)
  const auditType=proof?'operation-not-executed':status==='uncertain'?'operation-outcome-unknown':trust?.readOnly&&isError?'verified-read-failed':null
  if(auditType)s.log(library,auditType,{session,call_id:callId,name:op.name,code:typeof code==='string'?clip(code,100):null,basis:proof||(status==='uncertain'?'host-reported-error-without-stage-proof':'verified-read-contract'),classification:trust?.diagnostic,replayed:false})
 }
 observe(library,session,event){
  const op=dshToolEvent(event)
  if(op?.kind==='call'){
   this.prepare(library,session,op.call)
   if(Number.isSafeInteger(op.seq)&&op.seq>=0)this.store.db.prepare('UPDATE cm_tool_operations SET call_ref=COALESCE(call_ref,?) WHERE library=? AND session=? AND call_id=?').run(JSON.stringify({session,seq:op.seq,type:'tool/call'}),library,session,op.call.callId)
  }
  if(op?.kind==='result')this.complete(library,session,op.callId,op.result,{seq:op.seq})
 }
 /** Recover only an otherwise unrecorded, explicit native success. Never infer a result or replay. */
 reconcileNativeResults(library,session){
  if(!session||typeof session.id!=='string'||typeof session.snapshotEvents!=='function')return {recovered:0,unavailable:true}
  const sid=session.id,key=library+'\u0000'+sid
  this.store.assertOwner(library,sid)
  if(this.recoverySeen.get(session)===library&&!this.recoveryDirty.has(key))return {recovered:0,cached:true}
  const pending=this.store.db.prepare("SELECT * FROM cm_tool_operations WHERE library=? AND session=? AND status='uncertain' AND result_digest IS NULL ORDER BY time DESC,call_id LIMIT 32").all(library,sid)
  this.recoverySeen.set(session,library);this.recoveryDirty.delete(key)
  if(!pending.length)return {recovered:0}
  const refs=new Map(),eligible=new Map()
  for(const row of pending){
   let ref=null
   if(row.call_ref!==null){try{ref=JSON.parse(row.call_ref)}catch{continue};if(ref?.session!==sid||ref.type!=='tool/call'||!Number.isSafeInteger(ref.seq)||ref.seq<0)continue}
   refs.set(row.call_id,ref);eligible.set(row.call_id,row)
  }
  if(!eligible.size)return {recovered:0}
  const from=[...refs.values()].some(ref=>ref===null)?0:Math.min(...[...refs.values()].map(ref=>ref.seq))
  let snapshot
  try{snapshot=session.snapshotEvents(from);if(!Array.isArray(snapshot))throw Error('No native snapshot')}catch{this.recoverySeen.delete(session);return {recovered:0,unavailable:true}}
  const events=snapshot.slice(-8192),calls=new Map(),results=new Map(),ambiguous=new Set()
  for(const event of events){
   if(!Number.isSafeInteger(event?.seq)||event.seq<0||Array.isArray(event.sourceEventSeqs)&&event.sourceEventSeqs.length>1)continue
   const native=dshToolEvent(event);if(!native)continue
   const callId=native.kind==='call'?native.call.callId:native.callId,row=eligible.get(callId)
   if(!row)continue
   if(native.kind==='call'){
    if(calls.has(callId)){ambiguous.add(callId);continue}
    let matches=false
    try{matches=native.call.name===row.name&&argsHash(native.call.arguments)===row.args_digest}catch{}
    const ref=refs.get(callId)
    calls.set(callId,{seq:event.seq,matches:matches&&(!ref||ref.seq===event.seq)})
   }else{
    if(results.has(callId)){ambiguous.add(callId);continue}
    const message=native.message
    const explicitSuccess=message?.role==='tool'&&message.source?.kind==='tool'&&message.isError===false&&!native.isError&&(!message.source.callId||message.source.callId===callId)
    results.set(callId,{seq:event.seq,result:native.result,explicitSuccess,time:event.time,sourceEventSeqs:event.sourceEventSeqs})
   }
  }
  let recovered=0
  this.store.tx(()=>{for(const [callId,row]of eligible){
   const call=calls.get(callId),result=results.get(callId)
   if(ambiguous.has(callId)||!call?.matches||!result?.explicitSuccess||result.seq<=call.seq)continue
   if(result.sourceEventSeqs!==undefined&&(!Array.isArray(result.sourceEventSeqs)||result.sourceEventSeqs.length!==1||result.sourceEventSeqs[0]!==call.seq))continue
   const ref=JSON.stringify({session:sid,seq:result.seq,type:'tool/result'}),evidence={kind:'native-host-result',session:sid,call_seq:call.seq,result_seq:result.seq,args_digest:row.args_digest}
   const completed=typeof result.time==='number'?result.time:Date.parse(result.time)
   const changed=this.store.db.prepare("UPDATE cm_tool_operations SET status='succeeded',result_digest=?,result_ref=?,call_ref=COALESCE(call_ref,?),failure_code=NULL,finished=?,stage='host-result-recovered',evidence=COALESCE(evidence,?) WHERE library=? AND session=? AND call_id=? AND status='uncertain' AND result_digest IS NULL AND args_digest=? AND name=?").run(hash(JSON.stringify({isError:false,code:null,result:result.result})),ref,JSON.stringify({session:sid,seq:call.seq,type:'tool/call'}),Number.isFinite(completed)?completed:this.store.now(),JSON.stringify(evidence),library,sid,callId,row.args_digest,row.name).changes
   if(changed){recovered++;this.store.log(library,'operation-result-recovered',{session:sid,call_id:callId,call_seq:call.seq,result_seq:result.seq,replayed:false})}
  }})
  if(recovered&&pending.length===32)this.recoveryDirty.add(key)
  return {recovered,scanned:events.length,bounded:snapshot.length>8192||pending.length===32,replayed:false}
 }
 permitRetry(library,task,step,note){
  text(note,'reason',2000)
  return this.store.tx(()=>{const state=this.status(library,task),target=state.steps.find(s=>s.id===step)
   if(!target||!['failed','not_started'].includes(target.status))fail('RETRY_NOT_SAFE','只允许明确失败或未执行的步骤申请一次新尝试')
   this.store.db.prepare('UPDATE cm_task_steps SET retry_permit=1 WHERE task=? AND id=?').run(task,step)
   this.store.log(library,'human-step-retry-permit',{task,step,note:clip(note,300),attempts_allowed:1,executed:false})
  })
 }
 async verify(library,session,callId,{signal}={}){
  const op=this.store.db.prepare('SELECT * FROM cm_tool_operations WHERE library=? AND session=? AND call_id=?').get(library,session,callId)
  if(!op||op.status!=='uncertain')fail('CONFLICT','只核验当前未知操作')
  const verifier=this.verifiers.get(op.name)
  if(!verifier)return {status:'unknown',reason:'没有可信只读核验适配器，保持待人工处理',replayed:false}
  if(signal?.aborted)fail('CANCELLED','核验已取消；未知状态保留')
  const controller=new AbortController();let timer,timedOut=false,onAbort
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true})
  let result
  try {
   result=await new Promise((resolve,reject)=>{
    onAbort=()=>{const e=new Error(timedOut?'只读核验超时；未知状态保留':'核验已取消；未知状态保留');e.code=timedOut?'VERIFICATION_TIMEOUT':'CANCELLED';reject(e)}
    controller.signal.addEventListener('abort',onAbort,{once:true})
    timer=setTimeout(()=>{timedOut=true;controller.abort()},this.verificationTimeoutMs)
    Promise.resolve().then(()=>verifier(Object.freeze({library,session,call_id:callId,args_digest:op.args_digest,task_id:op.task_id,step_id:op.step_id}),controller.signal)).then(resolve,reject)
   })
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',onAbort);controller.abort()}
  if(signal?.aborted)fail('CANCELLED','核验已取消；未知状态保留')
  if(!result||!['applied','not_applied','unknown'].includes(result.status))fail('INVALID_VERIFIER_RESULT','核验适配器返回无效状态')
  if(result.status==='unknown')return {status:'unknown',replayed:false}
  if(!result.evidence||typeof result.evidence!=='object'||JSON.stringify(result.evidence).length>2000)fail('INVALID_VERIFIER_RESULT','需要有界的外部核验凭据')
  this.store.tx(()=>{
   const decision=result.status==='applied'?'verified-applied':'verified-not-applied'
   const changed=this.store.db.prepare("UPDATE cm_tool_operations SET status='reviewed',decision=?,note='Trusted read-only verifier',evidence=? WHERE library=? AND session=? AND call_id=? AND status='uncertain'").run(decision,JSON.stringify(result.evidence),library,session,callId).changes
   if(changed!==1)fail('CONFLICT','核验期间状态已变化')
   this.store.log(library,'operation-verified',{session,call_id:callId,decision,evidence:result.evidence,replayed:false})
  })
  return {status:result.status,evidence:result.evidence,replayed:false}
 }
 context(library){const step=this.store.db.prepare('SELECT s.task,s.id FROM cm_task_steps s JOIN cm_tasks t ON t.id=s.task WHERE t.library=? AND s.active=1 ORDER BY t.created DESC LIMIT 1').get(library);if(!step)return '';const task=this.status(library,step.task),status=task.steps.find(s=>s.id===step.id);return clip('执行接续记录（宿主证据，不是人格）：'+JSON.stringify({task:task.id,title:task.title,step:step.id,status:status.status,paused:!!task.paused,operation:status.operation?.call_id,next:task.paused?'任务已暂停，等待明确继续；不重放':status.status==='succeeded'?'复用已完成结果，选择下一步；不要重放':status.status==='uncertain'?'先核验外部结果；禁止重放':'先查cm_task再继续，失败后不自动重试'}),1000)}
}
