import {uuid,hash,fail,text,clip} from './util.mjs'
import {activeSource,sourceAvailabilitySQL,sourceStamp} from './source-position.mjs'

const DAY=86400000
const POSITIVE={cited:.25,helpful:.5,reaffirmed:.75}
const NEGATIVE={corrected:.55,invalidated:.35}
const cueKey=s=>String(s).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'')

/** Retrieval salience only. Feedback is an attributed report, never a truth label. */
export class MemoryDynamics {
  constructor(store,{enabled=false,semanticThreshold=.84}={}){
    if(typeof enabled!=='boolean')fail('INVALID_INPUT','memoryDynamics.enabled必须为布尔值')
    if(typeof semanticThreshold!=='number'||!Number.isFinite(semanticThreshold)||semanticThreshold<.8||semanticThreshold>.99)fail('INVALID_INPUT','纠正线索语义阈值应在0.8—0.99')
    this.store=store;this.enabled=enabled;this.semanticThreshold=semanticThreshold
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS cm_memory_feedback(id TEXT PRIMARY KEY,library TEXT NOT NULL,rid TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,session TEXT NOT NULL,kind TEXT NOT NULL,cue TEXT NOT NULL,cue_key TEXT NOT NULL,reason TEXT NOT NULL,refs TEXT NOT NULL,dedupe TEXT NOT NULL UNIQUE,time INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cm_feedback_record ON cm_memory_feedback(library,rid,time);
      CREATE TABLE IF NOT EXISTS cm_memory_feedback_refs(event_id TEXT NOT NULL REFERENCES cm_memory_feedback(id) ON DELETE CASCADE,rid TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,role TEXT NOT NULL,PRIMARY KEY(event_id,rid,role));
      CREATE INDEX IF NOT EXISTS cm_feedback_source ON cm_memory_feedback_refs(rid,event_id);
      CREATE TABLE IF NOT EXISTS cm_memory_feedback_retractions(event_id TEXT PRIMARY KEY REFERENCES cm_memory_feedback(id) ON DELETE CASCADE,session TEXT NOT NULL,reason TEXT NOT NULL,refs TEXT NOT NULL,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cm_feedback_cue_vectors(event_id TEXT PRIMARY KEY REFERENCES cm_memory_feedback(id) ON DELETE CASCADE,model_key TEXT NOT NULL,digest TEXT NOT NULL,dimensions INTEGER NOT NULL,value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS cm_feedback_health(library TEXT PRIMARY KEY,error TEXT,paused INTEGER NOT NULL,time INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS cm_feedback_source_deleted BEFORE DELETE ON records BEGIN
        DELETE FROM cm_memory_feedback WHERE id IN (SELECT event_id FROM cm_memory_feedback_refs WHERE rid=old.id);
      END;
    `)
  }
  health(library){const r=this.store.db.prepare('SELECT error,paused,time FROM cm_feedback_health WHERE library=?').get(library);return r?{...r,paused:!!r.paused}:{error:null,paused:false,time:null}}
  resume(library,session){this.store.assertOwner(library,session);return this.store.tx(()=>{this.store.db.prepare('DELETE FROM cm_feedback_cue_vectors WHERE event_id IN (SELECT id FROM cm_memory_feedback WHERE library=?)').run(library);this.store.db.prepare('DELETE FROM cm_feedback_health WHERE library=?').run(library);return this.health(library)})}
  markFailure(library,error){const code=/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'CORRECTION_INDEX_FAILED';this.store.db.prepare('INSERT INTO cm_feedback_health VALUES(?,?,1,?) ON CONFLICT(library) DO UPDATE SET error=excluded.error,paused=1,time=excluded.time').run(library,code,this.store.now());this.store.log(library,'correction-index-paused',{code,main_chat_blocked:false})}
  negativeRows(library,key,ids=null){
    const scope=ids?' AND f.rid IN (SELECT value FROM json_each(?))':''
    const valid=sourceAvailabilitySQL(this.store),refValid=sourceAvailabilitySQL(this.store,'rr')
    const sql="SELECT f.*,v.model_key,v.digest cue_digest,v.dimensions,v.value FROM cm_memory_feedback f JOIN records r ON r.id=f.rid LEFT JOIN cm_memory_feedback_retractions x ON x.event_id=f.id LEFT JOIN cm_feedback_cue_vectors v ON v.event_id=f.id AND v.model_key=? WHERE f.library=? AND x.event_id IS NULL AND f.kind IN ('corrected','invalidated') AND "+valid+" AND NOT EXISTS(SELECT 1 FROM json_each(f.refs) j LEFT JOIN records rr ON rr.id=j.value AND rr.library=f.library WHERE rr.id IS NULL OR NOT ("+refValid+'))'+scope+' ORDER BY f.time DESC,f.rowid DESC'
    return this.store.db.prepare(sql).iterate(key,library,...(ids?[JSON.stringify(ids)]:[]))
  }
  status(library,key=null){
    let total=0,indexed=0
    for(const r of this.negativeRows(library,key)){total++;if(r.cue_digest===hash(r.cue))indexed++}
    return {enabled:this.enabled,threshold:this.semanticThreshold,total_cues:total,indexed_cues:key?indexed:null,pending_cues:key?total-indexed:null,maintenance:this.health(library)}
  }
  async warm(embedding,library,session,key,signal=null){
    if(!this.enabled||this.health(library).paused)return {indexed:0}
    const rows=[]
    for(const r of this.negativeRows(library,key))if(r.cue_digest!==hash(r.cue)){rows.push(r);if(rows.length>=8)break}
    if(!rows.length)return {indexed:0}
    const stamps=rows.map(r=>[r.rid,...JSON.parse(r.refs)].map(id=>[id,sourceStamp(this.store,library,id)]))
    const vectors=await embedding.embed(rows.map(r=>r.cue),true,signal)
    signal?.throwIfAborted();this.store.assertOwner(library,session)
    return this.store.tx(()=>{
      const put=this.store.db.prepare('INSERT OR REPLACE INTO cm_feedback_cue_vectors VALUES(?,?,?,?,?)');let indexed=0
      for(let i=0;i<rows.length;i++){
        const r=rows[i],current=this.store.db.prepare('SELECT cue FROM cm_memory_feedback WHERE id=? AND library=? AND NOT EXISTS(SELECT 1 FROM cm_memory_feedback_retractions WHERE event_id=?)').get(r.id,library,r.id)
        if(!current||current.cue!==r.cue)continue
        let valid=true;for(const [id,stamp] of stamps[i])try{if(sourceStamp(this.store,library,id)!==stamp)valid=false}catch(error){if(['NOT_FOUND','SOURCE_INACTIVE'].includes(error.code))valid=false;else throw error}
        if(!valid)continue
        const vector=vectors[i],buffer=Buffer.alloc(vector.length*4);for(let j=0;j<vector.length;j++)buffer.writeFloatLE(vector[j],j*4)
        put.run(r.id,key,hash(r.cue),vector.length,buffer);indexed++
      }
      return {indexed}
    })
  }
  async match(library,key,queryVector,ids,signal=null){
    const context={status:this.enabled?'ready':'disabled',events:[],pending_rids:[]}
    if(!this.enabled||!ids.length)return context
    const pending=new Set();let visited=0
    try{
      const paused=this.health(library).paused
      for(const row of this.negativeRows(library,key,ids)){
        if(++visited%64===0){await new Promise(r=>setImmediate(r));signal?.throwIfAborted()}
        if(paused||row.cue_digest!==hash(row.cue)){pending.add(row.rid);continue}
        if(row.dimensions!==queryVector.length||row.value?.byteLength!==queryVector.length*4)fail('CORRECTION_VECTOR_INVALID','纠正线索向量维度无效')
        const view=new DataView(row.value.buffer,row.value.byteOffset,row.value.byteLength);let score=0,norm=0
        for(let i=0;i<queryVector.length;i++){const value=view.getFloat32(i*4,true);if(!Number.isFinite(value))fail('CORRECTION_VECTOR_INVALID','纠正线索向量无效');score+=queryVector[i]*value;norm+=value*value}
        if(Math.abs(norm-1)>.02)fail('CORRECTION_VECTOR_INVALID','纠正线索不是单位向量')
        score=Math.max(-1,Math.min(1,score/Math.sqrt(norm)))
        if(score>=this.semanticThreshold)context.events.push({id:row.id,rid:row.rid,score})
      }
      signal?.throwIfAborted();context.status=paused?'unavailable':pending.size?'index-incomplete':'ready'
    }catch(error){if(signal?.aborted)throw error;this.markFailure(library,error);context.status='unavailable';context.events=[];for(const id of ids)pending.add(id)}
    context.pending_rids=[...pending];return context
  }
  active(library,rid){
    return activeSource(this.store,library,rid)
  }
  references(library,rid,refs){
    if(!Array.isArray(refs)||!refs.length||refs.length>3)fail('INVALID_EVIDENCE','使用反馈需1—3条实际记录作为依据')
    const canonical=this.store.verifyRefs(library,refs).sort()
    if(canonical.includes(rid))fail('INVALID_EVIDENCE','被回忆的原文本身不能证明它后来被使用')
    for(const ref of canonical)this.active(library,ref)
    return canonical
  }
  record(library,session,{id,kind,refs,reason,cue=''}){
    this.store.assertOwner(library,session)
    if(!Object.hasOwn(POSITIVE,kind)&&!Object.hasOwn(NEGATIVE,kind))fail('INVALID_INPUT','只记录引用、帮助、重申、纠正或失效，不记录曝光奖励')
    text(reason,'reason',500)
    if(typeof cue!=='string'||cue.length>160)fail('INVALID_INPUT','cue最多160字符')
    const normalized=cueKey(cue)
    if(Object.hasOwn(NEGATIVE,kind)&&Array.from(normalized).length<2)fail('INVALID_INPUT','纠正或失效必须指定至少两字符的具体线索，不能宣判整篇原文无效')
    return this.store.tx(()=>{
      const source=this.active(library,id),canonical=this.references(library,source.id,refs)
      if(canonical.some(ref=>Date.parse(this.active(library,ref).time)<Date.parse(source.time)))fail('INVALID_EVIDENCE','使用依据不能早于被回忆的原文')
      if(kind==='cited'){
        const short=this.store.shortId(library,source.id)
        if(!canonical.some(ref=>this.active(library,ref).text.includes(short)))fail('INVALID_EVIDENCE','引用反馈需实际记录含原文ID；单纯读到不算引用')
      }
      const key=hash([library,source.id,kind,normalized,canonical]),old=this.store.db.prepare('SELECT * FROM cm_memory_feedback WHERE dedupe=?').get(key)
      if(old)return {...this.receipt(old),duplicate:true}
      const event={id:uuid(),library,rid:source.id,session,kind,cue:cue.trim(),cue_key:normalized,reason:reason.trim(),refs:JSON.stringify(canonical),dedupe:key,time:this.store.now()}
      this.store.db.prepare('INSERT INTO cm_memory_feedback(id,library,rid,session,kind,cue,cue_key,reason,refs,dedupe,time) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(event))
      for(const ref of canonical)this.store.db.prepare("INSERT INTO cm_memory_feedback_refs VALUES(?,?,'evidence')").run(event.id,ref)
      this.store.log(library,'memory-feedback-recorded',{id:event.id,rid:source.id,kind,cue:event.cue,refs:canonical,truth_verified:false})
      return {...this.receipt(event),duplicate:false}
    })
  }
  receipt(event){return {id:event.id,rid:event.rid,kind:event.kind,cue:event.cue,retracted:!!this.store.db.prepare('SELECT 1 FROM cm_memory_feedback_retractions WHERE event_id=?').get(event.id),note:'带依据的使用反馈；不修改原文、自我认识或人格，不证明事实真伪。'}}
  retract(library,session,{feedback_id,reason,refs}){
    this.store.assertOwner(library,session);text(reason,'reason',500)
    return this.store.tx(()=>{
      const event=this.store.db.prepare('SELECT * FROM cm_memory_feedback WHERE library=? AND id=?').get(library,feedback_id)
      if(!event)fail('NOT_FOUND','本库没有这条反馈')
      const canonical=this.references(library,event.rid,refs)
      if(this.store.db.prepare('SELECT 1 FROM cm_memory_feedback_retractions WHERE event_id=?').get(event.id))return {...this.receipt(event),duplicate:true}
      this.store.db.prepare('INSERT INTO cm_memory_feedback_retractions VALUES(?,?,?,?,?)').run(event.id,session,reason.trim(),JSON.stringify(canonical),this.store.now())
      for(const ref of canonical)this.store.db.prepare("INSERT OR IGNORE INTO cm_memory_feedback_refs VALUES(?,?,'retraction')").run(event.id,ref)
      this.store.log(library,'memory-feedback-retracted',{id:event.id,rid:event.rid,refs:canonical})
      return {...this.receipt(event),duplicate:false}
    })
  }
  rows(library,rid,query='',semantic=null){
    // Active feedback only; bounded work per candidate. No write occurs on recall.
    const select='SELECT f.* FROM cm_memory_feedback f LEFT JOIN cm_memory_feedback_retractions x ON x.event_id=f.id WHERE f.library=? AND f.rid=? AND x.event_id IS NULL '
    const ids=(semantic?.events||[]).filter(e=>e.rid===rid).map(e=>e.id)
    return [...this.store.db.prepare(select+"AND f.kind IN ('cited','helpful','reaffirmed') ORDER BY f.time DESC,f.rowid DESC LIMIT 64").all(library,rid),...this.store.db.prepare(select+"AND f.kind IN ('corrected','invalidated') AND (instr(?,f.cue_key)>0 OR f.id IN (SELECT value FROM json_each(?))) ORDER BY f.time DESC,f.rowid DESC").all(library,rid,cueKey(query),JSON.stringify(ids))]
  }
  assess(library,record,query='',halfDays=this.store.library(library).settings.decayHalfDays,semantic=null){
    const now=this.store.now(),days=Math.max(0,(now-Date.parse(record.time))/DAY),base=2**(-days/halfDays)
    if(!this.enabled)return {factor:.7+.3*base,phase:base<.01?'dormant':base<.5?'fading':'fresh',activation:base,reinforcement:0,auto_blocked:false,corrective_refs:[]}
    const rows=this.rows(library,record.id,query,semantic).filter(e=>JSON.parse(e.refs).every(ref=>{try{this.active(library,ref);return true}catch(error){if(['NOT_FOUND','SOURCE_INACTIVE'].includes(error.code))return false;throw error}}))
    const positive=rows.filter(e=>Object.hasOwn(POSITIVE,e.kind)).sort((a,b)=>POSITIVE[b.kind]-POSITIVE[a.kind]||b.time-a.time),seen=new Set(),daysUsed=new Map()
    let support=0
    for(const e of positive){
      const refs=JSON.parse(e.refs),unused=refs.filter(r=>!seen.has(r));if(!unused.length)continue
      const time=Math.min(now,Math.max(...unused.map(ref=>Date.parse(this.active(library,ref).time)))),day=Math.floor(time/DAY)
      for(const ref of refs)seen.add(ref)
      if((daysUsed.get(day)||0)>=3)continue;daysUsed.set(day,(daysUsed.get(day)||0)+1)
      support+=POSITIVE[e.kind]*2**(-Math.max(0,(now-time)/DAY)/halfDays)
    }
    const matched=new Set((semantic?.events||[]).filter(e=>e.rid===record.id).map(e=>e.id))
    const reinforcement=Math.min(1,support),activation=Math.max(base,reinforcement),queryKey=cueKey(query),negative=rows.filter(e=>Object.hasOwn(NEGATIVE,e.kind)&&(queryKey.includes(e.cue_key)||matched.has(e.id)))
    const penalty=negative.reduce((n,e)=>Math.min(n,NEGATIVE[e.kind]),1),corrective_refs=[...new Set(negative.flatMap(e=>JSON.parse(e.refs)))].slice(0,3)
    let pending=false
    if(semantic?.pending_rids?.includes(record.id)){const iterator=this.negativeRows(library,null,[record.id]);try{pending=!iterator.next().done}finally{iterator.return?.()}}
    return {factor:(.7+.3*activation)*penalty,phase:activation<.01?'dormant':activation<.5?'fading':'fresh',activation,reinforcement,auto_blocked:negative.length>0||pending,corrective_refs}
  }
  describe(library,id,query=''){
    const r=this.active(library,id),rows=this.store.db.prepare('SELECT f.*,x.time retracted_at FROM cm_memory_feedback f LEFT JOIN cm_memory_feedback_retractions x ON x.event_id=f.id WHERE f.library=? AND f.rid=? ORDER BY f.time DESC,f.rowid DESC LIMIT 5').all(library,r.id)
    return {id:r.id,enabled:this.enabled,semantic:this.status(library),assessment:this.assess(library,r,query),recent:rows.map(e=>({id:e.id,kind:e.kind,cue:e.cue,reason:clip(e.reason,160),refs:JSON.parse(e.refs),session:e.session,time:new Date(e.time).toISOString(),retracted:e.retracted_at!==null})),note:'只影响检索显著性；淡出不删除原文。检索时可做具体纠正线索的高置信语义匹配；此处assessment只演示字面线索。旧事可手动查原文。'}
  }
  recent(library){
    this.store.library(library)
    const rows=this.store.db.prepare('SELECT f.id feedback_id,f.rid id,f.kind,f.cue,f.refs,f.time,x.time retracted_at FROM cm_memory_feedback f LEFT JOIN cm_memory_feedback_retractions x ON x.event_id=f.id WHERE f.library=? ORDER BY f.time DESC,f.rowid DESC LIMIT 5').all(library)
    return {enabled:this.enabled,semantic:this.status(library),recent:rows.map(r=>({...r,refs:JSON.parse(r.refs)})),note:'最近5条反馈，id为被使用的原文编号；指定id可查看该原文反馈。没有记录不等于没有历史。'}
  }
}
