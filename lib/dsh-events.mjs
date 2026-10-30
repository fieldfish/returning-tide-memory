/** DSH envelope normalization. Raw payloads stay in host history, not the ledger. */
export const isAppendEvent=event=>!event.surfaceOp||(typeof event.surfaceOp==='string'?event.surfaceOp:event.surfaceOp.op)==='append'
export function toolOutcome(result,{thrown=false}={}){
 const inner=result?.result,message=result?.message||inner?.message||inner||result
 const error=result?.error||inner?.error||message?.error
 const code=error?.code||error?.info?.code||null
 return {message,error,code,isError:thrown||result?.isError===true||inner?.isError===true||message?.isError===true||!!error}
}
export function dshToolEvent(event){
 if(!isAppendEvent(event))return null
 const d=event.data||{}
 if(event.type==='tool/call'){
  const call=d.call||d,id=call.callId||call.id||d.callId
  return typeof id==='string'&&typeof call.name==='string'?{kind:'call',call:{...call,callId:id},seq:event.seq}:null
 }
 if(event.type==='tool/result'){
  const outcome=toolOutcome(d),id=outcome.message?.toolCallId||outcome.message?.source?.callId||d.callId||d.result?.callId
  return typeof id==='string'?{kind:'result',callId:id,result:d,...outcome,seq:event.seq}:null
 }
 return null
}
