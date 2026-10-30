import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Capture} from '../lib/capture.mjs'
import {ActivityArchive,encodeActivity} from '../lib/activity-archive.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {SituationIndex} from '../lib/situation-index.mjs'
import {Embedding} from '../lib/embedding.mjs'
import {SourceLog,sourceBatch} from '../lib/source-log.mjs'
import {Extraction} from '../lib/extraction.mjs'
import {sourcePosition,excludedSource} from '../lib/source-position.mjs'
import {snapshot,restoreCopy} from '../lib/snapshot.mjs'

function fixture(t,config={}){
  const directory=mkdtempSync(join(tmpdir(),'cm-activity-test-'));let seq=0
  const store=new ContinuityStore(directory,{now:()=>Date.parse('2026-10-30T08:00:00Z')}),lib=store.create('合成活动记录');store.bind('owner',lib.id,0)
  const archive=new ActivityArchive(store,{enabled:true,...config}),capture=new Capture(store,archive),events=[]
  const event=(type,data,extra={})=>{const e={seq:++seq,type,time:'2026-10-30T07:00:00Z',data,...extra};events.push(e);return {event:e,id:capture.event(lib.id,'owner',e)}}
  const raw=text=>event('user/message',{content:text}).id
  const report=(ref,extra={},session='owner')=>archive.report(lib.id,session,{kind:'video',title:'海螺视频片段',body:'字幕中提出一个方法，尚未实践',source:'https://example.invalid/video/one',start_ms:1000,end_ms:3000,refs:[ref],idempotency_key:'view-once:1000:3000',...extra},{session,seq:seq||1})
  const all=(id,part='payload')=>{let offset=0,text='';for(let n=0;n<100;n++){const r=archive.payload(lib.id,id,{offset,limit:6000,part});text+=r.text;if(r.next_offset===null)return JSON.parse(text);offset=r.next_offset}assert.fail('Unexpected huge fixture payload')}
  t.after(()=>{store.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('cm-activity-test-'));rmSync(target,{recursive:true,force:true})})
  return {directory,store,lib,archive,capture,event,raw,report,all,events}
}

