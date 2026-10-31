import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {WorkingMemory} from '../lib/working-memory.mjs'
import {ContextFrame} from '../lib/context-frame.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'
import {ClaimLinks} from '../lib/claim-links.mjs'

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'continuity-frame-test-')),store=new ContinuityStore(dir),lib=store.create('合成预算测试');store.bind('owner',lib.id,0)
  const scenes=new Scenes(store),situations=new Situations(store,scenes),execution=new ExecutionLedger(store)
  let answer={results:[],candidates:[]},seq=0
  const working=new WorkingMemory(store,{lookup:async()=>answer},scenes,{enabled:true}),context=new ContextFrame(store,working,situations,execution)
  const append=(text,extra={})=>store.append(lib.id,{session:'history',seq:++seq,time:'2026-10-28T08:00:00Z',role:'user',text,...extra})
  const hit=(id)=>{answer={results:[{id:store.shortId(lib.id,id),title:'合成旧事',score:.03,summary:'只在短卡中概括的线索',time:'2026-10-28'}],candidates:[{id,semantic:.95,lexical:true}]}}
  const render=()=>context.render(lib.id,'owner'),parse=()=>JSON.parse(render().split('\n').slice(1).join('\n'))
  t.after(()=>{working.close();store.close();const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('continuity-frame-test-'));rmSync(target,{recursive:true,force:true})})
  return {store,lib,scenes,situations,execution,working,context,append,hit,render,parse}
}

test('a previously prepared working frame revalidates new claim links without rereading the whole archive',async t=>{
 const f=fixture(t),a=f.append('以前用蓝色。'),b=f.append('后来改用绿色。'),links=new ClaimLinks(f.store)
 f.store.markRestored('owner');f.working.embedding.claimLinks=links;f.hit(a)
 await f.working.prepare({library:f.lib.id,session:'owner',query:'以前用的颜色',userSeq:99,turnSeq:99})
 assert.equal(f.parse().relations,undefined)
 links.record(f.lib.id,'owner',{id:a,target_id:b,relation:'changed',subject:'speaker',topic:'palette',scope:'room',source_quote:'以前用蓝色',target_quote:'后来改用绿色',reason:'Attributed synthetic change'})
 const rendered=f.render();assert.ok(Array.from(rendered).length<=800);assert.equal(f.parse().relations.items[0].after,'后来改用绿色')
 const view=f.working.context(f.lib.id,'owner');assert.ok(Array.from(view).length<=1800);assert.match(view,/后来改用绿色/)
 f.store.db.prepare('DELETE FROM records WHERE id=?').run(b);assert.equal(f.parse().relations,undefined)
})

