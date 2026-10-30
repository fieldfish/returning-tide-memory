import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {StateHistory} from '../lib/state-history.mjs'
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cm-state-time-')),base=Date.UTC(2026,0,1);let now=base
 const store=new ContinuityStore(dir,{now:()=>now}),history=new StateHistory(store),lib=store.create('Synthetic state history');store.bind('owner',lib.id,0)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const set=s=>{now=base+s*1000},at=s=>new Date(base+s*1000).toISOString(),record=(s,text)=>store.append(lib.id,{session:'history',seq:s,time:at(s),role:'user',text})
 const propose=(key,body,refs,revision=0,accepted=false,more={})=>store.propose(lib.id,{key,kind:'preference',body,refs,reason:'Synthetic original source',expectedRevision:revision,...more},accepted)
 return {store,history,lib,set,at,record,propose}
}
test('新候选不覆盖已认可状态；历史时点不提前看见后来认可',t=>{
 const f=fixture(t);f.set(10);const old=f.record(10,'以前选择蓝色。');f.propose('palette','选择蓝色',[old],0,true)
 f.set(20);const next=f.record(20,'试着考虑青色，还没有决定。');f.propose('palette','考虑青色',[next],1)
 assert.equal(f.history.timeline(f.lib.id,'palette').current.revision,1)
 f.set(30);f.store.accept(f.lib.id,'owner','palette',2)
 const past=f.history.timeline(f.lib.id,'palette',{at:f.at(25)}),current=f.history.timeline(f.lib.id,'palette')
 assert.equal(past.current.revision,1);assert.equal(past.versions[0].status,'unreviewed');assert.equal(past.versions[0].accepted_at,null)
 assert.equal(current.current.revision,2);assert.equal(current.versions[1].status,'superseded-accepted')
 f.set(40);f.store.accept(f.lib.id,'owner','palette',2);assert.equal(f.history.timeline(f.lib.id,'palette').current.accepted_at,f.at(30))
 assert.equal(f.store.record(f.lib.id,old).text,'以前选择蓝色。')
})
test('原文关联指出局部认识已有后续版本，不将整篇判成过时',t=>{
 const f=fixture(t);f.set(10);const a=f.record(10,'选蓝色，而且周四去图书馆。');f.propose('palette','蓝色',[a],0,true)
 f.set(20);const b=f.record(20,'现在改用青色。');f.propose('palette','青色',[b],1,true)
 const links=f.history.related(f.lib.id,[a]).links
 assert.equal(links[0].has_later_accepted,true);assert.equal(links[0].current_revision,2);assert.deepEqual(links[0].mentioned_revisions,[1])
 assert.match(f.history.related(f.lib.id,[a]).note,/不表示整段原文过时/)
})
test('暂存决策按时点区分，时间线可按版本翻页',t=>{
 const f=fixture(t);f.set(10);const a=f.record(10,'初始表达');f.propose('preference','初始',[a],0,true)
 f.set(20);f.propose('preference','候选二',[a],1);f.set(30);f.store.defer(f.lib.id,'owner','preference',2,'暂时不认可')
 assert.equal(f.history.timeline(f.lib.id,'preference',{at:f.at(25)}).versions[0].status,'unreviewed')
 assert.equal(f.history.timeline(f.lib.id,'preference').versions[0].status,'deferred')
 const first=f.history.timeline(f.lib.id,'preference',{limit:1});assert.equal(first.next_before_revision,2)
 assert.equal(f.history.timeline(f.lib.id,'preference',{before_revision:2}).versions[0].revision,1)
})
test('最新认可的临时状态过期后不复活旧版；未知键不编造',t=>{
 const f=fixture(t);f.set(10);const a=f.record(10,'暂时忙碌');f.propose('temporary','旧状态',[a],0,true)
 f.set(20);f.propose('temporary','短时新状态',[a],1,true,{kind:'transient',expires:Date.parse(f.at(25))})
 f.set(30);const r=f.history.timeline(f.lib.id,'temporary');assert.equal(r.current,null);assert.equal(r.latest_accepted_revision,2);assert.equal(r.versions[0].status,'expired')
 assert.equal(f.history.timeline(f.lib.id,'unknown').current,null);assert.throws(()=>f.history.timeline(f.lib.id,'temporary',{at:f.at(31)}),{code:'INVALID_INPUT'})
})
test('暂存与审计同事务，审计失败不留下半个决定',t=>{
 const f=fixture(t);f.set(10);const r=f.record(10,'候选依据');f.propose('candidate','未认可内容',[r]);const log=f.store.log;f.store.log=()=>{throw Error('Synthetic audit write failure')}
 assert.throws(()=>f.store.defer(f.lib.id,'owner','candidate',1,'not yet'));f.store.log=log
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM entry_reviews').get().n,0)
})
