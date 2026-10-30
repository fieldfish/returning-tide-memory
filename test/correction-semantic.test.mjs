import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {WorkingMemory} from '../lib/working-memory.mjs'
import {Situations} from '../lib/situations.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'
import {ContextFrame} from '../lib/context-frame.mjs'

function fixture(t,{enabled=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'cm-semantic-correction-')),store=new ContinuityStore(dir),lib=store.create('Synthetic semantic correction');store.bind('owner',lib.id,0)
 const embedding=new Embedding(store,{memoryDynamics:{enabled}}),d=embedding.memoryDynamics,scenes=new Scenes(store),working=new WorkingMemory(store,embedding,scenes,{enabled:true,timeoutMs:3000}),situations=new Situations(store,scenes)
 const context=new ContextFrame(store,working,situations,new ExecutionLedger(store));let seq=0,calls=0,key='synthetic-cue-model'
 embedding.identity=async()=>{embedding.cached=key;return key}
 embedding.embed=async inputs=>{calls++;return inputs.map(s=>Float32Array.from(/导航|颜色|配色/.test(s)?[1,0,0]:[0,1,0]))}
 const raw=text=>store.append(lib.id,{session:'history',seq:++seq,time:new Date(Date.now()-60000+seq*100).toISOString(),role:'user',text})
 const old=raw('导航配色原先是蓝色，同一段还说周四去图书馆。'),next=raw('这部分现在改用青色。'),feedback=d.record(lib.id,'owner',{id:old,kind:'corrected',cue:'导航配色',refs:[next],reason:'原方案已改，用后续原话核对'})
 t.after(async()=>{working.close();embedding.close();store.close();rmSync(dir,{recursive:true,force:true})})
 return {store,lib,embedding,d,working,context,old,next,feedback,raw,calls:()=>calls,setKey:k=>{key=k},warm:()=>embedding.warm(lib.id,'owner'),match:(v=[1,0,0],ids=[old])=>d.match(lib.id,key,Float32Array.from(v),ids)}
}