test('recovery guard and claim relationships share the hard context budget',async t=>{
 const f=fixture(t),a=f.append('旧'.repeat(100)),b=f.append('新'.repeat(100)),links=new ClaimLinks(f.store);f.working.embedding.claimLinks=links;f.hit(a)
 links.record(f.lib.id,'owner',{id:a,target_id:b,relation:'disputed',subject:'s'.repeat(80),topic:'t'.repeat(100),scope:'c'.repeat(100),source_quote:'旧'.repeat(100),target_quote:'新'.repeat(100),reason:'Unresolved synthetic dispute'})
 f.store.db.prepare('INSERT INTO cm_tool_operations(library,session,call_id,name,args_digest,readonly,status,time) VALUES(?,?,?,?,?,?,?,?)').run(f.lib.id,'owner','pending','synthetic_send','synthetic',0,'uncertain',Date.now())
 await f.working.prepare({library:f.lib.id,session:'owner',query:'以前的争议',userSeq:99,turnSeq:99})
 const rendered=f.render();assert.ok(Array.from(rendered).length<=1800);assert.ok(f.parse().relations);assert.equal(f.parse().relations.items[0].kind,'disputed')
})
test('所有自动材料共用1800字符，根状态、恢复、短卡、任务不会叠加超额',async t=>{
  const f=fixture(t),id=f.append('历史原文'.repeat(500)),s=f.situations.create(f.lib.id,'owner',{title:'当前视频',refs:[id]});f.situations.focus(f.lib.id,'owner',s.id)
  for(let n=0;n<8;n++)f.store.propose(f.lib.id,{key:'根'+n,kind:'identity',body:'有出处的自我认识'.repeat(50),reason:'测试',refs:[id]},true)
  f.store.checkpoint(f.lib.id,'owner','网页制作',{status:'paused',progress:'已做首页'.repeat(100),next_step:'核对页面'.repeat(100)},[id],0)
  f.hit(id);await f.working.prepare({library:f.lib.id,session:'owner',query:'当时的历史原文',userSeq:99,turnSeq:90})
  const text=f.render();assert.ok(Array.from(text).length<=1800);assert.ok(f.parse().omitted>0)
  assert.equal(f.store.record(f.lib.id,id).text.length,2000)
})
test('普通轮次预算800字符，保留当前线索；背景任务只保留入口',async t=>{
  const f=fixture(t),id=f.append('过去的网页任务');f.store.markRestored('owner');f.hit(id)
  const task=f.execution.plan(f.lib.id,'owner','后台网页',[{id:'a',title:'读页面',tool:'read'}]);f.execution.activate(f.lib.id,'owner',task.id,'a',0)
  await f.working.prepare({library:f.lib.id,session:'owner',query:'想和你聊昨天的事情',userSeq:10})
  assert.ok(Array.from(f.render()).length<=800);assert.equal(f.parse().execution.task,task.id);assert.ok(f.parse().cards.length)
})
test('恢复尾段排除当前问题；不凭当前问题构造历史答案',async t=>{
  const f=fixture(t);f.append('旧的真实原文',{session:'owner',seq:1});f.append('当前虚构问题',{session:'owner',seq:50})
  await f.working.prepare({library:f.lib.id,session:'owner',query:'当前虚构问题',userSeq:50,turnSeq:40})
  assert.doesNotMatch(f.render(),/当前虚构问题/);assert.match(f.render(),/旧的真实原文/)
})
test('出现未确认外部动作时，预算先保留核对保护；不重复写入恢复日志',async t=>{
  const f=fixture(t),id=f.append('背景资料'),s=f.situations.create(f.lib.id,'owner',{title:'一件事',refs:[id]});f.situations.focus(f.lib.id,'owner',s.id)
  f.store.db.prepare('INSERT INTO cm_tool_operations(library,session,call_id,name,args_digest,readonly,status,time) VALUES(?,?,?,?,?,?,?,?)').run(f.lib.id,'owner','uncertain','run_code','hash',0,'uncertain',Date.now())
  const before=f.store.db.prepare('SELECT count(*) n FROM audit').get().n
  for(let i=0;i<10;i++){const text=f.render();assert.ok(Array.from(text).length<=1800);assert.match(text,/等待管理员/);assert.match(text,/不重发/)}
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM audit').get().n,before)
})
test('召回异常明确给出不可用状态，其他原文照常保存',async t=>{
  const f=fixture(t);f.store.markRestored('owner');f.working.embedding.lookup=async()=>{throw Object.assign(Error('offline'),{code:'EMBEDDING_UNAVAILABLE'})}
  await f.working.prepare({library:f.lib.id,session:'owner',query:'以前的事情',userSeq:10})
  assert.equal(f.parse().recall.status,'unavailable');assert.match(f.render(),/不可用不等于没记录/)
  const id=f.append('故障期间的新原文');assert.equal(f.store.record(f.lib.id,id).text,'故障期间的新原文');assert.equal(f.store.library(f.lib.id).error,null)
})
test('当前焦点的语义胶囊只在继续或任务切换时展开',async t=>{
  const f=fixture(t),id=f.append('只完成了片头'),s=f.situations.create(f.lib.id,'owner',{title:'视频任务',refs:[id],assertions:[{slot:'progress',body:'只完成了片头',refs:[id]}]})
  f.situations.focus(f.lib.id,'owner',s.id);f.store.markRestored('owner')
  await f.working.prepare({library:f.lib.id,session:'owner',query:'你好',userSeq:10});assert.ok(!f.parse().situation.statements)
  await f.working.prepare({library:f.lib.id,session:'owner',query:'继续',userSeq:11});assert.match(f.render(),/只完成了片头/)
  assert.equal(f.context.render(f.lib.id,'other'),'')
})
test('命中旧原文时能附带所属情境入口，多个情境保持独立',async t=>{
  const f=fixture(t),id=f.append('闲聊中提到片头'),a=f.situations.create(f.lib.id,'owner',{title:'剪辑任务',refs:[id]}),b=f.situations.create(f.lib.id,'owner',{title:'游戏时的闲聊',refs:[id]})
  f.store.markRestored('owner');f.hit(id);await f.working.prepare({library:f.lib.id,session:'owner',query:'以前提到的片头',userSeq:10})
  const p=f.parse();assert.equal(p.related_situations.candidates.length,2);assert.deepEqual(new Set(p.related_situations.candidates.map(s=>s.id)),new Set([a.id,b.id]));assert.match(p.related_situations.basis,/不能合成/)
})

test('恢复路径保留自动整理事实的模型来源和未经核验状态',t=>{
  const f=fixture(t),id=f.append('外部视频的一种说法')
  f.store.propose(f.lib.id,{key:'claim',kind:'fact',body:'该来源提出一种方法',reason:'[自动整理，未经独立核验] 来自视频',refs:[id]},true)
  const state=f.parse().states[0];assert.equal(state.origin,'model-extracted');assert.equal(state.verification,'unassessed')
})
