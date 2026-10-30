import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ContinuityStore} from '../lib/store.mjs'
import {Extraction} from '../lib/extraction.mjs'

async function fixture(t,handler) {
  const directory=mkdtempSync(join(tmpdir(),'continuity-wire-test-')),store=new ContinuityStore(directory),library=store.create('线路测试');store.bind('owner',library.id,0)
  const rid=store.append(library.id,{session:'owner',seq:1,time:'2026-10-28T10:00:00Z',role:'user',type:'user/message',text:'已建立一个测试约定，准备以后核对'})
  const server=createServer((req,res)=>handler(req,res,rid));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  process.env.CM_WIRE_TEST_KEY='synthetic-not-a-real-key'
  const x=new Extraction(store);x.configure(library.id,'owner',{source:'api',baseURL:`http://127.0.0.1:${server.address().port}/v1`,model:'fake',apiKeyEnv:'CM_WIRE_TEST_KEY'});x.resume(library.id,'owner')
  t.after(async()=>{await x.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});delete process.env.CM_WIRE_TEST_KEY})
  return {store,x,library,rid}
}
test('真实HTTP 500只发送一次POST，失败后继续调度不再发请求',async t=>{
  let calls=0;const f=await fixture(t,(req,res)=>{calls++;assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');req.resume();res.writeHead(500,{'content-type':'application/json'});res.end('{"error":{"message":"synthetic failure"}}')})
  await assert.rejects(f.x.run(f.library.id,'owner'),{code:'API_HTTP_500'});await f.x.run(f.library.id,'owner');assert.equal(calls,1);assert.equal(f.x.status(f.library.id).paused,true)
})
test('真实HTTP成功：普通fact自动入库；自我候选只提示主会话审视一次',async t=>{
  const f=await fixture(t,(req,res,rid)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{key:'agreement',kind:'fact',body:'用户表达已有测试约定',reason:'原话',refs:[rid]},{key:'goal',kind:'goal',body:'考虑以后核对约定',reason:'候选而非强制目标',refs:[rid]}]})}}],usage:{prompt_tokens:500,completion_tokens:80,prompt_cache_hit_tokens:200}}))})
  f.store.markRestored('owner');await f.x.run(f.library.id,'owner')
  assert.equal(f.store.current(f.library.id).length,1);assert.match(f.store.current(f.library.id)[0].reason,/未经独立核验/)
  const bundle=f.store.restore(f.library.id,'owner');assert.match(bundle.text,/proposals-pending/);assert.match(bundle.text,/候选/);assert.doesNotMatch(bundle.text,/用户表达已有测试约定/)
  f.store.markRestored('owner');assert.equal(f.store.restore(f.library.id,'owner'),null)
  const u=f.store.report(f.library.id).usage[0];assert.equal(u.input,500);assert.equal(u.cache_read,200)
})
test('真实HTTP重定向拒绝，不把提炼请求和密钥转发到新地址',async t=>{
  let calls=0;const f=await fixture(t,(req,res)=>{calls++;req.resume();res.writeHead(302,{location:'/other'});res.end()})
  await assert.rejects(f.x.run(f.library.id,'owner'));assert.equal(calls,1);assert.equal(f.x.status(f.library.id).paused,true)
})
