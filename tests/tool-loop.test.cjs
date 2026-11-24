const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function panel(host) {
  const context = vm.createContext({ setTimeout() {}, TextEncoder, AbortController });
  vm.runInContext(script, context);
  context.PluginAPI = host;
  return context;
}

test('task pages preserve complete IDs and omit notes until requested', async () => {
  const tasks = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i), title: 'Example', notes: 'x'.repeat(3000)
  }));
  const ui = panel({ getTasks: async () => tasks });
  const page = await ui.executeTool('get_tasks', { offset: 995 });
  assert.equal(page.next_offset, null);
  assert.equal(page.total, 1000);
  assert.equal(page.items[0].id, '995');
  assert.equal(page.items[0].notes, undefined);
  const detail = await ui.executeTool('get_task', { task_id: '995', notes_offset: 1200 });
  assert.equal(detail.notes.length, 1200);
  assert.equal(detail.next_notes_offset, 2400);
});

test('invalid arguments and duplicate creates do not reach the host', async () => {
  let calls = 0;
  const ui = panel({ addTask: async () => { calls++; return 'new-id'; } });
  const offered = ui.availableTools();
  assert.ok(!offered.some(tool => tool.function.name === 'start_task'));
  const seen = new Set();
  const create = args => ui.runCall({ function: { name: 'create_task', arguments: args } }, offered, seen);
  assert.match((await create('{')).error, /JSON|property|position/i);
  assert.match((await create('{}')).error, /Missing title/);
  assert.equal((await create('{"title":"test"}')).task_id, 'new-id');
  assert.match((await create('{"title":"test"}')).error, /Already executed/);
  assert.equal(calls, 1);
});

test('legacy history excludes app snapshots, reasoning and orphaned tool messages', () => {
  const ui = panel({});
  ui.messages = [
    { role:'user', content:'find a task\n\n---\n[App Context]\nprivate snapshot' },
    { role:'assistant', content:null, tool_calls:[{}], reasoning_content:'old reasoning' },
    { role:'tool', content:'old result' },
    { role:'assistant', content:'Found it' }
  ];
  assert.equal(JSON.stringify(ui.recentHistory()), JSON.stringify([
    { role:'user', content:'find a task' }, { role:'assistant', content:'Found it' }
  ]));
  assert.equal(ui.responseLimit(16384), 4096);
});

function runnerPanel(host, complete) {
  const ui = panel(host);
  Object.assign(ui, { setTimeout, clearTimeout, queueMicrotask, crypto:globalThis.crypto,
    config:{model:'test',maxTokens:2048}, displayActions() {}, callOpenAI:complete });
  vm.runInContext('activeRequest = new AbortController()',ui);
  return ui;
}

function completion(message, used = 50) {
  return {choices:[{finish_reason:message.tool_calls ? 'tool_calls' : 'stop',message:{role:'assistant',...message}}],
    usage:{completion_tokens:used}};
}

function toolCall(name, args, id) {
  return {type:'function',id,function:{name,arguments:JSON.stringify(args)}};
}

test('official runner pairs tool results, preserves provider reasoning, and ends a stalled run', async () => {
  const requests = [];
  const ui = runnerPanel({getTasks:async () => []}, async (dialog, offered) => {
    requests.push(dialog);
    if (!offered.length) return completion({content:'No matching tasks.'});
    return completion({reasoning_content:'provider reasoning',tool_calls:[toolCall('get_tasks',{},'r'+requests.length)]});
  });
  const actions = [];
  const answer = await ui.runToolConversation([{role:'user',content:'Find tasks'}],
    {remaining:8192,status:{},question:'Find tasks',readPagesLeft:12},actions);
  assert.equal(answer,'No matching tasks.');
  assert.equal(requests.length,4);
  for (let n = 1; n <= 3; n++) {
    const pair = requests[n].filter(m => m.role !== 'system').slice(-2);
    assert.equal(pair[0].reasoning_content,'provider reasoning');
    assert.equal(pair[1].tool_call_id,pair[0].tool_calls[0].id);
  }
});

test('productive work may continue beyond five tool rounds', async () => {
  const tasks = Array.from({length:8},(_,i)=>({id:String(i),title:'Task '+i}));
  let n = 0;
  const ui = runnerPanel({getTasks:async () => tasks},async (_,offered) => {
    assert.ok(offered.length);
    if (++n === 8) return completion({content:'Finished.'});
    return completion({tool_calls:[toolCall('get_tasks',{offset:n-1,limit:1},'page'+n)]});
  });
  const actions = [];
  await ui.runToolConversation([],{remaining:8192,status:{},question:'List tasks',readPagesLeft:12},actions);
  assert.equal(actions.length,7);
});

test('a bounded task snapshot traverses descendants once and reports missing children', async () => {
  const tasks = [{id:'root',title:'Root',notes:'target A',subTaskIds:['child','child','missing']},
    {id:'child',title:'Child',notes:'target B',subTaskIds:['root']}];
  const ui = runnerPanel({getTasks:async()=>tasks,getSelectedTask:async()=>tasks[0]},()=>{
    throw Error('Short reads must not need an intermediate model call');
  });
  const result = await ui.taskContents({descendants:true},{});
  assert.equal(result.tasks_found,2);
  assert.match(result.contents,/target A/);
  assert.match(result.contents,/target B/);
  assert.deepEqual([...result.missing_ids],['missing']);
  assert.equal(result.complete,false);
});

