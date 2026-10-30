import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Extraction} from '../lib/extraction.mjs'
import {Evidence} from '../lib/evidence.mjs'

function fixture(t,reply){
  const dir=mkdtempSync(join(tmpdir(),'continuity-next-test-')),store=new ContinuityStore(dir),lib=store.create('合成测试');store.bind('owner',lib.id,0)
  let calls=0
  const x=new Extraction(store,{dshCall:async args=>{calls++;return {text:JSON.stringify(reply(args)),usage:{inputTokens:20,outputTokens:10}}}})
  x.configure(lib.id,'owner',{source:'dsh',provider:'test',model:'test',minIntervalMs:0,evidenceEnabled:true})
  const evidence=new Evidence(store,{},x)
  const raw=(text,seq=1)=>store.append(lib.id,{session:'owner',seq,time:'2026-10-28T12:00:00Z',role:'user',type:'user/message',text})
  t.after(async()=>{await x.stop();await evidence.stop();store.close();rmSync(dir,{recursive:true,force:true})})
  return {store,lib,x,evidence,raw,calls:()=>calls}
}
test('自动整理沿用旧键并保留认可旧版；主会话认可后才切换当前偏好',async t=>{
  let rid
  const f=fixture(t,args=>{const input=JSON.parse(args.input);assert.equal(input.known[0].key,'palette');assert.equal(input.known[0].revision,1);return {items:[{key:'palette',kind:'preference',body:'试读后改用雾蓝，日间更清楚',reason:'本轮明确修订',refs:[rid],expected_revision:1}]}})
  rid=f.raw('试读后改用雾蓝，日间更清楚。')
  f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'以前喜欢暖杏',reason:'旧偏好',refs:[rid]},true)
  f.x.resume(f.lib.id,'owner');await f.x.run(f.lib.id,'owner')
  assert.equal(f.store.current(f.lib.id)[0].body,'以前喜欢暖杏')
  assert.equal(f.store.pending(f.lib.id)[0].revision,2)
  f.store.accept(f.lib.id,'owner','palette',2)
  assert.equal(f.store.current(f.lib.id)[0].body,'试读后改用雾蓝，日间更清楚')
  assert.deepEqual(f.store.history(f.lib.id,'palette').map(x=>x.revision),[2,1])
  assert.equal(f.store.pending(f.lib.id).length,0)
})
test('整理不能把偏好换成fact绕过认可；失败整批回滚并暂停',async t=>{
  let rid
  const f=fixture(t,()=>({items:[{key:'palette',kind:'fact',body:'偷偷覆盖',reason:'test',refs:[rid],expected_revision:1}]}));rid=f.raw('新的表达')
  f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'旧偏好',reason:'test',refs:[rid]},true)
  f.x.resume(f.lib.id,'owner');await assert.rejects(f.x.run(f.lib.id,'owner'),{code:'INVALID_MODEL_OUTPUT'})
  assert.equal(f.store.current(f.lib.id)[0].body,'旧偏好');assert.equal(f.x.status(f.lib.id).cursor,0)
})
test('证据核验逐字引用校验，伪造引文不输出结论且不自动再调用',async t=>{
  let rid
  const f=fixture(t,()=>({status:'supported',answer:'已发布',citations:[{id:rid,quote:'今天已经发布了'}]}));rid=f.raw('今天计划发布，还没有发布。')
  await assert.rejects(f.evidence.verify(f.lib.id,'owner','是否发布了',[rid]),{code:'INVALID_EVIDENCE'})
  await assert.rejects(f.evidence.verify(f.lib.id,'owner','是否发布了',[rid]),{code:'EVIDENCE_PAUSED'})
  assert.equal(f.calls(),1);assert.equal(f.store.report(f.lib.id).records,1)
})
test('当前轮问题不能充当自身证据，无原文时不调用核验模型',async t=>{
  const f=fixture(t,()=>{throw Error('must not call')});const rid=f.raw('我拿了木星摄影比赛冠军吗？',5)
  const r=await f.evidence.verify(f.lib.id,'owner','比赛冠军',[rid],null,{session:'owner',fromSeq:4})
  assert.equal(r.status,'insufficient');assert.deepEqual(r.citations,[]);assert.equal(f.calls(),0)
})

