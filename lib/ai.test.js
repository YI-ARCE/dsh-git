import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runGeneration, NS } from './ai-core.js';
import { apply } from './ai.js';
function fixture() {
 const state = { provider: 'small-provider', model: 'small-model' }; let captured;
 const ctx = {
  settings: { describe: () => [{ ns: NS, revision: 1, value: state }] },
  workspaceRegistry: { resolveByPath: async () => ({ sessionIds: ['mine'] }) },
  sessionQuery: { readSurface: async () => ({ events: [] }) },
  llm: { listProviders: () => [{ id: 'small-provider' }], prepareCall: async config => ({ config, stream: async function* (request) { captured = request; yield { type: 'text-delta', text: '修复提交信息生成' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) }
 };
 return { ctx, state, captured: () => captured };
}
const data = { path: 'C:/repo', summary: '+ actual changes', expected: { provider: 'small-provider', model: 'small-model', revision: 1 } };
test('dedicated model only, no tools, untrusted data separate', async () => {
 const f = fixture(); const result = await runGeneration(f.ctx, data, new AbortController().signal);
 assert.equal(result.message, '修复提交信息生成'); assert.equal(f.captured().model, 'small-model'); assert.deepEqual(f.captured().tools, []);
 assert.match(f.captured().messages[0].content[0].text, /actualSelectedChanges/);
});
test('unconfigured or removed model never falls back', async () => {
 const f=fixture(); f.state.model=''; await assert.rejects(runGeneration(f.ctx,{...data,expected:{...data.expected,model:''}},new AbortController().signal), /先选择/);
 f.state.model='small-model'; f.ctx.llm.listProviders=()=>[]; await assert.rejects(runGeneration(f.ctx,data,new AbortController().signal), /不可用/);
});
test('workspace and session ownership are required', async () => {
 const f=fixture(); await assert.rejects(runGeneration(f.ctx,{...data,sessionId:'foreign'},new AbortController().signal), /不属于/);
 f.ctx.workspaceRegistry.resolveByPath=async()=>undefined; await assert.rejects(runGeneration(f.ctx,data,new AbortController().signal), /未登记/);
});
test('reasoning and tool content excluded from optional context', async () => {
 const f=fixture(); f.ctx.sessionQuery.readSurface=async()=>({events:[{type:'user/message',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'fix it'},{type:'reasoning',text:'SECRET'}]}}]});
 await runGeneration(f.ctx,{...data,sessionId:'mine'},new AbortController().signal);
 assert.match(f.captured().messages[0].content[0].text,/fix it/); assert.doesNotMatch(f.captured().messages[0].content[0].text,/SECRET/);
});
test('incomplete model output never accepted', async () => {
 const f=fixture(); f.ctx.llm.prepareCall=async config=>({config,stream:async function*(){yield {type:'text-delta',text:'partial'};yield {type:'finish',reason:{kind:'max-tokens'}};}});
 await assert.rejects(runGeneration(f.ctx,data,new AbortController().signal),/截断/);
});
test('concurrent settings change refuses rather than billing another model', async () => {
 const f=fixture(); f.state.model='expensive'; await assert.rejects(runGeneration(f.ctx,data,new AbortController().signal), /设置已变化/);
});
test('small model gets bounded input with explicit warning', async () => {
 const f=fixture(); let request;
 f.ctx.llm.prepareCall=async config=>({config,context:{contextWindow:4096},stream:async function*(r){request=r;yield {type:'text-delta',text:'摘要'};yield {type:'finish',reason:{kind:'stop'}};}});
 const result=await runGeneration(f.ctx,{...data,summary:'测试变更'.repeat(8000)},new AbortController().signal);
 assert.ok(Buffer.byteLength(request.messages[0].content[0].text)<1800); assert.match(result.warnings.join(''),/裁剪/);
});
test('options expose global providers even for unregistered Git directories', async () => {
  const f = fixture();
  f.ctx.workspaceRegistry.resolveByPath = async () => undefined;
  let handler;
  apply({ ...f.ctx, effect() {},
    webServer: { register(route) { handler = route.handler; } },
    connection: { requestRejection: () => undefined } });
  const req = { headers: { 'content-type': 'application/json' }, method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ action: 'options', path: 'C:/repo' })); } };
  const res = new EventEmitter();
  res.destroyed = false;
  res.writeHead = status => { res.status = status; };
  res.end = body => { res.body = JSON.parse(body); };
  await handler(req, res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.providers.map(p => p.id), ['small-provider']);
  assert.deepEqual(res.body.sessions, []);
  await assert.rejects(runGeneration(f.ctx, data, new AbortController().signal), /未登记/);
});

test('save updates the profile entry with revision checking', async () => {
  const state = { provider: '', model: '' };
  let revision = 2, handler;
  apply({ effect() {}, settings: {
    describe: () => [{ ns: NS, revision, value: state }],
    async update(ns, patch, expected) {
      assert.equal(ns, 'ui-git-badge');
      assert.equal(expected, revision);
      Object.assign(state, patch);
      revision++;
    },
  }, llm: { listProviders: () => [{ id: 'small-provider' }], resolveModelInfo: async () => ({}) },
  workspaceRegistry: {}, connection: { requestRejection: () => undefined },
  webServer: { register(route) { handler = route.handler; } } });
  const req = { headers: { 'content-type': 'application/json' }, method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ action: 'save', provider: 'small-provider', model: 'small-model', revision: 2 })); } };
  const res = new EventEmitter();
  res.writeHead = status => { res.status = status; };
  res.end = body => { res.body = JSON.parse(body); };
  await handler(req, res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { provider: 'small-provider', model: 'small-model', revision: 3 });
});

test('AI bridge does not require optional conversation service to activate', () => {
  let registered = false;
  apply({ effect() {}, webServer: { register() { registered = true; } } });
  assert.equal(registered, true);
});

test('HTTP authentication checked before body or business work', async () => {
 let handler; apply({effect(){},webServer:{register(route){handler=route.handler;}},connection:{requestRejection:()=>401}});
 let status,body; await handler({headers:{},method:'POST'}, {writeHead(s){status=s},end(b){body=b}});
 assert.equal(status,401); assert.match(body,/认证/);
});
