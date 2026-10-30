import {hash,clip} from './util.mjs'

// Hints about activity only; never declares a task finished or interprets shell code.
export class ToolContext {
  constructor(working){this.working=working;this.sessions=new Map()}
  observe(library,session,name,args){
    if(!this.working.config.enabled||/^cm_|^memory_|^rag_/.test(name||''))return
    const family=/bili|browser|web|navigate|fetch/i.test(name)?'browser':/game|steam/i.test(name)?'game':/screen|desktop|computer|mouse|keyboard/i.test(name)?'desktop':/shell|terminal|exec|code|file|read|write|edit/i.test(name)?'workspace':null
    const source=args&&typeof args==='object'&&!Array.isArray(args)?args:{},parts=[]
    for(const field of ['application','app','app_name','processName','windowTitle','window_title','task_id'])if(typeof source[field]==='string'&&source[field].trim())parts.push(field+':'+clip(source[field],100))
    if(typeof source.url==='string')try{const url=new URL(source.url);if(['http:','https:'].includes(url.protocol))parts.push(url.origin+url.pathname.slice(0,100))}catch{}
    if(!family&&!parts.length)return
    const prior=this.sessions.get(session),kind=family||prior?.family||'context'
    // Mouse movements, selectors, typed text, shell commands and URL tokens are not task hints.
    const detail=parts.length?parts.join(' '):prior?.family===kind?prior.detail:''
    const key=hash([library,kind,detail]);this.sessions.set(session,{library,family:kind,detail,key})
    if(!prior||prior.library!==library||prior.key===key)return
    this.working.signalEvent(library,session,'task-switch','tool-context:'+key,'工具活动线索转到 '+kind+' '+detail+'；仅核对相关旧经验和检查点，不据此判断任务完成。')
  }
  clear(session=null){if(session===null)this.sessions.clear();else this.sessions.delete(session)}
}
