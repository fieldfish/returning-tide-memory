import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'
const storeURL=new URL('../lib/store.mjs',import.meta.url).href,ledgerURL=new URL('../lib/execution.mjs',import.meta.url).href
function directory(t,before=()=>{}){const dir=mkdtempSync(join(tmpdir(),'cm-fault-boundary-'));t.after(()=>{before();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})});return dir}
function child(code){const p=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>{out+=b});p.stderr.on('data',b=>{err+=b});const done=new Promise((r,j)=>{p.once('error',j);p.once('close',(code,signal)=>r({code,signal,out,err}))});return {p,done}}

test('事务未提交时强制终止子进程，旧原文保留且未知动作不重放',{timeout:10000},async t=>{
 const dir=directory(t);let s=new ContinuityStore(dir);const lib=s.create('atomic crash');s.bind('owner',lib.id,0);const rid=s.append(lib.id,{session:'owner',seq:1,time:'2026-01-01T00:00:00Z',role:'user',text:'已提交旧原文🐟'});s.close()
 const marker=join(dir,'ready'),worker=child(`import {ContinuityStore} from ${JSON.stringify(storeURL)};import {ExecutionLedger} from ${JSON.stringify(ledgerURL)};import {writeFileSync} from 'node:fs';const s=new ContinuityStore(${JSON.stringify(dir)}),l=new ExecutionLedger(s);s.begin(${JSON.stringify(lib.id)},'owner','main');l.start(${JSON.stringify(lib.id)},'owner',{name:'synthetic_external',callId:'before-crash',arguments:{}});s.tx(()=>{s.append(${JSON.stringify(lib.id)},{session:'owner',seq:2,time:'2026-01-02T00:00:00Z',role:'assistant',text:'未提交的新原文'});writeFileSync(${JSON.stringify(marker)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)})`)
 try{const end=Date.now()+5000;while(!existsSync(marker)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(marker));worker.p.kill('SIGKILL');await worker.done;s=new ContinuityStore(dir);new ExecutionLedger(s);assert.equal(s.read(lib.id,rid).text,'已提交旧原文🐟');assert.equal(s.db.prepare('SELECT count(*) n FROM records').get().n,1);assert.equal(s.library(lib.id).owner,'owner');assert.equal(s.recovery.pending(lib.id).operations.length,1);assert.equal(s.busy(lib.id),null);assert.equal(s.db.prepare('PRAGMA quick_check').get().quick_check,'ok')}
 finally{worker.p.kill('SIGKILL');await worker.done;s.close()}
})

test('多个真实子进程争用同一库时，全部拒绝抢占仍存活的写者',{timeout:10000},async t=>{
 let s;const dir=directory(t,()=>s?.close());s=new ContinuityStore(dir);const token=s.lockToken
 const code=`import {ContinuityStore} from ${JSON.stringify(storeURL)};try{new ContinuityStore(${JSON.stringify(dir)});process.exitCode=2}catch(e){if(e.code!=='HOST_ALREADY_RUNNING')throw e;console.log('blocked')}`
 const workers=Array.from({length:3},()=>child(code));const results=await Promise.all(workers.map(w=>w.done));for(const r of results){assert.equal(r.code,0,r.err);assert.match(r.out,/blocked/)}assert.equal(s.lockToken,token);assert.ok(existsSync(s.lockPath))
})

test('SQLite页配额导致日志写入失败时，不执行外部工具且保留旧记录',t=>{
 let s;const dir=directory(t,()=>s?.close());s=new ContinuityStore(dir);const ledger=new ExecutionLedger(s),lib=s.create('page quota');s.bind('owner',lib.id,0);const rid=s.append(lib.id,{session:'owner',seq:1,time:'2026-01-01T00:00:00Z',role:'user',text:'不能丢的已提交记录'})
 const count=s.db.prepare('PRAGMA page_count').get().page_count;s.db.exec('PRAGMA max_page_count='+count)
 let externalEffects=0
 assert.throws(()=>{ledger.start(lib.id,'owner',{name:'synthetic_external',callId:'requires-pages-'+('x'.repeat(16000)),arguments:{}});externalEffects++},e=>e.errcode===13||/full/i.test(e.message))
 assert.equal(externalEffects,0);assert.equal(s.db.prepare('SELECT count(*) n FROM cm_tool_operations').get().n,0);assert.equal(s.read(lib.id,rid).text,'不能丢的已提交记录');assert.equal(s.db.prepare('PRAGMA quick_check').get().quick_check,'ok')
})
