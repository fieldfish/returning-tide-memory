/** One-plugin semantic memory. The model runs in local Ollama; vectors live in the continuity library. */
import {DatabaseSync} from 'node:sqlite'
import {existsSync} from 'node:fs'
import {hash,fail,integer,clip} from './util.mjs'
import {MemoryDynamics} from './memory-dynamics.mjs'
import {excludedSource,activeSource,sourceAvailabilitySQL,activitySourceText} from './source-position.mjs'
import {retrievalText,sourcePrior} from './retrieval-text.mjs'
import {recallCard} from './recall-card.mjs'
import {ClaimLinks} from './claim-links.mjs'

const DEFAULT_INSTRUCTION='Given a conversation query, retrieve relevant past conversations and personal memories.'
const PART=800
const CHUNK_BATCH=8
const lexTerms=q=>{
  const terms=new Set()
  for(const run of q.toLowerCase().match(/[\u3400-\u9fff]+|[a-z0-9_]+/g)||[]){
    if(/[\u3400-\u9fff]/.test(run))for(let i=0;i<run.length-1;i++)terms.add(run.slice(i,i+2))
    else if(run.length>=2)terms.add(run)
  }
  for(const term of ['哪天','哪款','是哪','用的','的是','是什','请问','我们','你们','他们','这个','那个','什么','可以','一个'])terms.delete(term)
  return [...terms].slice(0,80)
}
const normalize=values=>{
  if(!Array.isArray(values)||!values.length||values.length>8192||values.some(n=>typeof n!=='number'||!Number.isFinite(n)))fail('EMBEDDING_INVALID_VECTOR','本地模型返回了无效向量')
  const norm=Math.hypot(...values)
  if(!Number.isFinite(norm)||norm<1e-12)fail('EMBEDDING_INVALID_VECTOR','本地模型返回了零向量')
  return Float32Array.from(values,n=>n/norm)
}
const dot=(a,blob)=>{
  if(blob.byteLength!==a.length*4)fail('EMBEDDING_INVALID_VECTOR','索引向量长度不符')
  const view=new DataView(blob.buffer,blob.byteOffset,blob.byteLength);let sum=0
  for(let i=0;i<a.length;i++){const v=view.getFloat32(i*4,true);if(!Number.isFinite(v))fail('EMBEDDING_INVALID_VECTOR','索引包含非有限向量');sum+=a[i]*v}
  return sum
}
const retain=(items,item,limit=60)=>{const at=items.findIndex(v=>item.score>v.score);if(at<0){if(items.length<limit)items.push(item)}else{items.splice(at,0,item);if(items.length>limit)items.pop()}}
const buf=v=>{const b=Buffer.allocUnsafe(v.length*4);for(let i=0;i<v.length;i++)b.writeFloatLE(v[i],i*4);return b}
const focusPassage=(passage,query)=>{
  const terms=lexTerms(query),sentences=String(passage).match(/[^。！？!?\n]+[。！？!?]?/g)||[String(passage)]
  let best=sentences[0],score=0
  for(const s of sentences){const lower=s.toLowerCase(),n=terms.reduce((sum,t)=>sum+(lower.includes(t)?t.length:0),0);if(n>score){best=s;score=n}}
  return score?best:passage
}

