/** Authored situations + real localhost embeddings; no LLM answers or live-session data. */
import {mkdtempSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {ContinuityStore} from '../lib/store.mjs'
import {Embedding} from '../lib/embedding.mjs'
import {Scenes} from '../lib/scenes.mjs'
import {Situations} from '../lib/situations.mjs'
import {SituationIndex} from '../lib/situation-index.mjs'

// Fixture and expectations are fixed before the model runs; labels are never indexed.
const projects=[
  {key:'tide-film',title:'东港海边短片剪辑',body:'东港清晨防波堤的三十秒海边短片已经剪完画面，仍缺最后一段海浪声音。下一步是录制浪声音效，不是重新拍摄。'},
  {key:'family-album',title:'祖母旧相册扫描归档',body:'祖母的黑白家庭照片按年份扫描，目前只完成一九八四年的照片。扫描后先做数码备份，照片黄边暂时保留，剩余相册还没有处理。'},
  {key:'lighthouse-radio',title:'灯塔社区电台片头',body:'社区电台的开场音频确定用两声铜铃，接着放潮汐和海风背景声。铜铃已录好，潮汐背景还没降噪，尚未发布。'},
  {key:'bike-light',title:'折叠车夜骑车灯底座',body:'夜骑时车灯固定件会松动，打印的底座尺寸合适，但路面颠簸后仍会转动。下一步加橡胶垫再测试，不表示修理已经成功。'},
  {key:'moss-parser',title:'Moss语言的字符串语法解析器',body:'Moss解析器碰到带转义引号的字符串时会提前结束文本。问题已经定位到转义状态机，还没有提交修复；下一步补一个包含反斜杠的例子。'},
  {key:'basil-seedlings',title:'阳台罗勒育苗观察',body:'两盆罗勒幼苗移到东侧窗边，左盆土壤干得快，右盆仍然潮湿。先只给左盆少量浇水，右盆继续等，暂时不施肥。'},
  {key:'mountain-film',title:'山间步道短片剪辑',body:'山间短片使用黄昏松林和石阶素材，结尾缺鸟鸣音效。画面尚未定稿，下一步先删去抖动镜头，与东港海边短片分别整理。'},
  {key:'lake-film',title:'北湖划船短片剪辑',body:'北湖短片需要重新调整水面高光，桨声已经录好，暂时不增加旁白。下次先做色彩校正。'},
  {key:'night-film',title:'雨夜街灯短片剪辑',body:'雨夜街灯视频采用竖屏，路人面部还需打码，配乐已经选好。先检查隐私遮挡，再导出预览。'},
  {key:'station-podcast',title:'旧车站口述历史播客',body:'车站播客已经采访两名售票员，下一步核对地名读音。片头使用火车汽笛，不使用社区电台的铜铃。'},
  {key:'succulent-care',title:'阳台多肉换盆',body:'三盆多肉换到颗粒土后先停水，周末观察根部恢复。这个安排不用于罗勒幼苗。'},
  {key:'fern-care',title:'书房蕨类湿度记录',body:'书房蕨类叶尖发干，计划提高空气湿度。盆土尚湿，不额外浇水，先记录一周。'},
  {key:'bike-brake',title:'通勤自行车刹车调整',body:'通勤自行车前刹有摩擦声，已经校正碟片，下一步检查来令片间距。尚未进行长距离骑行验证。'},
  {key:'bike-bag',title:'折叠车后座驮包挑选',body:'折叠车驮包要求防雨且不碰脚跟，比较两款窄包。尚未购买，下一步量后座长度。'},
  {key:'cedar-parser',title:'Cedar配置文件解析器',body:'Cedar配置解析器不能读取嵌套数组，处理字符串转义的路径已经通过检查。下一步梳理数组栈。'},
  {key:'moss-highlighter',title:'Moss编辑器语法高亮',body:'Moss编辑器的注释颜色太浅，已经决定改成深灰，尚未调整主题文件。这是显示问题，与字符串解析错误分开。'},
  {key:'recipe-cards',title:'手写食谱卡整理',body:'整理外婆的手写食谱卡，先扫描甜点部分，再补充缺失的用量。暂不改写原来的烹饪步骤。'},
  {key:'map-archive',title:'城市旧地图数字存档',body:'旧地图按年代拍照，已完成城区东侧两张。下一步用平行光重拍折痕处，避免把折痕误修成道路。'},
  {key:'ceramic-glaze',title:'陶杯釉色试烧记录',body:'陶杯试片使用青灰釉，第二次试烧边缘流釉。下一步减少边缘施釉厚度，未决定正式批量制作。'},
  {key:'linen-curtain',title:'亚麻窗帘缝制',body:'亚麻窗帘完成一边折边，另一边尺寸还没确认。下一步重新量窗框，不直接按旧尺寸裁剪。'},
  {key:'coral-palette',title:'珊瑚图鉴网页配色',body:'珊瑚图鉴网页决定以暖杏色做背景，深青色标注分类。导航颜色尚未更新，下一步先做一页预览。'},
  {key:'bird-watch',title:'河口候鸟观察笔记',body:'河口观察见到白鹭和反嘴鹬，尚未确认一只远处的灰色鸟。下一次带望远镜核对，不把猜测写成确定物种。'},
  {key:'library-labels',title:'家庭图书架标签',body:'书架标签按作者姓氏排序，儿童绘本单独一层。已经贴完左侧两格，右侧尚未整理。'},
  {key:'tea-tasting',title:'焙火乌龙品饮记录',body:'乌龙茶试泡采用九十度水，第三泡苦味偏高。下一次缩短浸泡时间，暂时不更换茶具。'}
]
const cases=[
  {id:'old-coastal-film-paraphrase',query:'之前那支海边短片缺的海浪声音补上了吗？',expected:['tide-film'],kind:'paraphrase'},
  {id:'old-family-photos-paraphrase',query:'奶奶的照片数码备份进展如何？',expected:['family-album'],kind:'paraphrase'},
  {id:'old-radio-intro',query:'社区电台开场那两声铜铃，后来要接什么背景声？',expected:['lighthouse-radio'],kind:'paraphrase'},
  {id:'old-cycle-light',query:'夜骑时车灯固定件的松动，下一步怎么处理？',expected:['bike-light'],kind:'paraphrase'},
  {id:'old-parser-versus-highlighter',query:'Moss里带转义引号的文本还会把语法解析弄坏吗？',expected:['moss-parser'],kind:'paraphrase'},
  {id:'old-seedling-watering',query:'罗勒幼苗搬到窗边之后，两盆的浇水安排有什么不同？',expected:['basil-seedlings'],kind:'paraphrase'},
  {id:'similar-video-distinction',query:'山间步道短片接下来先处理抖动镜头，还是补鸟鸣？',expected:['mountain-film'],kind:'similar-project'},
  {id:'recent-web-palette',query:'珊瑚图鉴网页的导航配色做完了吗？',expected:['coral-palette'],kind:'recent'},
  {id:'unsupported-mars-sample',query:'上周买的火星土壤样本是哪家实验室检测的？',expected:[],kind:'unsupported'},
  {id:'unsupported-climbing-entry',query:'明年攀登珠峰的登山许可证编号是多少？',expected:[],kind:'unsupported'}
]
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const characters=value=>Array.from(JSON.stringify(value)).length
const invariant=(value,message)=>{if(!value)throw Object.assign(new Error(message),{code:'SITUATION_EVAL_INVARIANT'})}
const snapshot=store=>Object.fromEntries(['records','cm_situations','cm_situation_versions','cm_situation_sources','cm_situation_relations','cm_situation_focus','libraries','bindings'].map(table=>[table,store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))

export async function runSituationQuality(directory=mkdtempSync(join(tmpdir(),'continuity-situation-eval-'))){
  directory=resolve(directory);mkdirSync(directory,{recursive:true})
  // A fresh directory prevents this evaluator from opening any existing memory store.
  invariant(readdirSync(directory).length===0,'Evaluation requires a new empty directory')
  let clock=Date.parse('2026-01-01T00:00:00Z'),store,embedding,index
  const report={time:new Date().toISOString(),directory,fixture_sha256:digest({projects,cases}),synthetic_authored_sources:true,actual_local_embedding:true,cloud_model_calls:0,live_session_access:false,query_limit:3,rows:[],warm_batches:[]}
  try{
    store=new ContinuityStore(directory,{now:()=>clock});embedding=new Embedding(store)
    const situations=new Situations(store,new Scenes(store));index=new SituationIndex(store,situations,embedding,{enabled:true})
    const lib=store.create('Synthetic situation semantic quality');store.bind('eval-owner',lib.id,0)
    const ids={},creationOrder=[];let seq=0
    for(const project of projects){
      const refs=[project.title,project.body].map(text=>store.append(lib.id,{session:'synthetic-authored-history',seq:++seq,time:new Date(clock++).toISOString(),role:'assistant',text,origin:{kind:'synthetic-authored-situation-eval'}}))
      const s=situations.create(lib.id,'eval-owner',{title:project.title,refs:[refs[0]],mode:'experience',assertions:[{slot:'progress',body:project.body,refs:[refs[1]]}]})
      ids[project.key]=s.id;creationOrder.push(s.id);clock+=86400000
    }
    clock=Date.now()
    const before=snapshot(store),beforeHash=digest(before),older=new Set(creationOrder.slice(0,-8))
    report.fixture={situations:projects.length,source_records:seq,older_than_recent_eight:older.size,ids,initial_focus:situations.focused(lib.id,'eval-owner'),owner:store.library(lib.id).owner}
    report.model={model:embedding.model,endpoint:embedding.base,cloud_model_calls:0}
    const warmStart=performance.now()
    for(let batch=0;batch<100;batch++){
      const start=performance.now(),result=await index.warm(lib.id,'eval-owner')
      invariant(Number.isInteger(result.prepared)&&result.prepared<=8,'Warm batch exceeded eight situation projections')
      invariant(result.indexed<=8,'Warm batch embedded more than eight situations')
      report.warm_batches.push({batch:batch+1,prepared:result.prepared,indexed:result.indexed,discarded:result.discarded,ms:performance.now()-start})
      if(!index.status(lib.id).index_work_remaining)break
    }
    invariant(!index.status(lib.id).index_work_remaining,'Situation index did not drain in 100 bounded batches')
    report.warm_ms=performance.now()-warmStart
    for(const c of cases){
      const expectedIds=c.expected.map(key=>ids[key]),start=performance.now()
      const result=await index.lookup(lib.id,'eval-owner',c.query,3),returnedIds=result.results.map(card=>card.id),rank=returnedIds.findIndex(id=>expectedIds.includes(id))
      invariant(result.results.length<=3,'Lookup exceeded the requested result limit')
      invariant(!result.incomplete,'Fully warmed evaluation unexpectedly reports incomplete coverage')
      invariant(characters(result)<=1200,'Lookup response exceeded compact character budget')
      for(const card of result.results){
        invariant(creationOrder.includes(card.id),'Lookup returned a situation outside the synthetic library')
        invariant(characters(card)<=250,'Lookup card exceeded compact character budget')
        invariant(situations.get(lib.id,card.id).revision===card.revision,'Lookup returned a stale situation revision')
        for(const ref of card.refs)invariant(store.record(lib.id,ref).library===lib.id,'Lookup returned an invalid source reference')
      }
      report.rows.push({id:c.id,kind:c.kind,query:c.query,expected_keys:c.expected,expected_ids:expectedIds,expected_older_than_recent_eight:expectedIds.some(id=>older.has(id)),returned_ids:returnedIds,returned_keys:projects.filter(p=>returnedIds.includes(ids[p.key])).map(p=>p.key),returned:result.results,hit:expectedIds.length?rank>=0:null,reciprocal_rank:expectedIds.length?(rank<0?0:1/(rank+1)):null,unexpected_candidates:expectedIds.length?returnedIds.filter(id=>!expectedIds.includes(id)):returnedIds,characters:characters(result),note:result.note,ms:performance.now()-start})
    }
    const after=snapshot(store),unchanged=digest(after)===beforeHash,positive=report.rows.filter(row=>row.hit!==null),oldPositive=positive.filter(row=>row.expected_older_than_recent_eight),negative=report.rows.filter(row=>row.hit===null)
    report.invariants={raw_records_unchanged:digest(before.records)===digest(after.records),situation_documents_unchanged:digest(before.cm_situation_versions)===digest(after.cm_situation_versions),no_automatic_merge:digest(before.cm_situation_relations)===digest(after.cm_situation_relations),focus_unchanged:digest(before.cm_situation_focus)===digest(after.cm_situation_focus),owner_and_binding_unchanged:digest([before.libraries,before.bindings])===digest([after.libraries,after.bindings]),all_source_and_control_tables_unchanged:unchanged}
    invariant(unchanged,'Retrieval changed source records, situation documents, relations, focus, ownership, or bindings')
    report.summary={queries:report.rows.length,positive_queries:positive.length,hits_at_3:positive.filter(row=>row.hit).length,hit_at_3:positive.filter(row=>row.hit).length/positive.length,mrr_at_3:positive.reduce((sum,row)=>sum+row.reciprocal_rank,0)/positive.length,older_than_recent_eight_queries:oldPositive.length,older_than_recent_eight_hits:oldPositive.filter(row=>row.hit).length,unsupported_queries:negative.length,unsupported_queries_with_candidates:negative.filter(row=>row.returned_ids.length).length,maximum_response_characters:Math.max(...report.rows.map(row=>row.characters)),misses:positive.filter(row=>!row.hit).map(row=>row.id),measures_source_retrieval_only:true,answer_accuracy_not_measured:true}
    report.index=index.status(lib.id)
    report.caveat='Measures candidate retrieval from authored, synthetic situation projections only. Paraphrase misses and unsupported-query candidates are recorded, never converted into success assertions. Candidates do not establish facts, completed actions, or that two projects are the same experience. No answer-generation model or live chat data was used.'
  }catch(error){report.error={code:error.code||error.name,message:error.message}}
  finally{
    embedding?.close();store?.close()
    writeFileSync(join(directory,'situation-quality.json'),JSON.stringify(report,null,2))
  }
  return report
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const directory=process.argv.slice(2).find(value=>!value.startsWith('--')),report=await runSituationQuality(directory)
  console.log(JSON.stringify({directory:report.directory,report:join(report.directory,'situation-quality.json'),summary:report.summary,invariants:report.invariants,unsupported:report.rows.filter(row=>row.hit===null).map(row=>({id:row.id,returned_keys:row.returned_keys})),error:report.error}))
  if(report.error)process.exitCode=1
}
