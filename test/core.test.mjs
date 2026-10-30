import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {fileURLToPath} from 'node:url'
import { spawnSync } from 'node:child_process'
import { ContinuityStore } from '../lib/store.mjs'
import { Capture } from '../lib/capture.mjs'
import { Extraction, normalizeUsage } from '../lib/extraction.mjs'

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'continuity-core-test-')),store=new ContinuityStore(directory)
  const a=store.create('伙伴甲'),b=store.create('项目乙');store.bind('s1',a.id,0);store.bind('s2',b.id,0)
  const raw=(body,seq=1,library=a.id,session='s1')=>store.append(library,{session,seq,time:'2026-10-28T10:00:00+08:00',role:'user',type:'user/message',text:body})
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true})})
  return {store,a,b,raw,directory}
}
test('独立命名、重命名保持ID；版本冲突不覆盖',t=>{
  const f=fixture(t),before=f.store.library(f.a.id);f.store.rename(f.a.id,'新名字',before.revision)
  assert.equal(f.store.library(f.a.id).id,f.a.id);assert.throws(()=>f.store.rename(f.a.id,'旧修改',before.revision),{code:'CONFLICT'})
})
test('同库只有一个拥有者，一会话只绑定一个库',t=>{
  const f=fixture(t);assert.throws(()=>f.store.bind('s2',f.a.id,1),{code:'HANDOFF_REQUIRED'});assert.equal(f.store.binding('s2').library,f.b.id)
})
test('原文幂等，来源改写拒绝，不靠压缩摘要替换原文',t=>{
  const f=fixture(t),id=f.raw('我计划写文章，还没完成');assert.equal(f.raw('我计划写文章，还没完成'),id)
  assert.throws(()=>f.raw('我写完了文章'),{code:'SOURCE_CHANGED'});assert.equal(f.store.read(f.a.id,id).text,'我计划写文章，还没完成')
})
test('长原文按Unicode字符分页可逐字恢复',t=>{
  const f=fixture(t),body='鲸🐋甲'.repeat(9000),id=f.raw(body);let offset=0,result=''
  do{const page=f.store.read(f.a.id,id,offset,3000);result+=page.text;offset=page.next_offset}while(offset!==null)
  assert.equal(result,body)
})
test('跨库原文、引用、检索均隔离',t=>{
  const f=fixture(t),id=f.raw('仅属于伙伴甲的约定')
  assert.throws(()=>f.store.record(f.b.id,id),{code:'NOT_FOUND'});assert.equal(f.store.lookup(f.b.id,'约定').results.length,0)
  assert.throws(()=>f.store.propose(f.b.id,{key:'x',kind:'fact',body:'x',reason:'x',refs:[id]}),{code:'NOT_FOUND'})
})
test('候选不直接变成自我认识，主会话可审视接受',t=>{
  const f=fixture(t),id=f.raw('我更喜欢安静的写作'),e=f.store.propose(f.a.id,{key:'writing',kind:'preference',body:'表达偏爱写作',reason:'原话，非客观情绪证明',refs:[id]})
  assert.equal(f.store.current(f.a.id).length,0);assert.equal(f.store.pending(f.a.id).length,1)
  f.store.accept(f.a.id,'s1','writing',e.revision);assert.equal(f.store.current(f.a.id)[0].body,'表达偏爱写作')
})
test('偏好修订保留旧版本，陈旧修订拒绝',t=>{
  const f=fixture(t),r1=f.raw('喜欢旧风格'),r2=f.raw('经过尝试改选新风格',2)
  f.store.propose(f.a.id,{key:'style',kind:'preference',body:'旧风格',reason:'初次表达',refs:[r1]},true)
  f.store.propose(f.a.id,{key:'style',kind:'preference',body:'新风格',reason:'新尝试后修正',refs:[r2],expectedRevision:1},true)
  assert.equal(f.store.entry(f.a.id,'style',1).body,'旧风格');assert.equal(f.store.current(f.a.id)[0].body,'新风格')
  assert.throws(()=>f.store.propose(f.a.id,{key:'style',kind:'preference',body:'迟到覆盖',reason:'旧值',refs:[r1],expectedRevision:1}),{code:'CONFLICT'})
})
test('暂时状态必须有过期时间，过期不进入恢复',t=>{
  const f=fixture(t),id=f.raw('今天有点累');assert.throws(()=>f.store.propose(f.a.id,{key:'tired',kind:'transient',body:'暂时疲惫表达',reason:'当日',refs:[id]}),{code:'INVALID_INPUT'})
  f.store.propose(f.a.id,{key:'tired',kind:'transient',body:'暂时疲惫表达',reason:'当日',refs:[id],expires:Date.now()+50},true)
  f.store.now=()=>Date.now()+1000;assert.equal(f.store.current(f.a.id).length,0)
})
test('恢复预算有界，近期连续原文和任务能保留',t=>{
  const f=fixture(t);let rid;for(let i=1;i<=30;i++)rid=f.raw('第'+i+'轮 '+('长内容'.repeat(1000)),i)
  f.store.checkpoint(f.a.id,'s1','page',{status:'paused',progress:'已写文件，未验收',next_step:'检查页面'},[rid],0)
  const r=f.store.restore(f.a.id,'s1');assert.ok(r.text.length<=12000);assert.match(r.text,/检查页面/);assert.ok(r.omitted.recent>0)
})

