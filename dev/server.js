/**
 * Local preview of the web app. Serves src/Index.html the way HtmlService
 * would, and replaces google.script.run with calls to the real server code
 * running against an in-memory fake Sheet (see test/helpers/gas.js). TinyURL
 * is faked too: short links look like https://tinyurl.com/fake1 and go nowhere.
 *
 *   npm run dev            → prints the sample event's URL
 *   /static                → the static site (scripts/build-site.js), calling /exec
 *   /static-edge           → the static site reading from /edge first
 *   /exec                  → the Apps Script JSON API (doGet ?api=page, doPost)
 *   /edge                  → the Cloudflare Worker (edge/worker.js) with an
 *                            in-memory KV; the fake Apps Script publishes to it
 *   /__mail                → emails "sent" so far
 *   /__data                → raw contents of every event spreadsheet
 */
const http = require('node:http');
const { loadWithEvent, plain } = require('../test/helpers/gas');
const { buildSite } = require('../scripts/build-site');

const EDGE_SECRET = 'dev-edge-secret-0123456789abcdef0123456789abcdef';
const workerModule = import('../edge/worker.js').then((m) => m.default);

/** Workers KV stand-in: a Map behind KV's async get/put/delete. */
function memoryKv() {
  const data = new Map();
  const metadata = new Map();
  return {
    data,
    metadata,
    get: async (key) => (data.has(key) ? data.get(key) : null),
    getWithMetadata: async (key) => ({ value: data.has(key) ? data.get(key) : null, metadata: metadata.get(key) || null }),
    put: async (key, value, options) => { data.set(key, String(value)); metadata.set(key, (options && options.metadata) || null); },
    delete: async (key) => { data.delete(key); metadata.delete(key); },
  };
}

// Mirrors Apps Script: only these may be called from the browser.
const RPC_ALLOWED = new Set(['cancelSignup', 'getCancellation', 'getOpenEvents', 'getPageData', 'getShortLink', 'submitSignup']);

const MOCK_GOOGLE_SCRIPT = `<script>
  // Local stand-in for google.script.run / google.script.url (dev only).
  window.google = { script: {
    url: { getLocation: function (cb) {
      var parameter = {};
      new URLSearchParams(location.search).forEach(function (v, k) { parameter[k] = v; });
      setTimeout(function () { cb({ parameter: parameter, hash: location.hash.slice(1) }); });
    } },
    run: (function makeRunner(onOk, onErr) {
      return new Proxy({}, { get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return makeRunner(fn, onErr); };
        if (name === 'withFailureHandler') return function (fn) { return makeRunner(onOk, fn); };
        return function () {
          fetch('/__rpc/' + name, { method: 'POST', body: JSON.stringify(Array.from(arguments)) })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (res.error) { if (onErr) onErr(new Error(res.error)); }
              else if (onOk) onOk(res.result);
            })
            .catch(function (e) { if (onErr) onErr(e); });
        };
      } });
    })()
  } };
</script>`;

/** Runs the real doGet (with the fake HtmlService) and swaps in the dev-only google.script stand-in. */
function renderIndex(gas, url) {
  return gas.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) }).getContent()
    .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">' + MOCK_GOOGLE_SCRIPT);
}

