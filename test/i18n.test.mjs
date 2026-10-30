import test from 'node:test'
import assert from 'node:assert/strict'
import {EN,makeTranslator} from '../web/i18n.mjs'

test('interface translation preserves interpolated titles, IDs and original text literally',()=>{
 const en=makeTranslator('en'),zh=makeTranslator('zh'),title='刷新 {1} <b>source text</b>',id='synthetic-id'
 const parts=['','\n当前主会话：','\n库状态：',' · 当前执行：','\n经历原文：',' 条 · 已索引分片：',' · 待索引：','']
 const english=en(parts,title,id,'Healthy','Idle',8,6,2)
 assert.ok(english.includes(title));assert.ok(english.includes('Current main session: '+id));assert.ok(english.includes('indexed chunks: 6'))
 assert.ok(zh(parts,title,id,'正常','空闲',8,6,2).includes(title+'\n当前主会话：'+id))
 assert.equal(en('刷新'),'Refresh');assert.equal(en('Unmapped source text'),'Unmapped source text')
})

test('all interface translations preserve template positions and include the completed release status',()=>{
 const positions=text=>[...text.matchAll(/\{(\d+)\}/g)].map(m=>m[1]).sort()
 assert.ok(Object.keys(EN).length>=246)
 for(const [key,value]of Object.entries(EN)){assert.equal(typeof value,'string');assert.deepEqual(positions(value),positions(key),key)}
 assert.equal(makeTranslator('en')('已完成 · 正式版 · Returning Tide Memory'),'Completed · Stable release · Returning Tide Memory')
})
