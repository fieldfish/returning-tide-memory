import {uuid,hash,text,integer,fail,clip} from './util.mjs'

const SLOTS=new Set(['background','goal','progress','question','self-report','interpretation','source-claim'])
const MODES=new Set(['unknown','experience','creative','mixed'])
const STATES=new Set(['active','paused','closed'])
const length=s=>Array.from(s).length

/** Versioned projections of immutable sources. Associations never rewrite records. */
export class Situations {
  constructor(store,scenes){
    this.store=store;this.scenes=scenes
    store.tx(()=>store.db.exec([
      'CREATE TABLE IF NOT EXISTS cm_situations(id TEXT PRIMARY KEY,library TEXT NOT NULL REFERENCES libraries(id),revision INTEGER NOT NULL,created INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS cm_situations_library ON cm_situations(library)',
      'CREATE TABLE IF NOT EXISTS cm_situation_versions(situation TEXT NOT NULL REFERENCES cm_situations(id),revision INTEGER NOT NULL,document TEXT NOT NULL,refs TEXT NOT NULL,reason TEXT NOT NULL,recorded INTEGER NOT NULL,PRIMARY KEY(situation,revision))',
      'CREATE TABLE IF NOT EXISTS cm_situation_sources(situation TEXT NOT NULL REFERENCES cm_situations(id),rid TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,kind TEXT NOT NULL,recorded INTEGER NOT NULL,PRIMARY KEY(situation,rid))',
      'CREATE TABLE IF NOT EXISTS cm_situation_focus(library TEXT NOT NULL,session TEXT NOT NULL,situation TEXT,PRIMARY KEY(library,session))',
      'CREATE TABLE IF NOT EXISTS cm_situation_relations(id TEXT PRIMARY KEY,library TEXT NOT NULL,left_id TEXT NOT NULL REFERENCES cm_situations(id),right_id TEXT NOT NULL REFERENCES cm_situations(id),kind TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER NOT NULL,refs TEXT NOT NULL,reason TEXT NOT NULL,left_revision INTEGER NOT NULL,right_revision INTEGER NOT NULL,time INTEGER NOT NULL)'
    ].join(';')))
  }
  row(library,id){
    text(id,'id',80)
    const r=this.store.db.prepare('SELECT * FROM cm_situations WHERE library=? AND id=?').get(library,id)
    if(!r)fail('NOT_FOUND','本库没有这个情境')
    return r
  }
  canonicalRefs(library,refs){return this.store.verifyRefs(library,refs).map(id=>this.scenes.active(library,id).id)}
  available(library,refs){return refs.every(id=>{try{this.scenes.active(library,id);return true}catch(e){if(['NOT_FOUND','SOURCE_INACTIVE'].includes(e.code))return false;throw e}})}
  assertions(library,values,origin='explicit'){
    if(!['explicit','model-consolidated'].includes(origin))fail('INVALID_INPUT','未知整理来源')
    if(!Array.isArray(values)||values.length>30)fail('INVALID_INPUT','每次最多追加30条有出处的表述')
    return values.map(a=>{
      if(!a||typeof a!=='object'||!SLOTS.has(a.slot))fail('INVALID_INPUT','未知表述类别')
      const body=text(a.body,'body',1000),refs=this.canonicalRefs(library,a.refs)
      if(a.event_time!=null&&(typeof a.event_time!=='string'||!Number.isFinite(Date.parse(a.event_time))))fail('INVALID_INPUT','event_time须为带时区的有效时间或省略')
      if(a.event_time!=null&&!/(Z|[+-]\d\d:\d\d)$/.test(a.event_time))fail('INVALID_INPUT','event_time需明确时区')
      const event_time=a.event_time?new Date(a.event_time).toISOString():null
      const attributed_to=a.attributed_to==null?null:text(a.attributed_to,'attributed_to',120)
      const id=hash([a.slot,body,refs,event_time,attributed_to]).slice(0,20)
      return {id,slot:a.slot,body,refs,event_time,attributed_to,interpreted_at:this.store.now(),origin}
    })
  }
  rawVersion(library,id,revision=null){
    const s=this.row(library,id);if(revision!=null)integer(revision,'revision',1)
    const r=this.store.db.prepare('SELECT * FROM cm_situation_versions WHERE situation=? AND revision=?').get(id,revision??s.revision)
    if(!r)fail('NOT_FOUND','情境版本不存在')
    return {...r,document:JSON.parse(r.document),refs:JSON.parse(r.refs),created:s.created,library}
  }
  get(library,id,{revision=null,at=null}={}){
    if(at!=null){
      if(typeof at!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(at)||!Number.isFinite(Date.parse(at)))fail('INVALID_INPUT','at需为含时区时间')
      if(Date.parse(at)>this.store.now())fail('INVALID_INPUT','at不能是未来时点')
      this.row(library,id)
      const r=this.store.db.prepare('SELECT revision FROM cm_situation_versions WHERE situation=? AND recorded<=? ORDER BY revision DESC LIMIT 1').get(id,Date.parse(at))
      if(!r)fail('NOT_FOUND','该记录时间之前尚无这个情境版本')
      revision=r.revision
    }
    const v=this.rawVersion(library,id,revision),d=v.document,validTitle=this.available(library,d.title_refs)
    const assertions=d.assertions.filter(a=>this.available(library,a.refs))
    return {id,revision:v.revision,recorded_at:v.recorded,created_at:v.created,title:validTitle?d.title:'[标题出处已移除]',status:d.status,mode:d.mode,
      assertions,omitted_assertions:d.assertions.length-assertions.length,refs:v.refs.filter(r=>this.available(library,[r])),
      source_count:this.store.db.prepare('SELECT count(*) n FROM cm_situation_sources WHERE situation=?').get(id).n,
      note:'情境整理及自述，含记录时间；event_time是所述事情的时间。interpretation为解读，不能冒充当时原话。'}
  }
  commit(library,id,revision,document,refs,reason){
    const now=this.store.now()
    this.store.db.prepare('INSERT INTO cm_situation_versions VALUES(?,?,?,?,?,?)').run(id,revision,JSON.stringify(document),JSON.stringify(refs),reason,now)
    this.store.db.prepare('UPDATE cm_situations SET revision=? WHERE id=?').run(revision,id)
    for(const rid of refs)this.store.db.prepare('INSERT OR IGNORE INTO cm_situation_sources VALUES(?,?,?,?)').run(id,rid,'explicit',now)
    this.store.log(library,'situation-version',{id,revision,refs,reason:clip(reason,160)})
    return this.get(library,id)
  }
  create(library,session,{title,refs,mode='unknown',assertions=[],assertion_origin='explicit'}){
    this.store.assertOwner(library,session);title=text(title,'title',160)
    if(!MODES.has(mode))fail('INVALID_INPUT','未知情境模式')
    refs=this.canonicalRefs(library,refs);const items=this.assertions(library,assertions,assertion_origin),id=uuid()
    const all=[...new Set([...refs,...items.flatMap(a=>a.refs)])]
    return this.store.tx(()=>{
      this.store.db.prepare('INSERT INTO cm_situations VALUES(?,?,?,?)').run(id,library,1,this.store.now())
      return this.commit(library,id,1,{title,title_refs:refs,status:'active',mode,assertions:items},all,'created')
    })
  }
  revise(library,session,id,{expected_revision,title,status,mode,append_assertions=[],refs,reason,assertion_origin='explicit'}){
    this.store.assertOwner(library,session);integer(expected_revision,'expected_revision',1)
    reason=text(reason,'reason',1000);refs=this.canonicalRefs(library,refs)
    const additions=this.assertions(library,append_assertions,assertion_origin)
    return this.store.tx(()=>{
      const row=this.row(library,id);if(row.revision!==expected_revision)fail('CONFLICT','情境已更新，请先读取')
      const prior=this.rawVersion(library,id).document,d={...prior,assertions:[...prior.assertions]}
      if(title!=null){d.title=text(title,'title',160);d.title_refs=refs}
      if(status!=null){if(!STATES.has(status))fail('INVALID_INPUT','未知情境状态');d.status=status}
      if(mode!=null){if(!MODES.has(mode))fail('INVALID_INPUT','未知情境模式');d.mode=mode}
      for(const a of additions)if(!d.assertions.some(v=>v.id===a.id))d.assertions.push(a)
      if(d.assertions.length>200)fail('SITUATION_CAPACITY','该情境表述已达200条；请分成有引用的子情境，旧版本保留')
      const result=this.commit(library,id,row.revision+1,d,[...new Set([...refs,...additions.flatMap(a=>a.refs)])],reason)
      if(d.status!=='active')this.store.db.prepare('UPDATE cm_situation_focus SET situation=NULL WHERE library=? AND situation=?').run(library,id)
      return result
    })
  }
  attach(library,session,id,refs,{kind='source'}={}){
    this.store.assertOwner(library,session);this.row(library,id);refs=this.canonicalRefs(library,refs)
    if(!['source','creative','self-report','interpretation','observation'].includes(kind))fail('INVALID_INPUT','未知来源关联')
    return this.store.tx(()=>{
      for(const rid of refs)this.store.db.prepare('INSERT INTO cm_situation_sources VALUES(?,?,?,?) ON CONFLICT(situation,rid) DO UPDATE SET kind=excluded.kind').run(id,rid,kind,this.store.now())
      this.store.log(library,'situation-sources',{id,refs,kind})
      return {id,attached:refs.length}
    })
  }
  focus(library,session,id){
    this.store.assertOwner(library,session)
    if(id!==null){const d=this.get(library,id);if(d.status!=='active')fail('SITUATION_NOT_ACTIVE','暂停或结束的情境需明确更新后再设为当前')}
    this.store.db.prepare('INSERT INTO cm_situation_focus VALUES(?,?,?) ON CONFLICT(library,session) DO UPDATE SET situation=excluded.situation').run(library,session,id)
    this.store.log(library,'situation-focus',{session,id});return {id}
  }
  focused(library,session){
    if(this.store.library(library).owner!==session)return null
    let cursor=session,r=null;const visited=new Set()
    while(cursor&&!visited.has(cursor)){
      visited.add(cursor);r=this.store.db.prepare('SELECT situation FROM cm_situation_focus WHERE library=? AND session=?').get(library,cursor)
      if(r)break
      const binding=this.store.binding(cursor);cursor=binding?.library===library?binding.previous:null
    }
    if(!r?.situation)return null
    const active=this.store.db.prepare("SELECT s.id FROM cm_situations s JOIN cm_situation_versions v ON v.situation=s.id AND v.revision=s.revision WHERE s.library=? AND s.id=? AND json_extract(v.document,'$.status')='active'").get(library,r.situation)
    return active?.id||null
  }
  current(library,session){const id=this.focused(library,session);return id?this.get(library,id):null}
  handoff(library,from,to,expectedRevision){
    return this.store.tx(()=>{
      const focus=this.current(library,from),lib=this.store.transfer(library,from,to,expectedRevision)
      this.store.db.prepare('INSERT INTO cm_situation_focus VALUES(?,?,?) ON CONFLICT(library,session) DO UPDATE SET situation=excluded.situation').run(library,to,focus?.id||null)
      return lib
    })
  }
  observe(library,session,rid){
    const id=this.focused(library,session);if(!id)return {attached:false}
    const r=this.scenes.active(library,rid)
    this.store.db.prepare('INSERT OR IGNORE INTO cm_situation_sources VALUES(?,?,?,?)').run(id,r.id,'context-association',this.store.now())
    return {attached:true,id}
  }
  list(library,{offset=0,limit=5}={}){
    this.store.library(library);integer(offset,'offset');integer(limit,'limit',1,10)
    const rows=this.store.db.prepare('SELECT id FROM cm_situations WHERE library=? ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?').all(library,limit,offset)
    const total=this.store.db.prepare('SELECT count(*) n FROM cm_situations WHERE library=?').get(library).n
    return {items:rows.map(r=>{const s=this.get(library,r.id);return {id:s.id,title:clip(s.title,40),revision:s.revision,status:s.status,mode:s.mode,source_count:s.source_count}}),total,next_offset:offset+rows.length<total?offset+rows.length:null}
  }
  timeline(library,id,{before_revision=null,limit=5}={}){
    const current=this.row(library,id);integer(limit,'limit',1,10)
    if(before_revision!=null)integer(before_revision,'before_revision',1)
    const rows=this.store.db.prepare('SELECT revision,recorded,reason,refs FROM cm_situation_versions WHERE situation=? AND revision<? ORDER BY revision DESC LIMIT ?').all(id,before_revision??current.revision+1,limit+1)
    const more=rows.length>limit;rows.length=Math.min(rows.length,limit)
    return {id,current_revision:current.revision,versions:rows.map(({refs,...r})=>({...r,reason:this.available(library,JSON.parse(refs))?clip(r.reason,160):'[依据出处已移除]'})),next_before_revision:more?rows.at(-1).revision:null}
  }
  related(library,refs,limit=3){
    integer(limit,'limit',1,5);const canonical=this.canonicalRefs(library,refs)
    const rows=this.store.db.prepare('SELECT s.id,count(*) hits FROM cm_situations s JOIN cm_situation_sources x ON x.situation=s.id WHERE s.library=? AND x.rid IN ('+canonical.map(()=>'?').join(',')+') GROUP BY s.id ORDER BY hits DESC,s.created DESC LIMIT ?').all(library,...canonical,limit)
    return rows.map(r=>({id:r.id,hits:r.hits,...this.get(library,r.id)}))
  }
  link(library,session,left,right,{kind='possible',expected_revision,expected_target_revision,refs,reason}){
    this.store.assertOwner(library,session);if(!['possible','related','merged','part-of'].includes(kind)||left===right)fail('INVALID_INPUT','关系类型或两端不正确')
    integer(expected_revision,'expected_revision',1);integer(expected_target_revision,'expected_target_revision',1)
    refs=this.canonicalRefs(library,refs);reason=text(reason,'reason',1000)
    return this.store.tx(()=>{
      const a=this.row(library,left),b=this.row(library,right)
      if(a.revision!==expected_revision||b.revision!==expected_target_revision)fail('CONFLICT','关系两端版本变化')
      if(kind==='part-of'&&this.store.db.prepare("WITH RECURSIVE parents(id) AS (SELECT right_id FROM cm_situation_relations WHERE library=? AND left_id=? AND kind='part-of' AND active=1 UNION SELECT r.right_id FROM cm_situation_relations r JOIN parents p ON r.left_id=p.id WHERE r.library=? AND r.kind='part-of' AND r.active=1) SELECT 1 FROM parents WHERE id=?").get(library,right,library,left))fail('RELATION_CYCLE','子情境不能形成循环')
      if(this.store.db.prepare('SELECT 1 FROM cm_situation_relations WHERE library=? AND active=1 AND kind=? AND ((left_id=? AND right_id=?) OR (left_id=? AND right_id=?))').get(library,kind,left,right,right,left))fail('CONFLICT','关系已存在')
      const id=uuid()
      this.store.db.prepare('INSERT INTO cm_situation_relations VALUES(?,?,?,?,?,1,1,?,?,?,?,?)').run(id,library,left,right,kind,JSON.stringify(refs),reason,a.revision,b.revision,this.store.now())
      this.store.log(library,'situation-linked',{id,left,right,kind,refs});return {id,left,right,kind,revision:1,active:true}
    })
  }
  unlink(library,session,id,expected_revision){
    this.store.assertOwner(library,session)
    text(id,'id',80);integer(expected_revision,'expected_revision',1)
    return this.store.tx(()=>{
      const r=this.store.db.prepare('SELECT * FROM cm_situation_relations WHERE library=? AND id=?').get(library,id)
      if(!r)fail('NOT_FOUND','关系不存在')
      if(r.revision!==expected_revision||!r.active)fail('CONFLICT','关系已改变')
      if(r.kind==='merged'&&(this.row(library,r.left_id).revision!==r.left_revision||this.row(library,r.right_id).revision!==r.right_revision))fail('MERGE_HAS_LATER_CHANGES','合并后有新版本，需核对依赖后再拆分；未删除任何经历')
      this.store.db.prepare('UPDATE cm_situation_relations SET active=0,revision=revision+1 WHERE id=?').run(id)
      this.store.log(library,'situation-unlinked',{id,prior:r.revision});return {id,revision:r.revision+1,active:false}
    })
  }
  relations(library,id){
    this.row(library,id)
    return this.store.db.prepare('SELECT id,left_id,right_id,kind,revision,active,refs FROM cm_situation_relations WHERE library=? AND (left_id=? OR right_id=?) ORDER BY time DESC LIMIT 20').all(library,id,id).map(r=>({...r,refs:JSON.parse(r.refs)}))
  }
  capsule(library,id,{maxChars=650,revision=null}={}){
    integer(maxChars,'maxChars',350,3000);const d=this.get(library,id,{revision})
    const out={id:d.id,revision:d.revision,title:clip(d.title,45),status:d.status,mode:d.mode,recorded_at:d.recorded_at,statements:[],source_count:d.source_count,omitted:d.omitted_assertions}
    for(const a of [...d.assertions].reverse()){
      const item={slot:a.slot,body:clip(a.body,150),refs:a.refs.slice(0,2).map(r=>this.store.shortId(library,r)),event_time:a.event_time,interpreted_at:a.interpreted_at,origin:a.origin||'explicit',...(a.attributed_to?{attributed_to:clip(a.attributed_to,60)}:{})}
      out.statements.push(item);if(length(JSON.stringify(out))>maxChars){out.statements.pop();out.omitted++}
    }
    if(length(JSON.stringify(out))>maxChars)out.title=clip(out.title,10)
    if(length(JSON.stringify(out))>maxChars)fail('CONTEXT_BUDGET','情境元数据超过预算')
    return out
  }
}

