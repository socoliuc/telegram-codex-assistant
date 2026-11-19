import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/state.mjs';
import { DesktopMonitor } from '../src/desktop.mjs';

const projectA = process.platform === 'win32' ? 'D:\\a' : '/tmp/tg-desktop-projects/a';
const projectB = process.platform === 'win32' ? 'D:\\b' : '/tmp/tg-desktop-projects/b';
const listenerLocal = process.platform === 'win32' ? 'D:\\assistant\\.local' : '/tmp/tg-assistant/.local';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-alert-'));
  const store = new StateStore(join(dir,'state.json')); store.data.owner={userId:1,chatId:1};
  const histories = new Map(); const sent=[]; const submitted=[];
  const tools={ async list(){return [...histories.values()].map(h=>({...h.thread,status:h.thread.status.type,kind:'codex',hostId:'local'}));},
    async poll(targets){return {polls:targets.map(t=>{const h=histories.get(t.threadId),cursor=JSON.stringify(h);return {thread:{id:t.threadId,status:h.thread.status},latestTurn:h.turns[0],cursor,changed:cursor!==t.afterCursor};})};},
    async read(id){return structuredClone(histories.get(id));}, async send(id,text,hostId){submitted.push({id,text,hostId});return {status:'sent'};} };
  const send=async(text,jobId,keyboard,onDelivered)=>{const message={message_id:sent.length+1};sent.push({text,message});onDelivered?.(message);return [message];};
  const monitor=new DesktopMonitor({tools,store,send,loadProjects:()=>[
    {id:'a',name:'A',roots:[projectA]},{id:'b',name:'B',roots:[projectB]}],loadEvents:()=>[],excludeThreadIds:()=>[],minimumScanMs:0});
  const put=(id,project,turn,status='completed',text='Finished')=>histories.set(id,{thread:{id,title:`Task ${id}`,cwd:project === 'a' ? projectA : projectB,updatedAt:Date.now(),status:{type:status==='inProgress'?'active':'idle'}},turns:[{
    id:turn,status,startedAt:Date.now()/1000+1,completedAt:status==='completed'?Date.now()/1000+2:null,
    items:[{type:'agentMessage',id:'item-'+turn,phase:'final_answer',text}]}]});
  return {dir,store,histories,sent,submitted,tools,monitor,put,cleanup(){rmSync(dir,{recursive:true,force:true});}};
}

test('an existing chat returns only its Telegram-requested reply when desktop status polling fails', async () => {
  const f = fixture();
  try {
    f.put('source', 'a', 'older');
    await f.monitor.reply({ threadId: 'source', hostId: 'local', projectId: 'a', kind: 'chat' }, 'Dry run', 701);
    f.tools.list = async () => { throw new Error('Desktop discovery unavailable'); };
    const original = f.tools.read;
    const reads = [];
    f.tools.read = async (id, host, options) => {
      reads.push({ id, host, options });
      return original(id);
    };
    const marker = f.store.data.desktopSubmissions['701'].requestMarker;
    const wrapped = `<codex_delegation>\n  <source_thread_id>sender</source_thread_id>\n  <input>\n${marker} in this conversation:\n\nDry run\n  </input>\n</codex_delegation>`;
    const target = f.histories.get('source');
    target.turns.unshift({ id: 'unrelated', status: 'completed', items: [
      { type: 'agentMessage', phase: 'final_answer', text: wrapped }
    ] });
    await f.monitor.scan();
    assert.equal(f.sent.length, 0);
    target.turns[1] = { id: 'requested', status: 'completed', items: [
      { type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: wrapped } },
      { type: 'agentMessage', phase: 'final_answer', text: 'Verified reply' }
    ] };
    await f.monitor.scan();
    await f.monitor.scan();
    assert.deepEqual(reads, Array(2).fill({ id: 'source', host: 'local', options: { turnLimit: 3, includeOutputs: true } }));
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /A · Task source[\s\S]*Verified reply/);
    assert.equal(f.store.data.desktopSubmissions['701'].resultTurnId, 'requested');
    assert.equal(f.store.data.desktopReplies['1'].direct, true);
    assert.equal(f.submitted.length, 1);
  } finally { f.cleanup(); }
});

