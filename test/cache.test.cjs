'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { test } = require('node:test');
const { createCache } = require('express-cache-toolkit');

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections?.();
    await closed;
  }
}

async function readJson(url, options) {
  const response = await fetch(url, options);
  return {
    status: response.status,
    cache: response.headers.get('x-cache'),
    cacheControl: response.headers.get('cache-control'),
    setCookie: response.headers.get('set-cookie'),
    body: await response.json(),
  };
}

test('a successful GET is a MISS once and then a HIT with cache headers', async () => {
  const app = express();
  const cache = createCache({ ttlMs: 5_000 });
  let handlerCalls = 0;
  app.get('/products', cache.middleware({ keyGenerator: () => 'products', tags: 'products' }), (_req, res) => {
    handlerCalls += 1;
    res.json({ call: handlerCalls });
  });

  await withServer(app, async (baseUrl) => {
    const first = await readJson(`${baseUrl}/products`);
    const second = await readJson(`${baseUrl}/products`);
    assert.equal(first.cache, 'MISS');
    assert.deepEqual(first.body, { call: 1 });
    assert.equal(first.cacheControl, 'private, max-age=5');
    assert.equal(second.cache, 'HIT');
    assert.deepEqual(second.body, { call: 1 });
    assert.equal(handlerCalls, 1);
  });
});

test('custom keys control which requests share an entry', async () => {
  const app = express();
  const cache = createCache();
  let handlerCalls = 0;
  app.get('/products/:id', cache.middleware({
    keyGenerator: (req) => `product:${req.params.id.toLowerCase()}`,
  }), (req, res) => {
    handlerCalls += 1;
    res.json({ requestedId: req.params.id });
  });

  await withServer(app, async (baseUrl) => {
    const first = await readJson(`${baseUrl}/products/A`);
    const second = await readJson(`${baseUrl}/products/a`);
    assert.equal(first.cache, 'MISS');
    assert.equal(second.cache, 'HIT');
    assert.deepEqual(second.body, { requestedId: 'A' });
    assert.equal(handlerCalls, 1);
  });
});

test('cache hits preserve Express JSON replacer output', async () => {
  const app = express();
  app.set('json replacer', (key, value) => key === 'label' ? `${value}!` : value);
  const cache = createCache();
  app.get('/formatted', cache.middleware(), (_req, res) => res.json({ label: 'cached' }));

  await withServer(app, async (baseUrl) => {
    const first = await readJson(`${baseUrl}/formatted`);
    const second = await readJson(`${baseUrl}/formatted`);
    assert.deepEqual(first.body, { label: 'cached!' });
    assert.equal(second.cache, 'HIT');
    assert.deepEqual(second.body, { label: 'cached!' });
  });
});

