import test from 'node:test'
import assert from 'node:assert/strict'
import {readOnlyShell} from '../lib/read-only-shell.mjs'
import {readOnlyTool} from '../lib/recovery.mjs'

test('literal diagnostic commands and pipelines are recognized without executing them',()=>{
 for(const command of ['pwd','cat "C:/agent-test/README.md"','head -n 20 README.md','tail -5 restart.log','ls -lah','wc -l README.md','rg --files','grep -ci "DSH NEXT"','tasklist /fo csv /nh','sleep 12; cat "C:/agent-test/home/inbox/restart.log" 2>/dev/null | tail -5; echo "---"; tasklist | grep -ci "DSH NEXT"','cat "file;with-punctuation.txt"','echo "rm is just literal text"'])assert.equal(readOnlyShell(command),true,command)
})
test('shell writes, arbitrary execution, expansion, delegation and alternate redirections stay gated',()=>{
 for(const command of ['cat README.md > copy.txt','cat README.md 2> errors.log','cat README.md; rm old.txt','cat $(touch marker)','cat `touch marker`','echo ok &','python -c "open(\'marker\',\'w\')"','bash -c "cat README.md"','rg --pre=touch pattern','rg --hostname-bin=touch pattern','rg --pre touch pattern','find . -exec rm {} ;','sed -i s/a/b/ file','X=1 cat README.md','cat *','cat README.md\necho ok','sleep 90','tasklist /s remote-server','cat < input','echo foo;','cat "unterminated','cat README.md 2>/dev/null>marker'])assert.equal(readOnlyShell(command),false,command)
})
test('DSH working-directory reads are distinct from changes and shell metadata cannot inject an environment',()=>{
 assert.equal(readOnlyTool('working_directory',{}),true);assert.equal(readOnlyTool('working_directory',{cd:'C:/agent-test'}),false)
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',timeoutMs:1000}),true)
 assert.equal(readOnlyTool('ops_bash',JSON.stringify({command:'cat README.md'})),true)
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',env:{BASH_ENV:'malicious.sh'}}),false)
 assert.equal(readOnlyTool('ops_bash',{command:'cat README.md',background:true}),false)
})
