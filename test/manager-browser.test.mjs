import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {createPlugin} from '../index.mjs'
const settle=ms=>new Promise(r=>setTimeout(r,ms))
function browserCandidates(){
 return [process.env.DSH_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome',process.env.CHROME_PATH].filter(Boolean)
}
async function devtoolsUrl(child,timeoutMs=15000){
 return new Promise((resolve,reject)=>{
  let buffer='';const timer=setTimeout(()=>reject(Object.assign(new Error('browser did not expose DevTools in time'),{code:'BROWSER_TIMEOUT'})),timeoutMs)
  child.stderr.on('data',chunk=>{buffer+=chunk;const match=buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1])}})
  child.once('error',error=>{clearTimeout(timer);reject(error)})
  child.once('exit',()=>{clearTimeout(timer);reject(Object.assign(new Error('browser exited before DevTools was ready'),{code:'BROWSER_EXITED'}))})
 })
}
async function connect(wsUrl){
 const socket=new WebSocket(wsUrl)
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=()=>reject(new Error('CDP socket failed'))})
 let id=0;const pending=new Map()
 socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id)}}
 const send=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,message=>message.error?reject(new Error(message.error.message)):resolve(message.result));socket.send(JSON.stringify({id:next,method,params}))})
 return {send,close:()=>socket.close()}
}
async function managerFixture(t){
 const directory=mkdtempSync(join(tmpdir(),'cm-browser-manager-')),agents=new Map(),listeners=new Map(),tools=new Map()
 const agent={status:'idle',session:{id:'synthetic-browser-owner',header:{},snapshotEvents:()=>[]},ctx:{systemPrompt:{context:()=>()=>{}}},cancel:()=>{},whenIdle:async()=>{}}
 agents.set(agent.session.id,agent);let modelCalls=0
 const ctx={agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},sessions:{flush:async()=>{}},llm:{prepareCall:()=>{modelCalls++;throw Error('must not call a model')}},tools:{register:def=>{tools.set(def.name,def);return()=>tools.delete(def.name)}},on:(name,fn)=>{const list=listeners.get(name)||[];list.push(fn);listeners.set(name,list);return()=>{}},effect:()=>{},logger:{warn:()=>{}}}
 const plugin=await createPlugin(ctx,{dataDirectory:directory,manager:{enabled:true}},{isAgentLoopRequest:()=>true})
 const token=new URL(plugin.manager.url).hash.slice(1)
 const create=(await fetch(plugin.manager.origin+'/api',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action:'create',name:'Synthetic browser library'})})).json()
 const library_id=(await create).result.library.id
 await fetch(plugin.manager.origin+'/api',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action:'bind',library_id,session:agent.session.id,expected_revision:0})})
 t.after(async()=>{await plugin.dispose();rmSync(directory,{recursive:true,force:true})})
 return {plugin,agent,library_id,token,modelCalls:()=>modelCalls,url:plugin.manager.url}
}
test('the authenticated manager page discovers, preserves and resolves a pending item in a real browser',{timeout:120000},async t=>{
 const open=browserCandidates().find(path=>existsSync(path))
 if(!open){t.skip('no local Chromium-family browser found; set DSH_TEST_BROWSER to run this regression');return}
 const f=await managerFixture(t),profile=mkdtempSync(join(tmpdir(),'cm-browser-profile-'))
 let child=null
 try{child=spawn(open,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-gpu','--disable-extensions','--disable-sync','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true})}
 catch(error){if(['EPERM','ENOENT','EACCES'].includes(error.code)){t.skip('browser launch is blocked in this sandbox: '+error.code);return}throw error}
 let page=null
 t.after(async()=>{try{page?.close()}catch{}try{child?.kill()}catch{}await settle(200);rmSync(profile,{recursive:true,force:true})})
 let devtools
 try{devtools=await devtoolsUrl(child)}catch(error){if(['EPERM','ENOENT','EACCES'].includes(error.code)){t.skip('browser launch is blocked in this sandbox: '+error.code);return}throw error}
 const port=new URL(devtools).port
 const created=await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(f.url)}`,{method:'PUT'})).json()
 page=await connect(created.webSocketDebuggerUrl)
 await page.send('Runtime.enable');await page.send('Page.enable')
 await page.send('Page.bringToFront').catch(()=>{})
 const evaluate=async expression=>{const r=await page.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});return r?.result?.value}
 const waitFor=async(expression,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await settle(120)}throw new Error('timed out waiting for: '+expression)}
 await waitFor("document.readyState==='complete'&&!!document.getElementById('recoveryJump')")
 await waitFor("!!document.getElementById('library')&&document.getElementById('library').options.length>0")
 // The page is already open; the pending item arrives afterwards.
 const store=f.plugin.store
 store.recovery.observe(f.library_id,f.agent.session.id,{type:'tool/call',data:{name:'mock_send',callId:'browser-one'}})
 store.recovery.observe(f.library_id,f.agent.session.id,{type:'tool/result',data:{message:{toolCallId:'browser-one'},error:{code:'ABORTED'}}})
 assert.equal(store.recovery.needsReview(f.library_id),true)
 await evaluate("document.getElementById('recoveryJump').click()")
 await waitFor("document.querySelectorAll('#recovery .item').length===1")
 assert.match(await evaluate("document.querySelector('#recovery .item').textContent"),/mock_send/)
 assert.match(await evaluate("document.querySelector('#recovery .item').textContent"),/ABORTED/)
 // Human input survives the 10s operational health poll.
 await evaluate("(()=>{const row=document.querySelector('#recovery .item');const select=row.querySelector('select');select.value='abandon-no-replay';select.dispatchEvent(new Event('change',{bubbles:true}));const input=row.querySelector('input');input.value='synthetic browser note';input.dispatchEvent(new Event('input',{bubbles:true}));return input.value})()")
 await settle(11000)
 assert.equal(await evaluate("document.querySelector('#recovery .item input').value"),'synthetic browser note')
 assert.equal(await evaluate("document.querySelectorAll('#recovery .item').length"),1)
 // Confirming an old uncertain item works even while the owner agent is running.
 f.agent.status='running'
 await evaluate("(()=>{const row=document.querySelector('#recovery .item');[...row.querySelectorAll('button')].find(b=>b.textContent.trim().length>0&&b.closest('.item')).click();return true})()")
 await waitFor("document.querySelectorAll('#recovery .item').length===0",20000)
 const stored=store.db.prepare("SELECT status,decision,note FROM cm_tool_operations WHERE call_id='browser-one'").get()
 assert.equal(stored.status,'reviewed');assert.equal(stored.decision,'abandon-no-replay');assert.equal(stored.note,'synthetic browser note')
 assert.equal(store.recovery.needsReview(f.library_id),false)
 assert.equal(f.modelCalls(),0)
})
