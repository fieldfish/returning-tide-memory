import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Extraction} from '../lib/extraction.mjs'
import {Evidence} from '../lib/evidence.mjs'
import {ActivityArchive} from '../lib/activity-archive.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {Consolidation} from '../lib/consolidation.mjs'

function fixture(t,reply){
 const dir=mkdtempSync(join(tmpdir(),'cm-evidence-integrity-')),store=new ContinuityStore(dir),lib=store.create('Synthetic integrity');store.bind('owner',lib.id,0)
 let calls=0
 const x=new Extraction(store,{dshCall:async args=>{calls++;return {text:JSON.stringify(await reply(args)),usage:{inputTokens:20,outputTokens:10}}}})
 x.configure(lib.id,'owner',{source:'dsh',provider:'test',model:'test',minIntervalMs:0,evidenceEnabled:true})
 const evidence=new Evidence(store,{},x),activity=new ActivityArchive(store,{enabled:true})
 store.db.exec('CREATE TABLE IF NOT EXISTS cm_legacy_notes(library TEXT NOT NULL,legacy_id TEXT NOT NULL,rid TEXT,active INTEGER NOT NULL,PRIMARY KEY(library,legacy_id))')
 const raw=(text,seq=1)=>store.append(lib.id,{session:'owner',seq,time:new Date(Date.now()-60000+seq*100).toISOString(),role:'user',text})
 const deactivate=rid=>store.db.prepare('INSERT INTO cm_legacy_notes VALUES(?,?,?,0)').run(lib.id,rid,rid)
 const observe=(ref,seq=20)=>activity.report(lib.id,'owner',{kind:'browser',title:'合成观察',body:'来源表示使用暖杏色。',refs:[ref],evidence_type:'tool-output',idempotency_key:'obs-'+seq},{session:'owner',seq}).id
 t.after(async()=>{await evidence.stop();await x.stop();store.close();rmSync(dir,{recursive:true,force:true})})
 return {store,lib,x,evidence,raw,deactivate,observe,calls:()=>calls}
}

test('认识整理可使用唯一短ID，但写入的是本批规范原文引用',async t=>{
 let f,rid;f=fixture(t,()=>({items:[{key:'synthetic.fact',kind:'fact',body:'有一条合成说明',refs:[rid.slice(0,10)],reason:'来源明确'}]}));rid=f.raw('这是一条合成说明。');f.x.resume(f.lib.id,'owner')
 await f.x.run(f.lib.id,'owner');assert.deepEqual(f.store.entry(f.lib.id,'synthetic.fact').refs,[rid])
})

test('认识整理混合输入保留用户经历，排除禁止再提炼的管理报告',async t=>{
 let f,rid;f=fixture(t,args=>{assert.deepEqual(JSON.parse(args.input).records.map(r=>r.id),[rid]);return {items:[]}});rid=f.raw('今天真实表达想做网页。')
 f.store.append(f.lib.id,{session:'owner',seq:2,time:new Date().toISOString(),role:'assistant',text:'cm_self propose成功，候选待认可。'});f.x.resume(f.lib.id,'owner')
 const r=await f.x.run(f.lib.id,'owner');assert.equal(r.excluded_reports,1);assert.equal(f.x.sources.hasNew(f.lib.id,f.x.status(f.lib.id).cursor),false);assert.equal(f.store.report(f.lib.id).records,2)
})

