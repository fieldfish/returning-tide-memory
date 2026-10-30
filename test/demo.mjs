import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {ContinuityStore} from '../lib/store.mjs'

// All events below are explicitly synthetic fixtures, never the user's AI's experiences.
const directory=mkdtempSync(join(tmpdir(),'continuity-demo-')),store=new ContinuityStore(directory)
try {
  const lib=store.create('合成接续演示，不是真实经历');store.bind('previous',lib.id,0)
  const a=store.append(lib.id,{session:'previous',seq:1,time:'2026-10-28T09:00:00+08:00',role:'user',type:'user/message',text:'测试约定：先完成草稿，再决定是否发布。'})
  const b=store.append(lib.id,{session:'previous',seq:2,time:'2026-10-28T09:01:00+08:00',role:'assistant',type:'assistant/message',text:'经过这次对比，我暂时更喜欢简洁的样式，因为正文更容易阅读。'})
  store.propose(lib.id,{key:'style',kind:'preference',body:'当前表达偏爱简洁样式',reason:'对比后说明正文易读，允许以后修订',refs:[b]},true)
  store.propose(lib.id,{key:'agreement',kind:'relationship',body:'约定先完成草稿，再决定发布',reason:'双方交流中的具体约定',refs:[a]},true)
  store.checkpoint(lib.id,'previous','draft',{status:'paused',progress:'只有草稿，还没有验收或发布',next_step:'核对草稿后再决定'},[a],0)
  store.transfer(lib.id,'previous','next',1)
  const recovered=store.restore(lib.id,'next')
  assert.match(recovered.text,/正文易读/);assert.match(recovered.text,/没有验收或发布/);assert.match(recovered.text,/先完成草稿/)
  assert.throws(()=>store.assertOwner(lib.id,'previous'),{code:'NOT_OWNER'})
  store.markRestored('next');assert.equal(store.restore(lib.id,'next'),null)
  store.markCompacted('next');assert.ok(store.restore(lib.id,'next'))
  console.log(JSON.stringify({synthetic:true,cloud_calls:0,embedding_calls:0,previous_owner_blocked:true,preference_reason_preserved:true,agreement_preserved:true,unfinished_task_preserved:true,compaction_restore_triggered:true,restore_characters:recovered.characters,estimated_tokens:recovered.estimated_tokens,note:'数据流演示；没有测试真实模型人格、原生DSH或Windows'},null,2))
}finally{store.close();rmSync(directory,{recursive:true,force:true})}
