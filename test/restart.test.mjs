import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {ContinuityStore} from '../lib/store.mjs'

function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'continuity-restart-'));let store=new ContinuityStore(dir)
 const lib=store.create('synthetic restart');store.bind('owner',lib.id,0)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 return {lib,reopen(){store.close();store=new ContinuityStore(dir);return store},get store(){return store}}
}
const call=(name,id='call')=>({type:'tool/call',data:{name,callId:id,arguments:{action:'send'}}})
const result=(unknown=false,id='call')=>({type:'tool/result',data:{message:{toolCallId:id},...(unknown?{error:{code:'TOOL_OUTCOME_UNKNOWN'}}:{})}})
test('interrupted literal shell diagnostics recover without quarantining later tools',t=>{
 const f=setup(t);f.store.begin(f.lib.id,'owner','main')
 f.store.recovery.observe(f.lib.id,'owner',{type:'tool/call',data:{name:'ops_bash',callId:'diagnostic',arguments:{command:'sleep 12; cat restart.log 2>/dev/null | tail -5; tasklist | grep -ci "DSH NEXT"'}}})
 const s=f.reopen();assert.equal(s.recovery.needsReview(f.lib.id),false);assert.equal(s.library(f.lib.id).error,null);s.recovery.assertTool(f.lib.id,'qq_bridge_send',{})
 assert.equal(s.db.prepare('SELECT readonly,status FROM cm_tool_operations WHERE call_id=?').get('diagnostic').readonly,1)
})
test('an uncertain outgoing action still allows literal reads and cwd inspection while blocking writes',t=>{
 const f=setup(t);f.store.recovery.observe(f.lib.id,'owner',call('qq_bridge_send'));f.store.recovery.observe(f.lib.id,'owner',result(true))
 const s=f.reopen();assert.equal(s.recovery.needsReview(f.lib.id),true)
 s.recovery.assertTool(f.lib.id,'working_directory',{});s.recovery.assertTool(f.lib.id,'ops_bash',{command:'cat README.md'})
 assert.throws(()=>s.recovery.assertTool(f.lib.id,'ops_bash',{command:'cat README.md > changed.txt'}),{code:'RECOVERY_REVIEW_REQUIRED'})
 assert.throws(()=>s.recovery.assertTool(f.lib.id,'qq_bridge_send',{}),{code:'RECOVERY_REVIEW_REQUIRED'})
})
test('连续三次主对话中断重启仍能开始新轮，不改原文与owner',t=>{
 const f=setup(t);f.store.append(f.lib.id,{session:'owner',seq:1,time:new Date().toISOString(),role:'user',text:'must survive'})
 for(let i=0;i<3;i++){f.store.begin(f.lib.id,'owner','main');const s=f.reopen();assert.equal(s.library(f.lib.id).error,null);assert.equal(s.recovery.needsReview(f.lib.id),false);assert.equal(s.library(f.lib.id).owner,'owner');assert.equal(s.report(f.lib.id).records,1)}
})
test('已返回结果的QQ操作重启不阻断，不生成重复发送',t=>{
 const f=setup(t);f.store.begin(f.lib.id,'owner','main');f.store.recovery.observe(f.lib.id,'owner',call('qq_bridge_send'));f.store.recovery.observe(f.lib.id,'owner',result())
 const s=f.reopen();assert.equal(s.library(f.lib.id).error,null);assert.equal(s.recovery.needsReview(f.lib.id),false);s.recovery.assertTool(f.lib.id,'qq_bridge_send',{})
})
test('未知发送结果不锁对话，只阻止再次写操作；人工核查不会重放',t=>{
 const f=setup(t);f.store.begin(f.lib.id,'owner','main');f.store.recovery.observe(f.lib.id,'owner',call('ops_bash'));f.store.recovery.observe(f.lib.id,'owner',result(true))
 const s=f.reopen();assert.equal(s.library(f.lib.id).error,null);assert.equal(s.recovery.needsReview(f.lib.id),true)
 const token=s.begin(f.lib.id,'owner','main');s.finish(f.lib.id,token)
 s.recovery.assertTool(f.lib.id,'read',{});s.recovery.assertTool(f.lib.id,'cm_library',{action:'status'})
 assert.throws(()=>s.recovery.assertTool(f.lib.id,'ops_bash',{}),{code:'RECOVERY_REVIEW_REQUIRED'})
 const review=s.recovery.resolve(f.lib.id,{session:'owner',call_id:'call',decision:'verified-applied',note:'Verified outgoing image message id in local history'})
 assert.equal(review.replayed,false);assert.equal(s.recovery.needsReview(f.lib.id),false)
 assert.throws(()=>s.recovery.resolve(f.lib.id,{session:'owner',call_id:'call',decision:'verified-applied',note:'same'}),{code:'CONFLICT'})
})
test('只读工具中断可回收；真正的历史变化错误不会被清掉',t=>{
 const f=setup(t);f.store.begin(f.lib.id,'owner','main');f.store.recovery.observe(f.lib.id,'owner',call('read'));f.store.pause(f.lib.id,'SOURCE_CHANGED')
 const s=f.reopen();assert.equal(s.library(f.lib.id).error,'SOURCE_CHANGED');assert.equal(s.recovery.needsReview(f.lib.id),false)
 assert.throws(()=>s.begin(f.lib.id,'owner','main'),{code:'PAUSED'})
})
test('后台整理中断仅暂停整理，不关闭主会话',t=>{
 const f=setup(t);f.store.db.prepare("INSERT INTO extraction(library,config,paused) VALUES(?,'{}',0)").run(f.lib.id);f.store.begin(f.lib.id,'owner','extract')
 const s=f.reopen();assert.equal(s.library(f.lib.id).error,null);assert.deepEqual({...s.db.prepare('SELECT paused,error FROM extraction').get()},{paused:1,error:'PREVIOUS_EXTRACTION_INTERRUPTED'})
})

