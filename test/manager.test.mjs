import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPlugin} from '../index.mjs'

async function fixture(t,config={}){
 const directory=mkdtempSync(join(tmpdir(),'cm-manager-')),tools=new Map(),agents=new Map(),listeners=new Map()
 const agent={status:'idle',session:{id:'synthetic-manager-owner',header:{},snapshotEvents:()=>[]},ctx:{systemPrompt:{context:()=>()=>{}}},inbox:{},cancel:()=>{},whenIdle:async()=>{}}
 agents.set(agent.session.id,agent);let modelCalls=0
 const ctx={agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},sessions:{flush:async()=>{}},llm:{prepareCall:()=>{modelCalls++;throw Error('must not invoke a model')}},tools:{register:s=>{tools.set(s.name,s);return()=>tools.delete(s.name)}},on:(name,fn)=>{const list=listeners.get(name)||[];list.push(fn);listeners.set(name,list);return()=>{}},effect:()=>{},logger:{warn:()=>{}}}
 const plugin=await createPlugin(ctx,{dataDirectory:directory,manager:{enabled:true},...config},{isAgentLoopRequest:()=>true})
 t.after(async()=>{await plugin.dispose();rmSync(directory,{recursive:true,force:true})})
 const token=new URL(plugin.manager.url).hash.slice(1)
 async function api(action,args={},headers={}){const response=await fetch(plugin.manager.origin+'/api',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,...headers},body:JSON.stringify({action,...args})});return {http:response.status,...await response.json()}}
 return {plugin,agent,directory,api,modelCalls:()=>modelCalls}
}

