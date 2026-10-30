import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {WorkingMemory,retrievalTrigger} from '../lib/working-memory.mjs'

function fixture(t,config={}){
  const dir=mkdtempSync(join(tmpdir(),'continuity-working-test-'));let now=Date.parse('2026-10-29T08:00:00Z'),calls=0,answer=null
  const store=new ContinuityStore(dir,{now:()=>now}),lib=store.create('合成实验'),other=store.create('隔离库');store.bind('owner',lib.id,0)
  const append=(text,seq=1,extra={})=>store.append(lib.id,{session:'history',seq,time:new Date(now+seq*1000).toISOString(),role:'user',text,...extra})
  const embedding={lookup:async(...args)=>{calls++;assert.deepEqual(args[6],{readOnlyIndex:true,details:true});return typeof answer==='function'?answer(...args):answer||{results:[],candidates:[]}}}
  const scenes=new Scenes(store),working=new WorkingMemory(store,embedding,scenes,{enabled:true,...config})
  const hit=(id,semantic=.9,lexical=true)=>{answer={results:[{id:store.shortId(lib.id,id),title:'合成资料',score:.02,summary:Array.from(store.record(lib.id,id).text).slice(0,20).join(''),time:'2026-10-29 16:00'}],candidates:[{id,semantic,lexical,exact:false}]}}
  const prepare=(query='还记得蓝色小屋吗',seq=10,extra={})=>working.prepare({library:lib.id,session:'owner',query,userSeq:seq,turnSeq:seq,...extra})
  t.after(()=>{working.close();store.close();const path=resolve(dir);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('continuity-working-test-'));rmSync(path,{recursive:true,force:true})})
  return {store,lib,other,append,working,scenes,prepare,hit,calls:()=>calls,setAnswer:a=>{answer=a},advance:n=>{now+=n}}
}

test('触发门：明确回忆、话题、继续；问候不自动搜',()=>{
  assert.equal(retrievalTrigger('昨天的小屋'), 'explicit-recall');assert.equal(retrievalTrigger('研究一下天文学'), 'topic')
  assert.equal(retrievalTrigger('继续'),'continuation');for(const q of ['你好','好','谢谢','晚安',''])assert.equal(retrievalTrigger(q),'skip')
})

test('已纠正的候选不自动带入；强化分数不能绕过语义准入门',async t=>{
 const f=fixture(t),id=f.append('导航配色曾用蓝色'),card={id:f.store.shortId(f.lib.id,id),title:'原文',score:999,summary:'导航配色曾用蓝色',time:'2026-10-29'}
 f.setAnswer({results:[card],candidates:[{id,semantic:.95,lexical:true,auto_blocked:true}]});await f.prepare('导航配色现在怎样',11);assert.equal(f.working.view(f.lib.id,'owner').cards.length,0)
 f.setAnswer({results:[card],candidates:[{id,semantic:.51,lexical:true}]});await f.prepare('导航配色现在怎样',12);assert.equal(f.working.view(f.lib.id,'owner').cards.length,0)
})

