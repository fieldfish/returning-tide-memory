import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {topicEvidence} from '../lib/topic-evidence.mjs'
import {CheckpointResume,wantsResume} from '../lib/checkpoint-resume.mjs'
import {ContinuityStore} from '../lib/store.mjs'
import {ExecutionLedger} from '../lib/execution.mjs'

test('automatic relevance needs the requested subject within a shared project',()=>{
 const docs=['A42以前的封套是青色。','A42的封套现在改为橙色。','A42的申请还没寄出。','B10的封套用黄色。'].map((text,id)=>({id,text,semantic:.87}))
 const s=topicEvidence('还记得A42的封套以前和现在是什么颜色吗？',docs)
 assert.deepEqual([...s.values()],[true,true,false,false])
 assert.equal([...topicEvidence('A42的保险收据号是什么？',docs).values()].some(Boolean),false)
})
test('an isolated semantic lead can recall a paraphrase while a close semantic tie abstains',()=>{
 const docs=[{id:'a',text:'The parcel left the depot.',semantic:.93},{id:'b',text:'Cut the cover sheet.',semantic:.72}]
 assert.equal(topicEvidence('Delivery dispatch?',docs).get('a'),true)
 docs[1].semantic=.92;assert.equal(topicEvidence('Delivery dispatch?',docs).get('a'),false)
})
test('shared natural names, single-character segmentation and answer instructions are not independent evidence',()=>{
 const docs=['松涛藏品室的瓶签底纹采用格纹','松涛藏品室最近更换瓶签底纹','松涛藏品室的柜子只有申请，没有借出','松涛藏品室的摆放计划','晚枫藏品室的瓶签底纹已更新'].map((text,id)=>({id,text,semantic:.85}))
 const recall=q=>[...topicEvidence(q,docs).values()]
 assert.deepEqual(recall('松涛藏品室先前和当下的瓶签底纹怎样？'),[true,true,false,false,false])
 assert.deepEqual(recall('松涛藏品室取得奖章了吗？只有核实才给证书编号。'),[false,false,false,false,false])
})
test('only current execution instructions arm a checkpoint',()=>{
 for(const q of ['之前做到了哪一步？','先不要继续任务','继续查一下进度，不要执行','能否继续','What would resuming involve?'])assert.equal(wantsResume(q),false,q)
 assert.equal(wantsResume('继续上次的归档工作，生成文件。'),true)
 assert.equal(wantsResume('接着做归档任务并执行下一步。不要用历史状态代替本轮报告。'),true)
})
test('a natural project name and a facet jointly distinguish a same-facet neighbor',()=>{
 const docs=['云杉馆的纸张批次为一号。','云杉馆的名牌是银色。','溪石馆的纸张批次为三号。','衣架修好了。'].map((text,id)=>({id,text,semantic:.84}))
 const s=topicEvidence('云杉馆的纸张批次是什么？',docs)
 assert.deepEqual([...s.values()],[true,false,false,false])
})
test('a recall question does not authorize the executor recorded in a checkpoint',()=>{
 const task={task:'inventory',value:{status:'paused',next_tool:'export_sample'},refs:['record']}
 const mgr=new CheckpointResume({tasks:()=>[task],recovery:{needsReview:()=>false}},{frame:()=>null,validRefs:()=>true})
 const agent={session:{id:'test'}}
 mgr.begin('lib',agent,1,'还记得当时的颜色吗？')
 assert.throws(()=>mgr.assertAction('lib','test','export_sample'),{code:'CHECKPOINT_INQUIRY_ONLY'})
 assert.doesNotThrow(()=>mgr.assertAction('other','test','export_sample'))
 assert.doesNotThrow(()=>mgr.assertAction('lib','test','unrelated_tool'))
 mgr.clear('test');assert.doesNotThrow(()=>mgr.assertAction('lib','test','export_sample'))
})
test('resume is bounded by revision, ownership, real result sources and duplicate dispatch',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rt-resume-test-')),store=new ContinuityStore(dir)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const lib=store.create('Fixture').id;store.bind('a',lib,0)
 const add=(seq,text,role='user')=>store.append(lib,{session:'a',seq,time:new Date().toISOString(),role,type:role==='tool'?'tool/result':'user/message',text})
 const evidence=add(1,'A draft exists.'),ledger=new ExecutionLedger(store)
 store.checkpoint(lib,'a','draft',{status:'paused',progress:'Draft saved',next_step:'Export the proof.'},[evidence],0)
 const mgr=new CheckpointResume(store,{frame:()=>({refs:[evidence]}),validRefs:()=>true,focusCheckpoint:()=>{}})
 const agent={session:{id:'a'},ctx:{tools:{get:n=>n==='save_proof'?{}:undefined}}}
 mgr.begin(lib,agent,2,'继续查看任务进度，只汇报')
 assert.equal(mgr.progress(lib,'a').pending_step,'Export the proof.')
 assert.equal(mgr.current(lib,'a'),null);assert.equal(mgr.remind(lib,agent,2),null)
 mgr.begin(lib,agent,3,'Resume draft with save_proof.')
 assert.equal(mgr.current(lib,'a').active.tool,'save_proof')
 assert.ok(mgr.remind(lib,agent,3));assert.equal(mgr.remind(lib,agent,3),null)
 const done={task:'draft',value:{status:'done'},refs:[evidence]}
 assert.throws(()=>mgr.checkCompletion(lib,'a',done),{code:'CHECKPOINT_RECEIPT_REQUIRED'})
 const call={name:'save_proof',callId:'one',arguments:{out:'one'}}
 ledger.start(lib,'a',call,false,mgr.current(lib,'a').active)
 ledger.complete(lib,'a','one',{isError:false,value:{ok:true}},{seq:3})
 const output=add(3,'Output saved.','tool')
 assert.throws(()=>mgr.checkCompletion(lib,'a',done),{code:'CHECKPOINT_RECEIPT_REQUIRED'})
 mgr.checkCompletion(lib,'a',{...done,refs:[output]})
 assert.throws(()=>ledger.start(lib,'a',{...call,callId:'again'},false,mgr.current(lib,'a').active),{code:'CHECKPOINT_ALREADY_ATTEMPTED'})
 mgr.begin(lib,agent,4,'Resume draft with save_proof.')
 assert.equal(mgr.remind(lib,agent,4),null)
 store.checkpoint(lib,'a','draft',{status:'done',progress:'Proof checked'},[output],1)
 assert.equal(mgr.current(lib,'a'),null)
 const retry={task:'other-step',revision:1,tool:'edit'},edit={name:'edit',callId:'preflight',arguments:{file_path:'x'}}
 ledger.start(lib,'a',edit,false,retry)
 ledger.complete(lib,'a',edit.callId,{isError:true,error:{info:{name:'FsError',code:'FS_NOT_OBSERVED'}}},
   {trust:{nativeEdit:true,editIntentRejected:true,editIntentCode:'FS_NOT_OBSERVED'}})
 assert.doesNotThrow(()=>ledger.start(lib,'a',{...edit,callId:'after-read'},false,retry))
})