test('核验当前状态自动补新版本来源，旧引用单独支持时保守判未证实',async t=>{
 let old,newer,useNew=false
 const f=fixture(t,args=>{const input=JSON.parse(args.input);assert.equal(input.scope,'current-state');assert.ok(input.records.some(r=>r.id===newer));return {status:'supported',answer:useNew?'现在用青色':'现在仍用蓝色',citations:[{id:useNew?newer:old,quote:useNew?'现在改成青色':'以前用蓝色'}]}})
 old=f.raw('以前用蓝色。',1);newer=f.raw('现在改成青色。',2)
 f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'以前蓝色',reason:'旧原话',refs:[old]},true)
 f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'现在青色',reason:'新原话',refs:[newer],expectedRevision:1},true)
 const outdated=await f.evidence.verify(f.lib.id,'owner','现在用什么',[old],null,null,{scope:'current-state',state_keys:['palette']})
 assert.equal(outdated.status,'insufficient');assert.equal(outdated.guard,'no-current-state-citation');assert.equal(f.evidence.status(f.lib.id).paused,0)
 useNew=true;const latest=await f.evidence.verify(f.lib.id,'owner','现在用什么',[old],null,null,{scope:'current-state',state_keys:['palette']});assert.equal(latest.status,'supported');assert.equal(latest.guard,'passed')
 assert.equal(f.store.report(f.lib.id).records,2)
})

test('引用返回邻近原句与Unicode范围，避免只看到截短的证据',async t=>{
 let rid;const f=fixture(t,()=>({status:'contradicted',answer:'尚未完成',citations:[{id:rid,quote:'尚未完成蓝鲸视频'}]}))
 const original='记录🐟：昨天只是计划，尚未完成蓝鲸视频。后面再处理。';rid=f.raw(original)
 const result=await f.evidence.verify(f.lib.id,'owner','完成了吗',[rid]);assert.ok(result.citations[0].context.includes('只是计划'));assert.equal(Array.from(original).slice(...result.citations[0].range).join(''),'尚未完成蓝鲸视频')
})

test('取消证据模型调用不持久暂停，下次显式查询正常进行',async t=>{
 const control=new AbortController();let rid
 const f=fixture(t,()=>({status:'supported',answer:'有记录',citations:[{id:rid,quote:'已经保存合成文件'}]}));rid=f.raw('已经保存合成文件。')
 const normal=f.x.model.dshCall
 f.x.model.dshCall=args=>new Promise((_,reject)=>{args.signal.addEventListener('abort',()=>reject(args.signal.reason),{once:true});setImmediate(()=>control.abort())})
 await assert.rejects(f.evidence.verify(f.lib.id,'owner','保存了吗',[rid],control.signal),{code:'CANCELLED'});assert.equal(f.evidence.status(f.lib.id).paused,0)
 f.x.model.dshCall=normal;assert.equal((await f.evidence.verify(f.lib.id,'owner','保存了吗',[rid])).status,'supported')
})

test('短长ID指向同一原文同一引文时不能冒充两份证据',async t=>{
 let rid;const f=fixture(t,()=>({status:'supported',answer:'有记录',citations:[{id:rid,quote:'有一条原文'},{id:rid.slice(0,10),quote:'有一条原文'}]}));rid=f.raw('有一条原文。')
 await assert.rejects(f.evidence.verify(f.lib.id,'owner','有几份证据',[rid]),{code:'INVALID_EVIDENCE'})
})

test('不存在的状态键不调用模型也不编造当前状态',async t=>{
 const f=fixture(t,()=>assert.fail('No call expected'))
 const result=await f.evidence.verify(f.lib.id,'owner','未知偏好是什么',[],null,null,{scope:'current-state',state_keys:['unknown']})
 assert.equal(result.status,'insufficient');assert.equal(f.calls(),0)
})

