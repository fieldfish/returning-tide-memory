import {uuid,hash,text,integer,clip,fail} from './util.mjs'
import {activeSource,excludedSource} from './source-position.mjs'
import {StateHistory} from './state-history.mjs'
const KINDS=new Set(['changed','corrected','disputed','contextual'])
const origin=r=>typeof r.origin==='string'?JSON.parse(r.origin):r.origin||{}
const actor=r=>{const o=origin(r);return ['user','assistant'].includes(r.role)?[r.role,o.sender_id??o.user_id??(r.role==='user'?r.session:'model')].join(':'):null}
const norm=s=>s.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase()
const polarity=r=>[...r.text.matchAll(/我(?:现在|以前|今天|曾经)?(不再|不)?喜欢([^。！？!?\n]{1,24})/gu)].map(m=>({topic:norm(m[2].replace(/[了的呀啊呢吧]+$/u,'')),negative:!!m[1],quote:m[0]}))

/** Attributed claim relationships. Sources remain immutable; chronology alone never proves truth. */
export class ClaimLinks{
 constructor(store){
  this.store=store;this.history=new StateHistory(store)
  store.db.exec(`CREATE TABLE IF NOT EXISTS cm_claim_links(id TEXT PRIMARY KEY,library TEXT NOT NULL,session TEXT NOT NULL,kind TEXT NOT NULL,subject TEXT NOT NULL,topic TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,source_quote TEXT NOT NULL,target_quote TEXT NOT NULL,reason TEXT NOT NULL,dedupe TEXT NOT NULL UNIQUE,time INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS cm_claim_link_source ON cm_claim_links(library,source);
   CREATE INDEX IF NOT EXISTS cm_claim_link_target ON cm_claim_links(library,target);
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
   if(['changed','corrected'].includes(a.relation)&&(Date.parse(to.time)<Date.parse(from.time)||to.session===from.session&&to.seq<=from.seq))fail('INVALID_EVIDENCE','后来的变化依据不能早于被关联原话')
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
   const refs=this.store.verifyRefs(library,a.refs);for(const id of refs){const r=this.active(library,id);if([row.source,row.target].includes(id)||Date.parse(r.time)<Date.parse(this.active(library,row.target).time))fail('INVALID_EVIDENCE','撤销需独立的后续依据')}
   const old=this.store.db.prepare('SELECT 1 FROM cm_claim_link_retractions WHERE id=?').get(row.id);if(old)return {id:row.id,retracted:true,duplicate:true}
   this.store.db.prepare('INSERT INTO cm_claim_link_retractions VALUES(?,?,?,?,?)').run(row.id,session,a.reason,JSON.stringify(refs),this.store.now())
   for(const id of refs)this.store.db.prepare('INSERT INTO cm_claim_retraction_refs VALUES(?,?)').run(row.id,id)
   this.store.log(library,'claim-link-retracted',{id:row.id,refs});return {id:row.id,retracted:true}
  })
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
    if(next.length>40||depth===2&&next.length)truncated=true
    frontier=[...new Set(next)].slice(0,40)
   }
   for(const row of links)add({key:row.id,kind:row.kind,from:short(row.source),to:short(row.target),subject:clip(row.subject,24),topic:clip(row.topic,24),scope:clip(row.scope,24),before:clip(row.source_quote,24),after:clip(row.target_quote,24),time:get(row.target).time.slice(0,10),basis:'attributed-link'})
   for(const g of groups){
    const first=links.find(r=>r.id===g.key);if(!first||!['changed','corrected'].includes(first.kind))continue
    if(links.filter(r=>r.source===first.source&&r.subject===first.subject&&r.topic===first.topic&&r.scope===first.scope&&['changed','corrected'].includes(r.kind)).length>1){g.kind='disputed';g.branching=true;continue}
    let end=first;const seenPath=new Set([first.source,first.target])
    for(let n=0;n<8;n++){
     const next=links.filter(r=>r.source===end.target&&r.subject===first.subject&&r.topic===first.topic&&r.scope===first.scope&&['changed','corrected'].includes(r.kind))
     if(next.length>1){g.kind='disputed';g.branching=true;break}
     if(!next.length)break
     if(seenPath.has(next[0].target)){g.kind='disputed';g.branching=true;break}
     end=next[0];seenPath.add(end.target);g.to=short(end.target);g.after=clip(end.target_quote,24);g.time=get(end.target).time.slice(0,10);g.chain=true
    }
   }
   // Accepted versions already express a decision; attach both versions when either source is found.
   const keys=this.store.db.prepare('SELECT DISTINCT e.key FROM entries e,json_each(e.refs) j WHERE e.library=? AND j.value IN (SELECT value FROM json_each(?)) LIMIT 20').all(library,JSON.stringify(anchors))
   for(const {key}of keys){
    const entries=this.store.db.prepare('SELECT * FROM entries WHERE library=? AND key=? AND accepted=1 ORDER BY revision DESC LIMIT 65').all(library,key),current=entries[0]
    if(entries.length>64)truncated=true
    if(!current||current.expires!==null&&current.expires<=this.store.now())continue
    const usable=e=>JSON.parse(e.refs).every(id=>!!get(id)),nowRefs=JSON.parse(current.refs);if(!usable(current))continue
    const prior=entries.slice(1).find(e=>usable(e)&&norm(e.body)!==norm(current.body)&&(nowRefs.some(id=>anchors.includes(id))||JSON.parse(e.refs).some(id=>anchors.includes(id))))
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
 status(library,id){
  const r=this.active(library,id),resolved=this.resolve(library,[r.id],{limit:5,detect:false})
  const rows=this.store.db.prepare('SELECT l.*,x.reason AS retraction_reason,x.refs AS retraction_refs FROM cm_claim_links l LEFT JOIN cm_claim_link_retractions x ON x.id=l.id WHERE l.library=? AND (l.source=? OR l.target=?) ORDER BY l.time DESC,l.id LIMIT 21').all(library,r.id,r.id)
  return {...resolved,links:rows.slice(0,20).map(row=>({...row,dedupe:undefined})),more:resolved.more||rows.length>20}
 }
}
