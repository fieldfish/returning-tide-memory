import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Extraction} from '../lib/extraction.mjs'
import {evidenceWindow} from '../lib/evidence.mjs'

test('证据窗口命中长文尾部，保留连续原句与字符范围',()=>{
 const value='开头无关🐟。'.repeat(2000)+'图书馆蓝鲸方案尚未发布，只是计划。'
 const found=evidenceWindow(value,'蓝鲸方案是否发布',180)
 assert.ok(found.text.includes('蓝鲸方案尚未发布'))
 assert.equal(found.text,Array.from(value).slice(...found.range).join(''));assert.equal(found.excerpt,true)
})

test('长原文分片整理，重启续读偏移，失败不推进，不漏尾部或改原文',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-long-'));let store=new ContinuityStore(dir),x
 t.after(async()=>{await x?.stop();store.close();rmSync(dir,{recursive:true,force:true})})
 const lib=store.create('synthetic long');store.bind('owner',lib.id,0)
 const original='开头。'+'海🐟"\\\n'.repeat(1800)+'尾部：只是计划，尚未完成。'
 const rid=store.append(lib.id,{session:'owner',seq:1,time:new Date().toISOString(),role:'user',text:original})
 const chars=Array.from(original),seen=new Set();let failNext=false,calls=0
 const make=()=>new Extraction(store,{dshCall:async args=>{
   calls++;assert.ok(args.system.length+args.input.length<=2400)
   const records=JSON.parse(args.input).records
   for(const r of records){assert.equal(r.text,chars.slice(...r.range).join(''));assert.equal(r.id,rid)}
   if(failNext){failNext=false;throw Object.assign(Error('synthetic failure'),{code:'SYNTHETIC'})}
   for(const r of records)for(let i=r.range[0];i<r.range[1];i++)seen.add(i)
   return {text:'{"items":[]}',usage:{inputTokens:10,outputTokens:2}}
 }})
 x=make();x.configure(lib.id,'owner',{source:'dsh',provider:'test',model:'test',maxInputChars:2400,maxCallsPerDay:100,minIntervalMs:0});x.resume(lib.id,'owner')
 await x.run(lib.id,'owner')
 const first={...store.db.prepare('SELECT * FROM cm_extraction_progress').get()};assert.ok(first.offset>0);assert.equal(x.status(lib.id).cursor,0)
 failNext=true;await assert.rejects(x.run(lib.id,'owner'),{code:'SYNTHETIC'})
 assert.deepEqual({...store.db.prepare('SELECT * FROM cm_extraction_progress').get()},first)
 const failedCalls=calls;await x.run(lib.id,'owner');assert.equal(calls,failedCalls)
 await x.stop();store.close();store=new ContinuityStore(dir);x=make();x.resume(lib.id,'owner')
 for(let i=0;i<100&&x.dueIn(lib.id)!==null;i++)await x.run(lib.id,'owner')
 assert.equal(x.dueIn(lib.id),null);assert.equal(seen.size,chars.length)
 assert.equal(store.db.prepare('SELECT count(*) n FROM cm_extraction_progress').get().n,0)
 assert.equal(store.db.prepare('SELECT text FROM records WHERE id=?').get(rid).text,original)
 assert.equal(store.library(lib.id).owner,'owner')
})