test('核验显式来源也过滤停用的活动祖先，不调用模型',async t=>{
 const f=fixture(t,()=>{throw Error('must not call')}),ref=f.raw('暖杏色'),report=f.observe(ref);f.deactivate(ref)
 const r=await f.evidence.verify(f.lib.id,'owner','采用什么色彩',[report]);assert.equal(r.status,'insufficient');assert.equal(f.calls(),0)
 assert.equal(f.store.record(f.lib.id,report).text.includes('暖杏色'),true)
})
test('核验使用活动原生轮次，当前报告不能自证旧事',async t=>{
 const f=fixture(t,()=>{throw Error('must not call')}),ref=f.raw('暖杏色'),report=f.observe(ref)
 const r=await f.evidence.verify(f.lib.id,'owner','上次用什么色彩',[report],null,{session:'owner',fromSeq:10});assert.equal(r.status,'insufficient');assert.equal(f.calls(),0)
})
for(const change of ['inactive','deleted','content'])test('核验迟到响应不再使用变化来源：'+change,async t=>{
 let f,rid
 f=fixture(t,()=>{if(change==='inactive')f.deactivate(rid);else if(change==='deleted')f.store.removeRecord(f.lib.id,'owner',rid);else f.store.db.prepare('UPDATE records SET digest=? WHERE id=?').run('changed',rid);return {status:'supported',answer:'暖杏色',citations:[{id:rid,quote:'使用暖杏色'}]}})
 rid=f.raw('现在使用暖杏色。')
 const r=await f.evidence.verify(f.lib.id,'owner','现在用什么',[rid]);assert.equal(r.status,'insufficient');assert.deepEqual(r.citations,[]);assert.equal(r.guard,'source-changed');assert.equal(f.evidence.status(f.lib.id).paused,0)
})
test('核验模型忽略取消仍不能提交迟到结论',async t=>{
 const controller=new AbortController();let rid
 const f=fixture(t,()=>{controller.abort();return {status:'supported',answer:'暖杏色',citations:[{id:rid,quote:'使用暖杏色'}]}});rid=f.raw('现在使用暖杏色。')
 await assert.rejects(f.evidence.verify(f.lib.id,'owner','现在用什么',[rid],controller.signal),{code:'CANCELLED'});assert.equal(f.evidence.status(f.lib.id).paused,0)
})
test('核验期间认可版本变化不能确认旧版当前有效',async t=>{
 let f,old,next
 f=fixture(t,()=>{f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'海蓝',reason:'修订',refs:[next],expectedRevision:1},true);return {status:'supported',answer:'暖杏色',citations:[{id:old,quote:'使用暖杏色'}]}})
 old=f.raw('现在使用暖杏色。');next=f.raw('后来改为海蓝。',2);f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'暖杏色',reason:'初始',refs:[old]},true)
 const r=await f.evidence.verify(f.lib.id,'owner','现在用什么',[old],null,null,{scope:'current-state',state_keys:['palette']});assert.equal(r.status,'insufficient');assert.equal(r.guard,'state-changed')
})

test('活动报告正文未变但祖先变化时核验也不能提交',async t=>{
 let f,ref,report
 f=fixture(t,()=>{f.store.db.prepare('UPDATE records SET digest=? WHERE id=?').run('changed-ancestor',ref);return {status:'supported',answer:'暖杏色',citations:[{id:report,quote:'来源表示使用暖杏色。'}]}})
 ref=f.raw('暖杏色');report=f.observe(ref)
 const r=await f.evidence.verify(f.lib.id,'owner','这条记录的配色',[report]);assert.equal(r.status,'insufficient');assert.equal(r.guard,'source-changed')
})

for(const stage of ['extraction','consolidation'])for(const change of ['inactive','digest','pause'])test(stage+'迟到结果整批回滚：'+change,async t=>{
 let f,ref,c
 f=fixture(t,()=>{
   if(change==='inactive')f.deactivate(ref)
   else if(change==='digest')f.store.db.prepare('UPDATE records SET digest=? WHERE id=?').run('changed',ref)
   else if(stage==='extraction')f.x.pause(f.lib.id)
   else c.pause(f.lib.id)
   return stage==='extraction'?{items:[]}:{updates:[]}
 })
 ref=f.raw('这是需要增量整理的合成原文。')
 if(stage==='consolidation'){
   f.x.configure(f.lib.id,'owner',{source:'dsh',provider:'test',model:'test',situationsEnabled:true,minIntervalMs:0})
   c=new Consolidation(f.store,new Situations(f.store,new Scenes(f.store)),f.x);t.after(()=>c.stop());c.resume(f.lib.id,'owner')
 }else f.x.resume(f.lib.id,'owner')
 await assert.rejects(stage==='extraction'?f.x.run(f.lib.id,'owner'):c.run(f.lib.id,'owner'))
 assert.equal(stage==='extraction'?f.x.status(f.lib.id).cursor:c.state(f.lib.id).cursor,0)
 assert.equal(f.store.library(f.lib.id).error,null);assert.equal(f.store.db.prepare('SELECT count(*) n FROM entries').get().n,0)
})
