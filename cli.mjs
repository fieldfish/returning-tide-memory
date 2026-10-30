#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ContinuityStore } from './lib/store.mjs'
import { safeError, fail } from './lib/util.mjs'
import {snapshot,restoreCopy} from './lib/snapshot.mjs'
import {openManager} from './lib/manager-open.mjs'

if(process.argv.includes('--doctor')) {
  console.log(JSON.stringify({node:process.version,sqlite:'node:sqlite',cloud_calls:0,embedding:'local-ollama-optional-until-bound',host_tested:false}));process.exit(0)
}
const at=process.argv.indexOf('--data')
if(at<0||!process.argv[at+1]){console.error('Usage: node cli.mjs --data ABSOLUTE_DIRECTORY < request.json');process.exit(2)}
let store
try {
  if(process.argv.includes('--open-manager')){console.log(JSON.stringify({ok:true,result:openManager(resolve(process.argv[at+1]))}));process.exit(0)}
  const request=JSON.parse(readFileSync(0,'utf8'))
  if(request.action==='restore-copy'){
    const result=restoreCopy(request.snapshot,resolve(process.argv[at+1]))
    console.log(JSON.stringify({ok:true,result}));process.exit(0)
  }
  store=new ContinuityStore(resolve(process.argv[at+1]))
  let result
  switch(request.action) {
    case 'create':result=store.create(request.name);break
    case 'list':result=store.list();break
    case 'snapshot':result=snapshot(store,request.path);break
    case 'recovery-status':result={pending:store.recovery.pending(request.library_id),writes_require_review:store.recovery.needsReview(request.library_id)};break
    case 'recovery-review': {
      store.assertOwner(request.library_id,request.session)
      if(store.busy(request.library_id))fail('BUSY','请先等待活动结束')
      result=store.recovery.resolve(request.library_id,{session:request.operation_session??request.session,call_id:request.call_id,legacy_id:request.legacy_id,decision:request.decision,note:request.note});break
    }
    case 'review-restored-copy': {
      if(typeof request.reason!=='string'||!request.reason.trim()||request.reason.length>2000)fail('INVALID_INPUT','需要人工核查说明')
      store.tx(()=>{
        store.casLibrary(request.library_id,request.expected_revision)
        const lib=store.library(request.library_id)
        if(lib.owner!==null||lib.error!=='RESTORED_COPY_REQUIRES_REVIEW')fail('CONFLICT','不是待核查的未绑定恢复副本')
        store.db.prepare('UPDATE libraries SET error=NULL WHERE id=?').run(lib.id)
        store.log(lib.id,'human-restored-copy-review',{reason:request.reason,replayed:false})
      });result={reviewed:true,bound:false,replayed:false};break
    }
    case 'bind':result=store.bind(request.session,request.library_id,request.expected_revision);break
    case 'import':result={ids:request.records.map(r=>store.append(request.library_id,r))};break
    case 'report':result=store.report(request.library_id);break
    case 'export-report': {
      const target=resolve(request.path),report=store.report(request.library_id)
      mkdirSync(dirname(target),{recursive:true});writeFileSync(target,'# 接续与自我状态记录\n\n本文件为按需导出的状态证据，不是人格指令或亲历材料。实际用量与字符估算分列。\n\n```json\n'+JSON.stringify(report,null,2)+'\n```\n',{encoding:'utf8',flag:'wx',mode:0o600})
      result={path:target};break
    }
    case 'restore':result=store.restore(request.library_id,request.session,{force:true});break
    case 'read':result=store.read(request.library_id,request.id,request.offset??0,request.limit??2000);break
    case 'backup': {
      const target=resolve(request.path);if(existsSync(target))fail('DESTINATION_EXISTS','备份路径已存在，未覆盖')
      mkdirSync(dirname(target),{recursive:true})
      store.db.exec(`VACUUM INTO '${target.replace(/'/g,"''")}'`);result={path:target,note:'一致性数据库快照；不是DSH原日志、模型或完整工作区备份'};break
    }
    default:fail('INVALID_INPUT','不支持的CLI操作；运行中的会话通过插件工具管理，CLI不会冒充宿主交接')
  }
  console.log(JSON.stringify({ok:true,result}))
}catch(e){console.error(JSON.stringify({ok:false,...safeError(e)}));process.exitCode=1}
finally{store?.close()}
