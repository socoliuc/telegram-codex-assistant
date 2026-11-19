import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { DesktopTools } from '../src/desktop-tools.mjs';

test('concurrent desktop reads wait for MCP initialization and tool validation',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'desktop-mcp-'));let tools;
  try{
    const server=join(folder,'server.mjs');const host=join(folder,'host.json');
    writeFileSync(host,JSON.stringify({pipe:'\\\\.\\pipe\\validation-only'}));
    writeFileSync(server,`import {createInterface} from 'node:readline';
let ready=false;const reply=(id,result,error)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')setTimeout(()=>reply(m.id,{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}),70);
else if(m.method==='tools/list'){ready=true;reply(m.id,{tools:['list_threads','read_thread','wait_threads','send_message_to_thread'].map(name=>({name,inputSchema:{type:'object'}}))});}
else if(m.method==='tools/call'){if(!ready)return reply(m.id,null,{code:-32000,message:'Used before initialization'});if(m.params.name==='list_threads' && m.params.arguments.limit>50)return reply(m.id,null,{code:-32602,message:'Catalog limit exceeds 50'});reply(m.id,{content:[{type:'text',text:JSON.stringify(m.params.name==='list_threads'?{threads:[],pinnedThreads:[]}:{thread:{id:'source'},turns:[]})}]});}});`);
    tools=new DesktopTools({hostFile:host,serverPath:server,callerThreadId:()=> 'caller'});
    const [threads,source]=await Promise.all([tools.list(),tools.read('source')]);
    assert.deepEqual(threads,[]);assert.equal(source.thread.id,'source');
  }finally{if(tools?.rpc && tools.rpc.proc.exitCode===null){const done=once(tools.rpc.proc,'close');tools.close();await done;}rmSync(folder,{recursive:true,force:true});}
});
