import {hash,text,integer,fail,page,clip} from './util.mjs'
import {Scenes} from './scenes.mjs'
import {toolOutcome} from './dsh-events.mjs'

const INTERNAL=/^(cm_|[a-zA-Z0-9_]+_memory_|memory_(search|read|remember|project|list|stats)|rag_search)/
const SECRET=/^(authorization|proxy_authorization|cookie|set_cookie|password|passwd|passphrase|api_key|apikey|x_api_key|access_token|accesstoken|refresh_token|refreshtoken|session_token|sessiontoken|private_key|privatekey|client_secret|clientsecret|secret|credentials)$/
const credentialKey=key=>SECRET.test(String(key).toLowerCase().replace(/[-\s]/g,'_'))
const pointer=path=>'/'+path.map(s=>String(s).replaceAll('~','~0').replaceAll('/','~1')).join('/')

/** JSON data only. Hidden reasoning and binary carriers are not made into text experiences. */
export function encodeActivity(value,{redactCredentials=true,maxBytes=1048576,bodyRecord=null,message=null}={}){
  const seen=new Set(),redactions=[],omissions=[],normalizations=[],textRefs=[],bodyChars=bodyRecord?Array.from(bodyRecord.text):null,counts={redactions:0,omissions:0,normalizations:0};let nodes=0
  const note=(items,path,reason)=>{counts[items===redactions?'redactions':items===omissions?'omissions':'normalizations']++;if(items.length<128)items.push({path:pointer(path),reason})}
  const mask=(value,path)=>{
    if(!redactCredentials)return value
    let changed=false
    const out=value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi,()=>{changed=true;return 'Bearer [credential-redacted]'})
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,(_m,prefix)=>{changed=true;return prefix+'[credential-redacted]@'})
    if(changed)note(redactions,path,'credential-pattern')
    return out
  }
  const bodyRef=(value,path,offset)=>{
    const count=Array.from(value).length
    if(bodyChars.slice(offset,offset+count).join('')!==value){note(normalizations,path,'text-block-kept-literal');return value}
    textRefs.push({path:path.map(String),offset,length:count})
    return {text_record:bodyRecord.id,offset,length:count}
  }
  const content=(value,path,depth)=>{
    if(typeof value==='string')return bodyRecord?bodyRef(value,path,0):walk(value,path,depth)
    if(!Array.isArray(value))return walk(value,path,depth)
    let offset=0,trailingHigh=false
    return value.map((block,i)=>{
      if(++nodes>50000||depth>40)fail('ACTIVITY_PAYLOAD_LIMIT','活动正文块过多，未截断写入')
      const at=[...path,i]
      if(block?.type==='reasoning'){note(omissions,at,'hidden-reasoning-not-archived');return {type:'reasoning',omitted:true}}
      if(block?.type==='text'&&typeof block.text==='string'){
        const result=Object.create(null)
        for(const key of Object.keys(block).sort())result[key]=key==='text'&&bodyRecord?bodyRef(block.text,[...at,key],offset):walk(block[key],[...at,key],depth+1)
        const first=block.text.charCodeAt(0),last=block.text.charCodeAt(block.text.length-1)
        offset+=Array.from(block.text).length-(trailingHigh&&first>=0xdc00&&first<=0xdfff?1:0)
        if(block.text.length)trailingHigh=last>=0xd800&&last<=0xdbff
        return result
      }
      if(['image','audio','video','image_url','input_image','input_audio'].includes(block?.type)){
        note(omissions,at,'non-text-carrier-not-copied')
        const result={type:block.type,omitted_carrier:true}
        for(const key of ['mimeType','mime_type','path','uri','url'])if(typeof block[key]==='string'&&!block[key].startsWith('data:'))result[key]=mask(block[key],[...at,key])
        return result
      }
      return walk(block,at,depth+1)
    })
  }
  const walk=(item,path=[],depth=0)=>{
    if(++nodes>50000||depth>40)fail('ACTIVITY_PAYLOAD_LIMIT','活动数据的层数或节点过多，未截断写入')
    if(item===null||typeof item==='boolean')return item
    if(typeof item==='number'){if(!Number.isFinite(item))fail('ACTIVITY_NOT_JSON','活动数据含非有限数字');return item}
    if(typeof item==='string'){if(item.length>maxBytes)fail('ACTIVITY_PAYLOAD_LIMIT','活动字符串超过预算，未截断');return mask(item,path)}
    if(item===undefined){note(omissions,path,'undefined-not-json');return null}
    if(typeof item!=='object')fail('ACTIVITY_NOT_JSON','活动数据不是可归档JSON')
    if(seen.has(item))fail('ACTIVITY_NOT_JSON','活动数据存在循环引用')
    seen.add(item)
    try{
      if(Array.isArray(item))return item.map((part,i)=>walk(part,[...path,i],depth+1))
      if(item instanceof Error){note(omissions,path,'error-normalized-without-stack');return {name:item.name,message:mask(item.message,path),...(typeof item.code==='string'?{code:item.code}:{})}}
      if(item instanceof Date){if(!Number.isFinite(item.getTime()))fail('ACTIVITY_NOT_JSON','活动日期无效');return item.toISOString()}
      if(item instanceof Uint8Array){note(omissions,path,'non-text-carrier-not-copied');return {carrier:'bytes',byte_length:item.byteLength,omitted_carrier:true}}
      if(![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('ACTIVITY_NOT_JSON','活动数据含非JSON对象')
      const result=Object.create(null)
      for(const key of Object.keys(item).sort()){
        const child=[...path,key],part=item[key]
        if(part===undefined){note(omissions,child,'undefined-not-json');continue}
        if(redactCredentials&&(credentialKey(key)||key.toLowerCase()==='token'&&typeof part==='string')){result[key]='[credential-redacted]';note(redactions,child,'credential-field');continue}
        if(key==='arguments'&&typeof part==='string'){
          let parsed;try{parsed=JSON.parse(part)}catch{}
          if(parsed&&typeof parsed==='object'){note(normalizations,child,'json-argument-string-normalized');result[key]=walk(parsed,child,depth+1);continue}
        }
        result[key]=item===message&&key==='content'?content(part,child,depth+1):walk(part,child,depth+1)
      }
      return result
    }finally{seen.delete(item)}
  }
  const payload=JSON.stringify(walk(value)),bytes=Buffer.byteLength(payload)
  if(bytes>maxBytes)fail('ACTIVITY_PAYLOAD_LIMIT','活动数据超过预算，未静默截断；原生日志仍可另查')
  return {payload,digest:hash(payload),bytes,redactions,omissions,normalizations,textRefs,counts}
}

export class ActivityArchive {
  constructor(store,{enabled=false,maxPayloadBytes=1048576,redactCredentials=true}={}){
    if(typeof enabled!=='boolean'||typeof redactCredentials!=='boolean')fail('INVALID_INPUT','活动归档开关无效')
    integer(maxPayloadBytes,'maxPayloadBytes',8192,4194304)
    this.store=store;this.enabled=enabled;this.maxBytes=maxPayloadBytes;this.redactCredentials=redactCredentials;this.scenes=new Scenes(store);this.vectorTriggers=false
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS cm_activity_payloads(rid TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,library TEXT NOT NULL,event_type TEXT NOT NULL,call_id TEXT,name TEXT,phase TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,metadata TEXT NOT NULL,time INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cm_activity_payload_scope ON cm_activity_payloads(library,time);
      CREATE TABLE IF NOT EXISTS cm_activity_reports(seq INTEGER PRIMARY KEY AUTOINCREMENT,library TEXT NOT NULL,session TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,rid TEXT UNIQUE REFERENCES records(id) ON DELETE CASCADE,kind TEXT NOT NULL,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cm_activity_report_refs(report INTEGER NOT NULL REFERENCES cm_activity_reports(seq) ON DELETE CASCADE,rid TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,PRIMARY KEY(report,rid));
      CREATE INDEX IF NOT EXISTS cm_activity_report_source ON cm_activity_report_refs(rid,report);
      CREATE TABLE IF NOT EXISTS cm_activity_tombstones(library TEXT NOT NULL,event_key TEXT NOT NULL,PRIMARY KEY(library,event_key));
      CREATE TABLE IF NOT EXISTS cm_activity_health(library TEXT PRIMARY KEY,error TEXT,paused INTEGER NOT NULL,time INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS cm_activity_delete BEFORE DELETE ON records BEGIN
        INSERT OR IGNORE INTO cm_activity_tombstones SELECT p.library,p.event_key FROM cm_activity_reports p WHERE p.rid IN (WITH RECURSIVE affected(id) AS (SELECT old.id UNION SELECT p.rid FROM cm_activity_reports p JOIN cm_activity_report_refs r ON r.report=p.seq JOIN affected a ON a.id=r.rid) SELECT id FROM affected);
        DELETE FROM records WHERE id!=old.id AND id IN (WITH RECURSIVE affected(id) AS (SELECT old.id UNION SELECT p.rid FROM cm_activity_reports p JOIN cm_activity_report_refs r ON r.report=p.seq JOIN affected a ON a.id=r.rid) SELECT id FROM affected);
      END;
    `)
    this.ensureVectorTriggers()
  }
  ensureVectorTriggers(){
    if(this.vectorTriggers||!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_vector_prepared'").get())return
    this.store.db.exec(`CREATE TRIGGER IF NOT EXISTS cm_activity_vector_added AFTER INSERT ON cm_activity_payloads BEGIN DELETE FROM cm_vectors WHERE rid=new.rid;DELETE FROM cm_vector_chunks WHERE rid=new.rid;DELETE FROM cm_vector_prepared WHERE rid=new.rid;END;`);this.vectorTriggers=true
  }
  health(library){const row=this.store.db.prepare('SELECT error,paused,time FROM cm_activity_health WHERE library=?').get(library);return row?{...row,paused:!!row.paused}:{error:null,paused:false,time:null}}
  markFailure(library,error){
    const code=/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'ACTIVITY_CAPTURE_FAILED'
    this.store.db.prepare('INSERT INTO cm_activity_health VALUES(?,?,1,?) ON CONFLICT(library) DO UPDATE SET error=excluded.error,paused=1,time=excluded.time').run(library,code,this.store.now())
    this.store.log(library,'activity-capture-paused',{code,main_chat_blocked:false,replayed:false})
  }
  resume(library,session){this.store.assertOwner(library,session);this.store.db.prepare('INSERT INTO cm_activity_health VALUES(?,NULL,0,?) ON CONFLICT(library) DO UPDATE SET error=NULL,paused=0,time=excluded.time').run(library,this.store.now());return this.status(library)}
  status(library){
    this.store.library(library)
    return {enabled:this.enabled,maintenance:this.health(library),max_payload_bytes:this.maxBytes,credential_fields_masked:this.redactCredentials,
      payloads:this.store.db.prepare('SELECT count(*) n FROM cm_activity_payloads WHERE library=?').get(library).n,
      reports:this.store.db.prepare('SELECT count(*) n FROM cm_activity_reports WHERE library=?').get(library).n,
      note:'原生工具请求与结果分开；观察片段是有出处的报告，不证明已经看完或完成动作。非文本载体未复制。'}
  }
  encode(value,extra={}){return encodeActivity(value,{redactCredentials:this.redactCredentials,maxBytes:this.maxBytes,...extra})}
  attach(library,rid,{event_type,call_id=null,name=null,phase,encoded}){
    this.ensureVectorTriggers();this.store.record(library,rid)
    const old=this.store.db.prepare('SELECT * FROM cm_activity_payloads WHERE rid=? AND library=?').get(rid,library)
    if(old){if(old.digest!==encoded.digest||old.phase!==phase||old.event_type!==event_type)fail('SOURCE_CHANGED','同一工具事件的结构化记录已变化');return old.rid}
    const metadata=JSON.stringify({redactions:encoded.redactions,omissions:encoded.omissions,normalizations:encoded.normalizations,text_refs:encoded.textRefs,redaction_count:encoded.counts.redactions,omission_count:encoded.counts.omissions,normalization_count:encoded.counts.normalizations,paths_limited:Object.values(encoded.counts).some(n=>n>128),bytes:encoded.bytes})
    this.store.db.prepare('INSERT INTO cm_activity_payloads VALUES(?,?,?,?,?,?,?,?,?,?)').run(rid,library,event_type,call_id,name,phase,encoded.payload,encoded.digest,metadata,this.store.now());return rid
  }
  captureNative(library,session,event,{bodyRecord=null,message=null}={}){
    if(!this.enabled||this.health(library).paused)return null
    const data=event.data||{},call=data.call||data,name=call.name||data.name||message?.name||null
    if(INTERNAL.test(name||''))return null
    try{
      return this.store.tx(()=>{
        this.store.assertOwner(library,session)
        const outcome=toolOutcome(data),call_id=event.type==='tool/call'?(call.callId||call.id||data.callId):(message?.toolCallId||message?.source?.callId||data.callId||data.result?.callId)
        const uncertain=['TOOL_OUTCOME_UNKNOWN','ABORTED','TIMEOUT','CANCELLED','TRANSPORT'].includes(outcome.code)
        const phase=event.type==='tool/call'?'requested':uncertain?'host-outcome-unknown':outcome.isError?'host-error':'host-returned'
        const encoded=this.encode({event_type:event.type,phase,call_id:call_id??null,name,data},{bodyRecord,message})
        let rid=bodyRecord?.id
        if(!rid)rid=this.store.append(library,{session,seq:event.seq,time:new Date(event.time).toISOString(),role:'tool',type:event.type,text:encoded.payload,origin:{kind:'tool',archive:'structured',phase,call_id:call_id??null,name}})
        if(!rid)return null
        this.attach(library,rid,{event_type:event.type,call_id:call_id??null,name,phase,encoded});return rid
      })
    }catch(error){try{this.markFailure(library,error)}catch{}return null}
  }
  payload(library,id,{offset=0,limit=1200,part='payload'}={}){
    const record=this.store.record(library,id),row=this.store.db.prepare('SELECT * FROM cm_activity_payloads WHERE library=? AND rid=?').get(library,record.id)
    if(!row)fail('NOT_FOUND','这条原文没有结构化活动载荷')
    if(!['payload','metadata'].includes(part))fail('INVALID_INPUT','活动读取部分无效')
    const data=JSON.parse(row.payload),metadata=JSON.parse(row.metadata),chars=Array.from(record.text)
    if(part==='metadata')return {id:record.id,part,...page(JSON.stringify(metadata),offset,limit)}
    for(const ref of metadata.text_refs||[]){
      let target=data
      for(const key of ref.path.slice(0,-1)){if(!Object.hasOwn(target,key))fail('ACTIVITY_PAYLOAD_INVALID','正文引用位置无效');target=target[key]}
      const key=ref.path.at(-1);if(!Object.hasOwn(target,key)||!Number.isSafeInteger(ref.offset)||!Number.isSafeInteger(ref.length)||ref.offset<0||ref.length<0||ref.offset+ref.length>chars.length)fail('ACTIVITY_PAYLOAD_INVALID','正文引用范围无效')
      Object.defineProperty(target,key,{value:chars.slice(ref.offset,ref.offset+ref.length).join(''),writable:true,enumerable:true,configurable:true})
    }
    return {id:record.id,event_type:row.event_type,phase:row.phase,call_id:row.call_id,metadata:{redacted_fields:metadata.redaction_count,omitted_parts:metadata.omission_count,stored_bytes:metadata.bytes},...page(JSON.stringify(data),offset,limit)}
  }
  descriptor(library,id){
    const row=this.store.db.prepare('SELECT event_type,phase,call_id,metadata FROM cm_activity_payloads WHERE library=? AND rid=?').get(library,id)
    if(!row)return null
    const meta=JSON.parse(row.metadata);return {event_type:row.event_type,phase:row.phase,call_id:row.call_id,redacted_fields:meta.redaction_count,omitted_parts:meta.omission_count,read:'cm_activity read；按字符分页，默认1200'}
  }
  report(library,session,{kind,body,refs,title,source=null,start_ms=null,end_ms=null,evidence_type='agent-report',observed_at=null,idempotency_key},position,{trustedNode=false}={}){
    this.store.assertOwner(library,session)
    if(!this.enabled)fail('FEATURE_DISABLED','活动记录尚未启用')
    if(this.health(library).paused)fail('ACTIVITY_CAPTURE_PAUSED','活动记录已暂停，先核对后恢复')
    if(!['video','game','browser','desktop','task-node'].includes(kind)||kind==='task-node'&&!trustedNode)fail('INVALID_INPUT','活动种类无效')
    text(title,'title',160);text(body,'body',trustedNode?20000:8000);text(idempotency_key,'idempotency_key',200)
    if(!['agent-report','subtitle','tool-output','host-node'].includes(evidence_type)||evidence_type==='host-node'&&!trustedNode)fail('INVALID_INPUT','观察依据类型无效')
    if(!position||position.session!==session||!Number.isSafeInteger(position.seq)||position.seq<0)fail('HOST_API_UNAVAILABLE','缺少可核对的原生会话位置')
    if(source!==null)text(source,'source',2048)
    if(kind==='video'&&(!source||start_ms===null||end_ms===null))fail('INVALID_INPUT','视频片段需来源和媒体起止毫秒位置')
    if(start_ms!==null||end_ms!==null){integer(start_ms,'start_ms');integer(end_ms,'end_ms',start_ms)}
    if(observed_at!==null&&(typeof observed_at!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(observed_at)||!Number.isFinite(Date.parse(observed_at))||Date.parse(observed_at)>this.store.now()))fail('INVALID_INPUT','observed_at需带时区且不是未来；它仍是报告中的时间')
    const canonical=trustedNode&&!refs?.length?[]:this.store.verifyRefs(library,refs).sort()
    if(canonical.length>(trustedNode?20:5))fail('INVALID_EVIDENCE','观察依据最多5条，宿主检查点最多20条')
    for(const rid of canonical)this.scenes.active(library,rid)
    const encoded=this.encode({kind,title,body,source,media_range_ms:start_ms===null?null:[start_ms,end_ms],evidence_type,observed_at,refs:canonical,scope:trustedNode?'host-task-node':'reported-observation-not-independently-verified'})
    const event_key=hash([library,kind,idempotency_key])
    return this.store.tx(()=>{
      if(this.store.db.prepare('SELECT 1 FROM cm_activity_tombstones WHERE library=? AND event_key=?').get(library,event_key))fail('DELETED_SOURCE','该活动记录已删除，不能通过重复提交复活')
      const old=this.store.db.prepare('SELECT * FROM cm_activity_reports WHERE event_key=?').get(event_key)
      if(old){if(old.digest!==encoded.digest)fail('CONFLICT','同一片段键内容变化，需另存修订，未覆盖');return {id:old.rid,duplicate:true,scope:trustedNode?'host-task-node':'reported-observation'}}
      const row=this.store.db.prepare('INSERT INTO cm_activity_reports(library,session,event_key,digest,rid,kind,time) VALUES(?,?,?,?,NULL,?,?)').run(library,session,event_key,encoded.digest,kind,this.store.now()),seq=Number(row.lastInsertRowid)
      const rid=this.store.append(library,{session:'cm-activity:'+hash(session).slice(0,16),seq,time:new Date(this.store.now()).toISOString(),role:'note',type:trustedNode?'activity/task-node':'activity/observation',text:encoded.payload,origin:{kind:'activity-report',position_verified:true,native_session:session,native_seq:position.seq,evidence_type}})
      if(!rid)fail('DELETED_SOURCE','活动原文已删除')
      this.store.db.prepare('UPDATE cm_activity_reports SET rid=? WHERE seq=?').run(rid,seq)
      for(const ref of canonical)this.store.db.prepare('INSERT INTO cm_activity_report_refs VALUES(?,?)').run(seq,ref)
      this.attach(library,rid,{event_type:trustedNode?'task-node':'observation',phase:trustedNode?'host-node':'reported',encoded})
      this.store.log(library,'activity-recorded',{id:rid,kind,refs:canonical,native_position:position,replayed:false})
      return {id:rid,duplicate:false,scope:trustedNode?'host-task-node':'reported-observation',note:'已保存记录；不据此证明观看完成或外部操作成功。'}
    })
  }
  taskNode(library,session,action,result,position,key){
    if(!this.enabled||this.health(library).paused)return null
    try{return this.report(library,session,{kind:'task-node',title:'任务节点 · '+action,body:JSON.stringify(result),refs:result.checkpoint?.refs||[],evidence_type:'host-node',idempotency_key:key},position,{trustedNode:true})}catch(error){try{this.markFailure(library,error)}catch{}return null}
  }
  list(library,{offset=0,limit=5}={}){
    this.store.library(library);integer(offset,'offset');integer(limit,'limit',1,10)
    const rows=this.store.db.prepare("SELECT r.id,r.time,r.type,p.phase,coalesce(json_extract(p.payload,'$.title'),p.name,'工具返回记录') title,substr(r.text,1,200) text FROM records r JOIN cm_activity_payloads p ON p.rid=r.id WHERE r.library=? ORDER BY r.time DESC,p.time DESC,r.rowid DESC LIMIT ? OFFSET ?").all(library,limit,offset)
    const total=this.store.db.prepare('SELECT count(*) n FROM cm_activity_payloads WHERE library=?').get(library).n
    return {items:rows.map(r=>({id:r.id,time:r.time,type:r.type,title:clip(r.title,60),phase:r.phase,summary:clip(r.text.replace(/\s+/g,' '),80)})),total,next_offset:offset+rows.length<total?offset+rows.length:null}
  }
}
