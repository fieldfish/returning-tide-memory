import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {createServer} from 'node:http'
import { createPlugin } from '../index.mjs'

const settle=()=>new Promise(r=>setImmediate(r))
async function harness(t,config={}) {
  const directory=mkdtempSync(join(tmpdir(),'continuity-host-test-')),tools=new Map(),listeners=new Map(),agents=new Map(),contexts=new Map(),errors=[]
  function agent(id) {
    const events=[]
    const a={id,status:'idle',options:{},session:{id,header:{},snapshotEvents:(from=0)=>events.filter(e=>e.seq>=from)},ctx:{systemPrompt:{context:spec=>{const key=spec.name==='continuity-core:recovery'?id:id+':'+spec.name;contexts.set(key,spec);return()=>contexts.delete(key)}}},events,
      cancel:()=>{a.cancelled=true;a.status='idle'},whenIdle:async()=>{},runMaintenance:async fn=>fn(new AbortController().signal)}
    agents.set(id,a);return a
  }
  const a=agent('old'),b=agent('new'),c=agent('other')
  const ctx={tools:{register:s=>{tools.set(s.name,s);return()=>tools.delete(s.name)}},agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},sessions:{flush:async()=>{}},llm:{prepareCall:async cfg=>({config:cfg,retryPolicy:{mode:'normal',maxRetries:0},stream:async function*(){yield {type:'text-delta',text:'{"items":[]}'};yield {type:'usage',usage:{inputTokens:30,outputTokens:5}};yield {type:'finish',reason:{kind:'stop'}}}})},
    on:(name,fn)=>{const list=listeners.get(name)||[];list.push(fn);listeners.set(name,list);return()=>listeners.set(name,(listeners.get(name)||[]).filter(x=>x!==fn))},effect:()=>{},logger:{warn:()=>{}},emit:(...v)=>errors.push(v)}
  const plugin=await createPlugin(ctx,{dataDirectory:directory,...config},{isAgentLoopRequest:o=>o.loop===true})
  const call=(name,args,who=a)=>tools.get(name).execute(args,{agent:who,signal:new AbortController().signal})
  const emit=(name,...args)=>{for(const fn of listeners.get(name)||[])fn(...args)}
  const pre=(who=a,next=async()=>({kind:'enter',messages:[]}))=>(listeners.get('agent/pre-step')[0])({agent:who,messages:[],signal:new AbortController().signal},next)
  const event=(who,type,data,extra={})=>{const e={seq:who.events.length,time:'2026-10-28T10:00:00Z',type,data,...extra};who.events.push(e);emit('session/event',who.session,e);return e}
  const bind=async()=>{const lib=(await call('cm_library',{action:'create',name:'测试伙伴'})).library;await call('cm_library',{action:'bind',library_id:lib.id,expected_revision:0});return plugin.store.library(lib.id)}
  t.after(async()=>{await plugin.dispose();rmSync(directory,{recursive:true,force:true})})
  return {directory,tools,listeners,agents,contexts,ctx,plugin,call,emit,pre,event,bind,a,b,c,agent,errors}
}

test('主动切换注意点触发下步召回，不替旧任务宣称完成',async t=>{
 const h=await harness(t,{workingMemory:{enabled:true}}),lib=await h.bind();h.event(h.a,'user/message',{content:'先做网页，再去游戏'})
 const r=await h.call('cm_working',{action:'focus',query:'先接着游戏的上次进度'});assert.equal(r.recall_scheduled,true)
 const trigger=h.plugin.working.takeTrigger(lib.id,'old',99);assert.equal(trigger.kind,'task-switch');assert.match(trigger.query,/游戏/);assert.equal(h.plugin.store.tasks(lib.id).length,0)
 await assert.rejects(h.call('cm_working',{action:'focus',query:''}),{code:'INVALID_INPUT'});assert.equal(h.plugin.store.library(lib.id).error,null)
})

test('宿主工具线索变化接入召回队列，内部工具与普通鼠标操作不反复触发',async t=>{
 const h=await harness(t,{workingMemory:{enabled:true}}),lib=await h.bind(),hook=h.listeners.get('tools/execute')[0]
 const run=(name,args,id)=>hook({agent:h.a,name,arguments:args,callId:id},async()=>({value:{ok:true}}))
 await run('browser_open',{url:'https://example.org/one'},'ctx-1');await run('desktop_click',{application:'Synthetic Editor'},'ctx-2');await run('desktop_type',{text:'不应进入检索线索'},'ctx-3')
 const trigger=h.plugin.working.takeTrigger(lib.id,'old',10);assert.equal(trigger.kind,'task-switch');assert.match(trigger.query,/Synthetic Editor/);assert.doesNotMatch(trigger.query,/不应进入/);assert.equal(h.plugin.working.takeTrigger(lib.id,'old',10),null)
})

test('纠正索引可以单独恢复，不改主embedding健康或原文',async t=>{
 const h=await harness(t,{memoryDynamics:{enabled:true}}),lib=await h.bind();h.event(h.a,'user/message',{content:'这是一条原文'})
 h.plugin.embedding.memoryDynamics.markFailure(lib.id,{code:'SYNTHETIC_INDEX_ERROR'})
 const r=await h.call('cm_working',{action:'feedback-resume'});assert.equal(r.correction_index.paused,false);assert.equal(h.plugin.embedding.health(lib.id).paused,false);assert.equal(h.plugin.store.report(lib.id).records,1)
})

test('反馈状态省略id可查看最近编号，不报SQLite参数错误',async t=>{
 const h=await harness(t),lib=await h.bind(),result=await h.call('cm_working',{action:'feedback-status',limit:3000})
 const value=JSON.parse(result.feedback.text);assert.deepEqual(value.recent,[]);assert.equal(h.plugin.store.recovery.pending(lib.id).operations.length,0)
})

