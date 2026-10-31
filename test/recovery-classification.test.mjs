import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'
import {readOnlyTool} from '../lib/recovery.mjs'
const errorResult=(code,name='FsError')=>({isError:true,error:{message:'synthetic host failure',info:{name,code}}})
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cm-recovery-class-')),store=new ContinuityStore(dir),lib=store.create('Synthetic recovery classification');store.bind('owner',lib.id,0)
 const ledger=new ExecutionLedger(store)
 const call=(callId,name,args={})=>({callId,name,arguments:args})
 const op=callId=>store.db.prepare('SELECT * FROM cm_tool_operations WHERE library=? AND session=? AND call_id=?').get(lib.id,'owner',callId)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 return {dir,store,lib,ledger,call,op}
}
test('ops_bash host metadata is benign while command analysis stays strict',()=>{
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',workdir:'C:/synthetic'}),true)
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',workdir:'C:/synthetic',run_in_background:false}),true)
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',run_in_background:true}),false)
 assert.equal(readOnlyTool('ops_bash',{command:'echo x > README.md',workdir:'C:/synthetic'}),false)
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',unknown_field:true}),false)
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',workdir:'\u0000bad'}),false)
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',workdir:42}),false)
 assert.equal(readOnlyTool('ops_bash',{command:'echo $(cat README.md)'}),false)
})
test('a planned cancellation is not_started; cancellation codes after start need actual execution evidence',t=>{
 const f=fixture(t)
 f.ledger.prepare(f.lib.id,'owner',f.call('cancel-before','synthetic_send'))
 f.ledger.complete(f.lib.id,'owner','cancel-before',errorResult('ABORTED_BEFORE_DISPATCH','AbortError'))
 assert.equal(f.op('cancel-before').status,'not_started');assert.equal(f.store.recovery.needsReview(f.lib.id),false)
 f.ledger.start(f.lib.id,'owner',f.call('started-reports-before','synthetic_send'))
 f.ledger.complete(f.lib.id,'owner','started-reports-before',errorResult('ABORTED_BEFORE_DISPATCH','AbortError'))
 assert.equal(f.op('started-reports-before').status,'uncertain','a tool body can return the same code after an effect')
 f.ledger.start(f.lib.id,'owner',f.call('cancel-after','synthetic_send'))
 f.ledger.complete(f.lib.id,'owner','cancel-after',errorResult('ABORTED','AbortError'))
 assert.equal(f.op('cancel-after').status,'uncertain')
})
test('an invisible tool reported as UNKNOWN_TOOL is not_started, a visible body throwing it stays uncertain',t=>{
 const f=fixture(t)
 f.ledger.start(f.lib.id,'owner',f.call('missing','synthetic_missing'))
 f.ledger.complete(f.lib.id,'owner','missing',errorResult('UNKNOWN_TOOL','ToolNotFoundError'),{trust:{unknownTool:true}})
 assert.equal(f.op('missing').status,'not_started');assert.equal(f.op('missing').failure_code,'UNKNOWN_TOOL')
 f.ledger.start(f.lib.id,'owner',f.call('visible','synthetic_visible'))
 f.ledger.complete(f.lib.id,'owner','visible',errorResult('UNKNOWN_TOOL','ToolNotFoundError'),{trust:{unknownTool:false}})
 assert.equal(f.op('visible').status,'uncertain')
})
test('FS_NOT_OBSERVED needs both a trusted native edit identity and the host edit-intent rejection',t=>{
 const f=fixture(t)
 f.ledger.start(f.lib.id,'owner',f.call('untrusted','edit',{file_path:'x',old_string:'a',new_string:'b'}))
 f.ledger.complete(f.lib.id,'owner','untrusted',errorResult('FS_NOT_OBSERVED'),{trust:{nativeEdit:false,editIntentRejected:true}})
 assert.equal(f.op('untrusted').status,'uncertain')
 f.ledger.start(f.lib.id,'owner',f.call('no-intent','edit',{file_path:'x',old_string:'a',new_string:'b'}))
 f.ledger.complete(f.lib.id,'owner','no-intent',errorResult('FS_NOT_OBSERVED'),{trust:{nativeEdit:true,editIntentRejected:false}})
 assert.equal(f.op('no-intent').status,'uncertain')
 f.ledger.start(f.lib.id,'owner',f.call('proven','edit',{file_path:'x',old_string:'a',new_string:'b'}))
 f.ledger.complete(f.lib.id,'owner','proven',errorResult('FS_NOT_OBSERVED'),{trust:{nativeEdit:true,editIntentRejected:true}})
 assert.equal(f.op('proven').status,'not_started');assert.equal(f.op('proven').stage,'pre-effect')
})
test('native host-declined mutations are not_started while the same codes from other identities stay uncertain',t=>{
 const f=fixture(t)
 const proven=[['edit','FS_NOT_FOUND',{nativeEdit:true,editIntentRejected:true,editIntentCode:'FS_NOT_FOUND'}],['edit','FS_EDIT_NOT_FOUND',{nativeEdit:true,editIntentAccepted:true}],['edit','FS_AMBIGUOUS_EDIT',{nativeEdit:true,editIntentAccepted:true}],['write','FS_NOT_OBSERVED',{nativeWrite:true,writeIntentAccepted:true,writeIntentKind:'createIfAbsent'}],['edit','INVALID_ARGS',{nativeEdit:true,invalidArguments:true}],['write','INVALID_ARGS',{nativeWrite:true,invalidArguments:true}]]
 for(const [name,code,trust]of proven){const id='native-'+name+'-'+code;f.ledger.start(f.lib.id,'owner',f.call(id,name));f.ledger.complete(f.lib.id,'owner',id,errorResult(code,code==='INVALID_ARGS'?'ToolArgsError':'FsError'),{trust});assert.equal(f.op(id).status,'not_started',code+' from the native identity');}
 for(const [name,code,trust]of [['edit','FS_EDIT_NOT_FOUND',{}],['edit','FS_AMBIGUOUS_EDIT',{nativeEdit:false}],['write','FS_NOT_OBSERVED',{}],['edit','INVALID_ARGS',{nativeEdit:true,invalidArguments:false}],['synthetic_tool','FS_NOT_FOUND',{nativeEdit:false,editIntentRejected:true,editIntentCode:'FS_NOT_FOUND'}]]){const id='custom-'+name+'-'+code;f.ledger.start(f.lib.id,'owner',f.call(id,name));f.ledger.complete(f.lib.id,'owner',id,errorResult(code,'HarnessError'),{trust});assert.equal(f.op(id).status,'uncertain',code+' from a custom identity');}
})
test('a persisted native refusal stays decided after restart while a started write without result stays uncertain',t=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-recovery-persist-'))
 t.after(()=>rmSync(dir,{recursive:true,force:true}))
 let store=new ContinuityStore(dir),ledger=new ExecutionLedger(store)
 const clean=store.create('Synthetic decided refusal'),ambiguous=store.create('Synthetic unfinished write')
 store.bind('clean-owner',clean.id,0);store.bind('write-owner',ambiguous.id,0)
 ledger.start(clean.id,'clean-owner',{callId:'declined',name:'edit',arguments:{file_path:'x',old_string:'a',new_string:'b'}})
 ledger.complete(clean.id,'clean-owner','declined',errorResult('FS_AMBIGUOUS_EDIT'),{trust:{nativeEdit:true,editIntentAccepted:true}})
 ledger.start(ambiguous.id,'write-owner',{callId:'started',name:'write',arguments:{file_path:'y',content:'z'}})
 store.close()
 store=new ContinuityStore(dir);new ExecutionLedger(store)
 assert.equal(store.db.prepare('SELECT status FROM cm_tool_operations WHERE call_id=?').get('declined').status,'not_started')
 assert.equal(store.db.prepare('SELECT status FROM cm_tool_operations WHERE call_id=?').get('started').status,'uncertain')
 assert.equal(store.recovery.needsReview(clean.id),false)
 assert.equal(store.recovery.needsReview(ambiguous.id),true)
 store.close()
})
test('read-only interruption after restart does not require review while a write still does',t=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-recovery-restart-'))
 t.after(()=>rmSync(dir,{recursive:true,force:true}))
 let store=new ContinuityStore(dir)
 const lib=store.create('Synthetic restart classification');store.bind('owner',lib.id,0)
 let ledger=new ExecutionLedger(store)
 ledger.start(lib.id,'owner',{callId:'read-only',name:'ops_bash',arguments:{command:'cat README.md',workdir:'C:/synthetic'}})
 ledger.start(lib.id,'owner',{callId:'writer',name:'ops_bash',arguments:{command:'echo x > README.md',workdir:'C:/synthetic'}})
 assert.equal(store.db.prepare('SELECT readonly FROM cm_tool_operations WHERE call_id=?').get('read-only').readonly,1)
 store.close()
 store=new ContinuityStore(dir);store.bind('owner',lib.id,1)
 const read=store.db.prepare('SELECT status,stage FROM cm_tool_operations WHERE call_id=?').get('read-only')
 const write=store.db.prepare('SELECT status FROM cm_tool_operations WHERE call_id=?').get('writer')
 assert.equal(read.status,'failed');assert.equal(write.status,'uncertain')
 assert.equal(store.recovery.needsReview(lib.id),true)
 store.close()
})
