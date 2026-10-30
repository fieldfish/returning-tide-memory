/** Local human management. Shares the host's writer, never impersonates a model turn. */
import {createServer} from 'node:http'
import {randomBytes,timingSafeEqual} from 'node:crypto'
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {snapshot,restoreCopy} from './snapshot.mjs'
import {fail} from './util.mjs'

export async function createManager({store,execution,extraction,embedding,situations=null,situationIndex=null,activityArchive=null,working=null,consolidation=null,agents,invoke,port=0}){
 const lifecycle=new AbortController(),token=randomBytes(32).toString('hex'),assets=new Map([['/',['manager.html','text/html; charset=utf-8']],['/manager.js',['manager.js','text/javascript; charset=utf-8']],['/i18n.mjs',['i18n.mjs','text/javascript; charset=utf-8']],['/manager.css',['manager.css','text/css; charset=utf-8']]])
 let origin
 const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))}
 const agentFor=id=>{const a=agents.get(id);if(!a||a.session?.header?.parentSession)fail('SESSION_UNAVAILABLE','请选择已经加载的主会话');return a}
 const sessionTitle=agent=>{
  if(!agent?.session)return null
  try{
   const events=agent.session.snapshotEvents?.()||[]
   const latest=events.findLast(event=>event.type==='session/title'&&typeof event.data?.title==='string'&&event.data.title.trim())
   if(latest)return latest.data.title.trim()
  }catch{}
  const title=agent.session.header?.title
  return typeof title==='string'&&title.trim()?title.trim():null
 }
 const guard=id=>{const lib=store.library(id),a=agentFor(lib.owner);store.assertOwner(id,lib.owner);if(a.status!=='idle'||store.busy(id))fail('BUSY','当前仍有执行，请先在DSH正常结束这一轮');return {lib,agent:a}}
 const server=createServer(async(req,res)=>{
  try{
   if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!==origin?.slice(7))return reply(res,403,{ok:false,error:'LOCAL_ONLY'})
   const url=new URL(req.url,origin)
   if(req.method==='GET'&&assets.has(url.pathname)){
    const [file,type]=assets.get(url.pathname)
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"})
    return res.end(readFileSync(new URL('../web/'+file,import.meta.url)))
   }
   if(url.pathname!=='/api'||req.method!=='POST')return reply(res,404,{ok:false,error:'NOT_FOUND'})
   const provided=String(req.headers.authorization||'').replace(/^Bearer /,'')
   if(Buffer.byteLength(provided)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(provided),Buffer.from(token)))return reply(res,401,{ok:false,error:'AUTH_REQUIRED'})
   if(req.headers.origin&&req.headers.origin!==origin)return reply(res,403,{ok:false,error:'ORIGIN_DENIED'})
   if(!String(req.headers['content-type']).startsWith('application/json'))return reply(res,415,{ok:false,error:'JSON_REQUIRED'})
   let size=0,parts=[];for await(const part of req){size+=part.length;if(size>16384)return reply(res,413,{ok:false,error:'BODY_TOO_LARGE'});parts.push(part)}
   const r=JSON.parse(Buffer.concat(parts).toString('utf8'));let result
   if(r.action==='overview'){
    result={libraries:store.list().map(lib=>({...lib,owner_title:sessionTitle(agents.get(lib.owner))})),sessions:(agents.list?.()||[]).filter(a=>!a.session?.header?.parentSession).map(a=>({id:a.session.id,status:a.status,title:sessionTitle(a)||a.session.id})),version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,scope:'本机人工管理；不发送模型消息'}
   }else if(r.action==='inspect'){
    const stored=store.library(r.library_id),lib={...stored,owner_title:sessionTitle(agents.get(stored.owner))}
    result={library:lib,active:store.busy(lib.id),records:store.db.prepare('SELECT count(*) n FROM records WHERE library=?').get(lib.id).n,recovery:store.recovery.pending(lib.id),embedding:embedding.status(lib.id),extraction:extraction.status(lib.id),consolidation:consolidation?.status(lib.id)||null,working:lib.owner?working?.status(lib.id,lib.owner)||null:null,situation_page:situations?.list(lib.id,{limit:10})||null,task_page:execution.listPage(lib.id,0,30),usage:store.db.prepare('SELECT source,status,input,output,estimated_input,time FROM usage WHERE library=? ORDER BY time DESC LIMIT 20').all(lib.id)}
    result.memory_dynamics=embedding.memoryDynamics?.status(lib.id,embedding.cached)||{enabled:false}
    result.situation_index=situationIndex?.status(lib.id)||null
    result.activity_archive=activityArchive?.status(lib.id)||null
   }else if(r.action==='memory-dynamics'){
    store.library(r.library_id)
    if(!embedding.memoryDynamics)fail('HOST_API_UNAVAILABLE','此宿主未提供记忆反馈模块')
    result=embedding.memoryDynamics.describe(r.library_id,r.id,r.query||'')
   }else if(r.action==='create')result=await invoke('cm_library',{action:'create',name:r.name},{signal:lifecycle.signal})
   else if(r.action==='bind'||r.action==='handoff'){
    const a=agentFor(r.session);if(a.status!=='idle')fail('BUSY','目标会话仍在执行')
    result=await invoke('cm_library',{action:r.action,library_id:r.library_id,expected_revision:r.expected_revision},{agent:a,signal:lifecycle.signal})
   }else if(['rename','pause','resume','configure','extraction-resume','extraction-pause','consolidation-resume','consolidation-pause','working-clear','embedding-resume','correction-index-resume','situation-index-warm','situation-index-resume','activity-resume','review','retry','verify','task-pause','task-resume'].includes(r.action)){
    const {lib,agent}=guard(r.library_id)
    if(r.action==='rename')result=await invoke('cm_library',{action:'rename',name:r.name,expected_revision:r.expected_revision},{agent})
    if(r.action==='pause'){if(lib.error&&lib.error!=='MANUAL_PAUSE')fail('REPAIR_REQUIRED','已存在真实故障，不能用手动暂停覆盖');store.pause(lib.id,'MANUAL_PAUSE');result={paused:true}}
    if(r.action==='resume'){
     if(!['MANUAL_PAUSE','MAIN_REQUEST_FAILED'].includes(lib.error))fail('REPAIR_REQUIRED','此错误需先修复原因，管理界面不会强制绕过')
     store.resume(lib.id,lib.owner);result={resumed:true,replayed:false}
    }
    if(r.action==='configure')result=await invoke('cm_extraction',{action:'configure',config:r.config},{agent,signal:lifecycle.signal})
    if(r.action==='extraction-resume')result=await invoke('cm_extraction',{action:'resume'},{agent,signal:lifecycle.signal})
    if(r.action==='extraction-pause'){extraction.pause(lib.id);result={paused:true}}
    if(r.action==='consolidation-resume')result=await invoke('cm_situation',{action:'maintenance-resume'},{agent,signal:lifecycle.signal})
    if(r.action==='consolidation-pause'){consolidation.pause(lib.id);result={paused:true}}
    if(r.action==='working-clear'){working.invalidate(lib.id,lib.owner,'manual-clear');result=working.status(lib.id,lib.owner)}
    if(r.action==='correction-index-resume')result=await invoke('cm_working',{action:'feedback-resume'},{agent,signal:lifecycle.signal})
    if(r.action==='embedding-resume')result=embedding.resume(lib.id,lib.owner)
    if(r.action==='situation-index-warm')result=await invoke('cm_situation',{action:'index-warm'},{agent,signal:lifecycle.signal})
    if(r.action==='situation-index-resume')result=await invoke('cm_situation',{action:'index-resume'},{agent,signal:lifecycle.signal})
    if(r.action==='activity-resume')result=await invoke('cm_activity',{action:'resume'},{agent,signal:lifecycle.signal})
    if(r.action==='review')result=store.recovery.resolve(lib.id,{session:r.operation_session,call_id:r.call_id,legacy_id:r.legacy_id,decision:r.decision,note:r.note})
    if(r.action==='retry'){execution.permitRetry(lib.id,r.task_id,r.step_id,r.note);result={allowed_attempts:1,executed:false}}
    if(r.action==='verify')result=await execution.verify(lib.id,r.operation_session,r.call_id,{signal:lifecycle.signal})
    if(r.action==='task-pause'||r.action==='task-resume')result={task:execution.setPaused(lib.id,lib.owner,r.task_id,r.action==='task-pause',r.expected_revision)}
   }else if(r.action==='activity-list'){
    store.library(r.library_id);result=activityArchive.list(r.library_id,{offset:r.offset??0,limit:5})
   }else if(r.action==='activity-read'){
    store.library(r.library_id);result=activityArchive.payload(r.library_id,r.id,{offset:r.offset??0,limit:r.limit??1200,part:r.part??'payload'})
   }else if(r.action==='situation-search'){
    store.library(r.library_id)
    if(!situationIndex)fail('HOST_API_UNAVAILABLE','此宿主未提供情境向量索引')
    result=await situationIndex.lookup(r.library_id,store.library(r.library_id).owner,r.query,3,lifecycle.signal)
   }else if(r.action==='task')result={task:execution.status(r.library_id,r.task_id)}
   else if(r.action==='tasks')result=execution.listPage(r.library_id,r.offset??0,30)
   else if(r.action==='situations')result=situations.list(r.library_id,{offset:r.offset??0,limit:10})
   else if(r.action==='situation')result=situations.capsule(r.library_id,r.id,{maxChars:3000,revision:r.revision??null})
   else if(r.action==='backup'){
    const dir=join(store.directory,'snapshots');mkdirSync(dir,{recursive:true});result=snapshot(store,join(dir,Date.now()+'-'+randomBytes(4).toString('hex')))
   }else if(r.action==='restore-copy')result=restoreCopy(r.snapshot,r.destination)
   else fail('INVALID_INPUT','未知管理操作')
   reply(res,200,{ok:true,result})
  }catch(e){reply(res,e.code==='BUSY'?409:400,{ok:false,error:e.code||'MANAGEMENT_FAILED',message:typeof e.code==='string'?e.message:'管理请求失败，请核对本地输入或日志'})}
 })
 server.requestTimeout=15000;server.headersTimeout=10000
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
 origin='http://127.0.0.1:'+server.address().port
 const accessPath=join(store.directory,'manager-access.json'),url=origin+'/#'+token
 try{writeFileSync(accessPath,JSON.stringify({url,local_only:true,pid:process.pid,note:'临时本机管理凭据；不要公开或发给模型'}),{mode:0o600})}
 catch(e){lifecycle.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw e}
 return {origin,url,accessPath,async close(){lifecycle.abort();if(existsSync(accessPath))unlinkSync(accessPath);server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
}
