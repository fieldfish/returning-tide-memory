import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {SituationIndex} from '../lib/situation-index.mjs'
import {Extraction} from '../lib/extraction.mjs'
import {Consolidation} from '../lib/consolidation.mjs'
import {WorkingMemory} from '../lib/working-memory.mjs'
import {ContextFrame} from '../lib/context-frame.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'

function fixture(t,workingConfig={}){
  const dir=mkdtempSync(join(tmpdir(),'cm-situation-chain-')),store=new ContinuityStore(dir),lib=store.create('合成整条情境链');store.bind('owner',lib.id,0)
  let seq=0,modelCalls=0,answer=()=>({updates:[]}),failEmbed=false,raw={results:[],candidates:[]},rawFailures=0
  const embedding={model:'synthetic',cached:null,exclusive:async(signal,fn)=>{signal?.throwIfAborted();return fn()},identity:async()=>{embedding.cached='fixed';return 'fixed'},embed:async inputs=>{if(failEmbed)throw Object.assign(Error('Synthetic offline'),{code:'EMBEDDING_UNAVAILABLE'});return inputs.map(text=>text.includes('海螺')?[1,0,0]:text.includes('森林')?[0,1,0]:[0,0,1])},lookup:async()=>raw,health:()=>({paused:false,error:null}),markFailure:()=>{rawFailures++}}
  const scenes=new Scenes(store),situations=new Situations(store,scenes),index=new SituationIndex(store,situations,embedding,{enabled:true}),extraction=new Extraction(store,{dshCall:async args=>{modelCalls++;return {text:JSON.stringify(answer(JSON.parse(args.input))),usage:{inputTokens:20,outputTokens:10}}}})
  extraction.configure(lib.id,'owner',{source:'dsh',provider:'synthetic',model:'test',situationsEnabled:true,maxInputChars:5000,maxCallsPerDay:100,minIntervalMs:0})
  const c=new Consolidation(store,situations,extraction,index),working=new WorkingMemory(store,embedding,scenes,{enabled:true,timeoutMs:1000,...workingConfig},index),context=new ContextFrame(store,working,situations,new ExecutionLedger(store))
  const append=(text,extra={})=>store.append(lib.id,{session:'history',seq:++seq,time:new Date(Date.parse('2026-10-01T08:00:00Z')+seq*1000).toISOString(),role:'user',text,...extra})
  const make=title=>{const ref=append(title);return situations.create(lib.id,'owner',{title,refs:[ref],assertions:[{slot:'goal',body:title+'仍待继续',refs:[ref]}]})}
  const seedProcessed=()=>{c.resume(lib.id,'owner');store.db.prepare('UPDATE cm_consolidation SET cursor=(SELECT MAX(seq) FROM cm_ingest_log WHERE library=?) WHERE library=?').run(lib.id,lib.id)}
  const warm=async()=>{for(let i=0;i<20&&index.status(lib.id).index_work_remaining;i++)await index.warm(lib.id,'owner');assert.equal(index.status(lib.id).index_work_remaining,false)}
  const hit=id=>{raw={results:[{id:store.shortId(lib.id,id),title:'真实旧来源',score:.03,summary:'旧来源线索',time:'2026-10-01'}],candidates:[{id,semantic:.95,lexical:true}]}}
  t.after(async()=>{working.close();await c.stop();await extraction.stop();store.close();const path=resolve(dir);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('cm-situation-chain-'));rmSync(path,{recursive:true,force:true})})
  return {store,lib,scenes,situations,index,extraction,c,working,context,embedding,append,make,seedProcessed,warm,hit,calls:()=>modelCalls,answer:f=>{answer=f},failEmbedding:()=>{failEmbed=true},rawFailures:()=>rawFailures,prepare:q=>working.prepare({library:lib.id,session:'owner',query:q,userSeq:1000,turnSeq:1000})}
}

