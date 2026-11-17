'use strict';

const RESPONSE_ENTRY = Symbol('express-cache-toolkit.response');
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500;

function assertOptionsObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('Cache keys must be non-empty strings');
  }
}

function normalizeTags(tags) {
  if (tags === undefined) return [];
  const values = typeof tags === 'string' ? [tags] : tags;
  if (!Array.isArray(values) || values.some((tag) => typeof tag !== 'string' || tag.length === 0)) {
    throw new TypeError('tags must be a non-empty string or an array of non-empty strings');
  }
  return [...new Set(values)];
}

function cacheControlHasDirective(value, directive) {
  return value.split(',').some((part) => part.trim().split('=', 1)[0].toLowerCase() === directive);
}

function createCache(options = {}) {
  assertOptionsObject(options, 'Cache options');
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  const maxEntries = options.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : options.maxEntries;

  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a finite number greater than 0');
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('maxEntries must be a positive integer');
  }

  const entries = new Map();

  function removeExpired(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  function get(key) {
    assertKey(key);
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value, entryOptions = {}) {
    assertKey(key);
    assertOptionsObject(entryOptions, 'Entry options');
    const entryTtlMs = entryOptions.ttlMs === undefined ? ttlMs : entryOptions.ttlMs;
    if (typeof entryTtlMs !== 'number' || !Number.isFinite(entryTtlMs) || entryTtlMs <= 0) {
      throw new TypeError('Entry ttlMs must be a finite number greater than 0');
    }
    const tags = normalizeTags(entryOptions.tags);
    const now = Date.now();
    removeExpired(now);
    entries.delete(key);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    entries.set(key, { value, expiresAt: now + entryTtlMs, tags });
    return this;
  }

  function deleteKey(key) {
    assertKey(key);
    return entries.delete(key);
  }

  function invalidateTag(tag) {
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new TypeError('Invalidation tags must be non-empty strings');
    }
    let deleted = 0;
    for (const [key, entry] of entries) {
      if (entry.tags.includes(tag)) {
        entries.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  function clear() {
    entries.clear();
  }

  function middleware(middlewareOptions = {}) {
    assertOptionsObject(middlewareOptions, 'Middleware options');
    const keyGenerator = middlewareOptions.keyGenerator === undefined
      ? ((req) => [
        'GET',
        req.get?.('host') || '',
        req.originalUrl || req.url,
        req.get?.('accept') || '',
        req.get?.('accept-language') || '',
      ].join('\u0000'))
      : middlewareOptions.keyGenerator;
    if (typeof keyGenerator !== 'function') {
      throw new TypeError('keyGenerator must be a function');
    }

    const tagSource = middlewareOptions.tags;
    if (typeof tagSource !== 'function') normalizeTags(tagSource);

    const defaultCacheControl = `private, max-age=${Math.floor(ttlMs / 1000)}`;
    const cacheControl = middlewareOptions.cacheControl === undefined
      ? defaultCacheControl
      : middlewareOptions.cacheControl;
    if (typeof cacheControl !== 'string' || cacheControl.length === 0) {
      throw new TypeError('cacheControl must be a non-empty string');
    }

    return function responseCache(req, res, next) {
      if (req.method !== 'GET'
        || req.headers?.authorization
        || req.headers?.cookie
        || req.user
        || req.session) {
        res.setHeader('X-Cache', 'BYPASS');
        return next();
      }

      let key;
      let tags;
      try {
        key = keyGenerator(req);
        assertKey(key);
        tags = normalizeTags(typeof tagSource === 'function' ? tagSource(req) : tagSource);
      } catch (error) {
        return next(error);
      }

      const hit = get(key);
      if (hit && hit[RESPONSE_ENTRY] === true) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Cache-Control', hit.cacheControl);
        res.setHeader('Content-Type', hit.contentType);
        return res.status(hit.statusCode).send(hit.body);
      }

      res.setHeader('X-Cache', 'MISS');
      const originalJson = res.json;
      const originalSend = res.send;
      const originalWrite = res.write;
      const originalEnd = res.end;
      let callingJson = false;
      let sendingResponse = false;
      let jsonResponseEligible = false;

      res.write = function cacheAwareWrite(...args) {
        if (!sendingResponse && !this.headersSent) this.setHeader('X-Cache', 'BYPASS');
        return originalWrite.apply(this, args);
      };

      res.end = function cacheAwareEnd(...args) {
        if (!sendingResponse && !this.headersSent) this.setHeader('X-Cache', 'BYPASS');
        return originalEnd.apply(this, args);
      };

      res.send = function cacheAwareSend(...args) {
        if (!callingJson) {
          if (!this.headersSent) this.setHeader('X-Cache', 'BYPASS');
          sendingResponse = true;
          try {
            return originalSend.apply(this, args);
          } finally {
            sendingResponse = false;
          }
        }

        const payload = args[0];
        const contentType = String(this.getHeader('Content-Type') || '');
        const currentCacheControl = String(this.getHeader('Cache-Control') || '');
        const hasSetCookie = this.getHeader('Set-Cookie') !== undefined;
        const hasVary = this.getHeader('Vary') !== undefined;
        let isJson = false;
        if (typeof payload === 'string' && /^[^/]+\/(?:[^;]+\+)?json(?:\s*;|$)/i.test(contentType)) {
          try {
            JSON.parse(payload);
            isJson = true;
          } catch {
            isJson = false;
          }
        }
        const cacheable = jsonResponseEligible
          && this.statusCode >= 200
          && this.statusCode < 300
          && isJson
          && !hasSetCookie
          && !hasVary
          && !cacheControlHasDirective(currentCacheControl, 'no-store')
          && !cacheControlHasDirective(currentCacheControl, 'no-cache');

        if (!this.headersSent) this.setHeader('X-Cache', cacheable ? 'MISS' : 'BYPASS');
        sendingResponse = true;
        let result;
        try {
          result = originalSend.apply(this, args);
        } finally {
          sendingResponse = false;
        }
        if (cacheable) {
          set(key, {
            [RESPONSE_ENTRY]: true,
            statusCode: this.statusCode,
            body: payload,
            contentType,
            cacheControl: currentCacheControl || cacheControl,
          }, { tags });
        }
        return result;
      };

      res.json = function cacheAwareJson(body) {
        const currentCacheControl = String(this.getHeader('Cache-Control') || '');
        const hasSetCookie = this.getHeader('Set-Cookie') !== undefined;
        jsonResponseEligible = this.statusCode >= 200
          && this.statusCode < 300
          && !hasSetCookie
          && !cacheControlHasDirective(currentCacheControl, 'no-store')
          && !cacheControlHasDirective(currentCacheControl, 'no-cache');
        if (jsonResponseEligible && !currentCacheControl) this.setHeader('Cache-Control', cacheControl);
        callingJson = true;
        try {
          return originalJson.call(this, body);
        } finally {
          callingJson = false;
        }
      };

      return next();
    };
  }

  return {
    get,
    set,
    delete: deleteKey,
    invalidate: deleteKey,
    invalidateTag,
    clear,
    middleware,
    keys() {
      removeExpired();
      return [...entries.keys()];
    },
    get size() {
      removeExpired();
      return entries.size;
    },
  };
}

module.exports = { createCache };
