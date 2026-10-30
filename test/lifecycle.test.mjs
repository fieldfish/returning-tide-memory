import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {createServer} from 'node:http'
import {createPlugin} from '../index.mjs'
import {ContinuityStore} from '../lib/store.mjs'

function environment(t,{badDisposer=false,badRegistration=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'cm-life-')),tools=new Map()
 t.after(()=>{const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('cm-life-'));rmSync(target,{recursive:true,force:true})})
 const ctx={tools:{register:def=>{if(badRegistration&&def.name==='cm_lookup')throw Error('Synthetic registration failure');tools.set(def.name,def);return()=>{tools.delete(def.name);if(badDisposer&&def.name==='cm_read')throw Error('Synthetic unregister failure')}}},agents:{get:()=>null,list:()=>[]},sessions:{flush:async()=>{}},llm:{},on:()=>()=>{},effect:()=>{},logger:{warn:()=>{}}}
 return {directory,tools,ctx}
}
const listen=server=>new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)})
const close=server=>new Promise(r=>server.close(r))

test('管理端口冲突导致初始化失败时，注销工具并释放自己的写锁',async t=>{
 const f=environment(t),occupied=createServer();await listen(occupied);t.after(()=>close(occupied))
 await assert.rejects(createPlugin(f.ctx,{dataDirectory:f.directory,manager:{enabled:true,port:occupied.address().port}},{isAgentLoopRequest:()=>true}),{code:'EADDRINUSE'})
 assert.equal(f.tools.size,0);assert.equal(existsSync(join(f.directory,'host.lock')),false)
 const reopened=new ContinuityStore(f.directory);reopened.close()
})

test('管理令牌文件写入失败时，不遗留监听端口或数据库写锁',async t=>{
 const f=environment(t),probe=createServer();await listen(probe);const port=probe.address().port;await close(probe)
 mkdirSync(join(f.directory,'manager-access.json'))
 await assert.rejects(createPlugin(f.ctx,{dataDirectory:f.directory,manager:{enabled:true,port}},{isAgentLoopRequest:()=>true}))
 assert.equal(existsSync(join(f.directory,'host.lock')),false);assert.equal(f.tools.size,0)
 const again=createServer();await new Promise((r,j)=>{again.once('error',j);again.listen(port,'127.0.0.1',r)});await close(again)
})

test('单个工具注销失败仍清理其余资源，并报告失败而不遗留锁',async t=>{
 const f=environment(t,{badDisposer:true}),plugin=await createPlugin(f.ctx,{dataDirectory:f.directory},{isAgentLoopRequest:()=>true})
 await assert.rejects(plugin.dispose(),AggregateError);assert.equal(f.tools.size,0);assert.equal(existsSync(join(f.directory,'host.lock')),false)
 const reopened=new ContinuityStore(f.directory);reopened.close()
})

test('向量配置或旧索引无效的早期初始化失败不遗留写锁',async t=>{
 const f=environment(t)
 for(const embedding of [{ollamaUrl:'https://example.invalid'},{legacyIndexPath:join(f.directory,'missing.sqlite3')}]){
  await assert.rejects(createPlugin(f.ctx,{dataDirectory:f.directory,embedding},{isAgentLoopRequest:()=>true}))
  assert.equal(existsSync(join(f.directory,'host.lock')),false);assert.equal(f.tools.size,0)
 }
 const reopened=new ContinuityStore(f.directory);reopened.close()
})

test('注册工具中途失败撤销已注册工具并关闭数据库',async t=>{
 const f=environment(t,{badRegistration:true})
 await assert.rejects(createPlugin(f.ctx,{dataDirectory:f.directory},{isAgentLoopRequest:()=>true}),/Synthetic registration/)
 assert.equal(f.tools.size,0);assert.equal(existsSync(join(f.directory,'host.lock')),false)
})

test('恢复上下文挂载中途失败时，也清除已经挂上的部分',async t=>{
 const f=environment(t),initial=new ContinuityStore(f.directory),lib=initial.create('context failure');initial.bind('owner',lib.id,0);initial.close()
 const contexts=new Set();let calls=0
 const agent={status:'idle',session:{id:'owner',header:{}},ctx:{systemPrompt:{context:spec=>{if(++calls===2)throw Error('Synthetic context setup failure');contexts.add(spec.name);return()=>contexts.delete(spec.name)}}}}
 f.ctx.agents={get:()=>agent,list:()=>[agent]}
 await assert.rejects(createPlugin(f.ctx,{dataDirectory:f.directory},{isAgentLoopRequest:()=>true}),/Synthetic context/)
 assert.equal(contexts.size,0);assert.equal(f.tools.size,0);assert.equal(existsSync(join(f.directory,'host.lock')),false)
})
