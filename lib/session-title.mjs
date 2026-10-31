/** Native titles are presentation only; stable session IDs remain the ownership keys. */
export function sessionTitle(agent){
 if(!agent?.session)return null
 try{const latest=(agent.session.snapshotEvents?.()||[]).findLast(e=>e.type==='session/title'&&typeof e.data?.title==='string'&&e.data.title.trim());if(latest)return latest.data.title.trim()}catch{}
 const title=agent.session.header?.title
 return typeof title==='string'&&title.trim()?title.trim():null
}
