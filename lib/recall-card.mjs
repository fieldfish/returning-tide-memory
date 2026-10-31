import {clip,fail} from './util.mjs'
import {retrievalText,sourceKind} from './retrieval-text.mjs'
const size=s=>Array.from(s).length
const labels={dialogue:'对话',tool:'工具','legacy-file':'旧文件','legacy-note':'旧笔记',note:'笔记'}
// A summary or quote below these floors cannot be judged; the caller may return fewer cards instead.
const SUMMARY_FLOOR=10,QUOTE_FLOOR=10,SHORT_SUMMARY_FLOOR=6
function display(text){
 try{const v=JSON.parse(text),a=v.arguments||v.call?.arguments||v;return a.description||a.command||a.path||v.text||text}catch{return text}
}
export function recallCard(record,score,id,passage,query=''){
 const raw=retrievalText(record),plain=String(display(passage||raw)).replace(/\s+/g,' ').trim()
 const words=(query.match(/[\u3400-\u9fff]{2,}|[a-z0-9_-]{3,}/ig)||[]).filter(w=>!['the','was','were','where','what','when','which','with','that','this','have','from','does'].includes(w.toLowerCase())).sort((a,b)=>b.length-a.length)
 let at=-1
 for(const word of words){at=raw.toLowerCase().indexOf(word.toLowerCase());if(at>=0)break}
 if(at<0&&passage){const start=String(passage).slice(0,16);at=raw.indexOf(start)}
 if(at<0){const readable=display(raw);if(typeof readable==='string'&&readable!==raw)at=raw.indexOf(readable)}
 const chars=Array.from(raw),offset=at<0?0:Array.from(raw.slice(0,at)).length
 const quote=chars.slice(Math.max(0,offset-3),Math.max(0,offset-3)+12).join('')
 const label=labels[sourceKind(record)]
 const item={id,title:clip(label+'·'+plain,7),score:+(score*1000).toFixed(1),summary:clip(plain,30),time:new Date(record.time).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false}).slice(0,16),quote}
 // Six fields share the existing 120-character JSON budget. Never paraphrase a quote.
 // Priority: keep the source label and separator, then a judgeable summary and exact quote. The title
 // repeats the summary's opening, so its text yields first; only an overlong identifier falls back to
 // date precision (full time remains available through cm_read by id).
 const over=()=>size(JSON.stringify(item))>120
 const shrink=(field,floor)=>{const min=Math.min(floor,size(item[field]));while(over()&&size(item[field])>min)item[field]=clip(item[field],size(item[field])-1)}
 shrink('title',size(label)+1)
 shrink('summary',SUMMARY_FLOOR)
 shrink('quote',QUOTE_FLOOR)
 if(over()&&item.time.length>10)item.time=item.time.slice(0,10)
 shrink('summary',SHORT_SUMMARY_FLOOR)
 shrink('summary',1)
 shrink('quote',1)
 if(size(JSON.stringify(item))>120)fail('COMPACT_BUDGET_ERROR','精简结果超过字符预算')
 return item
}
