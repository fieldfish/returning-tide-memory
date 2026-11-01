import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {LexicalIndex} from '../lib/lexical-index.mjs'
function fixture(t,{before=[]}={}){
 const dir=mkdtempSync(join(tmpdir(),'cm-lexical-index-')),store=new ContinuityStore(dir),lib=store.create('Synthetic lexical index');store.bind('owner',lib.id,0)
 const other=store.create('Synthetic other library');store.bind('other-owner',other.id,0)
 let seq=0
 const record=text=>store.append(lib.id,{session:'history',seq:++seq,time:new Date(Date.UTC(2026,0,1,0,seq)).toISOString(),role:'user',text})
 for(const text of before)record(text)
 const index=new LexicalIndex(store)
 const matches=(term,{library=lib.id,activities=false}={})=>{
  const query=index.candidates(library,[term],activities)
  return store.db.prepare(`SELECT DISTINCT rid FROM (${query.sql})`).all(...query.args).map(row=>row.rid)
 }
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 return {dir,store,lib,other,index,record,matches}
}
test('a new backlog is pending, becomes searchable after a batch, and an absent term stays absent',t=>{
 const f=fixture(t),first=f.record('The blue clamp sits near the window'),second=f.record('A quiet ocean note')
 assert.equal(f.index.pending(f.lib.id),2)
 while(f.index.buildBatch(f.lib.id)>0){}
 assert.equal(f.index.pending(f.lib.id),0)
 assert.deepEqual(f.matches('window'),[first])
 assert.deepEqual(f.matches('lamp').filter(id=>id===first),[first],'English substring inside a longer word')
 assert.deepEqual(f.matches('honeymoon'),[])
})
test('long records stay searchable through the oversized path, including their tail',t=>{
 const f=fixture(t),huge=f.record('ordinary opening '+('x'.repeat(9000))+' uniqueendterm')
 while(f.index.buildBatch(f.lib.id)>0){}
 assert.equal(f.store.db.prepare('SELECT state FROM cm_lex_sources WHERE rid=?').get(huge).state,-1)
 assert.ok(f.matches('uniqueendterm').includes(huge))
})
test('insert, update and delete keep the queue correct and libraries stay isolated',t=>{
 const f=fixture(t),first=f.record('alpha workshop notes');while(f.index.buildBatch(f.lib.id)>0){}
 const added=f.record('beta workshop notes');assert.equal(f.index.pending(f.lib.id),1)
 const other=f.store.append(f.other.id,{session:'other',seq:1,time:'2026-01-01T00:00:00Z',role:'user',text:'gamma workshop notes'})
 while(f.index.buildBatch(f.lib.id)>0){};while(f.index.buildBatch(f.other.id)>0){}
 assert.ok(f.matches('beta').includes(added));assert.equal(f.matches('beta',{library:f.other.id}).includes(other),false)
 f.store.db.prepare('UPDATE records SET text=? WHERE id=?').run('delta workshop notes',first)
 assert.equal(f.index.pending(f.lib.id),1)
 while(f.index.buildBatch(f.lib.id)>0){}
 assert.ok(f.matches('delta').includes(first));assert.equal(f.matches('alpha').includes(first),false)
 f.store.db.prepare('DELETE FROM records WHERE id=?').run(added)
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_lex_sources WHERE rid=?').get(added).n,0)
})
test('an activity payload arriving after indexing resets and re-indexes its record',t=>{
 const f=fixture(t),source=f.record('raw observation text')
 while(f.index.buildBatch(f.lib.id)>0){}
 f.store.db.exec(`CREATE TABLE IF NOT EXISTS cm_activity_payloads(rid TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,library TEXT NOT NULL,event_type TEXT NOT NULL,call_id TEXT,name TEXT,phase TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,metadata TEXT NOT NULL,time INTEGER NOT NULL)`)
 assert.equal(f.index.ensureActivityTriggers(),true)
 f.store.db.prepare('INSERT INTO cm_activity_payloads VALUES(?,?,?,?,?,?,?,?,?,?)').run(source,f.lib.id,'tool','call','synthetic','host-returned','payloadunicorn visible text','digest','{}',Date.now())
 assert.equal(f.index.pending(f.lib.id),1,'a later payload must invalidate the built entry')
 assert.deepEqual(f.matches('payloadunicorn',{activities:true}),[source],'pending payload text is a candidate')
 while(f.index.buildBatch(f.lib.id)>0){}
 assert.deepEqual(f.matches('payloadunicorn',{activities:true}),[source],'payload text stays indexed after the rebuild')
 f.store.db.prepare('UPDATE cm_activity_payloads SET payload=? WHERE rid=?').run('secondoctopus text',source)
 assert.equal(f.index.pending(f.lib.id),1)
 while(f.index.buildBatch(f.lib.id)>0){}
 assert.deepEqual(f.matches('secondoctopus',{activities:true}),[source])
 f.store.db.prepare('DELETE FROM cm_activity_payloads WHERE rid=?').run(source)
 assert.equal(f.index.pending(f.lib.id),1,'payload deletion must also invalidate the built entry')
 while(f.index.buildBatch(f.lib.id)>0){}
 assert.deepEqual(f.matches('secondoctopus',{activities:true}),[],'stale payload pairs are cleared on rebuild')
 assert.deepEqual(f.matches('raw').filter(id=>id===source),[source],'raw text remains searchable')
})
test('an old database backfills on first construction and survives reopen',t=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-lexical-reopen-'))
 let store=new ContinuityStore(dir),lib=store.create('Synthetic legacy library');store.bind('owner',lib.id,0)
 store.append(lib.id,{session:'old',seq:1,time:'2026-01-01T00:00:00Z',role:'user',text:'legacy archive entry'})
 store.append(lib.id,{session:'old',seq:2,time:'2026-01-01T00:00:01Z',role:'user',text:'another legacy entry'})
 let index=new LexicalIndex(store)
 assert.equal(index.pending(lib.id),2,'first construction backfills existing records')
 while(index.buildBatch(lib.id)>0){}
 store.close()
 store=new ContinuityStore(dir);index=new LexicalIndex(store)
 assert.equal(index.pending(lib.id),0)
 const query=index.candidates(lib.id,['legacy'],false)
 assert.equal(store.db.prepare(`SELECT count(*) n FROM (SELECT DISTINCT rid FROM (${query.sql}))`).get(...query.args).n,2)
 store.append(lib.id,{session:'new',seq:1,time:'2026-01-02T00:00:00Z',role:'user',text:'post reopen record'})
 assert.equal(index.pending(lib.id),1,'triggers survive reopen')
 store.close();rmSync(dir,{recursive:true,force:true})
})
test('async maintenance yields between rows and observes cancellation',async t=>{
 const f=fixture(t)
 for(let i=0;i<40;i++)f.record('maintenance row '+i+' commonword')
 const done=await f.index.buildBatchAsync(f.lib.id,{batch:4})
 assert.equal(done,4);assert.equal(f.index.pending(f.lib.id),36)
 const controller=new AbortController();controller.abort()
 await assert.rejects(f.index.buildBatchAsync(f.lib.id,{signal:controller.signal}),{code:'CANCELLED'})
 assert.equal(f.index.pending(f.lib.id),36,'cancellation leaves unbuilt rows pending, never dropped')
 // Abort during the yielded turn, after the loop's first check: the row must not be built.
 const during=new AbortController(),pending=f.index.pending(f.lib.id)
 const running=f.index.buildBatchAsync(f.lib.id,{signal:during.signal,batch:4})
 queueMicrotask(()=>during.abort())
 await assert.rejects(running,{code:'CANCELLED'})
 assert.equal(f.index.pending(f.lib.id),pending,'the post-yield check prevents a database write after cancellation')
})
