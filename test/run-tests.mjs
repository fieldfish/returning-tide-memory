import {readdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const files=readdirSync(new URL('.',import.meta.url)).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>fileURLToPath(new URL(f,import.meta.url)))
// Bound concurrent SQLite-heavy workers on Windows CI instead of contending for every CPU's I/O.
const result=spawnSync(process.execPath,['--test','--test-concurrency=2',...files],{stdio:'inherit',windowsHide:true})
if(result.error)throw result.error
process.exitCode=result.status??1
