// node evals/lexical-index-benchmark.mjs <unpacked-v0.3.9> [record counts...]
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir,cpus,totalmem} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'

const script=fileURLToPath(import.meta.url)
const current=fileURLToPath(new URL('../',import.meta.url))
const baseline=resolve(process.argv[2])
const dimensions=1024
const model='synthetic-unit-vectors'
const queries=['QPROJ00000012','水杉计划','珊瑚档案','QPROJ00000421','海洋笔记','QPROJ00001987','不存在的蜂蜜菜谱','散步记录','QPROJ00003301','蓝灰台灯','QPROJ00007654','不存在的月球咖啡']
async function modules(root) {
  const load=file=>import(pathToFileURL(join(root,'lib',file)).href)
  return [(await load('store.mjs')).ContinuityStore,(await load('embedding.mjs')).Embedding]
}
function vector(axis) {
  const values=new Float32Array(dimensions)
  values[axis]=1
  return values
}
async function makeFixture(directory,count) {
  const [Store,Engine]=await modules(baseline)
  const store=new Store(directory),engine=new Engine(store),lib=store.create('Synthetic benchmark')
  store.bind('owner',lib.id,0)
  const chunk=store.db.prepare('INSERT INTO cm_vector_chunks VALUES(?,?,?,?,?)')
  const vectorRow=store.db.prepare('INSERT INTO cm_vectors VALUES(?,?,?,?,?,?)')
  const prepared=store.db.prepare('INSERT INTO cm_vector_prepared VALUES(?,?)')
  store.tx(()=>{
    for(let i=0;i<count;i++) {
      const code='QPROJ'+String(i).padStart(8,'0')
      const topic=i===21?'水杉计划':i===43?'珊瑚档案':i===65?'蓝灰台灯':i%7===0?'海洋笔记':'散步记录'
      const text='本条仅用于检索性能对照实验。'.repeat(18)+topic+' '+code
      const rid=store.append(lib.id,{session:'fixture',seq:i,time:'2026-01-01T00:00:00Z',role:'user',text})
      chunk.run(lib.id,rid,0,text,createHash('sha256').update(text).digest('hex'))
      prepared.run(rid,lib.id)
      vectorRow.run(lib.id,rid,0,model,dimensions,Buffer.from(vector(i%(dimensions-1)).buffer))
    }
  })
  engine.close()
  store.close()
  return lib.id
}
async function measure(root,directory,library) {
  const [Store,Engine]=await modules(root)
  const dbFile=join(directory,'continuity.sqlite3')
  const diskBefore=statSync(dbFile).size
  const start=performance.now()
  const store=new Store(directory),engine=new Engine(store)
  if(engine.lexicalIndex)while(engine.lexicalIndex.buildBatch(library)>0){}
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const buildMs=performance.now()-start,diskDelta=statSync(dbFile).size-diskBefore
  engine.identity=async()=>model
  engine.embed=async ([query])=>{
    const specific={水杉计划:21,珊瑚档案:43,蓝灰台灯:65}
    const axis=query.includes('不存在')?dimensions-1:(specific[query]??Number(query.match(/\d+/)?.[0]??0))%(dimensions-1)
    return [vector(axis)]
  }
  const rows=[]
  // Two warm-ups precede two measured passes in the same query order.
  for(const query of [...queries.slice(0,2),...queries,...queries]) {
    const at=performance.now()
    const out=await engine.lookup(library,'owner',query,5,null,null,{readOnlyIndex:true})
    rows.push({query,ms:performance.now()-at,cards:out.results})
    if(query.includes('不存在'))assert.equal(out.results.length,0)
  }
  engine.close()
  store.close()
  return {buildMs,diskDelta,peakRssKiB:process.resourceUsage().maxRSS,rows:rows.slice(2)}
}
if(process.argv[3]==='measure') {
  console.log(JSON.stringify(await measure(process.argv[4],process.argv[5],process.argv[6])))
} else {
  const counts=process.argv.slice(3).map(Number)
  const report={node:process.version,platform:process.platform,cpu:cpus()[0].model,ramGiB:totalmem()/2**30,dimensions,queries,modelCalls:0,sizes:[]}
  const runDirectory=mkdtempSync(join(tmpdir(),'rt-lex-benchmark-'))
  for(const count of counts.length?counts:[10000,50000]) {
    assert.ok(Number.isSafeInteger(count)&&count>=8000)
    const directory=join(runDirectory,String(count)),library=await makeFixture(directory,count)
    const runs=[]
    for(const root of [baseline,current]) {
      const child=spawnSync(process.execPath,[script,baseline,'measure',root,directory,library],{encoding:'utf8',windowsHide:true})
      assert.equal(child.status,0,child.stderr)
      runs.push(JSON.parse(child.stdout))
    }
    assert.deepEqual(runs[0].rows.map(r=>r.cards),runs[1].rows.map(r=>r.cards))
    const stats=runs.map(run=>{
      const times=run.rows.map(r=>r.ms).sort((a,b)=>a-b)
      return {medianMs:(times[11]+times[12])/2,p95Ms:times[22],peakRssKiB:run.peakRssKiB,setupMs:run.buildMs,databaseGrowthBytes:run.diskDelta}
    })
    report.sizes.push({count,checks:runs[0].rows.length,identicalCards:true,baseline:stats[0],indexed:stats[1]})
    writeFileSync(join(runDirectory,'results.json'),JSON.stringify(report,null,2))
    console.log(JSON.stringify(report.sizes.at(-1)))
  }
  console.log(join(runDirectory,'results.json'))
}
