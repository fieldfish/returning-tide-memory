import {text,integer,fail,clip} from './util.mjs'

// This marker is written by Extraction, not inferred from a memory's wording.
export const stateProvenance=entry=>String(entry.reason||'').startsWith('[自动整理，未经独立核验]')?{origin:'model-extracted',verification:'unassessed'}:{}

/** Accepted state history describes recorded decisions, not independently proven world facts. */
export class StateHistory{
 constructor(store){
  this.store=store
  store.db.exec("CREATE INDEX IF NOT EXISTS cm_audit_state_entry ON audit(library,type,json_extract(detail,'$.id'),time)")
 }
 at(value){
  if(value==null)return this.store.now()
  if(typeof value!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(value))fail('INVALID_INPUT','at需要带时区的ISO时间')
  const t=Date.parse(value);if(!Number.isFinite(t)||t>this.store.now())fail('INVALID_INPUT','at不是已发生的有效时间');return t
 }
 acceptedAt(entry){
  if(!entry.accepted)return {time:null,basis:null}
  const audited=this.store.db.prepare("SELECT MIN(time) t FROM audit WHERE library=? AND type IN ('state-revised','state-accepted') AND json_extract(detail,'$.id')=?").get(entry.library,entry.id).t
  return {time:audited??entry.time,basis:audited==null?'entry-time-fallback':'decision-audit'}
 }
 timeline(library,key,{at=null,before_revision=null,limit=5}={}){
  this.store.library(library);text(key,'key',120);integer(limit,'limit',1,5);if(before_revision!==null)integer(before_revision,'before_revision',1)
  const when=this.at(at),rows=this.store.db.prepare('SELECT * FROM entries WHERE library=? AND key=? AND time<=? ORDER BY revision DESC').iterate(library,key,when)
  let accepted=null,latest=null;const selected=[];let hasMore=false,total=0
  for(const row of rows){
   latest??=row;total++;const decision=this.acceptedAt(row)
   if(!accepted&&decision.time!==null&&decision.time<=when)accepted={...row,decision}
   if(before_revision===null||row.revision<before_revision){if(selected.length<limit)selected.push({row,decision});else hasMore=true}
  }
  const brief=({row,decision})=>{
   let status=decision.time!==null&&decision.time<=when?(row.revision===accepted?.revision?(row.expires!==null&&row.expires<=when?'expired':'current-accepted'):'superseded-accepted'):'unreviewed'
   if(status==='unreviewed'){
    const review=this.store.db.prepare('SELECT decision FROM entry_reviews WHERE library=? AND key=? AND revision=?').get(library,key,row.revision)
    if(review){const time=this.store.db.prepare("SELECT MIN(time) t FROM audit WHERE library=? AND type='state-deferred' AND json_extract(detail,'$.key')=? AND json_extract(detail,'$.revision')=?").get(library,key,row.revision).t;if(time!==null&&time<=when)status='deferred';else if(time===null)status='review-time-unknown'}
   }
   const refs=JSON.parse(row.refs)
   return {revision:row.revision,kind:row.kind,status,body:clip(row.body,240),refs:refs.slice(0,3),reference_count:refs.length,created_at:new Date(row.time).toISOString(),accepted_at:decision.time===null||decision.time>when?null:new Date(decision.time).toISOString(),acceptance_time_basis:decision.time===null||decision.time>when?null:decision.basis,excerpt:Array.from(row.body).length>240}
  }
  const current=accepted&&!(accepted.expires!==null&&accepted.expires<=when)?brief({row:accepted,decision:accepted.decision}):null
  return {key,as_of:new Date(when).toISOString(),current,latest_revision:latest?.revision??null,latest_accepted_revision:accepted?.revision??null,total_versions:total,versions:selected.map(brief),next_before_revision:hasMore?selected.at(-1).row.revision:null,note:'认可状态与修订记录，不等于外部事实已核实；旧原文完整保留。'}
 }
 related(library,refs,{limit=3}={}){
  if(!Array.isArray(refs)||!refs.length||refs.length>5)fail('INVALID_INPUT','refs需要1—5条本库原文ID');integer(limit,'limit',1,5)
  const ids=[...new Set(refs.map(r=>this.store.record(library,r).id))],marks=ids.map(()=>'?').join(',')
  const rows=this.store.db.prepare(`SELECT DISTINCT e.key FROM entries e JOIN json_each(e.refs) j WHERE e.library=? AND j.value IN (${marks}) ORDER BY e.time DESC,e.revision DESC LIMIT ?`).all(library,...ids,limit+1)
  return {links:rows.slice(0,limit).map(({key})=>{
   const state=this.timeline(library,key),matched=this.store.db.prepare(`SELECT DISTINCT e.revision FROM entries e JOIN json_each(e.refs) j WHERE e.library=? AND e.key=? AND j.value IN (${marks}) ORDER BY e.revision DESC LIMIT 5`).all(library,key,...ids).map(r=>r.revision)
   return {key,mentioned_revisions:matched,current_revision:state.current?.revision??null,latest_accepted_revision:state.latest_accepted_revision,has_later_accepted:state.latest_accepted_revision!==null&&matched.some(r=>r<state.latest_accepted_revision)}
  }),has_more:rows.length>limit,note:'仅表示这段原文被哪些认识版本引用，不表示整段原文过时。'}
 }
 currentRefs(library,key,at=null){
  const state=this.timeline(library,key,{at}),row=state.current?this.store.entry(library,key,state.current.revision):null,refs=row?.refs||[]
  const prior=row?this.store.db.prepare('SELECT refs FROM entries WHERE library=? AND key=? AND revision<? AND accepted=1').all(library,key,row.revision):[]
  const old=new Set(prior.flatMap(r=>JSON.parse(r.refs)))
  return {state,refs,shared_older_refs:refs.filter(r=>old.has(r))}
 }
}
