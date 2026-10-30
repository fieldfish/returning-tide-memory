import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {ContinuityStore} from '../lib/store.mjs'
import {Extraction} from '../lib/extraction.mjs'
import {SourceLog} from '../lib/source-log.mjs'

function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'cm-ingest-test-'));let store=new ContinuityStore(directory),seq=0
  const lib=store.create('合成摄入');store.bind('owner',lib.id,0)
  const append=text=>store.append(lib.id,{session:'owner',seq:++seq,time:'2026-10-29T08:00:00Z',role:'user',text})
  t.after(()=>{store.close();const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('cm-ingest-test-'));rmSync(path,{recursive:true,force:true})})
  return {directory,get store(){return store},lib,append,reopen:()=>{store.close();store=new ContinuityStore(directory);return store}}
}
test('删除末尾后SQLite行号确实复用，但新摄入序号不复用且不会漏整理',async t=>{
  const f=fixture(t),received=[];const x=new Extraction(f.store,{dshCall:async a=>{received.push(JSON.parse(a.input).records.map(r=>r.text));return {text:'{"items":[]}'}}})
  x.configure(f.lib.id,'owner',{source:'dsh',provider:'test',model:'test',minIntervalMs:0});x.resume(f.lib.id,'owner')
  f.append('第一条');const last=f.append('将删除的末尾');await x.run(f.lib.id,'owner')
  const cursor=x.status(f.lib.id).cursor,rowid=f.store.db.prepare('SELECT rowid FROM records WHERE id=?').get(last).rowid
  f.store.removeRecord(f.lib.id,'owner',last);const next=f.append('删除以后新来的记录')
  assert.equal(f.store.db.prepare('SELECT rowid FROM records WHERE id=?').get(next).rowid,rowid)
  assert.ok(f.store.db.prepare('SELECT seq FROM cm_ingest_log WHERE rid=?').get(next).seq>cursor)
  assert.equal(x.dueIn(f.lib.id),0);await x.run(f.lib.id,'owner');assert.deepEqual(received.at(-1),['删除以后新来的记录'])
})
test('多库和已有行号空洞迁移正确，重复初始化不改变序号或重复迁移',t=>{
  const f=fixture(t),a=f.append('已整理'),gone=f.append('旧空洞'),b=f.append('未整理');f.store.removeRecord(f.lib.id,'owner',gone)
  f.store.db.prepare('INSERT INTO extraction(library,config,paused,cursor) VALUES(?,?,1,?)').run(f.lib.id,'{}',1)
  const log=new SourceLog(f.store),cursor=f.store.db.prepare('SELECT cursor FROM extraction WHERE library=?').get(f.lib.id).cursor
  assert.deepEqual(log.rows(f.lib.id,cursor).map(r=>r.id),[b]);assert.equal(log.rows(f.lib.id,0)[0].id,a)
  new SourceLog(f.store);const c=f.append('第三条');assert.equal(log.rows(f.lib.id,0).at(-1).cursor,3)
  const other=f.store.create('另一个库');assert.equal(log.hasNew(other.id,0),false)
})
test('schema2升级前保留一致快照，旧游标迁移且原文不变',t=>{
  const f=fixture(t),id=f.append('升级原文');f.store.db.exec('PRAGMA user_version=2');f.reopen()
  const backups=readdirSync(f.directory).filter(p=>/^before-schema-3-.*\.sqlite3$/.test(p));assert.equal(backups.length,1)
  const backup=new DatabaseSync(join(f.directory,backups[0]),{readOnly:true})
  try{assert.equal(backup.prepare('PRAGMA user_version').get().user_version,2);assert.equal(backup.prepare('SELECT text FROM records WHERE id=?').get(id).text,'升级原文')}finally{backup.close()}
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,3);assert.equal(f.store.record(f.lib.id,id).text,'升级原文')
})
