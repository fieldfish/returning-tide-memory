import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Extraction} from '../lib/extraction.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {Consolidation} from '../lib/consolidation.mjs'

function fixture(t,config={}){
  const directory=mkdtempSync(join(tmpdir(),'cm-consolidate-test-'));let now=Date.parse('2026-10-29T08:00:00Z'),seq=0,calls=0,answer=()=>({updates:[]})
  const store=new ContinuityStore(directory,{now:()=>now}),lib=store.create('合成情境整理');store.bind('owner',lib.id,0)
  const extraction=new Extraction(store,{now:()=>now,dshCall:async args=>{calls++;const value=await answer(JSON.parse(args.input),args);return {text:typeof value==='string'?value:JSON.stringify(value),usage:{inputTokens:20,outputTokens:10}}}})
  extraction.configure(lib.id,'owner',{source:'dsh',provider:'test',model:'test',situationsEnabled:true,maxCallsPerDay:100,maxInputChars:4000,minIntervalMs:0,...config})
  const situations=new Situations(store,new Scenes(store)),c=new Consolidation(store,situations,extraction)
  const append=(text,extra={})=>store.append(lib.id,{session:'owner',seq:++seq,time:new Date(now).toISOString(),role:'user',text,...extra})
  const run=()=>c.run(lib.id,'owner'),resume=()=>c.resume(lib.id,'owner')
  t.after(async()=>{await c.stop();await extraction.stop();store.close();const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('cm-consolidate-test-'));rmSync(path,{recursive:true,force:true})})
  return {directory,store,lib,extraction,situations,c,append,run,resume,calls:()=>calls,setAnswer:fn=>{answer=fn},advance:n=>{now+=n}}
}
const update=(r,body='表达想制作网页')=>({title:'网页任务',mode:'experience',refs:[r.id],assertions:[{slot:'goal',body,refs:[r.id]}]})

test('更新旧情境可从逐条有效引用派生顶层出处，不要求重复同一refs字段',async t=>{
 const f=fixture(t),old=f.append('旧任务资料'),s=f.situations.create(f.lib.id,'owner',{title:'原任务',refs:[old]})
 f.setAnswer(({records})=>({updates:[{id:s.id,expected_revision:1,assertions:[{slot:'progress',body:'补充原话',refs:[records[0].id]},{slot:'goal',body:'同一出处支撑另一个表述',refs:[records[0].id]}]}]}));f.resume()
 const result=await f.run();assert.deepEqual(result.situations,[s.id]);assert.equal(f.situations.get(f.lib.id,s.id).revision,2)
})
test('派生更新出处仍拒绝无来源或批次外引用',async t=>{
 const f=fixture(t),old=f.append('旧任务资料'),s=f.situations.create(f.lib.id,'owner',{title:'原任务',refs:[old]});f.resume();await f.run();f.append('新资料')
 f.setAnswer(()=>({updates:[{id:s.id,expected_revision:1,assertions:[{slot:'progress',body:'不合法新陈述',refs:[old]}]}]}))
 await assert.rejects(f.run(),{code:'INVALID_EVIDENCE'});assert.equal(f.situations.get(f.lib.id,s.id).revision,1)
})

test('纯管理汇报保留原文且无模型调用推进情境游标',async t=>{
 const f=fixture(t),id=f.append('cm_self accept已经完成，这只是管理汇报。',{role:'assistant'});f.setAnswer(()=>{throw Error('not callable')});f.resume()
 const r=await f.run();assert.equal(f.calls(),0);assert.equal(r.excluded_reports,1);assert.equal(r.usage_id,null);assert.equal(f.c.status(f.lib.id).has_pending,false);assert.match(f.store.record(f.lib.id,id).text,/管理汇报/)
})
test('混合批次不把被禁止的管理汇报再交给模型当来源',async t=>{
 const f=fixture(t),id=f.append('想制作网页');f.append('cm_self propose已经记录，请核对。',{role:'assistant'});f.setAnswer(({records})=>{assert.deepEqual(records.map(r=>r.id),[id]);return {updates:[update(records[0])]}});f.resume()
 const r=await f.run();assert.equal(r.situations.length,1);assert.equal(r.excluded_reports,1);assert.equal(f.c.status(f.lib.id).has_pending,false)
})

