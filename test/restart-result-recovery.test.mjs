import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'
import {createPlugin} from '../index.mjs'

async function restart(t,{missing=false,changed=false,knownFailure=false,role='tool',duplicate=false,badLink=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'rt-native-restart-')),session='synthetic-restart-owner',args={file_path:'synthetic-output.txt',content:'synthetic output'},callId='synthetic-persisted-call'
 const call={seq:10,time:'2026-11-01T01:00:00Z',type:'tool/call',data:{callId,name:'write',arguments:JSON.stringify(changed?{...args,content:'another operation'}:args)}}
 const result={seq:11,time:'2026-11-01T01:00:01Z',type:'tool/result',surfaceOp:'append',sourceEventSeqs:[badLink?9:10],data:{message:{role,toolCallId:callId,source:{kind:'tool',callId},isError:false,content:[{type:'text',text:'Synthetic host reported completion'}]}}}
 let seed=new ContinuityStore(directory),ledger=new ExecutionLedger(seed)
 const lib=seed.create('Synthetic restart result'),original=seed.append(lib.id,{session:'synthetic-history',seq:1,time:'2026-10-31T00:00:00Z',role:'user',text:'Synthetic original source must remain unchanged'})
 seed.bind(session,lib.id,0);seed.begin(lib.id,session,'main')
 ledger.observe(lib.id,session,{...call,data:{...call.data,arguments:JSON.stringify(args)}});ledger.start(lib.id,session,{callId,name:'write',arguments:args})
 if(knownFailure)ledger.complete(lib.id,session,callId,{isError:true,error:{info:{code:'TIMEOUT'}}})
 seed.close();seed=null
 const events=missing?[call]:[call,result]
 if(duplicate)events.push({...result,seq:12,data:{message:{...result.data.message,isError:true,error:{code:'TIMEOUT'}}}})
 let toolDispatches=0
 const listeners=new Map(),agent={status:'running',session:{id:session,header:{},snapshotEvents:(from=0)=>events.filter(e=>e.seq>=from)},ctx:{systemPrompt:{context:()=>()=>{}}}},ctx={agents:{get:id=>id===session?agent:null,list:()=>[agent]},tools:{register:()=>()=>{},execute:()=>{toolDispatches++;throw Error('Recovery must never replay a tool')}},sessions:{flush:async()=>{}},on:(name,fn)=>{listeners.set(name,[...(listeners.get(name)||[]),fn]);return()=>{}},effect:()=>{},logger:{warn:()=>{}}}
 const plugin=await createPlugin(ctx,{dataDirectory:directory,workingMemory:{enabled:false},manager:{enabled:false}},{isAgentLoopRequest:()=>true})
 t.after(async()=>{await plugin.dispose();const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('rt-native-restart-'));rmSync(path,{recursive:true,force:true})})
 await listeners.get('agent/pre-step')[0]({agent,messages:[],signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))
 assert.equal(toolDispatches,0)
 assert.equal(plugin.store.record(lib.id,original).text,'Synthetic original source must remain unchanged')
 assert.equal(plugin.store.library(lib.id).owner,session)
 return {plugin,lib,callId,session,agent,events,result,listeners,operation:()=>plugin.store.db.prepare('SELECT * FROM cm_tool_operations WHERE library=? AND session=? AND call_id=?').get(lib.id,session,callId)}
}

test('restart recovers a missed completed native result without another tool call or a manual acknowledgement',async t=>{
 const f=await restart(t)
 assert.equal(f.operation().status,'succeeded')
 assert.ok(f.operation().result_digest)
 assert.equal(JSON.parse(f.operation().result_ref).seq,11)
 assert.equal(f.plugin.store.recovery.needsReview(f.lib.id),false)
 assert.ok(f.plugin.store.busy(f.lib.id),'reconciliation does not release the new main request lease')
})
test('restart retains genuinely missing results for human review',async t=>{
 const f=await restart(t,{missing:true});assert.equal(f.operation().status,'uncertain');assert.equal(f.plugin.store.recovery.needsReview(f.lib.id),true)
})
test('restart never associates a result with changed native call arguments',async t=>{
 const f=await restart(t,{changed:true});assert.equal(f.operation().status,'uncertain')
})
test('restart does not override an already recorded unknown failure',async t=>{
 const f=await restart(t,{knownFailure:true});assert.equal(f.operation().status,'uncertain');assert.equal(f.operation().failure_code,'TIMEOUT')
})
test('restart refuses user-authored and contradictory duplicate result envelopes',async t=>{
 for(const options of [{role:'user'},{duplicate:true}]){const f=await restart(t,options);assert.equal(f.operation().status,'uncertain')}
})
test('restart does not accept a native result citing another call position',async t=>{
 const f=await restart(t,{badLink:true});assert.equal(f.operation().status,'uncertain')
})
test('a result arriving after reload is reconciled on the next step, and unchanged checks do not rescan',async t=>{
 const f=await restart(t,{missing:true});assert.equal(f.operation().status,'uncertain')
 f.events.push(f.result)
 for(const listener of f.listeners.get('session/event'))listener(f.agent.session,f.result)
 await f.listeners.get('agent/pre-step')[0]({agent:f.agent,messages:[],signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))
 assert.equal(f.operation().status,'succeeded')
 let scans=0;const snapshot=f.agent.session.snapshotEvents;f.agent.session.snapshotEvents=from=>{scans++;return snapshot(from)}
 assert.equal(f.plugin.execution.reconcileNativeResults(f.lib.id,f.agent.session).cached,true);assert.equal(scans,0)
})
test('late native evidence does not overwrite a completed human review',async t=>{
 const f=await restart(t,{missing:true})
 f.plugin.store.recovery.resolve(f.lib.id,{session:f.session,call_id:f.callId,decision:'abandon-no-replay',note:'Synthetic human explicitly completed review'})
 f.events.push(f.result)
 for(const listener of f.listeners.get('session/event'))listener(f.agent.session,f.result)
 await f.listeners.get('agent/pre-step')[0]({agent:f.agent,messages:[],signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))
 assert.equal(f.operation().status,'reviewed');assert.equal(f.operation().decision,'abandon-no-replay')
})