export class Embedding {
  constructor(store,{ollamaUrl='http://127.0.0.1:11434',model='qwen3-embedding:0.6b',queryInstruction=DEFAULT_INSTRUCTION,legacyIndexPath=null,legacySessionId=null,legacyNamespace=null,memoryDynamics={}}={}){
    const url=new URL(ollamaUrl)
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/')fail('INVALID_EMBEDDING_URL','embedding只允许本机HTTP根地址')
    this.store=store;this.base=url.origin;this.model=model;this.instruction=queryInstruction;this.legacySessionId=legacySessionId;this.legacyNamespace=legacyNamespace;this.cached=null;this.lastCheck=0;this.busy=false;this.tail=Promise.resolve()
    this.lastQuery=null
    this.legacy=null
    try{
    if(legacyIndexPath){
      if(typeof legacyNamespace!=='string'||!legacyNamespace.trim()||legacyNamespace.length>200)fail('LEGACY_NAMESPACE_REQUIRED','Specify the legacy namespace explicitly before importing a legacy index')
      if(!existsSync(legacyIndexPath))fail('LEGACY_INDEX_MISSING','旧向量索引不存在；未修改原数据')
      this.legacy=new DatabaseSync(legacyIndexPath,{readOnly:true})
      const app=this.legacy.prepare('PRAGMA application_id').get().application_id
      if(app!==1145851185){this.legacy.close();fail('LEGACY_INDEX_MISMATCH','Unsupported legacy index application identifier')}
    }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS cm_vector_prepared(rid TEXT PRIMARY KEY, library TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cm_vector_chunks(library TEXT NOT NULL,rid TEXT NOT NULL,part INTEGER NOT NULL,content TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(library,rid,part));
      CREATE TABLE IF NOT EXISTS cm_vectors(library TEXT NOT NULL,rid TEXT NOT NULL,part INTEGER NOT NULL,model_key TEXT NOT NULL,dimensions INTEGER NOT NULL,value BLOB NOT NULL,PRIMARY KEY(library,rid,part,model_key));
      CREATE INDEX IF NOT EXISTS cm_chunks_digest ON cm_vector_chunks(digest);
      CREATE INDEX IF NOT EXISTS cm_vectors_scope ON cm_vectors(library,model_key,rid,part);
      CREATE TABLE IF NOT EXISTS cm_legacy_notes(library TEXT NOT NULL,legacy_id TEXT NOT NULL,rid TEXT,active INTEGER NOT NULL,PRIMARY KEY(library,legacy_id));
      CREATE INDEX IF NOT EXISTS cm_legacy_notes_source ON cm_legacy_notes(library,rid,active);
      CREATE TABLE IF NOT EXISTS cm_retrieval_projection(version INTEGER PRIMARY KEY,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cm_embedding_health(library TEXT PRIMARY KEY,error TEXT,paused INTEGER NOT NULL,time INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS cm_delete_vector AFTER DELETE ON records BEGIN
        DELETE FROM cm_vectors WHERE library=old.library AND rid=old.id;
        DELETE FROM cm_vector_chunks WHERE library=old.library AND rid=old.id;
        DELETE FROM cm_vector_prepared WHERE rid=old.id;
        DELETE FROM cm_legacy_notes WHERE library=old.library AND rid=old.id;
      END;
    `)
    this.memoryDynamics=new MemoryDynamics(store,memoryDynamics)
    this.claimLinks=new ClaimLinks(store)
    this.reconcileProjection()
    }catch(e){try{this.legacy?.close()}catch{}throw e}
  }
  reconcileProjection(){
    if(this.store.db.prepare('SELECT 1 FROM cm_retrieval_projection WHERE version=1').get())return
    this.store.tx(()=>{
      const affected=new Map()
      for(const r of this.store.db.prepare("SELECT id,library,role,text,origin FROM records WHERE role='user' AND (instr(text,'qq_bridge_send')>0 OR text LIKE '[QQ%')").all()){
        if(retrievalText(r)===r.text)continue
        this.store.db.prepare('DELETE FROM cm_vectors WHERE library=? AND rid=?').run(r.library,r.id)
        this.store.db.prepare('DELETE FROM cm_vector_chunks WHERE library=? AND rid=?').run(r.library,r.id)
        this.store.db.prepare('DELETE FROM cm_vector_prepared WHERE rid=?').run(r.id)
        if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_working_frames'").get())this.store.db.prepare('DELETE FROM cm_working_frames WHERE library=? AND EXISTS(SELECT 1 FROM json_each(cm_working_frames.payload,\'$.refs\') WHERE value=?)').run(r.library,r.id)
        affected.set(r.library,(affected.get(r.library)||0)+1)
      }
      for(const [library,count]of affected)this.store.log(library,'retrieval-projection-upgraded',{count,originals_unchanged:true})
      this.store.db.prepare('INSERT INTO cm_retrieval_projection VALUES(1,?)').run(this.store.now())
    })
  }
  async exclusive(signal,run){
    const before=this.tail
    let release
    this.tail=new Promise(resolve=>{release=resolve})
    let acquired=false,onAbort
    try{
      if(signal?.aborted)fail('CANCELLED','embedding操作已取消')
      if(signal)await new Promise((resolve,reject)=>{onAbort=()=>{const e=new Error('embedding排队已取消');e.code='CANCELLED';reject(e)};signal.addEventListener('abort',onAbort,{once:true});before.then(resolve,reject)})
      else await before
      if(signal?.aborted)fail('CANCELLED','embedding操作已取消')
      acquired=true;this.busy=true
      return await run()
    }finally{if(onAbort)signal.removeEventListener('abort',onAbort);if(acquired){this.busy=false;release()}else before.then(release,release)}
  }
  health(library){const r=this.store.db.prepare('SELECT error,paused,time FROM cm_embedding_health WHERE library=?').get(library);return r?{...r,paused:!!r.paused}:{error:null,paused:false,time:null}}
  markFailure(library,code){
    if(['CANCELLED','INVALID_INPUT'].includes(code))return
    const error=/^[A-Z0-9_]{1,80}$/.test(code||'')?code:'EMBEDDING_FAILED',prior=this.health(library)
    this.store.db.prepare('INSERT INTO cm_embedding_health VALUES(?,?,1,?) ON CONFLICT(library) DO UPDATE SET error=excluded.error,paused=1,time=excluded.time').run(library,error,this.store.now())
    if(!prior.paused||prior.error!==error)this.store.log(library,'embedding-feature-paused',{error,conversation_blocked:false})
  }
  resume(library,session){
    this.store.assertOwner(library,session)
    this.store.db.prepare('INSERT INTO cm_embedding_health VALUES(?,?,0,?) ON CONFLICT(library) DO UPDATE SET error=NULL,paused=0,time=excluded.time').run(library,null,this.store.now())
    this.store.log(library,'embedding-feature-resumed',{session});return this.health(library)
  }
  async request(path,body=null,signal=null,timeout=60000){
    const controller=AbortSignal.timeout(timeout)
    let response
    try{response=await fetch(this.base+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal?AbortSignal.any([signal,controller]):controller})}
    catch{if(signal?.aborted)fail('CANCELLED','embedding请求已取消');fail('EMBEDDING_UNAVAILABLE','本地embedding服务不可用；已停止检索，等待人工核对')}
    if(!response.ok)fail('EMBEDDING_UNAVAILABLE','本地embedding服务返回错误；不自动降级')
    const length=Number(response.headers.get('content-length')||0)
    if(length>8*1024*1024){await response.body?.cancel();fail('EMBEDDING_INVALID_RESPONSE','本地embedding响应过大')}
    try{
      const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text=''
      try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8*1024*1024){await reader.cancel();fail('EMBEDDING_INVALID_RESPONSE','本地embedding响应过大')};text+=decoder.decode(value,{stream:true})}text+=decoder.decode()}
      finally{reader.releaseLock()}
      return JSON.parse(text)
    }catch(e){if(signal?.aborted)fail('CANCELLED','embedding响应读取已取消');if(e.code==='EMBEDDING_INVALID_RESPONSE')throw e;fail('EMBEDDING_INVALID_RESPONSE','本地embedding响应无效')}
  }
  async identity(signal){
    if(this.cached&&Date.now()-this.lastCheck<30000)return this.cached
    const tags=await this.request('/api/tags',null,signal,10000)
    const row=tags.models?.find(x=>this.model===x.name||this.model===x.model)
    if(!row?.digest)fail('EMBEDDING_MODEL_MISSING','指定embedding模型尚未安装')
    // Same sorted canonical fields and pipeline as the existing Python index.
    this.cached=hash(JSON.stringify({digest:row.digest,model:this.model,pipeline:'dlm-v1-unit-f32',query_instruction:this.instruction}))
    this.lastCheck=Date.now();return this.cached
  }
  async embed(inputs,query=false,signal=null){
    if(!Array.isArray(inputs)||!inputs.length||inputs.length>16||inputs.some(x=>typeof x!=='string'||!x.trim()))fail('INVALID_INPUT','embedding输入无效')
    const text=query?inputs.map(x=>`Instruct: ${this.instruction}\nQuery: ${x}`):inputs
    const result=await this.request('/api/embed',{model:this.model,input:text,truncate:false,keep_alive:'5m'},signal)
    if(!Array.isArray(result.embeddings)||result.embeddings.length!==inputs.length)fail('EMBEDDING_INVALID_RESPONSE','本地模型返回数量不匹配')
    const values=result.embeddings.map(normalize)
    if(values.some(v=>v.length!==values[0].length))fail('EMBEDDING_INVALID_VECTOR','向量维度不一致')
    return values
  }
  syncLegacyNotes(library,session){
    if(!this.legacy||session!==this.legacySessionId)return {imported:0,retired:0}
    const rows=this.legacy.prepare(`SELECT r.id,r.source,r.role,r.content,r.created_at,f.active FROM records r JOIN flags f ON f.record_id=r.id WHERE r.namespace=? AND r.source!='event-journal' ORDER BY r.id`).all(this.legacyNamespace)
    let imported=0,retired=0
    this.store.tx(()=>{
      for(const r of rows){
        const seq=Number.parseInt(hash(r.id).slice(0,12),16),record={session:'legacy:'+r.source,seq,time:r.created_at,role:'note',type:'legacy-note',text:r.content,origin:{kind:'legacy-index-note',source:r.source,legacy_record_id:r.id}}
        const rid=this.store.append(library,record)
        if(rid)imported++
        this.store.db.prepare('INSERT INTO cm_legacy_notes(library,legacy_id,rid,active) VALUES(?,?,?,?) ON CONFLICT(library,legacy_id) DO UPDATE SET active=excluded.active').run(library,r.id,rid,r.active?1:0)
        if(!r.active)retired++
      }
    })
    return {imported,retired}
  }
  prepareChunks(library,limit=64){
    integer(limit,'preparation batch',1,128)
    const activities=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_payloads'").get()
    const rows=this.store.db.prepare('SELECT r.id,r.text,r.role,r.origin'+(activities?',a.payload':'')+' FROM records r LEFT JOIN cm_vector_prepared p ON p.rid=r.id '+(activities?'LEFT JOIN cm_activity_payloads a ON a.rid=r.id ':'')+'WHERE r.library=? AND p.rid IS NULL AND '+sourceAvailabilitySQL(this.store)+' ORDER BY r.rowid LIMIT ?').all(library,limit)
    let count=0
    this.store.tx(()=>{
      const chunk=this.store.db.prepare('INSERT OR IGNORE INTO cm_vector_chunks VALUES(?,?,?,?,?)')
      const prepared=this.store.db.prepare('INSERT OR IGNORE INTO cm_vector_prepared VALUES(?,?)')
      for(const r of rows){const chars=Array.from(activitySourceText(retrievalText(r),r.payload));for(let at=0,part=0;at<chars.length;at+=PART,part++){
        const content=chars.slice(at,at+PART).join('');if(content.trim()){chunk.run(library,r.id,part,content,hash(content));count++}
      }prepared.run(r.id,library)}
    })
    return count
  }
  copyLegacyVectors(library,key){
    if(!this.legacy)return 0
    const rows=this.store.db.prepare('SELECT c.* FROM cm_vector_chunks c LEFT JOIN cm_vectors v ON v.library=c.library AND v.rid=c.rid AND v.part=c.part AND v.model_key=? WHERE c.library=? AND v.rid IS NULL').all(key,library)
    let copied=0
    const source=this.legacy.prepare('SELECT value,dimensions FROM vectors WHERE model_key=? AND content_hash=? LIMIT 1')
    this.store.tx(()=>{const put=this.store.db.prepare('INSERT OR IGNORE INTO cm_vectors VALUES(?,?,?,?,?,?)');for(const r of rows){
      const old=source.get(key,r.digest);if(!old)continue
      if(old.value.byteLength!==old.dimensions*4)fail('LEGACY_VECTOR_INVALID','旧向量长度与维度不一致')
      put.run(library,r.rid,r.part,key,old.dimensions,old.value);copied++
    }})
    return copied
  }
  async indexPending(library,key,signal=null,limit=CHUNK_BATCH){
    integer(limit,'batch limit',1,16)
    const rows=this.store.db.prepare('SELECT c.* FROM cm_vector_chunks c LEFT JOIN cm_vectors v ON v.library=c.library AND v.rid=c.rid AND v.part=c.part AND v.model_key=? JOIN records r ON r.id=c.rid LEFT JOIN cm_legacy_notes x ON x.library=c.library AND x.rid=c.rid WHERE c.library=? AND v.rid IS NULL AND (x.rid IS NULL OR x.active=1) AND '+sourceAvailabilitySQL(this.store)+' ORDER BY r.time DESC,c.part ASC LIMIT ?').all(key,library,limit)
    if(!rows.length)return 0
    const vectors=await this.embed(rows.map(r=>r.content),false,signal)
    this.store.tx(()=>{const put=this.store.db.prepare('INSERT OR IGNORE INTO cm_vectors VALUES(?,?,?,?,?,?)');for(let i=0;i<rows.length;i++)put.run(library,rows[i].rid,rows[i].part,key,vectors[i].length,buf(vectors[i]))})
    return rows.length
  }
  status(library,key=this.cached){
    const records=this.store.db.prepare('SELECT COUNT(*) n FROM records WHERE library=?').get(library).n
    const available=sourceAvailabilitySQL(this.store)
    const parts=this.store.db.prepare('SELECT COUNT(*) n FROM cm_vector_chunks c JOIN records r ON r.id=c.rid LEFT JOIN cm_legacy_notes x ON x.library=c.library AND x.rid=c.rid WHERE c.library=? AND (x.rid IS NULL OR x.active=1) AND '+available).get(library).n
    const vectors=key?this.store.db.prepare('SELECT COUNT(*) n FROM cm_vectors v JOIN records r ON r.id=v.rid LEFT JOIN cm_legacy_notes x ON x.library=v.library AND x.rid=v.rid WHERE v.library=? AND v.model_key=? AND (x.rid IS NULL OR x.active=1) AND '+available).get(library,key).n:0
    const unprepared=this.store.db.prepare('SELECT count(*) n FROM records r LEFT JOIN cm_vector_prepared p ON p.rid=r.id LEFT JOIN cm_legacy_notes x ON x.library=r.library AND x.rid=r.id WHERE r.library=? AND p.rid IS NULL AND (x.rid IS NULL OR x.active=1) AND '+available).get(library).n
    const corrections=this.memoryDynamics.status(library,key)
    return {model:this.model,model_key:key,records,parts,indexed_parts:vectors,pending_parts:parts-vectors,unprepared_records:unprepared,index_work_remaining:parts>vectors||unprepared>0||corrections.enabled&&!corrections.maintenance.paused&&corrections.pending_cues>0,correction_index:corrections,legacy_model_reused:!!this.legacy,lookup:'hybrid',answerability:'unassessed',maintenance:this.health(library)}
  }
  async warmCorrections(library,session,key,signal){
    try{return await this.memoryDynamics.warm(this,library,session,key,signal)}
    catch(error){if(signal?.aborted)throw error;this.memoryDynamics.markFailure(library,error);return {indexed:0,unavailable:true}}
  }
  async correctionsFor(library,session,query,ids,signal=null){
    if(!this.memoryDynamics.enabled)return {status:'disabled',events:[],pending_rids:[]}
    return this.exclusive(signal,async()=>{
      this.store.assertOwner(library,session)
      const key=await this.identity(signal),vector=this.lastQuery?.key===key&&this.lastQuery.query===query?this.lastQuery.vector:(await this.embed([query],true,signal))[0]
      return this.memoryDynamics.match(library,key,vector,ids,signal)
    })
  }
  async lookup(library,session,query,limit=3,signal=null,exclude=null,options={}){
    return this.exclusive(signal,async()=>{
      if(typeof query!=='string'||!query.trim()||query.length>1000)fail('INVALID_INPUT','检索词无效')
      integer(limit,'limit',1,5)
      const key=await this.identity(signal)
      if(!options.readOnlyIndex&&!this.health(library).paused){
        this.syncLegacyNotes(library,session)
        this.prepareChunks(library)
        this.copyLegacyVectors(library,key)
        await this.indexPending(library,key,signal)
        await this.warmCorrections(library,session,key,signal)
      }
      const [queryVector]=await this.embed([query],true,signal)
      this.lastQuery={key,query,vector:queryVector}
      const checkpoint=async()=>{await new Promise(resolve=>setImmediate(resolve));if(signal?.aborted)fail('CANCELLED','检索已取消')}
      let visited=0
      const excluded=r=>excludedSource(r,exclude)
      const best=new Map(),bestParts=new Map(),terms=lexTerms(query),lex=[],exactTokens=(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{7,}/g)||[]).filter(t=>/[0-9_-]/.test(t))
      const activities=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_payloads'").get(),availability=sourceAvailabilitySQL(this.store)
      if(terms.length)for(const r of this.store.db.prepare('SELECT r.id,r.text,r.role,r.session,r.seq,r.origin'+(activities?',ap.payload':'')+' FROM records r LEFT JOIN cm_legacy_notes x ON x.library=r.library AND x.rid=r.id '+(activities?'LEFT JOIN cm_activity_payloads ap ON ap.rid=r.id ':'')+'WHERE r.library=? AND (x.rid IS NULL OR x.active=1) AND '+availability).iterate(library)){
        if(++visited%64===0)await checkpoint()
        if(excluded(r))continue
        const lower=activitySourceText(retrievalText(r),r.payload).toLowerCase();let n=0;for(const t of terms)if(lower.includes(t))n+=t.length
        if(n)retain(lex,{id:r.id,score:n,exact:exactTokens.some(token=>lower.includes(token))})
      }
      const lexIds=new Set(lex.map(r=>r.id)),exact=new Set(lex.filter(r=>r.exact).map(r=>r.id)),vector=[]
      let current=null
      const flush=()=>{if(!current)return;if(current.score>=0.5){retain(vector,current);if(lexIds.has(current.id)){best.set(current.id,current.score);bestParts.set(current.id,current.passage)}}}
      // Index order makes each record contiguous, so only one record and top candidates stay in JS memory.
      const vectorParts=this.store.db.prepare('SELECT v.rid,v.part,v.value,v.dimensions,r.session,r.seq,r.origin,c.content FROM cm_vectors v JOIN records r ON r.id=v.rid LEFT JOIN cm_legacy_notes x ON x.library=v.library AND x.rid=v.rid LEFT JOIN cm_vector_chunks c ON c.library=v.library AND c.rid=v.rid AND c.part=v.part WHERE v.library=? AND v.model_key=? AND (x.rid IS NULL OR x.active=1) AND '+availability+' ORDER BY v.rid,v.part').iterate(library,key)
      for(const r of vectorParts){
        if(++visited%64===0)await checkpoint()
        if(excluded(r))continue
        if(r.dimensions!==queryVector.length||typeof r.content!=='string')fail('EMBEDDING_INVALID_VECTOR','索引维度或对应分片不符')
        if(current?.id!==r.rid){flush();current={id:r.rid,score:-1,passage:null}}
        const score=dot(queryVector,r.value);if(score>current.score){current.score=score;current.passage=r.content}
      }
      flush()
      if(signal?.aborted)fail('CANCELLED','检索已取消')
      for(const r of vector){best.set(r.id,r.score);bestParts.set(r.id,r.passage)}
      const scores=new Map()
      for(const items of [vector,lex])for(let i=0;i<items.length;i++)scores.set(items[i].id,(scores.get(items[i].id)||0)+1/(61+i))
      const ranked=[],salience=new Map(),live=id=>{try{activeSource(this.store,library,id,{metadataOnly:true});return true}catch(e){if(['NOT_FOUND','SOURCE_INACTIVE'].includes(e.code))return false;throw e}}
      const get=this.store.db.prepare('SELECT id,time,role,session,seq,origin FROM records WHERE library=? AND id=?'),getText=this.store.db.prepare('SELECT text FROM records WHERE library=? AND id=?')
      const half=this.store.library(library).settings.decayHalfDays
      const corrections=await this.memoryDynamics.match(library,key,queryVector,[...scores.keys()],signal)
      for(const [id,base] of scores){if(!best.has(id)&&!exact.has(id))continue;const r=get.get(library,id);if(!r||excluded(r)||!live(id))continue;const assessment=this.memoryDynamics.assess(library,r,query,half,corrections);salience.set(id,assessment);ranked.push([r,base*assessment.factor*sourcePrior(r)])}
      ranked.sort((a,b)=>b[1]-a[1]||b[0].time.localeCompare(a[0].time))
      const status=this.status(library,key),incomplete=status.index_work_remaining
      const response={results:ranked.slice(0,limit).map(([r,s])=>{const raw={...r,text:getText.get(library,r.id).text};return recallCard(raw,s,this.store.shortId(library,r.id),focusPassage(bestParts.get(r.id)||retrievalText(raw),query),query)}),note:incomplete?'索引补建中≠记录丢失。排序分非概率，原文cm_read。':'候选待核验；排序分非概率。quote为原文短句，cm_read另取全文。'}
      const relationships=this.claimLinks.resolve(library,ranked.slice(0,limit).map(([r])=>r.id),{exclude,limit:1})
      if(relationships.groups.length){response.relations=relationships.groups.map(({link,basis,...g})=>g);response.relations_more=relationships.more;response.note='前后依据成组返回，不认证真假；争议勿二选一。关系详情cm_working link-status，全文cm_read。'}
      if(ranked.slice(0,limit).some(([r])=>salience.get(r.id).auto_blocked))response.note+='部分旧材料有针对当前线索的纠正反馈，cm_working feedback-status可核对。'
      while(Array.from(JSON.stringify(response)).length>650){
        const row=[...response.results].reverse().find(r=>r.summary.length>1)
        if(row){row.summary=clip(row.summary,Array.from(row.summary).length-1);continue}
        const title=[...response.results].reverse().find(r=>Array.from(r.title).length>4)
        if(title){title.title=clip(title.title,Array.from(title.title).length-1);continue}
        const quote=[...response.results].reverse().find(r=>Array.from(r.quote).length>10)
        if(quote){quote.quote=Array.from(quote.quote).slice(0,-1).join('');continue}
        if(response.relations&&response.results.length>1){response.results.pop();continue}
        fail('COMPACT_BUDGET_ERROR','精简结果整体超过字符预算')
      }
      if(options.details){
        response.candidates=ranked.slice(0,limit).filter(([r])=>response.results.some(c=>r.id.startsWith(c.id))).map(([r])=>({id:r.id,semantic:best.get(r.id)??0,lexical:lexIds.has(r.id),exact:exact.has(r.id),...(salience.get(r.id).auto_blocked?{auto_blocked:true,corrective_refs:salience.get(r.id).corrective_refs}:{})}))
        response.corrections=corrections
        response.incomplete=incomplete
        response.index={indexed:status.indexed_parts,pending:status.pending_parts,unprepared:status.unprepared_records}
        response.relationships=relationships
      }
      return response
    })
  }
  async warm(library,session,signal=null){
    if(this.health(library).paused)return {skipped:'feature-paused'}
    if(this.busy)return {skipped:'busy'}
    return this.exclusive(signal,async()=>{const key=await this.identity(signal);this.syncLegacyNotes(library,session);this.prepareChunks(library);const copied=this.copyLegacyVectors(library,key);const indexed=await this.indexPending(library,key,signal),corrections=await this.warmCorrections(library,session,key,signal);return {copied,indexed,corrections,status:this.status(library,key)}})
  }
  close(){this.legacy?.close()}
}
