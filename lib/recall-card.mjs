import {clip,fail} from './util.mjs'
import {retrievalText,sourceKind} from './retrieval-text.mjs'
const size=s=>Array.from(s).length
const labels={dialogue:'对话',tool:'工具','legacy-file':'旧文件','legacy-note':'旧笔记',note:'笔记'}
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
 const item={id,title:clip(labels[sourceKind(record)]+'·'+plain,7),score:+(score*1000).toFixed(1),summary:clip(plain,30),time:new Date(record.time).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false}).slice(0,16),quote}
 // Six fields share the existing 120-character JSON budget. Never paraphrase a quote.
 while(size(JSON.stringify(item))>120&&size(item.summary)>1)item.summary=clip(item.summary,size(item.summary)-1)
 while(size(JSON.stringify(item))>120&&size(item.title)>labels[sourceKind(record)].length+1)item.title=clip(item.title,size(item.title)-1)
 while(size(JSON.stringify(item))>120&&size(item.quote)>1)item.quote=Array.from(item.quote).slice(0,-1).join('')
 if(size(JSON.stringify(item))>120)fail('COMPACT_BUDGET_ERROR','精简结果超过字符预算')
 return item
}