test('管理页可只读核对淡出与使用依据；不开模型、不允许跨库读取',async t=>{
 const f=await fixture(t),created=await f.api('create',{name:'使用反馈管理'}),library_id=created.result.library.id
 await f.api('bind',{library_id,session:f.agent.session.id,expected_revision:0})
 const store=f.plugin.store,id=store.append(library_id,{session:'history',seq:1,time:'2020-01-01T00:00:00Z',role:'user',text:'很早的记录'}),ref=store.append(library_id,{session:'history',seq:2,time:'2026-10-29T08:00:00Z',role:'assistant',text:'旧记录帮上忙了'})
 f.plugin.embedding.memoryDynamics.record(library_id,f.agent.session.id,{id,kind:'helpful',refs:[ref],reason:'实际使用的自述'})
 const r=await f.api('memory-dynamics',{library_id,id:store.shortId(library_id,id)})
 assert.equal(r.ok,true);assert.equal(r.result.recent[0].kind,'helpful');assert.equal(r.result.enabled,false)
 const other=(await f.api('create',{name:'另一库'})).result.library.id
 assert.equal((await f.api('memory-dynamics',{library_id:other,id})).error,'NOT_FOUND')
 assert.equal((await f.api('inspect',{library_id})).result.memory_dynamics.enabled,false);assert.equal(f.modelCalls(),0);assert.equal(store.record(library_id,id).text,'很早的记录')
})
test('管理页可查看情境索引、补建及语义候选，查询不会修改原文或情境',async t=>{
 const f=await fixture(t,{situationIndex:{enabled:true}}),created=await f.api('create',{name:'情境候选管理'}),library_id=created.result.library.id
 await f.api('bind',{library_id,session:f.agent.session.id,expected_revision:0})
 f.plugin.embedding.identity=async()=>{f.plugin.embedding.cached='synthetic';return 'synthetic'};f.plugin.embedding.embed=async inputs=>inputs.map(()=>[1,0]);f.plugin.embedding.warm=async()=>({skipped:'synthetic'})
 const ref=f.plugin.store.append(library_id,{session:'history',seq:1,time:'2026-10-01T08:00:00Z',role:'user',text:'海螺作品的目标'}),s=f.plugin.situations.create(library_id,f.agent.session.id,{title:'海螺作品',refs:[ref]})
 assert.equal((await f.api('inspect',{library_id})).result.situation_index.pending_situations,1)
 assert.equal((await f.api('situation-index-warm',{library_id})).ok,true)
 const result=await f.api('situation-search',{library_id,query:'海螺作品'});assert.equal(result.result.available,true);assert.equal(result.result.results[0].id,s.id)
 assert.equal(f.plugin.situations.get(library_id,s.id).revision,1);assert.equal(f.plugin.situations.current(library_id,f.agent.session.id),null);assert.equal(f.modelCalls(),0)
})
test('管理页可按需分页查看活动报告，恢复只补扫、不调用模型',async t=>{
 const f=await fixture(t,{activityArchive:{enabled:true}}),created=await f.api('create',{name:'活动资料'}),library_id=created.result.library.id
 await f.api('bind',{library_id,session:f.agent.session.id,expected_revision:0})
 const ref=f.plugin.store.append(library_id,{session:f.agent.session.id,seq:1,time:'2026-10-30T07:00:00Z',role:'tool',text:'一段实际返回的资料'})
 const report=f.plugin.activityArchive.report(library_id,f.agent.session.id,{kind:'browser',title:'网页观察报告',body:'只记下这段可见资料',refs:[ref],idempotency_key:'page-one'}, {session:f.agent.session.id,seq:1})
 const list=await f.api('activity-list',{library_id});assert.equal(list.result.items[0].id,report.id)
 const read=await f.api('activity-read',{library_id,id:report.id,limit:80});assert.equal(Array.from(read.result.text).length,80);assert.ok(read.result.next_offset)
 assert.equal((await f.api('activity-read',{library_id,id:report.id,part:'metadata'})).ok,true)
 assert.equal((await f.api('activity-resume',{library_id})).ok,true);assert.equal((await f.api('inspect',{library_id})).result.activity_archive.reports,1);assert.equal(f.modelCalls(),0)
})
test('本机管理鉴权与跨站保护，不带令牌/错误来源/非JSON都不能修改',async t=>{
 const f=await fixture(t)
 assert.equal((await f.api('create',{name:'must not exist'},{authorization:''})).http,401)
 assert.equal((await f.api('create',{name:'must not exist'},{origin:'https://attacker.invalid'})).http,403)
 assert.equal((await f.api('create',{name:'must not exist'},{'content-type':'text/plain'})).http,415)
 assert.equal((await f.api('create',{name:'must not exist'},{authorization:'Bearer '+'é'.repeat(64)})).http,401)
 assert.deepEqual(f.plugin.store.list(),[]);assert.equal(f.modelCalls(),0)
 const html=await fetch(f.plugin.manager.origin+'/');assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/)
 assert.ok((await html.text()).includes('中断后的待核查操作'))
})
test('人工界面建库、命名、绑定、配置预算、暂停恢复与校验备份，全程不调用模型',async t=>{
 const f=await fixture(t),created=await f.api('create',{name:'synthetic library'});assert.equal(created.ok,true)
 const library_id=created.result.library.id
 let result=await f.api('bind',{library_id,session:f.agent.session.id,expected_revision:0});assert.equal(result.ok,true)
 result=await f.api('rename',{library_id,name:'renamed',expected_revision:1});assert.equal(result.ok,true)
 result=await f.api('configure',{library_id,config:{source:'dsh',provider:'synthetic',model:'test',maxCallsPerDay:2,maxInputChars:2400}});assert.equal(result.ok,true);assert.equal(result.result.paused,true)
 result=await f.api('pause',{library_id});assert.equal(result.ok,true)
 result=await f.api('resume',{library_id});assert.equal(result.result.replayed,false)
 result=await f.api('backup');assert.equal(result.ok,true);assert.ok(existsSync(join(result.result.directory,'manifest.json')))
 assert.equal(f.modelCalls(),0)
 f.plugin.store.pause(library_id,'SOURCE_CHANGED');assert.equal((await f.api('resume',{library_id})).error,'REPAIR_REQUIRED')
})
test('人工核查不重放，忙碌时拒绝恢复；管理令牌随卸载失效',async t=>{
 const f=await fixture(t),created=await f.api('create',{name:'review'}),library_id=created.result.library.id
 await f.api('bind',{library_id,session:f.agent.session.id,expected_revision:0})
 f.plugin.store.recovery.observe(library_id,f.agent.session.id,{type:'tool/call',data:{name:'mock_send',callId:'uncertain'}})
 f.plugin.store.recovery.observe(library_id,f.agent.session.id,{type:'tool/result',data:{message:{toolCallId:'uncertain'},error:{code:'ABORTED'}}})
 const args={library_id,operation_session:f.agent.session.id,call_id:'uncertain',decision:'abandon-no-replay',note:'Human chooses not to replay synthetic action'}
 f.agent.status='running';assert.equal((await f.api('review',args)).http,409);assert.equal(f.plugin.store.recovery.needsReview(library_id),true)
 f.agent.status='idle';const result=await f.api('review',args);assert.equal(result.result.replayed,false)
 assert.equal(f.plugin.store.recovery.needsReview(library_id),false)
 const path=f.plugin.manager.accessPath;assert.ok(existsSync(path));await f.plugin.dispose();assert.equal(existsSync(path),false);assert.equal(f.modelCalls(),0)
})

