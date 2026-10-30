import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'continuity-situation-test-'));let now=Date.parse('2026-10-29T08:00:00Z'),seq=0
  const store=new ContinuityStore(dir,{now:()=>now}),lib=store.create('合成情境');store.bind('owner',lib.id,0)
  const situations=new Situations(store,new Scenes(store))
  const append=(text,extra={})=>store.append(lib.id,{session:'owner',seq:++seq,time:new Date(now).toISOString(),role:'assistant',text,...extra})
  const source=append('我想剪一个海边视频，现在还没剪完')
  const create=(title='海边视频',extra={})=>situations.create(lib.id,'owner',{title,refs:[source],mode:'experience',...extra})
  t.after(()=>{store.close();const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('continuity-situation-test-'));rmSync(target,{recursive:true,force:true})})
  return {dir,store,lib,situations,append,source,create,advance:n=>{now+=n}}
}
test('情境版本追加原话与后来解释，按记录时间回看，不改原始文本',t=>{
  const f=fixture(t),body='昨天停下来时说自己累了',s=f.create('视频任务',{assertions:[{slot:'self-report',body,refs:[f.source],event_time:'2026-10-28T20:00:00+08:00'}]})
  f.advance(60000);const later=f.append('现在回看，当时是对选题不满意')
  const d=f.situations.revise(f.lib.id,'owner',s.id,{expected_revision:1,refs:[later],reason:'后来重新理解',append_assertions:[{slot:'interpretation',body:'现在认为当时对选题不满意',refs:[later],attributed_to:'TestAgent的后来自述'}]})
  assert.equal(d.revision,2);assert.equal(d.assertions.length,2);assert.equal(d.assertions[0].body,body)
  assert.equal(f.situations.get(f.lib.id,s.id,{at:'2026-10-29T08:00:30Z'}).revision,1)
  assert.equal(f.situations.get(f.lib.id,s.id,{revision:1}).assertions.length,1)
  assert.equal(f.store.record(f.lib.id,f.source).text,'我想剪一个海边视频，现在还没剪完')
  assert.throws(()=>f.situations.revise(f.lib.id,'owner',s.id,{expected_revision:1,refs:[later],reason:'过期写入'}),{code:'CONFLICT'})
})
test('一条来源可关联多个情境，自动关联不生成完成事实',t=>{
  const f=fixture(t),a=f.create(),b=f.create('游戏时的闲聊');f.situations.focus(f.lib.id,'owner',a.id)
  const r=f.append('还没完成，先去玩游戏');f.situations.observe(f.lib.id,'owner',r);f.situations.attach(f.lib.id,'owner',b.id,[r])
  assert.equal(f.situations.related(f.lib.id,[r]).length,2);assert.equal(f.situations.get(f.lib.id,a.id).assertions.length,0)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM records WHERE id=?').get(r).n,1)
})
test('创作与实际自述分开标记，短包保留归属与出处',t=>{
  const f=fixture(t),fiction=f.append('小说：我昨天去海边了'),s=f.create('海边小说',{mode:'creative',refs:[fiction]})
  const reaction=f.append('写这一段让我很喜欢');f.situations.revise(f.lib.id,'owner',s.id,{expected_revision:1,refs:[reaction],reason:'创作反馈',append_assertions:[{slot:'self-report',body:'喜欢写这段',refs:[reaction],attributed_to:'作者自述'}]})
  const c=f.situations.capsule(f.lib.id,s.id);assert.equal(c.mode,'creative');assert.equal(c.statements[0].attributed_to,'作者自述');assert.ok(Array.from(JSON.stringify(c)).length<=650)
  assert.ok(!JSON.stringify(c.statements).includes('去海边了'))
})
test('相似情境只建立可能关联，合并可撤销且不移动或删除来源',t=>{
  const f=fixture(t),a=f.create(),b=f.create('另一个作品'),args={expected_revision:1,expected_target_revision:1,refs:[f.source],reason:'明确依据'}
  const possible=f.situations.link(f.lib.id,'owner',a.id,b.id,args);assert.equal(possible.kind,'possible')
  const merge=f.situations.link(f.lib.id,'owner',a.id,b.id,{...args,kind:'merged'})
  assert.equal(f.situations.unlink(f.lib.id,'owner',merge.id,1).active,false)
  assert.equal(f.situations.get(f.lib.id,a.id).source_count,1);assert.equal(f.situations.get(f.lib.id,b.id).source_count,1)
  const merge2=f.situations.link(f.lib.id,'owner',a.id,b.id,{...args,kind:'merged'})
  f.situations.revise(f.lib.id,'owner',b.id,{expected_revision:1,refs:[f.source],reason:'合并后的新整理'})
  assert.throws(()=>f.situations.unlink(f.lib.id,'owner',merge2.id,1),{code:'MERGE_HAS_LATER_CHANGES'})
})
test('任务与子情境关联不会产生父子循环',t=>{
  const f=fixture(t),a=f.create(),b=f.create('剪片子'),c=f.create('片头修改'),args={kind:'part-of',expected_revision:1,expected_target_revision:1,refs:[f.source],reason:'任务结构'}
  f.situations.link(f.lib.id,'owner',c.id,b.id,args);f.situations.link(f.lib.id,'owner',b.id,a.id,args)
  assert.throws(()=>f.situations.link(f.lib.id,'owner',a.id,c.id,args),{code:'RELATION_CYCLE'})
})
test('删除出处立即停止返回对应表述，旧版本也不重新泄漏',t=>{
  const f=fixture(t),s=f.create('私人标题',{assertions:[{slot:'self-report',body:'私人的原话',refs:[f.source]}]})
  f.store.removeRecord(f.lib.id,'owner',f.source)
  for(const options of [{},{revision:1}]){const d=f.situations.get(f.lib.id,s.id,options);assert.equal(d.title,'[标题出处已移除]');assert.equal(d.assertions.length,0);assert.equal(d.omitted_assertions,1)}
})
test('情境焦点只属于活动主会话，暂停清空；明确交接可继承',t=>{
  const f=fixture(t),s=f.create();f.situations.focus(f.lib.id,'owner',s.id)
  assert.equal(f.situations.current(f.lib.id,'other'),null);assert.throws(()=>f.situations.focus(f.lib.id,'other',s.id),{code:'NOT_OWNER'})
  f.store.transfer(f.lib.id,'owner','next',f.store.library(f.lib.id).revision)
  assert.equal(f.situations.current(f.lib.id,'next').id,s.id);f.situations.focus(f.lib.id,'next',null);assert.equal(f.situations.current(f.lib.id,'next'),null)
  f.situations.revise(f.lib.id,'next',s.id,{expected_revision:1,refs:[f.source],reason:'先休息',status:'paused'})
  assert.throws(()=>f.situations.focus(f.lib.id,'next',s.id),{code:'SITUATION_NOT_ACTIVE'})
})
test('重建服务仍读到版本与焦点，分页不遗漏或重复',t=>{
  const f=fixture(t),s=f.create();f.situations.focus(f.lib.id,'owner',s.id)
  for(let n=1;n<5;n++)f.situations.revise(f.lib.id,'owner',s.id,{expected_revision:n,refs:[f.source],reason:'增量版本'+n})
  const restarted=new Situations(f.store,new Scenes(f.store));assert.equal(restarted.current(f.lib.id,'owner').revision,5)
  const first=restarted.timeline(f.lib.id,s.id,{limit:3}),second=restarted.timeline(f.lib.id,s.id,{before_revision:first.next_before_revision,limit:3})
  assert.deepEqual([...first.versions,...second.versions].map(v=>v.revision),[5,4,3,2,1]);assert.equal(second.next_before_revision,null)
})
test('情境内容强制有出处、跨库隔离、拒绝无时区事件时间',t=>{
  const f=fixture(t),other=f.store.create('别的库'),s=f.create()
  assert.throws(()=>f.situations.get(other.id,s.id),{code:'NOT_FOUND'})
  assert.throws(()=>f.create('没有出处',{refs:[]}),{code:'INVALID_EVIDENCE'})
  assert.throws(()=>f.create('模糊时间',{assertions:[{slot:'self-report',body:'今天',refs:[f.source],event_time:'2026-10-29T12:00:00'}]}),{code:'INVALID_INPUT'})
})
test('连续多次交接和接回旧窗口继承最新焦点，不复活旧任务',t=>{
  const f=fixture(t),a=f.create('旧任务'),b=f.create('当前任务');f.situations.focus(f.lib.id,'owner',a.id)
  f.situations.handoff(f.lib.id,'owner','next',f.store.library(f.lib.id).revision);f.situations.focus(f.lib.id,'next',b.id)
  f.situations.handoff(f.lib.id,'next','third',f.store.library(f.lib.id).revision);assert.equal(f.situations.current(f.lib.id,'third').id,b.id)
  f.situations.handoff(f.lib.id,'third','owner',f.store.library(f.lib.id).revision);assert.equal(f.situations.current(f.lib.id,'owner').id,b.id)
})
