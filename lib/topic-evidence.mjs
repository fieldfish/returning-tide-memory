// For automatic admission only. Manual lookup still returns the broad ranked set.
const segmenter=new Intl.Segmenter('zh',{granularity:'word'})
const generic=new Set(('什么 怎么 哪个 哪些 如何 之前 以前 后来 现在 上次 记得 还记得 请问 编号 号码 代码 状态 任务 项目 原来 分别 是否 结果 一下 继续 进行 执行 下一步 上一步 工具 记录 检查点 进度 接着 需要 已经 实际 这个 那个 我们 可以 目前 核对 输出 回答 说明 报告 查询 告诉 使用 相关 事情 最新 当时 原文 文件 原先 '+
  '只有 只要 虽然 但是 因此 然后 所以 核实 证实 听说 最初 最终 先前 当下 两次 代号 标识 标记 曾经 出处 给出 资料 '+
  'the and for this that with was were what which when who how did does previously previous current earlier latest remember number please return task project status continue resume next step tool using execute check json').split(/\s+/))

export function topicTerms(query){
  // Formatting requirements are not the subject of a memory query.
  const subject=query.split(/(?:最终\s*)?(?:仅|只|请用|请以)\s*(?:输出|返回|回答|JSON)|(?:output|return)\s+(?:only\s+)?JSON/i)[0]
  const words=new Set();let preceding=''
  for(const w of segmenter.segment(subject.normalize('NFKC').toLowerCase())){
    const token=w.segment
    // ICU returns some domain nouns as a succession of single Chinese characters.
    if(/^\p{Script=Han}$/u.test(token)&&!('的了吗呢与和是有在将用我你它这那把及了才要为给到'.includes(token))){
      if(preceding&&!generic.has(preceding+token))words.add(preceding+token)
      preceding=token
    }else{
      preceding=''
      if(w.isWordLike&&token.length>=2&&!generic.has(token))words.add(token)
    }
  }
  return [...words].slice(0,80)
}

export function topicEvidence(query,passages){
  const question=query.normalize('NFKC').toLowerCase()
  const texts=passages.map(p=>p.text.normalize('NFKC').toLowerCase())
  // Discover a repeatedly named scope (e.g. an unnumbered project) from the
  // passages themselves. Its component words must not count as separate facets.
  const prefixes=new Map()
  for(const text of texts)for(let n=4;n<=Math.min(48,text.length);n++){
    const prefix=text.slice(0,n)
    if(!question.includes(prefix))break
    if(/[。！？!?，,;；\n]/.test(prefix))break
    prefixes.set(prefix,(prefixes.get(prefix)||0)+1)
  }
  const common=[...prefixes].filter(([,n])=>n>=3).sort((a,b)=>b[1]-a[1]||b[0].length-a[0].length)[0]?.[0]?.trim()||''
  const allTerms=topicTerms(query)
  const residual=common?allTerms.filter(t=>!common.includes(t)):allTerms
  const terms=residual.length?residual:allTerms
  const matches=passages.map(p=>{
    const text=p.text.normalize('NFKC').toLowerCase()
    return new Set(terms.filter(t=>text.includes(t)))
  })
  // A different project can share the entire activity vocabulary. When the
  // query supplies a bounded identifier that exists in this pool, keep scope.
  const codes=(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g)||[]).filter(s=>s.length>=3&&/[a-z]/.test(s)&&/\d/.test(s))
  const identifiers=passages.map(p=>new Set(p.text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g)||[]))
  const scoped=codes.filter(code=>identifiers.some(set=>set.has(code)))
  const cohort=matches.filter((_,i)=>(!common||texts[i].includes(common))&&(!scoped.length||scoped.some(code=>identifiers[i].has(code))))
  const frequency=new Map(terms.map(t=>[t,cohort.filter(m=>m.has(t)).length]))
  const weight=t=>Math.log1p(cohort.length/(frequency.get(t)||1))*Math.min(t.length,5)
  const strength=m=>[...m].reduce((sum,t)=>sum+weight(t),0)
  return new Map(passages.map((p,i)=>{
    if(scoped.length&&!scoped.some(code=>identifiers[i].has(code)))return [p.id,false]
    if(common&&!texts[i].includes(common))return [p.id,false]
    const hits=[...matches[i]]
    const stronger=cohort.filter(m=>m.size>hits.length&&hits.every(t=>m.has(t)))
    const dominated=stronger.some(m=>strength(matches[i])<.8*strength(m))
    // An identifier shared by several candidate records is useful for retrieval.
    // On a multi-topic question require evidence beyond that common identifier.
    const anchored=hits.some(t=>{
      const count=frequency.get(t)
      if(count===1||terms.length===1||common&&residual.length&&count<cohort.length)return true
      const group=cohort.filter(m=>m.has(t))
      const sameContext=terms.some(other=>frequency.get(other)>count&&group.every(m=>m.has(other)))
      const joint=hits.some(other=>group.some(m=>!m.has(other))&&cohort.some(m=>m.has(other)&&!m.has(t)))
      return sameContext||joint||count===2&&cohort.length<=2&&hits.length>=2
    })
    const rival=Math.max(0,...passages.filter((_,j)=>j!==i).map(v=>v.semantic))
    const semanticOnly=hits.length===0&&p.semantic>=.88&&p.semantic-rival>=.08
    return [p.id,anchored&&!dominated||semanticOnly]
  }))
}
