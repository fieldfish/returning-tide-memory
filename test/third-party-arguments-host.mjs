import assert from 'node:assert/strict'
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

export async function checkThirdPartyArguments({agent,tools,native,state,clear,row,workspace}){
 const marker=join(workspace,'third-party-effect.txt')
 const followup=join(workspace,'independent-write.txt')
 const pending=async()=>(await state()).recovery.operations.length
 const render=(_args,value)=>[{type:'text',text:value}]
 const output={schema:{type:'string'},render}
 let entries=0
 const removeWriter=agent.ctx.tools.register(tools.defineTool({
  name:'fixture_followup',description:'Append the test payload to the witness file.',
  parameters:{},output,execute(){writeFileSync(followup,'independent write',{flag:'wx'});return 'ok'}
 }))
 const removeBoard=agent.ctx.tools.register(tools.defineTool({
  name:'video_storyboard',description:'Exercise the third-party validation and effect boundary.',
  parameters:{cells:{type:'number',required:true},simulateFailure:{type:'boolean'}},output,
  execute(args){
   entries++
   if(args.simulateFailure){
    writeFileSync(marker,'written before error',{flag:'wx'})
    throw new tools.ToolArgsError(['nested argument failure after writing'])
   }
   return 'rendered'
  }
 }))
 try{
  const refusals=[]
  for(const [id,args] of [['missing-cells',{}],['wrong-cells',{cells:'4'}]]){
   const r=await native('video_storyboard',args,id)
   assert.equal(r.error?.info?.code,'INVALID_ARGS')
   assert.match(r.error.message,/cells/)
   assert.equal(entries,0);assert.equal(existsSync(marker),false)
   const op=row(id)
   assert.equal(op.status,'not_started');assert.equal(op.stage,'schema-preflight')
   assert.equal(await pending(),0)
   refusals.push({id,status:op.status,stage:op.stage,body_entries:entries,pending:0})
  }
  const corrected=await native('video_storyboard',{cells:4},'corrected-cells')
  assert.equal(corrected.isError,false);assert.equal(entries,1)
  const next=await native('fixture_followup',{},'after-invalid')
  assert.equal(next.isError,false);assert.equal(readFileSync(followup,'utf8'),'independent write')
  const failed=await native('video_storyboard',{cells:4,simulateFailure:true},'written-invalid')
  assert.equal(failed.error?.info?.code,'INVALID_ARGS')
  assert.equal(readFileSync(marker,'utf8'),'written before error');assert.equal(entries,2)
  const op=row('written-invalid');assert.equal(op.status,'uncertain');assert.equal(await pending(),1)
  const denied=await native('video_storyboard',{cells:4},'blocked-after-write')
  assert.equal(denied.isError,true);assert.equal(entries,2);assert.equal(row('blocked-after-write'),undefined)
  return {refusals,corrected_executions:1,independent_file_verified:true,post_effect:{code:op.failure_code,status:op.status,file_verified:true,pending:1,subsequent_write_blocked:true}}
 }finally{removeBoard();removeWriter();await clear()}
}
