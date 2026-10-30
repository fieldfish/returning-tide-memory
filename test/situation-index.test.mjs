import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep,basename} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {SituationIndex} from '../lib/situation-index.mjs'
import {Embedding} from '../lib/embedding.mjs'

const chars=value=>Array.from(JSON.stringify(value)).length
const cancelled=()=>Object.assign(new Error('Synthetic embedding cancelled'),{code:'CANCELLED'})
const checkSignal=signal=>{if(signal?.aborted)throw cancelled()}
const vector=text=>/海螺|潮声|海边/.test(text)?[1,0,0,0]:/森林|松针/.test(text)?[0,1,0,0]:/珊瑚|暖杏/.test(text)?[0,0,1,0]:[0,0,0,1]

// Implements the real embedding facade's exclusive queue without starting a model.
class SyntheticEmbedding {
  constructor(){this.key='synthetic-model-v1';this.cached=null;this.model='synthetic-local-only';this.tail=Promise.resolve();this.busy=false;this.calls=[];this.identities=0;this.hook=null;this.failCode=null}
  async exclusive(signal,run){
    const before=this.tail;let release,onAbort,acquired=false
    this.tail=new Promise(resolve=>{release=resolve})
    try{
      checkSignal(signal)
      if(signal)await new Promise((resolve,reject)=>{onAbort=()=>reject(cancelled());signal.addEventListener('abort',onAbort,{once:true});before.then(resolve,reject)})
      else await before
      checkSignal(signal);acquired=true;this.busy=true
      return await run()
    }finally{if(onAbort)signal.removeEventListener('abort',onAbort);if(acquired){this.busy=false;release()}else before.then(release,release)}
  }
  async identity(signal){checkSignal(signal);this.identities++;this.cached=this.key;return this.key}
  async embed(inputs,query=false,signal=null){
    checkSignal(signal);this.calls.push({inputs:[...inputs],query})
    await this.hook?.({inputs,query,signal})
    checkSignal(signal)
    if(this.failCode)throw Object.assign(new Error('Synthetic model unavailable'),{code:this.failCode})
    return inputs.map(vector)
  }
}

function fixture(t,config={enabled:true}){
  const dir=mkdtempSync(join(tmpdir(),'continuity-situation-index-test-'))
  let now=Date.parse('2026-10-29T08:00:00Z'),seq=0
  const f={dir,embedding:new SyntheticEmbedding()}
  const open=()=>{
    f.store=new ContinuityStore(dir,{now:()=>now})
    f.situations=new Situations(f.store,new Scenes(f.store))
    f.index=new SituationIndex(f.store,f.situations,f.embedding,config)
  }
  open();f.lib=f.store.create('合成情境索引');f.store.bind('owner',f.lib.id,0)
  f.append=(text,{library=f.lib.id,session='owner',...extra}={})=>f.store.append(library,{session,seq:++seq,time:new Date(now++).toISOString(),role:'assistant',text,...extra})
  f.make=(title='海螺收藏计划',{library=f.lib.id,session='owner',refs=null,assertions=[],mode='experience'}={})=>f.situations.create(library,session,{title,refs:refs??[f.append(title,{library,session})],assertions,mode})
  f.reopen=()=>{f.store.close();open()}
  t.after(()=>{
    f.store.close()
    const target=resolve(dir),base=resolve(tmpdir())
    assert.ok(target.startsWith(base+sep)&&basename(target).startsWith('continuity-situation-index-test-'))
    rmSync(target,{recursive:true,force:true})
  })
  return f
}

