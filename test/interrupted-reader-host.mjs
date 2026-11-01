import {fork} from 'node:child_process'
import {once} from 'node:events'
import {existsSync,readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {ContinuityStore} from '../lib/store.mjs'

// Terminate only our isolated child, after its provider reports it has entered.
const results=[]
for(const mode of ['read','write','shadow']){
  const child=fork(fileURLToPath(new URL('./native-failure-host.mjs',import.meta.url)),['--desktop-preset','--interrupt='+mode],{silent:true})
  child.stdout.resume();child.stderr.resume()
  const exited=once(child,'exit')
  let timer
  try{
    const [info]=await Promise.race([once(child,'message'),exited.then(()=>{throw Error('Fixture exited before the barrier')}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture timed out')),60000)})])
    assert.equal(info.mode,mode);child.kill('SIGKILL');await exited
    for(let pass=0;pass<2;pass++){
      const store=new ContinuityStore(info.directory)
      try{
        const op=store.db.prepare("SELECT status,readonly,stage FROM cm_tool_operations WHERE session=? AND call_id='interrupted-body'").get(info.sid)
        assert.equal(op.readonly,mode==='read'?1:0)
        assert.equal(op.status,mode==='read'?'failed':'uncertain')
        if(mode==='read')assert.equal(op.stage,'verified-provider-entry')
        assert.equal(store.recovery.pending(info.library).operations.length,mode==='read'?0:1)
        assert.equal(existsSync(info.witness),mode!=='read')
        if(mode!=='read')assert.equal(readFileSync(info.witness,'utf8'),'one effect')
        if(pass===1)results.push({mode,status:op.status,pending:mode==='read'?0:1})
      }finally{store.close()}
    }
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill();await exited}}
}
console.log(JSON.stringify({cases:results,live_messages:0}))