test('首次升级遇到旧版活动轮，无法追踪其副作用时保守核查，仍可对话',t=>{
 const f=setup(t);f.store.begin(f.lib.id,'owner','main')
 f.store.db.exec('DROP TABLE cm_tool_operations;DROP TABLE cm_recovery_runs')
 const s=f.reopen();assert.equal(s.library(f.lib.id).error,null);assert.equal(s.recovery.needsReview(f.lib.id),true)
 assert.equal(s.recovery.pending(f.lib.id).legacy.length,1)
 const token=s.begin(f.lib.id,'owner','main');s.finish(f.lib.id,token)
})
test('旧版中断标记迁移为可对话的待核查项，不能绕过写操作保护',t=>{
 const f=setup(t);f.store.pause(f.lib.id,'PREVIOUS_PROCESS_INTERRUPTED')
 const s=f.reopen();assert.equal(s.library(f.lib.id).error,null);assert.equal(s.recovery.needsReview(f.lib.id),true)
 assert.match(s.recovery.context(f.lib.id),/继续对话/);assert.throws(()=>s.recovery.assertTool(f.lib.id,'cm_self',{action:'propose'}),{code:'RECOVERY_REVIEW_REQUIRED'})
 const pending=s.recovery.pending(f.lib.id).legacy[0]
 s.recovery.resolve(f.lib.id,{legacy_id:pending.id,decision:'abandon-no-replay',note:'Human chooses not to replay old task'})
 assert.equal(s.recovery.needsReview(f.lib.id),false)
})

test('取消发送即使返回ABORTED也视为结果未明，不能直接重发',t=>{
 const f=setup(t);f.store.recovery.observe(f.lib.id,'owner',call('ops_bash'))
 f.store.recovery.observe(f.lib.id,'owner',{type:'tool/result',data:{message:{toolCallId:'call'},error:{code:'ABORTED'}}})
 assert.equal(f.store.recovery.needsReview(f.lib.id),true)
 assert.throws(()=>f.store.recovery.assertTool(f.lib.id,'ops_bash',{}),{code:'RECOVERY_REVIEW_REQUIRED'})
})

test('真实子进程非正常退出后锁可回收，连续三次仍保留原文和绑定',t=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-process-restart-'))
 t.after(()=>rmSync(dir,{recursive:true,force:true}))
 let s=new ContinuityStore(dir);const lib=s.create('synthetic crash');s.bind('owner',lib.id,0)
 const rid=s.append(lib.id,{session:'owner',seq:1,time:new Date().toISOString(),role:'user',text:'崩溃前已提交的原文🐟'});s.close()
 const moduleURL=new URL('../lib/store.mjs',import.meta.url).href
 for(let i=0;i<3;i++){
   const code=`import {ContinuityStore} from ${JSON.stringify(moduleURL)};const s=new ContinuityStore(${JSON.stringify(dir)});s.begin(${JSON.stringify(lib.id)},'owner','main');process.exit(23)`
   const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true})
   assert.equal(child.status,23,child.stderr)
   s=new ContinuityStore(dir)
   try{assert.equal(s.library(lib.id).error,null);assert.equal(s.library(lib.id).owner,'owner');assert.equal(s.read(lib.id,rid).text,'崩溃前已提交的原文🐟');assert.equal(s.busy(lib.id),null)}finally{s.close()}
 }
})