test('desktop completion routes remain tied to original projects across restart and selection changes',async()=>{
  const f=fixture();try{
    f.put('desktop-a','a','a-1');f.put('desktop-b','b','b-1');
    await f.monitor.scan();assert.equal(f.sent.length,2);
    f.store.data.selectedProjectId='b';
    const restarted=new DesktopMonitor({tools:f.tools,store:new StateStore(f.store.file),send:async()=>[],loadProjects:()=>[],loadEvents:()=>[],excludeThreadIds:()=>[]});
    await restarted.reply(f.store.data.desktopReplies['1'],'Change A only',90);
    await restarted.reply(f.store.data.desktopReplies['2'],'Change B only',91);
    assert.equal(f.submitted[0].id,'desktop-a');assert.match(f.submitted[0].text,/Change A only/);
    assert.equal(f.submitted[1].id,'desktop-b');
    await f.monitor.scan();assert.equal(f.sent.length,2);
  }finally{f.cleanup();}
});

test('desktop image references stay in the original conversation and uncertain image replies never replay', async () => {
  const f = fixture(); try {
    f.put('source', 'a', 'turn'); await f.monitor.scan();
    f.store.data.selectedProjectId = 'b';
    await f.monitor.reply(f.store.data.desktopReplies['1'], 'Read this', 901, ['C:\\private\\photo.png']);
    assert.equal(f.submitted[0].id, 'source');
    assert.match(f.submitted[0].text, /image-reading tool/);
    assert.ok(f.submitted[0].text.includes(JSON.stringify('C:\\private\\photo.png')));
    await assert.rejects(f.monitor.reply(f.store.data.desktopReplies['1'], 'Read this', 901, ['C:\\private\\photo.png']), /already/);
    assert.equal(f.submitted.length, 1);
  } finally { f.cleanup(); }
});

test('old completed desktop history is baselined; running work and explicit questions notify when actionable',async()=>{
  const f=fixture();try{
    f.put('old','a','old-turn');f.histories.get('old').turns[0].startedAt=1;
    f.put('active','b','work','inProgress','');
    await f.monitor.scan();assert.equal(f.sent.length,0);
    f.put('active','b','work','completed','Done with B');
    await f.monitor.scan();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/Done with B/);
    f.put('question','a','ask','inProgress','Which option?');
    f.histories.get('question').turns[0].items[0]={type:'agentMessage',id:'ask-item',text:'Choose a color',phase:'commentary',delivery:'async',questions:[{title:'Which color?',options:['Red','Blue']}]};
    await f.monitor.scan();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/Which color/);
    await f.monitor.reply(f.store.data.desktopReplies['2'],'Blue',95);assert.equal(f.submitted.at(-1).id,'question');
  }finally{f.cleanup();}
});

test('uncertain notification/submission outcomes are never replayed and keep confirmed chunk routes',async()=>{
  const f=fixture();try{
    f.put('a','a','t');
    f.monitor.send=async(text,jobId,keyboard,onDelivered)=>{onDelivered({message_id:800});throw new Error('later chunk unknown');};
    await f.monitor.scan();assert.equal(f.store.data.desktopReplies['800'].threadId,'a');
    await f.monitor.scan();assert.equal(Object.keys(f.store.data.desktopReplies).length,1);
    f.tools.send=async()=>{f.submitted.push('attempt');throw new Error('unknown');};
    await assert.rejects(f.monitor.reply(f.store.data.desktopReplies['800'],'Continue',96),/unknown/);
    await assert.rejects(f.monitor.reply(f.store.data.desktopReplies['800'],'Continue',96),/already|inspect|unknown/);
    assert.equal(f.submitted.length,1);
  }finally{f.cleanup();}
});

