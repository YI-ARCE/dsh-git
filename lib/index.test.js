import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply, Config } from './index.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const routes = new Map();
  const events = new Map();
  const disposers = [];
  const workspaces = [{ id: 'one', path: 'C:/work/one', title: 'Same' }];
  let watched = 0;
  const fs = {
    resolve: async path => path,
    stat: async () => null,
    watch: async () => { watched++; return async () => { watched--; }; },
  };
  const ctx = {
    inject() {},
    on: (name, fn) => events.set(name, fn),
    get: key => ({
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
      workspaceRegistry: { list: () => workspaces },
      fs,
    })[key],
    effect: fn => disposers.push(fn()),
  };
  return { routes, events, workspaces, fs, disposers, watched: () => watched, ctx };
}

function subscribe(handler) {
  const response = new EventEmitter();
  response.frames = [];
  response.writeHead = () => {};
  response.write = data => response.frames.push(data);
  response.end = () => response.emit('close');
  handler({}, response);
  return response;
}

function snapshots(response) {
  return response.frames.filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
}

test('plugin declares live settings fields', () => {
  assert.equal(Config.dict.provider.meta.volatile, true);
  assert.equal(Config.dict.model.meta.volatile, true);
});

test('AI route stays mounted when optional services are unavailable', async t => {
  const f = fixture();
  await apply(f.ctx);
  t.after(() => { for (const dispose of f.disposers) dispose(); });
  const handler = f.routes.get('/__git-ai');
  assert.equal(typeof handler, 'function');
  const response = new EventEmitter();
  response.writeHead = status => { response.status = status; };
  response.end = body => { response.body = JSON.parse(body); };
  await handler({ headers: {}, method: 'POST' }, response);
  assert.equal(response.status, 503);
  assert.match(response.body.error, /connection/);
});

test('streams initial workspace and committed workspace changes without open queue', async t => {
  const f = fixture();
  await apply(f.ctx);
  t.after(() => { for (const dispose of f.disposers) dispose(); });
  assert.equal(f.routes.has('/__git-bridge/request-open'), false);
  assert.equal(f.routes.has('/__git-bridge/take-open'), false);
  const response = subscribe(f.routes.get('/__git-bridge/events'));
  t.after(() => response.emit('close'));
  await wait(180);
  assert.deepEqual(snapshots(response).at(-1).rows.map(row => row.workspaceId), ['one']);
  assert.equal(f.watched(), 1);

  f.workspaces.push({ id: 'two', path: 'C:/work/two', title: 'Same' });
  f.events.get('domain/changed')({ domain: 'workspace', table: 'workspaces', operation: 'put' });
  await wait(180);
  assert.deepEqual(snapshots(response).at(-1).rows.map(row => row.workspaceId), ['one', 'two']);
  assert.equal(f.watched(), 2);
  const reconnected = subscribe(f.routes.get('/__git-bridge/events'));
  assert.deepEqual(snapshots(reconnected)[0].rows.map(row => row.workspaceId), ['one', 'two']);
  reconnected.emit('close');

  f.workspaces.splice(0, 1);
  f.events.get('domain/changed')({ domain: 'workspace', table: 'workspaces', operation: 'deleted' });
  await wait(180);
  assert.deepEqual(snapshots(response).at(-1).rows.map(row => row.workspaceId), ['two']);
  assert.equal(f.watched(), 1);
});

function stateRows(f) {
  return new Promise((resolve, reject) => {
    const res = { setHeader() {}, end(body) {
      if (this.statusCode === 500) reject(new Error(String(body)));
      else resolve(JSON.parse(body).rows);
    } };
    f.routes.get('/__git-bridge/state')({}, res);
  });
}

test('verified plain folder and malformed worktree pointer are distinct from failed filesystem probes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'badge-mode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plain = join(dir, 'plain');
  const worktree = join(dir, 'worktree');
  mkdirSync(plain);
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere');
  const f = fixture();
  f.workspaces.splice(0, 1,
    { id: 'plain', path: plain, title: 'Plain' },
    { id: 'worktree', path: worktree, title: 'Worktree' },
    { id: 'missing', path: join(dir, 'missing'), title: 'Missing' });
  f.fs.stat = async path => { try { return statSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  await apply(f.ctx);
  t.after(() => { for (const dispose of f.disposers) dispose(); });
  const rows = await stateRows(f);
  assert.equal(rows.find(row => row.workspaceId === 'plain').accessible, true);
  assert.equal(rows.find(row => row.workspaceId === 'plain').hasGit, false);
  assert.equal(rows.find(row => row.workspaceId === 'worktree').hasGit, false);
  assert.equal(rows.find(row => row.workspaceId === 'worktree').accessible, false);
  assert.ok(rows.find(row => row.workspaceId === 'worktree').error);
  assert.equal(rows.find(row => row.workspaceId === 'missing').accessible, false);
  assert.equal(rows.find(row => row.workspaceId === 'missing').hasGit, false);
  f.fs.stat = async path => { if (path === plain + '/.git') throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); return statSync(path); };
  const failed = await stateRows(f);
  assert.equal(failed.find(row => row.workspaceId === 'plain').accessible, false);
  assert.match(failed.find(row => row.workspaceId === 'plain').error, /permission denied/);
});

test('nested repository and init/remove transitions remain Git-aware', async t => {
  const root = mkdtempSync(join(tmpdir(), 'badge-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, 'nested');
  mkdirSync(nested);
  const f = fixture();
  f.workspaces.splice(0, 1, { id: 'root', path: root, title: 'Root' }, { id: 'nested', path: nested, title: 'Nested' });
  f.fs.stat = async path => { try { return statSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  await apply(f.ctx);
  t.after(() => { for (const dispose of f.disposers) dispose(); });
  assert.equal((await stateRows(f))[0].hasGit, false);
  execFileSync('git', ['init', '-q', root]);
  assert.deepEqual((await stateRows(f)).map(row => row.hasGit), [true, true]);
  rmSync(join(root, '.git'), { recursive: true, force: true });
  assert.deepEqual((await stateRows(f)).map(row => row.hasGit), [false, false]);
});