test('宿主工具注册；首次绑定回填已有原文并提供一次恢复上下文',async t=>{
  const h=await harness(t);h.event(h.a,'user/message',{content:[{type:'text',text:'之前共同约定'}]})
  const lib=await h.bind();assert.equal(h.tools.size,14);assert.equal(h.plugin.store.report(lib.id).records,1);assert.match(h.contexts.get('old').text(),/之前共同约定/)
  await h.pre();h.event(h.a,'assistant/message',{message:{content:[{type:'text',text:'记得约定'}]},usage:{inputTokens:10,cacheReadTokens:90,outputTokens:5}})
  assert.equal(h.contexts.get('old').text(),'');h.event(h.a,'turn/end',{reason:{kind:'completed'}})
  assert.equal(h.plugin.store.report(lib.id).usage[0].input,100)
})

test('原会话编号传入同插件向量模块，用于只读旧笔记导入',async t=>{
  const h=await harness(t,{legacySessionId:'old'});assert.equal(h.plugin.embedding.legacySessionId,'old')
})
test('活动工具可记录时间片段并另读结构化数据，归档成功不等于观看完成',async t=>{
 const h=await harness(t,{activityArchive:{enabled:true}}),lib=await h.bind()
 h.event(h.a,'user/message',{content:'这里是一段供核对的字幕资料'});const ref=h.plugin.store.recent(lib.id)[0].id
 const args={action:'observe',kind:'video',title:'海螺视频片段',body:'主体报告字幕提出了一个想法，尚未实践',source:'https://example.invalid/video',start_ms:1000,end_ms:4000,refs:[ref],idempotency_key:'watch-one:1000:4000'}
 const r=await h.call('cm_activity',args);assert.equal(r.activity.scope,'reported-observation')
 const read=await h.call('cm_activity',{action:'read',id:r.activity.id,limit:6000});assert.equal(JSON.parse(read.activity.text).scope,'reported-observation-not-independently-verified')
 assert.equal((await h.call('cm_read',{id:r.activity.id})).activity.phase,'reported')
 assert.equal((await h.call('cm_activity',args)).activity.id,r.activity.id);assert.equal(h.plugin.store.report(lib.id).records,2)
 assert.equal((await h.call('cm_library',{action:'status'})).activity_archive.reports,1)
 await assert.rejects(h.call('cm_activity',args,h.b),{code:'NOT_BOUND'});assert.equal(h.agents.size,3)
})
test('任务节点保存完整步骤而非五步短卡，没有把激活步骤当执行成功',async t=>{
 const h=await harness(t,{activityArchive:{enabled:true}}),lib=await h.bind();h.event(h.a,'user/message',{content:'准备一个七步计划'})
 const steps=Array.from({length:7},(_,i)=>({id:'s'+i,title:'第'+i+'步',tool:'read'})),plan=await h.call('cm_task',{action:'plan',title:'七步计划',steps})
 assert.equal(plan.task.steps.length,5)
 let id=(await h.call('cm_activity',{action:'list'})).activity.items[0].id,payload=JSON.parse((await h.call('cm_activity',{action:'read',id,limit:6000})).activity.text)
 assert.equal(JSON.parse(payload.body).task.steps.length,7);assert.equal(JSON.parse(payload.body).task.status,'planned')
 await h.call('cm_task',{action:'activate',task_id:plan.task.id,step_id:'s0',expected_revision:plan.task.revision})
 id=(await h.call('cm_activity',{action:'list'})).activity.items[0].id;payload=JSON.parse((await h.call('cm_activity',{action:'read',id,limit:6000})).activity.text)
 assert.equal(JSON.parse(payload.body).task.steps[0].status,'planned');assert.equal(JSON.parse(payload.body).task.steps[0].active,true)
 assert.equal(h.plugin.store.db.prepare('SELECT count(*) n FROM cm_tool_operations').get().n,0);assert.equal(h.plugin.store.library(lib.id).error,null)
})
test('活动归档故障不关停聊天，修复补扫不重放任何工具',async t=>{
 const h=await harness(t,{activityArchive:{enabled:true,maxPayloadBytes:8192},workingMemory:{enabled:true}}),lib=await h.bind()
 h.plugin.embedding.lookup=async()=>({results:[],candidates:[]})
 h.event(h.a,'tool/call',{name:'write',callId:'oversize-native',arguments:{content:'x'.repeat(9000)}})
 assert.equal(h.plugin.activityArchive.health(lib.id).paused,true);assert.equal(h.plugin.store.library(lib.id).error,null)
 h.event(h.a,'user/message',{content:'归档故障期间继续聊天'});await h.pre();assert.match(h.plugin.contextFrame.render(lib.id,'old'),/ACTIVITY_PAYLOAD_LIMIT/)
 h.event(h.a,'assistant/message',{message:{content:'聊天可以继续'}});h.event(h.a,'turn/end',{reason:{kind:'completed'}})
 h.plugin.activityArchive.maxBytes=32768
 const result=await h.call('cm_activity',{action:'resume'});assert.equal(result.activity.maintenance.paused,false);assert.equal(result.activity.payloads,1)
 assert.equal(h.plugin.store.db.prepare("SELECT status FROM cm_tool_operations WHERE call_id='oversize-native'").get().status,'planned');assert.equal(h.plugin.store.library(lib.id).error,null)
})
test('情境语义检索可通过同一宿主工具访问，不新建会话或切换焦点',async t=>{
 const h=await harness(t,{situationIndex:{enabled:true}}),lib=await h.bind()
 h.plugin.embedding.identity=async()=>{h.plugin.embedding.cached='synthetic';return 'synthetic'};h.plugin.embedding.embed=async inputs=>inputs.map(()=>[1,0]);h.plugin.embedding.warm=async()=>({skipped:'synthetic'})
 h.event(h.a,'user/message',{content:'海螺潮声作品的原始目标'});const ref=h.plugin.store.recent(lib.id)[0].id
 const created=await h.call('cm_situation',{action:'create',title:'海螺潮声作品',refs:[ref]})
 assert.equal((await h.call('cm_situation',{action:'index-status'})).situation_index.pending_situations,1)
 await h.call('cm_situation',{action:'index-warm'});const search=await h.call('cm_situation',{action:'search',query:'海螺潮声作品'})
 assert.equal(search.situations.available,true);assert.equal(search.situations.results[0].id,created.situation.id);assert.equal((await h.call('cm_library',{action:'status'})).situation_index.indexed_situations,1)
 assert.equal(h.plugin.situations.current(lib.id,'old'),null);assert.equal(h.agents.size,3);assert.equal(h.plugin.store.list().length,1);assert.equal(h.plugin.store.record(lib.id,ref).text,'海螺潮声作品的原始目标')
})
test('情境向量故障有独立不可用状态，不关停主库或原文检索',async t=>{
 const h=await harness(t,{situationIndex:{enabled:true}}),lib=await h.bind()
 h.plugin.embedding.identity=async()=>{throw Object.assign(Error('synthetic offline'),{code:'EMBEDDING_UNAVAILABLE'})}
 await assert.rejects(h.call('cm_situation',{action:'search',query:'海螺潮声作品'}),{code:'EMBEDDING_UNAVAILABLE'})
 const paused=await h.call('cm_situation',{action:'search',query:'海螺潮声作品'})
 assert.equal(paused.situations.status,'unavailable');assert.equal(paused.situations.available,false);assert.equal(h.plugin.embedding.health(lib.id).paused,false);assert.equal(h.plugin.store.library(lib.id).error,null)
 await h.pre();h.event(h.a,'assistant/message',{message:{content:'仍然正常交流'}});h.event(h.a,'turn/end',{reason:{kind:'completed'}})
 assert.equal(h.plugin.store.recent(lib.id).at(-1).text,'仍然正常交流')
})
test('宿主使用反馈接到同一插件，分页可核查、可撤销，不新建主会话或改原文',async t=>{
 const h=await harness(t,{memoryDynamics:{enabled:true}}),lib=await h.bind();h.plugin.embedding.warm=async()=>({skipped:'synthetic'})
 h.event(h.a,'user/message',{content:'旧导航配色是蓝色'});const id=h.plugin.store.recent(lib.id)[0].id
 h.event(h.a,'assistant/message',{message:{content:'引用 '+h.plugin.store.shortId(lib.id,id)+' 后，我修好了导航'}});const ref=h.plugin.store.recent(lib.id).at(-1).id
 const receipt=await h.call('cm_working',{action:'feedback',id,kind:'cited',refs:[ref],reason:'有实际引用记录'})
 assert.equal(receipt.feedback.kind,'cited');assert.equal((await h.call('cm_working',{action:'status'})).memory_dynamics.enabled,true)
 const full=await h.call('cm_working',{action:'feedback-status',id,limit:3000}),page=await h.call('cm_working',{action:'feedback-status',id,limit:100})
 assert.equal(JSON.parse(full.feedback.text).recent[0].id,receipt.feedback.id);assert.equal(Array.from(page.feedback.text).length,100);assert.ok(page.feedback.next_offset)
 await assert.rejects(h.call('cm_working',{action:'feedback',id,kind:'helpful',refs:[ref],reason:'另一窗口'},h.b),{code:'NOT_BOUND'})
 h.event(h.a,'user/message',{content:'刚才那次引用记录需要撤销'});const undo=h.plugin.store.recent(lib.id).at(-1).id
 const retracted=await h.call('cm_working',{action:'feedback-retract',feedback_id:receipt.feedback.id,refs:[undo],reason:'按新依据撤销'})
 assert.equal(retracted.feedback.retracted,true);assert.equal(h.plugin.store.record(lib.id,id).text,'旧导航配色是蓝色');assert.equal(h.plugin.store.list().length,1);assert.equal(h.agents.size,3)
})
test('空闲认识与情境整理轮流推进，共用宿主维护入口且不并行',async t=>{
 const h=await harness(t),lib=await h.bind();h.plugin.embedding.warm=async()=>({skipped:'synthetic'})
 h.event(h.a,'user/message',{content:'合成长记录。'.repeat(600)})
 const order=[];let active=0
 h.ctx.llm.prepareCall=async()=>({config:{},retryPolicy:{mode:'normal',maxRetries:0},stream:async function*(args){active++;assert.equal(active,1);try{const kind=args.system.includes('增量整理成有出处的情境')?'consolidate':'extract';order.push(kind);yield {type:'text-delta',text:kind==='consolidate'?'{"updates":[]}':'{"items":[]}'};yield {type:'finish',reason:{kind:'stop'}}}finally{active--}}})
 await h.call('cm_extraction',{action:'configure',config:{source:'dsh',provider:'test',model:'test',situationsEnabled:true,maxInputChars:2400,minIntervalMs:0,maxCallsPerDay:100}})
 await h.call('cm_extraction',{action:'resume'});await h.call('cm_situation',{action:'maintenance-resume'})
 const deadline=Date.now()+2000;while(order.length<4&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5))
 h.plugin.extraction.pause(lib.id);h.plugin.consolidation.pause(lib.id)
 assert.deepEqual(order.slice(0,4),['extract','consolidate','extract','consolidate']);assert.equal(h.plugin.store.library(lib.id).error,null)
})
test('后台情境输出错误只暂停该功能，主会话和归档仍可继续',async t=>{
 const h=await harness(t),lib=await h.bind();h.plugin.embedding.warm=async()=>({skipped:'synthetic'})
 h.event(h.a,'user/message',{content:'合成新经历'})
 h.ctx.llm.prepareCall=async()=>({config:{},retryPolicy:{mode:'normal',maxRetries:0},stream:async function*(){yield {type:'text-delta',text:'broken-json'};yield {type:'finish',reason:{kind:'stop'}}}})
 await h.call('cm_extraction',{action:'configure',config:{source:'dsh',provider:'test',model:'test',situationsEnabled:true,minIntervalMs:0}})
 await h.call('cm_situation',{action:'maintenance-resume'})
 const deadline=Date.now()+1500;while(!h.plugin.consolidation.status(lib.id).error&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5))
 assert.equal(h.plugin.consolidation.status(lib.id).error,'INVALID_MODEL_OUTPUT');assert.equal(h.plugin.store.library(lib.id).error,null)
 await h.pre();h.event(h.a,'assistant/message',{message:{content:'聊天继续'}});h.event(h.a,'turn/end',{reason:{kind:'completed'}})
 assert.equal(h.plugin.store.recent(lib.id).at(-1).text,'聊天继续');assert.equal(h.errors.length,0)
})
test('实验工作记忆启用后只挂一个统一上下文，旧恢复段不叠加',async t=>{
  const h=await harness(t,{workingMemory:{enabled:true}});h.event(h.a,'user/message',{content:'合成历史原文'});await h.bind()
  assert.equal(h.contexts.size,1);const spec=h.contexts.get('old:continuity-core:memory-frame');assert.ok(spec)
  assert.ok(Array.from(spec.text()).length<=1800);assert.match(spec.text(),/合成历史原文/)
  h.event(h.a,'assistant/message',{message:{content:'已接上'}});assert.equal(spec.text(),'')
})
test('情境工具接线可写版本、关联实时原文、分页读档而不生成完成事实',async t=>{
  const h=await harness(t,{workingMemory:{enabled:true}});await h.bind();h.event(h.a,'user/message',{content:'先做海边视频'})
  const lib=h.plugin.store.binding('old').library,ref=h.plugin.store.recent(lib).at(-1).id
  const created=await h.call('cm_situation',{action:'create',title:'海边视频',refs:[ref],mode:'experience'}),id=created.situation.id
  await h.call('cm_situation',{action:'focus',id});h.event(h.a,'assistant/message',{message:{content:'先把片头做了，其他还没完成'}})
  assert.equal(h.plugin.situations.get(lib,id).source_count,2);assert.equal(h.plugin.situations.get(lib,id).assertions.length,0)
  const update=await h.call('cm_situation',{action:'update',id,expected_revision:1,refs:[ref],reason:'计划自述',assertions:[{slot:'goal',body:'打算做视频',refs:[ref]}]})
  assert.equal(update.situation.revision,2);assert.ok((await h.call('cm_situation',{action:'read',id,limit:100})).document.next_offset)
  await h.call('cm_situation',{action:'focus',clear:true});assert.equal(h.plugin.situations.current(lib,'old'),null)
})
test('新任务和工具失败触发一次召回，同消息后续步骤不重复搜且不带工具私密参数',async t=>{
  const h=await harness(t,{workingMemory:{enabled:true}});await h.bind();h.event(h.a,'turn/start',{});h.event(h.a,'user/message',{content:'整理一下过去网页的记录'})
  const queries=[];h.plugin.embedding.lookup=async(_lib,_session,q)=>{queries.push(q);return {results:[],candidates:[]}}
  await h.pre();assert.equal(queries.length,1)
  await h.call('cm_task',{action:'plan',title:'制作视频',steps:[{id:'a',title:'看资料',tool:'read'}]});await h.pre();await h.pre();assert.equal(queries.length,2);assert.equal(queries[1],'制作视频')
  const guard=h.listeners.get('tools/execute')[0]
  await guard({agent:h.a,name:'desktop_click',callId:'failed-test',arguments:{token:'SECRET-SYNTHETIC'}},async()=>({error:{code:'INVALID_INPUT'}}))
  await h.pre();await h.pre();assert.equal(queries.length,3);assert.match(queries[2],/desktop_click/);assert.ok(!queries.join('').includes('SECRET-SYNTHETIC'))
  assert.equal(h.plugin.store.library(h.plugin.store.binding('old').library).error,null)
})
test('统一工作集手动清空不删上下文和原文，同条用户消息不会自动补回',async t=>{
  const h=await harness(t,{workingMemory:{enabled:true}});const lib=await h.bind();h.event(h.a,'user/message',{content:'过去的小屋是什么样'})
  let calls=0;h.plugin.embedding.lookup=async()=>{calls++;return {results:[],candidates:[]}}
  await h.pre();const events=h.a.events.length,raw=h.plugin.store.report(lib.id).records
  await h.call('cm_working',{action:'clear'});await h.pre();assert.equal(calls,1);assert.equal(h.a.events.length,events);assert.equal(h.plugin.store.report(lib.id).records,raw)
})

