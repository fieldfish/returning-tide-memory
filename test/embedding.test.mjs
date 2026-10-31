import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';
import {ContinuityStore} from '../lib/store.mjs';import {Embedding} from '../lib/embedding.mjs';
import {Capture} from '../lib/capture.mjs'
import {ActivityArchive} from '../lib/activity-archive.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {SituationIndex} from '../lib/situation-index.mjs'

async function fixture(t,{failEmbeds=false,stallTags=null,oversizedTags=false,memoryDynamics={}}={}){
 const dir=mkdtempSync(join(tmpdir(),'continuity-vector-test-'));let posts=0,tags=0
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/tags'){tags++;res.setHeader('Content-Type','application/json');if(oversizedTags){res.write(' '.repeat(9*1024*1024));return}if(stallTags){if(stallTags==='body'){res.writeHead(200);res.write('{"models":[')}return}res.end(JSON.stringify({models:[{name:'fixture-embedding',digest:'fixture-digest'}]}));return}
  if(req.url==='/api/embed'){
   posts++;if(failEmbeds){res.writeHead(500);res.end('fail');return}
   let text='';for await(const chunk of req)text+=chunk
   const data=JSON.parse(text);const embeddings=data.input.map(s=>String(s).includes('代理')?[1,0,0]:[0,1,0]);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({embeddings}));return
  }res.writeHead(404);res.end()
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const store=new ContinuityStore(dir)
 const embedding=new Embedding(store,{ollamaUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture-embedding',queryInstruction:'test',memoryDynamics})
 t.after(async()=>{embedding.close();store.close();server.closeAllConnections();await new Promise(r=>server.close(r));const target=resolve(dir),base=resolve(tmpdir());assert.ok(target.startsWith(base+sep)&&target.includes('continuity-vector-test-'));rmSync(target,{recursive:true,force:true})})
 return {store,embedding,posts:()=>posts,tags:()=>tags}
}

test('retrieving only the old claim brings its attributed later change within the compact budget',async t=>{
 const f=await fixture(t),lib=f.store.create('Synthetic paired lookup');f.store.bind('owner',lib.id,0)
 const a=f.store.append(lib.id,{session:'history',seq:1,time:'2026-10-30T00:00:00Z',role:'user',text:'代理台灯选蓝色，其他事项照旧。'}),b=f.store.append(lib.id,{session:'history',seq:2,time:'2026-10-31T00:00:00Z',role:'user',text:'现在改选绿色，别的事情没变。'})
 f.embedding.claimLinks.record(lib.id,'owner',{id:a,target_id:b,relation:'changed',subject:'synthetic-speaker',topic:'lamp-color',scope:'room-lamp',source_quote:'台灯选蓝色',target_quote:'现在改选绿色',reason:'Attributed preference change'})
 const response=await f.embedding.lookup(lib.id,'owner','代理台灯蓝色',1)
 assert.equal(response.results[0].id,f.store.shortId(lib.id,a));assert.match(response.relations[0].after,/绿色/);assert.equal(response.relations[0].to,f.store.shortId(lib.id,b));assert.ok(Array.from(JSON.stringify(response)).length<=650)
 assert.deepEqual(Object.keys(response.results[0]).sort(),['id','title','score','summary','time','quote'].sort())
})
test('Projection upgrade rebuilds only affected bridge indexes and leaves source rows and other vectors intact',async t=>{
 const f=await fixture(t),lib=f.store.create('projection migration');f.store.bind('owner',lib.id,0)
 const dirty='[QQ · 私聊] Example：代理记得蓝色台灯\n（回 QQ：用 qq_bridge_send 工具）',bridge=f.store.append(lib.id,{session:'history',seq:1,time:'2026-10-31T00:00:00Z',role:'user',text:dirty,origin:{kind:'plugin:dsh-qq-bridge'}})
 const clean=f.store.append(lib.id,{session:'history',seq:2,time:'2026-10-31T00:00:00Z',role:'assistant',text:'代理合成台灯，尚未购买'})
 await f.embedding.warm(lib.id,'owner');const original=f.store.record(lib.id,bridge),saved=Buffer.from(f.store.db.prepare('SELECT value FROM cm_vectors WHERE rid=?').get(clean).value)
 f.store.db.prepare('UPDATE cm_vector_chunks SET content=? WHERE rid=?').run(dirty,bridge);f.store.db.exec('DELETE FROM cm_retrieval_projection')
 const migrated=new Embedding(f.store,{model:'fixture-embedding'})
 try{
  assert.deepEqual(f.store.record(lib.id,bridge),original);assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_vectors WHERE rid=?').get(bridge).n,0)
  assert.deepEqual(Buffer.from(f.store.db.prepare('SELECT value FROM cm_vectors WHERE rid=?').get(clean).value),saved)
  migrated.prepareChunks(lib.id);assert.equal(f.store.db.prepare('SELECT content FROM cm_vector_chunks WHERE rid=?').get(bridge).content,'代理记得蓝色台灯')
  const plan=f.store.db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM cm_legacy_notes WHERE library=? AND rid=? AND active=0').all(lib.id,bridge).map(r=>r.detail).join(' ')
  assert.match(plan,/cm_legacy_notes_source/)
 }finally{migrated.close()}
})
test('Dialogue outranks equally relevant authored legacy notes, both keep distinguishable exact quotes',async t=>{
 const f=await fixture(t),lib=f.store.create('source ranking');f.store.bind('owner',lib.id,0)
 const file=f.store.append(lib.id,{session:'legacy-file',seq:1,time:'2026-10-31T00:00:00Z',role:'note',text:'代理的合成台灯是蓝色，仅为笔记',origin:{kind:'legacy-index-note',source:'authored-file'}})
 const dialogue=f.store.append(lib.id,{session:'history',seq:1,time:'2026-10-31T00:00:00Z',role:'user',text:'代理的合成台灯是蓝色，这是原话'})
 const r=await f.embedding.lookup(lib.id,'owner','代理合成台灯',5)
 assert.equal(r.results[0].id,f.store.shortId(lib.id,dialogue));assert.match(r.results.find(c=>c.id===f.store.shortId(lib.id,file)).title,/旧文件/)
 for(const c of r.results)assert.ok(f.store.record(lib.id,c.id).text.includes(c.quote))
})
test('Five verbose source cards still fit the whole response budget without losing verbatim quotes',async t=>{
 const f=await fixture(t),lib=f.store.create('compact quotes');f.store.bind('owner',lib.id,0)
 for(let i=0;i<5;i++)f.store.append(lib.id,{session:'history',seq:i,time:'2026-10-31T00:00:00Z',role:'user',text:'代理合成台灯的说明🌊'+i+'。'.repeat(200)})
 const r=await f.embedding.lookup(lib.id,'owner','代理合成台灯',5);assert.equal(r.results.length,5);assert.ok(Array.from(JSON.stringify(r)).length<=650)
 for(const c of r.results){assert.ok(Array.from(JSON.stringify(c)).length<=120);assert.ok(c.summary.length>=10,'a fitting card keeps a judgeable summary');assert.ok(c.quote.length>=10);assert.ok(f.store.record(lib.id,c.id).text.includes(c.quote))}
})
test('关系元数据挤压预算时整张卡片少返回，而不是把摘要压成一两个字',async t=>{
 const f=await fixture(t),lib=f.store.create('compact relations');f.store.bind('owner',lib.id,0)
 const ids=[]
 for(let i=0;i<4;i++)ids.push(f.store.append(lib.id,{session:'history',seq:i,time:'2026-10-31T00:00:00Z',role:'user',text:'代理合成台灯的说明🌊'+i+'。'.repeat(200)}))
 f.embedding.claimLinks.record(lib.id,'owner',{id:ids[0],target_id:ids[1],relation:'changed',subject:'synthetic-speaker',topic:'lamp-color',scope:'room-lamp',source_quote:'台灯的说明',target_quote:'台灯的说明',reason:'Synthetic attributed change within the same verbose text'})
 const r=await f.embedding.lookup(lib.id,'owner','代理合成台灯',4)
 assert.ok(Array.from(JSON.stringify(r)).length<=650)
 assert.ok(r.relations?.length,'relationship metadata remains attributable')
 assert.ok(r.results.length>=1&&r.results.length<4,'whole cards are dropped before cards become meaningless')
 assert.match(r.note,/预算内\d+条/)
 for(const c of r.results){assert.ok(Array.from(JSON.stringify(c)).length<=120);assert.ok(c.summary.length>=10);assert.ok(c.quote.length>=10);assert.ok(f.store.record(lib.id,c.id).text.includes(c.quote))}
})

test('取消排队立即返回，后续查询仍等待原操作，不并发穿透',async t=>{
 const {embedding}=await fixture(t);let release,enter,thirdRan=false
 const gate=new Promise(r=>{release=r}),ready=new Promise(r=>{enter=r})
 const first=embedding.exclusive(null,async()=>{enter();await gate});await ready
 const control=new AbortController(),second=embedding.exclusive(control.signal,()=>assert.fail('Cancelled task executed'))
 control.abort();const third=embedding.exclusive(null,async()=>{thirdRan=true})
 try{await assert.rejects(Promise.race([second,new Promise((_,j)=>setTimeout(()=>j(Error('cancel did not return promptly')),250))]),{code:'CANCELLED'});await new Promise(r=>setImmediate(r));assert.equal(thirdRan,false)}
 finally{release();await first;await third}
 assert.equal(thirdRan,true)
})

for(const phase of ['headers','body'])test(`取消本地向量${phase}请求保留CANCELLED，不冒充服务故障`,async t=>{
 const f=await fixture(t,{stallTags:phase}),control=new AbortController(),job=f.embedding.identity(control.signal)
 const until=Date.now()+2000;while(!f.tags()&&Date.now()<until)await new Promise(r=>setTimeout(r,10))
 assert.ok(f.tags());control.abort();await assert.rejects(job,{code:'CANCELLED'})
})

test('无Content-Length的大响应在流读取期间受限，不等服务结束', {timeout:5000}, async t=>{
 const {embedding}=await fixture(t,{oversizedTags:true});await assert.rejects(embedding.identity(),{code:'EMBEDDING_INVALID_RESPONSE'})
})
test('大量原文扫描会让出执行并响应取消，取消后串行队列可恢复',async t=>{
 const f=await fixture(t),lib=f.store.create('cancel-scan');f.store.bind('owner',lib.id,0)
 f.store.tx(()=>{for(let i=0;i<500;i++)f.store.append(lib.id,{session:'history',seq:i,time:'2026-10-28T00:00:00Z',role:'user',text:'代理 合成扫描资料 '+i})})
 const key=await f.embedding.identity(),original=f.embedding.embed,control=new AbortController()
 f.embedding.embed=async()=>{setImmediate(()=>control.abort());return [[1,0,0]]}
 await assert.rejects(f.embedding.lookup(lib.id,'owner','代理',3,control.signal,null,{readOnlyIndex:true}),{code:'CANCELLED'})
 f.embedding.embed=original;assert.ok(key);assert.equal(await f.embedding.exclusive(null,async()=>true),true)
})
test('向量故障状态独立持久保存，不污染主库；索引暂停不自动重试',async t=>{
 const f=await fixture(t),lib=f.store.create('feature-health');f.store.bind('owner',lib.id,0)
 f.embedding.markFailure(lib.id,'EMBEDDING_UNAVAILABLE');const reopened=new Embedding(f.store,{model:'fixture-embedding'})
 try{assert.equal(reopened.health(lib.id).paused,true);assert.equal(f.store.library(lib.id).error,null);assert.deepEqual(await reopened.warm(lib.id,'owner'),{skipped:'feature-paused'});assert.equal(f.posts(),0)}finally{reopened.close()}
 f.embedding.resume(lib.id,'owner');assert.equal(f.embedding.health(lib.id).paused,false)
})

test('当前模型索引维度损坏会明确报错，不静默返回空候选',async t=>{
 const {store,embedding}=await fixture(t),lib=store.create('corrupted dimensions');store.bind('owner',lib.id,0)
 store.append(lib.id,{session:'history',seq:1,time:'2026-10-28T00:00:00Z',role:'user',text:'代理合成资料'})
 await embedding.warm(lib.id,'owner');const valid=Buffer.from(store.db.prepare('SELECT value FROM cm_vectors').get().value),nan=Buffer.alloc(12);nan.writeFloatLE(NaN,0)
 for(const [dimensions,value] of [[999,valid],[3,Buffer.alloc(8)],[3,nan]]){store.db.prepare('UPDATE cm_vectors SET dimensions=?,value=? WHERE library=?').run(dimensions,value,lib.id);await assert.rejects(embedding.lookup(lib.id,'owner','代理'),{code:'EMBEDDING_INVALID_VECTOR'})}
})

test('词命中的记录即使不在向量前60名，仍保留其有效向量准入',async t=>{
 const {store,embedding}=await fixture(t),lib=store.create('fused route');store.bind('owner',lib.id,0);let target
 for(let i=0;i<75;i++){const rid=store.append(lib.id,{session:'history',seq:i,time:'2026-10-28T00:00:00Z',role:'user',text:i===74?'代理专用信号蓝桨':'普通合成背景 '+i});if(i===74)target=rid}
 do{await embedding.warm(lib.id,'owner')}while(embedding.status(lib.id).index_work_remaining)
 for(const row of store.db.prepare('SELECT rid FROM cm_vectors').all()){const value=Buffer.alloc(12),score=row.rid===target?.51:.95;value.writeFloatLE(score,0);value.writeFloatLE(Math.sqrt(1-score*score),4);store.db.prepare('UPDATE cm_vectors SET value=? WHERE rid=?').run(value,row.rid)}
 const result=await embedding.lookup(lib.id,'owner','代理',5);assert.ok(result.results.some(r=>r.id===target.slice(0,10)))
})

test('两个库隔离，混合检索返回含原句的六字段短卡，短ID可读原文',async t=>{
 const {store,embedding}=await fixture(t),a=store.create('小黛'),b=store.create('别的伙伴');store.bind('s-a',a.id,0);store.bind('s-b',b.id,0)
 const rid=store.append(a.id,{session:'s-a',seq:1,time:'2026-10-28T00:00:00Z',role:'user',type:'user/message',text:'代理喜欢安静的小房间。',origin:{kind:'user'}})
 store.append(b.id,{session:'s-b',seq:1,time:'2026-10-28T00:00:00Z',role:'user',type:'user/message',text:'代理在别的库里。',origin:{kind:'user'}})
 const response=await embedding.lookup(a.id,'s-a','代理',5)
 assert.equal(response.results.length,1);assert.equal(response.results[0].id,rid.slice(0,10))
 assert.deepEqual(Object.keys(response.results[0]).sort(),['id','title','score','summary','time','quote'].sort())
 assert.ok(Array.from(JSON.stringify(response.results[0])).length<=120)
 assert.ok(Array.from(JSON.stringify(response)).length<=700)
 assert.equal(store.read(a.id,response.results[0].id,0,2000).text,'代理喜欢安静的小房间。')
 assert.equal(store.read(a.id,response.results[0].id,0,2000).id,rid)
 assert.ok(response.results[0].summary);assert.ok(store.record(a.id,rid).text.includes(response.results[0].quote));assert.ok(response.results[0].quote.length>=10)
 assert.throws(()=>store.read(b.id,rid,0,2000),{code:'NOT_FOUND'})
})

test('反馈只调整已准入候选排序；只读检索和读原文不强化，短卡字段与预算不变',async t=>{
 const {store,embedding}=await fixture(t,{memoryDynamics:{enabled:true}}),lib=store.create('反馈检索');store.bind('owner',lib.id,0)
 const id=store.append(lib.id,{session:'history',seq:1,time:'2020-01-01T00:00:00Z',role:'assistant',text:'代理的导航配色原来是蓝色。'})
 const before=await embedding.lookup(lib.id,'owner','代理导航配色',3,null,null,{details:true})
 assert.equal(before.candidates[0].auto_blocked,undefined)
 const ref=store.append(lib.id,{session:'owner',seq:2,time:new Date().toISOString(),role:'user',text:'导航配色的旧说法需要纠正'})
 embedding.memoryDynamics.record(lib.id,'owner',{id,kind:'corrected',cue:'导航配色',refs:[ref],reason:'原文保留，具体配色需核对'})
 const result=await embedding.lookup(lib.id,'owner','代理导航配色',3,null,null,{readOnlyIndex:true,details:true})
 assert.equal(result.candidates.find(c=>c.id===id).auto_blocked,true);assert.equal(result.candidates.find(c=>c.id===id).semantic,before.candidates[0].semantic)
 assert.ok(result.results.find(r=>r.id===store.shortId(lib.id,id)).score<before.results[0].score)
 for(const card of result.results){assert.deepEqual(Object.keys(card).sort(),['id','title','score','summary','time','quote'].sort());assert.ok(Array.from(JSON.stringify(card)).length<=120)}
 const count=store.db.prepare('SELECT count(*) n FROM cm_memory_feedback').get().n
 for(let i=0;i<3;i++){await embedding.lookup(lib.id,'owner','代理导航配色',3,null,null,{readOnlyIndex:true});store.read(lib.id,id,0,200)}
 assert.equal(store.db.prepare('SELECT count(*) n FROM cm_memory_feedback').get().n,count);assert.equal(store.record(lib.id,id).text,'代理的导航配色原来是蓝色。')
 await embedding.warm(lib.id,'owner') // New cue index is maintained while idle, never by read-only lookup.
 const other=await embedding.lookup(lib.id,'owner','代理的房间',3,null,null,{readOnlyIndex:true,details:true});assert.equal(other.candidates.find(c=>c.id===id).auto_blocked,undefined)
})

test('同库最新记录可补向量，失败只请求一次且不把关键词当故障后备',async t=>{
 const {store,embedding,posts}=await fixture(t,{failEmbeds:true}),a=store.create('故障库');store.bind('s',a.id,0)
 store.append(a.id,{session:'s',seq:1,time:'2026-10-28T00:00:00Z',role:'user',type:'user/message',text:'代理在这里。',origin:{kind:'user'}})
 await assert.rejects(embedding.lookup(a.id,'s','代理'),{code:'EMBEDDING_UNAVAILABLE'})
 assert.equal(posts(),1)
})

test('后台建向量时查询排队等待，不因瞬时忙碌报错',async t=>{
 const {store,embedding}=await fixture(t),a=store.create('并发库');store.bind('s',a.id,0)
 store.append(a.id,{session:'s',seq:1,time:'2026-10-28T00:00:00Z',role:'user',type:'user/message',text:'代理喜欢安静的小房间。',origin:{kind:'user'}})
 let enter,release;const entered=new Promise(r=>{enter=r}),gate=new Promise(r=>{release=r});let delayed=false
 const original=embedding.embed.bind(embedding)
 embedding.embed=async(...args)=>{if(!delayed&&!args[1]){delayed=true;enter();await gate}return original(...args)}
 const warming=embedding.warm(a.id,'s');await entered
 const querying=embedding.lookup(a.id,'s','代理')
 release();await warming
 const response=await querying;assert.equal(response.results.length,1)
})

test('检索排除当前回合提问，未知负例不返回弱相关候选',async t=>{
 const {store,embedding}=await fixture(t),a=store.create('负例库');store.bind('s',a.id,0)
 const old=store.append(a.id,{session:'s',seq:1,time:'2026-10-28T00:00:00Z',role:'assistant',type:'assistant/message',text:'代理喜欢安静的小房间。',origin:{kind:'model'}})
 store.append(a.id,{session:'s',seq:5,time:'2026-10-28T00:01:00Z',role:'user',type:'user/message',text:'代理喜欢什么？我上周买了哪种火星土壤样本？',origin:{kind:'user'}})
 const exclude={session:'s',fromSeq:4}
 const known=await embedding.lookup(a.id,'s','代理喜欢什么',3,null,exclude)
 assert.equal(known.results[0].id,old.slice(0,10))
 const unknown=await embedding.lookup(a.id,'s','我上周买了哪种火星土壤样本',3,null,exclude)
 assert.deepEqual(unknown.results,[])
})

test('原生时间戳和QQ来源会入库，隐藏推理与插件注入不回灌',async t=>{
 const {store}=await fixture(t),a=store.create('采集库');store.bind('native',a.id,0)
 const {Capture}=await import('../lib/capture.mjs');const capture=new Capture(store),time=Date.parse('2026-10-28T01:02:03Z')
 const qq={seq:1,time,type:'user/message',surfaceOp:'append',data:{id:'u1',role:'user',source:{kind:'plugin:dsh-qq-bridge'},content:[{type:'text',text:'[QQ]管理员说晚安'}]}}
 const assistant={seq:2,time:time+1,type:'assistant/message',surfaceOp:'append',data:{message:{id:'a2',role:'assistant',source:{kind:'model'},content:[{type:'reasoning',text:'HIDDEN'},{type:'text',text:'晚安。'}]}}}
 const injected={seq:3,time:time+2,type:'user/message',surfaceOp:'append',data:{source:{kind:'schedule'},content:[{type:'text',text:'NOT_REAL_LIFE'}]}}
 assert.ok(capture.event(a.id,'native',qq));assert.ok(capture.event(a.id,'native',assistant));assert.equal(capture.event(a.id,'native',injected),null)
 assert.equal(store.report(a.id).records,2);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM records WHERE origin LIKE '%plugin:dsh-qq-bridge%'").get().n,1)
 assert.ok(!JSON.stringify(store.recent(a.id)).includes('HIDDEN'))
 assert.ok(!JSON.stringify(store.recent(a.id)).includes('NOT_REAL_LIFE'))
})

test('对象形式append也归档，替换事件不伪造新经历',async t=>{
 const {store}=await fixture(t),lib=store.create('event formats');store.bind('s',lib.id,0)
 const {Capture}=await import('../lib/capture.mjs'),capture=new Capture(store)
 const e={seq:1,time:Date.parse('2026-10-29T00:00:00Z'),surfaceOp:{op:'append'},type:'user/message',data:{source:{kind:'user'},content:'对象追加事件原文'}}
 assert.ok(capture.event(lib.id,'s',e));assert.equal(store.report(lib.id).records,1)
 assert.equal(capture.event(lib.id,'s',{...e,seq:2,surfaceOp:{op:'replace'}}),null);assert.equal(store.report(lib.id).records,1)
})

test('索引状态区分尚未分片与已分片待向量，不用pending=0冒充全部完成',async t=>{
 const {store,embedding}=await fixture(t),lib=store.create('coverage');store.bind('s',lib.id,0)
 for(let i=0;i<66;i++)store.append(lib.id,{session:'history',seq:i,time:'2026-10-28T00:00:00Z',role:'user',text:'代理合成记录 '+i})
 const before=embedding.status(lib.id);assert.equal(before.pending_parts,0);assert.equal(before.unprepared_records,66);assert.equal(before.index_work_remaining,true)
 assert.equal(embedding.prepareChunks(lib.id),64);assert.equal(embedding.status(lib.id).unprepared_records,2)
 const response=await embedding.lookup(lib.id,'s','代理',3);assert.match(response.note,/索引补建中/);assert.ok(Array.from(JSON.stringify(response)).length<=650)
 while(embedding.status(lib.id).index_work_remaining)await embedding.warm(lib.id,'s')
 assert.equal(embedding.status(lib.id).indexed_parts,66);assert.equal(embedding.status(lib.id).index_work_remaining,false)
})

test('普通英文词不绕过向量门槛，含数字的长编号仍可精确定位',async t=>{
 const {store,embedding}=await fixture(t),a=store.create('词与编号');store.bind('s',a.id,0)
 store.append(a.id,{session:'s',seq:1,time:'2026-10-28T00:00:00Z',role:'assistant',type:'assistant/message',text:'代理给 banana 项目安装依赖。编号 ABC1234567。'})
 assert.deepEqual((await embedding.lookup(a.id,'s','banana 比赛获得第几名')).results,[])
 assert.equal((await embedding.lookup(a.id,'s','ABC1234567')).results.length,1)
})

test('长文命中后半分片时短卡显示命中分片，原文仍可完整读取',async t=>{
 const {store,embedding}=await fixture(t),a=store.create('长文');store.bind('s',a.id,0)
 const text='别的内容。'.repeat(160)+'代理最终选择暖杏色，因为夜间柔和。'
 const rid=store.append(a.id,{session:'s',seq:1,time:'2026-10-28T00:00:00Z',role:'user',type:'user/message',text})
 const result=await embedding.lookup(a.id,'s','代理配色',3)
 assert.equal(result.results[0].id,rid.slice(0,10));assert.match(result.results[0].summary,/代理|暖杏/)
 assert.ok(store.read(a.id,rid,0,2000).text.endsWith('夜间柔和。'))
})

test('补充结构化结果会更新派生索引但不改旧正文，编号可检索并另读',async t=>{
 const f=await fixture(t),lib=f.store.create('结构化索引');f.store.bind('s',lib.id,0)
 const capture=new Capture(f.store),event={seq:1,type:'tool/result',time:'2026-10-30T08:00:00Z',data:{message:{toolCallId:'receipt',content:'普通返回正文'},structured:{receipt:'代理 ACT123456789'}}}
 const rid=capture.event(lib.id,'s',event),before=f.store.record(lib.id,rid).digest
 await f.embedding.warm(lib.id,'s');assert.deepEqual((await f.embedding.lookup(lib.id,'s','代理 ACT123456789')).results,[])
 const archive=new ActivityArchive(f.store,{enabled:true});capture.activityArchive=archive;assert.equal(capture.event(lib.id,'s',event),rid)
 assert.equal(f.store.record(lib.id,rid).digest,before);assert.equal(f.embedding.status(lib.id).unprepared_records,1)
 const found=await f.embedding.lookup(lib.id,'s','代理 ACT123456789');assert.equal(found.results[0].id,f.store.shortId(lib.id,rid));assert.match(archive.payload(lib.id,rid,{limit:6000}).text,/ACT123456789/)
 assert.equal(f.store.record(lib.id,rid).text,'普通返回正文');assert.equal(f.store.report(lib.id).records,1)
})
test('合成活动命名空间不能绕过当前轮排除，下一轮仍可正常召回',async t=>{
 const f=await fixture(t),lib=f.store.create('活动轮次');f.store.bind('s',lib.id,0)
 const ref=f.store.append(lib.id,{session:'s',seq:1,time:'2026-10-30T07:00:00Z',role:'tool',text:'字幕提供代理海螺线索'}),archive=new ActivityArchive(f.store,{enabled:true})
 const observation=archive.report(lib.id,'s',{kind:'video',title:'代理海螺片段',body:'主体报告字幕提到海螺',source:'https://example.invalid/video',start_ms:0,end_ms:3000,refs:[ref],idempotency_key:'video-one'}, {session:'s',seq:2})
 do{await f.embedding.warm(lib.id,'s')}while(f.embedding.status(lib.id).index_work_remaining)
 const current=await f.embedding.lookup(lib.id,'s','代理海螺片段',5,null,{session:'s',fromSeq:2},{readOnlyIndex:true})
 assert.equal(current.results.some(c=>c.id===f.store.shortId(lib.id,observation.id)),false)
 const next=await f.embedding.lookup(lib.id,'s','代理海螺片段',5,null,{session:'s',fromSeq:3},{readOnlyIndex:true})
 assert.equal(next.results.some(c=>c.id===f.store.shortId(lib.id,observation.id)),true)
})
test('情境投影跟踪活动依据，既排除当前报告也响应依据停用',async t=>{
 const f=await fixture(t),lib=f.store.create('活动情境');f.store.bind('s',lib.id,0)
 const ref=f.store.append(lib.id,{session:'s',seq:1,time:'2026-10-30T07:00:00Z',role:'tool',text:'代理海螺字幕'}),archive=new ActivityArchive(f.store,{enabled:true})
 const report=archive.report(lib.id,'s',{kind:'video',title:'代理海螺活动',body:'字幕提出一个代理海螺问题',source:'https://example.invalid/video',start_ms:0,end_ms:2000,refs:[ref],idempotency_key:'episode'}, {session:'s',seq:2})
 f.store.db.prepare('INSERT INTO cm_legacy_notes(library,legacy_id,rid,active) VALUES(?,?,?,1)').run(lib.id,'origin',ref)
 const situations=new Situations(f.store,new Scenes(f.store)),s=situations.create(lib.id,'s',{title:'代理海螺活动',refs:[report.id]}),index=new SituationIndex(f.store,situations,f.embedding,{enabled:true})
 await index.warm(lib.id,'s');assert.equal((await index.lookup(lib.id,'s','代理海螺活动')).results[0].id,s.id)
 assert.equal((await index.lookup(lib.id,'s','代理海螺活动',3,null,{exclude:{session:'s',fromSeq:2}})).results.length,0)
 f.store.db.prepare('UPDATE cm_legacy_notes SET active=0 WHERE rid=?').run(ref)
 assert.equal(index.status(lib.id).pending_situations,1);assert.equal((await index.lookup(lib.id,'s','代理海螺活动')).results.length,0)
 await index.warm(lib.id,'s');assert.equal(index.status(lib.id).pending_situations,0);assert.equal(index.status(lib.id).unindexable_situations,1)
})
