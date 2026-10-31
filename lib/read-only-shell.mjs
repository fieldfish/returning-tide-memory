/** Recognize a small literal-only diagnostic grammar. Never execute or infer from keywords. */
export function readOnlyShell(command){
 if(typeof command!=='string'||!command.trim()||command.length>12000||/[\x00-\x08\x0a-\x1f$`()<>!]/.test(command.replaceAll('2>/dev/null','')))return false
 const groups=[];let words=[],word='',active=false,quote=null
 const flush=()=>{if(active){words.push(word);word='';active=false}}
 const finish=()=>{flush();if(!words.length)return false;groups.push(words);words=[];return true}
 for(let i=0;i<command.length;i++){
  const c=command[i]
  if(quote){if(c===quote){quote=null;continue}if(c==='\\'&&quote==='"'&&['\\','"'].includes(command[i+1]))word+=command[++i];else word+=c;continue}
  if(c==='"'||c==="'"){quote=c;active=true;continue}
  if(c==='\\'){if(i+1>=command.length)return false;word+=command[++i];active=true;continue}
  if(/\s/.test(c)){flush();continue}
  if(!active&&command.startsWith('2>/dev/null',i)&&(!command[i+11]||/[\s;|&]/.test(command[i+11]))){i+=10;continue}
  if(';|&'.includes(c)){if(!finish())return false;if(c==='&'&&command[i+1]!=='&')return false;if(command[i+1]===c&&c!==';')i++;continue}
  if('><*?[]{}#'.includes(c))return false
  word+=c;active=true
 }
 if(quote||!finish())return false
 const flags={cat:/^-[nbsvETA]+$|^--(?:number|number-nonblank|squeeze-blank|show-ends|show-tabs|show-nonprinting|show-all)$/,head:/^-[qv]$|^-\d+$|^--(?:quiet|silent|verbose)$/,tail:/^-[qv]$|^-\d+$|^--(?:quiet|silent|verbose)$/,ls:/^-[aAlhtrSdFR1]+$|^--(?:all|almost-all|human-readable|color=never|file-type|group-directories-first|literal)$/,stat:/^-[fLt]+$/,wc:/^-[lwmcL]+$/,grep:/^-[nicvFElrRshHo]+$|^--(?:line-number|ignore-case|count|invert-match|fixed-strings|extended-regexp|files-with-matches|recursive|no-messages|no-filename|with-filename|only-matching)$/,rg:/^-[niFlsSv]+$|^--(?:files|line-number|ignore-case|fixed-strings|files-with-matches|case-sensitive|smart-case|invert-match|no-heading|hidden)$/,pwd:/^-[LP]$/}
 return groups.every(([name,...args])=>{
  if(name==='echo')return true
  if(name==='sleep')return args.length===1&&/^\d+(?:\.\d+)?s?$/.test(args[0])&&Number(args[0].replace(/s$/,''))<=60
  if(name==='tasklist'||name==='tasklist.exe')return args.length===0||args.every((arg,index)=>arg.toLowerCase()==='/nh'||arg.toLowerCase()==='/fo'&&['csv','list','table'].includes(args[index+1]?.toLowerCase())||index>0&&args[index-1].toLowerCase()==='/fo'&&['csv','list','table'].includes(arg.toLowerCase()))
  if(!Object.hasOwn(flags,name))return false
  let positional=false
  for(let i=0;i<args.length;i++){
   const arg=args[i]
   if(positional)continue
   if(arg==='--'){positional=true;continue}
   if((name==='head'||name==='tail')&&['-n','-c'].includes(arg)){if(!/^[+-]?\d{1,6}$/.test(args[++i]||''))return false;continue}
   if(arg.startsWith('-')&&!flags[name].test(arg))return false
   if(name==='pwd'&&!arg.startsWith('-'))return false
  }
  return true
 })
}