test('宿主查询把当前原生回合起点交给检索器以排除自身提问',async t=>{
  const h=await harness(t);await h.bind();h.event(h.a,'turn/start',{});h.event(h.a,'user/message',{content:'本轮问题'})
  let seen;h.plugin.embedding.lookup=async(...args)=>{seen=args[5];return {results:[]}}
  await h.call('cm_lookup',{query:'本轮问题'})
  assert.deepEqual(seen,{session:'old',fromSeq:0})
})
test('压缩替代文本不冒充原经历，compaction/end之后重新恢复原文',async t=>{
  const h=await harness(t),lib=await h.bind();h.event(h.a,'user/message',{content:'真实原句'});h.event(h.a,'assistant/message',{message:{content:'原回复'}})
  h.event(h.a,'user/message',{content:'错误压缩摘要'},{surfaceOp:{op:'replace',startSeq:0,endSeq:1}});h.event(h.a,'compaction/end',{})
  const recovered=h.contexts.get('old').text();assert.match(recovered,/真实原句/);assert.doesNotMatch(recovered,/错误压缩摘要/);assert.equal(h.plugin.store.report(lib.id).records,2)
})
test('同库运行拦截，交接必须等待旧执行达到idle',async t=>{
  const h=await harness(t),lib=await h.bind();h.event(h.a,'user/message',{content:'待交接的原文'});await h.pre();h.a.status='running'
  let release;h.a.whenIdle=()=>new Promise(r=>{release=r})
  const moving=h.call('cm_library',{action:'handoff',library_id:lib.id,expected_revision:lib.revision},h.b)
  await settle();assert.equal(h.plugin.store.library(lib.id).owner,'old');assert.equal(h.a.cancelled,true)
  release();await moving;assert.equal(h.plugin.store.library(lib.id).owner,'new');assert.match(h.contexts.get('new').text(),/待交接的原文/)
  await assert.rejects(h.pre(h.a),{code:'NOT_OWNER'});await h.pre(h.b)
})
test('不能把未加载旧会话当作已经停止并强行接手',async t=>{
  const h=await harness(t),lib=await h.bind();h.agents.delete('old')
  await assert.rejects(h.call('cm_library',{action:'handoff',library_id:lib.id,expected_revision:lib.revision},h.b),{code:'OLD_SESSION_UNVERIFIED'});assert.equal(h.plugin.store.library(lib.id).owner,'old')
})
test('B站式子代理可运行，主会话独占记忆；子代理不能直接调用库工具',async t=>{
  const h=await harness(t),lib=await h.bind(),child=h.agent('child');child.session.header.parentSession='old'
  await h.pre();await h.pre(child)
  const guard=h.listeners.get('tools/execute')[0]
  assert.deepEqual(await guard({agent:h.a,name:'subagent',callId:'synthetic-subagent'},async()=>({ok:true})),{ok:true})
  await assert.rejects(h.call('cm_library',{action:'list'},child),{code:'CHILD_MEMORY_DENIED'})
  await assert.rejects(guard({agent:child,name:'cm_lookup'},async()=>({})),{code:'CHILD_MEMORY_DENIED'})
  const stream=h.listeners.get('llm/stream')[0]
  const chunks=[];for await(const part of stream({sessionId:'child',loop:true},async function*(){yield {type:'text-delta',text:'片子摘要'}}))chunks.push(part)
  assert.equal(chunks[0].text,'片子摘要')
  assert.equal(h.plugin.store.library(lib.id).owner,'old')
  assert.equal(h.plugin.store.binding('child'),null)
  assert.equal(h.contexts.has('child'),false)
})

