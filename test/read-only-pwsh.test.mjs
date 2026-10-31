import test from 'node:test'
import assert from 'node:assert/strict'
import {readOnlyPwsh} from '../lib/read-only-pwsh.mjs'
import {readOnlyTool} from '../lib/recovery.mjs'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ContinuityStore} from '../lib/store.mjs'

test('native PowerShell literal diagnostics and pipes are recognized without executing scripts',()=>{
 for(const command of ['Get-Content -LiteralPath "C:\\synthetic\\README.md" -TotalCount 20','Get-ChildItem -Path . -File -Recurse -Depth 2 | Select-Object -First 5 -Property Name,Length','Get-Process -Name node | Select-Object Id,ProcessName','Test-Path -LiteralPath .','Get-Location; Get-FileHash README.md -Algorithm SHA256','Get-Content "file; name.txt"','Select-String -Path README.md -Pattern "read|write" -SimpleMatch','Get-Item .\nGet-Location'])assert.equal(readOnlyPwsh(command),true,command)
})
test('PowerShell expansion, writes, background execution and script delegation remain unclassified',()=>{
 for(const command of ['Get-Content a > b','Get-Content a; Remove-Item b','Get-Content $(New-Item marker)','Get-Content $env:SECRET','Get-Content `"a`"','& Get-Content a','Invoke-Expression "Get-Content a"','pwsh -Command "Get-Content a"','Get-Content a | Set-Content b','Get-ChildItem | ForEach-Object { Remove-Item $_ }','Get-Content a -Wait','Get-Content a -Unknown','Get-Content a -ErrorAction Ignore','Get-Content "unterminated','Get-Content a && Remove-Item b'])assert.equal(readOnlyPwsh(command),false,command)
 assert.equal(readOnlyTool('pwsh',{command:'Get-Content a',run_in_background:true}),false)
 assert.equal(readOnlyTool('pwsh',{command:'Get-Content a',env:{X:'value'}}),false)
 assert.equal(readOnlyTool('pwsh',{command:'Get-Content a',workdir:'C:/synthetic',timeoutMs:1000}),true)
})
test('host searches stay available during recovery and historical misclassifications are repaired on restart',t=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-native-reads-'));let store=new ContinuityStore(dir)
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const lib=store.create('Synthetic reads');store.bind('owner',lib.id,0)
 const insert=store.db.prepare('INSERT INTO cm_tool_operations(library,session,call_id,name,args_digest,readonly,status,time) VALUES(?,?,?,?,?,?,?,?)')
 for(const name of ['grep','glob'])insert.run(lib.id,'owner',name,name,'old-classification',0,'uncertain',Date.now())
 store.close();store=new ContinuityStore(dir);assert.equal(store.recovery.needsReview(lib.id),false)
 assert.equal(store.db.prepare("SELECT count(*) n FROM cm_tool_operations WHERE readonly=1 AND status='failed'").get().n,2)
 store.db.prepare('INSERT INTO cm_tool_operations(library,session,call_id,name,args_digest,readonly,status,time) VALUES(?,?,?,?,?,?,?,?)').run(lib.id,'owner','send','synthetic_send','write',0,'uncertain',Date.now())
 for(const [name,args]of [['grep',{pattern:'lamp'}],['glob',{pattern:'**/*.md'}],['pwsh',{command:'Get-Content README.md'}],['cm_working',{action:'link-status'}],['cm_working',{action:'focus'}],['cm_checkpoint',{action:'write'}],['cm_self',{action:'propose'}]])assert.doesNotThrow(()=>store.recovery.assertTool(lib.id,name,args))
 assert.throws(()=>store.recovery.assertTool(lib.id,'pwsh',{command:'Remove-Item README.md'}),{code:'RECOVERY_REVIEW_REQUIRED'})
 assert.equal(readOnlyTool('cm_checkpoint',{action:'write'}),false);assert.equal(store.recovery.pending(lib.id).operations.length,1)
})
test('normal operation does not impose a read-only policy on native tools',t=>{
 const dir=mkdtempSync(join(tmpdir(),'cm-normal-tools-')),store=new ContinuityStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const lib=store.create('Synthetic normal tools');store.bind('owner',lib.id,0)
 for(const [name,args]of [['pwsh',{command:'Set-Content output.txt hello'}],['write',{file_path:'output.txt'}],['synthetic_send',{}]])assert.doesNotThrow(()=>store.recovery.assertTool(lib.id,name,args))
})
