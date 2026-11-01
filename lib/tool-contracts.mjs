import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {readOnlyTool} from './recovery.mjs'

const DECLARATION = Symbol.for('dsh-returning-tide-memory.read-contract.v1')
const OFFICIAL = {
  grep: [['dsh-tool-fs-search']], glob: [['dsh-tool-fs-search']],
  read: [['dsh-tool-fs','read']],
  read_image: [['dsh-tool-fs','readImage']],
  working_directory: [['dsh-tool-working-directory']],
  edit: [['dsh-tool-fs','edit']],
  write: [['dsh-tool-fs','write']],
  pwsh: [['dsh-tool-pwsh'],['dsh-tool-pwsh-persistent']],
  web_fetch: [['dsh-tool-web','fetch']]
}
function reserved(name) {
  return Object.hasOwn(OFFICIAL,name) || /^cm_/.test(name) ||
    ['bash','run_code'].includes(name)
}

function snapshot(definition) {
  if (!definition || typeof definition.execute !== 'function') return null
  return {definition,execute:definition.execute,schema:JSON.stringify(definition.parameters)}
}

function matches(stamp,definition) {
  return !!stamp && stamp.definition===definition && stamp.execute===definition.execute
    && stamp.schema===JSON.stringify(definition.parameters)
}

// The SDK resolves the scoped tool, then reads exec.arguments immediately before
// calling that tool. Keep this check local to the admitted invocation. A later
// middleware may replace an argument object or register a scoped shadow.
export function guardHostRead(exec,check) {
  const property=Object.getOwnPropertyDescriptor(exec,'arguments')
  if (!property?.configurable || !Object.hasOwn(property,'value')) throw new Error('Cannot guard mutable host arguments')
  let args=property.value
  Object.defineProperty(exec,'arguments',{configurable:true,enumerable:property.enumerable,
    get(){if(!check(args))throw new Error('Verified host reader or argument mode changed');return args},
    set(value){args=value}})
  return ()=>Object.defineProperty(exec,'arguments',{...property,value:args})
}

function allowsRead(predicate,args) {
  try {
    const result=predicate(structuredClone(args))
    if (result && typeof result.then==='function') Promise.resolve(result).catch(()=>{})
    return result===true
  } catch { return false }
}

/** Register an installed plugin's exact tool with an explicit synchronous read contract.
 * For a mixed tool the predicate must return true ONLY for side-effect-free argument modes.
 * Undeclared tools, copied metadata, and schemas or executors replaced after registration
 * do not inherit permission. This is an installed-code API, never a model-callable tool.
 */
export function registerReadOnlyTool(ctx,definition,when=()=>true) {
  if (typeof ctx?.tools?.register!=='function' || typeof definition?.name!=='string'
      || !definition.name || typeof definition.execute!=='function' || typeof when!=='function') {
    throw new TypeError('Expected a tool registration context, executable definition and read predicate')
  }
  if (reserved(definition.name)) throw new TypeError('Reserved tools use their host recovery contract')
  const guarded=new WeakMap(), execute=definition.execute
  const registered={...definition,execute(args,exec) {
    // DSH passes the same exec through its middleware and into the provider.
    // A later argument rewrite must not turn an admitted read into a write.
    if (guarded.has(exec)) {
      if (!allowsRead(when,args)) throw new Error('The declared read mode changed before execution')
      guarded.get(exec)?.(args)
    }
    return execute.call(this,args,exec)
  }}
  Object.defineProperty(registered,DECLARATION,{value:Object.freeze({
    stamp:Object.freeze(snapshot(registered)),name:registered.name,when,
    guard(exec,onEnter) { guarded.set(exec,onEnter); return ()=>guarded.delete(exec) }
  })})
  return ctx.tools.register(registered)
}

