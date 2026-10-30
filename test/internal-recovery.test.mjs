import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'

function fixture(t){const directory=mkdtempSync(join(tmpdir(),'cm-internal-recovery-')),store=new ContinuityStore(directory),lib=store.create('Synthetic internal control');store.bind('owner',lib.id,0);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true})});return {directory,store,lib}}
for(const name of ['cm_task','cm_library','cm_self','cm_checkpoint','cm_extraction','cm_report','cm_delete','cm_situation','cm_working','cm_scene','cm_activity'])test(name+'原生参数错误不变成外部执行未知',t=>{
 const f=fixture(t),journal=f.store.recovery
 journal.observe(f.lib.id,'owner',{type:'tool/call',seq:1,data:{call:{callId:'synthetic-invalid',name,arguments:{action:'feedback',id:'invalid'}}}})
 journal.observe(f.lib.id,'owner',{type:'tool/result',seq:2,data:{callId:'synthetic-invalid',isError:true,error:{code:'TOOL_OUTCOME_UNKNOWN',message:'Synthetic validation error'}}})
 assert.equal(journal.pending(f.lib.id).operations.length,0);assert.doesNotThrow(()=>journal.assertTool(f.lib.id,'write',{path:'synthetic.txt'}));assert.equal(f.store.library(f.lib.id).error,null)
})
test('实际外部操作和未知自定义cm工具仍需要核查，不能放行写入',t=>{
 const f=fixture(t),journal=f.store.recovery
 for(const [i,name]of ['write','cm_custom_remote_write'].entries()){
  const callId='external-'+i;journal.observe(f.lib.id,'owner',{type:'tool/call',seq:i*2,data:{call:{callId,name,arguments:{path:'synthetic.txt'}}}})
  journal.observe(f.lib.id,'owner',{type:'tool/result',seq:i*2+1,data:{callId,isError:true,error:{code:'TOOL_OUTCOME_UNKNOWN'}}})
 }
 assert.equal(journal.pending(f.lib.id).operations.length,2);assert.throws(()=>journal.assertTool(f.lib.id,'write',{}),{code:'RECOVERY_REVIEW_REQUIRED'});assert.doesNotThrow(()=>journal.assertTool(f.lib.id,'cm_read',{}))
})
test('旧版本遗留的内部未知标记恢复后不继续卡写，真实外部未知仍保留',t=>{
 const f=fixture(t),insert=f.store.db.prepare('INSERT INTO cm_tool_operations(library,session,call_id,name,args_digest,readonly,status,time) VALUES(?,?,?,?,?,0,?,?)')
 insert.run(f.lib.id,'owner','old-control','cm_working','synthetic','uncertain',Date.now());insert.run(f.lib.id,'owner','old-external','write','synthetic','uncertain',Date.now());f.store.recovery.startup()
 assert.equal(f.store.db.prepare('SELECT status FROM cm_tool_operations WHERE call_id=?').get('old-control').status,'settled')
 assert.deepEqual(f.store.recovery.pending(f.lib.id).operations.map(o=>o.call_id),['old-external'])
 const audit=f.store.db.prepare("SELECT detail FROM audit WHERE type='internal-control-recovered'").get();assert.equal(JSON.parse(audit.detail).commit_assumed,false)
})
test('缺少原文ID和拼错的超长hex ID给出输入错误，不泄漏SQLite参数异常',t=>{
 const f=fixture(t)
 for(const id of [undefined,null,'','a'.repeat(30)])assert.throws(()=>f.store.record(f.lib.id,id),{code:'INVALID_INPUT'})
 assert.throws(()=>f.store.record(f.lib.id,'a'.repeat(24)),{code:'NOT_FOUND'})
})
