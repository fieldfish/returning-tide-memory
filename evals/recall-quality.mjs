/** Actual local embedding retrieval against authored scenarios; expected labels never enter source text. */
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'
export const casesPath=new URL('./recall-cases.json',import.meta.url)
export const loadCases=()=>JSON.parse(readFileSync(casesPath,'utf8'))
export function seed(store,lib,data,setClock){
 const ids={};const records=[...data.records].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))
 for(let i=0;i<records.length;i++){const r=records[i];setClock?.(Date.parse(r.time));ids[r.id]=store.append(lib,{session:'synthetic-authored-history',seq:i,time:r.time,role:r.role,text:r.text,origin:{kind:'synthetic-fixture'}});if(r.state){const previous=store.entry(lib,r.state.key);store.propose(lib,{key:r.state.key,kind:'preference',body:r.state.body,reason:'人工编写的合成语料',refs:[ids[r.id]],expectedRevision:previous?.revision||0},r.state.accepted)}}
 return ids
}
export async function runQuality(directory=mkdtempSync(join(tmpdir(),'continuity-recall-eval-'))){
 let clock=Date.now();const store=new ContinuityStore(directory,{now:()=>clock}),embedding=new Embedding(store),data=loadCases(),lib=store.create('Authored recall quality'),ids=seed(store,lib.id,data,t=>{clock=t});clock=Date.now();store.bind('eval-owner',lib.id,0)
 const report={time:new Date().toISOString(),directory,fixture_sha256:createHash('sha256').update(readFileSync(casesPath)).digest('hex'),synthetic_authored_records:true,actual_local_embedding:true,cloud_model_calls:0,rows:[]}
 try{
  do{await embedding.warm(lib.id,'eval-owner')}while(embedding.status(lib.id).index_work_remaining)
  for(const c of data.cases){const start=performance.now(),result=await embedding.lookup(lib.id,'eval-owner',c.query,3),returned=result.results.map(r=>store.record(lib.id,r.id).id),expected=c.relevant.map(x=>ids[x]),rank=returned.findIndex(x=>expected.includes(x));report.rows.push({id:c.id,split:c.split,query:c.query,expected_status:c.expected,relevant:c.relevant,returned:result.results,hit:expected.length?rank>=0:null,reciprocal_rank:expected.length?(rank<0?0:1/(rank+1)):null,ms:performance.now()-start});}
  for(const split of ['all','development','holdout']){const rows=report.rows.filter(r=>(split==='all'||r.split===split)&&r.hit!==null);report[split]={queries:rows.length,hit_at_3:rows.filter(r=>r.hit).length/rows.length,mrr_at_3:rows.reduce((n,r)=>n+r.reciprocal_rank,0)/rows.length}}
  report.unsupported_queries=report.rows.filter(r=>r.hit===null).map(r=>({id:r.id,candidates:r.returned.length,note:'候选并非事实断言，答案正确性另用证据评测'}));report.embedding=embedding.status(lib.id)
 }catch(e){report.error={message:e.message,code:e.code};process.exitCode=1}
 finally{embedding.close();store.close();writeFileSync(join(directory,'recall-results.json'),JSON.stringify(report,null,2))}
 return report
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const r=await runQuality();console.log(JSON.stringify({directory:r.directory,all:r.all,development:r.development,holdout:r.holdout,unsupported_queries:r.unsupported_queries,error:r.error}))}