test('子代理仍在运行时拒绝记忆库交接；结束后才交接',async t=>{
  const h=await harness(t),lib=await h.bind(),child=h.agent('child');child.session.header.parentSession='old';child.status='running'
  await assert.rejects(h.call('cm_library',{action:'handoff',library_id:lib.id,expected_revision:lib.revision},h.b),{code:'CHILD_STILL_RUNNING'})
  assert.equal(h.plugin.store.library(lib.id).owner,'old')
  child.status='idle';await h.call('cm_library',{action:'handoff',library_id:lib.id,expected_revision:lib.revision},h.b)
  assert.equal(h.plugin.store.library(lib.id).owner,'new')
  await assert.rejects(h.pre(child),{code:'HANDOFF_IN_PROGRESS'})
})

test('子代理忙时空闲提炼跳过，不误报为记忆库故障',async t=>{
  const h=await harness(t),lib=await h.bind(),child=h.agent('child');child.session.header.parentSession='old';child.status='running'
  h.event(h.a,'user/message',{content:'值得整理的经历'})
  h.plugin.extraction.configure(lib.id,'old',{source:'dsh',provider:'p',model:'m'});h.plugin.extraction.resume(lib.id,'old')
  await h.plugin.idleExtraction(h.a)
  assert.equal(h.plugin.extraction.status(lib.id).paused,false)
  assert.equal(h.plugin.store.library(lib.id).error,null)
  child.status='idle';await h.plugin.idleExtraction(h.a)
  assert.equal(h.plugin.extraction.status(lib.id).paused,false)
})

