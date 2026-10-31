import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {ClaimLinks} from '../lib/claim-links.mjs'
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cm-claim-links-')),store=new ContinuityStore(dir),lib=store.create('Synthetic claim history');store.bind('owner',lib.id,0)
 const links=new ClaimLinks(store);let seq=0
 const record=(text,extra={})=>store.append(lib.id,{session:'history',seq:++seq,time:new Date(Date.UTC(2026,0,1,0,seq)).toISOString(),role:'user',text,...extra})
 const link=(id,target_id,more={})=>links.record(lib.id,'owner',{id,target_id,relation:'changed',subject:'speaker',topic:'palette',scope:'room',source_quote:store.record(lib.id,id).text,target_quote:store.record(lib.id,target_id).text,reason:'Explicit attributed change in synthetic sources',...more})
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});return {dir,store,lib,links,record,link}
}
test('either endpoint retrieves both attributed statements without changing original sources',t=>{
 const f=fixture(t),a=f.record('I used blue in the room.'),b=f.record('I now prefer green in the room.'),saved=f.store.record(f.lib.id,a)
 const result=f.link(a,b)
 for(const id of [a,b]){const g=f.links.resolve(f.lib.id,[id]).groups[0];assert.equal(g.kind,'changed');assert.match(g.before,/blue/);assert.match(g.after,/green/)}
 assert.equal(result.truth_verified,false);assert.deepEqual(f.store.record(f.lib.id,a),saved);assert.equal(f.link(a,b).duplicate,true)
 assert.match(f.links.status(f.lib.id,a).links[0].reason,/Explicit/)
})
test('links require ownership, exact quotations, ordered evidence and matching library',t=>{
 const f=fixture(t),a=f.record('First expression.'),b=f.record('Later expression.')
 assert.throws(()=>f.link(a,b,{source_quote:'Invented quote'}),{code:'INVALID_EVIDENCE'})
 assert.throws(()=>f.link(b,a),{code:'INVALID_EVIDENCE'})
 const other=f.store.create('Other library'),c=f.store.append(other.id,{session:'elsewhere',seq:1,time:new Date().toISOString(),role:'user',text:'Other source.'})
 assert.throws(()=>f.link(a,c),{code:'NOT_FOUND'})
 assert.throws(()=>f.links.record(f.lib.id,'reader',{}))
})
test('a chain follows later changes, branching remains a dispute rather than a random winner',t=>{
 const f=fixture(t),a=f.record('Blue.'),b=f.record('Green.'),c=f.record('Yellow.'),d=f.record('Red.')
 f.link(a,b);f.link(b,c)
 const g=f.links.resolve(f.lib.id,[a],{limit:5}).groups.find(g=>g.from===f.store.shortId(f.lib.id,a));assert.equal(g.to,f.store.shortId(f.lib.id,c));assert.equal(g.chain,true)
 f.link(a,d);const groups=f.links.resolve(f.lib.id,[a],{limit:5}).groups;assert.ok(groups.filter(g=>g.from===f.store.shortId(f.lib.id,a)).every(g=>g.kind==='disputed'&&g.branching))
})
test('contextual differences do not silently become corrections and current-turn evidence is excluded',t=>{
 const f=fixture(t),a=f.record('At work I choose blue.'),b=f.record('At home I choose green.',{session:'owner',seq:90})
 f.link(a,b,{relation:'contextual'});assert.equal(f.links.resolve(f.lib.id,[a]).groups[0].kind,'contextual')
 assert.equal(f.links.resolve(f.lib.id,[a],{exclude:{session:'owner',fromSeq:90}}).groups.length,0)
})
test('retraction is evidenced, durable and does not silently reactivate through deduplication',t=>{
 const f=fixture(t),a=f.record('First.'),b=f.record('Second.'),c=f.record('The previous association was mistaken.'),link=f.link(a,b)
 assert.throws(()=>f.links.retract(f.lib.id,'owner',{link_id:link.id,reason:'mistaken',refs:[a]}),{code:'INVALID_EVIDENCE'})
 f.links.retract(f.lib.id,'owner',{link_id:link.id,reason:'Independent later correction',refs:[c]});assert.equal(f.links.resolve(f.lib.id,[a]).groups.length,0)
 assert.equal(f.link(a,b).retracted,true);assert.equal(f.links.status(f.lib.id,a).links[0].retraction_reason,'Independent later correction')
})
test('accepted state history is paired; a pending candidate does not replace the accepted version',t=>{
 const f=fixture(t),a=f.record('Blue.'),b=f.record('Green.'),c=f.record('Possibly yellow.')
 const propose=(body,refs,revision,accepted)=>f.store.propose(f.lib.id,{key:'palette',kind:'preference',body,refs,reason:'Synthetic sources',expectedRevision:revision},accepted)
 propose('Blue',[a],0,true);propose('Green',[b],1,true);propose('Yellow',[c],2,false)
 const g=f.links.resolve(f.lib.id,[a]).groups[0];assert.equal(g.kind,'state-revision');assert.equal(g.before,'Blue');assert.equal(g.after,'Green');assert.match(g.basis,/not-verified/)
})
test('same-speaker opposite preference is only a possible conflict; other speakers do not merge',t=>{
 const f=fixture(t),a=f.record('我喜欢蓝色。'),b=f.record('我现在不喜欢蓝色。'),c=f.record('我喜欢蓝色。',{origin:{sender_id:'another-person'}})
 assert.equal(f.links.resolve(f.lib.id,[a,b]).groups[0].kind,'possible-conflict');assert.equal(f.links.resolve(f.lib.id,[b,c]).groups.length,0)
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_claim_links').get().n,0)
})
test('deleted or inactive evidence cannot be injected from a cached relationship',t=>{
 const f=fixture(t),a=f.record('Old.'),b=f.record('New.');f.link(a,b)
 f.store.db.prepare('DELETE FROM records WHERE id=?').run(b);assert.equal(f.links.resolve(f.lib.id,[a]).groups.length,0)
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM cm_claim_links').get().n,0)
})
