import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor() { this.children = []; this.parentElement = null; this.attrs = {}; this.style = {}; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  hasAttribute(key) { return key in this.attrs; }
  appendChild(node) { this.children.push(node); node.parentElement = this; }
  insertBefore(node, next) { this.children.splice(this.children.indexOf(next), 0, node); node.parentElement = this; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentElement = null; }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  querySelector() { return this.titleNode; }
}

test('badge matches workspace ID and opens desktop with payload', () => {
  const row = new Element();
  row.setAttribute('data-row-key', 'workspace:one');
  row.titleNode = new Element();
  row.appendChild(row.titleNode);
  const frames = [];
  const requests = [];
  let stream;
  let dispose;
  const document = {
    documentElement: {},
    createElement: () => new Element(),
    querySelectorAll: selector => selector.includes('projectRow') ? [row] : row.children.filter(el => el.hasAttribute('data-dsh-git-badge')),
  };
  class EventSource { constructor() { stream = this; } close() {} }
  class MutationObserver { observe() {} disconnect() {} }
  const context = {
    document, EventSource, MutationObserver, console,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    fetch: (url, options) => { requests.push({ url, options }); return Promise.resolve(); },
    window: { _wails: { invoke() {} }, __ModuleLoader__: { load({ factory }) { context.plugin = factory(() => ({})); } } },
  };
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), context);
  context.plugin.apply({ effect: fn => { dispose = fn(); } });
  stream.onmessage({ data: JSON.stringify({ rows: [{ workspaceId: 'one', title: 'different title', path: 'C:/one', hasGit: true, status: { branch: 'main', hasUpstream: true } }] }) });
  while (frames.length) frames.shift()();
  const chip = row.children.find(el => el.hasAttribute('data-dsh-git-badge'));
  assert.ok(chip);
  chip.onclick({ stopPropagation() {}, preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://wails.localhost/wails/runtime');
  assert.equal(requests[0].options.mode, 'no-cors');
  assert.equal(JSON.parse(requests[0].options.body).args.data.workspaceId, 'one');
  stream.onmessage({ data: JSON.stringify({ rows: [{ workspaceId: 'one', path: 'C:/one', hasGit: false, accessible: true, status: null }] }) });
  while (frames.length) frames.shift()();
  const fileChip = row.children.find(el => el.hasAttribute('data-dsh-git-badge'));
  assert.ok(fileChip);
  assert.notEqual(fileChip, chip);
  assert.match(fileChip.innerHTML, /polyline/);
  assert.doesNotMatch(fileChip.innerHTML, /circle/);
  fileChip.onclick({ stopPropagation() {}, preventDefault() {} });
  assert.equal(JSON.parse(requests[1].options.body).args.name, 'git:open-window');
  assert.equal(JSON.parse(requests[1].options.body).args.data.path, 'C:/one');
  stream.onmessage({ data: JSON.stringify({ rows: [{ workspaceId: 'one', path: 'C:/one', hasGit: false, accessible: false, error: 'denied' }] }) });
  while (frames.length) frames.shift()();
  assert.equal(row.children.some(el => el.hasAttribute('data-dsh-git-badge')), false);
  dispose();
});
