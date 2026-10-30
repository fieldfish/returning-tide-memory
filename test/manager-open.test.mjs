import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {managerAddress} from '../lib/manager-open.mjs'
test('管理入口仅接受存活后台的本机地址，拒绝外部地址及无效令牌',t=>{
 const dir=mkdtempSync(join(tmpdir(),'manager-open-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const write=url=>writeFileSync(join(dir,'manager-access.json'),JSON.stringify({pid:process.pid,url}))
 assert.throws(()=>managerAddress(dir),{code:'MANAGER_UNAVAILABLE'})
 write('https://evil.invalid/#'+'a'.repeat(64));assert.throws(()=>managerAddress(dir),{code:'INVALID_MANAGER_ADDRESS'})
 write('http://127.0.0.1:12345/#bad');assert.throws(()=>managerAddress(dir),{code:'INVALID_MANAGER_ADDRESS'})
 const url='http://127.0.0.1:12345/#'+'a'.repeat(64);write(url);assert.equal(managerAddress(dir),url)
})
