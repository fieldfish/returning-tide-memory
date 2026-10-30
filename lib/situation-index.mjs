import {hash,fail,integer,clip} from './util.mjs'
import {sourcePosition,sourceAncestors} from './source-position.mjs'

const BATCH=8,MAX_PROJECTION=1200,MAX_CARD=250,MAX_RESPONSE=1200
const chars=s=>Array.from(String(s)).length
const clean=s=>String(s??'').replace(/\s+/gu,' ').trim()
const cancelled=signal=>{if(signal?.aborted)fail('CANCELLED','情境检索已取消')}
const legacyExists=store=>!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cm_legacy_notes'").get()
const listRefs=value=>Array.isArray(value)?value.filter(id=>typeof id==='string'&&id.length>0):[]

// These terms corroborate a vector candidate; they never form a fallback search.
const terms=query=>{
  const result=new Set()
  for(const run of clean(query).toLowerCase().match(/[\u3400-\u9fff]+|[a-z0-9][a-z0-9_-]*/g)||[]){
    if(/[\u3400-\u9fff]/.test(run))for(let i=0;i<run.length-1;i++)result.add(run.slice(i,i+2))
    else if(run.length>=3)result.add(run)
  }
  for(const stop of ['什么','这个','那个','我们','你们','他们','可以','一个','怎么','如何','是不是','请问','知道','记得','之前','现在','当时','后来','时候','事情','情境','情况','有关','关于','进行','已经','没有','计划','任务','项目','方案','整理','原文','the','and','that','this','with','what','when','where','about','please','remember','plan','task','project'])result.delete(stop)
  return [...result].slice(0,80)
}
const corroborate=(query,content)=>{
  const lower=clean(content).toLowerCase(),q=clean(query).toLowerCase(),tokens=terms(q)
  const exactTokens=q.match(/[a-z0-9][a-z0-9_-]{5,}/g)||[]
  const exact=exactTokens.some(t=>/[0-9_-]/.test(t)&&lower.includes(t))
  const hits=tokens.filter(t=>lower.includes(t)),lexical=hits.length>0
  // A substantive phrase or identifier suffices; uncorroborated similarity does not.
  const phrase=q.length>=2&&q.length<=160&&tokens.length>0&&lower.includes(q)
  const substantive=hits.some(t=>t.length>=3&&!/[\u3400-\u9fff]/.test(t))||hits.filter(t=>/[\u3400-\u9fff]{2}/.test(t)).length>=2
  return {exact,lexical,admissible:exact||phrase||substantive}
}
const normalize=values=>{
  if(!(Array.isArray(values)||values instanceof Float32Array||values instanceof Float64Array)||!values.length||values.length>8192)fail('EMBEDDING_INVALID_VECTOR','情境向量格式无效')
  let norm=0
  for(const value of values){if(typeof value!=='number'||!Number.isFinite(value))fail('EMBEDDING_INVALID_VECTOR','情境向量包含无效数字');norm+=value*value}
  norm=Math.sqrt(norm)
  if(!Number.isFinite(norm)||norm<1e-12)fail('EMBEDDING_INVALID_VECTOR','情境向量无效或为零')
  const vector=Float32Array.from(values,value=>value/norm)
  if(vector.some(value=>!Number.isFinite(value)))fail('EMBEDDING_INVALID_VECTOR','情境向量无法保存')
  return vector
}
const encode=vector=>{const bytes=Buffer.alloc(vector.length*4);for(let i=0;i<vector.length;i++)bytes.writeFloatLE(vector[i],i*4);return bytes}
const similarity=(query,row)=>{
  if(!Number.isSafeInteger(row.dimensions)||row.dimensions!==query.length||!(row.value instanceof Uint8Array)||row.value.byteLength!==query.length*4)fail('EMBEDDING_INVALID_VECTOR','情境索引维度或长度无效')
  const bytes=new DataView(row.value.buffer,row.value.byteOffset,row.value.byteLength);let sum=0,norm=0
  for(let i=0;i<query.length;i++){const v=bytes.getFloat32(i*4,true);if(!Number.isFinite(v))fail('EMBEDDING_INVALID_VECTOR','情境索引包含无效数字');sum+=query[i]*v;norm+=v*v}
  if(!Number.isFinite(norm)||norm<1e-12||Math.abs(norm-1)>0.02)fail('EMBEDDING_INVALID_VECTOR','情境索引不是单位向量')
  return Math.max(-1,Math.min(1,sum/Math.sqrt(norm)))
}