test('长消息接续优先保留最后的真实结果，并标注原文字符范围',t=>{
 const f=fixture(t),body='开头背景。'.repeat(900)+'最后一步已完成：合成文件已经保存。',rid=f.raw(body)
 f.store.settings(f.a.id,'s1',{restoreChars:1800})
 const restored=f.store.restore(f.a.id,'s1'),bundle=JSON.parse(restored.text.slice(restored.text.indexOf('{')))
 assert.ok(restored.text.length<=1800);assert.match(restored.text,/最后一步已完成/)
 assert.ok(bundle.recent[0].range[0]>0);assert.equal(bundle.recent[0].range[1],Array.from(body).length);assert.equal(bundle.recent[0].excerpt,true)
 assert.equal(f.store.record(f.a.id,rid).text,body)
})
test('常驻状态默认关闭，压缩标记会触发一次恢复',t=>{
  const f=fixture(t);f.raw('刚才聊到这里');assert.ok(f.store.restore(f.a.id,'s1'));f.store.markRestored('s1');assert.equal(f.store.restore(f.a.id,'s1'),null)
  f.store.markCompacted('s1');assert.ok(f.store.restore(f.a.id,'s1'));f.store.markRestored('s1');f.store.settings(f.a.id,'s1',{injectLatestState:true});assert.ok(f.store.restore(f.a.id,'s1'))
})
test('同库调用互斥，不同库独立；错误后需手动恢复',t=>{
  const f=fixture(t),token=f.store.begin(f.a.id,'s1','main'),other=f.store.begin(f.b.id,'s2','main')
  assert.throws(()=>f.store.begin(f.a.id,'s1','extract'),{code:'BUSY'});f.store.finish(f.a.id,'wrong');assert.ok(f.store.busy(f.a.id))
  f.store.finish(f.a.id,token);f.store.pause(f.a.id,'FAULT');assert.throws(()=>f.store.begin(f.a.id,'s1','main'),{code:'PAUSED'});f.store.resume(f.a.id,'s1');assert.ok(f.store.begin(f.a.id,'s1','main'));f.store.finish(f.b.id,other)
})
test('交接拒绝活动中的旧会话，旧窗口交接后不能写状态',t=>{
  const f=fixture(t);f.raw('最后一句相处原文');const token=f.store.begin(f.a.id,'s1','main')
  assert.throws(()=>f.store.transfer(f.a.id,'s1','new',1),{code:'BUSY'});f.store.finish(f.a.id,token)
  f.store.transfer(f.a.id,'s1','new',1);assert.throws(()=>f.store.assertOwner(f.a.id,'s1'),{code:'NOT_OWNER'});assert.match(f.store.restore(f.a.id,'new').text,/最后一句相处原文/)
})
test('删除清理派生认识组，不使旧版本复活，并防止来源回填',t=>{
  const f=fixture(t),r1=f.raw('旧结论'),r2=f.raw('新结论',2)
  f.store.propose(f.a.id,{key:'fact',kind:'fact',body:'旧',reason:'旧',refs:[r1]},true);f.store.propose(f.a.id,{key:'fact',kind:'fact',body:'新',reason:'修订',refs:[r2],expectedRevision:1},true)
  f.store.removeRecord(f.a.id,'s1',r2);assert.equal(f.store.current(f.a.id).length,0);assert.equal(f.raw('新结论',2),null)
})
test('工具与QQ可见正文采集，注入、隐藏思考、替代摘要不回灌',t=>{
  const f=fixture(t),c=new Capture(f.store),ev=(seq,type,data,extra={})=>({seq,time:'2026-10-28T10:00:00Z',type,data,...extra})
  c.event(f.a.id,'s1',ev(1,'user/message',{role:'user',source:{kind:'qq'},content:[{type:'text',text:'QQ来的话'}]}))
  c.event(f.a.id,'s1',ev(2,'assistant/message',{message:{content:[{type:'reasoning',text:'不保存隐藏思考'},{type:'text',text:'可见回复'}]}}))
  assert.equal(c.event(f.a.id,'s1',ev(3,'user/message',{source:{kind:'plugin'},content:'旧记忆注入'})),null)
  assert.equal(c.event(f.a.id,'s1',ev(4,'user/message',{content:'压缩摘要'},{surfaceOp:{op:'replace',startSeq:1,endSeq:2}})),null)
  c.event(f.a.id,'s1',ev(5,'tool/call',{id:'call1',name:'cm_read'}));assert.equal(c.event(f.a.id,'s1',ev(6,'tool/result',{message:{toolCallId:'call1',content:'旧原文'}})),null)
  c.event(f.a.id,'s1',ev(7,'tool/result',{message:{toolCallId:'normal',content:'实际操作结果'}}))
  assert.equal(f.store.report(f.a.id).records,3);assert.ok(f.store.lookup(f.a.id,'QQ').results.length)
})
test('单写者锁阻止另一个宿主，重启不会清空数据',t=>{
  const f=fixture(t);f.raw('持久内容');assert.throws(()=>new ContinuityStore(f.directory),{code:'HOST_ALREADY_RUNNING'})
  f.store.close();const again=new ContinuityStore(f.directory);assert.equal(again.report(f.a.id).records,1);again.close()
})
test('重启回收旧活动锁但不锁死下一轮对话',t=>{
  const f=fixture(t);f.store.begin(f.a.id,'s1','main');f.store.close();const again=new ContinuityStore(f.directory)
  assert.equal(again.library(f.a.id).error,null);assert.equal(again.busy(f.a.id),null);const token=again.begin(f.a.id,'s1','main');again.finish(f.a.id,token);again.close()
})
test('精简候选完整JSON不超过120个Unicode字符',t=>{
  const f=fixture(t);f.raw('共同约定很长的句子'.repeat(40));for(const r of f.store.lookup(f.a.id,'共同约定',5).results)assert.ok(Array.from(JSON.stringify(r)).length<=120)
})
test('提炼失败仅一次请求，暂停后重复调度也不自动重试或换源',async t=>{
  const f=fixture(t);f.raw('需要提炼的一段真实材料');let calls=0
  process.env.CM_TEST_KEY='test-only';t.after(()=>delete process.env.CM_TEST_KEY)
  const x=new Extraction(f.store,{fetcher:async()=>{calls++;return {ok:false,status:500}}})
  x.configure(f.a.id,'s1',{source:'api',baseURL:'https://example.invalid/v1',model:'fake',apiKeyEnv:'CM_TEST_KEY'});x.resume(f.a.id,'s1')
  await assert.rejects(x.run(f.a.id,'s1'));assert.equal(calls,1);assert.equal(x.status(f.a.id).paused,true)
  await x.run(f.a.id,'s1');assert.equal(calls,1);assert.equal(f.store.report(f.a.id).records,1)
})
test('提炼成功生成未认可候选，实报usage与估算分列',async t=>{
  const f=fixture(t),rid=f.raw('表达了对安静写作的偏好');process.env.CM_TEST_KEY='test-only';t.after(()=>delete process.env.CM_TEST_KEY)
  const x=new Extraction(f.store,{fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{key:'writing',kind:'preference',body:'表达喜欢安静写作',reason:'用户原话，不等同AI本人偏好',refs:[rid]}]})}}],usage:{prompt_tokens:400,completion_tokens:80}})})})
  x.configure(f.a.id,'s1',{source:'api',baseURL:'https://example.invalid/v1',model:'fake',apiKeyEnv:'CM_TEST_KEY'});x.resume(f.a.id,'s1');await x.run(f.a.id,'s1')
  assert.equal(f.store.current(f.a.id).length,0);assert.equal(f.store.pending(f.a.id).length,1)
  const u=f.store.report(f.a.id).usage[0];assert.equal(u.input,400);assert.equal(u.output,80);assert.ok(u.estimated_input>0)
})
test('提炼无效引用整批回滚，游标不推进，未知用量不记成0',async t=>{
  const f=fixture(t);f.raw('真实材料');const x=new Extraction(f.store,{dshCall:async()=>({text:JSON.stringify({items:[{key:'bad',kind:'fact',body:'x',reason:'x',refs:['fake']}]})})})
  x.configure(f.a.id,'s1',{source:'dsh',provider:'p',model:'m'});x.resume(f.a.id,'s1');await assert.rejects(x.run(f.a.id,'s1'),{code:'INVALID_EVIDENCE'})
  assert.equal(x.status(f.a.id).cursor,0);assert.equal(f.store.pending(f.a.id).length,0);assert.equal(f.store.report(f.a.id).usage[0].input,null)
})
test('DSH disjoint用量不重复计入缓存或推理token',()=>{
  assert.deepEqual(normalizeUsage({inputTokens:10,cacheReadTokens:90,outputTokens:20,reasoningTokens:10},'dsh'),{input:100,output:20,cache_read:90,cache_write:null})
})
test('真实CLI子进程建库与备份，拒绝覆盖已有备份',t=>{
  const directory=mkdtempSync(join(tmpdir(),'continuity-cli-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url)),run=request=>spawnSync(process.execPath,[cli,'--data',directory],{input:JSON.stringify(request),encoding:'utf8'})
  const create=run({action:'create',name:'CLI库'});assert.equal(create.status,0,create.stderr)
  const id=JSON.parse(create.stdout).result.id,target=join(directory,'backup.sqlite3');assert.equal(run({action:'backup',path:target}).status,0)
  assert.equal(run({action:'backup',path:target}).status,1);assert.equal(run({action:'report',library_id:id}).status,0)
})
test('查阅调用跨采集器重启仍被排除，不把旧记忆回灌为新经历',t=>{
  const f=fixture(t),a=new Capture(f.store),time='2026-10-28T10:00:00Z'
  a.event(f.a.id,'s1',{seq:1,time,type:'tool/call',data:{id:'memory-call',name:'cm_read'}})
  const b=new Capture(f.store);assert.equal(b.event(f.a.id,'s1',{seq:2,time,type:'tool/result',data:{message:{toolCallId:'memory-call',content:'旧经历'}}}),null)
  assert.equal(f.store.report(f.a.id).records,0)
})
test('常驻最新状态不每轮重复塞入整段旧会话原文',t=>{
  const f=fixture(t),id=f.raw('从前会话的独特长句');f.store.propose(f.a.id,{key:'pref',kind:'preference',body:'当前表达的偏好',reason:'理由',refs:[id]},true)
  f.store.transfer(f.a.id,'s1','new',1);f.store.markRestored('new');f.store.settings(f.a.id,'new',{injectLatestState:true,stateChars:2000})
  const recovered=f.store.restore(f.a.id,'new');assert.ok(recovered.text.length<=2000);assert.match(recovered.text,/当前表达的偏好/);assert.doesNotMatch(recovered.text,/从前会话的独特长句/)
})