test('孙级子代理同样不能读取主会话库，运行时阻止交接',async t=>{
  const h=await harness(t),lib=await h.bind(),child=h.agent('child'),grandchild=h.agent('grandchild')
  child.session.header.parentSession='old';grandchild.session.header.parentSession='child';grandchild.status='running'
  await h.pre(grandchild)
  await assert.rejects(h.call('cm_library',{action:'list'},grandchild),{code:'CHILD_MEMORY_DENIED'})
  await assert.rejects(h.call('cm_library',{action:'handoff',library_id:lib.id,expected_revision:lib.revision},h.b),{code:'CHILD_STILL_RUNNING'})
  assert.equal(h.plugin.store.library(lib.id).owner,'old')
})
test('工具调用来源事件再次回填，不重复写入旧记忆结果',async t=>{
  const h=await harness(t),lib=await h.bind()
  h.event(h.a,'tool/call',{call:{id:'call',name:'run_code',arguments:{code:'await tools.cm_read({id:"r"})'}}})
  h.event(h.a,'tool/result',{message:{toolCallId:'call',content:'不应再次入库的旧经历'}})
  h.plugin.capture.backfill(lib.id,h.a.session);assert.equal(h.plugin.store.report(lib.id).records,0)
})
test('宿主不具备原文读取能力时bind不提交',async t=>{
  const h=await harness(t),lib=(await h.call('cm_library',{action:'create',name:'待绑定'})).library;delete h.a.session.snapshotEvents
  await assert.rejects(h.call('cm_library',{action:'bind',library_id:lib.id,expected_revision:0}),{code:'HOST_API_UNAVAILABLE'});assert.equal(h.plugin.store.library(lib.id).owner,null)
})
test('主模型失败不调用下游重试策略，不影响其他未绑定会话',async t=>{
  const h=await harness(t),lib=await h.bind(),handler=h.listeners.get('agent/request-error')[0];let retries=0
  await handler({agent:h.a},async()=>{retries++;return {kind:'retry'}});assert.equal(retries,0);assert.equal(h.plugin.store.library(lib.id).error,'MAIN_REQUEST_FAILED');assert.ok(h.errors.length)
  await handler({agent:h.c},async()=>{retries++;return {kind:'retry'}});assert.equal(retries,1)
})