function createServer({ latencyMs = 0, edgeCheckRate = 0 } = {}) {
  const gas = loadWithEvent();
  const edgeEnv = { EVENTS: memoryKv(), PUBLISH_SECRET: EDGE_SECRET };
  // UrlFetchApp is synchronous but the Worker isn't: publishes are queued, and
  // /edge reads wait for the queue, so they always see what was published.
  let edgeQueue = Promise.resolve();
  const fakeFetch = gas.ctx.UrlFetchApp.fetch;
  gas.ctx.UrlFetchApp.fetch = (url, options = {}) => {
    if (!gas.props.EDGE_URL || !url.startsWith(gas.props.EDGE_URL)) return fakeFetch(url, options);
    const workerUrl = 'http://localhost' + url.slice(gas.props.EDGE_URL.length); // the Worker's own paths
    const request = new Request(workerUrl, { method: 'POST', headers: options.headers, body: options.payload });
    edgeQueue = edgeQueue.then(() => workerModule).then((worker) => worker.fetch(request, edgeEnv)).then(async (r) => { if (r.status !== 200) console.error("edge publish", r.status, await r.text()); }).catch(console.error);
    return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };

    if (req.method === 'GET' && url.pathname === '/') {
      return send(200, 'text/html; charset=utf-8', renderIndex(gas, url));
    }
    if (req.method === 'GET' && url.pathname === '/static') {
      return send(200, 'text/html; charset=utf-8', buildSite({ apiUrl: '/exec' }));
    }
    if (req.method === 'GET' && url.pathname === '/static-edge') {
      return send(200, 'text/html; charset=utf-8', buildSite({ apiUrl: '/exec', edgeUrl: '/edge', edgeCheckRate }));
    }
    if (url.pathname === '/edge' || url.pathname.startsWith('/edge/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        server.edgeLog.push(req.method + ' ' + url.pathname.slice('/edge'.length));
        await edgeQueue;
        const worker = await workerModule;
        const out = await worker.fetch(new Request('http://localhost' + url.pathname.slice('/edge'.length) + url.search, {
          method: req.method,
          headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
          body: req.method === 'POST' ? body : undefined,
        }), edgeEnv);
        send(out.status, out.headers.get('content-type'), await out.text());
      });
      return;
    }
    if (url.pathname === '/exec' && (req.method === 'GET' || req.method === 'POST')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        server.apiLog.push(req.method + ' ' + (url.searchParams.get('api') || (body && JSON.parse(body).api) || ''));
        const out = req.method === 'GET'
          ? gas.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) })
          : gas.ctx.doPost({ postData: { contents: body, type: req.headers['content-type'] } });
        setTimeout(() => send(200, out.mimeType || 'text/html; charset=utf-8', out.getContent()), latencyMs);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__mail') {
      return send(200, 'application/json', JSON.stringify(gas.sentMail, null, 2));
    }
    if (req.method === 'GET' && url.pathname === '/__data') {
      const tables = Object.fromEntries([gas.eventId, gas.props.TEMPLATE_ID].map((id) => {
        const ss = gas.spreadsheet(id);
        return [ss.name + ' (' + id + ')', Object.fromEntries(ss.getSheets().map((s) => [s.getName(), s.rows]))];
      }));
      return send(200, 'application/json', JSON.stringify(tables, null, 2));
    }
    const rpc = url.pathname.match(/^\/__rpc\/(\w+)$/);
    if (req.method === 'POST' && rpc) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const name = rpc[1];
        server.rpcLog.push(name);
        const reply = (payload) => setTimeout(() => send(200, 'application/json', JSON.stringify(payload)), latencyMs);
        if (!RPC_ALLOWED.has(name)) return reply({ error: 'Script function not found: ' + name });
        try {
          reply({ result: plain(gas.ctx[name](...JSON.parse(body || '[]'))) });
        } catch (err) {
          console.error(err);
          reply({ error: String(err.message || err) });
        }
      });
      return;
    }
    send(404, 'text/plain', 'Not found');
  });

  // Links in the page should point back at this server, not script.google.com.
  server.on('listening', () => {
    const { port } = server.address();
    gas.ctx.ScriptApp = { ...gas.ctx.ScriptApp, getService: () => ({ getUrl: () => 'http://localhost:' + port + '/' }) };
    // Publish to /edge, and run the timer once so it has the events.
    gas.props.EDGE_URL = 'http://localhost:' + port + '/edge';
    gas.props.EDGE_SECRET = EDGE_SECRET;
    gas.runTimer();
  });
  server.gas = gas;
  server.edgeEnv = edgeEnv;
  server.edgeLog = [];
  server.rpcLog = [];
  server.apiLog = [];
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer({ latencyMs: 400 });
  server.listen(port, () => {
    console.log('Sample event:    http://localhost:' + port + '/?event=' + server.gas.eventId);
    console.log('Home page:       http://localhost:' + port + '/');
    console.log('Static site:     http://localhost:' + port + '/static?event=' + server.gas.eventId);
    console.log('  via the edge:  http://localhost:' + port + '/static-edge?event=' + server.gas.eventId);
    console.log('Sent emails:     http://localhost:' + port + '/__mail');
    console.log('Database:        http://localhost:' + port + '/__data');
  });
}
