import {fail,integer,hash} from './util.mjs'
import {sourceAvailabilitySQL,activitySourceText} from './source-position.mjs'

/** Monotonic ingestion positions are independent of reusable SQLite rowids. */
export class SourceLog {
  constructor(store){
    this.store=store
    store.tx(()=>{
      store.db.exec(`CREATE TABLE IF NOT EXISTS cm_ingest_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,library TEXT NOT NULL,rid TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS cm_ingest_library ON cm_ingest_log(library,seq);
        CREATE TABLE IF NOT EXISTS cm_ingest_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS cm_record_ingested AFTER INSERT ON records BEGIN INSERT INTO cm_ingest_log(library,rid) VALUES(new.library,new.id); END;
        INSERT INTO cm_ingest_log(library,rid) SELECT r.library,r.id FROM records r LEFT JOIN cm_ingest_log i ON i.rid=r.id WHERE i.rid IS NULL ORDER BY r.rowid;`)
      if(!store.db.prepare("SELECT 1 FROM cm_ingest_meta WHERE name='extraction-cursor-v1'").get()){
        store.db.exec("UPDATE extraction SET cursor=COALESCE((SELECT MAX(i.seq) FROM cm_ingest_log i JOIN records r ON r.id=i.rid WHERE i.library=extraction.library AND r.rowid<=extraction.cursor),0);INSERT INTO cm_ingest_meta VALUES('extraction-cursor-v1','done')")
      }
    })
  }
  rows(library,cursor,limit=200){
    return [...this.iterate(library,cursor,limit)]
  }
  iterate(library,cursor,limit=200){
    integer(cursor,'cursor');integer(limit,'limit',1,200)
    const legacy=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_legacy_notes'").get()
    const activities=!!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_payloads'").get()
    return this.store.db.prepare('SELECT i.seq cursor,r.*'+(activities?',ap.payload activity_payload,ap.digest activity_digest':'')+' FROM cm_ingest_log i JOIN records r ON r.id=i.rid '+(legacy?'LEFT JOIN cm_legacy_notes x ON x.library=r.library AND x.rid=r.id ':'')+(activities?'LEFT JOIN cm_activity_payloads ap ON ap.rid=r.id ':'')+'WHERE i.library=? AND i.seq>? '+(legacy?'AND (x.rid IS NULL OR x.active=1) ':'')+'AND '+sourceAvailabilitySQL(this.store)+' ORDER BY i.seq LIMIT ?').iterate(library,cursor,limit)
  }
  hasNew(library,cursor){return this.rows(library,cursor,1).length>0}
}

export function sourceBatch(log,library,{cursor=0,progress=null,system,known=[],maxInputChars,limit=200}){
  const rows=log.iterate(library,cursor,limit),records=[];let nextCursor=cursor,nextProgress=null
  const fits=part=>system.length+JSON.stringify({known,records:[...records,part]}).length<=maxInputChars
  for(const r of rows){
    const rawContinuation=progress?.rid===r.id&&progress.digest===r.digest
    const projected=!rawContinuation&&r.activity_payload&&r.activity_payload!==r.text,source=projected?activitySourceText(r.text,r.activity_payload):r.text,digest=projected?hash([r.digest,r.activity_digest]):r.digest
    if(progress?.rid===r.id&&progress.digest!==digest)fail('SOURCE_CHANGED','待续整理原文摘要变化，未跳过')
    const chars=Array.from(source),offset=progress?.rid===r.id?progress.offset:0,start=Math.max(0,offset-64)
    integer(offset,'progress.offset',0,chars.length)
    const base={id:r.id,role:r.role,time:r.time,origin:JSON.parse(r.origin),maintenance_report:r.role==='assistant'&&/cm_(self|library|checkpoint|evidence|situation)|expected_revision|accepted\s*[=:]|候选.{0,20}(认可|确认)|接续成功|库已接续/.test(r.text),...(r.type?.startsWith('activity/')||r.type==='tool/call'?{record_type:r.type,evidence_scope:r.type==='tool/call'?'tool-request-not-completion':r.type==='activity/observation'?'reported-observation':'host-task-node'}:{})}
    const part=end=>({...base,...(projected?{range_basis:'raw-plus-structured-tool-view',original_text_chars:Array.from(r.text).length,structured_read:'cm_activity read'}:{}),fragment:start>0||end<chars.length,range:[start,end],total_chars:chars.length,text:chars.slice(start,end).join('')})
    if(fits(part(chars.length))){records.push(part(chars.length));nextCursor=r.cursor;continue}
    let lo=offset,hi=chars.length
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(fits(part(mid)))lo=mid;else hi=mid-1}
    if(lo<=offset){if(records.length)break;fail('INPUT_BUDGET_TOO_SMALL','预算容不下元数据和一个新字符；未跳过原文')}
    records.push(part(lo));nextProgress={rid:r.id,offset:lo,digest};break
  }
  return {records,cursor:nextCursor,progress:nextProgress}
}