test('native waiting state alerts never turn a free-text reply into a permission approval',async()=>{
  const f=fixture();try{
    f.put('approval','a','waiting','inProgress','');
    f.histories.get('approval').thread.status={type:'active',activeFlags:['waitingOnApproval']};
    await f.monitor.scan();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/approval/i);
    await f.monitor.reply(f.store.data.desktopReplies['1'],'Stop that action',99);
    assert.equal(f.submitted[0].id,'approval');assert.match(f.submitted[0].text,/Stop that action/);
    assert.match(f.sent[0].text,/desktop|Codex/i);
  }finally{f.cleanup();}
});

test('a new lifecycle event does not broadcast older completed turns from that conversation',async()=>{
  const f=fixture();try{
    f.put('a','a','old');f.histories.get('a').turns[0].startedAt=1;
    f.monitor.loadEvents=()=>[{id:'new-event',sessionId:'a',turnId:'different-current-turn',receivedAt:new Date(Date.now()+1000).toISOString()}];
    await f.monitor.scan();assert.equal(f.sent.length,0);
  }finally{f.cleanup();}
});

test('a completed turn containing an explicit unanswered async question notifies as input',async()=>{
  const f=fixture();try{
    f.put('a','a','ask','completed','');
    f.histories.get('a').turns[0].items=[{type:'agentMessage',id:'question',text:'Pick one',phase:'commentary',delivery:'async',questions:[{title:'Red or Blue?',options:['Red','Blue']}]}];
    await f.monitor.scan();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/needs your input/);
  }finally{f.cleanup();}
});

test('old completed questions are baselined and successive native approvals in one turn each notify',async()=>{
  const f=fixture();try{
    f.put('old','a','old','completed','');f.histories.get('old').turns[0].startedAt=1;
    f.histories.get('old').turns[0].items=[{type:'agentMessage',id:'old-q',questions:[{title:'Old question'}],delivery:'async'}];
    f.put('active','b','same-turn','inProgress','');
    f.histories.get('active').thread.status={type:'active',activeFlags:['waitingOnApproval']};
    let events=[{id:'approval-1',event:'PermissionRequest',sessionId:'active',turnId:'same-turn',receivedAt:new Date(Date.now()+1000).toISOString()}];
    f.monitor.loadEvents=()=>events;
    await f.monitor.scan();assert.equal(f.sent.length,1);
    await f.monitor.scan();assert.equal(f.sent.length,1);
    events=[...events,{id:'approval-2',event:'PermissionRequest',sessionId:'active',turnId:'same-turn',receivedAt:new Date(Date.now()+2000).toISOString()}];
    await f.monitor.scan();assert.equal(f.sent.length,2);
  }finally{f.cleanup();}
});

test('a newly completed conversational question is an input alert tied to that exact chat',async()=>{
  const f=fixture();try{
    f.put('a','a','question','completed','Which color should I use, red or blue?');
    await f.monitor.scan();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/question|input/i);
    assert.equal(f.store.data.desktopReplies['1'].kind,'input');
  }finally{f.cleanup();}
});

test('historical async questions never suppress a later completion or failure in the same turn',async()=>{
  for(const status of ['completed','failed']){
    const f=fixture();try{
      f.put('a','a','turn','inProgress','');
      const turn=f.histories.get('a').turns[0];
      turn.items=[{type:'agentMessage',id:'old-q',phase:'commentary',delivery:'async',questions:[{title:'Which option?'}]}];
      await f.monitor.scan();assert.equal(f.sent.length,1);
      turn.status=status;turn.completedAt=Date.now()/1000;
      f.histories.get('a').thread.status={type:'idle'};
      if(status==='completed')turn.items.push({type:'agentMessage',id:'final',phase:'final_answer',text:'Finished after the question'});
      await f.monitor.scan();assert.equal(f.sent.length,2);
      assert.match(f.sent[1].text,status==='completed'?/Finished after the question/:/failed/);
    }finally{f.cleanup();}
  }
});