export async function createToolContracts(ctx,runtimePackageJson) {
  const modules=new Map()
  let scopeApi
  const hasRegistry=typeof ctx.registry?.get==='function'
  if (hasRegistry) {
    const requireFromHost=runtimePackageJson ? createRequire(resolve(runtimePackageJson)) : null
    async function load(name) {
      const specifier='@deepseek-ai/'+name
      // Cordis owns the actual module identity, including inside packaged desktop apps.
      try { if (typeof ctx.loader?.import==='function') return await ctx.loader.import(specifier) } catch {}
      try { return await import(requireFromHost ? pathToFileURL(requireFromHost.resolve(specifier)).href : specifier) } catch { return null }
    }
    scopeApi=await load('dsh-scope')
    const packages=new Set(Object.values(OFFICIAL).flat().map(([pkg])=>pkg))
    for (const pkg of packages) modules.set(pkg,await load(pkg))
  }

  const owners=new WeakMap(),legacyOwner={}
  function pinned(owner,name,definition) {
    let tools=owners.get(owner)
    if (!tools) owners.set(owner,tools=new Map())
    if (!tools.has(name)) tools.set(name,snapshot(definition))
    return matches(tools.get(name),definition)
  }
  function official(name,agent,definition) {
    if (!Object.hasOwn(OFFICIAL,name) || !definition) return null
    if (!hasRegistry) {
      // Compatibility with pre-inspection hosts: preserve only the old global FS proof.
      if ((name==='edit'||name==='write') && ctx.tools.get(name)===definition && pinned(legacyOwner,name,definition))
        return {owner:legacyOwner,source:'global-fs-compat'}
      return null
    }
    if (!scopeApi?.scopeOf || !scopeApi?.scopeChainOf) return null
    const chain=scopeApi.scopeChainOf(agent)
    for (const [pkg,enabled] of OFFICIAL[name]) {
      const plugin=modules.get(pkg)
      if (!plugin?.apply) continue
      // Match Cordis' registered callback, its active fiber and validated config. An
      // enabled official registration owns this name in its own scope (duplicates fail).
      for (const fiber of ctx.registry.get(plugin.apply)?.fibers??[]) {
        if (fiber.state!==2 || (enabled && fiber.config?.[enabled]!==true)) continue
        if (name==='read_image' && !fiber.ctx.get?.('attachments')) continue
        const scope=scopeApi.scopeOf(fiber.ctx)
        if (scope!==undefined && !chain.includes(scope)) continue
        if (ctx.tools.get(name,scope)!==definition || !pinned(fiber,name,definition)) continue
        return {owner:fiber,source:scope===undefined?'official-global':'official-scoped'}
      }
    }
    return null
  }
  function inspect(name,agent,args) {
    try {
      if (typeof ctx.tools?.get!=='function') return {available:false}
      const definition=ctx.tools.get(name,agent)
      if (!definition) return {available:true,definition}
      const origin=official(name,agent,definition)
      const declaration=definition[DECLARATION]
      const declared=!reserved(name) && declaration?.name===name && matches(declaration.stamp,definition)
        && (name!=='ops_bash'||readOnlyTool(name,args)) && allowsRead(declaration.when,args)
      const readOnly=!!origin && (name==='web_fetch'||readOnlyTool(name,args)) || !!declared
      return {available:true,definition,origin,readOnly,guard:declared?declaration.guard:undefined,
        stamp:(origin||readOnly)?snapshot(definition):null}
    } catch { return {available:false} }
  }
  function ownerChanged(fiber) {
    if (!fiber || fiber.state!==2) { if (fiber) owners.delete(fiber); return }
    try {
      const callback=fiber.runtime?.callback
      if (typeof callback!=='function' || !scopeApi?.scopeOf) return
      const scope=scopeApi.scopeOf(fiber.ctx)
      for (const [name,specs] of Object.entries(OFFICIAL)) {
        if (!specs.some(([pkg,flag])=>modules.get(pkg)?.apply===callback && (!flag||fiber.config?.[flag]===true))) continue
        const definition=ctx.tools.get(name,scope)
        if (definition) pinned(fiber,name,definition)
      }
    } catch { /* Incomplete activation is not proof. Inspect again at dispatch. */ }
  }
  for (const plugin of modules.values()) {
    try { if (plugin?.apply) for (const fiber of ctx.registry.get(plugin.apply)?.fibers??[]) ownerChanged(fiber) }
    catch { /* Optional host inspection can be unavailable during activation. */ }
  }
  // Preserve the existing frozen global-FS guard on older hosts.
  for (const name of ['edit','write']) inspect(name,undefined,{})
  return {inspect,matches,ownerChanged}
}