for(const code of ['TRANSPORT','TIMEOUT','ABORTED'])test(`${code}结束本轮且不重试；后续新轮仍可开始，原文与绑定不变`,async t=>{
 const h=await harness(t),lib=await h.bind(),handler=h.listeners.get('agent/request-error')[0]
 h.event(h.a,'user/message',{content:'故障前保存的原句'});await h.pre()
 const oldRecord=h.plugin.store.recent(lib.id)[0];let retried=0
 await handler({agent:h.a,failure:{code,message:'synthetic provider failure'}},async()=>{retried++;return {kind:'retry'}})
 assert.equal(retried,0);assert.equal(h.plugin.store.library(lib.id).error,null)
 assert.ok(h.plugin.store.busy(lib.id),'本轮真正结束前不能释放运行权')
 h.event(h.a,'turn/end',{reason:{kind:'error'}})
 assert.equal(h.plugin.store.busy(lib.id),null)
 await h.pre();h.event(h.a,'turn/end',{reason:{kind:'completed'}})
 assert.deepEqual(h.plugin.store.record(lib.id,oldRecord.id),oldRecord)
 assert.equal(h.plugin.store.library(lib.id).owner,'old')
 assert.equal(h.plugin.store.db.prepare("SELECT count(*) n FROM audit WHERE library=? AND type='main-request-ended'").get(lib.id).n,1)
})

test('模型连接失败不能清除先前的原文采集或向量故障',async t=>{
 const h=await harness(t),lib=await h.bind(),handler=h.listeners.get('agent/request-error')[0]
 h.plugin.store.pause(lib.id,'SOURCE_CHANGED')
 await handler({agent:h.a,failure:{code:'TRANSPORT'}},async()=>assert.fail('不得重试'))
 assert.equal(h.plugin.store.library(lib.id).error,'SOURCE_CHANGED')
 await handler({agent:h.a,failure:{code:'UNEXPECTED'}},async()=>assert.fail('不得重试'))
 assert.equal(h.plugin.store.library(lib.id).error,'SOURCE_CHANGED')
 await assert.rejects(h.pre(),{code:'PAUSED'})
})

test('未知模型失败及鉴权失败仍暂停，其他会话的错误不影响本库',async t=>{
 const h=await harness(t),lib=await h.bind(),handler=h.listeners.get('agent/request-error')[0]
 let next=0
 await handler({agent:h.c,failure:{code:'TRANSPORT'}},async()=>{next++})
 assert.equal(next,1);assert.equal(h.plugin.store.library(lib.id).error,null)
 await handler({agent:h.a,failure:{code:'HTTP_401'}},async()=>assert.fail('不得重试'))
 assert.equal(h.plugin.store.library(lib.id).error,'MAIN_REQUEST_FAILED')
})
test('DSH提炼适配器检查重试策略，未达0次就报错暂停',async t=>{
  const h=await harness(t),lib=await h.bind();h.event(h.a,'user/message',{content:'有出处的待提炼材料'})
  h.ctx.llm.prepareCall=async()=>({retryPolicy:{mode:'normal',maxRetries:5}})
  h.plugin.extraction.configure(lib.id,'old',{source:'dsh',provider:'p',model:'m'});h.plugin.extraction.resume(lib.id,'old')
  await assert.rejects(h.plugin.extraction.run(lib.id,'old'),{code:'NO_RETRY_GUARANTEE'});assert.equal(h.plugin.extraction.status(lib.id).paused,true)
})
test('空闲提炼使用runMaintenance，主会话活动期间不提炼',async t=>{
  const h=await harness(t),lib=await h.bind();h.event(h.a,'user/message',{content:'待整理的可见原文'});let calls=0
  h.a.runMaintenance=async fn=>{calls++;return fn(new AbortController().signal)}
  h.plugin.extraction.configure(lib.id,'old',{source:'dsh',provider:'p',model:'m'});h.plugin.extraction.resume(lib.id,'old')
  h.a.status='running';await h.plugin.idleExtraction(h.a);assert.equal(calls,0)
  h.a.status='idle';await h.plugin.idleExtraction(h.a);assert.equal(calls,1);assert.equal(h.plugin.store.busy(lib.id),null)
})
test('LLM流拦截并发与无法归属的辅助调用',async t=>{
  const h=await harness(t),lib=await h.bind();await h.pre()
  const guard=h.listeners.get('llm/stream')[0],run=async request=>{for await(const _ of guard(request,async function*(){yield {type:'finish',reason:{kind:'stop'}}})){} }
  await assert.rejects(run({sessionId:'old',loop:false}),{code:'SECOND_MODEL_NOT_ALLOWED'})
  await assert.rejects(run({}),{code:'UNATTRIBUTED_MODEL_CALL'})
  let release;const wait=new Promise(r=>{release=r});const first=guard({sessionId:'old',loop:true},async function*(){await wait;yield {type:'finish',reason:{kind:'stop'}}})
  const pending=first.next();await settle();await assert.rejects(run({sessionId:'old',loop:true}),{code:'SECOND_MODEL_NOT_ALLOWED'});release();await pending;await first.return()
})
test('不同记忆库主会话可独立运行',async t=>{
  const h=await harness(t);await h.bind();const b=(await h.call('cm_library',{action:'create',name:'另一份库'},h.c)).library
  await h.call('cm_library',{action:'bind',library_id:b.id,expected_revision:0},h.c);await h.pre(h.a);await h.pre(h.c)
  assert.equal(h.plugin.store.db.prepare('SELECT count(*) n FROM activity').get().n,2)
})
test('回填中发现坏原文时绑定和已导入前缀一并回滚',async t=>{
  const h=await harness(t),lib=(await h.call('cm_library',{action:'create',name:'原子绑定'})).library
  h.event(h.a,'user/message',{content:'第一条有效'});h.a.events.push({seq:1,time:'bad-time',type:'user/message',data:{content:'第二条坏时间'}})
  await assert.rejects(h.call('cm_library',{action:'bind',library_id:lib.id,expected_revision:0}),{code:'INVALID_INPUT'})
  assert.equal(h.plugin.store.library(lib.id).owner,null);assert.equal(h.plugin.store.report(lib.id).records,0)
  h.a.events[1].time='2026-10-28T10:00:00Z';await h.call('cm_library',{action:'bind',library_id:lib.id,expected_revision:0});assert.equal(h.plugin.store.report(lib.id).records,2)
})
test('有排队消息时交接拒绝，不覆盖草稿和排队输入',async t=>{
  const h=await harness(t),lib=await h.bind();h.a.inbox={nextTurn:[{id:'pending'}],nextStep:[]}
  await assert.rejects(h.call('cm_library',{action:'handoff',library_id:lib.id,expected_revision:lib.revision},h.b),{code:'PENDING_INPUT'})
  assert.equal(h.a.cancelled,undefined);assert.equal(h.a.inbox.nextTurn[0].id,'pending')
})
test('主库错误后可由未绑定维护会话手动恢复，原会话须空闲',async t=>{
  const h=await harness(t),lib=await h.bind();h.plugin.store.pause(lib.id,'FAULT');h.a.status='running'
  await assert.rejects(h.call('cm_library',{action:'resume',library_id:lib.id},h.c),{code:'OLD_SESSION_UNVERIFIED'})
  h.a.status='idle';await h.call('cm_library',{action:'resume',library_id:lib.id},h.c);assert.equal(h.plugin.store.library(lib.id).error,null)
})

