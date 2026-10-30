/** Repeatable synthetic lifecycle exercise; no model/service calls and no existing profile. */
import {mkdtempSync,existsSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {createPlugin} from '../index.mjs'
import {ContinuityStore} from '../lib/store.mjs'
const cycles=Number(process.argv[2]||120)
const workingEnabled=process.argv.includes('--working')
const dynamicsEnabled=process.argv.includes('--dynamics')
const situationIndexEnabled=process.argv.includes('--situations')
const activityEnabled=process.argv.includes('--activity')
assert.ok(Number.isInteger(cycles)&&cycles>=20&&cycles<=2000)
const directory=mkdtempSync(join(tmpdir(),'continuity-soak-')),tools=new Map(),listeners=new Map(),contexts=new Map(),events=[],samples=[]
let library,plugin,modelCalls=0,interrupted=0,situation=null,firstRecord=null,correction=null,nativeSeq=0,expectedRecords=0
const userSequences=[]
const agent={status:'idle',session:{id:'synthetic-soak-owner',header:{},snapshotEvents:(from=0)=>events.filter(e=>e.seq>=from)},ctx:{systemPrompt:{context:spec=>{assert.equal(contexts.has(spec.name),false,'Duplicate recovery context');contexts.set(spec.name,spec);return()=>contexts.delete(spec.name)}}}}
const ctx={agents:{get:id=>id===agent.session.id?agent:null,list:()=>[agent]},sessions:{flush:async()=>{}},llm:{prepareCall:()=>{modelCalls++;throw Error('No model calls allowed')}},tools:{register:def=>{assert.equal(tools.has(def.name),false,'Duplicate tool');tools.set(def.name,def);return()=>tools.delete(def.name)}},on:(name,fn)=>{const rows=listeners.get(name)||[];rows.push(fn);listeners.set(name,rows);return()=>listeners.set(name,rows.filter(r=>r!==fn))},effect:()=>{},logger:{warn:()=>{}}}
const started=performance.now(),result={time:new Date().toISOString(),directory,cycles,working_enabled:workingEnabled,memory_dynamics_enabled:dynamicsEnabled,situation_index_enabled:situationIndexEnabled,activity_archive_enabled:activityEnabled,model_calls:0,synthetic_only:true,checks:{}}
try{
 for(let i=0;i<cycles;i++){
  plugin=await createPlugin(ctx,{dataDirectory:directory,manager:{enabled:i%20===0},workingMemory:{enabled:workingEnabled},memoryDynamics:{enabled:dynamicsEnabled},situationIndex:{enabled:situationIndexEnabled},activityArchive:{enabled:activityEnabled}},{isAgentLoopRequest:()=>true})
  if(situationIndexEnabled){plugin.embedding.identity=async()=>{plugin.embedding.cached='synthetic-soak';return 'synthetic-soak'};plugin.embedding.embed=async inputs=>inputs.map(()=>[1,0])}
  if(!library){library=plugin.store.create('Synthetic lifecycle fixture').id;plugin.store.bind(agent.session.id,library,0)}
  const pending=plugin.store.recovery.pending(library);for(const op of pending.operations)plugin.store.recovery.resolve(library,{session:op.session,call_id:op.call_id,decision:'verified-not-applied',note:'Synthetic harness never executed an external effect'})
  const event={seq:nativeSeq++,time:Date.UTC(2026,0,1)+i*1000,type:'user/message',surfaceOp:{op:'append'},data:{source:{kind:'user'},content:'合成循环经历 '+i+' 🐟'}};events.push(event);userSequences.push(event.seq);expectedRecords++
  if(i===0)plugin.capture.event(library,agent.session.id,event)
  else for(const handler of listeners.get('session/event')||[])handler(agent.session,event)
  if(dynamicsEnabled){
    const ref=plugin.store.recent(library).at(-1).id;firstRecord??=ref
    if(i>0&&i%10===0)plugin.embedding.memoryDynamics.record(library,agent.session.id,{id:firstRecord,kind:'helpful',refs:[ref],reason:'Synthetic later usage feedback'})
    if(i===20)correction=plugin.embedding.memoryDynamics.record(library,agent.session.id,{id:firstRecord,kind:'corrected',cue:'合成任务',refs:[ref],reason:'Synthetic scoped correction'}).id
    if(i===30)plugin.embedding.memoryDynamics.retract(library,agent.session.id,{feedback_id:correction,refs:[ref],reason:'Synthetic correction withdrawal'})
    assert.equal(plugin.embedding.memoryDynamics.assess(library,plugin.store.record(library,firstRecord),'合成任务').auto_blocked,i>=20&&i<30)
    assert.equal(plugin.store.db.prepare("SELECT count(*) n FROM cm_memory_feedback WHERE kind='helpful'").get().n,Math.floor(i/10))
  }
  if(activityEnabled){
    for(const e of [
      {seq:nativeSeq++,time:event.time+1,type:'tool/call',data:{name:'read',callId:'synthetic-read-'+i,arguments:{path:'synthetic-'+i+'.txt'}}},
      {seq:nativeSeq++,time:event.time+2,type:'tool/result',data:{message:{toolCallId:'synthetic-read-'+i,content:'合成工具返回 '+i+' 🐟'},structured:{receipt:'synthetic-receipt-'+i}}}
    ]){events.push(e);for(const handler of listeners.get('session/event')||[])handler(agent.session,e);expectedRecords++}
    if(i%10===0){const ref=plugin.store.recent(library).at(-1).id;plugin.activityArchive.report(library,agent.session.id,{kind:'browser',title:'合成资料片段 '+i,body:'只记录合成工具可见文字',refs:[ref],evidence_type:'tool-output',idempotency_key:'soak-observation-'+i},{session:agent.session.id,seq:nativeSeq-1});expectedRecords++}
    assert.equal(plugin.activityArchive.status(library).payloads,2*(i+1)+Math.floor(i/10)+1)
    assert.equal(plugin.activityArchive.health(library).paused,false)
  }
  if(workingEnabled){
    const refs=[plugin.store.recent(library).at(-1).id]
    if(!situation){situation=plugin.situations.create(library,agent.session.id,{title:'Synthetic continuous task',refs}).id;plugin.situations.focus(library,agent.session.id,situation)}
    if(i%25===0)plugin.situations.revise(library,agent.session.id,situation,{expected_revision:plugin.situations.get(library,situation).revision,refs,reason:'Synthetic increment',append_assertions:[{slot:'progress',body:'已记录合成节点 '+i,refs}]})
    assert.equal(plugin.situations.current(library,agent.session.id).id,situation)
    await plugin.working.prepare({library,session:agent.session.id,query:'你好',userSeq:event.seq})
    assert.ok(Array.from(plugin.contextFrame.render(library,agent.session.id)).length<=1800)
    if(situationIndexEnabled){await plugin.situationIndex.warm(library,agent.session.id);assert.equal(plugin.situationIndex.status(library).indexed_situations,1);assert.equal((await plugin.situationIndex.lookup(library,agent.session.id,'Synthetic continuous task')).results[0].id,situation)}
  }
  assert.equal(plugin.store.library(library).owner,agent.session.id);assert.equal(plugin.store.library(library).error,null)
  assert.equal(plugin.store.db.prepare('SELECT count(*) n FROM records').get().n,expectedRecords)
  if(i%15===0&&i!==cycles-1){plugin.store.begin(library,agent.session.id,'main');plugin.execution.start(library,agent.session.id,{name:'synthetic_external',callId:'interrupted-'+i,arguments:{test:true}});interrupted++}
  const access=plugin.manager?.accessPath;await plugin.dispose();plugin=null
  assert.equal(tools.size,0);assert.equal(contexts.size,0);assert.equal([...listeners.values()].reduce((s,v)=>s+v.length,0),0);assert.equal(existsSync(join(directory,'host.lock')),false);if(access)assert.equal(existsSync(access),false)
  if(i%10===9){globalThis.gc?.();samples.push({cycle:i+1,...process.memoryUsage()})}
 }
 const store=new ContinuityStore(directory)
 try{for(let i=0;i<cycles;i++)assert.equal(store.db.prepare('SELECT text FROM records WHERE session=? AND seq=?').get(agent.session.id,userSequences[i]).text,'合成循环经历 '+i+' 🐟');assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0)}finally{store.close()}
 assert.equal(modelCalls,0);const growth=samples.at(-1).heapUsed-samples[0].heapUsed;if(globalThis.gc)assert.ok(growth<16*1024*1024,'Unexpected sustained JS heap growth')
 result.checks={all_cycles_preserve_raw_records:true,tools_hooks_contexts_fully_removed:true,writer_lock_and_management_token_removed:true,interrupted_operations_reviewed_without_replay:true,database_integrity:true}
 if(dynamicsEnabled)result.checks.feedback_and_withdrawal_survive_restarts=true
 if(situationIndexEnabled)result.checks.situation_index_persists_and_refreshes=true
 if(activityEnabled){result.checks.activity_payloads_and_reports_survive_restarts=true;result.activity_records=expectedRecords;result.activity_payloads=2*cycles+Math.ceil(cycles/10)}
 result.interruptions=interrupted;result.heap_growth_bytes=growth;result.explicit_gc=!!globalThis.gc;result.memory_samples=samples
}catch(e){result.error={message:e.message,stack:e.stack};process.exitCode=1}
finally{try{await plugin?.dispose()}catch{}result.elapsed_ms=performance.now()-started;writeFileSync(join(directory,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,memory_samples:undefined}))}
