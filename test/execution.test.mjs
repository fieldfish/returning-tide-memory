import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {ContinuityStore} from '../lib/store.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'

function fixture(t,options={}){
 const dir=mkdtempSync(join(tmpdir(),'cm-execution-'));let store=new ContinuityStore(dir),ledger=new ExecutionLedger(store,options)
 const lib=store.create('synthetic task');store.bind('owner',lib.id,0)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const f={dir,lib,get store(){return store},get ledger(){return ledger},reopen(){store.close();store=new ContinuityStore(dir);ledger=new ExecutionLedger(store,options)},call(name,id,args={}){return {name,callId:id,arguments:args}}}
 return f
}

test('同名子代理工具不能误完成主会话当前步骤',t=>{
 const f=fixture(t);let task=f.ledger.plan(f.lib.id,'owner','parent',[{id:'file',title:'parent file',tool:'write'}]);task=f.ledger.activate(f.lib.id,'owner',task.id,'file',0)
 const call=f.call('write','child-same-name');f.ledger.start(f.lib.id,'synthetic-child',call);f.ledger.complete(f.lib.id,'synthetic-child',call.callId,{ok:true})
 assert.equal(f.ledger.status(f.lib.id,task.id).steps[0].status,'planned')
})

test('任务列表超过30个仍能分页找到最早任务',t=>{
 const f=fixture(t);let first
 for(let i=0;i<35;i++){const v=f.ledger.plan(f.lib.id,'owner','task '+i,[{id:'file',title:'file',tool:'write'}]);first??=v.id}
 const items=f.ledger.list(f.lib.id,{offset:30,limit:5})
 assert.equal(items.length,5);assert.ok(items.some(t=>t.id===first))
})

test('读取工具中断后可查失败并人工许可重试，不能假装已有结果',t=>{
 const f=fixture(t);let task=f.ledger.plan(f.lib.id,'owner','read restart',[{id:'read',title:'read',tool:'read'}]);task=f.ledger.activate(f.lib.id,'owner',task.id,'read',0)
 f.ledger.start(f.lib.id,'owner',f.call('read','read-no-result'));f.reopen()
 assert.equal(f.ledger.status(f.lib.id,task.id).steps[0].status,'failed')
 f.ledger.permitRetry(f.lib.id,task.id,'read','Read-only request interrupted without result')
 assert.equal(f.store.recovery.needsReview(f.lib.id),false)
})

test('暂停任务保留进度并拒绝已排队旧调用；继续不授予自动重试',t=>{
 const f=fixture(t);let task=f.ledger.plan(f.lib.id,'owner','pause',[{id:'file',title:'file',tool:'write'}]);task=f.ledger.activate(f.lib.id,'owner',task.id,'file',0)
 const call=f.call('write','queued');f.ledger.prepare(f.lib.id,'owner',call)
 task=f.ledger.setPaused(f.lib.id,'owner',task.id,true,task.revision);assert.equal(task.status,'paused');assert.match(f.ledger.context(f.lib.id),/任务已暂停/)
 assert.throws(()=>f.ledger.start(f.lib.id,'owner',call),{code:'TASK_NOT_ACTIVE'})
 assert.throws(()=>f.ledger.setPaused(f.lib.id,'owner',task.id,false,0),{code:'CONFLICT'})
 task=f.ledger.setPaused(f.lib.id,'owner',task.id,false,task.revision)
 assert.throws(()=>f.ledger.start(f.lib.id,'owner',f.call('write','no-auto-retry')),{code:'RETRY_REQUIRES_HUMAN'})
 f.ledger.permitRetry(f.lib.id,task.id,'file','Human checked: rejected before execution');f.ledger.start(f.lib.id,'owner',f.call('write','permitted'));f.ledger.complete(f.lib.id,'owner','permitted',{ok:true})
 assert.equal(f.ledger.status(f.lib.id,task.id).status,'succeeded')
})

test('任务工具在途时不能切换活动步骤，完成后可切换',t=>{
 const f=fixture(t),a=f.ledger.plan(f.lib.id,'owner','A',[{id:'a',title:'a',tool:'write'}]),b=f.ledger.plan(f.lib.id,'owner','B',[{id:'b',title:'b',tool:'write'}])
 f.ledger.activate(f.lib.id,'owner',a.id,'a',0);f.ledger.start(f.lib.id,'owner',f.call('write','inflight'))
 assert.throws(()=>f.ledger.activate(f.lib.id,'owner',b.id,'b',0),{code:'TASK_EXECUTION_IN_PROGRESS'})
 f.ledger.complete(f.lib.id,'owner','inflight',{ok:true});assert.equal(f.ledger.activate(f.lib.id,'owner',b.id,'b',0).steps[0].active,1)
})

