import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {MemoryDynamics} from '../lib/memory-dynamics.mjs'

const DAY=86400000
function fixture(t,enabled=true){
  const directory=mkdtempSync(join(tmpdir(),'cm-dynamics-test-'));let now=Date.parse('2026-10-30T08:00:00Z'),seq=0
  const store=new ContinuityStore(directory,{now:()=>now}),lib=store.create('合成使用反馈');store.bind('owner',lib.id,0)
  const d=new MemoryDynamics(store,{enabled}),append=(body,extra={})=>store.append(lib.id,{session:'history',seq:++seq,time:new Date(now).toISOString(),role:'assistant',text:body,...extra})
  t.after(()=>{store.close();const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('cm-dynamics-test-'));rmSync(path,{recursive:true,force:true})})
  return {directory,store,lib,d,append,advance:n=>{now+=n},now:()=>now,assess:(id,q='')=>d.assess(lib.id,store.record(lib.id,id),q),record:(id,kind,ref,extra={})=>d.record(lib.id,'owner',{id,kind,refs:[ref],reason:'合成可核对的使用记录',...extra})}
}

test('默认关闭时仍可记录待用反馈，不改变原有时间排序或自动召回准入',t=>{
  const f=fixture(t,false),id=f.append('旧经历');f.advance(90*DAY);const evidence=f.append('现在否定这个说法'),before=f.assess(id,'导航配色')
  f.record(id,'invalidated',evidence,{cue:'导航配色'})
  assert.deepEqual(f.assess(id,'导航配色'),before);assert.equal(f.d.describe(f.lib.id,id).enabled,false)
})
test('时间淡出按同一时钟计算；进入休眠仍保留原文和排序底值',t=>{
  const f=fixture(t),id=f.append('多年后的原话仍要保留');assert.equal(f.assess(id).factor,1)
  f.advance(30*DAY);assert.equal(f.assess(id).factor,.85)
  f.advance(300*DAY);assert.equal(f.assess(id).phase,'dormant');assert.ok(f.assess(id).factor>=.7);assert.equal(f.store.record(f.lib.id,id).text,'多年后的原话仍要保留')
})
test('实际使用反馈可强化；重复同一依据和跨类型提交不叠加奖励',t=>{
  const f=fixture(t),id=f.append('旧网页经历');f.advance(180*DAY);const before=f.assess(id),ref=f.append('用旧网页经历解决了导航问题')
  f.record(id,'helpful',ref);const once=f.assess(id);assert.ok(once.factor>before.factor)
  const repeat=f.record(f.store.shortId(f.lib.id,id),'helpful',ref,{reason:'换措辞也不能重复刷'});assert.equal(repeat.duplicate,true);assert.deepEqual(f.assess(id),once)
  const cited=f.append('引用 '+f.store.shortId(f.lib.id,id));f.record(id,'cited',cited);f.record(id,'helpful',cited)
  assert.ok(f.assess(id).reinforcement<=1);const beforeType=f.assess(id);f.record(id,'cited',ref,{refs:[cited]});assert.deepEqual(f.assess(id),beforeType)
})
test('旧使用依据今天补记不会重置到今天，记忆只能按实际依据时间恢复',t=>{
  const f=fixture(t),id=f.append('旧事');f.advance(DAY);const ref=f.append('当时用过这条');f.advance(300*DAY)
  f.record(id,'reaffirmed',ref);assert.ok(f.assess(id).reinforcement<.001);assert.equal(f.assess(id).phase,'dormant')
})
test('需要后续原文；曝光、读取、无ID引用和自我证明不产生强化',t=>{
  const f=fixture(t),older=f.append('更早的记录');f.advance(DAY);const id=f.append('需要回忆的原文'),ref=f.append('只读过但没有引用')
  for(const kind of ['read','exposed','retrieved'])assert.throws(()=>f.record(id,kind,ref),{code:'INVALID_INPUT'})
  assert.throws(()=>f.record(id,'helpful',id),{code:'INVALID_EVIDENCE'});assert.throws(()=>f.record(id,'helpful',older),{code:'INVALID_EVIDENCE'});assert.throws(()=>f.record(id,'cited',ref),{code:'INVALID_EVIDENCE'})
  assert.throws(()=>f.record(id,'helpful',ref,{refs:[]}),{code:'INVALID_EVIDENCE'});assert.equal(f.d.rows(f.lib.id,id).length,0)
})
test('同一天大量不同依据的正向反馈受上限约束；未触碰任何原文',t=>{
  const f=fixture(t),id=f.append('旧记录');f.advance(120*DAY)
  for(let i=0;i<20;i++)f.record(id,'cited',f.append('第'+i+'次引用 '+f.store.shortId(f.lib.id,id)))
  assert.equal(f.assess(id).reinforcement,.75);assert.equal(f.store.record(f.lib.id,id).text,'旧记录')
})
test('纠正限定字面线索，不牵连同段其他话题；之后的强化不能自动取消纠正',t=>{
  const f=fixture(t),id=f.append('导航配色是蓝色；也喜欢海边'),ref=f.append('导航配色说错了')
  assert.throws(()=>f.record(id,'corrected',ref),{code:'INVALID_INPUT'})
  const feedback=f.record(id,'corrected',ref,{cue:'导航配色'});assert.equal(f.assess(id,'导航配色现在怎样').auto_blocked,true);assert.equal(f.assess(id,'喜欢海边吗').auto_blocked,false)
  f.record(id,'reaffirmed',f.append('我再次提到了那份旧记录'))
  assert.equal(f.assess(id,'导航配色').auto_blocked,true);assert.equal(f.d.describe(f.lib.id,id).recent.some(e=>e.id===feedback.id),true)
})
test('反馈可撤销且幂等，不删除记录或重写认可状态',t=>{
  const f=fixture(t),id=f.append('旧记录'),ref=f.append('纠正依据'),event=f.record(id,'invalidated',ref,{cue:'导航配色'})
  f.store.propose(f.lib.id,{key:'color',kind:'preference',body:'蓝色',reason:'自述',refs:[id]},true)
  const r=f.append('后来发现这次纠正不成立'),args={feedback_id:event.id,reason:'撤销原纠正',refs:[r]}
  assert.equal(f.d.retract(f.lib.id,'owner',args).retracted,true);assert.equal(f.d.retract(f.lib.id,'owner',args).duplicate,true);assert.equal(f.assess(id,'导航配色').auto_blocked,false)
  assert.equal(f.store.current(f.lib.id)[0].body,'蓝色');assert.equal(f.store.record(f.lib.id,id).text,'旧记录')
})
test('删除使用依据会清理反馈组；删除撤销依据不会把旧负向反馈复活',t=>{
  const f=fixture(t),id=f.append('原文'),ref=f.append('使用记录');f.record(id,'helpful',ref);f.store.removeRecord(f.lib.id,'owner',ref);assert.equal(f.d.rows(f.lib.id,id).length,0)
  const negative=f.record(id,'invalidated',f.append('否定'),{cue:'导航配色'}),undo=f.append('撤销否定')
  f.d.retract(f.lib.id,'owner',{feedback_id:negative.id,reason:'撤销',refs:[undo]});f.store.removeRecord(f.lib.id,'owner',undo)
  assert.equal(f.assess(id,'导航配色').auto_blocked,false);assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_memory_feedback').get().n,0)
})
test('大量正向反馈不会把长期有效的具体纠正挤出判定',t=>{
  const f=fixture(t),id=f.append('旧说法');f.record(id,'invalidated',f.append('明确纠正'),{cue:'导航配色'})
  for(let i=0;i<70;i++)f.record(id,'helpful',f.append('其他用途帮助 '+i))
  assert.equal(f.assess(id,'导航配色').auto_blocked,true);assert.equal(f.assess(id,'其他用途').auto_blocked,false)
})
test('原文库和owner隔离；审计失败整批回滚',t=>{
  const f=fixture(t),id=f.append('原文'),ref=f.append('使用依据'),other=f.store.create('另一个库');f.store.bind('other',other.id,0)
  assert.throws(()=>f.d.record(f.lib.id,'other',{id,kind:'helpful',refs:[ref],reason:'不允许'}),{code:'NOT_OWNER'})
  assert.throws(()=>f.d.describe(other.id,id),{code:'NOT_FOUND'})
  const log=f.store.log;f.store.log=()=>{throw Error('synthetic audit failure')}
  try{assert.throws(()=>f.record(id,'helpful',ref),/audit failure/)}finally{f.store.log=log}
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_memory_feedback').get().n,0)
})
test('反馈和撤销可跨重启恢复，不因加载或状态查询再强化',t=>{
  const f=fixture(t),id=f.append('原文');f.advance(180*DAY);f.record(id,'helpful',f.append('实际帮助'));const before=f.assess(id)
  f.store.close();const reopened=new ContinuityStore(f.directory,{now:f.now}),d=new MemoryDynamics(reopened,{enabled:true})
  try{assert.deepEqual(d.assess(f.lib.id,reopened.record(f.lib.id,id)),before);for(let i=0;i<5;i++)d.describe(f.lib.id,id);assert.equal(d.rows(f.lib.id,id).length,1)}finally{reopened.close()}
})