test('具体纠正线索支持高置信改述，无关线索不连带失效',async t=>{
 const f=fixture(t);await f.warm();const match=await f.match(),r=f.store.record(f.lib.id,f.old)
 assert.equal(match.events[0].id,f.feedback.id)
 const assessed=f.d.assess(f.lib.id,r,'导航的颜色现在如何',undefined,match);assert.equal(assessed.auto_blocked,true);assert.deepEqual(assessed.corrective_refs,[f.next])
 const other=await f.match([0,1,0]);assert.equal(f.d.assess(f.lib.id,r,'周四去图书馆吗',undefined,other).auto_blocked,false)
 assert.equal(f.store.record(f.lib.id,f.old).text,'导航配色原先是蓝色，同一段还说周四去图书馆。')
})
test('只读查询不偷偷补建纠正向量，缺失时明确保守处理',async t=>{
 const f=fixture(t);await f.embedding.lookup(f.lib.id,'owner','导航的颜色现在如何');f.d.resume(f.lib.id,'owner')
 const before=f.calls(),result=await f.embedding.lookup(f.lib.id,'owner','导航的颜色现在如何',3,null,null,{details:true,readOnlyIndex:true})
 assert.equal(f.calls(),before+1);assert.equal(result.corrections.status,'index-incomplete');assert.equal(result.candidates.find(c=>c.id===f.old).auto_blocked,true)
 assert.ok(result.results.some(r=>r.id===f.store.shortId(f.lib.id,f.old)))
})
test('撤销后旧语义匹配和待补建标记均不继续压制原文',async t=>{
 const f=fixture(t);await f.warm();const match=await f.match();f.d.resume(f.lib.id,'owner');const pending=await f.match()
 f.d.retract(f.lib.id,'owner',{feedback_id:f.feedback.id,refs:[f.raw('撤回这条纠正反馈。')],reason:'新的复核'})
 const r=f.store.record(f.lib.id,f.old)
 assert.equal(f.d.assess(f.lib.id,r,'导航的颜色现在如何',undefined,match).auto_blocked,false)
 assert.equal(f.d.assess(f.lib.id,r,'导航的颜色现在如何',undefined,pending).auto_blocked,false)
})
test('纠正向量故障只暂停本功能，恢复会重建损坏派生数据',async t=>{
 const f=fixture(t);await f.warm();f.store.db.prepare('UPDATE cm_feedback_cue_vectors SET dimensions=99').run()
 const broken=await f.match();assert.equal(broken.status,'unavailable');assert.equal(f.d.health(f.lib.id).paused,true);assert.equal(f.embedding.health(f.lib.id).paused,false);assert.equal(f.store.library(f.lib.id).error,null)
 f.d.resume(f.lib.id,'owner');assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_feedback_cue_vectors').get().n,0)
 await f.warm();assert.equal((await f.match()).status,'ready');assert.equal(f.d.status(f.lib.id,f.embedding.cached).pending_cues,0)
})
test('来源停用、反馈撤销和其他库均不能借旧向量继续匹配',async t=>{
 const f=fixture(t);await f.warm();const other=f.store.create('Other library');f.store.bind('other-owner',other.id,0)
 assert.equal((await f.d.match(other.id,f.embedding.cached,Float32Array.from([1,0,0]),[f.old])).events.length,0)
 f.store.db.prepare('INSERT INTO cm_legacy_notes VALUES(?,?,?,0)').run(f.lib.id,'inactive-ref',f.next)
 const r=await f.match();assert.deepEqual(r.events,[]);assert.equal(f.d.status(f.lib.id,f.embedding.cached).total_cues,0)
})
test('模型标识变化后旧纠正向量不冒用，可独立增量补齐',async t=>{
 const f=fixture(t);await f.warm();f.setKey('new-synthetic-model');const p=await f.match();assert.equal(p.status,'index-incomplete');await f.warm();assert.equal((await f.match()).events.length,1)
})
test('默认关闭时不多调用embedding，取消不持久暂停',async t=>{
 const f=fixture(t,{enabled:false});const before=f.calls();await f.d.warm(f.embedding,f.lib.id,'owner','key');assert.equal(f.calls(),before);assert.equal((await f.match()).status,'disabled')
 f.d.enabled=true;await f.warm();const controller=new AbortController();controller.abort();await assert.rejects(f.d.match(f.lib.id,f.embedding.cached,Float32Array.from([1,0,0]),[f.old],controller.signal));assert.equal(f.d.health(f.lib.id).paused,false)
})
test('补建期间引用变化或反馈撤销不提交迟到向量',async t=>{
 const f=fixture(t);f.embedding.embed=async inputs=>{f.d.retract(f.lib.id,'owner',{feedback_id:f.feedback.id,refs:[f.raw('撤销')],reason:'晚到前撤销'});return inputs.map(()=>Float32Array.from([1,0,0]))}
 const r=await f.d.warm(f.embedding,f.lib.id,'owner','synthetic-cue-model');assert.equal(r.indexed,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_feedback_cue_vectors').get().n,0)
})
test('被纠正旧卡退出后，工作记忆带入修正出处且保持预算',async t=>{
 const f=fixture(t);await f.warm()
 const result=await f.working.prepare({library:f.lib.id,session:'owner',query:'导航的颜色现在如何',userSeq:100,turnSeq:100})
 assert.equal(result.reason,'ready');const view=f.working.view(f.lib.id,'owner');assert.ok(!view.cards.some(c=>c.id===f.store.shortId(f.lib.id,f.old)));assert.equal(view.corrections[0].id,f.store.shortId(f.lib.id,f.next));assert.match(view.corrections[0].summary,/青色/)
 const text=f.context.render(f.lib.id,'owner');assert.ok(Array.from(text).length<=1800);assert.match(text,/青色/);assert.doesNotMatch(text,/原先是蓝色/)
 const count=f.store.db.prepare('SELECT count(*) n FROM cm_memory_feedback').get().n;f.working.view(f.lib.id,'owner');assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_memory_feedback').get().n,count)
})
test('显式删除源清理纠正向量，不能用过期匹配复活',async t=>{
 const f=fixture(t);await f.warm();f.store.removeRecord(f.lib.id,'owner',f.old);assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_feedback_cue_vectors').get().n,0);assert.equal((await f.match()).events.length,0)
})

test('工作记忆提供本轮真实工具返回的短出处，不把旧轮结果冒充当前动作',async t=>{
 const f=fixture(t);f.store.markRestored('owner');await f.working.prepare({library:f.lib.id,session:'owner',query:'你好',userSeq:100,turnSeq:100})
 const append=(seq,text)=>f.store.append(f.lib.id,{session:'owner',seq,time:new Date().toISOString(),role:'tool',type:'tool/result',text})
 const old=append(99,'旧轮返回');let text=f.context.render(f.lib.id,'owner');assert.doesNotMatch(text,/current_tool_source/)
 const current=append(101,'当前实际工具返回');text=f.context.render(f.lib.id,'owner');const payload=JSON.parse(text.slice(text.indexOf('\n')+1))
 assert.equal(payload.current_tool_source.id,f.store.shortId(f.lib.id,current));assert.match(payload.current_tool_source.scope,/不代表任务完成/);assert.ok(Array.from(text).length<=800)
 f.store.db.prepare('INSERT INTO cm_legacy_notes VALUES(?,?,?,0)').run(f.lib.id,'tool-source',current);assert.doesNotMatch(f.context.render(f.lib.id,'owner'),/current_tool_source/);assert.ok(f.store.record(f.lib.id,old))
})
