import {DatabaseSync} from 'node:sqlite'
import {mkdirSync,readFileSync,writeFileSync,existsSync,copyFileSync,constants,statSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {fail} from './util.mjs'

const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
export function snapshot(store,directory){
 const out=resolve(directory)
 if(existsSync(out))fail('DESTINATION_EXISTS','快照目录已存在，未覆盖')
 if(store.db.prepare('SELECT 1 FROM activity LIMIT 1').get())fail('BUSY','请等当前任务结束后再离线备份')
 mkdirSync(out,{recursive:false,mode:0o700})
 const db=join(out,'continuity.sqlite3')
 store.db.exec(`VACUUM INTO '${db.replaceAll("'","''")}'`)
 const check=new DatabaseSync(db,{readOnly:true})
 try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail('INVALID_BACKUP','快照完整性检查失败')}finally{check.close()}
 const manifest={format:'continuity-snapshot-v1',time:new Date().toISOString(),database:'continuity.sqlite3',sha256:digest(db),bytes:statSync(db).size,scope:'Memory database only; no persona, native DSH log, credentials or models'}
 writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
 return {directory:out,...manifest}
}
export function restoreCopy(snapshotDirectory,destination){
 const src=resolve(snapshotDirectory),out=resolve(destination),manifest=JSON.parse(readFileSync(join(src,'manifest.json'),'utf8'))
 if(existsSync(out))fail('DESTINATION_EXISTS','恢复只允许新目录，绝不覆盖现有库')
 if(manifest.format!=='continuity-snapshot-v1'||manifest.database!=='continuity.sqlite3')fail('INVALID_BACKUP','不支持的备份清单')
 const db=join(src,'continuity.sqlite3')
 if(digest(db)!==manifest.sha256||statSync(db).size!==manifest.bytes)fail('BACKUP_HASH_MISMATCH','备份摘要不符，未恢复')
 const check=new DatabaseSync(db,{readOnly:true})
 try{
  if(check.prepare('PRAGMA application_id').get().application_id!==1129137485||![1,2,3].includes(check.prepare('PRAGMA user_version').get().user_version)||check.prepare('PRAGMA quick_check').get().quick_check!=='ok'||check.prepare('PRAGMA foreign_key_check').all().length)fail('INVALID_BACKUP','备份格式或完整性无效')
 }finally{check.close()}
 mkdirSync(out,{recursive:false,mode:0o700});const target=join(out,'continuity.sqlite3')
 copyFileSync(db,target,constants.COPYFILE_EXCL)
 const copy=new DatabaseSync(target)
 try{
  copy.exec('BEGIN IMMEDIATE')
  const libraries=copy.prepare('SELECT id,owner,error FROM libraries').all()
  copy.exec("DELETE FROM bindings;DELETE FROM activity;UPDATE extraction SET paused=1,error='RESTORED_COPY_REQUIRES_REVIEW';UPDATE libraries SET owner=NULL,revision=revision+1,error='RESTORED_COPY_REQUIRES_REVIEW'")
  if(copy.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_consolidation'").get())copy.exec("UPDATE cm_consolidation SET paused=1,error='RESTORED_COPY_REQUIRES_REVIEW'")
  if(copy.prepare("SELECT 1 FROM sqlite_master WHERE name='cm_working_frames'").get())copy.exec('DELETE FROM cm_working_frames')
  for(const lib of libraries)copy.prepare('INSERT INTO audit(library,type,detail,time) VALUES(?,?,?,?)').run(lib.id,'restored-as-unbound-copy',JSON.stringify({previous_owner:lib.owner,previous_error:lib.error,source_sha256:manifest.sha256,requires_human_review:true,replayed:false}),Date.now())
  copy.exec('COMMIT')
 }catch(e){copy.exec('ROLLBACK');throw e}finally{copy.close()}
 writeFileSync(join(out,'RESTORE-REVIEW.json'),JSON.stringify({source:src,source_sha256:manifest.sha256,unbound:true,paused:true,original_modified:false,model_calls:0},null,2)+'\n',{flag:'wx',mode:0o600})
 return {directory:out,unbound:true,paused:true,original_modified:false,model_calls:0}
}