test('活动开关默认关闭，不新增请求或结构化数据，也不改变原工具正文',t=>{
  const f=fixture(t,{enabled:false})
  assert.equal(f.event('tool/call',{name:'read',callId:'c1',arguments:{path:'a.txt'}}).id,null)
  const result=f.event('tool/result',{message:{toolCallId:'c1',content:'原工具正文'}})
  assert.equal(f.store.record(f.lib.id,result.id).text,'原工具正文');assert.equal(f.archive.status(f.lib.id).payloads,0)
  assert.equal(f.event('tool/result',{callId:'c2',result:{value:42}}).id,null)
})
test('原参数、结构化结果和正文分开保存，请求不被标为完成',t=>{
  const f=fixture(t),call=f.event('tool/call',{name:'read',callId:'c1',arguments:{path:'代理.txt',password:'fixture-secret',headers:{Authorization:'Bearer fixture-bearer-12345'}}})
  const result=f.event('tool/result',{message:{toolCallId:'c1',content:[{type:'text',text:'工具返回 🐟'},{type:'reasoning',text:'HIDDEN-TEST-TEXT'},{type:'text',text:' 完毕'}]},structured:{receipt:'AB12345678',count:3}})
  assert.equal(f.archive.descriptor(f.lib.id,call.id).phase,'requested');assert.equal(f.archive.descriptor(f.lib.id,result.id).phase,'host-returned')
  const read=f.all(call.id);assert.equal(read.data.arguments.path,'代理.txt');assert.equal(read.data.arguments.password,'[credential-redacted]')
  assert.doesNotMatch(f.store.record(f.lib.id,call.id).text,/fixture-secret|fixture-bearer/)
  assert.equal(f.all(result.id).data.structured.receipt,'AB12345678');assert.equal(f.all(result.id).data.message.content[0].text,'工具返回 🐟')
  assert.equal(f.store.record(f.lib.id,result.id).text,'工具返回 🐟 完毕');assert.doesNotMatch(JSON.stringify(f.all(result.id)),/HIDDEN-TEST-TEXT/)
})
test('JSON字符串参数可检查具名凭据，转换有标记，字符串顺序与嵌套数据不丢',t=>{
  const f=fixture(t),r=f.event('tool/call',{callId:'string-args',name:'run_code',arguments:'{"items":[3,1,2],"apiKey":"fixture-api-secret","cmd":"print(1)"}'})
  const payload=f.all(r.id);assert.deepEqual(payload.data.arguments.items,[3,1,2]);assert.equal(payload.data.arguments.apiKey,'[credential-redacted]')
  assert.ok(f.all(r.id,'metadata').normalizations.some(o=>o.reason==='json-argument-string-normalized'))
})
test('大正文仅存引用，分页可恢复原文本；不会把长元数据整包塞回模型',t=>{
  const f=fixture(t,{maxPayloadBytes:8192}),body='🌊🐟段落\n'.repeat(1400)
  const r=f.event('tool/result',{message:{toolCallId:'large',content:[{type:'text',text:body.slice(0,3000)},{type:'text',text:body.slice(3000)}]},structured:{receipt:'large-123'}})
  assert.ok(r.id);assert.equal(f.archive.health(f.lib.id).paused,false)
  const stored=f.store.db.prepare('SELECT payload FROM cm_activity_payloads WHERE rid=?').get(r.id).payload
  assert.ok(stored.length<1500);const read=f.all(r.id)
  assert.equal(read.data.message.content.map(b=>b.text).join(''),body)
  const page=f.archive.payload(f.lib.id,r.id,{limit:80});assert.equal(Array.from(page.text).length,80);assert.ok(JSON.stringify(page.metadata).length<150)
})
test('无正文的结构化返回也可留档；图片载体不伪造成观看内容',t=>{
  const f=fixture(t),result=f.event('tool/result',{callId:'structured',result:{value:42,items:['one','two']}})
  assert.equal(f.all(result.id).data.result.value,42);assert.ok(f.store.record(f.lib.id,result.id).text.includes('42'))
  const image=f.event('tool/result',{message:{toolCallId:'image',content:[{type:'image',data:'DO-NOT-COPY-BASE64'.repeat(1000),mimeType:'image/png'}]}})
  assert.ok(image.id);assert.doesNotMatch(f.store.record(f.lib.id,image.id).text,/DO-NOT-COPY-BASE64/);assert.ok(f.all(image.id).data.message.content[0].omitted_carrier)
  assert.equal(f.archive.health(f.lib.id).paused,false)
})
test('正文块恰好分开代理对时仍保留各块，不误报来源变化或停掉采集',t=>{
 const f=fixture(t),blocks=['\ud83d','\udc1f',' 后续文字'],r=f.event('tool/result',{message:{toolCallId:'unicode-split',content:blocks.map(text=>({type:'text',text}))}})
 assert.equal(f.archive.health(f.lib.id).paused,false);assert.equal(f.store.record(f.lib.id,r.id).text,'🐟 后续文字')
 assert.deepEqual(f.all(r.id).data.message.content.map(b=>b.text),blocks);assert.equal(f.all(r.id,'metadata').normalization_count,2)
})
test('工具返回错误只描述宿主返回，不虚构外部成功；Error对象可规范化',t=>{
  const f=fixture(t),error=Object.assign(new Error('fixture failed'),{code:'TIMEOUT'}),r=f.event('tool/result',{callId:'error',error})
  assert.equal(f.archive.descriptor(f.lib.id,r.id).phase,'host-outcome-unknown');assert.equal(f.all(r.id).data.error.code,'TIMEOUT');assert.equal(f.archive.health(f.lib.id).paused,false)
})
test('自身记忆工具及代码包装器不回灌成经历，替换事件不新增',t=>{
  const f=fixture(t)
  assert.equal(f.event('tool/call',{name:'cm_activity',callId:'own',arguments:{action:'status'}}).id,null)
  assert.equal(f.event('tool/result',{message:{toolCallId:'own',content:'内部记忆状态'}}).id,null)
  assert.equal(f.event('tool/call',{name:'run_code',callId:'own-code',arguments:{code:'await api.cm_activity({action:"status"})'}}).id,null)
  assert.equal(f.event('tool/result',{message:{toolCallId:'own-code',content:'内部记忆状态'}}).id,null)
  assert.equal(f.event('tool/call',{name:'read',callId:'replace',arguments:{}},{surfaceOp:'replace'}).id,null);assert.equal(f.store.report(f.lib.id).records,0)
})
test('重扫幂等，旧正文不重写；原事件参数变化仅暂停活动功能',t=>{
  const f=fixture(t),r=f.event('tool/call',{name:'read',callId:'same',arguments:{path:'first.txt'}}),before=f.store.record(f.lib.id,r.id).text
  const session={id:'owner',snapshotEvents:from=>f.events.filter(e=>e.seq>=from)}
  f.capture.backfill(f.lib.id,session,{rescan:true});f.capture.backfill(f.lib.id,session,{rescan:true});assert.equal(f.archive.status(f.lib.id).payloads,1)
  f.capture.event(f.lib.id,'owner',{...r.event,data:{name:'read',callId:'same',arguments:{path:'changed.txt'}}})
  assert.equal(f.archive.health(f.lib.id).paused,true);assert.equal(f.archive.health(f.lib.id).error,'SOURCE_CHANGED');assert.equal(f.store.library(f.lib.id).error,null);assert.equal(f.store.record(f.lib.id,r.id).text,before)
})
test('预算超限明确暂停而不截断，修复后补扫只归档、不执行工具',t=>{
  const f=fixture(t,{maxPayloadBytes:8192}),r=f.event('tool/call',{name:'write',callId:'oversize',arguments:{content:'x'.repeat(9000)}})
  assert.equal(r.id,null);assert.equal(f.archive.health(f.lib.id).error,'ACTIVITY_PAYLOAD_LIMIT');assert.equal(f.store.library(f.lib.id).error,null)
  f.archive.maxBytes=32768;f.archive.resume(f.lib.id,'owner');f.capture.backfill(f.lib.id,{id:'owner',snapshotEvents:from=>f.events.filter(e=>e.seq>=from)},{rescan:true})
  assert.equal(f.archive.status(f.lib.id).payloads,1);assert.equal(f.archive.health(f.lib.id).paused,false)
  const id=f.archive.list(f.lib.id).items[0].id;assert.equal(f.all(id).data.arguments.content.length,9000)
})
test('循环数据不留下半条归档；原文聊天继续',t=>{
  const f=fixture(t),args={};args.self=args
  assert.equal(f.event('tool/call',{name:'write',callId:'cycle',arguments:args}).id,null);assert.equal(f.archive.status(f.lib.id).payloads,0)
  const id=f.raw('归档故障期间仍能聊天');assert.equal(f.store.record(f.lib.id,id).text,'归档故障期间仍能聊天');assert.equal(f.store.library(f.lib.id).error,null)
})
test('视频片段需来源、时间区间及出处，成功只表示报告被保存',t=>{
  const f=fixture(t),ref=f.raw('实际可见的字幕来源')
  for(const extra of [{source:null},{start_ms:null},{end_ms:500},{refs:[]},{evidence_type:'host-node'},{observed_at:'2099-01-01T00:00:00Z'}])assert.throws(()=>f.report(ref,extra))
  const r=f.report(ref,{evidence_type:'subtitle'}),record=f.store.record(f.lib.id,r.id),data=f.all(r.id)
  assert.equal(r.scope,'reported-observation');assert.equal(record.role,'note');assert.equal(data.scope,'reported-observation-not-independently-verified');assert.deepEqual(data.media_range_ms,[1000,3000]);assert.equal(data.observed_at,null)
  assert.equal(sourcePosition(record).session,'owner');assert.equal(excludedSource(record,{session:'owner',fromSeq:1}),true)
  assert.throws(()=>new Scenes(f.store).build(f.lib.id,r.id,{exclude:{session:'owner',fromSeq:1}}),{code:'CURRENT_TURN_EXCLUDED'})
})
test('片段键跨交接幂等，改内容另存修订；非owner不能追加',t=>{
  const f=fixture(t),ref=f.raw('字幕来源'),r=f.report(ref)
  assert.equal(f.report(ref).id,r.id);assert.throws(()=>f.report(ref,{body:'改了内容'}),{code:'CONFLICT'})
  f.store.transfer(f.lib.id,'owner','next',f.store.library(f.lib.id).revision)
  assert.equal(f.report(ref,{},'next').id,r.id);assert.throws(()=>f.report(ref),{code:'NOT_OWNER'})
})
test('删除依据清理派生片段、认识和检查点，并阻止重复键复活',t=>{
  const f=fixture(t),ref=f.raw('唯一字幕依据'),a=f.report(ref),b=f.report(a.id,{idempotency_key:'second-fragment'})
  f.store.propose(f.lib.id,{key:'derived',kind:'fact',body:'派生认识',reason:'有出处',refs:[b.id]},true)
  f.store.checkpoint(f.lib.id,'owner','derived-task',{status:'paused',progress:'派生进度',next_step:'待继续'},[b.id],0)
  f.store.removeRecord(f.lib.id,'owner',ref)
  assert.throws(()=>f.store.record(f.lib.id,a.id),{code:'NOT_FOUND'});assert.throws(()=>f.store.record(f.lib.id,b.id),{code:'NOT_FOUND'});assert.equal(f.store.current(f.lib.id).length,0);assert.equal(f.store.tasks(f.lib.id).length,0)
  const fresh=f.raw('新来源');assert.throws(()=>f.report(fresh),{code:'DELETED_SOURCE'});assert.equal(f.archive.status(f.lib.id).reports,0);assert.equal(f.archive.status(f.lib.id).payloads,0)
  assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length,0)
})
test('停用片段依据会停止派生记录参与整理、场景和向量计数，不阻塞后面的新原文',t=>{
  const f=fixture(t),ref=f.raw('旧笔记字幕'),r=f.report(ref),scenes=new Scenes(f.store),embedding=new Embedding(f.store)
  f.store.db.prepare('INSERT INTO cm_legacy_notes(library,legacy_id,rid,active) VALUES(?,?,?,1)').run(f.lib.id,'legacy',ref)
  const log=new SourceLog(f.store),cursor=log.rows(f.lib.id,0).find(row=>row.id===ref).cursor
  f.store.db.prepare('UPDATE cm_legacy_notes SET active=0 WHERE rid=?').run(ref);const next=f.raw('后续仍要整理的新原文')
  assert.throws(()=>scenes.active(f.lib.id,r.id),{code:'SOURCE_INACTIVE'});assert.equal(log.rows(f.lib.id,cursor,1)[0].id,next)
  embedding.prepareChunks(f.lib.id);assert.equal(embedding.status(f.lib.id).parts,1);assert.equal(embedding.status(f.lib.id).unprepared_records,0);embedding.close()
})
test('结构化补充进入增量整理视图，不改变原始正文或旧分片续读',t=>{
  const f=fixture(t),result=f.event('tool/result',{message:{toolCallId:'meta',content:'旧正文不含编号'},structured:{receipt:'AB12345678'}}),log=new SourceLog(f.store)
  const batch=sourceBatch(log,f.lib.id,{system:'test',maxInputChars:3000})
  assert.match(batch.records[0].text,/AB12345678/);assert.equal(batch.records[0].range_basis,'raw-plus-structured-tool-view');assert.equal(f.store.record(f.lib.id,result.id).text,'旧正文不含编号')
  const raw=f.store.record(f.lib.id,result.id),legacy=sourceBatch(log,f.lib.id,{system:'test',maxInputChars:3000,progress:{rid:raw.id,offset:3,digest:raw.digest}})
  assert.equal(legacy.records[0].text,'旧正文不含编号');assert.equal(legacy.records[0].range_basis,undefined)
})
test('结构化活动和来源关联可随一致快照恢复；没有重复执行或重写原库',t=>{
  const f=fixture(t),ref=f.raw('字幕来源'),r=f.report(ref),before=f.store.record(f.lib.id,r.id).digest
  snapshot(f.store,join(f.directory,'snapshot'));restoreCopy(join(f.directory,'snapshot'),join(f.directory,'copy'))
  const copy=new ContinuityStore(join(f.directory,'copy')),archive=new ActivityArchive(copy,{enabled:true})
  try{assert.equal(copy.library(f.lib.id).owner,null);assert.equal(copy.library(f.lib.id).error,'RESTORED_COPY_REQUIRES_REVIEW');assert.equal(archive.status(f.lib.id).reports,1);assert.equal(copy.record(f.lib.id,r.id).digest,before);assert.match(archive.payload(f.lib.id,r.id).text,/reported-observation/)}finally{copy.close()}
  assert.equal(f.store.library(f.lib.id).owner,'owner');assert.equal(f.store.record(f.lib.id,r.id).digest,before)
})