test('情境索引分批补齐后，整理能关联最近八条之外的任务；不自动合并或换焦点',async t=>{
  const f=fixture(t),old=f.make('海螺潮声采样作品');for(let i=0;i<18;i++)f.make('森林松针作品'+i)
  f.seedProcessed();const next=f.append('海螺潮声采样作品现在完成了片头，继续原作品')
  f.answer(({known,records})=>{
    assert.ok(known.some(d=>d.id===old.id&&d.basis==='semantic-candidate-not-identity-proof'))
    assert.deepEqual(records.map(r=>r.id),[next])
    return {updates:[{id:old.id,expected_revision:1,refs:[next],assertions:[{slot:'progress',body:'自述片头已完成',refs:[next]}]}]}
  })
  const first=await f.c.run(f.lib.id,'owner');assert.equal(first.skipped,'situation-index-pending');assert.equal(f.calls(),0)
  const second=await f.c.run(f.lib.id,'owner');assert.equal(second.skipped,'situation-index-pending');assert.equal(f.calls(),0)
  await f.c.run(f.lib.id,'owner');assert.equal(f.calls(),1);assert.equal(f.situations.get(f.lib.id,old.id).revision,2)
  assert.equal(f.situations.list(f.lib.id).total,19);assert.equal(f.situations.current(f.lib.id,'owner'),null);assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_situation_relations').get().n,0)
})
test('两个相似作品仅作为独立候选交给整理模型，不自动拼接成同一事件',async t=>{
  const f=fixture(t),a=f.make('海螺潮声第一件作品'),b=f.make('海螺潮声第二件作品');f.seedProcessed();await f.warm();const next=f.append('我想做一个新的海螺潮声作品，和旧项目分开')
  f.answer(({known})=>{assert.ok(known.some(d=>d.id===a.id));assert.ok(known.some(d=>d.id===b.id));return {updates:[{title:'第三个海螺作品',refs:[next],assertions:[]}]}})
  await f.c.run(f.lib.id,'owner');assert.equal(f.situations.list(f.lib.id).total,3);assert.equal(f.situations.get(f.lib.id,a.id).revision,1);assert.equal(f.situations.get(f.lib.id,b.id).revision,1)
})
test('情境检索故障暂停对应整理，保留新原文，不锁主库或暂停另一整理',async t=>{
  const f=fixture(t);f.make('海螺旧作品');f.seedProcessed();await f.warm();const id=f.append('继续海螺旧作品');f.extraction.resume(f.lib.id,'owner');f.failEmbedding()
  await assert.rejects(f.c.run(f.lib.id,'owner'),{code:'EMBEDDING_UNAVAILABLE'})
  assert.equal(f.calls(),0);assert.equal(f.c.status(f.lib.id).paused,true);assert.equal(f.extraction.status(f.lib.id).paused,false);assert.equal(f.store.library(f.lib.id).error,null);assert.ok(f.store.record(f.lib.id,id));assert.equal(f.rawFailures(),0)
})
test('原文未命中时仍能把情境候选入口放进统一工作记忆，改版后立即失效',async t=>{
  const f=fixture(t),s=f.make('海螺潮声采样任务');await f.warm();f.store.markRestored('owner')
  await f.prepare('还记得海螺潮声采样任务吗');assert.equal(f.working.view(f.lib.id,'owner').cards.length,0)
  const text=f.context.render(f.lib.id,'owner'),bundle=JSON.parse(text.slice(text.indexOf('\n')+1))
  assert.equal(bundle.recalled_situations.candidates[0].id,s.id);assert.ok(Array.from(text).length<=800)
  const refs=f.situations.get(f.lib.id,s.id).refs;f.situations.revise(f.lib.id,'owner',s.id,{expected_revision:1,status:'paused',refs,reason:'后来暂停'})
  assert.equal(f.working.view(f.lib.id,'owner').situations.length,0);assert.doesNotMatch(f.context.render(f.lib.id,'owner'),/海螺潮声采样任务/)
})
test('情境候选超时保留已经成功的原文召回，不把原文向量服务标成故障',async t=>{
  const f=fixture(t,{timeoutMs:100}),id=f.append('海螺旧任务');f.hit(id)
  f.index.lookup=()=>new Promise(()=>{})
  await f.prepare('海螺旧任务怎样了');const view=f.working.view(f.lib.id,'owner')
  assert.equal(view.cards.length,1);assert.equal(view.situation_recall.status,'unavailable');assert.equal(view.situation_recall.error,'SITUATION_RECALL_TIMEOUT');assert.equal(f.rawFailures(),0);assert.equal(f.store.library(f.lib.id).error,null)
})
test('被当前线索纠正的来源不会通过摘要候选绕回自动工作记忆',async t=>{
  const f=fixture(t),s=f.make('海螺配色任务');await f.warm()
  f.embedding.memoryDynamics={assess:()=>({auto_blocked:true})}
  await f.prepare('海螺配色任务怎样了');assert.equal(f.working.view(f.lib.id,'owner').situations.length,0)
  assert.equal((await f.index.lookup(f.lib.id,'owner','海螺配色任务')).results[0].id,s.id)
})