test('已经准备的旧工作集遇到新纠正会退出，不继续带入其关联状态',async t=>{
 const f=fixture(t),id=f.append('导航配色曾用蓝色');f.hit(id)
 f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'旧配色',reason:'有出处',refs:[id]},true)
 await f.prepare('导航配色现在怎样',10);assert.equal(f.working.view(f.lib.id,'owner').cards.length,1)
 f.working.embedding.memoryDynamics={assess:()=>({auto_blocked:true})}
 const after=f.working.view(f.lib.id,'owner');assert.equal(after.cards.length,0);assert.equal(after.states.length,0)
 assert.equal(f.store.current(f.lib.id)[0].body,'旧配色');assert.equal(f.store.record(f.lib.id,id).text,'导航配色曾用蓝色')
})
test('场景保留说话者与原句顺序，不跨会话、聊天或时间断层',t=>{
  const f=fixture(t),a=f.append('我想玩游戏',1,{origin:{kind:'qq',chat_id:'A'}})
  f.append('我现在不想玩了',2,{role:'assistant'});f.append('另一聊天的内容',3,{origin:{kind:'qq',chat_id:'B'}})
  const result=f.scenes.build(f.lib.id,a);assert.deepEqual(result.messages.map(m=>m.text),['我想玩游戏','我现在不想玩了'])
  assert.equal(result.messages[0].role,'user');assert.equal(result.messages[1].role,'assistant');assert.match(result.note,/未推断/)
  f.append('明天的新话题',4,{time:'2026-10-30T08:00:00Z'});const later=f.scenes.build(f.lib.id,f.store.recent(f.lib.id).at(-1).id);assert.equal(later.messages.length,1)
  assert.throws(()=>f.scenes.build(f.other.id,a),{code:'NOT_FOUND'})
})
test('场景预算含JSON和元数据，emoji不拆字符；长原文不改写',t=>{
  const f=fixture(t),text='🌊'.repeat(4000)+'想去海边',id=f.append(text)
  const r=f.scenes.build(f.lib.id,id,{maxChars:1000});assert.ok(Array.from(JSON.stringify(r)).length<=1000)
  assert.equal(f.store.record(f.lib.id,id).text,text);assert.ok(r.messages[0].excerpt);assert.ok(!r.messages[0].text.includes('\ufffd'))
})
test('场景排除当前提问以及其后材料',t=>{
  const f=fixture(t),id=f.append('过去的原文',1);f.append('本轮问句',10)
  const r=f.scenes.build(f.lib.id,id,{exclude:{session:'history',fromSeq:10}});assert.equal(r.messages.length,1)
  assert.throws(()=>f.scenes.build(f.lib.id,f.store.recent(f.lib.id).at(-1).id,{exclude:{session:'history',fromSeq:10}}),{code:'CURRENT_TURN_EXCLUDED'})
})
test('高相关候选提升为预算内工作集，同条用户消息多步不重复搜索',async t=>{
  const f=fixture(t),id=f.append('蓝色小屋是上次聊过的网页设计');f.hit(id)
  await f.prepare('还记得蓝色小屋当时的聊天吗');await f.prepare('还记得蓝色小屋当时的聊天吗');assert.equal(f.calls(),1)
  const c=f.working.context(f.lib.id,'owner');assert.match(c,/蓝色小屋/);assert.match(c,/历史引用/);assert.match(c,/adjacent-source-records/);assert.ok(Array.from(c).length<=1800)
})
test('仅话题相近的弱候选不自动注入，分数不当成事实',async t=>{
  const f=fixture(t),id=f.append('我看过普通地质视频');f.hit(id,.55,true)
  await f.prepare('我上周买的火星土壤是哪种');assert.equal(f.working.context(f.lib.id,'owner'),'');assert.equal(f.working.status(f.lib.id,'owner').frame.status,'no-admissible-evidence')
})
test('明确换话题立即退出旧工作集，不把旧材料带到下一题',async t=>{
  const f=fixture(t),id=f.append('蓝色小屋');f.hit(id);await f.prepare();assert.match(f.working.context(f.lib.id,'owner'),/蓝色小屋/)
  f.setAnswer({results:[],candidates:[]});await f.prepare('木星天气怎样',20);assert.equal(f.working.context(f.lib.id,'owner'),'')
})
test('继续仅短暂沿用；时间到期或超过两次继续后退出',async t=>{
  const f=fixture(t),id=f.append('蓝色小屋');f.hit(id);await f.prepare()
  await f.prepare('继续',20);await f.prepare('继续',30);assert.match(f.working.context(f.lib.id,'owner'),/蓝色小屋/)
  await f.prepare('继续',40);assert.equal(f.working.context(f.lib.id,'owner'),'')
  await f.prepare('蓝色小屋怎么样',50);f.advance(16*60*1000);assert.equal(f.working.context(f.lib.id,'owner'),'')
})
test('已删除原文立即停止带入，清空工作集不删除长期记录',async t=>{
  const f=fixture(t),id=f.append('蓝色小屋');f.hit(id);await f.prepare()
  f.store.removeRecord(f.lib.id,'owner',id);assert.equal(f.working.context(f.lib.id,'owner'),'')
  const other=f.append('另一份原文',2);f.hit(other);await f.prepare('新的原文在哪',20);f.working.invalidate(f.lib.id,'owner');assert.equal(f.store.record(f.lib.id,other).text,'另一份原文')
})
test('只带已认可且仍有效的语义状态；新版本取代旧版并保留时间线入口',async t=>{
  const f=fixture(t),id=f.append('我喜欢蓝灰色');f.hit(id)
  f.store.propose(f.lib.id,{key:'colour',kind:'preference',body:'偏好蓝灰',reason:'原话',refs:[id]},true)
  f.store.propose(f.lib.id,{key:'pending',kind:'preference',body:'未核实的偏好',reason:'候选',refs:[id]})
  await f.prepare();let c=f.working.context(f.lib.id,'owner');assert.match(c,/偏好蓝灰/);assert.doesNotMatch(c,/未核实的偏好/)
  f.store.propose(f.lib.id,{key:'colour',expectedRevision:1,kind:'preference',body:'现在偏好亮黄',reason:'改变',refs:[id]},true)
  c=f.working.context(f.lib.id,'owner');assert.doesNotMatch(c,/"body":"偏好蓝灰"/);assert.match(c,/现在偏好亮黄/);assert.match(c,/replaces_revision/)
})
test('事实含义不自动分类，助手自述和用户意愿作为带角色的原文保留',async t=>{
  const f=fixture(t),id=f.append('我想玩游戏');f.append('我说不定已经学会了',2,{role:'assistant'});f.hit(id);await f.prepare('昨天想玩什么游戏')
  const c=f.working.context(f.lib.id,'owner');assert.match(c,/我想玩游戏/);assert.equal(f.store.current(f.lib.id).length,0);assert.equal(f.store.pending(f.lib.id).length,0)
})
test('检索不可用只退出自动召回，不锁主库、不退化成关键词、不重复重试',async t=>{
  const f=fixture(t);f.setAnswer(async()=>{throw Object.assign(Error('断线'),{code:'EMBEDDING_UNAVAILABLE'})})
  await f.prepare();await f.prepare();assert.equal(f.calls(),1);assert.equal(f.store.library(f.lib.id).error,null)
  assert.match(f.working.context(f.lib.id,'owner'),/EMBEDDING_UNAVAILABLE/);assert.match(f.working.context(f.lib.id,'owner'),/不等于没有记忆/)
})
test('自动召回超时后迟到结果不写回，记录原文不受影响',async t=>{
  const f=fixture(t,{timeoutMs:100});let finish;f.setAnswer(()=>new Promise(r=>{finish=r}))
  const id=f.append('蓝色小屋');await f.prepare();assert.equal(f.working.status(f.lib.id,'owner').frame.error,'AUTO_RECALL_TIMEOUT')
  finish({results:[],candidates:[{id,semantic:1,lexical:true}]});await new Promise(r=>setImmediate(r))
  assert.equal(f.working.status(f.lib.id,'owner').frame.status,'unavailable');assert.equal(f.store.report(f.lib.id).records,1)
})
test('关停和跨会话归属变化后不注入旧工作集',async t=>{
  const f=fixture(t),id=f.append('蓝色小屋');f.hit(id);await f.prepare();const rev=f.store.library(f.lib.id).revision
  f.store.transfer(f.lib.id,'owner','next',rev);assert.equal(f.working.context(f.lib.id,'owner'),'')
  assert.throws(()=>f.working.status(f.lib.id,'owner'),{code:'NOT_OWNER'});f.working.close();assert.equal(f.working.context(f.lib.id,'next'),'')
})
test('操作日志数量受限，原文永不因工作集退出而删除',async t=>{
  const f=fixture(t),id=f.append('原始记录');for(let i=0;i<140;i++)await f.prepare('你好',i)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_working_events').get().n,100);assert.equal(f.store.record(f.lib.id,id).text,'原始记录')
})
test('普通检索只带短卡，明确问当时才展开邻近聊天',async t=>{
  const f=fixture(t),id=f.append('蓝色小屋');f.hit(id);await f.prepare()
  assert.equal(f.working.view(f.lib.id,'owner').scene,null)
  await f.prepare('当时蓝色小屋怎么聊的',20);assert.equal(f.working.view(f.lib.id,'owner').scene.messages.length,1)
})
test('手动清空在当前消息内持续生效，下条新消息可正常召回',async t=>{
  const f=fixture(t),id=f.append('蓝色小屋');f.hit(id);await f.prepare();f.working.invalidate(f.lib.id,'owner','manual-clear')
  await f.prepare();assert.equal(f.calls(),1);assert.equal(f.working.context(f.lib.id,'owner'),'')
  await f.prepare('蓝色小屋怎么样',11);assert.equal(f.calls(),2);assert.match(f.working.context(f.lib.id,'owner'),/蓝色小屋/)
})
test('首次工作集尚未建立时清空，也能抑制当前消息的自动召回',async t=>{
  const f=fixture(t);f.append('先别检索了',10,{session:'owner'});f.working.invalidate(f.lib.id,'owner','manual-clear')
  const result=await f.prepare('先别检索了',10);assert.equal(result.reason,'manual-clear');assert.equal(f.calls(),0)
})
test('任务与失败触发同问题去重，每回合最多三次事件检索',async t=>{
  const f=fixture(t),w=f.working
  for(let i=0;i<8;i++){w.signalEvent(f.lib.id,'owner','tool-failure','failure-'+i,'网页工具失败');w.signalEvent(f.lib.id,'owner','tool-failure','failure-'+i,'重复失败')}
  const run=[];for(let i=0;i<8;i++){const event=w.takeTrigger(f.lib.id,'owner',1);if(event){run.push(event);await f.prepare(event.query,10,{event,turnSeq:1})}}
  assert.equal(run.length,3);assert.equal(f.calls(),3);assert.equal(new Set(run.map(e=>e.key)).size,3)
  w.signalEvent(f.lib.id,'owner','task-start','new','开始另一任务');assert.equal(w.takeTrigger(f.lib.id,'owner',2).kind,'task-start')
})
test('命中旧偏好原文也能带出最新已认可偏好，并明确它是当前状态',async t=>{
  const f=fixture(t),old=f.append('以前喜欢蓝色'),next=f.append('今天更喜欢绿色',2)
  f.store.propose(f.lib.id,{key:'colour',kind:'preference',body:'喜欢蓝色',reason:'原话',refs:[old]},true)
  f.advance(1000);f.store.propose(f.lib.id,{key:'colour',kind:'preference',body:'现在喜欢绿色',reason:'新自述',refs:[next],expectedRevision:1},true)
  f.hit(old);await f.prepare();const s=f.working.view(f.lib.id,'owner').states[0]
  assert.equal(s.body,'现在喜欢绿色');assert.equal(s.scope,'current-accepted');assert.ok(s.recorded_at);assert.match(s.history,/历史时点/)
})

