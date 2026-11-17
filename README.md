# express-cache-toolkit

Small, dependency-light in-memory JSON response caching middleware for Express 4 and 5. It helps avoid repeating work for successful `GET` endpoints while keeping expiration, capacity, cache keys, and invalidation explicit.

## Features

- Configurable entry lifetime and maximum cache size.
- Cache hit, miss, and bypass reporting with the `X-Cache` header.
- Custom key generation and tag based invalidation.
- Least recently used eviction when the cache reaches capacity.
- Only successful JSON `GET` responses are cached.
- Requests with `Authorization` or `Cookie` headers bypass the cache.
- CommonJS and ES module entry points, with no runtime dependencies.

## Requirements

- Node.js 18 or newer.
- Express 4.18 or Express 5.

## Installation

```sh
npm install express-cache-toolkit
```

Express is a peer dependency. Install it in your application if it is not already present.

## Quick start (Express 5, CommonJS)

Save this as `server.cjs` and run it with `node server.cjs`:

```js
const express = require('express');
const { createCache } = require('express-cache-toolkit');

const app = express();
const products = [
  { id: 1, name: 'Keyboard', price: 49.99 },
  { id: 2, name: 'Mouse', price: 19.99 },
];
const cache = createCache({ ttlMs: 60_000, maxEntries: 500 });

app.get(
  '/products',
  cache.middleware({
    keyGenerator: () => 'products',
    tags: ['products'],
  }),
  (_req, res) => res.json(products),
);

app.listen(3000, () => console.log('Listening on http://localhost:3000'));
```

The first request is marked `X-Cache: MISS`; a repeat request within the TTL is marked `X-Cache: HIT`. The middleware also sets `Cache-Control: private, max-age=60` by default for a 60-second TTL.

## ES modules

The package also provides named ESM exports. Save this as `server.mjs` in an application with Express installed:

```js
import express from 'express';
import { createCache } from 'express-cache-toolkit';

const app = express();
const cache = createCache({ ttlMs: 30_000 });

app.get('/status', cache.middleware(), (_req, res) => {
  res.json({ status: 'ready' });
});

app.listen(3000, () => console.log('Listening on http://localhost:3000'));
```

## API

### `createCache(options)`

Creates an isolated in-memory cache instance. Options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `ttlMs` | positive finite number | `60000` | Default time to live for each entry, in milliseconds. |
| `maxEntries` | positive integer | `500` | Maximum number of live entries. The least recently used entry is removed when capacity is reached. |

Invalid options throw a `TypeError` immediately.

### `cache.middleware(options)`

Returns Express middleware for one route. It handles cache lookup and saves eligible JSON responses after the route handler finishes.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `keyGenerator` | `(req) => string` | method, host, URL, `Accept`, and `Accept-Language` | Generates a non-empty key. It can account for query parameters, locales, or other public request data. |
| `tags` | string, string array, or `(req) => string \| string[]` | none | Associates responses with tags for grouped invalidation. |
| `cacheControl` | non-empty string | `private, max-age=<ttl seconds>` | `Cache-Control` value added to eligible responses unless the handler already sets one. |

The middleware uses these rules:

- Only `GET` requests are eligible. Other methods, requests with `Authorization` or `Cookie` headers, authenticated requests with `req.user` or `req.session`, and responses sent with `res.send()`, `res.write()`, or `res.end()` bypass caching.
- Only 2xx JSON responses are saved. Error responses, responses with `Set-Cookie` or `Vary`, `Cache-Control: no-store` or `no-cache`, and values that cannot be JSON serialized are not saved.
- A cache hit replays the original status and JSON body and sets `X-Cache: HIT`.
- Express's serialized JSON is stored, so application JSON replacers and escaping are preserved on cache hits.
- An eligible request with no entry sets `X-Cache: MISS`. A request or response that cannot be cached sets `X-Cache: BYPASS`.
- Exceptions from key or tag generators are passed to Express with `next(error)`.

### Cache instance methods

- `cache.get(key)` returns a live value or `undefined`. Reading a value makes it most recently used.
- `cache.set(key, value, { ttlMs, tags })` stores a value. `ttlMs` and `tags` override defaults for that entry.
- `cache.delete(key)` and `cache.invalidate(key)` remove one key and return whether an entry existed.
- `cache.invalidateTag(tag)` removes all entries carrying that tag and returns the number removed.
- `cache.clear()` removes every entry.
- `cache.keys()` returns live keys; `cache.size` returns the live entry count.

Keys and tags must be non-empty strings. Entry values are stored by reference by `cache.set`; response bodies handled by middleware are copied through JSON serialization before storage.

## TTL and capacity

`ttlMs` is measured from the time an entry is written. Expired entries are removed when accessed and during writes, so the cache does not create background timers. At capacity, the next write evicts the least recently used entry. The `Cache-Control` header uses whole seconds rounded down; the in-process TTL remains the configured millisecond value.

## Invalidation example

Use tags when a mutation changes more than one cached response. This complete route example caches both the collection and individual products under the same tag, then invalidates them after a successful create:

```js
const express = require('express');
const { createCache } = require('express-cache-toolkit');

const app = express();
app.use(express.json());
const products = [{ id: 1, name: 'Keyboard' }];
const cache = createCache({ ttlMs: 60_000 });

app.get('/products', cache.middleware({ keyGenerator: () => 'products', tags: 'products' }), (_req, res) => {
  res.json(products);
});

app.get('/products/:id', cache.middleware({
  keyGenerator: (req) => `product:${req.params.id}`,
  tags: 'products',
}), (req, res) => {
  const product = products.find((item) => item.id === Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Product not found' });
  return res.json(product);
});

app.post('/products', (req, res) => {
  const product = { ...req.body, id: products.length + 1 };
  products.push(product);
  cache.invalidateTag('products');
  return res.status(201).json(product);
});

app.listen(3000, () => console.log('Listening on http://localhost:3000'));
```

For a single entry, call `cache.invalidate('product:1')` or `cache.delete('product:1')` after the underlying data changes.

## Testing

```sh
npm ci
npm test
```

Tests use Node.js's built-in test runner and a local Express 5 server.

## Limitations

- Entries live in one Node.js process. Multiple workers or servers do not share cache contents.
- Restarting the process clears the cache; this is not a persistent or distributed cache.
- Simultaneous misses for the same key are not coalesced, so their route handlers may run concurrently.
- The middleware caches JSON responses only. It does not cache streams, files, redirects, or arbitrary `res.send()` output.
- It replays the status, JSON content type, JSON body, and cache-control value. Route-specific response headers are not retained; responses that declare `Vary` bypass the cache.
- The application is responsible for choosing keys and invalidating entries when data changes. A poorly chosen key can mix distinct responses.

## License

MIT. See [LICENSE](./LICENSE).
