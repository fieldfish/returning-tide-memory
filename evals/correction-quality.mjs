/** Developer-authored synthetic feedback; actual localhost embeddings, no dialogue model. */
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'
const directory=mkdtempSync(join(tmpdir(),'cm-real-correction-')),store=new ContinuityStore(directory),lib=store.create('Synthetic correction quality');store.bind('owner',lib.id,0)
const embedding=new Embedding(store,{memoryDynamics:{enabled:true}}),d=embedding.memoryDynamics,report={synthetic_sources:true,actual_local_embedding:true,dialogue_model_calls:0,rows:[],checks:{}}
try{
 const raw=(seq,text)=>store.append(lib.id,{session:'history',seq,time:new Date(Date.now()-60000+seq*100).toISOString(),role:'user',text})
 const old=raw(1,'导航配色原先是蓝色。'),next=raw(2,'这项现在改为青色。');d.record(lib.id,'owner',{id:old,kind:'corrected',cue:'导航配色',refs:[next],reason:'具体配色已修订'})
 const before=JSON.stringify(store.db.prepare('SELECT * FROM records ORDER BY id').all());do{await embedding.warm(lib.id,'owner')}while(embedding.status(lib.id).index_work_remaining)
 for(const [query,expected] of [['导航配色',true],['导航的颜色现在如何',true],['导航排版怎么安排',false],['我们上次打了什么游戏',false],['导航获得过什么设计奖',false]]){
   const context=await embedding.correctionsFor(lib.id,'owner',query,[old]),assessment=d.assess(lib.id,store.record(lib.id,old),query,undefined,context)
   report.rows.push({query,expected_block:expected,actual_block:assessment.auto_blocked,score:context.events[0]?.score??null,status:context.status})
 }
 report.checks.all_cases_pass=report.rows.every(r=>r.expected_block===r.actual_block);report.checks.originals_unchanged=before===JSON.stringify(store.db.prepare('SELECT * FROM records ORDER BY id').all());report.checks.only_one_owner=store.library(lib.id).owner==='owner'
 assert.ok(Object.values(report.checks).every(Boolean))
}catch(error){report.error={code:error.code,message:error.message};process.exitCode=1}
finally{embedding.close();store.close();writeFileSync(join(directory,'correction-quality.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({directory,...report}))}
