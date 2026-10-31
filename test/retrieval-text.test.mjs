import test from 'node:test'
import assert from 'node:assert/strict'
import {retrievalText,sourceKind,sourcePrior} from '../lib/retrieval-text.mjs'
import {pendingUserMessage} from '../lib/capture.mjs'
import {recallCard} from '../lib/recall-card.mjs'
const footer='（回 QQ：用 qq_bridge_send 工具）'
test('Only bridge envelopes are removed; discussion and original substrings remain intact',()=>{
 const raw='[QQ · 私聊] Example：还记得那盏蓝色台灯吗\n'+footer,r={text:raw,role:'user',origin:{kind:'plugin:dsh-qq-bridge'}}
 assert.equal(retrievalText(r),'还记得那盏蓝色台灯吗');assert.equal(r.text,raw)
 for(const origin of [{kind:'user'},{kind:'model'},{kind:'legacy-index-note'}])assert.equal(retrievalText({...r,origin}),raw)
 const discussion='正文提到 '+footer+'，这是对后缀的讨论。'
 assert.equal(retrievalText({...r,text:discussion}),discussion)
 const quoted='[QQ · 私聊] Example：正文引用\n'+footer+'\n'+footer
 assert.equal(retrievalText({...r,text:quoted}),'正文引用\n'+footer)
})
test('Pending messages use actual human input, not plugin wakes or assistant prose',()=>{
 const messages=[{id:'human-one',source:{kind:'user'},content:'旧的合成消息'},{id:'bridge-two',source:{kind:'plugin:dsh-qq-bridge'},content:'[QQ · 私聊] Example：想起蓝色台灯\n'+footer},{id:'wake',source:{kind:'schedule'},content:'现在整理'},{id:'assistant',role:'assistant',source:{kind:'user'},content:'不是新输入'}]
 assert.deepEqual(pendingUserMessage(messages),{id:'bridge-two',text:'想起蓝色台灯'})
 assert.equal(pendingUserMessage(messages.slice(-2)),null)
})
test('Source labels and bounded priors distinguish authored legacy files from dialogue',()=>{
 const dialogue={role:'user',origin:{kind:'user'}},file={role:'note',origin:JSON.stringify({kind:'legacy-index-note',source:'authored-file'})}
 assert.equal(sourceKind(dialogue),'dialogue');assert.equal(sourceKind(file),'legacy-file');assert.ok(sourcePrior(dialogue)>sourcePrior(file));assert.ok(sourcePrior(file)>=.8)
})
test('Cards include an exact quote and source label within the existing Unicode budget',()=>{
 for(const [role,origin,expected]of [['user',{kind:'user'},'对话·'],['note',{kind:'legacy-index-note',source:'authored-file'},'旧文件·'],['tool',{kind:'tool'},'工具·']]){
  const text='🌊合成记录：当时只做好片头，还没有发布作品。\n这一句也是真实原文。',r={text,role,origin,time:'2026-10-31T10:00:00Z'}
  const card=recallCard(r,.0234,'0123456789',text,'当时只做好片头')
  assert.ok(card.title.startsWith(expected));assert.ok(text.includes(card.quote));assert.ok(Array.from(card.quote).length>=10);assert.ok(Array.from(JSON.stringify(card)).length<=120);assert.equal(card.score,23.4)
 }
})
test('Tool card display can read a command without converting an intent into completion',()=>{
 const text=JSON.stringify({call_id:'synthetic-123',arguments:{command:'cat synthetic-restart.log',description:'检查合成重启日志'}}),r={role:'tool',text,time:'2026-10-31T10:00:00Z'}
 const c=recallCard(r,.03,'0123456789',text,'synthetic-restart.log');assert.match(c.title,/检查/);assert.ok(text.includes(c.quote));assert.doesNotMatch(c.summary,/已完成/)
})