test('核查许可和故障标记写入必须与审计同事务，审计失败不放行',t=>{
 const f=fixture(t);let task=f.ledger.plan(f.lib.id,'owner','atomic',[{id:'read',title:'read',tool:'read'}]);task=f.ledger.activate(f.lib.id,'owner',task.id,'read',0)
 f.ledger.start(f.lib.id,'owner',f.call('read','failed'));f.ledger.complete(f.lib.id,'owner','failed',{isError:true,error:{code:'TIMEOUT'}})
 const log=f.store.log;f.store.log=()=>{throw Error('Synthetic audit disk failure')}
 assert.throws(()=>f.ledger.permitRetry(f.lib.id,task.id,'read','human reviewed'))
 assert.equal(f.store.db.prepare('SELECT retry_permit FROM cm_task_steps WHERE task=?').get(task.id).retry_permit,0)
 assert.throws(()=>f.store.pause(f.lib.id,'SOURCE_CHANGED'));assert.equal(f.store.library(f.lib.id).error,null)
 f.store.log=log;f.store.pause(f.lib.id,'SOURCE_CHANGED');f.store.pause(f.lib.id,'MANUAL_PAUSE');assert.equal(f.store.library(f.lib.id).error,'SOURCE_CHANGED')
 f.store.resume(f.lib.id,'owner');f.store.pause(f.lib.id,'MAIN_REQUEST_FAILED');f.store.pause(f.lib.id,'SOURCE_CHANGED');assert.equal(f.store.library(f.lib.id).error,'SOURCE_CHANGED')
})

test('嵌套宿主错误保持未知并补上原生引用，迟到事件不抹掉未知判断',t=>{
 const f=fixture(t),call=f.call('write','wrapped');f.ledger.start(f.lib.id,'owner',call)
 const event={seq:42,type:'tool/result',data:{result:{message:{toolCallId:'wrapped',content:[]},error:{info:{code:'TIMEOUT'}}}}}
 f.ledger.observe(f.lib.id,'owner',event);f.store.recovery.observe(f.lib.id,'owner',event)
 const op=()=>f.store.db.prepare('SELECT status,result_ref FROM cm_tool_operations WHERE call_id=?').get('wrapped')
 assert.equal(op().status,'uncertain');assert.equal(JSON.parse(op().result_ref).seq,42)
 f.ledger.observe(f.lib.id,'owner',{seq:43,type:'tool/result',data:{message:{toolCallId:'wrapped'}}});f.store.recovery.observe(f.lib.id,'owner',{seq:43,type:'tool/result',data:{message:{toolCallId:'wrapped'}}})
 assert.equal(op().status,'uncertain');assert.equal(f.store.recovery.needsReview(f.lib.id),true)
})

test('兼容旧beta把中断读取标为已结算但没有结果摘要的记录',t=>{
 const f=fixture(t);let task=f.ledger.plan(f.lib.id,'owner','old interrupted read',[{id:'read',title:'read',tool:'read'}]);task=f.ledger.activate(f.lib.id,'owner',task.id,'read',0)
 f.ledger.start(f.lib.id,'owner',f.call('read','old-settled'));f.store.db.prepare("UPDATE cm_tool_operations SET status='settled' WHERE call_id='old-settled'").run();f.reopen()
 assert.equal(f.ledger.status(f.lib.id,task.id).steps[0].status,'failed');f.ledger.permitRetry(f.lib.id,task.id,'read','human checked old interrupted read')
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit WHERE type='legacy-read-result-reclassified'").get().n,1)
})

test('核验器忽略取消时仍按时结束；迟到成功不解除未知状态',async t=>{
 let signal,complete
 const f=fixture(t,{verificationTimeoutMs:20,verifiers:{mock_send:(_op,s)=>{signal=s;return new Promise(resolve=>{complete=resolve})}}})
 const call=f.call('mock_send','timeout');f.ledger.start(f.lib.id,'owner',call);f.ledger.complete(f.lib.id,'owner',call.callId,{isError:true,error:{code:'TIMEOUT'}})
 await assert.rejects(f.ledger.verify(f.lib.id,'owner',call.callId),{code:'VERIFICATION_TIMEOUT'})
 assert.equal(signal.aborted,true);assert.equal(f.store.recovery.needsReview(f.lib.id),true)
 complete({status:'applied',evidence:{receipt:'late'}});await new Promise(r=>setImmediate(r))
 assert.equal(f.store.recovery.needsReview(f.lib.id),true)
})

