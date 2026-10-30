/** Synthetic native events + actual localhost embedding. No tool execution or answer model. */
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'
import {Capture} from '../lib/capture.mjs'
import {ActivityArchive} from '../lib/activity-archive.mjs'

export async function runActivityQuality(directory=mkdtempSync(join(tmpdir(),'continuity-activity-eval-'))){
  const store=new ContinuityStore(directory),embedding=new Embedding(store),archive=new ActivityArchive(store,{enabled:true}),capture=new Capture(store,archive),lib=store.create('Synthetic activity archive evaluation'),session='synthetic-eval-owner'
  store.bind(session,lib.id,0)
  const ids={},event=(key,seq,type,data)=>{ids[key]=capture.event(lib.id,session,{seq,time:new Date(Date.now()-60000+seq*1000).toISOString(),type,data})}
  const report={directory,synthetic_sources:true,actual_local_embedding:true,cloud_model_calls:0,external_tool_executions:0,live_session_access:false,rows:[]}
  const original=()=>JSON.stringify({records:store.db.prepare('SELECT * FROM records ORDER BY id').all(),payloads:store.db.prepare('SELECT * FROM cm_activity_payloads ORDER BY rid').all(),owner:store.library(lib.id).owner})
  try{
    event('sea_request',1,'tool/call',{name:'write',callId:'synthetic-sea-write',arguments:{path:'sea-clip-opening.html',description:'海螺片头网页的蓝灰色开场',content:'<header>海螺片头</header>'}})
    event('sea_result',2,'tool/result',{message:{toolCallId:'synthetic-sea-write',content:'合成宿主返回：草稿写入操作已返回'},structured:{receipt:'SEA-CLIP-4820137'}})
    event('forest_request',3,'tool/call',{name:'read',callId:'synthetic-forest-read',arguments:{path:'forest-edit-notes.txt',purpose:'松针森林剪辑的字幕校对'}})
    event('forest_result',4,'tool/result',{message:{toolCallId:'synthetic-forest-read',content:'合成字幕资料：镜头前两秒使用轻微推镜。'},structured:{subtitle_marker:'FOREST-7C2'}})
    event('internal',5,'tool/call',{name:'cm_activity',callId:'synthetic-observe',arguments:{action:'observe'}})
    ids.observation=archive.report(lib.id,session,{kind:'video',title:'松针森林视频两秒镜头',body:'主体报告：字幕指出开头两秒缓慢推镜，没有证据证明观看已经完成。',source:'https://example.invalid/forest-video',start_ms:0,end_ms:2000,evidence_type:'subtitle',refs:[ids.forest_result],idempotency_key:'forest-view-one'}, {session,seq:5}).id
    const before=original()
    do{await embedding.warm(lib.id,session)}while(embedding.status(lib.id).index_work_remaining)
    const cases=[
      {id:'request-path',query:'海螺片头网页打算保存到哪个文件',expected:['sea_request']},
      {id:'structured-receipt',query:'SEA-CLIP-4820137 是哪个工具返回的编号',expected:['sea_result']},
      {id:'read-parameters',query:'松针森林剪辑字幕校对要读取哪个文件',expected:['forest_request']},
      {id:'tool-text',query:'开头两秒轻微推镜的字幕资料',expected:['forest_result']},
      {id:'observation-range',query:'松针森林视频两秒镜头记录的媒体位置',expected:['observation']},
      {id:'missing-mars',query:'我上周买的火星土壤样本批次号',expected:[],kind:'unsupported-unrelated'},
      {id:'missing-seat',query:'北极演唱会门票座位号码',expected:[],kind:'unsupported-unrelated'},
      {id:'related-missing-award',query:'松针森林视频获得了什么国际大奖',expected:[],kind:'related-not-answer-bearing'}
    ]
    for(const c of cases){
      const start=performance.now(),result=await embedding.lookup(lib.id,session,c.query,3,null,null,{readOnlyIndex:true}),found=Object.keys(ids).filter(key=>ids[key]&&result.results.some(card=>ids[key].startsWith(card.id)))
      report.rows.push({id:c.id,kind:c.kind||'positive',query:c.query,expected:c.expected,found,hit:c.expected.length?c.expected.some(key=>found.includes(key)):null,characters:Array.from(JSON.stringify(result)).length,ms:performance.now()-start,answer_support:'unassessed',cards:result.results})
    }
    const excluded=await embedding.lookup(lib.id,session,'松针森林视频两秒镜头',5,null,{session,fromSeq:5},{readOnlyIndex:true}),later=await embedding.lookup(lib.id,session,'松针森林视频两秒镜头',5,null,{session,fromSeq:6},{readOnlyIndex:true})
    const positives=report.rows.filter(c=>c.hit!==null),missing=report.rows.filter(c=>c.kind==='unsupported-unrelated'),related=report.rows.find(c=>c.kind==='related-not-answer-bearing')
    report.summary={queries:cases.length,positive_queries:positives.length,hits_at_3:positives.filter(c=>c.hit).length,unrelated_unsupported_queries:missing.length,unrelated_queries_with_candidates:missing.filter(c=>c.found.length).length,related_unsupported_candidates:related.found,maximum_compact_characters:Math.max(...report.rows.map(c=>c.characters)),measures_source_retrieval_only:true,answer_accuracy_not_measured:true}
    report.invariants={original_records_and_payloads_unchanged:original()===before,current_report_excluded:!excluded.results.some(c=>ids.observation.startsWith(c.id)),report_available_in_later_turn:later.results.some(c=>ids.observation.startsWith(c.id)),internal_tool_not_archived:ids.internal===null,owner_unchanged:store.library(lib.id).owner===session}
    if(!Object.values(report.invariants).every(Boolean))throw Error('Activity evaluation invariant failed')
    report.archive=archive.status(lib.id);report.index=embedding.status(lib.id)
    report.caveat='Actual embeddings over five authored synthetic records. Tool-call events were not executed. An observation is an attributed report; a retrieved near-topic candidate does not prove an award, viewing completion, or answer correctness.'
  }catch(error){report.error={code:error.code||error.name,message:error.message}}
  finally{embedding.close();store.close();writeFileSync(join(directory,'activity-quality.json'),JSON.stringify(report,null,2))}
  return report
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const r=await runActivityQuality(process.argv[2]);console.log(JSON.stringify({directory:r.directory,summary:r.summary,invariants:r.invariants,error:r.error}));if(r.error)process.exitCode=1}
