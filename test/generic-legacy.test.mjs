import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'
import {Capture} from '../lib/capture.mjs'
import {ActivityArchive} from '../lib/activity-archive.mjs'

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'rt-generic-legacy-')),legacy=join(dir,'legacy.sqlite3'),db=new DatabaseSync(legacy)
 db.exec('PRAGMA application_id=1145851185;CREATE TABLE records(id TEXT,namespace TEXT,source TEXT,role TEXT,content TEXT,created_at TEXT);CREATE TABLE flags(record_id TEXT,active INTEGER);')
 for(const [id,ns]of [['a','synthetic-a'],['b','synthetic-b']]){db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(id,ns,'notes','user','Synthetic namespace '+ns,'2026-01-01T00:00:00Z');db.prepare('INSERT INTO flags VALUES(?,1)').run(id)}db.close()
 const store=new ContinuityStore(join(dir,'memory')),library=store.create('Synthetic generic import');store.bind('owner',library.id,0);const instances=[]
 t.after(()=>{for(const e of instances)e.close();store.close();const p=resolve(dir);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&p.includes('rt-generic-legacy-'));rmSync(p,{recursive:true,force:true})})
 const embed=options=>{const e=new Embedding(store,{legacyIndexPath:legacy,legacySessionId:'owner',...options});instances.push(e);return e}
 return {store,library,legacy,embed}
}
test('legacy imports require an explicit namespace, without a personal default',t=>{
 const f=fixture(t);assert.throws(()=>f.embed({}),{code:'LEGACY_NAMESPACE_REQUIRED'});assert.equal(f.store.report(f.library.id).records,0)
})
test('legacy imports select only the configured namespace and remain read-only',t=>{
 const f=fixture(t),e=f.embed({legacyNamespace:'synthetic-b'});assert.equal(e.syncLegacyNotes(f.library.id,'owner').imported,1)
 assert.equal(f.store.recent(f.library.id)[0].text,'Synthetic namespace synthetic-b');const db=new DatabaseSync(f.legacy,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM records').get().n,2)}finally{db.close()}
})
test('legacy namespace values are SQL parameters, never executable selectors',t=>{
 const f=fixture(t),e=f.embed({legacyNamespace:"synthetic-b' OR 1=1 --"});assert.equal(e.syncLegacyNotes(f.library.id,'owner').imported,0)
})
test('memory-tool replay exclusion is generic instead of tied to a persona name',t=>{
 const f=fixture(t),archive=new ActivityArchive(f.store,{enabled:true}),capture=new Capture(f.store,archive),time=new Date().toISOString()
 capture.event(f.library.id,'owner',{seq:1,time,type:'tool/call',data:{name:'sample_memory_lookup',callId:'synthetic-lookup',arguments:{query:'synthetic'}}})
 capture.event(f.library.id,'owner',{seq:2,time,type:'tool/result',data:{message:{toolCallId:'synthetic-lookup',content:'Synthetic returned memory'}}})
 assert.equal(f.store.report(f.library.id).records,0)
})
