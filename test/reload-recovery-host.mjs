import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:http'
import {createPlugin} from '../index.mjs'
import {ContinuityStore} from '../lib/store.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'

const runtimeDirectory=process.env.DSH_SDK_RUNTIME
assert.ok(runtimeDirectory&&existsSync(join(runtimeDirectory,'package.json')),'Set DSH_SDK_RUNTIME to the installed DSH runtime directory')
const runtime=join(resolve(runtimeDirectory),'package.json'),require=createRequire(runtime),load=async name=>import(pathToFileURL(require.resolve(name)).href),yaml=require('js-yaml')
const directory=mkdtempSync(join(tmpdir(),'rt-reload-host-')),home=join(directory,'home'),workspace=join(directory,'workspace'),data=join(directory,'memory'),profile=join(home,'profiles','reload-test'),sid='synthetic-reload-owner',target=join(workspace,'completed-output.txt')
for(const path of [home,workspace,profile])mkdirSync(path,{recursive:true})
const report={directory,cloud_model_calls:0,live_chat_messages:0,tool_effects:0,checks:{}}
let boot,handle,memory,server
try{
 const seed=new ContinuityStore(data),lib=seed.create('Synthetic reload integration'),unknown=seed.create('Synthetic missing-result control')
 seed.bind(sid,lib.id,0);seed.bind('synthetic-control-owner',unknown.id,0)
 const original=seed.append(lib.id,{session:'synthetic-history',seq:1,time:'2026-11-01T00:00:00Z',role:'user',text:'Synthetic source preserved across reload'})
 new ExecutionLedger(seed).start(unknown.id,'synthetic-control-owner',{callId:'truly-unconfirmed',name:'synthetic_write',arguments:{}});seed.close()
 server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'synthetic-reload-embedding',digest:'synthetic-v1'}]}));let body='';for await(const part of req)body+=part;const payload=JSON.parse(body);res.end(JSON.stringify({embeddings:payload.input.map(()=>[1,0])}))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 writeFileSync(join(profile,'package.json'),JSON.stringify({name:'synthetic-reload-profile',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}}}))
 writeFileSync(join(profile,'cordis.patch.yml'),yaml.dump([{id:'session-title-llm',disabled:true},{id:'hmr',disabled:true},{id:'settings',disabled:true},{id:'config-editor',disabled:true},{id:'plugin-manager',disabled:true},{id:'deepseek-account',config:{desktopPlatform:'win32'}},{id:'session-persistence-jsonl',config:{root:join(home,'sessions')}},{id:'storage-json',config:{root:join(home,'storages')}},{id:'system-prompt',config:{personaPrefix:''}}]))
 process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1';process.chdir(workspace)
 const {runProfile}=await load('@deepseek-ai/dsh/profile-boot'),{createLaunchEnvironmentSnapshot}=await load('@deepseek-ai/dsh-launch-environment'),{LlmAdapter,createToolResultMessage,createAssistantMessage}=await load('@deepseek-ai/dsh-llm')
 class NoModel extends LlmAdapter{async resolveModel(provider,model){return {provider,id:model,name:model,context:{contextWindow:100000},systemPromptUpdate:'in-history'}}async *stream(){report.cloud_model_calls++;throw Error('No dialogue model call is allowed in this integration')}}
 const start=async()=>{const started=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:{...process.env}}]),profile:'reload-test',patchFiles:[],args:[]});started.ctx.llm.registerAdapter(['synthetic-reload'],new NoModel());return started}
 const config={dataDirectory:data,runtimePackageJson:runtime,manager:{enabled:false},workingMemory:{enabled:false},embedding:{model:'synthetic-reload-embedding',ollamaUrl:'http://127.0.0.1:'+server.address().port}}
 boot=await start();handle=await boot.ctx.agents.create({sessionId:sid,meta:{cwd:workspace},agentOptions:{provider:'synthetic-reload',model:'synthetic-only',maxTokens:64}})
 memory=await createPlugin(boot.ctx,config)
 const agent=handle.agent,callId='synthetic-reload-write',remove=agent.ctx.tools.register({name:'synthetic_reload_write',description:'Synthetic local operation completing during memory-plugin unload.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',properties:{applied:{type:'boolean'}},required:['applied'],additionalProperties:false},render:()=> [{type:'text',text:'Synthetic local result'}]},execute:async()=>{report.tool_effects++;writeFileSync(target,'Synthetic applied output');await memory.dispose();return {applied:true}}})
 agent.session.append('turn/start',{turn:1});agent.session.append('step/start',{turn:1,step:1})
 agent.session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'synthetic-reload',model:'synthetic-only'},content:[{type:'tool-call',id:callId,name:'synthetic_reload_write',arguments:'{}'}]}),stream:[{type:'tool-call-delta',index:0,id:callId,name:'synthetic_reload_write',argumentsDelta:'{}'},{type:'finish',reason:{kind:'stop'}}]},{surfaceOp:'append'})
 const call=agent.session.append('tool/call',{turn:1,step:1,callId,name:'synthetic_reload_write',arguments:'{}'})
 const result=await agent.ctx.tools.execute({agent,callId,name:'synthetic_reload_write',arguments:{},signal:AbortSignal.timeout(10000)})
 report.host_result={isError:result.isError,error:result.error}
 assert.equal(result.isError,false,'a completed host operation must not become a closed-database error')
 agent.session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId,content:result.content,isError:result.isError})},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
 assert.equal(await boot.ctx.sessions.flush(agent.session),true)
 const before=new ContinuityStore(data);assert.equal(before.recovery.needsReview(lib.id),true,'the missed outcome is still unresolved before native evidence is checked');before.close()
 report.checks.unload_preserves_actual_tool_result=true
 remove();await handle.dispose();handle=null;await boot.shutdown.shutdown(0);boot=null
 boot=await start();handle=await boot.ctx.agents.resume({resumeSessionId:sid,agentOptions:{provider:'synthetic-reload',model:'synthetic-only',maxTokens:64}})
 assert.equal(handle.agent.session.id,sid)
 memory=await createPlugin(boot.ctx,config)
 const reconciled=memory.execution.reconcileNativeResults(lib.id,handle.agent.session)
 assert.equal(reconciled.recovered,1,JSON.stringify(reconciled))
 assert.equal(memory.store.recovery.needsReview(lib.id),false)
 memory.store.recovery.assertTool(lib.id,'write',{file_path:target,content:'Not executed by this test'})
 assert.equal(memory.store.recovery.needsReview(unknown.id),true,'a genuinely missing result must still require review')
 assert.equal(memory.store.library(lib.id).owner,sid)
 assert.equal(memory.store.record(lib.id,original).text,'Synthetic source preserved across reload')
 assert.equal(readFileSync(target,'utf8'),'Synthetic applied output');assert.equal(report.tool_effects,1)
 report.checks.same_session_restart_reconciles_persisted_success=true
 report.checks.unknown_control_preserved=true
 report.checks.no_replay_or_source_change=true
 await memory.dispose();memory=await createPlugin(boot.ctx,config)
 assert.equal(memory.execution.reconcileNativeResults(lib.id,handle.agent.session).recovered,0)
 assert.equal(memory.store.recovery.needsReview(lib.id),false)
 report.checks.clean_followup_reload_needs_no_acknowledgement=true
 assert.equal(report.cloud_model_calls,0)
}catch(error){report.error={message:error.message,stack:error.stack};process.exitCode=1}
finally{
 try{await memory?.dispose();await handle?.dispose();await boot?.shutdown.shutdown(process.exitCode||0)}catch(error){report.cleanup_error=error.message;process.exitCode=1}
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
 writeFileSync(join(directory,'reload-recovery-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
