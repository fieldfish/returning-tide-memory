import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {tmpdir} from 'node:os'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),baseline=process.argv[2]==='child'?process.argv[5]:process.argv[2];assert.ok(baseline,'Provide an absolute beta2 baseline directory')
if(process.argv[2]==='child'){
 const [version,directory]=process.argv.slice(3),meta=JSON.parse(readFileSync(join(directory,'fixture.json'),'utf8'))
 const {Embedding:Vector}=await import(pathToFileURL(join(version==='beta2'?resolve(baseline):root,'lib/embedding.mjs')).href)
 const store=new ContinuityStore(directory),e=new Vector(store),rows=[]
 e.cached=meta.key;e.identity=async()=>meta.key;e.embed=async inputs=>inputs.map(q=>{const v=new Float32Array(meta.dimensions);v[q.includes('不存在')?2:0]=1;return v})
 try{
  for(let i=0;i<12;i++){
   const query=i%3===0?'海蓝计划 QPROJ-0009863':i%3===1?'海洋 笔记':'不存在的土卫六蜂蜜菜谱',start=performance.now()
   const result=await e.lookup(meta.library,'bench-owner',query,5)
   rows.push({query,ms:performance.now()-start,ids:result.results.map(r=>r.id),summaries:result.results.map(r=>r.summary)})
   if(query.includes('不存在'))assert.equal(result.results.length,0)
   else if(query.includes('QPROJ'))assert.equal(result.results[0].id,meta.target.slice(0,10))
  }
  const times=rows.map(r=>r.ms).sort((a,b)=>a-b)
  console.log(JSON.stringify({version,records:meta.records,dimensions:meta.dimensions,calls:rows.length,median_ms:times[Math.floor(times.length/2)],p95_ms:times[Math.ceil(times.length*.95)-1],peak_rss_kib:process.resourceUsage().maxRSS,rows,model_calls:0,synthetic_vectors:true}))
 }finally{e.close();store.close()}
}else{
 const directory=mkdtempSync(join(tmpdir(),'continuity-benchmark-')),store=new ContinuityStore(directory),e=new Embedding(store),lib=store.create('Synthetic performance fixture'),dimensions=1024,count=10000,key=createHash('sha256').update('synthetic-benchmark-unit-f32').digest('hex')
 store.bind('bench-owner',lib.id,0);let target
 store.tx(()=>{
  const chunk=store.db.prepare('INSERT INTO cm_vector_chunks VALUES(?,?,?,?,?)'),prepared=store.db.prepare('INSERT INTO cm_vector_prepared VALUES(?,?)'),vector=store.db.prepare('INSERT INTO cm_vectors VALUES(?,?,?,?,?,?)')
  for(let i=0;i<count;i++){
   const text=(i===9863?'海蓝计划 唯一编号 QPROJ-0009863，最终确定每周四整理作品。':`合成资料第${i}条，${i%7===0?'海洋':'散步'}${i%5===0?'笔记':'记录'}。`)+('这段材料仅用于本地性能测试。'.repeat(30)),rid=store.append(lib.id,{session:'synthetic-benchmark-history',seq:i,time:new Date(Date.UTC(2026,0,1)+i*1000).toISOString(),role:'user',text})
   if(i===9863)target=rid
   chunk.run(lib.id,rid,0,text,createHash('sha256').update(text).digest('hex'));prepared.run(rid,lib.id)
   const value=Buffer.alloc(dimensions*4),score=i===9863?.99:.51+.45*i/count;value.writeFloatLE(score,0);value.writeFloatLE(Math.sqrt(1-score*score),4);vector.run(lib.id,rid,0,key,dimensions,value)
  }
 });e.close();store.close();writeFileSync(join(directory,'fixture.json'),JSON.stringify({library:lib.id,key,target,dimensions,records:count}))
 const reports=[]
 for(const version of ['beta2','beta3']){
  const p=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'child',version,directory,baseline],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024})
  assert.equal(p.status,0,p.stderr);reports.push(JSON.parse(p.stdout.trim()))
 }
 for(let i=0;i<reports[0].rows.length;i++){assert.deepEqual(reports[0].rows[i].ids,reports[1].rows[i].ids);assert.deepEqual(reports[0].rows[i].summaries,reports[1].rows[i].summaries)}
 const result={time:new Date().toISOString(),directory,fixture:{records:count,dimensions,model_calls:0,synthetic_vectors:true},same_ranked_ids_and_summaries:true,results:reports,memory_reduction_percent:100*(1-reports[1].peak_rss_kib/reports[0].peak_rss_kib),median_change_percent:100*(reports[1].median_ms/reports[0].median_ms-1)}
 writeFileSync(join(directory,'benchmark-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,results:reports.map(({rows,...r})=>r)}))
}

