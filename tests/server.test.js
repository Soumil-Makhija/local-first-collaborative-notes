import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../scripts/serve.js';

test('static server exposes app assets, blocks arbitrary files and has no write API', async () => {
  const server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="editor"/u);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
    for (const path of ['/.git/config', '/package.json', '/%2e%2e/README.md', '/unknown']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    assert.equal((await fetch(base, { method: 'POST', body: 'note text' })).status, 405);
    const js = await fetch(base + '/src/crdt.js?cache=test', { method: 'HEAD' });
    assert.equal(js.status, 200);
    assert.equal(await js.text(), '');
    assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
    assert.match(js.headers.get('content-type'), /javascript/u);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
