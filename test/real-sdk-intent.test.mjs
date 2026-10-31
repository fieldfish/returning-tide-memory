import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const runtime=process.env.DSH_SDK_RUNTIME
// Uses the real official policy package when a DSH runtime directory is provided. It proves the
// contract this plugin relies on: the native edit guard rejects at fs/edit-intent before any write.
test('the official observation policy rejects an unread edit at fs/edit-intent before any mutation',{skip:!runtime?'set DSH_SDK_RUNTIME to a DSH runtime directory':false},async t=>{
 const policy=join(runtime,'node_modules','@deepseek-ai','dsh-fs-observation-policy','lib','index.js')
 if(!existsSync(policy)){t.skip('official fs-observation-policy not present in DSH_SDK_RUNTIME');return}
 const {apply}=await import(pathToFileURL(policy).href)
 const listeners=[]
 const ctx={on:(name,fn)=>{listeners.push({name,fn});return()=>{}},effect:fn=>{const dispose=fn();return()=>dispose?.()}}
 apply(ctx)
 const dispatch=async(target,actor)=>{const chain=listeners.filter(listener=>listener.name==='fs/edit-intent');let next=async()=>undefined;for(const listener of [...chain].reverse()){const downstream=next;next=()=>listener.fn(target,actor,downstream)}return next()}
 const target={targetKey:'synthetic-target',displayPath:'synthetic.txt'},actor={agent:{session:{id:'synthetic-session'}}}
 await assert.rejects(()=>dispatch(target,actor),error=>error.code==='FS_NOT_OBSERVED')
 const observed=listeners.find(listener=>listener.name==='fs/observed')
 assert.ok(observed,'the policy registers its observation listener')
 observed.fn(target,{kind:'present',version:1},actor)
 assert.deepEqual(await dispatch(target,actor),{version:1})
})
