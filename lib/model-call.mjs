import {fail,uuid,estimateTokens} from './util.mjs'
export class ModelCalls {
  constructor(store,{fetcher=fetch,dshCall=null,now=Date.now}={}){this.store=store;this.fetcher=fetcher;this.dshCall=dshCall;this.now=now}
  async request(id,cfg,{session,system,input,signal,purpose='extract',onReserved=null}){
    if(!['extract','evidence','consolidate'].includes(purpose))fail('INVALID_INPUT','未知模型调用用途')
    const day=new Date(this.now()+8*3600000).toISOString().slice(0,10),usageId=uuid(),source=purpose==='extract'?cfg.source:(purpose==='consolidate'?'consolidation-':'evidence-')+cfg.source
    this.store.tx(()=>{
      const count=this.store.db.prepare("SELECT COUNT(*) n FROM usage WHERE library=? AND source!='main' AND time>=?").get(id,Date.parse(day+'T00:00:00+08:00')).n
      if(count>=cfg.maxCallsPerDay)fail('DAILY_LIMIT','已达到整理与证据核验共用的每日调用上限')
      this.store.db.prepare('INSERT INTO usage(id,library,source,status,estimated_input,time) VALUES(?,?,?,?,?,?)').run(usageId,id,source,'started',estimateTokens(system+input),this.now())
    })
    let usage=null
    try{
      onReserved?.(usageId)
      let text
      if(cfg.source==='api'){
        const key=process.env[cfg.apiKeyEnv];if(!key?.trim())fail('API_KEY_MISSING','提炼密钥环境变量未设置')
        const response=await this.fetcher(cfg.baseURL.replace(/\/$/,'')+'/chat/completions',{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',authorization:'Bearer '+key.trim()},body:JSON.stringify({model:cfg.model,stream:false,temperature:0,max_tokens:cfg.maxOutputTokens,messages:[{role:'system',content:system},{role:'user',content:input}]})})
        if(!response.ok)fail('API_HTTP_'+response.status,'模型API返回错误')
        const payload=await response.json();usage=normalizeUsage(payload.usage,'api')
        if(payload.choices?.[0]?.finish_reason!=='stop')fail('INCOMPLETE_OUTPUT','模型输出未正常完成')
        text=payload.choices?.[0]?.message?.content
      }else{
        if(!this.dshCall)fail('DSH_API_UNAVAILABLE','未提供经过核对的DSH调用适配器')
        const result=await this.dshCall({...cfg,system,input,session,signal});usage=normalizeUsage(result.usage,'dsh');text=result.text
      }
      signal?.throwIfAborted()
      if(typeof text!=='string'||text.length>100000)fail('INVALID_MODEL_OUTPUT','模型结果无效')
      return {text,usage,id:usageId}
    }catch(error){this.finish(usageId,'failed',usage);throw error}
  }
  finish(id,status,usage){this.store.db.prepare('UPDATE usage SET status=?,input=?,output=?,cache_read=?,cache_write=? WHERE id=?').run(status,usage?.input??null,usage?.output??null,usage?.cache_read??null,usage?.cache_write??null,id)}
}
export function normalizeUsage(u,source){
  if(!u)return null
  const finite=v=>Number.isSafeInteger(v)&&v>=0?v:null
  if(source==='api')return {input:finite(u.prompt_tokens),output:finite(u.completion_tokens),cache_read:finite(u.prompt_cache_hit_tokens??u.prompt_tokens_details?.cached_tokens),cache_write:null}
  const pieces=[u.inputTokens,u.cacheReadTokens??0,u.cacheWriteTokens??0]
  return {input:pieces.every(v=>finite(v)!==null)?pieces.reduce((a,b)=>a+b,0):null,output:finite(u.outputTokens),cache_read:finite(u.cacheReadTokens),cache_write:finite(u.cacheWriteTokens)}
}
