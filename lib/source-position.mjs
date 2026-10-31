import {fail} from './util.mjs'

/** Synthetic reports retain their native turn position instead of becoming false history. */
export function sourcePosition(record){
  const origin=typeof record.origin==='string'?JSON.parse(record.origin):record.origin||{}
  if(origin.kind==='activity-report'&&origin.position_verified===true){
    if(typeof origin.native_session!=='string'||!origin.native_session||!Number.isSafeInteger(origin.native_seq)||origin.native_seq<0)fail('INVALID_SOURCE_POSITION','活动记录的原生位置无效')
    return {session:origin.native_session,seq:origin.native_seq}
  }
  return {session:record.session,seq:record.seq}
}
export const excludedSource=(record,exclude)=>{if(!exclude)return false;const position=sourcePosition(record);return position.session===exclude.session&&position.seq>=exclude.fromSeq}
export const activitySourceText=(raw,payload)=>payload&&payload!==raw?payload+'\n【同一工具事件的原始正文；上述正文引用另读原文】\n'+raw:raw

export function sourceAncestors(store,library,rid){
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_reports'").get())return []
  if(!store.db.prepare('SELECT 1 FROM cm_activity_reports WHERE library=? AND rid=?').get(library,rid))return []
  return store.db.prepare('WITH RECURSIVE parents(id) AS (SELECT ? UNION SELECT f.rid FROM cm_activity_reports p JOIN cm_activity_report_refs f ON f.report=p.seq JOIN parents a ON a.id=p.rid WHERE p.library=?) SELECT id FROM parents WHERE id!=?').all(rid,library,rid).map(r=>r.id)
}
export function dependentRecords(store,library,rid){
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_reports'").get())return [rid]
  return store.db.prepare('WITH RECURSIVE affected(id) AS (SELECT ? UNION SELECT p.rid FROM cm_activity_reports p JOIN cm_activity_report_refs f ON f.report=p.seq JOIN affected a ON a.id=f.rid WHERE p.library=? AND p.rid IS NOT NULL) SELECT id FROM affected').all(rid,library).map(r=>r.id)
}
export function sourceAvailabilitySQL(store,alias='r'){
  if(!/^[a-z][a-z0-9_]*$/i.test(alias))fail('INVALID_INPUT','来源表别名无效')
  const legacy=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_legacy_notes'").get()
  const direct=legacy?`NOT EXISTS(SELECT 1 FROM cm_legacy_notes af WHERE af.library=${alias}.library AND af.rid=${alias}.id AND af.active=0)`:'1'
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_reports'").get())return direct
  const graph=`NOT EXISTS(WITH RECURSIVE parents(id) AS (SELECT ${alias}.id UNION SELECT f.rid FROM cm_activity_reports ap JOIN cm_activity_report_refs f ON f.report=ap.seq JOIN parents a ON a.id=ap.rid WHERE ap.library=${alias}.library) SELECT 1 FROM parents a LEFT JOIN records ar ON ar.library=${alias}.library AND ar.id=a.id WHERE ar.id IS NULL ${legacy?`OR EXISTS(SELECT 1 FROM cm_legacy_notes af WHERE af.library=${alias}.library AND af.rid=a.id AND af.active=0)`:''} LIMIT 1)`
  return `(CASE WHEN ${alias}.type LIKE 'activity/%' AND EXISTS(SELECT 1 FROM cm_activity_reports membership WHERE membership.library=${alias}.library AND membership.rid=${alias}.id) THEN ${graph} ELSE ${direct} END)`
}
export function activeSource(store,library,rid,{metadataOnly=false}={}){
  const r=metadataOnly&&/^[0-9a-f]{24}$/.test(rid)?store.db.prepare('SELECT id,library,session,seq,type,origin,time,role,digest FROM records WHERE library=? AND id=?').get(library,rid):store.record(library,rid)
  if(!r)fail('NOT_FOUND','本库没有这条原文')
  if(!store.db.prepare('SELECT 1 FROM records r WHERE r.library=? AND r.id=? AND '+sourceAvailabilitySQL(store)).get(library,r.id))fail('SOURCE_INACTIVE','原文或活动报告的依据已停用')
  return r
}

/** Stable across wall-clock time; changes when a source, ancestor or structured view changes. */
export function sourceStamp(store,library,rid){
  const root=activeSource(store,library,rid,{metadataOnly:true}),ids=[root.id,...sourceAncestors(store,library,root.id)].sort()
  const activities=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_activity_payloads'").get()
  return JSON.stringify(ids.map(id=>{
    const r=activeSource(store,library,id,{metadataOnly:true}),payload=activities?store.db.prepare('SELECT digest FROM cm_activity_payloads WHERE library=? AND rid=?').get(library,id):null
    return [r.id,r.digest,r.origin,sourcePosition(r),payload?.digest??null]
  }))
}
