import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,appendFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {snapshot,restoreCopy} from '../lib/snapshot.mjs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {Extraction} from '../lib/extraction.mjs'
import {Consolidation} from '../lib/consolidation.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {WorkingMemory} from '../lib/working-memory.mjs'
import {MemoryDynamics} from '../lib/memory-dynamics.mjs'

test('恢复副本保留使用反馈，退出旧工作集并暂停两类后台整理',async t=>{
 const root=mkdtempSync(join(tmpdir(),'cm-snapshot-feedback-')),store=new ContinuityStore(join(root,'source')),lib=store.create('合成反馈快照');store.bind('owner',lib.id,0)
 const x=new Extraction(store),scenes=new Scenes(store),c=new Consolidation(store,new Situations(store,scenes),x),d=new MemoryDynamics(store,{enabled:true}),working=new WorkingMemory(store,{},scenes,{enabled:true})
 t.after(async()=>{working.close();await c.stop();await x.stop();store.close();const path=resolve(root);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('cm-snapshot-feedback-'));rmSync(path,{recursive:true,force:true})})
 const id=store.append(lib.id,{session:'owner',seq:1,time:'2020-01-01T00:00:00Z',role:'user',text:'原始旧经历'}),ref=store.append(lib.id,{session:'owner',seq:2,time:'2026-10-29T08:00:00Z',role:'assistant',text:'实际用旧经历处理了问题'})
 d.record(lib.id,'owner',{id,kind:'helpful',refs:[ref],reason:'有后续记录'})
 x.configure(lib.id,'owner',{source:'dsh',provider:'synthetic',model:'test',situationsEnabled:true});x.resume(lib.id,'owner');c.resume(lib.id,'owner');working.save(lib.id,'owner',{status:'ready',refs:[id]})
 snapshot(store,join(root,'snapshot'));restoreCopy(join(root,'snapshot'),join(root,'copy'))
 const copy=new ContinuityStore(join(root,'copy')),restoredX=new Extraction(copy),restoredC=new Consolidation(copy,new Situations(copy,new Scenes(copy)),restoredX),restoredD=new MemoryDynamics(copy,{enabled:true})
 try{
   assert.equal(restoredC.status(lib.id).paused,true);assert.equal(restoredX.status(lib.id).paused,true);assert.equal(copy.db.prepare('SELECT count(*) n FROM cm_working_frames').get().n,0)
   assert.equal(restoredD.rows(lib.id,id).length,1);assert.equal(copy.record(lib.id,id).text,'原始旧经历');assert.equal(copy.library(lib.id).owner,null)
   copy.db.prepare('UPDATE libraries SET error=NULL WHERE id=?').run(lib.id);copy.bind('new-owner',lib.id,copy.library(lib.id).revision)
   assert.equal(restoredC.dueIn(lib.id),null);assert.equal(restoredX.dueIn(lib.id),null)
 }finally{await restoredC.stop();await restoredX.stop();copy.close()}
 assert.equal(c.status(lib.id).paused,false);assert.equal(x.status(lib.id).paused,false);assert.equal(working.frame(lib.id,'owner').status,'ready')
})
test('快照校验并仅恢复新副本，原文保留且解绑暂停，不覆盖原库',t=>{
 const root=mkdtempSync(join(tmpdir(),'cm-snapshot-')),store=new ContinuityStore(join(root,'source'))
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
 const lib=store.create('synthetic');store.bind('owner',lib.id,0)
 const rid=store.append(lib.id,{session:'owner',seq:1,time:new Date().toISOString(),role:'user',text:'原始经历🐟'})
 snapshot(store,join(root,'snapshot'))
 assert.throws(()=>snapshot(store,join(root,'snapshot')),{code:'DESTINATION_EXISTS'})
 assert.throws(()=>restoreCopy(join(root,'snapshot'),join(root,'source')),{code:'DESTINATION_EXISTS'})
 const restored=restoreCopy(join(root,'snapshot'),join(root,'copy'));assert.equal(restored.original_modified,false)
 const copy=new ContinuityStore(join(root,'copy'))
 try{assert.equal(copy.read(lib.id,rid).text,'原始经历🐟');assert.equal(copy.library(lib.id).owner,null);assert.equal(copy.library(lib.id).error,'RESTORED_COPY_REQUIRES_REVIEW');assert.equal(copy.binding('owner'),null);assert.throws(()=>copy.bind('new-owner',lib.id,copy.library(lib.id).revision),{code:'REPAIR_REQUIRED'});assert.equal(copy.library(lib.id).owner,null)}finally{copy.close()}
 assert.equal(store.library(lib.id).owner,'owner');assert.equal(store.library(lib.id).error,null)
 appendFileSync(join(root,'snapshot','continuity.sqlite3'),'corruption')
 assert.throws(()=>restoreCopy(join(root,'snapshot'),join(root,'rejected')),{code:'BACKUP_HASH_MISMATCH'})
})

test('离线CLI恢复只生成暂停副本，人工核查后可绑定合成新会话',t=>{
 const root=mkdtempSync(join(tmpdir(),'cm-restore-cli-')),dir=join(root,'source'),store=new ContinuityStore(dir)
 t.after(()=>rmSync(root,{recursive:true,force:true}))
 const lib=store.create('synthetic CLI');store.bind('old-synthetic',lib.id,0)
 const rid=store.append(lib.id,{session:'old-synthetic',seq:1,time:new Date().toISOString(),role:'user',text:'不可覆盖的原文'})
 snapshot(store,join(root,'snapshot'));store.close()
 const run=(data,request)=>spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--data',data],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true})
 const target=join(root,'copy')
 let result=run(target,{action:'restore-copy',snapshot:join(root,'snapshot')});assert.equal(result.status,0,result.stderr)
 result=run(target,{action:'review-restored-copy',library_id:lib.id,expected_revision:2,reason:'Reviewed synthetic copy; no external actions will be replayed'});assert.equal(result.status,0,result.stderr)
 result=run(target,{action:'bind',session:'new-synthetic',library_id:lib.id,expected_revision:2});assert.equal(result.status,0,result.stderr)
 const copy=new ContinuityStore(target)
 try{assert.equal(copy.library(lib.id).owner,'new-synthetic');assert.equal(copy.library(lib.id).error,null);assert.equal(copy.read(lib.id,rid).text,'不可覆盖的原文')}finally{copy.close()}
 result=run(dir,{action:'report',library_id:lib.id});assert.equal(result.status,0,result.stderr)
 const old=new ContinuityStore(dir);try{assert.equal(old.library(lib.id).owner,'old-synthetic')}finally{old.close()}
})
