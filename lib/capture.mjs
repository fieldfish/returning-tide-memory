import { hash } from './util.mjs'
import {isAppendEvent} from './dsh-events.mjs'

const INTERNAL = new Set(['plugin', 'system', 'runtime', 'skill', 'compaction', 'continuity-core', 'schedule', 'time-context', 'tool-registry'])
const MEMORY_TOOL = /^(cm_|[a-zA-Z0-9_]+_memory_|memory_(search|read|remember|project|list|stats)|rag_search)/
const blocksText = content => typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('') : '')
const eventTime = value => {
  const date = typeof value === 'number' && Number.isSafeInteger(value) ? new Date(value) : typeof value === 'string' ? new Date(value) : new Date(NaN)
  if (!Number.isFinite(date.getTime())) { const e=new Error('原生事件时间无效');e.code='INVALID_INPUT';throw e }
  return date.toISOString()
}

export class Capture {
  constructor(store,activityArchive=null) { this.store = store; this.activityArchive=activityArchive; this.cursors = new Map() }
  event(library, session, event) {
    if (!event || !Number.isSafeInteger(event.seq)) return null
    if (!isAppendEvent(event)) return null
    const data = event.data || {}, kind = event.type
    if (kind === 'tool/call') {
      const call = data.call || data
      if (MEMORY_TOOL.test(call.name || '') || (call.name==='run_code' && /cm_(read|lookup|self|report|checkpoint|activity|working|situation|task|extraction|evidence|library|scene|delete)\b|[a-zA-Z0-9_]+_memory_|memory_search|rag_search/.test(JSON.stringify(call.arguments||'')))) {
        const callId=call.callId||call.id||data.callId||data.id
        if(callId)this.store.db.prepare('INSERT OR IGNORE INTO excluded_calls VALUES(?,?,?)').run(library,session,callId)
      }
      if(!MEMORY_TOOL.test(call.name||'')&&!this.store.db.prepare('SELECT 1 FROM excluded_calls WHERE library=? AND session=? AND call_id=?').get(library,session,call.callId||call.id||data.callId||data.id||''))return this.activityArchive?.captureNative(library,session,event)||null
      return null
    }
    let message, role
    if (kind === 'user/message') { message = data.message || data; role = 'user' }
    else if (kind === 'assistant/message') { message = data.message; role = 'assistant' }
    else if (kind === 'tool/result') { message = data.message || data.result?.message || data.result || data; role = 'tool' }
    else return null
    if (!message || INTERNAL.has(message.source?.kind)) return null
    if(role==='user'&&message.source?.kind&&!['user','human','qq','dsh-qq-bridge','plugin:dsh-qq-bridge'].includes(message.source.kind))return null
    if (message.source?.plugin && MEMORY_TOOL.test(message.source.plugin)) return null
    const callId = message.toolCallId || message.source?.callId || data.toolCallId || data.callId || message.id
    if(role==='tool'&&callId&&MEMORY_TOOL.test(this.store.db.prepare('SELECT name FROM cm_tool_operations WHERE library=? AND session=? AND call_id=?').get(library,session,callId)?.name||''))return null
    if (role === 'tool' && (this.store.db.prepare('SELECT 1 FROM excluded_calls WHERE library=? AND session=? AND call_id=?').get(library,session,callId||'') || MEMORY_TOOL.test(data.name || message.name || ''))) return null
    const body = blocksText(message.content)
    const origin={}
    for(const key of ['kind','plugin','sender_id','user_id','chat_id'])if(['string','number'].includes(typeof message.source?.[key]))origin[key]=message.source[key]
    if(role==='tool' && message.source?.kind && message.source.kind!=='tool')return null
    if(role==='tool' && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length>1)return null
    if(!body.trim())return role==='tool'?this.activityArchive?.captureNative(library,session,event,{message})||null:null
    const rid=this.store.append(library, { session, seq: event.seq, time: eventTime(event.time), role, type: kind, text: body,origin })
    if(role==='tool'&&rid)this.activityArchive?.captureNative(library,session,event,{bodyRecord:this.store.record(library,rid),message})
    return rid
  }
  backfill(library, session,{rescan=false}={}) {
    if (typeof session?.snapshotEvents !== 'function') { const e = new Error('宿主缺少 snapshotEvents，未猜测压缩日志格式'); e.code = 'HOST_API_UNAVAILABLE'; throw e }
    const key=`${library}:${session.id}`,from=rescan?0:this.cursors.get(key)||0,events = session.snapshotEvents(from); let count = 0
    this.store.tx(()=>{for (const event of events) if (this.event(library, session.id, event)) count++})
    if(events.length)this.cursors.set(key,events.at(-1).seq+1)
    return { scanned: events.length, captured: count, fingerprint: hash(events.map(e => [e.seq,e.type,e.time])) }
  }
}