test('管理入口关闭的取消信号中断核验，保留待核查操作',async t=>{
 let started
 const ready=new Promise(r=>{started=r}),f=fixture(t,{verifiers:{mock_send:()=>{started();return new Promise(()=>{})}}})
 const call=f.call('mock_send','cancel');f.ledger.start(f.lib.id,'owner',call);f.ledger.complete(f.lib.id,'owner',call.callId,{isError:true,error:{code:'TIMEOUT'}})
 const control=new AbortController(),pending=f.ledger.verify(f.lib.id,'owner',call.callId,{signal:control.signal})
 await ready;control.abort();await assert.rejects(pending,{code:'CANCELLED'})
 assert.equal(f.store.recovery.needsReview(f.lib.id),true)
})
test('完整任务链：检索→生成文件→模拟外部操作→保存结果，结果来自实际工具',t=>{
 const f=fixture(t),steps=[['lookup','cm_lookup'],['file','write'],['send','mock_send'],['save','write']].map(([id,tool])=>({id,title:id,tool}))
 let task=f.ledger.plan(f.lib.id,'owner','synthetic full chain',steps),effects=0
 for(const step of steps){
  task=f.ledger.activate(f.lib.id,'owner',task.id,step.id,task.revision)
  const call=f.call(step.tool,'call-'+step.id,{value:'synthetic'});f.ledger.prepare(f.lib.id,'owner',call);f.ledger.start(f.lib.id,'owner',call)
  let result
  if(step.id==='lookup')result={ids:['synthetic-source']}
  else if(step.id==='send'){effects++;result={receipt:'external-001'}}
  else{const path=join(f.dir,step.id+'.txt');writeFileSync(path,step.id);result={sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}}
  f.ledger.complete(f.lib.id,'owner',call.callId,result,{seq:10+steps.indexOf(step)})
  task=f.ledger.status(f.lib.id,task.id);assert.equal(task.steps.find(s=>s.id===step.id).status,'succeeded')
 }
 assert.equal(task.status,'succeeded');assert.equal(effects,1)
 assert.throws(()=>f.ledger.activate(f.lib.id,'owner',task.id,'send',task.revision),{code:'STEP_ALREADY_COMPLETED'})
 assert.ok(task.steps.every(s=>s.operation.result_digest&&s.operation.result_ref))
 f.reopen();assert.equal(f.ledger.status(f.lib.id,task.id).status,'succeeded');assert.equal(effects,1)
})
test('执行前中断识别为未执行；失败不自动再调用，人工授权仅放行一次',t=>{
 const f=fixture(t);let task=f.ledger.plan(f.lib.id,'owner','before start',[{id:'file',title:'file',tool:'write'}]);task=f.ledger.activate(f.lib.id,'owner',task.id,'file',0)
 f.ledger.prepare(f.lib.id,'owner',f.call('write','before'));f.reopen()
 assert.equal(f.ledger.status(f.lib.id,task.id).steps[0].status,'not_started');assert.equal(f.store.recovery.needsReview(f.lib.id),false)
 assert.throws(()=>f.ledger.start(f.lib.id,'owner',f.call('write','retry-no-permit')),{code:'RETRY_REQUIRES_HUMAN'})
 f.ledger.permitRetry(f.lib.id,task.id,'file','Human reviewed: first call never executed')
 f.ledger.start(f.lib.id,'owner',f.call('write','retry-with-permit'))
 f.ledger.complete(f.lib.id,'owner','retry-with-permit',{isError:true,error:{code:'FS_STALE_VERSION'}})
 assert.equal(f.ledger.status(f.lib.id,task.id).steps[0].status,'failed')
 assert.throws(()=>f.ledger.start(f.lib.id,'owner',f.call('write','no-second-permit')),{code:'RETRY_REQUIRES_HUMAN'})
})
test('外部成功但本地结果丢失：核验后复用成功记录，绝不第二次产生副作用',async t=>{
 let effects=0,verifyCalls=0
 const f=fixture(t,{verifiers:{mock_send:async op=>{verifyCalls++;return {status:'applied',evidence:{receipt:'mock-001',args_digest:op.args_digest}}}}})
 let task=f.ledger.plan(f.lib.id,'owner','external uncertain',[{id:'send',title:'send',tool:'mock_send'}]);task=f.ledger.activate(f.lib.id,'owner',task.id,'send',0)
 const call=f.call('mock_send','send-001',{to:'synthetic'});f.ledger.prepare(f.lib.id,'owner',call);f.ledger.start(f.lib.id,'owner',call);effects++
 f.reopen();assert.equal(f.ledger.status(f.lib.id,task.id).steps[0].status,'uncertain');assert.equal(f.store.library(f.lib.id).error,null)
 f.store.recovery.assertTool(f.lib.id,'cm_task',{action:'verify'})
 const verified=await f.ledger.verify(f.lib.id,'owner','send-001');assert.equal(verified.status,'applied');assert.equal(verified.replayed,false)
 assert.equal(f.ledger.status(f.lib.id,task.id).steps[0].status,'succeeded');assert.equal(effects,1);assert.equal(verifyCalls,1)
 await assert.rejects(f.ledger.verify(f.lib.id,'owner','send-001'),{code:'CONFLICT'});assert.equal(verifyCalls,1)
 assert.throws(()=>f.ledger.start(f.lib.id,'owner',f.call('mock_send','duplicate')),{code:'STEP_ALREADY_COMPLETED'});assert.equal(effects,1)
})
test('无核验适配器或外部证据不足时保持未知，任意错误不能冒充明确失败',async t=>{
 const f=fixture(t);let task=f.ledger.plan(f.lib.id,'owner','unknown',[{id:'send',title:'send',tool:'mock_send'}]);task=f.ledger.activate(f.lib.id,'owner',task.id,'send',0)
 f.ledger.start(f.lib.id,'owner',f.call('mock_send','send'));f.ledger.complete(f.lib.id,'owner','send',{error:{code:'HTTP_500'}},{thrown:true})
 assert.equal(f.ledger.status(f.lib.id,task.id).steps[0].status,'uncertain')
 assert.equal((await f.ledger.verify(f.lib.id,'owner','send')).status,'unknown');assert.equal(f.store.recovery.needsReview(f.lib.id),true)
 assert.throws(()=>f.store.recovery.assertTool(f.lib.id,'write',{}),{code:'RECOVERY_REVIEW_REQUIRED'})
})
test('参数指纹规范化，调用ID改参数拒绝；跨库不能读取或标记任务',t=>{
 const f=fixture(t),call=f.call('write','stable','{"b":2,"a":1}');f.ledger.prepare(f.lib.id,'owner',call)
 f.ledger.start(f.lib.id,'owner',f.call('write','stable',{a:1,b:2}))
 f.ledger.prepare(f.lib.id,'owner',f.call('write','tampered',{a:1,b:2}))
 assert.throws(()=>f.ledger.start(f.lib.id,'owner',f.call('write','tampered',{a:9,b:2})),{code:'SOURCE_CHANGED'})
 const task=f.ledger.plan(f.lib.id,'owner','isolation',[{id:'one',title:'one',tool:'write'}]),foreign=f.store.create('other')
 assert.throws(()=>f.ledger.status(foreign.id,task.id),{code:'NOT_FOUND'})
 assert.throws(()=>f.ledger.plan(f.lib.id,'other','bad',[{id:'x',title:'x',tool:'write'}]),{code:'NOT_OWNER'})
})
test('存储故障发生在执行前时不得放行工具；schema迁移先生成一致快照',t=>{
 const f=fixture(t);f.store.db.exec('PRAGMA user_version=1');f.reopen()
 const backups=readdirSync(f.dir).filter(n=>/^before-schema-3-.*\.sqlite3$/.test(n));assert.equal(backups.length,1)
 const backup=join(f.dir,backups[0]),manifest=JSON.parse(readFileSync(backup+'.json','utf8'));assert.equal(manifest.sha256,createHash('sha256').update(readFileSync(backup)).digest('hex'))
 const original=new DatabaseSync(backup,{readOnly:true});try{assert.equal(original.prepare('PRAGMA user_version').get().user_version,1)}finally{original.close()}
 const call=f.call('write','storage-fault');f.ledger.prepare(f.lib.id,'owner',call);f.store.db.exec('PRAGMA query_only=ON')
 assert.throws(()=>f.ledger.start(f.lib.id,'owner',call));f.store.db.exec('PRAGMA query_only=OFF')
 assert.equal(f.store.db.prepare('SELECT status FROM cm_tool_operations WHERE call_id=?').get(call.callId).status,'planned')
})
