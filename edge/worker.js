/**
 * Cloudflare Worker that serves each event's public view from Workers KV, so
 * the static site's first page load doesn't wait for Apps Script. Apps
 * Script publishes here (src/Edge.js); this Worker never calls Google.
 *
 *   GET  /events/<eventId>  → { event, publishedAt }    404 if not published
 *   GET  /events            → { events, publishedAt }   the home page's open events list
 * publishedAt is when that data was last published (ms since 1970).
 *   POST /publish           Authorization: Bearer <PUBLISH_SECRET>
 *        { put: { <eventId>: view }, delete: [eventId], openEvents: [...] }
 *
 * Every publish records the time. If Apps Script hasn't published for
 * STALE_AFTER_MS (its timer sends at least one every 10 minutes), reads
 * answer 503 and the site asks Apps Script instead of showing stale data.
 *
 * Reads use KV's edge cache (READ_CACHE_SECONDS), so a publish can take
 * about a minute to show up everywhere. The site only uses this for a page's
 * first load; sign-ups and refreshes after them go to Apps Script.
 *
 * Bindings (wrangler.toml): EVENTS (KV namespace), PUBLISH_SECRET (secret).
 */

const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{25,100}$/;
const STALE_AFTER_MS = 20 * 60 * 1000;
const READ_CACHE_SECONDS = 60; // KV's minimum
const MAX_PUBLISH_BYTES = 5 * 1024 * 1024;
const MAX_KEYS_PER_PUBLISH = 100;

const SYNCED_AT_KEY = 'meta:syncedAt';
const OPEN_EVENTS_KEY = 'openEvents';
const eventKey = (eventId) => 'event:' + eventId;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  // Public data, read by the static site from another origin.
  'access-control-allow-origin': '*',
};

function json(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    try {
      if (request.method === 'POST' && path === '/publish') return await publish(request, env);
      if (request.method === 'GET' && path === '/events') return await read(env, OPEN_EVENTS_KEY, 'events');
      const match = /^\/events\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && match) {
        const eventId = decodeURIComponent(match[1]);
        if (!EVENT_ID_PATTERN.test(eventId)) return json(404, { error: 'NOT_FOUND' });
        return await read(env, eventKey(eventId), 'event');
      }
      return json(404, { error: 'NOT_FOUND' });
    } catch (err) {
      console.error(err && err.stack || err);
      return json(500, { error: 'SERVER_ERROR' });
    }
  },
};

/** Answers { [field]: <stored JSON> }, or 404 / 503 (stale). */
async function read(env, key, field) {
  const [syncedAt, stored] = await Promise.all([
    env.EVENTS.get(SYNCED_AT_KEY, { cacheTtl: READ_CACHE_SECONDS }),
    env.EVENTS.getWithMetadata(key, { cacheTtl: READ_CACHE_SECONDS }),
  ]);
  if (!syncedAt || Date.now() - Number(syncedAt) > STALE_AFTER_MS) return json(503, { error: 'STALE' });
  if (stored.value == null) return json(404, { error: 'NOT_FOUND' });
  const publishedAt = Number(stored.metadata && stored.metadata.publishedAt) || 0;
  // Stored as JSON text; wrap it without parsing.
  return json(200, '{"' + field + '":' + stored.value + ',"publishedAt":' + publishedAt + '}');
}

async function publish(request, env) {
  const secret = String(env.PUBLISH_SECRET || '');
  if (secret.length < 32) return json(500, { error: 'NOT_CONFIGURED' });
  const auth = request.headers.get('authorization') || '';
  if (!sameText(auth, 'Bearer ' + secret)) return json(401, { error: 'UNAUTHORIZED' });

  const text = await request.text();
  if (text.length > MAX_PUBLISH_BYTES) return json(413, { error: 'TOO_LARGE' });
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return json(400, { error: 'INVALID', message: 'Body must be JSON.' });
  }
  const problem = checkPublish(body);
  if (problem) return json(400, { error: 'INVALID', message: problem });

  const put = body.put || {};
  const removed = body.delete || [];
  const options = { metadata: { publishedAt: Date.now() } };
  const writes = Object.keys(put).map((id) => env.EVENTS.put(eventKey(id), JSON.stringify(put[id]), options));
  removed.forEach((id) => writes.push(env.EVENTS.delete(eventKey(id))));
  if (body.openEvents) writes.push(env.EVENTS.put(OPEN_EVENTS_KEY, JSON.stringify(body.openEvents), options));
  await Promise.all(writes);
  // Last, so the data is in place before it counts as current.
  await env.EVENTS.put(SYNCED_AT_KEY, String(Date.now()));
  return json(200, { ok: true, put: Object.keys(put).length, deleted: removed.length });
}

/** Returns what's wrong with a publish body, or '' if it's fine. */
function checkPublish(body) {
  if (!isObject(body)) return 'Body must be an object.';
  const put = body.put === undefined ? {} : body.put;
  if (!isObject(put)) return '"put" must be an object.';
  const removed = body.delete === undefined ? [] : body.delete;
  if (!Array.isArray(removed)) return '"delete" must be a list.';
  const ids = Object.keys(put).concat(removed);
  if (ids.length > MAX_KEYS_PER_PUBLISH) return 'At most ' + MAX_KEYS_PER_PUBLISH + ' events per publish.';
  if (!ids.every((id) => typeof id === 'string' && EVENT_ID_PATTERN.test(id))) return 'Invalid event id.';
  if (!Object.values(put).every(isObject)) return 'Each event must be an object.';
  if (body.openEvents !== undefined && !Array.isArray(body.openEvents)) return '"openEvents" must be a list.';
  return '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Compares in time that doesn't depend on where the texts differ. */
function sameText(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < y.length; i++) diff |= (x[i] || 0) ^ y[i];
  return diff === 0;
}
