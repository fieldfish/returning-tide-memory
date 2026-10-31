import {uuid,hash,text,integer,clip,fail} from './util.mjs'
import {activeSource,excludedSource,sourcePosition} from './source-position.mjs'
import {StateHistory} from './state-history.mjs'
const KINDS=new Set(['changed','corrected','disputed','contextual'])
const CHANGES=new Set(['changed','corrected'])
const INACTIVE=new Set(['NOT_FOUND','SOURCE_INACTIVE','CURRENT_TURN_EXCLUDED'])
const CURSOR_VERSION=1
const PAGE_LIMIT_MAX=20
const origin=r=>typeof r.origin==='string'?JSON.parse(r.origin):r.origin||{}
const actor=r=>{const o=origin(r);return ['user','assistant'].includes(r.role)?[r.role,o.sender_id??o.user_id??(r.role==='user'?r.session:'model')].join(':'):null}
// Topic cues ignore spacing, case and trailing sentence punctuation.
const norm=s=>s.normalize('NFKC').replace(/\s+/gu,'').toLowerCase().replace(/[。！？!?、，,.;；:：…]+$/u,'')
// Accepted bodies are compared the way they were recorded: case, word boundaries and punctuation
// that can belong to a name (C#, key:, US) are never collapsed into a synonym.
const bodyKey=s=>s.normalize('NFKC').replace(/\s+/gu,' ').trim()
const polarity=r=>[...r.text.matchAll(/我(?:现在|以前|今天|曾经)?(不再|不)?喜欢([^。！？!?\n]{1,24})/gu)].map(m=>({topic:norm(m[2].replace(/[了的呀啊呢吧]+$/u,'')),negative:!!m[1],quote:m[0]}))
// "Later" follows source position before archive time. Two sources in the same effective session are
// ordered by sequence first, so a report of an earlier native event that was archived later cannot
// become a later understanding. Sources that cannot be ordered that way fall back to archive time;
// an equal time that does not establish order stays uncertain rather than counting as later.
const laterThan=(a,b)=>{
 const ap=sourcePosition(a),bp=sourcePosition(b)
 if(ap.session===bp.session)return ap.seq>bp.seq
 const at=Date.parse(a.time),bt=Date.parse(b.time)
 return Number.isFinite(at)&&Number.isFinite(bt)&&at>bt
}
const cursorSignature=(library,anchor,time,id)=>hash(['cm-claim-relation-page',CURSOR_VERSION,library,anchor,time,id]).slice(0,16)