test('模型使用唯一短原文ID时严格归一化为本批来源，不误拒合法引用',async t=>{
 const f=fixture(t),rid=f.append('想做一个网页');f.setAnswer(({records})=>({updates:[update({...records[0],id:records[0].id.slice(0,10)})]}));f.resume()
 const result=await f.run();assert.equal(result.situations.length,1);assert.ok(f.situations.get(f.lib.id,result.situations[0]).refs.includes(rid))
})
test('唯一短ID仍不能把不在本批的旧来源偷带入整理结果',async t=>{
 const f=fixture(t),old=f.append('旧记录');f.resume();await f.run();const cursor=f.c.state(f.lib.id).cursor
 f.append('新记录正文中提到旧ID '+old);f.setAnswer(()=>({updates:[update({id:old.slice(0,10)})]}))
 await assert.rejects(f.run(),{code:'INVALID_EVIDENCE'});assert.equal(f.c.state(f.lib.id).cursor,cursor);assert.equal(f.situations.list(f.lib.id).total,0)
})

test('后台整理默认暂停且需显式启用，不因加载或status调用模型',async t=>{
  const f=fixture(t,{situationsEnabled:false});f.append('一条经历');assert.equal(f.c.status(f.lib.id).enabled,false)
  await f.run();assert.equal(f.calls(),0);assert.throws(f.resume,{code:'NOT_CONFIGURED'});assert.equal(f.store.library(f.lib.id).error,null)
})
test('只增量处理新原文，追加情境版本，不写人格或自我认识，不自动改变焦点',async t=>{
  const f=fixture(t);f.append('我想制作网页，还没做');f.setAnswer(({records,known})=>{assert.equal(known.length,0);return {updates:[update(records[0])]}})
  f.resume();await f.run();let docs=f.situations.list(f.lib.id).items;assert.equal(docs.length,1);const id=docs[0].id
  assert.equal(f.situations.get(f.lib.id,id).assertions[0].origin,'model-consolidated');assert.equal(f.situations.current(f.lib.id,'owner'),null);assert.equal(f.store.current(f.lib.id).length,0)
  const next=f.append('网页只做完了导航');f.setAnswer(({records,known})=>{assert.deepEqual(records.map(r=>r.id),[next]);assert.equal(known[0].revision,1);return {updates:[{id,expected_revision:1,refs:[next],assertions:[{slot:'progress',body:'自述只做完导航',refs:[next]}]}]}})
  await f.run();assert.equal(f.situations.get(f.lib.id,id).revision,2);assert.equal(f.situations.get(f.lib.id,id,{revision:1}).assertions.length,1)
  await f.run();assert.equal(f.calls(),2);assert.equal(f.c.status(f.lib.id).completed_parts,2)
})
test('无效引用整批回滚，包括前面已经通过的情境和整理游标',async t=>{
  const f=fixture(t);f.append('原文');f.setAnswer(({records})=>({updates:[update(records[0]),{title:'无证据',refs:['bad'],assertions:[]}]}));f.resume()
  await assert.rejects(f.run(),{code:'INVALID_EVIDENCE'});assert.equal(f.situations.list(f.lib.id).total,0);assert.equal(f.c.status(f.lib.id).cursor,0);assert.equal(f.c.status(f.lib.id).completed_parts,0)
  await f.run();assert.equal(f.calls(),1);assert.equal(f.store.library(f.lib.id).error,null);assert.equal(f.store.report(f.lib.id).usage[0].status,'failed')
})
test('旧来源即使真实存在也不能冒充本批新证据',async t=>{
  const f=fixture(t),old=f.append('旧事');f.resume();await f.run();f.append('新的事情')
  f.setAnswer(()=>({updates:[{title:'重放旧事',refs:[old],assertions:[]}]}));await assert.rejects(f.run(),{code:'INVALID_EVIDENCE'});assert.equal(f.c.status(f.lib.id).completed_parts,1)
})
test('源记录在模型调用期间删除时，不留下派生摘要或推进游标',async t=>{
  const f=fixture(t),id=f.append('后来要求删除');f.setAnswer(({records})=>{f.store.removeRecord(f.lib.id,'owner',id);return {updates:[update(records[0])]}});f.resume()
  await assert.rejects(f.run(),{code:'NOT_FOUND'});assert.equal(f.situations.list(f.lib.id).total,0);assert.equal(f.c.status(f.lib.id).cursor,0)
})
test('整理期间显式修改情境造成CAS冲突，保留人工版本而不覆盖',async t=>{
  const f=fixture(t),ref=f.append('计划'),s=f.situations.create(f.lib.id,'owner',{title:'已有任务',refs:[ref]})
  f.setAnswer(({records})=>{f.situations.revise(f.lib.id,'owner',s.id,{expected_revision:1,refs:[ref],reason:'主会话更新',status:'paused'});return {updates:[{id:s.id,expected_revision:1,refs:[records[0].id],assertions:[]}]}});f.resume()
  await assert.rejects(f.run(),{code:'CONFLICT'});assert.equal(f.situations.get(f.lib.id,s.id).revision,2);assert.equal(f.situations.get(f.lib.id,s.id).status,'paused');assert.equal(f.c.status(f.lib.id).cursor,0)
})
test('情境整理与认识提炼共享日预算，达到上限停止且不锁主库',async t=>{
  const f=fixture(t,{maxCallsPerDay:1});f.append('第一条');f.resume();await f.run();f.append('第二条');f.extraction.resume(f.lib.id,'owner')
  await assert.rejects(f.extraction.run(f.lib.id,'owner'),{code:'DAILY_LIMIT'});assert.equal(f.calls(),1);assert.equal(f.store.library(f.lib.id).error,null)
  await assert.rejects(f.run(),{code:'DAILY_LIMIT'});await f.run();assert.equal(f.calls(),1)
})
test('暂停中的迟到模型结果不提交，恢复需明确resume',async t=>{
  const f=fixture(t);f.append('待处理');f.setAnswer(({records})=>{f.c.pause(f.lib.id);return {updates:[update(records[0])]}});f.resume()
  await assert.rejects(f.run(),{code:'CANCELLED'});assert.equal(f.situations.list(f.lib.id).total,0);assert.equal(f.c.status(f.lib.id).cursor,0);assert.equal(f.store.library(f.lib.id).error,null)
})
test('整理时持有单库活动权，不允许并发整理、主调用或交接',async t=>{
  const f=fixture(t);f.append('经历');let finish,started;const ready=new Promise(r=>{started=r})
  f.setAnswer(()=>new Promise(r=>{finish=r;started()}));f.resume();const job=f.run();await ready
  assert.throws(f.run,{code:'BUSY'});assert.throws(()=>f.store.begin(f.lib.id,'owner','main'),{code:'BUSY'});assert.throws(()=>f.store.transfer(f.lib.id,'owner','next',1),{code:'BUSY'})
  finish({updates:[]});await job;assert.equal(f.store.busy(f.lib.id),null)
})
test('后台管理汇报不被提炼为新经历',async t=>{
  const f=fixture(t),excluded=f.append('cm_situation 更新完成 expected_revision=1',{role:'assistant'});f.append('这是可整理的新经历');f.setAnswer(()=>({updates:[update({id:excluded})]}));f.resume()
  await assert.rejects(f.run(),{code:'INVALID_EVIDENCE'});assert.equal(f.situations.list(f.lib.id).total,0)
})
test('异常中断重启只暂停情境整理，保留原文且不自动付费重试',async t=>{
  const f=fixture(t);f.append('重启前原文');f.resume();f.extraction.resume(f.lib.id,'owner')
  f.store.db.prepare('INSERT INTO cm_consolidation_runs VALUES(?,?,?,?,?,?,NULL,?,?,?,NULL)').run('unfinished',f.lib.id,'batch','owner','running','digest','[]',null,Date.now())
  f.store.begin(f.lib.id,'owner','consolidate');f.store.close()
  const reopened=new ContinuityStore(f.directory),x=new Extraction(reopened),c=new Consolidation(reopened,new Situations(reopened,new Scenes(reopened)),x)
  try{assert.equal(c.status(f.lib.id).error,'PREVIOUS_CONSOLIDATION_INTERRUPTED');assert.equal(x.status(f.lib.id).paused,false);assert.equal(reopened.library(f.lib.id).error,null);assert.equal(reopened.report(f.lib.id).records,1);await c.run(f.lib.id,'owner');assert.equal(reopened.report(f.lib.id).usage.length,0)}finally{await c.stop();reopened.close()}
})
test('超长原文按Unicode片段整理，覆盖尾部且每批受输入预算约束',async t=>{
  const f=fixture(t,{maxInputChars:2400,maxCallsPerDay:200}),original='海🐟"\\\n'.repeat(1200)+'尾部还没做完',chars=Array.from(original),seen=new Set();f.append(original)
  f.setAnswer(({records},args)=>{assert.ok(args.system.length+args.input.length<=2400);for(const r of records){assert.equal(r.text,chars.slice(...r.range).join(''));for(let i=r.range[0];i<r.range[1];i++)seen.add(i)}return {updates:[]}});f.resume()
  for(let i=0;i<200&&f.c.dueIn(f.lib.id)!==null;i++)await f.run()
  assert.equal(f.c.dueIn(f.lib.id),null);assert.equal(seen.size,chars.length);assert.equal(f.c.status(f.lib.id).progress,null);assert.equal(f.store.recent(f.lib.id)[0].text,original)
})

