import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {ClaimLinks} from '../lib/claim-links.mjs'
import {page} from '../lib/util.mjs'
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cm-claim-pages-')),base=Date.UTC(2026,0,1);let now=base
 const store=new ContinuityStore(dir,{now:()=>now}),lib=store.create('Synthetic claim pages');store.bind('owner',lib.id,0)
 const links=new ClaimLinks(store);let seq=0
 const record=text=>store.append(lib.id,{session:'history',seq:++seq,time:new Date(base+seq*1000).toISOString(),role:'user',text})
 const link=(id,target_id,more={})=>links.record(lib.id,'owner',{id,target_id,relation:'changed',subject:'speaker',topic:'palette',scope:'room',source_quote:store.record(lib.id,id).text,target_quote:store.record(lib.id,target_id).text,reason:'Synthetic attributed change',...more})
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 return {dir,store,lib,links,record,link,setNow:s=>{now=base+s}}
}
function drain(f,anchor,{limit=10,maxPages=20}={}){
 const first=f.links.status(f.lib.id,anchor,{limit}).relation_page,items=[...first.items],seen=new Set(items.map(i=>i.id)),cursors=[first.next_cursor]
 assert.equal(first.returned,first.items.length);assert.ok(first.next_cursor!==undefined)
 let page=first,pages=1
 while(page.has_more&&pages<maxPages){
  assert.ok(page.next_cursor,'a page that claims more must return a usable cursor')
  assert.ok(!cursors.slice(0,-1).includes(page.next_cursor),'pages must not reuse an earlier cursor')
  page=f.links.relations(f.lib.id,anchor,{cursor:page.next_cursor,limit})
  for(const item of page.items){assert.ok(!seen.has(item.id),'no relationship may repeat across pages');seen.add(item.id)}
  items.push(...page.items);cursors.push(page.next_cursor);pages++
 }
 return {items,seen,pages,last:page,cursors}
}
test('relationship pages reach beyond the first twenty with stable same-timestamp ties',t=>{
 const f=fixture(t),anchor=f.record('Original choice.'),targets=Array.from({length:25},(_,i)=>f.record('Later choice '+i+'.'))
 f.setNow(5000);const expected=targets.map(target=>f.link(anchor,target).id)
 const first=f.links.status(f.lib.id,anchor,{limit:10}).relation_page
 assert.equal(first.items.length,10);assert.equal(first.has_more,true)
 const {items,seen,pages,last}=drain(f,anchor,{limit:10})
 assert.equal(f.store.db.prepare('SELECT count(DISTINCT time) n FROM cm_claim_links').get().n,1,'fixture must exercise identical timestamps')
 assert.equal(items.length,25);assert.equal(seen.size,25);assert.equal(last.has_more,false);assert.equal(last.next_cursor,null)
 for(const id of expected)assert.ok(seen.has(id))
 assert.equal(new Set(f.store.db.prepare('SELECT id FROM cm_claim_links').all().map(r=>r.id)).size,25)
 assert.ok(pages>=3)
})
test('a relationship inserted between pages appears once later instead of repeating a page',t=>{
 const f=fixture(t),anchor=f.record('Original choice.'),targets=Array.from({length:12},(_,i)=>f.record('Later '+i+'.'))
 f.setNow(5000);for(const target of targets)f.link(anchor,target)
 const first=f.links.status(f.lib.id,anchor,{limit:5}).relation_page
 assert.equal(first.items.length,5)
 f.setNow(4000)
 const inserted=f.link(anchor,f.record('Inserted between pages.'))
 const seen=new Set(first.items.map(i=>i.id)),items=[...first.items]
 let page=first,pages=0
 while(page.has_more&&pages<10){
  page=f.links.relations(f.lib.id,anchor,{cursor:page.next_cursor,limit:5})
  assert.notEqual(page.items[0]?.id,first.items[0]?.id,'the cursor must advance, not serve the same page')
  for(const item of page.items){assert.ok(!seen.has(item.id),'no duplicates after an insert');seen.add(item.id)}
  items.push(...page.items);pages++
 }
 assert.equal(items.length,13);assert.ok(seen.has(inserted.id));assert.equal(page.has_more,false)
})
test('cross-library, foreign-source, tampered and stale cursors are rejected',t=>{
 const f=fixture(t),anchor=f.record('Original choice.'),target=f.record('Later choice.'),second=f.record('Even later choice.')
 f.setNow(5000);f.link(anchor,target);f.link(anchor,second)
 const cursor=f.links.status(f.lib.id,anchor,{limit:1}).relation_page.next_cursor
 assert.ok(cursor)
 assert.throws(()=>f.links.relations(f.lib.id,target,{cursor,limit:1}),{code:'INVALID_CURSOR'})
 assert.throws(()=>f.links.relations(f.lib.id,anchor,{cursor:cursor.slice(0,-3)+'AAA',limit:1}),{code:'INVALID_CURSOR'})
 assert.throws(()=>f.links.relations(f.lib.id,anchor,{cursor:'not-a-cursor',limit:1}),{code:'INVALID_CURSOR'})
 const other=f.store.create('Synthetic other library'),elsewhere=f.store.append(other.id,{session:'elsewhere',seq:1,time:new Date(Date.now()).toISOString(),role:'user',text:'Other source.'})
 assert.throws(()=>f.links.relations(other.id,elsewhere,{cursor,limit:1}),{code:'INVALID_CURSOR'})
 assert.throws(()=>f.links.relations(other.id,anchor,{cursor,limit:1}),{code:'NOT_FOUND'})
 const boundary=f.store.db.prepare('SELECT id,time FROM cm_claim_links ORDER BY time DESC,id DESC LIMIT 1').get()
 assert.deepEqual(boundary,f.store.db.prepare('SELECT id,time FROM cm_claim_links WHERE id=?').get(boundary.id))
 f.store.db.prepare('DELETE FROM cm_claim_links WHERE id=?').run(boundary.id)
 assert.throws(()=>f.links.relations(f.lib.id,anchor,{cursor,limit:1}),{code:'INVALID_CURSOR'})
})
test('retracted relationships stay listed with evidence while inactive endpoints are withheld',t=>{
 const f=fixture(t),anchor=f.record('Original choice.'),first=f.record('Later one.'),second=f.record('Later two.'),evidence=f.record('Independent later evidence.')
 f.setNow(5000);const linkOne=f.link(anchor,first),linkTwo=f.link(anchor,second)
 f.setNow(6000);f.links.retract(f.lib.id,'owner',{link_id:linkOne.id,reason:'Synthetic retraction',refs:[evidence]})
 const listed=f.links.status(f.lib.id,anchor,{limit:10}).relation_page
 const retracted=listed.items.find(i=>i.id===linkOne.id)
 assert.ok(retracted);assert.equal(retracted.retracted,true);assert.match(retracted.retraction.reason,/Synthetic retraction/)
 assert.deepEqual(retracted.retraction.refs,[f.store.shortId(f.lib.id,evidence)])
 assert.equal(listed.items.some(i=>i.id===linkTwo.id),true)
 f.store.db.exec('CREATE TABLE IF NOT EXISTS cm_legacy_notes(library TEXT NOT NULL,legacy_id TEXT NOT NULL,rid TEXT,active INTEGER NOT NULL,PRIMARY KEY(library,legacy_id))')
 f.store.db.prepare('INSERT INTO cm_legacy_notes VALUES(?,?,?,0)').run(f.lib.id,'legacy-synthetic',second)
 const after=f.links.status(f.lib.id,anchor,{limit:10}).relation_page
 assert.equal(after.items.some(i=>i.id===linkTwo.id),false,'a relationship with an inactive endpoint is not served')
 assert.equal(after.items.some(i=>i.id===linkOne.id),true)
 assert.ok(after.recorded_total>=2)
})
test('a long retraction explanation is returned in full from the stored relationship',t=>{
 const f=fixture(t),anchor=f.record('Original choice.'),target=f.record('Later choice.'),evidence=f.record('Independent later retraction evidence.')
 f.setNow(5000);const link=f.link(anchor,target)
 f.setNow(6000);const reason='r'.repeat(440)+'-essential-final-context'
 f.links.retract(f.lib.id,'owner',{link_id:link.id,reason,refs:[evidence]})
 const detail=f.links.status(f.lib.id,anchor).links.find(item=>item.id===link.id)
 assert.equal(detail.retraction.reason,reason)
 assert.equal(detail.retraction_reason,reason)
 assert.deepEqual(detail.retraction.refs,[f.store.shortId(f.lib.id,evidence)])
})
test('character pagination of the summary remains independent from relationship cursors',t=>{
 const f=fixture(t),anchor=f.record('Original choice.'),targets=Array.from({length:9},(_,i)=>f.record('Later '+i+'.'))
 f.setNow(5000);for(const target of targets)f.link(anchor,target)
 const full=f.links.status(f.lib.id,anchor,{limit:3})
 const summary=JSON.stringify({groups:full.groups,more:full.more,note:full.note})
 const chars=Array.from(summary)
 const first=page(summary,0,40),second=page(summary,first.next_offset,40)
 assert.equal(Array.from(first.text).length,40);assert.equal(first.text+second.text,chars.slice(0,80).join(''))
 assert.equal(full.relation_page.items.length,3)
 assert.ok(full.relation_page.next_cursor)
})