test('an earlier async question cannot hide a later native approval or input form',async()=>{
  for(const flag of ['waitingOnApproval','waitingOnUserInput']){
    const f=fixture();try{
      f.put('a','a','turn','inProgress','');
      f.histories.get('a').turns[0].items=[{type:'agentMessage',id:'earlier-question',phase:'commentary',delivery:'async',questions:[{title:'Previous question?'}]}];
      await f.monitor.scan();assert.equal(f.sent.length,1);
      f.histories.get('a').thread.status={type:'active',activeFlags:[flag]};
      await f.monitor.scan();assert.equal(f.sent.length,2);
      await f.monitor.scan();assert.equal(f.sent.length,2);
    }finally{f.cleanup();}
  }
});

test('desktop-flattened async questions alert while an existing turn keeps working', async () => {
  const f = fixture(); try {
    f.put('sample-app', 'a', 'existing', 'inProgress', 'Continuing local analysis');
    const turn = f.histories.get('sample-app').turns[0];
    turn.startedAt = 1; // Existing conversations and turns predate notification setup.
    turn.items = [
      { type: 'agentMessage', id: 'call_cloudflare', phase: 'final_answer', text: 'Please complete the Cloudflare check in the existing browser. I will continue local analysis meanwhile.' },
      { type: 'agentMessage', id: 'msg_progress', phase: 'commentary', text: 'Local tests are still running.' }
    ];
    await f.monitor.scan();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /needs your input/);
    assert.match(f.sent[0].text, /Cloudflare/);
    assert.equal(f.store.data.desktopReplies['1'].threadId, 'sample-app');
    await f.monitor.scan(); assert.equal(f.sent.length, 1);
    await f.monitor.reply(f.store.data.desktopReplies['1'], 'Done', 902);
    assert.equal(f.submitted[0].id, 'sample-app');
  } finally { f.cleanup(); }
});

test('answered flattened questions and ordinary ongoing final messages do not become input alerts', async () => {
  const f = fixture(); try {
    f.put('a', 'a', 'ongoing', 'inProgress', 'A regular milestone result');
    const turn = f.histories.get('a').turns[0];
    turn.items.unshift({ type: 'agentMessage', id: 'call_answered', phase: 'final_answer', text: 'Please complete the check.' });
    turn.items.push({ type: 'userMessage', id: 'answer', content: [{ type: 'text', text: '<send_user_message_question_reply>\n' +
      JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'call_answered', 0]), question: 'Please complete the check.', answer: 'Done' }]) +
      '\n</send_user_message_question_reply>' }] });
    await f.monitor.scan(); assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test('answering one question cannot hide remaining structured or flattened prompts in the same async call', async () => {
  for (const structured of [false, true]) {
    const f = fixture(); try {
      f.put('a', 'a', 'ongoing', 'inProgress', '');
      const turn = f.histories.get('a').turns[0];
      turn.items = [{ type: 'agentMessage', id: 'call_multi', phase: 'final_answer', text: 'Which branch?\n\nWhich region?',
        ...(structured ? { delivery: 'async', questions: [{ title: 'Which branch?' }, { title: 'Which region?' }] } : {}) },
        { type: 'userMessage', id: 'partial-answer', content: [{ type: 'text', text: '<send_user_message_question_reply>\n' +
          JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'call_multi', 0]), question: 'Which branch?', answer: 'Main' }]) +
          '\n</send_user_message_question_reply>' }] }];
      await f.monitor.scan();
      assert.equal(f.sent.length, 1);
      assert.match(f.sent[0].text, /Which region/);
    } finally { f.cleanup(); }
  }
});

test('private listener validation folders are excluded without hiding real project conversations', async () => {
  const f = fixture(); try {
    f.monitor.excludeRoots = [listenerLocal];
    f.put('test-run', 'a', 'test-turn');
    f.histories.get('test-run').thread.cwd = join(listenerLocal, 'image-smoke-123');
    f.put('real-project', 'b', 'real-turn');
    await f.monitor.scan();
    assert.equal(f.sent.length, 1);
    assert.equal(f.store.data.desktopReplies['1'].threadId, 'real-project');
  } finally { f.cleanup(); }
});