test('长原文整理到一半正常重启，持久片段续读且不重放已提交批次',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'cm-consolidate-restart-')),original='重启🐟"\\\n'.repeat(180)+'最后一段仍保留',chars=Array.from(original),seen=new Set(),ranges=new Set()
  let store,extraction,c,calls=0,firstAfterRestart=false
  const open=()=>{
    store=new ContinuityStore(directory)
    extraction=new Extraction(store,{dshCall:async args=>{
      calls++;const input=JSON.parse(args.input)
      assert.ok(args.system.length+args.input.length<=2400)
      if(firstAfterRestart){assert.ok(input.records[0].range[0]>0);firstAfterRestart=false}
      for(const r of input.records){
        const key=JSON.stringify([r.id,r.range]);assert.equal(ranges.has(key),false);ranges.add(key)
        assert.equal(r.text,chars.slice(...r.range).join(''))
        for(let i=r.range[0];i<r.range[1];i++)seen.add(i)
      }
      return {text:'{"updates":[]}',usage:{inputTokens:20,outputTokens:5}}
    }})
    c=new Consolidation(store,new Situations(store,new Scenes(store)),extraction)
  }
  t.after(async()=>{
    await c?.stop();await extraction?.stop();store?.close()
    const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('cm-consolidate-restart-'));rmSync(path,{recursive:true,force:true})
  })
  open();const lib=store.create('合成分片重启');store.bind('owner',lib.id,0)
  extraction.configure(lib.id,'owner',{source:'dsh',provider:'test',model:'test',situationsEnabled:true,maxCallsPerDay:200,maxInputChars:2400,minIntervalMs:0})
  store.append(lib.id,{session:'owner',seq:1,time:new Date().toISOString(),role:'user',text:original})
  c.resume(lib.id,'owner');await c.run(lib.id,'owner')
  const checkpoint=c.status(lib.id).progress;assert.ok(checkpoint.offset>64);assert.ok(checkpoint.offset<chars.length)
  await c.stop();await extraction.stop();store.close();open();firstAfterRestart=true
  assert.deepEqual(c.status(lib.id).progress,checkpoint);assert.equal(c.status(lib.id).paused,false);assert.equal(calls,1)
  for(let i=0;i<200&&c.dueIn(lib.id)!==null;i++)await c.run(lib.id,'owner')
  assert.equal(c.dueIn(lib.id),null);assert.equal(seen.size,chars.length);assert.equal(c.status(lib.id).progress,null)
  assert.equal(store.recent(lib.id)[0].text,original);assert.equal(c.status(lib.id).completed_parts,ranges.size)
})
