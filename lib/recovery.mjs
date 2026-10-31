/** Operational recovery journal. An expired process lease must never lock conversation. */
import {uuid,hash,fail,text,clip} from './util.mjs'
import {dshToolEvent} from './dsh-events.mjs'
import {readOnlyShell} from './read-only-shell.mjs'
import {fileURLToPath} from 'node:url'

const READ_ONLY=new Set(['read','read_image','ls','rg','cm_read','cm_lookup','cm_report','cm_scene'])
// These tools only change transactional local control state. Inspect that state on recovery;
// never classify a validation error as an uncertain external side effect.
const INTERNAL_CONTROL=/^cm_(task|library|self|checkpoint|extraction|report|delete|situation|working|scene|activity)$/
export function readOnlyTool(name,args={}){
  if(READ_ONLY.has(name))return true
  if(typeof args==='string'){try{args=JSON.parse(args)}catch{return false}}
  if(!args||typeof args!=='object'||Array.isArray(args))return false
  if(name==='working_directory')return !Object.hasOwn(args,'cd')&&Object.keys(args).length===0
  if(name==='ops_bash')return Object.keys(args).every(key=>['command','description','timeoutMs'].includes(key))&&readOnlyShell(args.command)
  if(name==='cm_library')return ['list','status','recovery'].includes(args?.action)
  if(name==='cm_self')return ['get','list','history','timeline','related'].includes(args?.action)
  if(name==='cm_checkpoint')return args?.action==='read'
  if(name==='cm_task')return ['list','status','verify'].includes(args?.action)
  if(name==='cm_working')return ['status','feedback-status'].includes(args?.action)
  if(name==='cm_activity')return ['read','list','status'].includes(args?.action)
  if(name==='cm_situation')return ['get','read','list','timeline','related','maintenance-status','search','index-status','index-warm'].includes(args?.action)
  if(name==='cm_evidence')return !args?.action||['verify','status'].includes(args.action)
  return false
}
export class RecoveryJournal{
  constructor(store){
    this.store=store
    this.hadJournal=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cm_tool_operations'").get()
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS cm_recovery_runs(id TEXT PRIMARY KEY,library TEXT NOT NULL,session TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,time INTEGER NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cm_tool_operations(library TEXT NOT NULL,session TEXT NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,args_digest TEXT NOT NULL,readonly INTEGER NOT NULL,status TEXT NOT NULL,time INTEGER NOT NULL,decision TEXT,note TEXT,PRIMARY KEY(library,session,call_id));
    `)
  }
  startup(){
    const s=this.store
    s.tx(()=>{
      for(const op of s.db.prepare("SELECT library,session,call_id,name FROM cm_tool_operations WHERE status IN ('running','uncertain','planned')").all())if(INTERNAL_CONTROL.test(op.name)){
        s.db.prepare("UPDATE cm_tool_operations SET status='settled',note=? WHERE library=? AND session=? AND call_id=?").run('Internal transactional state must be inspected; no external replay and no claim that the change committed',op.library,op.session,op.call_id)
        s.log(op.library,'internal-control-recovered',{session:op.session,call_id:op.call_id,name:op.name,replayed:false,commit_assumed:false})
      }
      const runs=s.db.prepare('SELECT * FROM activity').all()
      for(const row of runs){
        const uncertain=s.db.prepare("SELECT count(*) n FROM cm_tool_operations WHERE library=? AND status='running' AND readonly=0").get(row.library).n
        const untrackedLegacy=!this.hadJournal&&row.kind==='main'
        s.db.prepare('INSERT INTO cm_recovery_runs VALUES(?,?,?,?,?,?,?)').run(uuid(),row.library,row.session,untrackedLegacy?'legacy':row.kind,untrackedLegacy?'needs_review':'notice',s.now(),JSON.stringify({previous_started:row.time,uncertain_tools:uncertain,untracked_legacy:untrackedLegacy,note:'Previous request stopped; never replay automatically'}))
        if(row.kind==='extract')s.db.prepare("UPDATE extraction SET paused=1,error='PREVIOUS_EXTRACTION_INTERRUPTED' WHERE library=?").run(row.library)
        s.log(row.library,'interrupted-request-recovered',{session:row.session,kind:row.kind,uncertain_tools:uncertain,conversation_blocked:false})
      }
      // A tool may remain unresolved even if turn/end already released its lease.
      s.db.exec("UPDATE cm_tool_operations SET status=CASE WHEN readonly=1 THEN 'failed' ELSE 'uncertain' END WHERE status='running'")
      s.db.exec("UPDATE cm_tool_operations SET status='not_started' WHERE status='planned'")
      for(const lib of s.db.prepare("SELECT * FROM libraries WHERE error='PREVIOUS_PROCESS_INTERRUPTED'").all()){
        s.db.prepare('INSERT INTO cm_recovery_runs VALUES(?,?,?,?,?,?,?)').run(uuid(),lib.id,lib.owner||'', 'legacy','needs_review',s.now(),JSON.stringify({note:'Legacy interruption marker; review external effects before enabling writes'}))
        s.db.prepare("UPDATE libraries SET error=NULL WHERE id=? AND error='PREVIOUS_PROCESS_INTERRUPTED'").run(lib.id)
        s.log(lib.id,'legacy-interruption-migrated',{conversation_blocked:false,writes_require_review:true})
      }
      s.db.exec('DELETE FROM activity')
    })
  }
  observe(library,session,event){
    if(event.surfaceOp&&(typeof event.surfaceOp==='string'?event.surfaceOp:event.surfaceOp.op)!=='append')return
    const op=dshToolEvent(event),s=this.store
    if(op?.kind==='call'){
      const call=op.call,id=call.callId
      if(INTERNAL_CONTROL.test(call.name))return
      s.db.prepare('INSERT OR IGNORE INTO cm_tool_operations(library,session,call_id,name,args_digest,readonly,status,time) VALUES(?,?,?,?,?,?,?,?)').run(library,session,id,call.name,hash(JSON.stringify(call.arguments??{})),readOnlyTool(call.name,call.arguments)?1:0,'running',s.now())
    }else if(op?.kind==='result'){
      const id=op.callId
      const uncertainCodes=new Set(['TOOL_OUTCOME_UNKNOWN','ABORTED','TIMEOUT','CANCELLED','TRANSPORT'])
      const unknown=uncertainCodes.has(op.code)
      if(id)s.db.prepare("UPDATE cm_tool_operations SET status=CASE WHEN ?=1 AND readonly=0 THEN 'uncertain' ELSE 'settled' END WHERE library=? AND session=? AND call_id=? AND status='running'").run(unknown?1:0,library,session,id)
    }else if(event.type==='assistant/message'){
      s.db.prepare("UPDATE cm_recovery_runs SET status='seen' WHERE library=? AND status='notice'").run(library)
    }
  }
  pending(library){
    return {operations:this.store.db.prepare("SELECT session,call_id,name,time FROM cm_tool_operations WHERE library=? AND status='uncertain' ORDER BY time LIMIT 20").all(library),legacy:this.store.db.prepare("SELECT id,session,time FROM cm_recovery_runs WHERE library=? AND status='needs_review' ORDER BY time LIMIT 20").all(library)}
  }
  needsReview(library){
    return !!(this.store.db.prepare("SELECT 1 FROM cm_tool_operations WHERE library=? AND status='uncertain' LIMIT 1").get(library)||this.store.db.prepare("SELECT 1 FROM cm_recovery_runs WHERE library=? AND status='needs_review' LIMIT 1").get(library))
  }
  assertTool(library,name,args){
    if(this.needsReview(library)&&!readOnlyTool(name,args))fail('RECOVERY_REVIEW_REQUIRED','只有写操作待核对，聊天和已识别的只读工具仍可用。请打开 Returning Tide Memory 管理页顶部的“查看并处理”，或在本机运行 '+this.managerCommand()+'。核对前不重放、不绕过。')
  }
  managerCommand(){const quote=value=>process.platform==='win32'?"'"+value.replaceAll("'","''")+"'":"'"+value.replaceAll("'","'\\''")+"'";return 'node '+quote(fileURLToPath(new URL('../cli.mjs',import.meta.url)))+' --data '+quote(this.store.directory)+' --open-manager'}
  context(library){
    const pending=this.pending(library)
    if(this.needsReview(library))return '中断恢复状态（运行元数据，不是人格或亲历）：可以继续对话；只有写操作待管理员核对。read、cm_read、cm_lookup、working_directory及已识别的诊断ops_bash仍可用。打开 Returning Tide Memory 管理页顶部“查看并处理”。不要重发、重放或绕过。\n'+clip(JSON.stringify({operations:pending.operations.slice(0,5),legacy:pending.legacy.slice(0,5)}),1600)
    const recent=this.store.db.prepare("SELECT kind,time FROM cm_recovery_runs WHERE library=? AND status='notice' ORDER BY time DESC LIMIT 1").get(library)
    return recent?'上次请求随宿主停止，旧执行锁已经回收。没有待核对的写操作；继续正常对话，不自动重放上轮任务。':''
  }
  // This method is for the authenticated LOCAL human manager, not a model tool.
  resolve(library,{session,call_id,legacy_id,decision,note}){
    text(note,'review note',2000)
    if(!['verified-applied','verified-not-applied','abandon-no-replay'].includes(decision))fail('INVALID_INPUT','需要核查结果或明确放弃重放')
    const s=this.store
    return s.tx(()=>{
      let changed
      if(legacy_id)changed=s.db.prepare("UPDATE cm_recovery_runs SET status='reviewed',detail=? WHERE library=? AND id=? AND status='needs_review'").run(JSON.stringify({decision,note}),library,legacy_id).changes
      else changed=s.db.prepare("UPDATE cm_tool_operations SET status='reviewed',decision=?,note=? WHERE library=? AND session=? AND call_id=? AND status='uncertain'").run(decision,note,library,session,call_id).changes
      if(changed!==1)fail('CONFLICT','待核查项已变化，未重复处理')
      s.log(library,'human-interruption-review',{session,call_id,legacy_id,decision,note:clip(note,300),replayed:false})
      return {resolved:true,replayed:false,pending:this.pending(library)}
    })
  }
}
