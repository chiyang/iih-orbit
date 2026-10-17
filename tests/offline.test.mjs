import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto, createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const source = await readFile(new URL('../scripts/offline-worker.js', import.meta.url), 'utf8');
const scope = 'https://example.test/iih-orbit/';
const contents = {'index.html': '<html>release</html>', 'lazy.js': 'export const task = true;'};
const assets = Object.entries(contents).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')]);
function harness(broken = false) {
  const handlers = {}, stores = new Map(), requests = [], claims = [];
  const caches = {
    async open(key) {
      if (!stores.has(key)) stores.set(key, new Map());
      const items = stores.get(key);
      return {put: async (url, response) => items.set(String(url), response), match: async request => items.get(typeof request === 'string' ? request : request.url)};
    },
    keys: async () => [...stores.keys()],
    delete: async key => stores.delete(key)
  };
  vm.runInNewContext(`const VERSION = 'new'; const ASSETS = ${JSON.stringify(assets)};\n${source}`, {
    self: {registration: {scope}, location: new URL(scope), clients: {claim: async () => {claims.push([...stores.keys()]);}}, addEventListener: (name, handler) => {handlers[name] = handler;}},
    caches, crypto: webcrypto, URL, Request,
    fetch: async request => {
      const url = typeof request === 'string' ? request : request.url;
      requests.push(url);
      return new Response(broken && url.endsWith('lazy.js') ? 'wrong release' : contents[url.slice(scope.length)] ?? 'network');
    }
  });
  const dispatch = async (name, extra = {}) => {
    let promise;
    handlers[name]({...extra, waitUntil: value => {promise = value;}, respondWith: value => {promise = value;}});
    return promise;
  };
  return {dispatch, stores, requests, claims};
}

test('offline installation caches the complete release including lazy screens', async () => {
  const h = harness(); await h.dispatch('install');
  assert.equal(h.stores.get('orbit-shell:' + scope + ':new').size, 2);
  const response = await h.dispatch('fetch', {request: {url: scope + '?view=board', method: 'GET', mode: 'navigate'}});
  assert.equal(await response.text(), contents['index.html']);
  const lazy = await h.dispatch('fetch', {request: new Request(scope + 'lazy.js')});
  assert.equal(await lazy.text(), contents['lazy.js']);
  assert.equal(h.requests.length, 2);
});

test('a mixed or incomplete release fails installation and preserves the old cache', async () => {
  const h = harness(true), old = 'orbit-shell:' + scope + ':old';
  h.stores.set(old, new Map());
  await assert.rejects(h.dispatch('install'), /release changed/);
  assert.deepEqual([...h.stores.keys()], [old]);
});

test('activation only clears old application caches within this scope', async () => {
  const h = harness(), current = 'orbit-shell:' + scope + ':new';
  for (const key of [current, 'orbit-shell:' + scope + ':old', 'other-app', 'orbit-shell:https://example.test/another/:old']) h.stores.set(key, new Map());
  await h.dispatch('activate');
  assert.deepEqual([...h.stores.keys()], [current, 'other-app', 'orbit-shell:https://example.test/another/:old']);
  assert.deepEqual(h.claims, [[current, 'other-app', 'orbit-shell:https://example.test/another/:old']]);
});

test('cloud, unknown resources and writes are never intercepted or cached', async () => {
  const h = harness();
  for (const request of [new Request('https://www.googleapis.com/drive/v3/files'), new Request(scope + 'api/tasks'), new Request(scope + 'index.html', {method: 'POST'})]) {
    assert.equal(await h.dispatch('fetch', {request}), undefined);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.stores.size, 0);
});

test('offline builds are repeatable and worker-only updates use a separate cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-offline-build-'));
  try {
    const scripts = join(directory, 'scripts'), release = join(directory, 'release');
    await mkdir(scripts); await mkdir(release);
    await writeFile(join(scripts, 'offline-build.mjs'), await readFile(new URL('../scripts/offline-build.mjs', import.meta.url)));
    await writeFile(join(scripts, 'offline-worker.js'), source);
    await writeFile(join(release, 'index.html'), contents['index.html']);
    await writeFile(join(release, 'lazy.js'), contents['lazy.js']);
    await writeFile(join(release, 'lazy.js.map'), 'source map');
    const {generateOfflineWorker} = await import(pathToFileURL(join(scripts, 'offline-build.mjs')).href);
    const build = async () => {await generateOfflineWorker(release); return readFile(join(release, 'sw.js'), 'utf8');};
    const first = await build();
    assert.equal(await build(), first);
    assert.equal(first.includes('lazy.js.map'), false);
    await writeFile(join(scripts, 'offline-worker.js'), source + '\n// Worker-only update\n');
    const updated = await build();
    assert.notEqual(updated.split('\n')[0], first.split('\n')[0]);
    await writeFile(join(release, 'lazy.js'), 'export const task = false;');
    assert.notEqual((await build()).split('\n')[0], updated.split('\n')[0]);
  } finally {await rm(directory, {recursive: true, force: true});}
});
