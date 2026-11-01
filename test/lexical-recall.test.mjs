import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'rt-lexical-recall-'))
  const store=new ContinuityStore(directory),embedding=new Embedding(store)
  const library=store.create('Synthetic end-to-end lexical recall')
  store.bind('owner',library.id,0)
  let seq=0
  const add=(text,origin={})=>store.append(library.id,{
    session:'history',seq:++seq,time:new Date(Date.UTC(2026,0,1,0,seq)).toISOString(),
    role:'user',text,origin
  })
  const key='synthetic-recall'
  embedding.identity=async()=>key
  embedding.embed=async([query])=>[Float32Array.from(query==='unsupported moon purchase'?[0,1]:[1,0])]
  function prepare() {
    while(embedding.prepareChunks(library.id)>0){}
    const insert=store.db.prepare('INSERT OR IGNORE INTO cm_vectors VALUES(?,?,?,?,?,?)')
    store.tx(()=>{
      for(const row of store.db.prepare('SELECT rid,part FROM cm_vector_chunks WHERE library=?').all(library.id))
        insert.run(library.id,row.rid,row.part,key,2,Buffer.from(new Float32Array([1,0]).buffer))
    })
  }
  const lookup=query=>embedding.lookup(library.id,'owner',query,5,null,null,{readOnlyIndex:true})
  const build=()=>{while(embedding.lexicalIndex.buildBatch(library.id)>0){}}
  t.after(()=>{embedding.close();store.close();rmSync(directory,{recursive:true,force:true})})
  return {store,embedding,library,add,prepare,lookup,build}
}

test('indexed recall preserves pending-path cards for substring, late text and unsupported history',async t=>{
  const f=fixture(t)
  f.add('A clamp was installed beside the window.')
  f.add('Synthetic source '.repeat(750)+' 尾部水杉计划确定下周继续。')
  f.add('另一条合成记录说明整理书桌的计划。')
  f.prepare()
  const queries=['lamp','水杉计划','unsupported moon purchase']
  const pending=[]
  for(const query of queries)pending.push((await f.lookup(query)).results)
  f.build()
  for(let i=0;i<queries.length;i++)assert.deepEqual((await f.lookup(queries[i])).results,pending[i])
  assert.equal(pending[2].length,0)
  assert.ok(pending[0].some(card=>card.quote.includes('clamp')))
})

test('indexed recall retains semantic-only results and verifies QQ transport against current text',async t=>{
  const f=fixture(t)
  const source='[QQ · 私聊] Synthetic sender：水杉计划\n（回 QQ：用 qq_bridge_send 工具）'
  const rid=f.add(source,{kind:'plugin:dsh-qq-bridge'})
  f.prepare()
  const before=(await f.lookup('unrelated semantic wording')).results
  f.build()
  assert.deepEqual((await f.lookup('unrelated semantic wording')).results,before)
  assert.ok(before.some(card=>rid.startsWith(card.id)))
  assert.equal(f.store.record(f.library.id,rid).text,source)
  const q=f.embedding.lexicalIndex.candidates(f.library.id,['send'],false)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM ('+q.sql+')').get(...q.args).n,0)
})

test('a failed batch rolls back pairs and queue state together and can be retried',t=>{
  const f=fixture(t),rid=f.add('A synthetic restartable indexing operation.')
  f.store.db.exec("CREATE TRIGGER synthetic_pair_failure BEFORE INSERT ON cm_lex_pairs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;")
  assert.throws(()=>f.build(),/synthetic failure/)
  assert.equal(f.embedding.lexicalIndex.pending(f.library.id),1)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_lex_pairs').get().n,0)
  f.store.db.exec('DROP TRIGGER synthetic_pair_failure')
  f.build()
  assert.equal(f.embedding.lexicalIndex.pending(f.library.id),0)
  assert.equal(f.store.record(f.library.id,rid).text,'A synthetic restartable indexing operation.')
})

test('built candidates still exclude retired legacy sources at the normal lookup entry point',async t=>{
  const f=fixture(t),rid=f.add('Synthetic orchid project identifier ORCHID12345678.')
  f.prepare();f.build()
  assert.ok((await f.lookup('ORCHID12345678')).results.some(card=>rid.startsWith(card.id)))
  f.store.db.prepare('INSERT INTO cm_legacy_notes VALUES(?,?,?,0)').run(f.library.id,'synthetic-retired',rid)
  assert.equal((await f.lookup('ORCHID12345678')).results.length,0)
})

test('oversized activity payloads avoid JS materialization during maintenance and retain tail lookup',async t=>{
  const f=fixture(t),rid=f.add('Synthetic observed tool result.')
  f.prepare();f.build()
  f.store.db.exec(`CREATE TABLE cm_activity_payloads(
    rid TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,library TEXT NOT NULL,
    event_type TEXT NOT NULL,call_id TEXT,name TEXT,phase TEXT NOT NULL,payload TEXT NOT NULL,
    digest TEXT NOT NULL,metadata TEXT NOT NULL,time INTEGER NOT NULL)`)
  f.embedding.lexicalIndex.ensureActivityTriggers()
  const payload='x'.repeat(100000)+' QPROJLONG12345678'
  f.store.db.prepare('INSERT INTO cm_activity_payloads VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(rid,f.library.id,'tool/result','synthetic-call','synthetic-tool','completed',payload,'synthetic','{}',0)
  const row=f.embedding.lexicalIndex.nextRows(f.library.id,1)[0]
  assert.equal(row.payload,null)
  assert.equal(row.payload_oversized,1)
  f.build()
  assert.equal(f.store.db.prepare('SELECT state FROM cm_lex_sources WHERE rid=?').get(rid).state,-1)
  f.embedding.embed=async()=>[Float32Array.from([0,1])]
  assert.ok((await f.lookup('QPROJLONG12345678')).results.some(card=>rid.startsWith(card.id)))
})
