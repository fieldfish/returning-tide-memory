import {clip,fail,integer} from './util.mjs'
import {activeSource,excludedSource} from './source-position.mjs'

const length=s=>Array.from(s).length
const origin=r=>{const o=JSON.parse(r.origin||'{}');return Object.fromEntries(['kind','plugin','sender_id','user_id','chat_id'].filter(k=>o[k]!==undefined).map(k=>[k,clip(o[k],80)]))}

/** A deterministic view over immutable sources, never an invented episode. */
export class Scenes {
  constructor(store){this.store=store}
  active(library,rid){
    return activeSource(this.store,library,rid)
  }
  build(library,rid,{window=2,maxChars=3000,query='',exclude=null,gapMs=20*60*1000,sourceFilter=null}={}){
    integer(window,'window',0,3);integer(maxChars,'maxChars',800,6000)
    const anchor=this.active(library,rid),blocked=r=>excludedSource(r,exclude)
    if(sourceFilter!==null&&typeof sourceFilter!=='function')fail('INVALID_INPUT','场景来源过滤器无效')
    if(blocked(anchor))fail('CURRENT_TURN_EXCLUDED','当前提问不作为历史证据')
    if(sourceFilter&&!sourceFilter(anchor))fail('SOURCE_SUPPRESSED','当前线索不自动带入这段原文')
    const before=this.store.db.prepare('SELECT * FROM records WHERE library=? AND session=? AND seq<? ORDER BY seq DESC LIMIT ?').all(library,anchor.session,anchor.seq,window)
    const after=this.store.db.prepare('SELECT * FROM records WHERE library=? AND session=? AND seq>? ORDER BY seq LIMIT ?').all(library,anchor.session,anchor.seq,window)
    const selected=[anchor],anchorSource=origin(anchor)
    for(const side of [before,after]){
      let previous=anchor
      for(const r of side){
        const source=origin(r)
        if(blocked(r)||Math.abs(Date.parse(previous.time)-Date.parse(r.time))>gapMs||Math.abs(Date.parse(anchor.time)-Date.parse(r.time))>2*gapMs)break
        if(anchorSource.chat_id&&source.chat_id&&anchorSource.chat_id!==source.chat_id)break
        try{this.active(library,r.id)}catch(e){if(e.code==='SOURCE_INACTIVE')break;throw e}
        if(sourceFilter&&!sourceFilter(r))break
        selected.push(r);previous=r
      }
    }
    const terms=(String(query).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)||[]).flatMap(t=>/[\u3400-\u9fff]/.test(t)?Array.from({length:Math.max(0,t.length-1)},(_,i)=>t.slice(i,i+2)):[t]).slice(0,80)
    const excerpt=(r,cap)=>{
      const chars=Array.from(r.text),lower=r.text.toLowerCase();let at=-1
      for(const term of terms){const n=lower.indexOf(term);if(n>=0&&(at<0||n<at))at=n}
      const center=at<0?0:Array.from(r.text.slice(0,at)).length,start=Math.max(0,center-Math.floor(cap/3)),end=Math.min(chars.length,start+cap)
      return {id:this.store.shortId(library,r.id),seq:r.seq,time:r.time,role:r.role,source:origin(r),text:chars.slice(start,end).join(''),offset:start,total:chars.length,excerpt:start>0||end<chars.length}
    }
    const result={anchor:this.store.shortId(library,anchor.id),session:anchor.session,basis:'adjacent-source-records',messages:[excerpt(anchor,500)],omitted:0,note:'原始聊天的相邻片段；非完整场景，未推断情绪、因果或事实真伪。全文用cm_read。'}
    // Anchor has priority. Metadata and JSON escaping count against the budget.
    for(const r of selected.filter(r=>r!==anchor).sort((a,b)=>Math.abs(a.seq-anchor.seq)-Math.abs(b.seq-anchor.seq))){
      const item=excerpt(r,240);result.messages.push(item)
      if(length(JSON.stringify(result))>maxChars){result.messages.pop();result.omitted++}
    }
    while(length(JSON.stringify(result))>maxChars&&result.messages[0].text.length){
      result.messages[0].text=clip(result.messages[0].text,Math.max(0,length(result.messages[0].text)-40));result.messages[0].excerpt=true
    }
    if(length(JSON.stringify(result))>maxChars)fail('SCENE_BUDGET_TOO_SMALL','场景元数据已超过预算')
    result.messages.sort((a,b)=>a.seq-b.seq)
    return result
  }
}
