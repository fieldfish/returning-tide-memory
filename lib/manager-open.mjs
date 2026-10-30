import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {fail} from './util.mjs'

export function managerAddress(directory){
 let access
 try{access=JSON.parse(readFileSync(join(directory,'manager-access.json'),'utf8'))}catch{fail('MANAGER_UNAVAILABLE','请先在DSH启用manager.enabled并正常加载插件')}
 const url=new URL(access.url)
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!/^#[a-f0-9]{64}$/.test(url.hash)||!url.port||url.username||url.password||url.pathname!=='/'||url.search)fail('INVALID_MANAGER_ADDRESS','管理地址格式不符，拒绝打开')
 try{process.kill(access.pid,0)}catch{fail('MANAGER_UNAVAILABLE','管理后台已退出，请重新加载插件')}
 return url.href
}
export function openManager(directory){
 const url=managerAddress(directory)
 const [command,args]=process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',url]]:process.platform==='darwin'?['open',[url]]:['xdg-open',[url]]
 const child=spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{process.stderr.write('无法打开浏览器；请检查系统默认浏览器。\n')});child.unref()
 return {opened:true,local_only:true,token_printed:false}
}
