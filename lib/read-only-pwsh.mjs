/** Literal-only PowerShell diagnostics. This classifies text; it never evaluates a script. */
export function readOnlyPwsh(command){
 if(typeof command!=='string'||!command.trim()||command.length>12000||/[\x00-\x08\x0b\x0c\x0e-\x1f$`]/.test(command))return false
 const groups=[];let words=[],word='',active=false,quote=null
 const flush=()=>{if(active){words.push(word);word='';active=false}}
 const finish=()=>{flush();if(words.length){groups.push(words);words=[]}}
 for(let i=0;i<command.length;i++){
  const c=command[i]
  if(quote){if(c===quote){if(quote==="'"&&command[i+1]==="'"){word+="'";i++}else quote=null}else word+=c;continue}
  if(c==='"'||c==="'"){quote=c;active=true;continue}
  if(/[&<>(){}\[\]#]/.test(c))return false
  if(c===';'||c==='|'||c==='\n'||c==='\r'){finish();if(c==='|'&&command[i+1]==='|')return false;continue}
  if(/\s/.test(c)){flush();continue}word+=c;active=true
 }
 if(quote)return false;finish();if(!groups.length)return false
 const common=['erroraction','ea'],definitions={
  'get-content':['path','literalpath','totalcount','head','tail','raw','encoding','readcount'],
  'get-childitem':['path','literalpath','filter','include','exclude','recurse','depth','file','directory','force','name'],
  'get-item':['path','literalpath','force'], 'test-path':['path','literalpath','pathtype'],
  'get-location':[], 'get-process':['name','id'],
  'select-string':['path','literalpath','pattern','simplematch','casesensitive','list','quiet','notmatch','allmatches','context','encoding'],
  'select-object':['property','first','last','skip','skiplast','unique','expandproperty'],
  'measure-object':['property','line','word','character','sum','average','minimum','maximum'],
  'format-list':['property'], 'format-table':['property','autosize','hidetableheaders'],
  'sort-object':['property','descending','unique'], 'get-filehash':['path','literalpath','algorithm']
 }
 return groups.every(([raw,...args])=>{
  const name=raw.toLowerCase();if(!Object.hasOwn(definitions,name))return false
  const allowed=new Set([...definitions[name],...common])
  for(let i=0;i<args.length;i++){
   const a=args[i];if(!a.startsWith('-'))continue
   const key=a.slice(1).toLowerCase();if(!allowed.has(key))return false
   if(common.includes(key)&&!['stop','silentlycontinue','continue'].includes(args[++i]?.toLowerCase()))return false
  }
  return true
 })
}