test('expired entries become misses and are replaced', async () => {
  const app = express();
  const cache = createCache({ ttlMs: 100 });
  let handlerCalls = 0;
  app.get('/short-lived', cache.middleware({ keyGenerator: () => 'short-lived' }), (_req, res) => {
    handlerCalls += 1;
    res.json({ call: handlerCalls });
  });

  await withServer(app, async (baseUrl) => {
    const first = await readJson(`${baseUrl}/short-lived`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await readJson(`${baseUrl}/short-lived`);
    assert.equal(first.cache, 'MISS');
    assert.equal(second.cache, 'MISS');
    assert.deepEqual(second.body, { call: 2 });
  });
});

test('keys and tags invalidate entries explicitly', () => {
  const cache = createCache();
  cache.set('products', [{ id: 1 }], { tags: 'products' });
  cache.set('product:1', { id: 1 }, { tags: ['products', 'product:1'] });
  cache.set('settings', { theme: 'dark' });

  assert.equal(cache.get('products').length, 1);
  assert.equal(cache.invalidateTag('products'), 2);
  assert.deepEqual(cache.keys(), ['settings']);
  assert.equal(cache.invalidate('settings'), true);
  assert.equal(cache.delete('missing'), false);
  assert.equal(cache.size, 0);
});

test('different routes in the same cache do not share default keys', async () => {
  const app = express();
  const cache = createCache();
  let oneCalls = 0;
  let twoCalls = 0;
  app.get('/one', cache.middleware(), (_req, res) => res.json({ calls: ++oneCalls }));
  app.get('/two', cache.middleware(), (_req, res) => res.json({ calls: ++twoCalls }));

  await withServer(app, async (baseUrl) => {
    const one = await readJson(`${baseUrl}/one`);
    const two = await readJson(`${baseUrl}/two`);
    const oneAgain = await readJson(`${baseUrl}/one`);
    const twoAgain = await readJson(`${baseUrl}/two`);
    assert.deepEqual(one.body, { calls: 1 });
    assert.deepEqual(two.body, { calls: 1 });
    assert.equal(oneAgain.cache, 'HIT');
    assert.equal(twoAgain.cache, 'HIT');
    assert.equal(oneCalls, 1);
    assert.equal(twoCalls, 1);
  });
});

test('invalid cache, middleware, and generated-key configuration is rejected', async () => {
  assert.throws(() => createCache(null), /Cache options must be an object/);
  assert.throws(() => createCache({ ttlMs: 0 }), /ttlMs must be/);
  assert.throws(() => createCache({ maxEntries: 1.5 }), /maxEntries must be/);

  const cache = createCache();
  assert.throws(() => cache.middleware({ keyGenerator: 'not a function' }), /keyGenerator must be a function/);
  assert.throws(() => cache.middleware({ keyGenerator: null }), /keyGenerator must be a function/);
  assert.throws(() => cache.middleware({ tags: [''] }), /tags must be/);

  const app = express();
  app.get('/bad-key', cache.middleware({ keyGenerator: () => '' }), (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  await withServer(app, async (baseUrl) => {
    const response = await readJson(`${baseUrl}/bad-key`);
    assert.equal(response.status, 500);
    assert.match(response.body.error, /Cache keys must be non-empty strings/);
  });
});

test('least recently used entries are evicted at maximum capacity', () => {
  const cache = createCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.deepEqual(cache.keys(), ['a', 'c']);
});

test('errors, non-JSON sends, and credentialed requests are not cached', async () => {
  const app = express();
  const cache = createCache();
  let errorCalls = 0;
  let textCalls = 0;
  let privateCalls = 0;
  let notFoundCalls = 0;
  let endedCalls = 0;
  let varyCalls = 0;
  let cookieResponseCalls = 0;
  let authenticatedCalls = 0;
  app.get('/error-then-ok', cache.middleware(), (_req, res) => {
    errorCalls += 1;
    if (errorCalls === 1) return res.status(500).json({ error: 'temporary' });
    return res.json({ call: errorCalls });
  });
  app.get('/text', cache.middleware(), (_req, res) => {
    textCalls += 1;
    res.send('plain text');
  });
  app.get('/private', cache.middleware(), (_req, res) => {
    privateCalls += 1;
    res.json({ call: privateCalls });
  });
  app.get('/not-found', cache.middleware(), (_req, res) => {
    notFoundCalls += 1;
    res.status(404).json({ error: 'missing' });
  });
  app.get('/ended', cache.middleware(), (_req, res) => {
    endedCalls += 1;
    res.end('done');
  });
  app.get('/varied', cache.middleware(), (_req, res) => {
    varyCalls += 1;
    res.vary('Accept-Language').json({ call: varyCalls });
  });
  app.get('/sets-cookie', cache.middleware(), (_req, res) => {
    cookieResponseCalls += 1;
    res.cookie('visitor', String(cookieResponseCalls)).json({ call: cookieResponseCalls });
  });
  app.use('/authenticated', (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  });
  app.get('/authenticated', cache.middleware(), (_req, res) => {
    authenticatedCalls += 1;
    res.json({ call: authenticatedCalls });
  });

  await withServer(app, async (baseUrl) => {
    const failed = await readJson(`${baseUrl}/error-then-ok`);
    const recovered = await readJson(`${baseUrl}/error-then-ok`);
    assert.equal(failed.status, 500);
    assert.equal(failed.cache, 'BYPASS');
    assert.equal(recovered.cache, 'MISS');
    assert.equal(errorCalls, 2);

    const firstText = await fetch(`${baseUrl}/text`);
    const secondText = await fetch(`${baseUrl}/text`);
    assert.equal(firstText.headers.get('x-cache'), 'BYPASS');
    assert.equal(secondText.headers.get('x-cache'), 'BYPASS');
    assert.equal(textCalls, 2);

    const privateOne = await readJson(`${baseUrl}/private`, { headers: { Cookie: 'session=one' } });
    const privateTwo = await readJson(`${baseUrl}/private`, { headers: { Cookie: 'session=one' } });
    assert.equal(privateOne.cache, 'BYPASS');
    assert.equal(privateTwo.cache, 'BYPASS');
    assert.equal(privateCalls, 2);

    const missingOne = await readJson(`${baseUrl}/not-found`);
    const missingTwo = await readJson(`${baseUrl}/not-found`);
    assert.equal(missingOne.status, 404);
    assert.equal(missingOne.cache, 'BYPASS');
    assert.equal(missingTwo.cache, 'BYPASS');
    assert.equal(notFoundCalls, 2);

    const firstEnd = await fetch(`${baseUrl}/ended`);
    const secondEnd = await fetch(`${baseUrl}/ended`);
    assert.equal(firstEnd.headers.get('x-cache'), 'BYPASS');
    assert.equal(secondEnd.headers.get('x-cache'), 'BYPASS');
    assert.equal(endedCalls, 2);

    const variedOne = await readJson(`${baseUrl}/varied`);
    const variedTwo = await readJson(`${baseUrl}/varied`);
    assert.equal(variedOne.cache, 'BYPASS');
    assert.equal(variedTwo.cache, 'BYPASS');
    assert.equal(varyCalls, 2);

    const cookieResponseOne = await readJson(`${baseUrl}/sets-cookie`);
    const cookieResponseTwo = await readJson(`${baseUrl}/sets-cookie`);
    assert.equal(cookieResponseOne.cache, 'BYPASS');
    assert.equal(cookieResponseTwo.cache, 'BYPASS');
    assert.equal(cookieResponseOne.setCookie, 'visitor=1; Path=/');
    assert.equal(cookieResponseTwo.setCookie, 'visitor=2; Path=/');
    assert.equal(cookieResponseCalls, 2);

    const authenticatedOne = await readJson(`${baseUrl}/authenticated`);
    const authenticatedTwo = await readJson(`${baseUrl}/authenticated`);
    assert.equal(authenticatedOne.cache, 'BYPASS');
    assert.equal(authenticatedTwo.cache, 'BYPASS');
    assert.equal(authenticatedCalls, 2);
  });
});

test('the ES module entry point exposes the same public API', async () => {
  const esm = await import('express-cache-toolkit');
  assert.equal(typeof esm.createCache, 'function');
  assert.deepEqual(esm.createCache().keys(), []);
});

test('concurrent misses remain independent and later requests hit the stored response', async () => {
  const app = express();
  const cache = createCache();
  let handlerCalls = 0;
  app.get('/slow', cache.middleware(), async (_req, res) => {
    handlerCalls += 1;
    const call = handlerCalls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    res.json({ call });
  });

  await withServer(app, async (baseUrl) => {
    const [first, second] = await Promise.all([
      readJson(`${baseUrl}/slow`),
      readJson(`${baseUrl}/slow`),
    ]);
    assert.equal(first.cache, 'MISS');
    assert.equal(second.cache, 'MISS');
    assert.equal(handlerCalls, 2);
    const subsequent = await readJson(`${baseUrl}/slow`);
    assert.equal(subsequent.cache, 'HIT');
  });
});
