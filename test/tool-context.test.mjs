import test from 'node:test'
import assert from 'node:assert/strict'
import {ToolContext} from '../lib/tool-context.mjs'

function fixture(enabled=true){const events=[],working={config:{enabled},signalEvent:(...args)=>events.push(args)};return {events,context:new ToolContext(working)}}
test('同一回合切换工具活动线索触发，无需新用户消息',()=>{
 const f=fixture();f.context.observe('lib','owner','browser_navigate',{url:'https://example.org/video/one'});assert.equal(f.events.length,0)
 f.context.observe('lib','owner','desktop_click',{application:'Synthetic Game'});assert.equal(f.events.length,1);assert.equal(f.events[0][2],'task-switch');assert.match(f.events[0][4],/Synthetic Game/)
 f.context.observe('lib','owner','desktop_type',{text:'some new text'});assert.equal(f.events.length,1)
})
test('页面凭据、选择器、输入文字和shell代码不进入任务线索',()=>{
 const f=fixture();f.context.observe('lib','owner','browser_navigate',{url:'https://user:password@example.org/video?token=secret#private'});f.context.observe('lib','owner','shell_exec',{command:'private command',password:'secret'})
 assert.equal(f.events.length,1);assert.doesNotMatch(f.events[0][4],/private command|password|secret|token=/)
})
test('URL查询参数变化不重复触发，明确应用变化可以触发',()=>{
 const f=fixture();f.context.observe('lib','owner','browser_navigate',{url:'https://example.org/video?a=1'});f.context.observe('lib','owner','browser_navigate',{url:'https://example.org/video?a=2'});assert.equal(f.events.length,0)
 f.context.observe('lib','owner','desktop_click',{application:'Editor'});f.context.observe('lib','owner','desktop_click',{application:'Game'});assert.equal(f.events.length,2)
})
test('内部工具、关闭功能、不同owner与清理不制造假切换',()=>{
 const f=fixture();f.context.observe('lib','owner','cm_read',{});assert.equal(f.context.sessions.size,0)
 f.context.observe('lib','owner','browser_open',{});f.context.observe('lib','other','desktop_click',{});assert.equal(f.events.length,0)
 f.context.clear('owner');f.context.observe('lib','owner','shell_exec',{});assert.equal(f.events.length,0);f.context.clear();assert.equal(f.context.sessions.size,0)
 const off=fixture(false);off.context.observe('lib','owner','browser_open',{});assert.equal(off.context.sessions.size,0)
})
