import {clip,fail} from './util.mjs'
import {dshToolEvent} from './dsh-events.mjs'

// Only a fresh human instruction can arm an action for this turn. Reading a
// checkpoint, a tool failure, or a background recall cannot arm one.
export function wantsResume(text){
  const first=String(text||'').trim()
  if(/^(?:请|麻烦)?(?:继续|接着)(?:帮我)?(?:查(?:看|询|一下)|看看|了解|介绍|解释|回顾|汇报|报告)|^(?:please )?(?:continue|resume) (?:explaining|reviewing|discussing|summarizing)\b/i.test(first))return false
  if(/(?:不要|别|先不|暂不|不必|禁止)\s*(?:实际|擅自|直接|再)?(?:动手|动文件|做|执行|继续|操作|运行|调用|写|发送|发布|生成|提交)|仅(?:看|查|问)|只(?:汇报|读|看|查|想知道|问)|^(?:请问)?(?:是否|能否|可不可以)|^[^。！!？?]*[吗么][？?]|\b(?:do not|don't) (?:run|write|execute|act|continue|send)|\b(?:what would|could you explain|read.only)\b/i.test(first))return false
  return /^(?:请|麻烦)?(?:继续|接着|恢复|执行下一步|完成下一步)|^(?:please\s+)?(?:resume|continue|carry on|execute the next step)\b/i.test(first)
}

export class CheckpointResume {
  constructor(store,working){
    this.store=store;this.working=working;this.turns=new Map();this.inquiries=new Map()
  }
  clear(session){this.turns.delete(session);this.inquiries.delete(session)}
  begin(library,agent,turn,query,fromSeq=0){
    const session=agent.session.id
    this.clear(session)
    if(!wantsResume(query)){
      const progressQuestion=/进度|做到哪|停在哪|哪一步|\b(?:progress|where did we stop|task status)\b/i.test(query)
      const inquiry=progressQuestion||/只(?:汇报|查看|读|查询)|暂不(?:执行|写)|还记得|是否|\b(?:do you remember|report only)\b/i.test(query)
      const alsoAct=/然后|随后|接下来请|(?:并|现在|请)(?:请|你|实际)?(?:调用|写入|生成|导出|执行)|\band then\b/i.test(query)
      if(inquiry&&!alsoAct){
        const tasks=this.store.tasks(library),tools=tasks.filter(t=>!['done','cancelled'].includes(t.value.status)).map(t=>t.value.next_tool).filter(Boolean)
        const refs=new Set(this.working.frame(library,session)?.refs||[])
        const related=progressQuestion?tasks.filter(t=>t.refs.some(id=>refs.has(id))&&this.working.validRefs(library,t.refs)):[]
        this.inquiries.set(session,{library,tools:new Set(tools),task:related.length===1?related[0].task:null})
        if(related.length===1)this.working.focusCheckpoint(library,session,related[0])
      }
      return
    }
    if(this.store.recovery.needsReview(library))return
    const refs=new Set(this.working.frame(library,session)?.refs||[])
    const tasks=this.store.tasks(library).filter(t=>['planned','paused','running'].includes(t.value.status)&&this.working.validRefs(library,t.refs))
    const words=query.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g)||[]
    const named=tasks.filter(t=>/^[a-z0-9_.-]+$/i.test(t.task)?words.includes(t.task.toLowerCase()):query.includes(t.task))
    const linked=named.length?named:tasks.filter(t=>t.refs.some(id=>refs.has(id)))
    const continueOnly=/^(?:请)?(?:继续|接着)(?:上次|之前|刚才)?(?:的)?(?:任务|工作|下一步)[。！\s]*$|^(?:please )?(?:continue|resume) (?:the |my )?(?:previous |last )?task[.!\s]*$/i.test(query)
    const candidates=linked.length?linked:(tasks.length===1&&continueOnly?tasks:[])
    if(candidates.length!==1)return
    const task=candidates[0]
    const available=name=>typeof name==='string'&&!/^cm_/.test(name)&&!!agent.ctx?.tools?.get?.(name,agent)
    const explicit=[...new Set((query.match(/[A-Za-z][A-Za-z_0-9.-]*/g)||[]).map(w=>w.replace(/[.-]+$/,'')).filter(available))]
    if(explicit.length>1)return
    const hint=task.value.next_tool
    if(hint&&(!available(hint)||explicit.length&&explicit[0]!==hint))return
    if(!hint&&!explicit.length&&!/写入|落盘|保存|生成|运行|调用|导出|提交|上传|发送|编译|部署|复制|创建|执行|\b(?:save|write|export|run|create|send|build|deploy|copy|render)\b/i.test(task.value.next_step))return
    this.turns.set(session,{library,turn,fromSeq,task:task.task,revision:task.revision,tool:explicit[0]||hint||null,reminded:false,attempted:false})
    this.working.focusCheckpoint(library,session,task)
  }
  assertAction(library,session,tool){
    const scope=this.inquiries.get(session)
    if(scope?.library===library&&scope.tools.has(tool))fail('CHECKPOINT_INQUIRY_ONLY','本轮只在查询旧事。检查点中的写操作没有收到本轮执行授权。')
  }
  progress(library,session){
    const scope=this.inquiries.get(session)
    if(!scope?.task||scope.library!==library||this.store.library(library).owner!==session)return null
    const row=this.store.tasks(library).find(t=>t.task===scope.task)
    if(!row||!this.working.validRefs(library,row.refs))return null
    return {task:row.task,revision:row.revision,saved_status:row.value.status,recorded_progress:clip(row.value.progress,120),
      pending_step:clip(row.value.next_step||'',200),refs:row.refs.slice(0,2).map(id=>this.store.shortId(library,id)),
      scope:'仅汇报。检查点已记录的进度与计划可据此说明；下一步没有完成凭据时仍属待办，本轮不执行。'}
  }
  current(library,session){
    const active=this.turns.get(session)
    if(!active||active.library!==library||this.store.library(library).owner!==session||this.store.library(library).error||this.store.recovery.needsReview(library))return null
    const task=this.store.tasks(library).find(t=>t.task===active.task)
    if(!task||task.revision!==active.revision||!['planned','paused','running'].includes(task.value.status)||!this.working.validRefs(library,task.refs))return null
    return {active,task}
  }
  receipt(library,active){
    return this.store.db.prepare(`SELECT o.status,o.call_id,o.result_ref,o.result_digest FROM cm_checkpoint_attempts a
      JOIN cm_tool_operations o ON o.library=a.library AND o.session=a.session AND o.call_id=a.call_id
      WHERE a.library=? AND a.task=? AND a.revision=? AND (? IS NULL OR a.tool=?) ORDER BY a.rowid DESC LIMIT 1`).get(library,active.task,active.revision,active.tool,active.tool)
  }
  checkCompletion(library,session,args){
    if(args.value?.status!=='done')return
    const existing=this.store.tasks(library).find(t=>t.task===args.task)
    if(!existing)return
    const turn=this.turns.get(session)
    const armed=turn?.library===library&&turn.task===existing.task&&turn.revision===existing.revision
    const op=this.receipt(library,{task:existing.task,revision:existing.revision,tool:armed?turn.tool:existing.value.next_tool||null})
    if(!armed&&!existing.value.next_tool&&!op)return
    const ref=op?.result_ref&&JSON.parse(op.result_ref)
    if(op?.status==='succeeded'&&op.result_digest&&ref&&Array.isArray(args.refs)&&args.refs.some(id=>{
      const r=this.store.record(library,id)
      return r.role==='tool'&&r.type==='tool/result'&&r.session===ref.session&&r.seq===ref.seq
    }))return
    fail('CHECKPOINT_RECEIPT_REQUIRED','此执行步骤仍缺少匹配的成功工具结果原文。先核对实际产物，再引用该结果保存完成状态。')
  }
  view(library,session){
    const state=this.current(library,session);if(!state)return null
    const {active,task}=state,receipt=this.receipt(library,active)
    return {task:task.task,revision:task.revision,progress:clip(task.value.progress,100),next_step:clip(task.value.next_step,220),tool:active.tool,
      ...(receipt?{attempt:receipt.status,call:receipt.call_id,check:'核对本次工具结果和实际产物，勿重复执行。凭据吻合时报告本步已完成；旧检查点的状态不能代替本轮结果。缺少凭据则报告未核实。'}:
        {check:'本轮用户明确要求继续。核对任务、权限及现场后执行下一步，查看实际结果再报告。受阻则说明阻碍。读取检查点不算完成。'})}
  }
  remind(library,agent,turn){
    const session=agent.session.id,state=this.current(library,session)
    if(!state||state.active.turn!==turn||state.active.reminded||state.active.attempted||this.receipt(library,state.active))return null
    if(agent.inbox?.nextTurn?.length||agent.inbox?.nextStep?.length)return null
    for(const event of agent.session.snapshotEvents?.(state.active.fromSeq)||[]){
      const call=dshToolEvent(event)?.call
      if(!call||call.name.startsWith('cm_'))continue
      const op=this.store.db.prepare('SELECT readonly,status FROM cm_tool_operations WHERE library=? AND session=? AND call_id=?').get(library,session,call.callId)
      if(!op?.readonly||op.status!=='succeeded')return null
    }
    state.active.reminded=true
    return '本轮任务仍只有历史进度，未记录本轮执行凭据。请依照用户本轮授权核对检查点，能执行就调用对应工具并核对产物；若需要确认、目标不明确或工具不可用，向用户说明后停止。不要重放旧调用。'
  }
}
