/** Synthetic sources + real localhost embeddings. No model answers or live DSH session. */
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {WorkingMemory} from '../lib/working-memory.mjs'
import {ContextFrame} from '../lib/context-frame.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'
import {seed,loadCases} from './recall-quality.mjs'

export async function runWorkingQuality(directory=mkdtempSync(join(tmpdir(),'continuity-working-eval-')),{memoryDynamics=false}={}){
  let clock=Date.now();const store=new ContinuityStore(directory,{now:()=>clock}),embedding=new Embedding(store,{memoryDynamics:{enabled:memoryDynamics}}),scenes=new Scenes(store),situations=new Situations(store,scenes),execution=new ExecutionLedger(store)
  const working=new WorkingMemory(store,embedding,scenes,{enabled:true,timeoutMs:10000}),context=new ContextFrame(store,working,situations,execution)
  const data=loadCases(),lib=store.create('Synthetic automatic working-set evaluation'),ids=seed(store,lib.id,data,t=>{clock=t});clock=Date.now()
  store.bind('eval-owner',lib.id,0);store.markRestored('eval-owner')
  const report={synthetic_sources:true,actual_local_embedding:true,cloud_model_calls:0,live_session_access:false,memory_dynamics_enabled:memoryDynamics,directory,rows:[]}
  try{
    do{await embedding.warm(lib.id,'eval-owner')}while(embedding.status(lib.id).index_work_remaining)
    for(const [i,c]of data.cases.entries()){
      const start=performance.now();await working.prepare({library:lib.id,session:'eval-owner',query:c.query,userSeq:1000+i})
      const frame=working.frame(lib.id,'eval-owner'),view=working.view(lib.id,'eval-owner'),text=context.render(lib.id,'eval-owner')
      const injected=text?JSON.parse(text.slice(text.indexOf('\n')+1)):{},prepared=Object.keys(ids).filter(k=>frame.refs.includes(ids[k]))
      const found=Object.keys(ids).filter(k=>(injected.cards||[]).some(c=>ids[k].startsWith(c.id))),stateRefs=(injected.states||[]).flatMap(s=>s.refs).map(r=>store.record(lib.id,r).id)
      const stateFound=Object.keys(ids).filter(k=>stateRefs.includes(ids[k]))
      report.rows.push({id:c.id,split:c.split,query:c.query,expected_sources:c.relevant,prepared_sources:prepared,found_sources:found,state_sources:stateFound,hit:c.relevant.length?c.relevant.some(k=>found.includes(k)):null,with_state_hit:c.relevant.length?c.relevant.some(k=>found.includes(k)||stateFound.includes(k)):null,status:frame.status,characters:Array.from(text).length,states:injected.states||[],ms:performance.now()-start})
    }
    const eligible=report.rows.filter(r=>r.hit!==null),missing=report.rows.filter(r=>r.hit===null)
    report.summary={queries:report.rows.length,source_recall_at_3:eligible.filter(r=>r.hit).length/eligible.length,source_or_current_state_recall:eligible.filter(r=>r.with_state_hit).length/eligible.length,unsupported_source_injections:missing.filter(r=>r.found_sources.length||r.state_sources.length).length,unsupported_queries:missing.length,maximum_automatic_characters:Math.max(...report.rows.map(r=>r.characters)),unavailable:report.rows.filter(r=>r.status==='unavailable').length,measures_source_retrieval_only:true,answer_accuracy_not_measured:true}
    report.index=embedding.status(lib.id)
  }catch(error){report.error={code:error.code,message:error.message}}
  finally{working.close();await embedding.exclusive(null,async()=>{});embedding.close();store.close();writeFileSync(join(directory,'working-quality.json'),JSON.stringify(report,null,2))}
  return report
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const directory=process.argv.slice(2).find(v=>!v.startsWith('--')),r=await runWorkingQuality(directory,{memoryDynamics:process.argv.includes('--dynamics')});console.log(JSON.stringify({directory:r.directory,summary:r.summary,misses:r.rows.filter(v=>v.hit===false).map(v=>v.id),unsupported:r.rows.filter(v=>v.hit===null).map(v=>({id:v.id,found:v.found_sources})),error:r.error}));if(r.error)process.exitCode=1}