test('混合召回只留下仍有效来源关联的状态，另一条活来源不能掩护已纠正状态',async t=>{
  const f=fixture(t),a=f.append('旧配色依据',1),b=f.append('海边作品依据',2)
  f.store.propose(f.lib.id,{key:'palette',kind:'preference',body:'旧配色',reason:'有原文',refs:[a]},true)
  f.store.propose(f.lib.id,{key:'seaside',kind:'goal',body:'海边作品',reason:'有原文',refs:[b]},true)
  f.setAnswer({results:[a,b].map(id=>({id:f.store.shortId(f.lib.id,id),title:'来源',score:.03,summary:'来源线索',time:'2026-10-29'})),candidates:[a,b].map(id=>({id,semantic:.95,lexical:true}))})
  await f.prepare('配色与海边作品',10);assert.equal(f.working.view(f.lib.id,'owner').states.length,2)
  f.working.embedding.memoryDynamics={assess:(_lib,r)=>({auto_blocked:r.id===a})}
  const view=f.working.view(f.lib.id,'owner');assert.deepEqual(view.source_ids,[b]);assert.deepEqual(view.states.map(s=>s.key),['seaside'])
})
test('自动场景过滤已纠正相邻原句，手动查看仍保留原话',async t=>{
  const f=fixture(t),a=f.append('旧配色原话',1),b=f.append('旁边还聊了海边作品',2);f.hit(b)
  f.working.embedding.memoryDynamics={assess:(_lib,r)=>({auto_blocked:r.id===a})}
  await f.prepare('当时配色与海边作品怎样聊',10)
  const scene=f.working.view(f.lib.id,'owner').scene;assert.deepEqual(scene.messages.map(m=>m.id),[f.store.shortId(f.lib.id,b)])
  assert.equal(f.scenes.build(f.lib.id,b).messages.some(m=>m.id===f.store.shortId(f.lib.id,a)),true)
})
test('继续时和渲染时均复核检查点来源，停用旧笔记不再带入其进度',async t=>{
  const f=fixture(t),id=f.append('旧笔记里的任务进度',1)
  f.store.checkpoint(f.lib.id,'owner','任务',{status:'paused',progress:'旧进度',next_step:'旧下一步'},[id],0)
  f.store.db.exec('CREATE TABLE cm_legacy_notes(library TEXT,rid TEXT,active INTEGER)');f.store.db.prepare('INSERT INTO cm_legacy_notes VALUES(?,?,1)').run(f.lib.id,id)
  await f.prepare('继续',10);assert.equal(f.working.view(f.lib.id,'owner').tasks.length,1)
  f.store.db.prepare('UPDATE cm_legacy_notes SET active=0 WHERE rid=?').run(id)
  assert.equal(f.working.view(f.lib.id,'owner').tasks.length,0)
  await f.prepare('继续',11);assert.equal(f.working.frame(f.lib.id,'owner').tasks.length,0)
})
test('自动提炼的事实状态带出模型来源与未核验标记',async t=>{
  const f=fixture(t),id=f.append('某视频提出一种方法',1)
  f.store.propose(f.lib.id,{key:'method',kind:'fact',body:'该视频提出的方法',reason:'[自动整理，未经独立核验] 模型归纳',refs:[id]},true)
  f.hit(id);await f.prepare();const state=f.working.view(f.lib.id,'owner').states[0]
  assert.equal(state.origin,'model-extracted');assert.equal(state.verification,'unassessed')
})
test('命中旧来源可取回全局最近100条以外的当前认识，不被常驻列表截断',async t=>{
  const f=fixture(t),old=f.append('很早的编译器约定',1),newer=f.append('其他认识依据',2)
  f.store.propose(f.lib.id,{key:'old-compiler',kind:'fact',body:'旧约定仍有效',reason:'原话',refs:[old]},true)
  for(let i=0;i<105;i++){f.advance(1);f.store.propose(f.lib.id,{key:'other-'+i,kind:'fact',body:'其他事实 '+i,reason:'原话',refs:[newer]},true)}
  assert.equal(f.store.current(f.lib.id).some(e=>e.key==='old-compiler'),false)
  f.hit(old);await f.prepare('很早的编译器约定',10);assert.equal(f.working.view(f.lib.id,'owner').states[0].key,'old-compiler')
})
