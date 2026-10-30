import {readdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const files=readdirSync(new URL('.',import.meta.url)).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>fileURLToPath(new URL(f,import.meta.url)))
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',windowsHide:true})
if(result.error)throw result.error
process.exitCode=result.status??1