test('暂停再恢复不能覆盖来源变化或存储故障',async t=>{
 const f=await fixture(t),created=await f.api('create',{name:'fault preservation'}),library_id=created.result.library.id
 await f.api('bind',{library_id,session:f.agent.session.id,expected_revision:0})
 f.plugin.store.pause(library_id,'SOURCE_CHANGED')
 assert.equal((await f.api('pause',{library_id})).error,'REPAIR_REQUIRED')
 assert.equal(f.plugin.store.library(library_id).error,'SOURCE_CHANGED')
 assert.equal((await f.api('resume',{library_id})).error,'REPAIR_REQUIRED')
})

test('人工任务翻页、暂停与继续保留版本与步骤，无模型调用',async t=>{
 const f=await fixture(t),created=await f.api('create',{name:'task control'}),library_id=created.result.library.id
 await f.api('bind',{library_id,session:f.agent.session.id,expected_revision:0})
 for(let i=0;i<35;i++)f.plugin.execution.plan(library_id,f.agent.session.id,'task '+i,[{id:'read',title:'read',tool:'read'}])
 const p=await f.api('tasks',{library_id,offset:30});assert.equal(p.result.total,35);assert.equal(p.result.tasks.length,5)
 let task=p.result.tasks[0];let r=await f.api('task-pause',{library_id,task_id:task.id,expected_revision:task.revision});assert.equal(r.result.task.status,'paused')
 r=await f.api('task-resume',{library_id,task_id:task.id,expected_revision:r.result.task.revision});assert.equal(r.result.task.status,'planned');assert.equal(f.modelCalls(),0)
})
test('管理入口可看情境、清工作集、独立配置和暂停情境维护，不调用模型',async t=>{
 const f=await fixture(t),created=await f.api('create',{name:'memory architecture'}),library_id=created.result.library.id
 await f.api('bind',{library_id,session:f.agent.session.id,expected_revision:0})
 let r=await f.api('configure',{library_id,config:{source:'dsh',provider:'synthetic',model:'test',situationsEnabled:true}});assert.equal(r.ok,true)
 r=await f.api('consolidation-resume',{library_id});assert.equal(r.ok,true)
 await f.api('consolidation-pause',{library_id})
 const ref=f.plugin.store.append(library_id,{session:f.agent.session.id,seq:1,time:'2026-10-29T08:00:00Z',role:'user',text:'只完成片头'})
 const s=f.plugin.situations.create(library_id,f.agent.session.id,{title:'测试视频',refs:[ref],assertions:[{slot:'progress',body:'自述只完成片头',refs:[ref]}]})
 r=await f.api('situations',{library_id});assert.equal(r.result.items[0].id,s.id)
 r=await f.api('situation',{library_id,id:s.id});assert.equal(r.result.statements[0].body,'自述只完成片头')
 r=await f.api('working-clear',{library_id});assert.equal(r.ok,true);assert.equal(f.plugin.store.report(library_id).records,1)
 r=await f.api('inspect',{library_id});assert.equal(r.result.consolidation.paused,true);assert.equal(r.result.situation_page.total,1)
 assert.equal(f.modelCalls(),0)
})
