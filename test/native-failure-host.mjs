import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,cpSync,lstatSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
const runtimeDirectory=process.env.DSH_SDK_RUNTIME;assert.ok(runtimeDirectory&&existsSync(join(runtimeDirectory,'package.json')),'Set DSH_SDK_RUNTIME to the installed DSH runtime directory')
const candidate=fileURLToPath(new URL('../',import.meta.url));const {ContinuityStore}=await import(pathToFileURL(join(candidate,'lib/store.mjs')).href)
const root=mkdtempSync(join(tmpdir(),'rt-native-failure-host-')),out=join(root,'reviewer-host-boundaries-'+Date.now()),home=join(out,'home'),workspace=join(out,'workspace'),directory=join(out,'memory'),profile=join(home,'profiles','pending-test'),sid='synthetic-pending-main',source=candidate
for(const p of [home,workspace,join(profile,'node_modules')])mkdirSync(p,{recursive:true})
const runtime=join(runtimeDirectory,'package.json'),require=createRequire(runtime),load=async n=>import(pathToFileURL(require.resolve(n)).href),yaml=require('js-yaml'),report={directory:root,isolated:true,cloud_calls:0,real_session_messages:0,checks:{},requests:[]}
let boot,handle,server
try{
 const seed=new ContinuityStore(directory),lib=seed.create('Synthetic pending-message test');seed.bind(sid,lib.id,0)
 const old=seed.append(lib.id,{session:'synthetic-history',seq:1,time:new Date().toISOString(),role:'user',text:'蓝色台灯放在七号架，只是合成记录，尚未购买。'});seed.close()
 server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'synthetic-embedding',digest:'synthetic-v1'}]}));let text='';for await(const c of req)text+=c;const r=JSON.parse(text);res.end(JSON.stringify({embeddings:r.input.map(s=>/lamp|台灯/i.test(s)?[1,0]:[0,1])}))});await new Promise(r=>server.listen(0,'127.0.0.1',r))
 writeFileSync(join(profile,'package.json'),JSON.stringify({name:'dsh-profile-pending-test',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','dsh-returning-tide-memory']}}}))
 const testPackage=join(profile,'node_modules','dsh-returning-tide-memory');mkdirSync(testPackage)
 for(const entry of ['package.json','index.mjs','cli.mjs','lib','web','cordis.patch.yml'])cpSync(join(source,entry),join(testPackage,entry),{recursive:true,dereference:false,filter:path=>{if(lstatSync(path).isSymbolicLink())throw Error('Test runtime copy rejects every directory link');return true}})
 const patch=[{id:'session-title-llm',disabled:true},{id:'hmr',disabled:true},{id:'settings',disabled:true},{id:'config-editor',disabled:true},{id:'plugin-manager',disabled:true},{id:'deepseek-account',config:{desktopPlatform:'win32'}},{id:'session-persistence-jsonl',config:{root:join(home,'sessions')}},{id:'storage-json',config:{root:join(home,'storages')}},{id:'system-prompt',config:{personaPrefix:''}},{id:'continuity-core',config:{dataDirectory:directory,runtimePackageJson:runtime,manager:{enabled:true},workingMemory:{enabled:true},embedding:{ollamaUrl:'http://127.0.0.1:'+server.address().port,model:'synthetic-embedding'},memoryDynamics:{enabled:true}}}]
 writeFileSync(join(profile,'cordis.patch.yml'),yaml.dump(patch));process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1';process.chdir(workspace)
 const {runProfile}=await load('@deepseek-ai/dsh/profile-boot'),{createLaunchEnvironmentSnapshot}=await load('@deepseek-ai/dsh-launch-environment'),{LlmAdapter}=await load('@deepseek-ai/dsh-llm')
 boot=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:{...process.env}}]),profile:'pending-test',patchFiles:[],args:[]})
 class Synthetic extends LlmAdapter{
  async resolveModel(provider,model){return {provider,id:model,name:model,context:{contextWindow:100000},systemPromptUpdate:'in-history'}}
  async *stream(options){report.requests.push(structuredClone({...options,signal:undefined}));yield {type:'text-delta',text:'Synthetic response; no external actions.'};yield {type:'finish',reason:{kind:'stop'}}}
 }
 boot.ctx.llm.registerAdapter(['synthetic-pending'],new Synthetic())
 handle=await boot.ctx.agents.create({sessionId:sid,meta:{cwd:workspace},agentOptions:{provider:'synthetic-pending',model:'synthetic-model',maxTokens:300}})
 const agent=handle.agent
 const access=JSON.parse(readFileSync(join(directory,'manager-access.json'),'utf8')),u=new URL(access.url),api=async(action,args={})=>{const r=await fetch(u.origin+'/api',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+u.hash.slice(1)},body:JSON.stringify({action,library_id:lib.id,...args})});const body=await r.json();assert.equal(body.ok,true,JSON.stringify(body));return body.result}
 const native=async(name,args)=>agent.ctx.tools.execute({callId:'failure-'+Date.now(),name,arguments:args,agent,signal:AbortSignal.timeout(10000)})

 report.cases=[]
 const tools=await load('@deepseek-ai/dsh-tools'),{FsError}=await load('@deepseek-ai/dsh-fs'),{HarnessError}=await load('@deepseek-ai/dsh-llm'),file=join(workspace,'unobserved-edit.txt'),mark=join(workspace,'composite-side-effect.txt')
 const state=async()=>api('inspect')
 const clear=async()=>{for(const op of (await state()).recovery.operations)await api('review',{operation_session:op.session,call_id:op.call_id,decision:'abandon-no-replay',note:'Synthetic fixture cleanup only; no replay'})}
 const failures=[]
 const expect=(condition,message)=>{if(!condition)failures.push(message)}
 for(const [name,args]of [['edit',{file_path:file,old_string:'Before',new_string:'After'}],['synthetic_missing_tool',{}]]){
  writeFileSync(file,'Before')
  const result=await native(name,args),pending=(await state()).recovery.operations
  expect(result.isError===true,name+' must be a real host refusal')
  expect(readFileSync(file,'utf8')==='Before',name+' changed the file unexpectedly')
  expect(pending.length===0,name+' incorrectly requires human recovery review')
  report.cases.push({tool:name,error_code:result.error?.info?.code,pending:pending.length,file_unchanged:readFileSync(file,'utf8')==='Before'})
  await clear()
 }
 const read=await native('read',{file_path:file});expect(!read.isError,'native read should succeed')
 const edited=await native('edit',{file_path:file,old_string:'Before',new_string:'After'});expect(!edited.isError,'read then edit should succeed');expect(readFileSync(file,'utf8')==='After','successful native edit did not change file');expect((await state()).recovery.operations.length===0,'successful edit caused recovery hold')
 report.checks.native_read_then_edit={read_error:!!read.isError,edit_error:!!edited.isError,file_after:readFileSync(file,'utf8')}
 for(const [name,code] of [['synthetic_effect_then_unknown_tool','UNKNOWN_TOOL'],['synthetic_effect_then_fs_not_observed','FS_NOT_OBSERVED'],['edit','FS_NOT_OBSERVED'],['synthetic_effect_then_pre_dispatch_error','ABORTED_BEFORE_DISPATCH']]){
  const dispose=agent.ctx.tools.register({name,description:'Synthetic reviewer tool with a real local side effect followed by a known-looking error.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>''},execute:async()=>{writeFileSync(mark,code);if(code==='UNKNOWN_TOOL')throw new tools.ToolNotFoundError('synthetic_nested_missing');if(code==='ABORTED_BEFORE_DISPATCH')throw new HarnessError('Synthetic error after effect',code);throw new FsError('Synthetic error after effect',code)}})
  try{
   const result=await native(name,{}),pending=(await state()).recovery.operations
   expect(readFileSync(mark,'utf8')===code,'synthetic side effect did not happen')
   expect(pending.some(x=>x.name===name),name+' wrongly classifies an executed custom tool as harmless')
   report.cases.push({tool:name,error_code:result.error?.info?.code,side_effect_proven:true,pending:pending.length})
   await clear()
  }finally{dispose()}
 }
 const cancelledBefore=new AbortController();cancelledBefore.abort()
 const before=await agent.ctx.tools.execute({callId:'synthetic-cancel-before',name:'edit',arguments:{file_path:file,old_string:'After',new_string:'Unexpected'},agent,signal:cancelledBefore.signal})
 expect(before.isError===true,'cancel-before-dispatch must report cancellation')
 expect(readFileSync(file,'utf8')==='After','cancel-before-dispatch changed the target')
 expect((await state()).recovery.operations.length===0,'cancel-before-dispatch incorrectly needs recovery review')
 report.checks.cancel_before_dispatch={error_code:before.error?.info?.code,file_unchanged:readFileSync(file,'utf8')==='After'}
 const cancelledAfter=new AbortController(),afterName='synthetic_effect_then_abort'
 const removeAfter=agent.ctx.tools.register({name:afterName,description:'Synthetic reviewer operation interrupted after its effect.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>''},execute:async()=>{writeFileSync(mark,'ABORTED');cancelledAfter.abort();return {ok:true}}})
 try{
  const result=await agent.ctx.tools.execute({callId:'synthetic-cancel-after',name:afterName,arguments:{},agent,signal:cancelledAfter.signal}),pending=(await state()).recovery.operations
  expect(result.isError===true,'interrupted started tool must report cancellation')
  expect(readFileSync(mark,'utf8')==='ABORTED','post-start cancellation fixture did not perform its effect')
  expect(pending.some(x=>x.name===afterName),'post-effect cancellation wrongly cleared uncertainty')
  report.checks.cancel_after_dispatch={error_code:result.error?.info?.code,side_effect_proven:true,pending:pending.length}
  await clear()
 }finally{removeAfter()}
 report.checks.real_host_pre_execution_failures_exercised=true

 report.native_failure_matrix=[]
 const missing=join(workspace,'missing-target.txt'),noMatch=join(workspace,'no-match.txt'),ambiguous=join(workspace,'ambiguous.txt'),unreadWrite=join(workspace,'existing-unread-write.txt')
 await native('read',{file_path:missing})
 writeFileSync(noMatch,'Original text');await native('read',{file_path:noMatch})
 writeFileSync(ambiguous,'same same');await native('read',{file_path:ambiguous})
 writeFileSync(unreadWrite,'Keep this original')
 const matrix=[
  {label:'edit-observed-missing-file',name:'edit',args:{file_path:missing,old_string:'before',new_string:'after'},target:missing,before:null},
  {label:'edit-no-match',name:'edit',args:{file_path:noMatch,old_string:'does not occur',new_string:'after'},target:noMatch,before:'Original text'},
  {label:'edit-ambiguous-match',name:'edit',args:{file_path:ambiguous,old_string:'same',new_string:'after'},target:ambiguous,before:'same same'},
  {label:'edit-invalid-arguments',name:'edit',args:{file_path:noMatch,old_string:'Original text'},target:noMatch,before:'Original text'},
  {label:'write-existing-unread-file',name:'write',args:{file_path:unreadWrite,content:'Unexpected replacement'},target:unreadWrite,before:'Keep this original'},
  {label:'write-invalid-arguments',name:'write',args:{file_path:join(workspace,'invalid-write.txt'),content:123},target:join(workspace,'invalid-write.txt'),before:null}
 ]
 for(const item of matrix){
  const result=await native(item.name,item.args),pending=(await state()).recovery.operations,after=existsSync(item.target)?readFileSync(item.target,'utf8'):null,code=result.error?.info?.code||result.error?.code||null
  expect(result.isError===true,item.label+' must actually be declined by the host')
  expect(after===item.before,item.label+' unexpectedly changed the target')
  expect(pending.length===0,item.label+' is still a false recovery hold')
  report.native_failure_matrix.push({label:item.label,code,pending:pending.length,target_unchanged:after===item.before})
  await clear()
 }
 const codes=[...new Set(report.native_failure_matrix.map(x=>x.code).filter(Boolean))]
 for(const [i,code] of codes.entries()){
  const name='synthetic_effect_then_native_code_'+i,dispose=agent.ctx.tools.register({name,description:'Synthetic reviewer composite operation.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>''},execute:async()=>{writeFileSync(mark,code);throw new HarnessError('Synthetic error after an effect',code)}})
  try{await native(name,{});expect(readFileSync(mark,'utf8')===code,'composite fixture did not run');expect((await state()).recovery.operations.some(x=>x.name===name),'custom effect followed by '+code+' was incorrectly certified harmless');await clear()}finally{dispose()}
 }

 report.failures=failures
 assert.deepEqual(failures,[])

}catch(e){report.error={message:e.message,stack:e.stack};process.exitCode=1}
finally{report.requests=report.requests.map((r,i)=>({index:i,message_count:r.message_count??r.messages?.length}));try{await handle?.dispose();await boot?.shutdown.shutdown(process.exitCode||0)}catch(e){report.cleanup_error=e.message;process.exitCode=1}if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}report.manager_removed=!existsSync(join(directory,'manager-access.json'));writeFileSync(join(root,'native-failure-host-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))}