/** Build only a CURRENT, source-valid, bounded view. No inference or model calls. */
function snapshot(store,situations,library,id){
  let version
  try{version=situations.rawVersion(library,id)}catch(error){if(error.code==='NOT_FOUND')return null;throw error}
  const document=version.document,assertions=Array.isArray(document.assertions)?document.assertions:[]
  const direct=[...new Set([...listRefs(document.title_refs),...assertions.flatMap(a=>listRefs(a.refs))])],ancestors=new Map(direct.map(id=>[id,sourceAncestors(store,library,id)]))
  const dependencies=[...new Set([...direct,...[...ancestors.values()].flat()])]
  const hasLegacy=legacyExists(store),sources=new Map(),sourceState=[]
  const get=store.db.prepare('SELECT id,digest,session,seq,origin FROM records WHERE library=? AND id=?')
  const active=hasLegacy?store.db.prepare('SELECT min(active) active FROM cm_legacy_notes WHERE library=? AND rid=?'):null
  for(const rid of dependencies){
    const row=get.get(library,rid),available=!!row&&(!active||active.get(library,rid)?.active!==0)
    const position=row?sourcePosition(row):null
    sources.set(rid,{row,available});sourceState.push([rid,row?.digest??null,available?1:0,position?.session??null,position?.seq??null])
  }
  const available=refs=>refs.length>0&&refs.every(rid=>[rid,...(ancestors.get(rid)||[])].every(id=>sources.get(id)?.available))
  const titleRefs=listRefs(document.title_refs),title=available(titleRefs)?clip(clean(document.title),160):''
  const pieces=[],refs=new Set(),selected=[]
  let content='情境整理（有出处，非逐字原文）'
  if(title){content+='\n标题：'+title;for(const rid of titleRefs)refs.add(rid)}
  // Recent assertions receive a bounded excerpt; omitted statements contribute no refs.
  for(const assertion of [...assertions].reverse()){
    if(selected.length>=6)break
    const ids=listRefs(assertion.refs)
    if(!available(ids)||!clean(assertion.body))continue
    const origin=assertion.origin==='model-consolidated'?'model-consolidated':'explicit'
    const original=clean(assertion.body),excerpted=chars(original)>130,body=clip(original,130)+(excerpted?'…':'')
    const line=`[${origin}:${clip(clean(assertion.slot),24)}] ${body}`
    if(chars(content)+1+chars(line)>MAX_PROJECTION)continue
    content+='\n'+line;pieces.push(line);selected.push({slot:assertion.slot,body,origin,refs:ids,excerpted})
    for(const rid of ids)refs.add(rid)
  }
  const hasEpoch=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cm_situation_index_source_epoch'").get()
  const documentDigest=hash(document),epoch=hasEpoch?(store.db.prepare('SELECT epoch FROM cm_situation_index_source_epoch WHERE library=? AND situation=?').get(library,id)?.epoch??0):0
  const base={id,revision:version.revision,dependencies,source_state:sourceState,document_digest:documentDigest,epoch,legacy_present:hasLegacy}
  if(!refs.size)return {...base,projection:null}
  const ids=[...refs],read=store.db.prepare('SELECT digest,session,seq,time,role,type,origin FROM records WHERE library=? AND id=?'),fingerprints=[]
  for(const rid of ids){
    const row=read.get(library,rid)
    if(!row)return {...base,projection:null}
    // Raw records are immutable through the store. UPDATE/DELETE triggers advance
    // this situation's epoch even when a direct SQL edit fails to update digest.
    fingerprints.push([rid,row.digest,row.session,row.seq,row.time,row.role,row.type,row.origin])
  }
  const projection={id,revision:version.revision,title,content,summary:pieces.join('；')||title,refs:ids,
    mode:document.mode||'unknown',status:document.status||'active',source_state:sourceState.filter(v=>refs.has(v[0])||[...refs].some(id=>ancestors.get(id)?.includes(v[0]))),statements:selected,
    omitted_assertions:assertions.length-selected.length,excerpted:selected.some(statement=>statement.excerpted)||assertions.length>selected.length}
  projection.digest=hash([id,version.revision,documentDigest,epoch,content,ids,fingerprints,projection.mode,projection.status])
  return {...base,projection}
}

