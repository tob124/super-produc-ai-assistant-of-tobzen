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
