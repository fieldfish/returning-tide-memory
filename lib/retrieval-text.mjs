/** Retrieval projections only. The immutable source, authorship and read offsets stay intact. */
const BRIDGES=new Set(['qq','dsh-qq-bridge','plugin:dsh-qq-bridge'])
export function sourceKind(record){
 const origin=typeof record.origin==='string'?JSON.parse(record.origin):record.origin||{}
 if(origin.kind==='legacy-index-note')return origin.source==='authored-file'?'legacy-file':'legacy-note'
 if(record.role==='note')return 'note'
 if(['user','assistant'].includes(record.role))return 'dialogue'
 return 'tool'
}
export const sourcePrior=record=>({dialogue:1.1,'legacy-file':.8,'legacy-note':.85,note:.9,tool:1}[sourceKind(record)])
export function retrievalText(record){
 const raw=String(record.text||''),origin=typeof record.origin==='string'?JSON.parse(record.origin):record.origin||{}
 if(record.role!=='user'||!BRIDGES.has(origin.kind))return raw
 // Exact transport envelope, not occurrences quoted or discussed inside a message.
 return raw.replace(/(?:\r?\n)?[（(]回\s*QQ[：:]\s*用\s+qq_bridge_send\s+工具[）)]\s*$/u,'')
  .replace(/^\[QQ\s*[·・]\s*(?:私聊|群聊)\]\s*[^\r\n：:]{1,100}[：:]\s*/u,'')
}