test('新旧认识共享同一原文时，严格状态核验不能仅凭相同ID确认新语义',async t=>{
 let rid;const f=fixture(t,()=>({status:'supported',answer:'现在还是蓝色',citations:[{id:rid,quote:'以前采用蓝色'}]}));rid=f.raw('以前采用蓝色，后来已经改成青色。')
 f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'蓝色',reason:'原文旧半段',refs:[rid]},true)
 f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'青色',reason:'原文新半段',refs:[rid],expectedRevision:1},true)
 const r=await f.evidence.verify(f.lib.id,'owner','现在是什么颜色',[rid],null,null,{scope:'current-state',state_keys:['palette']})
 assert.equal(r.status,'insufficient');assert.equal(r.guard,'shared-revision-source')
})
test('整理与证据核验共用调用次数上限，没有偷偷增加一次请求',async t=>{
  const f=fixture(t,()=>({items:[]})),rid=f.raw('一条原文')
  f.x.configure(f.lib.id,'owner',{source:'dsh',provider:'p',model:'m',maxCallsPerDay:1,evidenceEnabled:true});f.x.resume(f.lib.id,'owner')
  await f.x.run(f.lib.id,'owner')
  await assert.rejects(f.evidence.verify(f.lib.id,'owner','原文是什么',[rid]),{code:'DAILY_LIMIT'})
  assert.equal(f.calls(),1)
})
test('默认不开启收费核验；开启后可返回有真实引用的反证而不改原文',async t=>{
  let rid
  const f=fixture(t,()=>({status:'contradicted',answer:'尚未发布',citations:[{id:rid,quote:'尚未发布'}]}));rid=f.raw('草稿已完成，尚未发布。')
  f.x.configure(f.lib.id,'owner',{source:'dsh',provider:'p',model:'m'})
  await assert.rejects(f.evidence.verify(f.lib.id,'owner','发布了吗',[rid]),{code:'EVIDENCE_NOT_ENABLED'});assert.equal(f.calls(),0)
  f.x.configure(f.lib.id,'owner',{source:'dsh',provider:'p',model:'m',evidenceEnabled:true})
  const result=await f.evidence.verify(f.lib.id,'owner','发布了吗',[rid]);assert.equal(result.status,'contradicted');assert.equal(result.citations[0].quote,'尚未发布');assert.equal(f.store.report(f.lib.id).records,1)
})

test('候选可暂存且保留理由；新版本重新待审，删除来源时清理关联审视记录',t=>{
 const f=fixture(t,()=>({items:[]})),rid=f.raw('用户提出一个待考虑的偏好')
 f.store.propose(f.lib.id,{key:'pref',kind:'preference',body:'暂时的候选',reason:'未认可',refs:[rid]})
 f.store.defer(f.lib.id,'owner','pref',1,'目前只是用户提议，暂不认作自己的偏好')
 assert.equal(f.store.pending(f.lib.id).length,0);assert.equal(f.store.current(f.lib.id).length,0)
 f.store.propose(f.lib.id,{key:'pref',kind:'preference',body:'根据新经历修订的候选',reason:'新依据',refs:[rid],expectedRevision:1})
 assert.equal(f.store.pending(f.lib.id)[0].revision,2)
 f.store.removeRecord(f.lib.id,'owner',rid);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM entry_reviews').get().n,0)
})

test('助手的内部认可失败报告不会被当成新的偏好版本',async t=>{
 let rid
 const f=fixture(t,()=>{throw Error('管理报告批次不应调用模型')})
 rid=f.store.append(f.lib.id,{session:'owner',seq:1,time:'2026-10-28T12:00:00Z',role:'assistant',text:'cm_self accept失败，候选未认可。'})
 f.x.resume(f.lib.id,'owner');const result=await f.x.run(f.lib.id,'owner')
 assert.equal(result.proposed,0);assert.equal(f.store.history(f.lib.id,'pref').length,0);assert.equal(f.calls(),0);assert.equal(result.excluded_reports,1)
})