export function projectSituation(store,situations,library,id){return snapshot(store,situations,library,id)?.projection??null}

export class SituationIndex {
  constructor(store,situations,embedding,{enabled=false,minSemantic=.62}={}){
    if(typeof enabled!=='boolean'||typeof minSemantic!=='number'||!Number.isFinite(minSemantic)||minSemantic<0||minSemantic>1)fail('INVALID_INPUT','情境索引配置无效')
    this.store=store;this.situations=situations;this.embedding=embedding;this.enabled=enabled;this.minSemantic=minSemantic;this.modelKey=null;this.legacyReady=false
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS cm_situation_index(library TEXT NOT NULL,situation TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,content TEXT NOT NULL,model_key TEXT NOT NULL,dimensions INTEGER NOT NULL,value BLOB NOT NULL,refs TEXT NOT NULL,PRIMARY KEY(library,situation,model_key));
      CREATE INDEX IF NOT EXISTS cm_situation_index_scope ON cm_situation_index(library,model_key,situation);
      CREATE TABLE IF NOT EXISTS cm_situation_index_state(library TEXT NOT NULL,situation TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,projectable INTEGER NOT NULL,source_state TEXT NOT NULL,PRIMARY KEY(library,situation));
      CREATE TABLE IF NOT EXISTS cm_situation_index_dependencies(library TEXT NOT NULL,situation TEXT NOT NULL,rid TEXT NOT NULL,PRIMARY KEY(library,situation,rid));
      CREATE INDEX IF NOT EXISTS cm_situation_index_source ON cm_situation_index_dependencies(library,rid,situation);
      CREATE TABLE IF NOT EXISTS cm_situation_index_source_epoch(library TEXT NOT NULL,situation TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(library,situation));
      CREATE TABLE IF NOT EXISTS cm_situation_index_health(library TEXT PRIMARY KEY,error TEXT,paused INTEGER NOT NULL,time INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS cm_situation_index_revision AFTER UPDATE OF revision ON cm_situations BEGIN
        DELETE FROM cm_situation_index WHERE library=old.library AND situation=old.id;
        DELETE FROM cm_situation_index_state WHERE library=old.library AND situation=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS cm_situation_index_document AFTER UPDATE ON cm_situation_versions BEGIN
        DELETE FROM cm_situation_index WHERE situation=old.situation;
        DELETE FROM cm_situation_index_state WHERE situation=old.situation;
      END;
      CREATE TRIGGER IF NOT EXISTS cm_situation_index_document_delete AFTER DELETE ON cm_situation_versions BEGIN
        DELETE FROM cm_situation_index WHERE situation=old.situation;
        DELETE FROM cm_situation_index_state WHERE situation=old.situation;
      END;
      CREATE TRIGGER IF NOT EXISTS cm_situation_index_delete AFTER DELETE ON cm_situations BEGIN
        DELETE FROM cm_situation_index WHERE situation=old.id;
        DELETE FROM cm_situation_index_state WHERE situation=old.id;
        DELETE FROM cm_situation_index_dependencies WHERE situation=old.id;
        DELETE FROM cm_situation_index_source_epoch WHERE situation=old.id;
      END;
    `)
    for(const event of ['DELETE','UPDATE','INSERT']){
      const rid=event==='INSERT'?'new':'old'
      store.db.exec(`DROP TRIGGER IF EXISTS cm_situation_index_record_${event.toLowerCase()}; CREATE TRIGGER cm_situation_index_record_${event.toLowerCase()} AFTER ${event} ON records BEGIN
        INSERT INTO cm_situation_index_source_epoch(library,situation,epoch) SELECT library,situation,1 FROM cm_situation_index_dependencies WHERE library=${rid}.library AND rid=${rid}.id
          ON CONFLICT(library,situation) DO UPDATE SET epoch=epoch+1;
        DELETE FROM cm_situation_index WHERE library=${rid}.library AND situation IN (SELECT situation FROM cm_situation_index_dependencies WHERE library=${rid}.library AND rid=${rid}.id);
        DELETE FROM cm_situation_index_state WHERE library=${rid}.library AND situation IN (SELECT situation FROM cm_situation_index_dependencies WHERE library=${rid}.library AND rid=${rid}.id);
      END;`)
    }
    this.legacyTriggers()
  }
  legacyTriggers(){
    if(!legacyExists(this.store))return
    if(this.legacyReady&&this.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('cm_situation_index_legacy_update','cm_situation_index_legacy_delete','cm_situation_index_legacy_insert')").get().n===3)return
    for(const event of ['UPDATE','DELETE','INSERT']){
      const rid=event==='DELETE'?'old':'new'
      this.store.db.exec(`DROP TRIGGER IF EXISTS cm_situation_index_legacy_${event.toLowerCase()}; CREATE TRIGGER cm_situation_index_legacy_${event.toLowerCase()} AFTER ${event} ON cm_legacy_notes BEGIN
        INSERT INTO cm_situation_index_source_epoch(library,situation,epoch) SELECT library,situation,1 FROM cm_situation_index_dependencies WHERE library=${rid}.library AND rid=${rid}.rid
          ON CONFLICT(library,situation) DO UPDATE SET epoch=epoch+1;
        DELETE FROM cm_situation_index WHERE library=${rid}.library AND situation IN (SELECT situation FROM cm_situation_index_dependencies WHERE library=${rid}.library AND rid=${rid}.rid);
        DELETE FROM cm_situation_index_state WHERE library=${rid}.library AND situation IN (SELECT situation FROM cm_situation_index_dependencies WHERE library=${rid}.library AND rid=${rid}.rid);
      END;`)
    }
    this.legacyReady=true
  }
  health(library){const row=this.store.db.prepare('SELECT error,paused,time FROM cm_situation_index_health WHERE library=?').get(library);return row?{...row,paused:!!row.paused}:{error:null,paused:false,time:null}}
  markFailure(library,error){
    const code=typeof error==='string'?error:error?.code
    if(['CANCELLED','INVALID_INPUT','NOT_OWNER','NOT_FOUND'].includes(code))return
    const safe=/^[A-Z0-9_]{1,80}$/.test(code||'')?code:'SITUATION_INDEX_FAILED'
    this.store.db.prepare('INSERT INTO cm_situation_index_health VALUES(?,?,1,?) ON CONFLICT(library) DO UPDATE SET error=excluded.error,paused=1,time=excluded.time').run(library,safe,this.store.now())
  }
  resume(library,session){this.store.assertOwner(library,session);this.store.db.prepare('INSERT INTO cm_situation_index_health VALUES(?,NULL,0,?) ON CONFLICT(library) DO UPDATE SET error=NULL,paused=0,time=excluded.time').run(library,this.store.now());return this.health(library)}
  key(){return this.embedding.cached||this.modelKey||null}
  // SQL aggregation avoids materializing every situation or document for status/backlog.
  validState(){
    const legacy=legacyExists(this.store)
    return `st.revision=s.revision AND coalesce(json_extract(st.source_state,'$.legacy'),-1)=${legacy?1:0} AND coalesce(json_extract(st.source_state,'$.epoch'),-1)=coalesce((SELECT e.epoch FROM cm_situation_index_source_epoch e WHERE e.library=s.library AND e.situation=s.id),0)`
  }
  status(library){
    this.store.library(library)
    const key=this.key(),valid=this.validState()
    const row=this.store.db.prepare(`SELECT count(*) total_situations,
      coalesce(sum(CASE WHEN ${valid} AND st.projectable=0 THEN 1 ELSE 0 END),0) unindexable_situations,
      coalesce(sum(CASE WHEN ${valid} AND st.projectable=1 AND v.situation IS NOT NULL THEN 1 ELSE 0 END),0) indexed_situations
      FROM cm_situations s LEFT JOIN cm_situation_index_state st ON st.library=s.library AND st.situation=s.id
      LEFT JOIN cm_situation_index v ON v.library=s.library AND v.situation=s.id AND v.revision=s.revision AND v.digest=st.digest AND v.model_key=? WHERE s.library=?`).get(key??'',library)
    const pending=row.total_situations-row.unindexable_situations-row.indexed_situations
    return {enabled:this.enabled,model:this.embedding.model??null,model_key:key,model_key_known:!!key,...row,pending_situations:pending,
      pending_model_check:!key&&pending>0,index_work_remaining:pending>0,lookup:'situation-vector-candidates',answerability:'unassessed',maintenance:this.health(library)}
  }
  excluded(projection,exclude){return !!exclude&&projection.source_state.some(row=>row[3]===exclude.session&&row[4]>=exclude.fromSeq)}
  revalidate(library,{id,revision,digest=null}={},exclude=null){
    if(!this.enabled||typeof id!=='string'||!Number.isSafeInteger(revision))return false
    const projection=projectSituation(this.store,this.situations,library,id)
    if(!projection||projection.revision!==revision||(digest!=null&&projection.digest!==digest)||this.excluded(projection,exclude))return false
    return !!this.store.db.prepare('SELECT 1 FROM cm_situation_index WHERE library=? AND situation=? AND revision=? AND digest=? LIMIT 1').get(library,id,revision,projection.digest)
  }
  remember(library,state){
    const projection=state.projection,digest=projection?.digest??hash([state.revision,state.document_digest,state.source_state])
    this.store.db.prepare('DELETE FROM cm_situation_index WHERE library=? AND situation=? AND (revision!=? OR digest!=?)').run(library,state.id,state.revision,digest)
    this.store.db.prepare('INSERT INTO cm_situation_index_state VALUES(?,?,?,?,?,?) ON CONFLICT(library,situation) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,projectable=excluded.projectable,source_state=excluded.source_state').run(library,state.id,state.revision,digest,projection?1:0,JSON.stringify({legacy:state.legacy_present?1:0,epoch:state.epoch}))
    this.store.db.prepare('DELETE FROM cm_situation_index_dependencies WHERE library=? AND situation=?').run(library,state.id)
    const put=this.store.db.prepare('INSERT INTO cm_situation_index_dependencies VALUES(?,?,?)')
    for(const rid of state.dependencies)put.run(library,state.id,rid)
  }
  async warm(library,session,signal=null){
    this.store.assertOwner(library,session)
    if(!this.enabled)return {skipped:'feature-disabled'}
    if(this.health(library).paused)return {skipped:'feature-paused'}
    try{return await this.embedding.exclusive(signal,async()=>{
      cancelled(signal);this.store.assertOwner(library,session)
      if(this.health(library).paused)return {skipped:'feature-paused'}
      const key=await this.embedding.identity(signal);cancelled(signal);this.store.assertOwner(library,session)
      if(typeof key!=='string'||!key)fail('EMBEDDING_INVALID_RESPONSE','情境向量模型标识无效')
      this.modelKey=key;this.legacyTriggers()
      const valid=this.validState(),rows=this.store.db.prepare(`SELECT s.id FROM cm_situations s LEFT JOIN cm_situation_index_state st ON st.library=s.library AND st.situation=s.id WHERE s.library=? AND (st.situation IS NULL OR NOT (${valid}) OR (st.projectable=1 AND NOT EXISTS (SELECT 1 FROM cm_situation_index v WHERE v.library=s.library AND v.situation=s.id AND v.revision=s.revision AND v.digest=st.digest AND v.model_key=?))) ORDER BY s.rowid LIMIT ?`).all(library,key,BATCH)
      const states=rows.map(row=>snapshot(this.store,this.situations,library,row.id)).filter(Boolean)
      this.store.tx(()=>{for(const state of states)this.remember(library,state)})
      const projections=states.map(state=>state.projection).filter(Boolean)
      let indexed=0,discarded=0
      if(projections.length){
        const values=await this.embedding.embed(projections.map(row=>row.content),false,signal)
        cancelled(signal);this.store.assertOwner(library,session)
        if(!Array.isArray(values)||values.length!==projections.length)fail('EMBEDDING_INVALID_RESPONSE','情境向量数量无效')
        const vectors=values.map(normalize)
        if(vectors.some(value=>value.length!==vectors[0].length))fail('EMBEDDING_INVALID_VECTOR','情境向量维度不一致')
        this.store.tx(()=>{
          const put=this.store.db.prepare('INSERT INTO cm_situation_index VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(library,situation,model_key) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,content=excluded.content,dimensions=excluded.dimensions,value=excluded.value,refs=excluded.refs')
          for(let i=0;i<projections.length;i++){
            const prior=projections[i],current=snapshot(this.store,this.situations,library,prior.id)
            if(!current?.projection||current.projection.digest!==prior.digest){discarded++;continue}
            this.remember(library,current)
            put.run(library,prior.id,prior.revision,prior.digest,prior.content,key,vectors[i].length,encode(vectors[i]),JSON.stringify(prior.refs));indexed++
          }
        })
      }
      return {prepared:states.length,indexed,discarded,status:this.status(library)}
    })}catch(error){this.markFailure(library,error);throw error}
  }
  compact(projection,score){
    const item={id:projection.id,revision:projection.revision,title:clip(projection.title,24),score:+score.toFixed(5),summary:clip(projection.summary,80),refs:projection.refs.slice(0,1),mode:projection.mode,status:projection.status,semantic:+score.toFixed(5)}
    while(chars(JSON.stringify(item))>MAX_CARD&&item.summary)item.summary=clip(item.summary,Math.max(0,chars(item.summary)-1))
    while(chars(JSON.stringify(item))>MAX_CARD&&item.title)item.title=clip(item.title,Math.max(0,chars(item.title)-1))
    return chars(JSON.stringify(item))<=MAX_CARD?item:null
  }
  async lookup(library,session,query,limit=3,signal=null,options={}){
    this.store.library(library)
    if(typeof query!=='string'||!query.trim()||chars(query)>1000)fail('INVALID_INPUT','情境检索词无效')
    integer(limit,'limit',1,5)
    if(!options||typeof options!=='object'||Array.isArray(options))fail('INVALID_INPUT','情境检索选项无效')
    const exclude=options.exclude??null
    if(exclude&&(typeof exclude.session!=='string'||!Number.isSafeInteger(exclude.fromSeq)||exclude.fromSeq<0))fail('INVALID_INPUT','情境检索排除范围无效')
    const empty=(note,status,error=null)=>({results:[],status,available:false,...(status==='unavailable'?{error}:{}),incomplete:this.status(library).index_work_remaining,note})
    if(!this.enabled)return empty('情境向量索引未启用。','disabled')
    if(this.health(library).paused)return empty('情境向量功能已暂停；请核对后手动恢复。','unavailable',this.health(library).error)
    try{return await this.embedding.exclusive(signal,async()=>{
      cancelled(signal)
      if(this.health(library).paused)return empty('情境向量功能已暂停；请核对后手动恢复。','unavailable',this.health(library).error)
      const key=await this.embedding.identity(signal);cancelled(signal)
      if(typeof key!=='string'||!key)fail('EMBEDDING_INVALID_RESPONSE','情境向量模型标识无效')
      this.modelKey=key
      const values=await this.embedding.embed([query],true,signal);cancelled(signal)
      if(!Array.isArray(values)||values.length!==1)fail('EMBEDDING_INVALID_RESPONSE','情境查询向量数量无效')
      const vector=normalize(values[0]),best=[]
      // Scan only the bounded stored projection and vector. Full current documents
      // and source metadata are read for at most twenty top candidates afterward.
      const excludeSQL=exclude?' AND NOT EXISTS (SELECT 1 FROM json_each(v.refs) j JOIN records r ON r.library=v.library AND r.id=j.value WHERE r.session=? AND r.seq>=?)':''
      const rows=this.store.db.prepare('SELECT v.* FROM cm_situation_index v JOIN cm_situations s ON s.library=v.library AND s.id=v.situation AND s.revision=v.revision WHERE v.library=? AND v.model_key=?'+excludeSQL+' ORDER BY v.situation').iterate(library,key,...(exclude?[exclude.session,exclude.fromSeq]:[]))
      let visited=0
      for(const row of rows){
        if(++visited%8===0){await new Promise(resolve=>setImmediate(resolve));cancelled(signal)}
        const score=similarity(vector,row)
        if(score<this.minSemantic)continue
        if(typeof row.content!=='string'||chars(row.content)>MAX_PROJECTION)fail('SITUATION_INDEX_INVALID','情境索引投影无效')
        const content=row.content.split('\n').slice(1).map(line=>line.startsWith('标题：')?line.slice(3):line.replace(/^\[[^\]]+\] /u,'')).join('\n')
        const proof=corroborate(query,content)
        if(!proof.admissible)continue
        best.push({row,score,...proof});best.sort((a,b)=>b.score-a.score||a.row.situation.localeCompare(b.row.situation));if(best.length>20)best.pop()
      }
      cancelled(signal)
      // A yielded scan may outlive source deletion or a revision; validate every winner again.
      const selected=[]
      for(const candidate of best){
        await new Promise(resolve=>setImmediate(resolve));cancelled(signal)
        const prior=candidate.row,current=projectSituation(this.store,this.situations,library,prior.situation)
        if(!current||current.revision!==prior.revision||current.digest!==prior.digest||current.content!==prior.content||this.excluded(current,exclude))continue
        let indexedRefs
        try{indexedRefs=JSON.parse(prior.refs)}catch{fail('SITUATION_INDEX_INVALID','情境索引出处无效')}
        if(JSON.stringify(indexedRefs)!==JSON.stringify(current.refs))fail('SITUATION_INDEX_INVALID','情境索引出处与当前投影不符')
        const proof=corroborate(query,[current.title,...current.statements.map(statement=>statement.body)].join('\n'))
        if(!proof.admissible||!this.revalidate(library,current,exclude))continue
        selected.push({...candidate,...proof,projection:current});if(selected.length>=limit)break
      }
      // Each candidate check yields. A later yield can invalidate an earlier winner.
      for(let i=selected.length-1;i>=0;i--)if(!this.revalidate(library,selected[i].projection,exclude))selected.splice(i,1)
      cancelled(signal)
      const response={results:selected.map(item=>this.compact(item.projection,item.score)).filter(Boolean),status:'ready',available:true,incomplete:this.status(library).index_work_remaining,note:'仅索引标题及至多6条表述摘录；未命中不代表没有。整理候选非原话，相似不证明同一经历；卡片仅列首条出处。'}
      if(response.incomplete)response.note+='索引尚未完成。'
      while(chars(JSON.stringify(response))>MAX_RESPONSE&&response.results.length)response.results.pop()
      if(options.details)response.candidates=selected.map(item=>({id:item.projection.id,revision:item.projection.revision,digest:item.projection.digest,title:item.projection.title,summary:item.projection.summary,refs:[...item.projection.refs],mode:item.projection.mode,status:item.projection.status,semantic:+item.score.toFixed(5),score:+item.score.toFixed(5),lexical:item.lexical,exact:item.exact,excerpted:item.projection.excerpted,omitted_assertions:item.projection.omitted_assertions}))
      return response
    })}catch(error){this.markFailure(library,error);throw error}
  }
}