/** Attributed claim relationships. Sources remain immutable; chronology alone never proves truth. */
export class ClaimLinks{
 constructor(store){
  this.store=store;this.history=new StateHistory(store)
  store.db.exec(`CREATE TABLE IF NOT EXISTS cm_claim_links(id TEXT PRIMARY KEY,library TEXT NOT NULL,session TEXT NOT NULL,kind TEXT NOT NULL,subject TEXT NOT NULL,topic TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,source_quote TEXT NOT NULL,target_quote TEXT NOT NULL,reason TEXT NOT NULL,dedupe TEXT NOT NULL UNIQUE,time INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS cm_claim_link_source ON cm_claim_links(library,source);
   CREATE INDEX IF NOT EXISTS cm_claim_link_target ON cm_claim_links(library,target);
   CREATE INDEX IF NOT EXISTS cm_claim_link_order ON cm_claim_links(library,time,id);
   CREATE TABLE IF NOT EXISTS cm_claim_link_retractions(id TEXT PRIMARY KEY REFERENCES cm_claim_links(id) ON DELETE CASCADE,session TEXT NOT NULL,reason TEXT NOT NULL,refs TEXT NOT NULL,time INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cm_claim_retraction_refs(link TEXT NOT NULL REFERENCES cm_claim_link_retractions(id) ON DELETE CASCADE,rid TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,PRIMARY KEY(link,rid));
   CREATE TRIGGER IF NOT EXISTS cm_claim_retraction_source_deleted BEFORE DELETE ON records BEGIN DELETE FROM cm_claim_links WHERE id IN (SELECT link FROM cm_claim_retraction_refs WHERE rid=old.id); END;`)
 }
 active(library,id,exclude=null){const r=activeSource(this.store,library,id);if(excludedSource(r,exclude))fail('CURRENT_TURN_EXCLUDED','当前回合不能成为旧事的依据');return r}
 record(library,session,a){
  this.store.assertOwner(library,session)
  if(!KINDS.has(a.relation))fail('INVALID_INPUT','关系必须是changed/corrected/disputed/contextual')
  for(const [k,n]of [['subject',80],['topic',100],['scope',100],['reason',500],['source_quote',160],['target_quote',160]])text(a[k],k,n)
  return this.store.tx(()=>{
   const from=this.active(library,a.id),to=this.active(library,a.target_id)
   if(from.id===to.id||!from.text.includes(a.source_quote)||!to.text.includes(a.target_quote))fail('INVALID_EVIDENCE','需要两条不同原文及各自的精确原句')
   if(['changed','corrected'].includes(a.relation)&&!laterThan(to,from))fail('INVALID_EVIDENCE','后来的变化依据不能早于被关联原话')
   const args=[library,a.subject,a.topic,a.scope]
   if(['changed','corrected'].includes(a.relation)&&this.store.db.prepare("WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT l.target FROM cm_claim_links l JOIN reach r ON r.id=l.source WHERE l.library=? AND l.subject=? AND l.topic=? AND l.scope=? AND l.kind IN ('changed','corrected') AND NOT EXISTS(SELECT 1 FROM cm_claim_link_retractions x WHERE x.id=l.id)) SELECT 1 FROM reach WHERE id=? LIMIT 1").get(to.id,...args,from.id))fail('INVALID_EVIDENCE','变化关系不能形成循环')
   const dedupe=hash([...args,a.relation,from.id,to.id,a.source_quote,a.target_quote]),prior=this.store.db.prepare('SELECT id FROM cm_claim_links WHERE dedupe=?').get(dedupe)
   if(prior)return {id:prior.id,duplicate:true,retracted:!!this.store.db.prepare('SELECT 1 FROM cm_claim_link_retractions WHERE id=?').get(prior.id)}
   const id=uuid();this.store.db.prepare('INSERT INTO cm_claim_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,library,session,a.relation,a.subject,a.topic,a.scope,from.id,to.id,a.source_quote,a.target_quote,a.reason,dedupe,this.store.now())
   this.store.log(library,'claim-link-recorded',{id,kind:a.relation,source:from.id,target:to.id,truth_verified:false});return {id,duplicate:false,truth_verified:false}
  })
 }
 retract(library,session,a){
  this.store.assertOwner(library,session);text(a.reason,'reason',500)
  return this.store.tx(()=>{
   const row=this.store.db.prepare('SELECT * FROM cm_claim_links WHERE library=? AND id=?').get(library,a.link_id);if(!row)fail('NOT_FOUND','本库没有这条关系')
   if(!Array.isArray(a.refs)||!a.refs.length||a.refs.length>3)fail('INVALID_EVIDENCE','撤销需1—3条后续原文依据')
   const refs=this.store.verifyRefs(library,a.refs);for(const id of refs){const r=this.active(library,id);if([row.source,row.target].includes(id)||!laterThan(r,this.active(library,row.target)))fail('INVALID_EVIDENCE','撤销需独立的后续依据')}
   const old=this.store.db.prepare('SELECT 1 FROM cm_claim_link_retractions WHERE id=?').get(row.id);if(old)return {id:row.id,retracted:true,duplicate:true}
   this.store.db.prepare('INSERT INTO cm_claim_link_retractions VALUES(?,?,?,?,?)').run(row.id,session,a.reason,JSON.stringify(refs),this.store.now())
   for(const id of refs)this.store.db.prepare('INSERT INTO cm_claim_retraction_refs VALUES(?,?)').run(row.id,id)
   this.store.log(library,'claim-link-retracted',{id:row.id,refs});return {id:row.id,retracted:true}
  })
 }
 /**
  * Stable keyset pagination over the relationships recorded for one endpoint.
  * The cursor is bound to the library and to the endpoint and to the last row served, so a page from
  * another library or another source is rejected instead of repeating the first page. Relationships
  * whose endpoint became unavailable, or whose named excerpts no longer match, are withheld;
  * retracted relationships stay listed with their evidence. Pagination and the summary's character
  * pagination are independent: this method never re-sends the summary.
  */
 relations(library,id,{cursor=null,limit=5}={}){
  integer(limit,'relation_limit',1,PAGE_LIMIT_MAX)
  const anchor=this.active(library,id).id,bound=cursor==null?null:this.boundary(library,anchor,cursor)
  const params=[library,anchor,anchor]
  if(bound)params.push(bound.time,bound.time,bound.id)
  const rows=this.store.db.prepare(`SELECT l.*,x.reason retraction_reason,x.refs retraction_refs,x.time retraction_time FROM cm_claim_links l LEFT JOIN cm_claim_link_retractions x ON x.id=l.id WHERE l.library=? AND (l.source=? OR l.target=?)${bound?' AND (l.time<? OR (l.time=? AND l.id<?))':''} ORDER BY l.time DESC,l.id DESC LIMIT ?`).all(...params,limit+1)
  const hasMore=rows.length>limit,page=rows.slice(0,limit),items=[],usable=new Map()
  const endpoint=rid=>{if(!usable.has(rid)){try{usable.set(rid,this.active(library,rid))}catch(e){if(!INACTIVE.has(e.code))throw e;usable.set(rid,null)}}return usable.get(rid)}
  const short=rid=>{try{return this.store.shortId(library,rid)}catch{return rid}}
  for(const row of page){
   const from=endpoint(row.source),to=endpoint(row.target)
   if(!from||!to||!from.text.includes(row.source_quote)||!to.text.includes(row.target_quote))continue
   const retraction=row.retraction_reason==null?null:{reason:row.retraction_reason,refs:JSON.parse(row.retraction_refs).map(short),time:new Date(row.retraction_time).toISOString()}
   items.push({id:row.id,kind:row.kind,source:short(row.source),target:short(row.target),subject:row.subject,topic:row.topic,scope:row.scope,before:row.source_quote,after:row.target_quote,reason:row.reason,time:new Date(row.time).toISOString(),retracted:!!retraction,retraction_reason:retraction?.reason??null,...(retraction?{retraction}:{})})
  }
  const last=page.at(-1)
  return {items,returned:items.length,has_more:hasMore,next_cursor:hasMore&&last?this.cursor(library,anchor,last):null,limit,recorded_total:this.store.db.prepare('SELECT count(*) n FROM cm_claim_links WHERE library=? AND (source=? OR target=?)').get(library,anchor,anchor).n,note:'按记录时间倒序的稳定游标；撤销关系保留依据，端点失效的不列出；游标只用于这份原文。'}
 }
 cursor(library,anchor,row){return Buffer.from(JSON.stringify({v:CURSOR_VERSION,l:library,a:anchor,t:row.time,r:row.id,c:cursorSignature(library,anchor,row.time,row.id)})).toString('base64url')}
 boundary(library,anchor,cursor){
  if(typeof cursor!=='string'||!cursor||cursor.length>600)fail('INVALID_CURSOR','关系游标无效，请从第一页重新读取')
  let raw,data
  try{raw=Buffer.from(cursor,'base64url').toString('utf8');data=JSON.parse(raw)}catch{fail('INVALID_CURSOR','关系游标无法解析，请从第一页重新读取')}
  if(Buffer.from(raw,'utf8').toString('base64url')!==cursor||!data||data.v!==CURSOR_VERSION||data.l!==library||data.a!==anchor||!Number.isSafeInteger(data.t)||typeof data.r!=='string'||data.c!==cursorSignature(library,anchor,data.t,data.r))fail('INVALID_CURSOR','关系游标不属于这份原文或已损坏，请从第一页重新读取')
  const row=this.store.db.prepare('SELECT time,source,target FROM cm_claim_links WHERE library=? AND id=?').get(library,data.r)
  if(!row||row.time!==data.t||(row.source!==anchor&&row.target!==anchor))fail('INVALID_CURSOR','关系游标已失效或不属于这份原文，请从第一页重新读取')
  return {time:row.time,id:data.r}
 }
 resolve(library,ids,{exclude=null,limit=2,detect=true}={}){
  integer(limit,'limit',1,5)
  const anchors=[...new Set(ids)].slice(0,20),valid=new Map(),get=id=>{try{if(!valid.has(id))valid.set(id,this.active(library,id,exclude));return valid.get(id)}catch(e){if(['NOT_FOUND','SOURCE_INACTIVE','CURRENT_TURN_EXCLUDED'].includes(e.code))return null;throw e}},groups=[];let truncated=false
  const add=g=>{if(!groups.some(p=>p.key===g.key))groups.push(g)}
  const short=id=>this.store.shortId(library,id)
  if(anchors.length){
   // Follow a bounded relationship neighborhood. Never silently present an intermediate update as final.
   let frontier=anchors;const seen=new Set(),links=[]
   for(let depth=0;depth<3&&frontier.length;depth++){
    const next=[]
    const rows=this.store.db.prepare("SELECT l.* FROM cm_claim_links l WHERE l.library=? AND NOT EXISTS(SELECT 1 FROM cm_claim_link_retractions x WHERE x.id=l.id) AND (l.source IN (SELECT value FROM json_each(?)) OR l.target IN (SELECT value FROM json_each(?))) ORDER BY l.time DESC,l.id LIMIT 41").all(library,JSON.stringify(frontier),JSON.stringify(frontier));if(rows.length>40)truncated=true
    for(const row of rows.slice(0,40)){
     if(seen.has(row.id))continue;seen.add(row.id);const from=get(row.source),to=get(row.target);if(!from||!to||!from.text.includes(row.source_quote)||!to.text.includes(row.target_quote))continue
     links.push(row);next.push(row.source,row.target)
    }
    const unique=[...new Set(next)];if(unique.length>40)truncated=true
    frontier=unique.slice(0,40)
   }
   for(const row of links)add({key:row.id,kind:row.kind,from:short(row.source),to:short(row.target),subject:clip(row.subject,24),topic:clip(row.topic,24),scope:clip(row.scope,24),before:clip(row.source_quote,24),after:clip(row.target_quote,24),time:get(row.target).time.slice(0,10),basis:'attributed-link'})
   // The walk reads successors directly, so a chain longer than the discovery bound is reported as
   // unfinished instead of ending quietly on an intermediate node. Only returned groups are walked.
   for(const g of groups.slice(0,limit)){
    const first=links.find(r=>r.id===g.key);if(!first||!CHANGES.has(first.kind))continue
    // Successors are read directly and invalid rows are filtered before choosing, so an unusable
    // neighbour cannot hide an older valid continuation. A capped read is never reported as terminal.
    const outgoing=node=>{const rows=this.store.db.prepare("SELECT l.* FROM cm_claim_links l WHERE l.library=? AND l.source=? AND l.subject=? AND l.topic=? AND l.scope=? AND l.kind IN ('changed','corrected') AND NOT EXISTS(SELECT 1 FROM cm_claim_link_retractions x WHERE x.id=l.id) ORDER BY l.time DESC,l.id LIMIT 33").all(library,node,first.subject,first.topic,first.scope)
     return {rows,complete:rows.length<33,usable:rows.filter(row=>{const from=get(row.source),to=get(row.target);return !!from&&!!to&&from.text.includes(row.source_quote)&&to.text.includes(row.target_quote)})}}
    let end=first,seenPath=new Set([first.source,first.target]),steps=0,stopped=false
    // Two changes leaving the same node are a branch: no single successor may be presented as final.
    if(outgoing(first.source).usable.length>1){g.kind='disputed';g.branching=true;truncated=true;stopped=true}
    for(;!stopped&&steps<8;steps++){
     const {rows,usable,complete}=outgoing(end.target)
     if(usable.length>1||seenPath.has(usable[0]?.target)){g.kind='disputed';g.branching=true;truncated=true;stopped=true;break}
     if(!usable.length){if(rows.length){g.intermediate=true;truncated=true;stopped=true}break}
     end=usable[0];seenPath.add(end.target);g.to=short(end.target);g.after=clip(end.target_quote,24);g.time=get(end.target).time.slice(0,10);g.chain=true
     if(!complete){g.intermediate=true;truncated=true;stopped=true}
    }
    if(!stopped&&steps===8&&outgoing(end.target).rows.length){g.intermediate=true;truncated=true}
   }
   // Accepted versions already express a decision; attach both versions when either source is found.
   // The revision the retrieved source actually supports is looked up directly, so a long accepted
   // history cannot hide that version behind a window of only the newest revisions.
   const keys=this.store.db.prepare('SELECT DISTINCT e.key FROM entries e,json_each(e.refs) j WHERE e.library=? AND j.value IN (SELECT value FROM json_each(?)) ORDER BY e.time DESC,e.key LIMIT 21').all(library,JSON.stringify(anchors))
   if(keys.length>20)truncated=true
   for(const {key}of keys.slice(0,20)){
    const current=this.store.db.prepare('SELECT * FROM entries WHERE library=? AND key=? AND accepted=1 ORDER BY revision DESC LIMIT 1').get(library,key)
    if(!current||current.expires!==null&&current.expires<=this.store.now())continue
    const nowRefs=JSON.parse(current.refs),usable=e=>JSON.parse(e.refs).every(id=>!!get(id))
    if(!usable(current))continue
    const matched=this.store.db.prepare('SELECT e.* FROM entries e WHERE e.library=? AND e.key=? AND e.accepted=1 AND EXISTS(SELECT 1 FROM json_each(e.refs) j WHERE j.value IN (SELECT value FROM json_each(?))) ORDER BY e.revision DESC LIMIT 1').get(library,key,JSON.stringify(anchors))
    let prior=null
    if(matched&&matched.revision!==current.revision&&usable(matched)&&bodyKey(matched.body)!==bodyKey(current.body))prior=matched
    if(!prior&&nowRefs.some(id=>anchors.includes(id))){
     const rows=this.store.db.prepare('SELECT * FROM entries WHERE library=? AND key=? AND accepted=1 AND revision<? ORDER BY revision DESC LIMIT 64').all(library,key,current.revision)
     prior=rows.find(e=>usable(e)&&bodyKey(e.body)!==bodyKey(current.body))||null
     if(!prior&&this.store.db.prepare('SELECT count(*) n FROM entries WHERE library=? AND key=? AND accepted=1 AND revision<?').get(library,key,current.revision).n>64)truncated=true
    }
    if(!prior)continue
    add({key:'state:'+key,kind:'state-revision',from:short(JSON.parse(prior.refs)[0]),to:short(nowRefs[0]),topic:clip(key,24),before:clip(prior.body,30),after:clip(current.body,30),time:new Date(this.history.acceptedAt(current).time).toISOString().slice(0,10),basis:'accepted-state-not-verified-fact'})
   }
  }
  // A deliberately narrow, same-speaker opposite-preference cue. It raises a question, never a verdict.
  if(detect&&groups.length<limit){
   const records=anchors.map(get).filter(Boolean)
   for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
    let a=records[i],b=records[j];if(!actor(a)||actor(a)!==actor(b))continue
    if(a.time>b.time||a.time===b.time&&a.seq>b.seq)[a,b]=[b,a]
    if(groups.some(g=>[g.from,g.to].includes(short(a.id))&&[g.from,g.to].includes(short(b.id))))continue
    for(const pa of polarity(a))for(const pb of polarity(b))if(pa.topic&&pa.topic===pb.topic&&pa.negative!==pb.negative)add({key:'possible:'+hash([a.id,b.id,pa.topic]),kind:'possible-conflict',from:short(a.id),to:short(b.id),topic:clip(pa.topic,24),before:clip(pa.quote,24),after:clip(pb.quote,24),basis:'literal-cue-unresolved'})
   }
  }
  return {groups:groups.slice(0,limit).map(({key,...g})=>({...g,link:key})),more:truncated||groups.length>limit,note:'关联不认证事实。before/after保留前后依据；disputed/possible-conflict不二选一；contextual区分情境。more需link-status继续核对，不把中间节点当最终现在。'}
 }
 status(library,id,{limit=5}={}){
  const r=this.active(library,id),resolved=this.resolve(library,[r.id],{limit:5,detect:false}),page=this.relations(library,r.id,{limit})
  return {...resolved,links:page.items,relation_page:page,more:resolved.more||page.has_more}
 }
}
