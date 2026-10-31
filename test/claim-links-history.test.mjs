import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {ClaimLinks} from '../lib/claim-links.mjs'
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cm-claim-history-')),base=Date.UTC(2026,0,1);let now=base,seq=0
 const store=new ContinuityStore(dir,{now:()=>now}),lib=store.create('Synthetic deep claim history');store.bind('owner',lib.id,0)
 const links=new ClaimLinks(store),at=s=>new Date(base+s*1000).toISOString()
 const record=(text,more={})=>{seq++;return store.append(lib.id,{session:'history',seq,time:at(seq),role:'user',text,...more})}
 const link=(id,target_id,more={})=>links.record(lib.id,'owner',{id,target_id,relation:'changed',subject:'speaker',topic:'palette',scope:'room',source_quote:store.record(lib.id,id).text,target_quote:store.record(lib.id,target_id).text,reason:'Synthetic attributed change',...more})
 const propose=(key,body,refs,revision,accepted=true,more={})=>store.propose(lib.id,{key,kind:'preference',body,refs,reason:'Synthetic original source',expectedRevision:revision,...more},accepted)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 return {store,lib,links,record,link,propose,at,setNow:s=>{now=base+s*1000}}
}
function deepHistory(f,{count=70}={}){
 const anchor=f.record('Original C++ choice.'),later=Array.from({length:count},(_,i)=>f.record('Revision '+i+' choice.'))
 f.propose('palette','C++',[anchor],0)
 for(let i=0;i<count;i++)f.propose('palette','revision '+i,[later[i]],i+1)
 return {anchor,later}
}
test('deep accepted history still pairs the earliest retrieved source with the latest accepted version',t=>{
 const f=fixture(t),{anchor,later}=deepHistory(f)
 const groups=f.links.resolve(f.lib.id,[anchor],{limit:5}).groups.filter(g=>g.kind==='state-revision')
 assert.equal(groups.length,1)
 assert.equal(groups[0].before,'C++')
 assert.equal(groups[0].after,'revision 69')
 assert.equal(groups[0].to,f.store.shortId(f.lib.id,later[69]))
})
test('a pending candidate in a deep history never replaces the accepted current version',t=>{
 const f=fixture(t),{anchor}=deepHistory(f)
 f.propose('palette','pending candidate',[anchor],71,false)
 const group=f.links.resolve(f.lib.id,[anchor],{limit:5}).groups.find(g=>g.kind==='state-revision')
 assert.ok(group)
 assert.equal(group.after,'revision 69')
 assert.doesNotMatch(group.after,/pending/)
})
test('an expired latest accepted state is not silently replaced by an older accepted version',t=>{
 const f=fixture(t)
 f.setNow(10);const anchor=f.record('Old decision.')
 f.propose('temporary','old decision',[anchor],0)
 f.setNow(20);const later=f.record('Temporary decision.')
 f.propose('temporary','temporary decision',[later],1,true,{kind:'transient',expires:Date.parse(f.at(30))})
 f.setNow(40)
 const resolved=f.links.resolve(f.lib.id,[anchor],{limit:5})
 assert.equal(resolved.groups.filter(g=>g.kind==='state-revision').length,0)
})
test('C# and C++ are not treated as C when only punctuation differs',t=>{
 const f=fixture(t),a=f.record('Language choice C#.'),b=f.record('Language choice C.'),c=f.record('Language choice C++.')
 f.propose('language','C#',[a],0)
 f.propose('language','C',[b],1)
 const group=f.links.resolve(f.lib.id,[a]).groups.find(g=>g.kind==='state-revision')
 assert.ok(group,'a body that differs only by a punctuation mark that belongs to the name is still a different decision')
 assert.equal(group.before,'C#')
 assert.equal(group.after,'C')
 f.propose('language','C++',[c],2)
 const latest=f.links.resolve(f.lib.id,[b]).groups.find(g=>g.kind==='state-revision')
 assert.equal(latest.before,'C')
 assert.equal(latest.after,'C++')
})
test('a long chain reports its bound instead of presenting an intermediate node as final',t=>{
 const f=fixture(t),nodes=[f.record('Step 0.')]
 for(let i=1;i<=11;i++)nodes.push(f.record('Step '+i+'.'))
 for(let i=0;i<11;i++)f.link(nodes[i],nodes[i+1])
 const result=f.links.resolve(f.lib.id,[nodes[0]],{limit:5}),group=result.groups.find(g=>g.from===f.store.shortId(f.lib.id,nodes[0]))
 assert.equal(group.kind,'changed')
 assert.equal(group.chain,true)
 assert.equal(group.intermediate,true)
 assert.equal(group.to,f.store.shortId(f.lib.id,nodes[9]))
 assert.equal(result.more,true)
})
test('a fully returned short chain does not falsely claim there is more',t=>{
 const f=fixture(t),nodes=[f.record('Step 0.')]
 for(let i=1;i<=3;i++)nodes.push(f.record('Step '+i+'.'))
 for(let i=0;i<3;i++)f.link(nodes[i],nodes[i+1])
 const result=f.links.resolve(f.lib.id,[nodes[0]],{limit:5})
 assert.equal(result.groups.length,3)
 assert.equal(result.more,false)
 assert.equal(result.groups.find(g=>g.from===f.store.shortId(f.lib.id,nodes[0])).to,f.store.shortId(f.lib.id,nodes[3]))
})
test('a branch found only by the walk stays a dispute rather than one chosen successor',t=>{
 const f=fixture(t),a=f.record('Root.'),b=f.record('Middle.'),c=f.record('Third.'),d=f.record('Fourth.'),e1=f.record('Fifth A.'),e2=f.record('Fifth B.')
 f.link(a,b);f.link(b,c);f.link(c,d);f.link(d,e1);f.link(d,e2)
 const result=f.links.resolve(f.lib.id,[a],{limit:5}),group=result.groups.find(g=>g.from===f.store.shortId(f.lib.id,a))
 assert.equal(group.kind,'disputed')
 assert.equal(group.branching,true)
 assert.equal(result.more,true)
})
test('a later archived report of an earlier native event cannot extend or retract a later relation',t=>{
 const f=fixture(t),a=f.record('Original choice.'),b=f.record('Later choice.')
 const earlierReport=f.store.append(f.lib.id,{session:'activity-report',seq:1,time:'2026-01-02T00:00:00Z',role:'user',text:'Report copied from an earlier native event.',origin:{kind:'activity-report',position_verified:true,native_session:'history',native_seq:1}})
 const link=f.link(a,b),quote=text=>f.store.record(f.lib.id,text).text
 assert.throws(()=>f.links.record(f.lib.id,'owner',{id:b,target_id:earlierReport,relation:'changed',subject:'speaker',topic:'palette',scope:'room',source_quote:quote(b),target_quote:quote(earlierReport),reason:'A later archive time is not a later understanding'}),{code:'INVALID_EVIDENCE'})
 assert.throws(()=>f.links.retract(f.lib.id,'owner',{link_id:link.id,reason:'An earlier source archived later',refs:[earlierReport]}),{code:'INVALID_EVIDENCE'})
})
test('a new understanding with a later native position can extend and retract even when archived earlier',t=>{
 const f=fixture(t),a=f.record('Original choice.'),b=f.record('Later choice.')
 const laterReport=f.store.append(f.lib.id,{session:'activity-report',seq:2,time:'2026-01-01T00:00:01Z',role:'user',text:'A new understanding recorded later in the native conversation.',origin:{kind:'activity-report',position_verified:true,native_session:'history',native_seq:5}})
 const quote=id=>f.store.record(f.lib.id,id).text
 const extended=f.links.record(f.lib.id,'owner',{id:b,target_id:laterReport,relation:'changed',subject:'speaker',topic:'palette',scope:'room',source_quote:quote(b),target_quote:quote(laterReport),reason:'Native order beats the archive time'})
 assert.ok(extended.id)
 const link=f.link(a,b)
 const retracted=f.links.retract(f.lib.id,'owner',{link_id:link.id,reason:'Independent later native understanding',refs:[laterReport]})
 assert.equal(retracted.retracted,true)
})