async function drain(f,library=f.lib.id,session='owner'){
  for(let i=0;i<100;i++){
    await f.index.warm(library,session)
    if(!f.index.status(library).index_work_remaining)return
  }
  assert.fail('Synthetic situation index did not finish within 100 bounded batches')
}
const has=(result,situation)=>result.results.some(r=>r.id===situation.id)
function gateNextDocument(embedding){
  let enter,release;const entered=new Promise(r=>{enter=r}),gate=new Promise(r=>{release=r})
  embedding.hook=async({query})=>{if(!query){embedding.hook=null;enter();await gate}}
  return {entered,release}
}
function sourceSnapshot(f){
  return Object.fromEntries(['records','cm_situations','cm_situation_versions','cm_situation_sources','cm_situation_relations','cm_situation_focus'].map(table=>[table,f.store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))
}

test('情境索引默认关闭，不验证模型也不调用向量服务',async t=>{
  const f=fixture(t,{});f.make()
  assert.equal(f.index.enabled,false)
  await f.index.warm(f.lib.id,'owner')
  const result=await f.index.lookup(f.lib.id,'owner','海螺计划')
  assert.deepEqual(result.results,[])
  assert.equal(f.index.status(f.lib.id).enabled,false)
  assert.equal(f.embedding.identities,0);assert.equal(f.embedding.calls.length,0)
})

test('默认查询只读取已建投影，不在查询中补建或误报完整覆盖',async t=>{
  const f=fixture(t),s=f.make()
  const before=sourceSnapshot(f),result=await f.index.lookup(f.lib.id,'owner','海螺收藏计划')
  assert.deepEqual(result.results,[]);assert.equal(result.incomplete,true)
  assert.equal(f.index.status(f.lib.id).indexed_situations,0)
  assert.equal(f.embedding.calls.filter(c=>!c.query).length,0)
  assert.deepEqual(sourceSnapshot(f),before)
  await drain(f)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收藏计划'),s),true)
})

test('每批最多八个情境，超过最近八项的旧情境仍可检出',async t=>{
  const f=fixture(t),old=f.make('海螺收藏的旧计划')
  for(let i=0;i<19;i++)f.make('森林散步的新计划 '+i)
  const first=await f.index.warm(f.lib.id,'owner')
  assert.ok(first.indexed>0&&first.indexed<=8)
  assert.equal(f.index.status(f.lib.id).index_work_remaining,true)
  await drain(f)
  assert.equal(f.index.status(f.lib.id).indexed_situations,20)
  for(const call of f.embedding.calls.filter(c=>!c.query))assert.ok(call.inputs.length<=8)
  const result=await f.index.lookup(f.lib.id,'owner','海螺收藏计划')
  assert.equal(has(result,old),true);assert.equal(result.incomplete,false)
})

test('版本改变后旧向量立即失效，补建后返回最新版本',async t=>{
  const f=fixture(t),s=f.make('海螺收集旧方案');await drain(f)
  const ref=f.append('珊瑚配色改为暖杏')
  f.situations.revise(f.lib.id,'owner',s.id,{expected_revision:1,title:'珊瑚暖杏新方案',refs:[ref],reason:'合成修订'})
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收集旧方案'),s),false)
  assert.equal(f.index.status(f.lib.id).index_work_remaining,true)
  await drain(f)
  const result=await f.index.lookup(f.lib.id,'owner','珊瑚暖杏新方案'),card=result.results.find(r=>r.id===s.id)
  assert.ok(card);assert.equal(card.revision,2);assert.match(card.title,/珊瑚/)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收集旧方案'),s),false)
})

test('删除标题或表述出处、停用旧笔记后，不等待补建便剔除旧投影',async t=>{
  const f=fixture(t),titleRef=f.append('海螺标题出处'),assertionTitle=f.append('海螺另一个标题'),assertionRef=f.append('海螺表述出处'),legacyRef=f.append('海螺旧笔记')
  f.store.db.exec('CREATE TABLE cm_legacy_notes(library TEXT NOT NULL,legacy_id TEXT NOT NULL,rid TEXT,active INTEGER NOT NULL,PRIMARY KEY(library,legacy_id))')
  f.store.db.prepare('INSERT INTO cm_legacy_notes VALUES(?,?,?,1)').run(f.lib.id,'synthetic-legacy',legacyRef)
  const a=f.make('海螺标题删除',{refs:[titleRef]}),b=f.make('海螺表述删除',{refs:[assertionTitle],assertions:[{slot:'goal',body:'海螺表述出处',refs:[assertionRef]}]}),c=f.make('海螺旧笔记停用',{refs:[legacyRef]})
  await drain(f)
  assert.equal((await f.index.lookup(f.lib.id,'owner','海螺',5)).results.length,3)
  f.store.removeRecord(f.lib.id,'owner',titleRef)
  f.store.removeRecord(f.lib.id,'owner',assertionRef)
  f.store.db.prepare('UPDATE cm_legacy_notes SET active=0 WHERE rid=?').run(legacyRef)
  const result=await f.index.lookup(f.lib.id,'owner','海螺',5)
  for(const s of [a,b,c])assert.equal(has(result,s),false)
})

test('建向量等待期间来源删除或情境修订，不提交过期投影',async t=>{
  const f=fixture(t),ref=f.append('海螺待删除出处'),deleted=f.make('海螺待删除情境',{refs:[ref]})
  let gate=gateNextDocument(f.embedding),job=f.index.warm(f.lib.id,'owner');await gate.entered
  try{f.store.removeRecord(f.lib.id,'owner',ref)}finally{gate.release()}
  await job
  assert.equal(f.index.status(f.lib.id).indexed_situations,0)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺'),deleted),false)
  const changed=f.make('海螺修订前'),newRef=f.append('珊瑚暖杏修订后')
  gate=gateNextDocument(f.embedding);job=f.index.warm(f.lib.id,'owner');await gate.entered
  try{f.situations.revise(f.lib.id,'owner',changed.id,{expected_revision:1,title:'珊瑚暖杏修订后',refs:[newRef],reason:'等待期间更新'})}finally{gate.release()}
  await job
  assert.equal(f.index.status(f.lib.id).indexed_situations,0)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺修订前'),changed),false)
  await drain(f)
  assert.equal((await f.index.lookup(f.lib.id,'owner','珊瑚暖杏修订后')).results.find(r=>r.id===changed.id)?.revision,2)
})

test('排队取消和请求取消保留CANCELLED，队列恢复且不暂停主会话',async t=>{
  const f=fixture(t);f.make()
  const gate=gateNextDocument(f.embedding),warming=f.index.warm(f.lib.id,'owner');await gate.entered
  const controller=new AbortController(),queued=f.index.lookup(f.lib.id,'owner','海螺',3,controller.signal)
  controller.abort()
  try{await assert.rejects(queued,{code:'CANCELLED'})}finally{gate.release();await warming}
  let enter,release;const entered=new Promise(r=>{enter=r}),wait=new Promise(r=>{release=r})
  f.embedding.hook=async({query})=>{if(query){f.embedding.hook=null;enter();await wait}}
  const inFlightController=new AbortController(),querying=f.index.lookup(f.lib.id,'owner','海螺',3,inFlightController.signal)
  await entered;inFlightController.abort();release()
  await assert.rejects(querying,{code:'CANCELLED'})
  assert.equal(f.index.health(f.lib.id).paused,false);assert.equal(f.store.library(f.lib.id).error,null)
  assert.ok(f.append('取消检索后仍可继续聊天'))
  assert.equal((await f.index.lookup(f.lib.id,'owner','海螺')).results.length,1)
})

test('模型故障明确失败且只暂停情境索引，不以关键词冒充检索成功',async t=>{
  const f=fixture(t);f.make();await drain(f)
  f.embedding.failCode='EMBEDDING_UNAVAILABLE'
  await assert.rejects(f.index.lookup(f.lib.id,'owner','海螺收藏计划'),{code:'EMBEDDING_UNAVAILABLE'})
  assert.equal(f.index.health(f.lib.id).paused,true)
  assert.equal(f.index.health(f.lib.id).error,'EMBEDDING_UNAVAILABLE')
  assert.equal(f.store.library(f.lib.id).error,null);assert.ok(f.append('模型故障后正常聊天'))
  const calls=f.embedding.calls.length
  assert.deepEqual(await f.index.warm(f.lib.id,'owner'),{skipped:'feature-paused'})
  assert.equal(f.embedding.calls.length,calls)
  f.embedding.failCode=null;f.index.resume(f.lib.id,'owner')
  assert.equal(f.index.health(f.lib.id).paused,false)
  assert.equal((await f.index.lookup(f.lib.id,'owner','海螺收藏计划')).results.length,1)
})

test('同一服务的库互相隔离，补建和恢复必须持有本库运行权',async t=>{
  const f=fixture(t),a=f.make(),other=f.store.create('另一合成库');f.store.bind('other-owner',other.id,0)
  const b=f.make('海螺另库专属',{library:other.id,session:'other-owner'})
  const calls=f.embedding.calls.length
  await assert.rejects(f.index.warm(f.lib.id,'other-owner'),{code:'NOT_OWNER'})
  assert.throws(()=>f.index.resume(f.lib.id,'other-owner'),{code:'NOT_OWNER'})
  assert.equal(f.embedding.calls.length,calls)
  await drain(f);await drain(f,other.id,'other-owner')
  const left=await f.index.lookup(f.lib.id,'read-only-reader','海螺'),right=await f.index.lookup(other.id,'other-owner','海螺')
  assert.equal(has(left,a),true);assert.equal(has(left,b),false)
  assert.equal(has(right,b),true);assert.equal(has(right,a),false)
  assert.throws(()=>f.situations.get(other.id,a.id),{code:'NOT_FOUND'})
})

test('当前回合及之后的任一出处都会排除整个投影，包括卡片未展示的出处',async t=>{
  const f=fixture(t),oldRef=f.append('海螺旧出处',{seq:1}),currentRef=f.append('海螺当前问题',{seq:10}),futureRef=f.append('海螺稍后答复',{seq:11})
  const old=f.make('海螺可靠旧情境',{refs:[oldRef]}),current=f.make('海螺当前情境',{refs:[currentRef]}),mixed=f.make('海螺混合出处情境',{refs:[oldRef],assertions:[{slot:'goal',body:'海螺新目标',refs:[futureRef]}]})
  await drain(f)
  assert.equal((await f.index.lookup(f.lib.id,'owner','海螺',5)).results.length,3)
  const result=await f.index.lookup(f.lib.id,'owner','海螺',5,null,{exclude:{session:'owner',fromSeq:10}})
  assert.equal(has(result,old),true);assert.equal(has(result,current),false);assert.equal(has(result,mixed),false)
})

test('短卡有预算和出处，缓存投影仅提供候选，不合并情境或修改原文',async t=>{
  const f=fixture(t)
  for(let i=0;i<3;i++){
    const refs=Array.from({length:8},(_,n)=>f.append('海螺长出处 '+i+' '+n))
    f.make('海螺'+('收藏计划和漫长标题🐟'.repeat(12)).slice(0,150),{refs,mode:i===0?'creative':'experience',assertions:refs.map(ref=>({slot:'interpretation',body:'海螺'+('这是后来的解释🐟'.repeat(80)),refs:[ref]}))})
  }
  const before=sourceSnapshot(f);await drain(f)
  const result=await f.index.lookup(f.lib.id,'owner','海螺收藏计划',3)
  assert.equal(result.results.length,3);assert.ok(chars(result)<=1200)
  for(const card of result.results){
    assert.deepEqual(Object.keys(card).sort(),['id','revision','title','score','summary','refs','mode','status','semantic'].sort())
    assert.ok(chars(card)<=250);assert.ok(card.refs.length>0)
    assert.ok(Number.isFinite(card.score));assert.ok(Number.isFinite(card.semantic))
    for(const ref of card.refs)assert.equal(f.store.record(f.lib.id,ref).library,f.lib.id)
    assert.equal(f.situations.get(f.lib.id,card.id).revision,card.revision)
  }
  assert.match(result.note,/候选|核验|核对/)
  await f.index.lookup(f.lib.id,'owner','海螺收藏计划',3)
  assert.deepEqual(sourceSnapshot(f),before)
})

test('模型身份改变后旧向量不能冒充新索引，明确待补建后才重获候选',async t=>{
  const f=fixture(t),s=f.make();await drain(f)
  assert.equal(f.index.status(f.lib.id).model_key,'synthetic-model-v1')
  f.embedding.key='synthetic-model-v2'
  const cold=await f.index.lookup(f.lib.id,'owner','海螺收藏计划')
  assert.equal(has(cold,s),false);assert.equal(cold.incomplete,true)
  const status=f.index.status(f.lib.id)
  assert.equal(status.model_key,'synthetic-model-v2');assert.equal(status.indexed_situations,0);assert.equal(status.pending_situations,1)
  await drain(f)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收藏计划'),s),true)
})

test('重启保留可替换的派生索引，模型身份核对后无需重新嵌入原情境',async t=>{
  const f=fixture(t),s=f.make();await drain(f)
  const before=sourceSnapshot(f),documents=f.embedding.calls.filter(c=>!c.query).length
  f.reopen()
  const result=await f.index.lookup(f.lib.id,'owner','海螺收藏计划')
  assert.equal(has(result,s),true);assert.equal(result.incomplete,false)
  assert.equal(f.index.status(f.lib.id).indexed_situations,1)
  assert.equal(f.embedding.calls.filter(c=>!c.query).length,documents)
  assert.deepEqual(sourceSnapshot(f),before)
})

test('建向量期间原文被直接修改且digest未变，仍丢弃等待中的旧投影',async t=>{
  const f=fixture(t),ref=f.append('海螺原始出处'),s=f.make('海螺收藏计划',{refs:[ref]})
  const originalDigest=f.store.record(f.lib.id,ref).digest,gate=gateNextDocument(f.embedding),warming=f.index.warm(f.lib.id,'owner')
  await gate.entered
  try{
    f.store.db.prepare('UPDATE records SET text=? WHERE library=? AND id=?').run('海螺出处在模型等待期间被修改',f.lib.id,ref)
    assert.equal(f.store.record(f.lib.id,ref).digest,originalDigest)
  }finally{gate.release()}
  await warming
  assert.equal(f.index.status(f.lib.id).indexed_situations,0)
  assert.equal(f.index.status(f.lib.id).index_work_remaining,true)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收藏计划'),s),false)
  await drain(f)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收藏计划'),s),true)
  assert.equal(f.index.health(f.lib.id).paused,false)
})

test('损坏向量明确报错，仅暂停情境索引且可在修复后恢复',async t=>{
  const f=fixture(t),s=f.make(),sourceEmbedding=new Embedding(f.store)
  try{
    await drain(f)
    const before=sourceSnapshot(f),row=f.store.db.prepare('SELECT dimensions,value FROM cm_situation_index WHERE library=? AND situation=?').get(f.lib.id,s.id),valid=Buffer.from(row.value),nan=Buffer.alloc(valid.length),nonUnit=Buffer.alloc(valid.length)
    nan.writeFloatLE(NaN,0);nonUnit.writeFloatLE(2,0)
    for(const [dimensions,value] of [[row.dimensions+1,valid],[row.dimensions,Buffer.alloc(4)],[row.dimensions,nan],[row.dimensions,nonUnit]]){
      f.store.db.prepare('UPDATE cm_situation_index SET dimensions=?,value=? WHERE library=? AND situation=?').run(dimensions,value,f.lib.id,s.id)
      await assert.rejects(f.index.lookup(f.lib.id,'owner','海螺收藏计划'),{code:'EMBEDDING_INVALID_VECTOR'})
      assert.equal(f.index.health(f.lib.id).paused,true)
      assert.equal(f.index.health(f.lib.id).error,'EMBEDDING_INVALID_VECTOR')
      assert.equal(sourceEmbedding.health(f.lib.id).paused,false)
      assert.equal(f.store.library(f.lib.id).error,null)
      f.index.resume(f.lib.id,'owner')
    }
    f.store.db.prepare('UPDATE cm_situation_index SET dimensions=?,value=? WHERE library=? AND situation=?').run(row.dimensions,valid,f.lib.id,s.id)
    assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收藏计划'),s),true)
    assert.deepEqual(sourceSnapshot(f),before)
    assert.ok(f.append('情境索引损坏期间，主会话仍可追加正常聊天'))
  }finally{sourceEmbedding.close()}
})

test('重启后旧版数组元数据明确待补建，升级后恢复完整覆盖和正常失效',async t=>{
  const f=fixture(t),ref=f.append('海螺旧版索引出处'),s=f.make('海螺收藏计划',{refs:[ref]});await drain(f)
  const source=f.store.record(f.lib.id,ref),oldState=[[ref,source.digest,1,source.session,source.seq]],before=sourceSnapshot(f)
  f.store.db.prepare('UPDATE cm_situation_index_state SET source_state=? WHERE library=? AND situation=?').run(JSON.stringify(oldState),f.lib.id,s.id)
  f.reopen()
  assert.equal(f.index.status(f.lib.id).indexed_situations,0)
  assert.equal(f.index.status(f.lib.id).pending_situations,1)
  assert.equal(f.index.status(f.lib.id).index_work_remaining,true)
  await drain(f)
  assert.equal(f.index.status(f.lib.id).pending_situations,0)
  assert.equal(f.index.status(f.lib.id).index_work_remaining,false)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收藏计划'),s),true)
  assert.deepEqual(sourceSnapshot(f),before)
  f.store.removeRecord(f.lib.id,'owner',ref)
  assert.equal(has(await f.index.lookup(f.lib.id,'owner','海螺收藏计划'),s),false)
  assert.equal(f.index.status(f.lib.id).indexed_situations,0)
})

test('所有出处均已删除的积压也按八项排空，不循环补建或复活原文',async t=>{
  const f=fixture(t)
  for(let i=0;i<19;i++){
    const ref=f.append('海螺已移除出处 '+i)
    f.make('海螺已移除情境 '+i,{refs:[ref]})
    f.store.removeRecord(f.lib.id,'owner',ref)
  }
  const first=await f.index.warm(f.lib.id,'owner')
  assert.ok(first.prepared>0&&first.prepared<=8);assert.equal(first.indexed,0)
  assert.equal(f.index.status(f.lib.id).index_work_remaining,true)
  await drain(f)
  const status=f.index.status(f.lib.id)
  assert.equal(status.total_situations,19);assert.equal(status.unindexable_situations,19)
  assert.equal(status.indexed_situations,0);assert.equal(status.pending_situations,0);assert.equal(status.index_work_remaining,false)
  assert.equal(f.embedding.calls.filter(call=>!call.query).length,0)
  const result=await f.index.lookup(f.lib.id,'owner','海螺收藏计划')
  assert.deepEqual(result.results,[]);assert.equal(result.incomplete,false)
  const idle=await f.index.warm(f.lib.id,'owner')
  assert.equal(idle.prepared,0);assert.equal(idle.indexed,0)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM records WHERE library=?').get(f.lib.id).n,0)
  assert.equal(f.index.health(f.lib.id).paused,false);assert.equal(f.store.library(f.lib.id).error,null)
})
