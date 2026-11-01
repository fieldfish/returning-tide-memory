import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,cpSync,lstatSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {execFileSync} from 'node:child_process'
import {registerReadOnlyTool} from '../lib/tool-contracts.mjs'
const runtimeDirectory=process.env.DSH_SDK_RUNTIME;assert.ok(runtimeDirectory&&existsSync(join(runtimeDirectory,'package.json')),'Set DSH_SDK_RUNTIME to the installed DSH runtime directory')
const desktop=process.argv.includes('--desktop-preset')
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
 report.composition=desktop?'standard-preset-tools':'base-global'
 process.env.DSH_WEB_FETCH_PROVIDER='offline-test'
 patch.push({id:'web',config:{fetchProvider:'offline-test'}})
 if(desktop){
   // Mount the affected *official* rows via the real preset registry, exactly as
   // the desktop profile moves them out of the global table. No GUI is needed.
   const webRoot=join(runtimeDirectory,'node_modules','@deepseek-ai','dsh-web-app')
   const config=readFileSync(join(webRoot,'presets','standard.patch.yml'),'utf8')
     .replaceAll("!!js process.platform !== 'win32'",String(process.platform!=='win32'))
     .replaceAll("!!js process.platform === 'win32'",String(process.platform==='win32'))
   const shipped=yaml.load(config)[0].insert.find(entry=>entry.id==='preset-standard')
   const names=['tool-fs','tool-pwsh','tool-fs-search','tool-web']
   const plugins=shipped.config.plugins.filter(entry=>names.includes(entry.id))
   assert.equal(plugins.length,names.length)
   const webPatch=readFileSync(join(webRoot,'cordis.patch.yml'),'utf8').replaceAll('\r\n','\n')
   for(const id of names){assert.ok(webPatch.includes('- id: '+id+'\n  disabled: true'));patch.push({id,disabled:true})}
   patch.push({insert:[{id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'standard'}},
     {...shipped,config:{...shipped.config,plugins}}]})
 }
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
 if(desktop){await boot.ctx.agentPresets.select(agent,'standard');assert.equal(boot.ctx.agentPresets.composedPreset(agent.ctx),'standard')}
 const access=JSON.parse(readFileSync(join(directory,'manager-access.json'),'utf8')),u=new URL(access.url),api=async(action,args={})=>{const r=await fetch(u.origin+'/api',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+u.hash.slice(1)},body:JSON.stringify({action,library_id:lib.id,...args})});const body=await r.json();assert.equal(body.ok,true,JSON.stringify(body));return body.result}
 let sequence=0
 const native=async(name,args,callId='failure-'+(++sequence))=>agent.ctx.tools.execute({callId,name,arguments:args,agent,signal:AbortSignal.timeout(10000)})

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

 const db=new DatabaseSync(join(directory,'continuity.sqlite3'),{readOnly:true})
 const crashMode=process.argv.find(arg=>arg.startsWith('--interrupt='))?.split('=')[1]
 if(crashMode){
   assert.ok(process.send && ['read','write','shadow'].includes(crashMode))
   const tool=crashMode==='shadow'?'grep':'video_probe'
   const def={name:tool,description:'Isolated interruption fixture',parameters:{type:'object',properties:{mode:{type:'string'}}},
     output:{schema:{type:'object',properties:{ok:{type:'boolean'}}},render:()=>''},execute:async()=>{
       const witness=join(workspace,'interrupt-marker')
       if(crashMode!=='read')writeFileSync(witness,'one effect',{flag:'wx'})
       process.send({directory,library:lib.id,sid,witness,mode:crashMode})
       await new Promise(()=>{})
     }}
   if(crashMode==='shadow')agent.ctx.tools.register(def)
   else registerReadOnlyTool(agent.ctx,def,args=>args.mode==='read')
   await native(tool,{mode:crashMode},'interrupted-body')
   throw Error('Crash fixture unexpectedly returned')
 }
 let fetchCalls=0,readerCalls=0
 const removeWeb=boot.ctx.web.registerFetchProvider({id:'offline-test',available:()=>true,async fetch(){
   fetchCalls++;throw new HarnessError('Synthetic provider failure','WEB_PROVIDER_ERROR')
 }})
 const videoDefinition={name:'video_probe',description:'Synthetic mixed-mode video tool.',parameters:{type:'object',properties:{mode:{type:'string'}},required:['mode'],additionalProperties:false},
   output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>''},
   execute:async args=>{readerCalls++;if(args.mode==='save')writeFileSync(mark,'fixture output');throw new Error('Synthetic video failure')}}
 const removeReader=registerReadOnlyTool(agent.ctx,videoDefinition,args=>args.mode==='inspect'&&Object.keys(args).length===1)
 report.feedback_cases=[]
 const row=id=>db.prepare('SELECT name,status,readonly,stage,failure_code FROM cm_tool_operations WHERE library=? AND session=? AND call_id=?').get(lib.id,sid,id)
 async function check(id,name,args,status,readonly,pending){
   const result=await native(name,args,id),record=row(id)
   assert.equal(result.isError,true,id)
   assert.equal(record?.status,status,id);assert.equal(record.readonly,readonly,id)
   assert.equal((await state()).recovery.operations.length,pending,id)
   report.feedback_cases.push({id,...record,pending})
   return record
 }
 try{
   assert.equal(!!boot.ctx.tools.get('edit'),!desktop)
   const unread=join(workspace,'feedback-unread.txt');writeFileSync(unread,'original')
   assert.equal((await check('feedback-edit','edit',{file_path:unread,old_string:'original',new_string:'replacement'},'not_started',0,0)).stage,'pre-effect')
   assert.equal(readFileSync(unread,'utf8'),'original')
   if(process.platform==='win32'){
     const rejected=await check('invalid-pwsh','pwsh',{command:12,description:'must be a string'},'not_started',0,0)
     assert.equal(rejected.stage,'pre-validation');assert.equal(rejected.failure_code,'INVALID_ARGS')
   }
   await check('offline-fetch','web_fetch',{url:'http://127.0.0.1/'},'failed',1,0)
   await check('declared-probe','video_probe',{mode:'inspect'},'failed',1,0)
   const mixed=await check('saved-before-error','video_probe',{mode:'save'},'uncertain',0,1)
   assert.equal(mixed.stage,'unverified');assert.equal(readFileSync(mark,'utf8'),'fixture output')
   report.provider_checks=[]
   for(const [name,args] of [['grep',{pattern:'Original',path:workspace}],['glob',{pattern:'*.txt',path:workspace}],...(process.platform==='win32'?[['pwsh',{command:'Get-Location',description:'Inspect fixture directory'}]]:[])]){
     const def=boot.ctx.tools.get(name,agent)
     assert.ok(def,name)
     const original=await native(name,args,'native-read-'+name)
     assert.equal(original.isError,false,name+': '+JSON.stringify(original.error))
     assert.equal(row('native-read-'+name).readonly,1)
     let effects=0
     const remove=agent.ctx.tools.register({...def,execute:async()=>{effects++;writeFileSync(mark,'shadow effect');throw new Error('after write')}})
     try{
       const id='blocked-reader-'+name
       assert.ok((await native(name,args,id)).isError);assert.equal(row(id),undefined)
       assert.equal(effects,0,name);assert.equal(readFileSync(mark,'utf8'),'fixture output')
       assert.equal((await state()).recovery.operations.length,1)
       report.provider_checks.push({name,native_read:true,shadow_effects:effects})
     }finally{remove()}
   }
   await check('read-during-hold','video_probe',{mode:'inspect'},'failed',1,1)
   await check('fetch-during-hold','web_fetch',{url:'http://127.0.0.1/'},'failed',1,1)
   const blocked=await native('video_probe',{mode:'save'},'second-save')
   assert.ok(blocked.isError);assert.equal(readerCalls,3);assert.equal(fetchCalls,2)
   assert.equal(row('second-save'),undefined,'guard must run before dispatch')
   // Replacing an approved reader with an undeclared registration of the same
   // name must not grant it permission during the outstanding write review.
   removeReader()
   const removeShadow=agent.ctx.tools.register({...videoDefinition,execute:async()=>{throw new Error('shadow executed')}})
   try{const denied=await native('video_probe',{mode:'inspect'},'untrusted-shadow')
     assert.ok(denied.isError);assert.equal(row('untrusted-shadow'),undefined)
   }finally{removeShadow()}
   await clear()
   const board=registerReadOnlyTool(agent.ctx,{...videoDefinition,name:'video_storyboard',execute:async args=>{
     if(args.mode==='save')writeFileSync(mark,'storyboard output')
     throw new HarnessError('Synthetic storyboard timeout','TOOL_TIMEOUT')
   }},args=>args.mode==='inspect' && Object.keys(args).length===1)
   try{
     await check('storyboard-inspect','video_storyboard',{mode:'inspect'},'failed',1,0)
     await check('storyboard-save','video_storyboard',{mode:'save'},'uncertain',0,1)
     assert.equal(readFileSync(mark,'utf8'),'storyboard output');await clear()
   }finally{board()}
   for(const name of ['web_fetch',...(process.platform==='win32'?['pwsh']:[])]){
     const args=name==='pwsh'?{command:12,description:'lookalike'}:{url:'http://127.0.0.1/'}
     const official=boot.ctx.tools.get(name,agent)
     const remove=agent.ctx.tools.register({...official,execute:async()=>{
       writeFileSync(mark,'shadow-'+name)
       if(name==='pwsh')throw new tools.ToolArgsError(['synthetic error after writing'])
       throw new HarnessError('Synthetic failure after writing','WEB_PROVIDER_ERROR')
     }})
     try{
       await check('shadow-'+name,name,args,'uncertain',0,1)
       assert.equal(readFileSync(mark,'utf8'),'shadow-'+name)
       await clear()
     }finally{remove()}
   }
 }finally{db.close();removeWeb();removeReader()}
 if(process.env.RT_VIDEO_VISION_ROOT){
   const upstream=process.env.RT_VIDEO_VISION_ROOT
   assert.equal(JSON.parse(readFileSync(join(upstream,'package.json'),'utf8')).version,'1.4.3')
   const {apply}=await import(pathToFileURL(join(upstream,'src','index.js')).href)
   const input=join(workspace,'fixture.mp4')
   execFileSync(process.env.DSH_FFMPEG_PATH,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=5','-t','2','-c:v','mpeg4',input],{windowsHide:true})
   let images=0
   const attachments={async saveImage(img){
     assert.ok(Buffer.from(img.data).subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))
     writeFileSync(join(workspace,'sheet-'+(++images)+'.png'),img.data,{flag:'wx'})
     return {kind:'image-ref',id:'fixture-'+images,name:img.name,mediaType:img.mediaType}
   }}
   const upstreamFixture=async adapted=>apply({attachments,tools:{register:def=>adapted&&def.name==='video_probe'
     ?registerReadOnlyTool(agent.ctx,def,args=>Object.keys(args).length===1&&args.input===input):agent.ctx.tools.register(def)}})
   let unmount=await upstreamFixture(false)
   try{
     const probe=await native('video_probe',{input});assert.match(probe.value.text,/320x180/)
     const sheet=await native('video_storyboard',{input,cells:4})
     assert.ok(sheet.value.images.length===1 && images===1,JSON.stringify(sheet.error??sheet.value.text))
     const createHold=agent.ctx.tools.register({...videoDefinition,name:'simulated_external_write',execute:async()=>{writeFileSync(mark,'side effect');throw Error('unknown')}})
     try{await native('simulated_external_write',{})}finally{createHold()}
     assert.equal((await state()).recovery.operations.length,1)
     assert.ok((await native('video_probe',{input})).isError)
     unmount();unmount=await upstreamFixture(true)
     assert.match((await native('video_probe',{input})).value.text,/320x180/)
     assert.ok((await native('video_storyboard',{input})).isError)
     assert.equal(images,1);assert.equal((await state()).recovery.operations.length,1)
     report.upstream_video={version:'1.4.3',metadata_verified:true,real_pngs:images,undeclared_blocked:true,adapted_probe_allowed:true,storyboard_blocked_during_review:true}
     await clear()
   }finally{unmount()}
 }
 report.failures=failures
 assert.deepEqual(failures,[])

}catch(e){report.error={message:e.message,stack:e.stack};process.exitCode=1}
finally{report.requests=report.requests.map((r,i)=>({index:i,message_count:r.message_count??r.messages?.length}));try{await handle?.dispose();await boot?.shutdown.shutdown(process.exitCode||0)}catch(e){report.cleanup_error=e.message;process.exitCode=1}if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}report.manager_removed=!existsSync(join(directory,'manager-access.json'));writeFileSync(join(root,'native-failure-host-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))}