test('向量服务出错仅暂停向量维护，聊天与原文不锁；修复后显式恢复',async t=>{
  let calls=0
  const server=createServer(async(req,res)=>{
    if(req.url==='/api/tags'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{name:'fixture-embedding',digest:'fixture-digest'}]}));return}
    if(req.url==='/api/embed'){calls++;res.writeHead(500);res.end('failed');return}
    res.writeHead(404);res.end()
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
  const h=await harness(t,{embedding:{ollamaUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture-embedding'}})
  const lib=await h.bind();h.event(h.a,'user/message',{content:'代理今天想整理书桌'})
  await assert.rejects(h.call('cm_lookup',{query:'代理'}),{code:'EMBEDDING_UNAVAILABLE'})
  assert.equal(h.plugin.store.library(lib.id).error,null)
  assert.equal(h.plugin.embedding.health(lib.id).paused,true);await h.plugin.idleEmbedding(h.a);assert.equal(calls,1)
  await h.pre();h.event(h.a,'assistant/message',{message:{content:'仍能正常对话'}});h.event(h.a,'turn/end',{reason:{kind:'completed'}})
  assert.ok(h.plugin.store.recent(lib.id).some(r=>r.text==='仍能正常对话'));assert.equal(calls,1)
  await h.call('cm_library',{action:'embedding-resume'});assert.equal(h.plugin.embedding.health(lib.id).paused,false)
})

test('空闲整理能持续分批推进，不必每批再发一条消息；暂停后不再调用',async t=>{
 const h=await harness(t),lib=await h.bind();h.plugin.embedding.warm=async()=>({skipped:'synthetic-test'})
 for(let i=0;i<6;i++)h.event(h.a,'user/message',{content:'有来源的合成记录。'.repeat(20)})
 let calls=0;h.ctx.llm.prepareCall=async()=>{calls++;return {config:{},retryPolicy:{mode:'normal',maxRetries:0},stream:async function*(){yield {type:'text-delta',text:'{"items":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}}
 h.plugin.extraction.configure(lib.id,'old',{source:'dsh',provider:'p',model:'m',minIntervalMs:0,maxInputChars:1100})
 h.plugin.extraction.resume(lib.id,'old');h.emit('agent/status',{agent:h.a,status:'idle'})
 const last=h.plugin.store.db.prepare('SELECT MAX(rowid) n FROM records WHERE library=?').get(lib.id).n
 const stop=Date.now()+1500
 while(h.plugin.extraction.status(lib.id).cursor<last&&Date.now()<stop)await new Promise(r=>setTimeout(r,10))
 assert.equal(h.plugin.extraction.status(lib.id).cursor,last);assert.ok(calls>1)
 h.plugin.extraction.pause(lib.id);h.event(h.a,'user/message',{content:'暂停后不应调用'});h.emit('agent/status',{agent:h.a,status:'idle'});await new Promise(r=>setTimeout(r,40));const count=calls;assert.ok(count>1);assert.equal(h.plugin.extraction.status(lib.id).paused,true)
})

test('认可候选兼容真实模型使用expected_revision的参数；冲突别名拒绝',async t=>{
 const h=await harness(t),lib=await h.bind();h.event(h.a,'user/message',{content:'合成偏好依据'})
 const rid=h.plugin.store.recent(lib.id)[0].id
 h.plugin.store.propose(lib.id,{key:'pref',kind:'preference',body:'新的偏好',reason:'有原文',refs:[rid]})
 const accepted=await h.call('cm_self',{action:'accept',key:'pref',expected_revision:1})
 assert.equal(accepted.entry.accepted,true)
 await assert.rejects(h.call('cm_self',{action:'accept',key:'pref',revision:1,expected_revision:2}),{code:'INVALID_INPUT'})
})

test('读取旧来源会提供认识版本线索，时间线区分候选与当前认可',async t=>{
 const h=await harness(t),lib=await h.bind();h.event(h.a,'user/message',{content:'原来用蓝色。'});const old=h.plugin.store.recent(lib.id)[0].id
 h.plugin.store.propose(lib.id,{key:'palette',kind:'preference',body:'蓝色',reason:'旧来源',refs:[old]},true)
 h.event(h.a,'user/message',{content:'现在改成青色。'});const next=h.plugin.store.recent(lib.id).at(-1).id
 h.plugin.store.propose(lib.id,{key:'palette',kind:'preference',body:'青色',reason:'新来源',refs:[next],expectedRevision:1},true)
 const source=await h.call('cm_read',{id:old});assert.equal(source.state_links[0].has_later_accepted,true)
 const report=await h.call('cm_self',{action:'timeline',key:'palette',limit:6000});assert.equal(JSON.parse(report.timeline.text).current.revision,2)
 const relations=await h.call('cm_self',{action:'related',refs:[old],limit:6000});assert.equal(JSON.parse(relations.relations.text).links[0].current_revision,2)
})

test('证据核验取消经过宿主工具包装后，不留下未知外部动作锁',async t=>{
 const h=await harness(t),lib=await h.bind();h.event(h.a,'user/message',{content:'有一条证据原文。'});const rid=h.plugin.store.recent(lib.id)[0].id
 h.plugin.extraction.configure(lib.id,'old',{source:'dsh',provider:'synthetic',model:'synthetic',evidenceEnabled:true,maxInputChars:4000})
 const control=new AbortController();h.plugin.extraction.model.dshCall=args=>new Promise((_,reject)=>{args.signal.addEventListener('abort',()=>reject(args.signal.reason),{once:true});setImmediate(()=>control.abort())})
 const exec={callId:'cancel-evidence-host',name:'cm_evidence',arguments:{query:'有什么原文',ids:[rid]},agent:h.a,signal:control.signal},wrapper=h.listeners.get('tools/execute')[0]
 await assert.rejects(wrapper(exec,()=>h.tools.get('cm_evidence').execute(exec.arguments,exec)),{code:'CANCELLED'})
 assert.equal(h.plugin.store.recovery.needsReview(lib.id),false);assert.equal(h.plugin.evidence.status(lib.id).paused,0);assert.equal(h.plugin.store.library(lib.id).error,null)
})

test('模型任务状态始终分页精简，完整执行结果不重新塞进上下文',async t=>{
 const h=await harness(t),lib=await h.bind(),steps=Array.from({length:7},(_,i)=>({id:'s'+i,title:'合成步骤'.repeat(20),tool:'write'}))
 const planned=await h.call('cm_task',{action:'plan',title:'分页测试',steps}),id=planned.task.id
 assert.equal(planned.task.steps.length,5);assert.equal(planned.task.next_offset,5)
 const next=await h.call('cm_task',{action:'status',task_id:id,offset:5,limit:5})
 assert.equal(next.task.steps.length,2);assert.equal(next.task.next_offset,null)
 assert.ok(JSON.stringify(planned).length<3000);assert.equal('operation' in planned.task.steps[0],false)
 await assert.rejects(h.call('cm_task',{action:'status',task_id:id,limit:6}),{code:'INVALID_INPUT'})
 await assert.rejects(h.call('cm_task',{action:'list',offset:-1}),{code:'INVALID_INPUT'})
 assert.equal(h.plugin.store.library(lib.id).error,null)
})

test('模型可以翻到第35个任务并暂停继续，未执行任何步骤',async t=>{
 const h=await harness(t),lib=await h.bind();let first
 for(let i=0;i<35;i++){const v=h.plugin.execution.plan(lib.id,'old','task '+i,[{id:'one',title:'one',tool:'write'}]);first??=v.id}
 const page=await h.call('cm_task',{action:'list',offset:30,limit:5});assert.equal(page.total,35);assert.equal(page.next_offset,null);assert.ok(page.tasks.some(t=>t.id===first))
 let task=(await h.call('cm_task',{action:'status',task_id:first})).task
 task=(await h.call('cm_task',{action:'pause',task_id:first,expected_revision:task.revision})).task;assert.equal(task.paused,true)
 task=(await h.call('cm_task',{action:'resume',task_id:first,expected_revision:task.revision})).task;assert.equal(task.paused,false)
 assert.equal(h.plugin.store.db.prepare('SELECT count(*) n FROM cm_tool_operations').get().n,0)
})

test('空闲向量维护会分批补齐，用户开始新轮后停止继续调度',async t=>{
 const h=await harness(t),lib=await h.bind();let pending=3,calls=0
 h.plugin.embedding.status=()=>({index_work_remaining:pending>0})
 h.plugin.embedding.warm=async()=>{calls++;pending--;return {indexed:1}}
 await h.plugin.idleEmbedding(h.a);h.a.status='running'
 await new Promise(r=>setTimeout(r,550));assert.equal(calls,1)
 h.a.status='idle';await h.plugin.idleEmbedding(h.a)
 const until=Date.now()+1500;while(pending>0&&Date.now()<until)await new Promise(r=>setTimeout(r,20))
 assert.equal(pending,0);assert.equal(calls,3);await new Promise(r=>setTimeout(r,550));assert.equal(calls,3);assert.equal(h.plugin.store.library(lib.id).error,null)
})
