/**
 * The Cloudflare Worker (edge/worker.js), run in Node with a Map standing in
 * for Workers KV.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const EVENT_ID = '1EkDCyHpBfFpl8SQ1-buQzejKkUGagznHnjjfY30GBKk';
const OTHER_ID = '1fake000000000000000000000000000000000000002';

let worker;
test.before(async () => { worker = (await import('../../edge/worker.js')).default; });

function setup({ secret = SECRET } = {}) {
  const data = new Map();
  const metadata = new Map();
  const reads = [];
  const env = {
    PUBLISH_SECRET: secret,
    EVENTS: {
      get: async (key, options) => { reads.push([key, options && options.cacheTtl]); return data.has(key) ? data.get(key) : null; },
      getWithMetadata: async (key, options) => {
        reads.push([key, options && options.cacheTtl]);
        return { value: data.has(key) ? data.get(key) : null, metadata: metadata.get(key) || null };
      },
      put: async (key, value, options) => { data.set(key, String(value)); metadata.set(key, (options && options.metadata) || null); },
      delete: async (key) => { data.delete(key); metadata.delete(key); },
    },
  };
  const call = async (method, path, { body, auth } = {}) => {
    const headers = auth ? { authorization: auth } : {};
    const res = await worker.fetch(new Request('https://edge.test' + path, {
      method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }), env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  const publish = (body, ...auth) => call('POST', '/publish', { body, auth: auth.length ? auth[0] : 'Bearer ' + SECRET });
  return { data, reads, call, publish };
}

test('a published event can be read back, with CORS for the static site', async () => {
  const edge = setup();
  const view = { eventId: EVENT_ID, title: 'Request an account', slots: [], isOpen: true };
  const r = await edge.publish({ put: { [EVENT_ID]: view }, openEvents: [{ eventId: EVENT_ID, title: 'Request an account' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, put: 1, deleted: 0 });

  const before = Date.now();
  const got = await edge.call('GET', '/events/' + EVENT_ID);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.event, view);
  assert.ok(got.json.publishedAt > before - 5000 && got.json.publishedAt <= Date.now(), 'when it was published');
  assert.equal(got.headers.get('access-control-allow-origin'), '*');
  assert.equal(got.headers.get('cache-control'), 'no-store');
  assert.ok(edge.reads.every(([, ttl]) => ttl === 60), 'reads use the KV edge cache');

  const list = (await edge.call('GET', '/events')).json;
  assert.deepEqual(list.events, [{ eventId: EVENT_ID, title: 'Request an account' }]);
  assert.equal(typeof list.publishedAt, 'number');
  assert.deepEqual((await edge.call('GET', '/events/')).json.events.length, 1, 'trailing slash is fine');
});

test('unknown events, bad ids, and other paths are 404', async () => {
  const edge = setup();
  await edge.publish({});
  assert.equal((await edge.call('GET', '/events/' + OTHER_ID)).status, 404);
  assert.equal((await edge.call('GET', '/events/not-an-id')).status, 404);
  assert.equal((await edge.call('GET', '/events/..%2Fmeta:syncedAt')).status, 404);
  assert.equal((await edge.call('GET', '/')).status, 404);
  assert.equal((await edge.call('PUT', '/events/' + EVENT_ID)).status, 404);
  assert.equal((await edge.call('GET', '/events')).status, 404, 'no open events list published yet');
});

test('a delete removes the event', async () => {
  const edge = setup();
  await edge.publish({ put: { [EVENT_ID]: { title: 'A' }, [OTHER_ID]: { title: 'B' } } });
  const r = await edge.publish({ delete: [EVENT_ID] });
  assert.deepEqual(r.json, { ok: true, put: 0, deleted: 1 });
  assert.equal((await edge.call('GET', '/events/' + EVENT_ID)).status, 404);
  assert.equal((await edge.call('GET', '/events/' + OTHER_ID)).status, 200);
});

test('reads answer 503 if Apps Script has not published for 20 minutes', async () => {
  const edge = setup();
  await edge.publish({ put: { [EVENT_ID]: { title: 'A' } } });
  edge.data.set('meta:syncedAt', String(Date.now() - 21 * 60 * 1000));
  assert.equal((await edge.call('GET', '/events/' + EVENT_ID)).status, 503);
  assert.equal((await edge.call('GET', '/events')).status, 503);
  await edge.publish({}); // the heartbeat
  assert.equal((await edge.call('GET', '/events/' + EVENT_ID)).status, 200);
});

test('nothing is served before the first publish', async () => {
  const edge = setup();
  edge.data.set('event:' + EVENT_ID, '{"title":"A"}');
  assert.equal((await edge.call('GET', '/events/' + EVENT_ID)).status, 503);
});

test('publishing needs the exact secret', async () => {
  const edge = setup();
  const body = { put: { [EVENT_ID]: { title: 'Hacked' } } };
  for (const auth of [undefined, '', 'Bearer', 'Bearer ' + SECRET.slice(0, -1), 'Bearer ' + SECRET + 'x', 'Basic ' + SECRET, SECRET]) {
    assert.equal((await edge.publish(body, auth)).status, 401, String(auth));
  }
  assert.equal(edge.data.size, 0, 'nothing written');
});

test('a missing or short secret refuses every publish', async () => {
  for (const secret of [null, '', 'short']) {
    const edge = setup({ secret });
    assert.equal((await edge.publish({}, 'Bearer ' + (secret || ''))).status, 500);
    assert.equal(edge.data.size, 0);
  }
});

test('malformed publishes are rejected without writing anything', async () => {
  const edge = setup();
  const bad = [
    'not json',
    [],
    { put: [] },
    { put: { 'bad id': {} } },
    { put: { [EVENT_ID]: 'text' } },
    { put: { [EVENT_ID]: null } },
    { delete: EVENT_ID },
    { delete: ['../x'] },
    { openEvents: {} },
    { put: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [EVENT_ID.slice(0, 40) + String(i).padStart(3, '0'), {}])) },
  ];
  for (const body of bad) {
    const r = await edge.publish(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(edge.data.size, 0);
});