test('oversized reading preserves evidence and original question on resume, rejects edited snapshots', async () => {
  const task = {id:'one',title:'Root',notes:'前🙂'.repeat(4500)+'END'};
  const pages = [];
  const ui = runnerPanel({getTasks:async()=>[task]}, async (prompt,tools) => {
    assert.equal(tools.length,0);
    const input = JSON.parse(prompt[1].content);
    pages.push(input);
    return completion({content:'evidence through '+input.page});
  });
  const turn = {remaining:8192,status:{},question:'Find dates',readPagesLeft:1};
  const first = await ui.taskContents({task_id:'one'},turn);
  assert.ok(first.resume);
  assert.equal(first.through_page,1);
  ui.messages = [{role:'assistant',actions:[{resume:first.resume,question:first.question,findings:first.findings}]}];
  const tail = await ui.taskContents(first.resume,{...turn,question:'Continue',readPagesLeft:12});
  assert.equal(tail.complete,true);
  assert.equal(pages[1].question,'Find dates');
  assert.equal(pages[1].earlier_findings,first.findings);
  assert.ok(pages.map(p=>p.task_text).join('').endsWith(task.notes));
  task.notes+=' changed';
  assert.match((await ui.taskContents(first.resume,turn)).error,/Checkpoint/);
});

test('workspace counts use all tasks independently of project paging and respect the host day', async () => {
  const today = '2026-11-24';
  const projects = Array.from({length:24}, (_,i) => ({id:'p'+i,title:'Project '+i}));
  const tasks = Array.from({length:2350}, (_,i) => ({id:String(i),projectId:'p'+(i%24)}));
  Object.assign(tasks[0], {isDone:true,dueDay:'2026-11-23'});
  Object.assign(tasks[1], {parentId:'25',dueDay:today});
  Object.assign(tasks[2], {dueDay:'2026-11-25'});
  Object.assign(tasks[3], {dueWithTime:new Date(2026,10,24,1).getTime()});
  tasks[4].projectId=null;
  const ui = panel({getTasks:async()=>tasks,getAllProjects:async()=>projects,
    getDayContext:async()=>({todayStr:today,startOfNextDayDiffMs:4*3600000})});
  const first = await ui.executeTool('get_workspace_overview',{limit:3});
  const second = await ui.executeTool('get_workspace_overview',{offset:first.projects.next_offset,limit:3});
  assert.deepEqual({...first.totals},{open:2349,done:1,past_planned:1,today:1,future:1,unscheduled:2346});
  assert.equal(first.projects.items[0].id,'p3');
  assert.equal(first.projects.total,25);
  assert.equal(first.projects.items.length,3);
  assert.equal(JSON.stringify(second.totals),JSON.stringify(first.totals));
  assert.ok(!second.projects.items.some(p => first.projects.items.some(q => q.id===p.id)));
});

test('duplicate titles retain project and parent context; a scoped note edit touches only its exact passage', async () => {
  const tasks = [{id:'a',title:'Review',projectId:'p1',notes:'one\ntwo\nthree'},
    {id:'b',title:'Review',projectId:'p2',parentId:'parent',notes:'another note'},
    {id:'parent',title:'Quarterly plan',projectId:'p2'}];
  let writes=0;
  const ui = panel({getTasks:async()=>tasks,getAllProjects:async()=>[{id:'p1',title:'First'},{id:'p2',title:'Second'}],
    getSelectedTask:async()=>tasks[1],
    updateTask:async(id,changes)=>{writes++;Object.assign(tasks.find(t=>t.id===id),changes)}});
  const candidates = await ui.executeTool('get_tasks',{exact_title:'review'});
  assert.equal(candidates.total,2);
  assert.equal(candidates.items[1].projectTitle,'Second');
  assert.equal(candidates.items[1].parentTitle,'Quarterly plan');
  assert.equal((await ui.executeTool('get_tasks',{exact_title:'Review',parent_id:'parent'})).total,1);
  assert.equal((await ui.executeTool('get_task',{})).id,'b');
  const receipt=await ui.executeTool('edit_task_note',{task_id:'a',old_text:'two',new_text:'$& revised'});
  assert.equal(receipt.verified,true);
  assert.equal(tasks[0].notes,'one\n$& revised\nthree');
  assert.equal(tasks[1].notes,'another note');
  assert.match((await ui.executeTool('edit_task_note',{task_id:'a',old_text:'two',new_text:'oops'})).error,/no longer/);
  tasks[0].notes='aaaa';
  assert.match((await ui.executeTool('edit_task_note',{task_id:'a',old_text:'aaa',new_text:'oops'})).error,/more than once/);
  assert.equal(writes,1);
});

test('a host acknowledgment without the requested change is reported and not replayed',async()=>{
  let writes=0;
  const ui=panel({getTasks:async()=>[{id:'a',title:'Old'}],updateTask:async()=>{writes++}});
  const call={function:{name:'update_task',arguments:JSON.stringify({task_id:'a',title:'New'})}};
  const seen=new Set();
  const result=await ui.runCall(call,ui.availableTools(),seen);
  assert.equal(result.host_accepted,true);
  assert.equal(result.verified,false);
  assert.deepEqual([...result.mismatch],['title']);
  assert.match((await ui.runCall(call,ui.availableTools(),seen)).error,/Already executed/);
  assert.equal(writes,1);
});
