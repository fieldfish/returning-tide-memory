import test from 'node:test'
import assert from 'node:assert/strict'
import {createToolContracts,registerReadOnlyTool,guardHostRead} from '../lib/tool-contracts.mjs'

const definition=(name)=>({name,parameters:{type:'object',properties:{}},execute:async()=>name})
test('a late scope replacement or changed diagnostic cannot dispatch under an earlier read permit',()=>{
  const exec={arguments:{command:'Get-Location'}},descriptor=Object.getOwnPropertyDescriptor(exec,'arguments')
  let originalProvider=true
  const done=guardHostRead(exec,args=>originalProvider&&args.command==='Get-Location')
  assert.equal(exec.arguments.command,'Get-Location')
  originalProvider=false;assert.throws(()=>exec.arguments,/changed/)
  originalProvider=true;exec.arguments={command:'Set-Content marker x'}
  assert.throws(()=>exec.arguments,/changed/);done()
  const after=Object.getOwnPropertyDescriptor(exec,'arguments')
  assert.equal(after.writable,descriptor.writable);assert.equal(after.value.command,'Set-Content marker x')
})
async function host(enabled=true) {
  const table=new Map(), registries=new Map(), packages=new Map()
  const preset={},agent={parent:preset},other={}
  const scopeApi={scopeOf:ctx=>ctx.scope,scopeChainOf:target=>[target,target?.parent,undefined]}
  packages.set('dsh-scope',scopeApi)
  function put(scope,tool){
    if(!table.has(scope))table.set(scope,new Map())
    table.get(scope).set(tool.name,tool)
  }
  function get(name,scope){
    for(const location of scopeApi.scopeChainOf(scope)){
      const tool=table.get(location)?.get(name)
      if(tool)return tool
    }
  }
  const ctx={loader:{import:async spec=>packages.get(spec.split('/')[1])},
    registry:{get:callback=>registries.get(callback)},tools:{get,register:tool=>{put(agent,tool);return ()=>table.get(agent).delete(tool.name)}}}
  const plugin={apply(){}},fiber={state:2,config:{edit:enabled,write:enabled},runtime:{callback:plugin.apply},ctx:{scope:preset}}
  packages.set('dsh-tool-fs',plugin);registries.set(plugin.apply,{fibers:[fiber]})
  const native=definition('edit');put(preset,native)
  return {contracts:await createToolContracts(ctx),ctx,put,get,preset,agent,other,native,fiber}
}

test('official preset ownership requires a ready enabled fiber in the visible scope',async()=>{
  const {contracts,preset,agent,other,put,native,fiber}=await host()
  const inspect=target=>contracts.inspect('edit',target,{})
  assert.equal(inspect(agent).origin.source,'official-scoped')
  assert.equal(inspect(other).origin,undefined)
  fiber.state=0;contracts.ownerChanged(fiber);assert.equal(inspect(agent).origin,null)
  fiber.state=2;contracts.ownerChanged(fiber);assert.ok(inspect(agent).origin)
  put(agent,{...native});assert.equal(inspect(agent).origin,null)
  assert.ok(inspect(preset).origin)
  const disabled=await host(false)
  assert.equal(disabled.contracts.inspect('edit',disabled.agent,{}).origin,null)
})

test('native executor and schema are pinned at owner activation before the first invocation',async()=>{
  for(const change of [def=>{def.execute=async()=>false},def=>{def.parameters.required=['newKey']}]){
    const {contracts,native,agent}=await host()
    change(native);assert.equal(contracts.inspect('edit',agent,{}).origin,null)
  }
  const {ctx,agent}=await host()
  ctx.registry.get=()=>{throw Error('registry unavailable')}
  const contracts=await createToolContracts(ctx)
  assert.notEqual(contracts.inspect('edit',agent,{}).origin?.source,'official-scoped')
})

test('an exact registered reader permits only explicitly side-effect-free modes',async()=>{
  const {ctx,contracts,get,agent,put}=await host()
  const original=definition('video_probe')
  registerReadOnlyTool(ctx,original,args=>args.mode==='inspect' && Object.keys(args).length===1)
  const inspect=args=>contracts.inspect('video_probe',agent,args)
  assert.equal(inspect({mode:'inspect'}).readOnly,true)
  for(const args of [{mode:'save'},{mode:'inspect',output:'file'},{}])assert.equal(inspect(args).readOnly,false)
  const registered=get('video_probe',agent)
  const copy={...registered}
  for(const key of Object.getOwnPropertySymbols(registered))Object.defineProperty(copy,key,Object.getOwnPropertyDescriptor(registered,key))
  put(agent,copy);assert.equal(inspect({mode:'inspect'}).readOnly,false)
  put(agent,registered);registered.parameters.required=['extra'];assert.equal(inspect({mode:'inspect'}).readOnly,false)
  put(agent,{...original,readOnly:true});assert.equal(inspect({mode:'inspect'}).readOnly,false)
})

test('a provider cannot use a read declaration for reserved tools, by throwing, or by returning a promise',async()=>{
  const {ctx,contracts,agent}=await host()
  for(const name of ['pwsh','edit','write','web_fetch','cm_library','run_code'])
    assert.throws(()=>registerReadOnlyTool(ctx,definition(name)),/Reserved/)
  for(const when of [()=>{throw Error('missing')},()=>1,async()=>true,async()=>{throw Error('async failure')}]){
    const remove=registerReadOnlyTool(ctx,definition('probe'),when)
    assert.equal(contracts.inspect('probe',agent,{}).readOnly,false);remove()
  }
  const args={mode:'inspect'}
  registerReadOnlyTool(ctx,definition('probe'),copy=>{copy.mode='changed';return true})
  assert.equal(contracts.inspect('probe',agent,args).readOnly,true);assert.equal(args.mode,'inspect')
})

test('a verified read is checked again at the provider boundary after downstream argument rewrites',async()=>{
  const {ctx,contracts,agent,get}=await host(), effects=[]
  const tool={...definition('probe'),execute:args=>effects.push(args.mode)}
  registerReadOnlyTool(ctx,tool,args=>args.mode==='inspect')
  const exec={arguments:{mode:'inspect'}}, registered=get('probe',agent)
  const done=contracts.inspect('probe',agent,exec.arguments).guard(exec)
  exec.arguments.mode='save'
  assert.throws(()=>registered.execute(exec.arguments,exec),/read mode changed/)
  assert.deepEqual(effects,[]);done()
  registered.execute(exec.arguments,exec);assert.deepEqual(effects,['save'])
})
