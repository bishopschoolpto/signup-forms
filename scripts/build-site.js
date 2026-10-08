/**
 * Builds the static site for signups.bishopschoolpto.com: one self-contained
 * index.html made from the same page code Apps Script serves (src/*.html).
 * The only difference is a small stand-in for google.script.run that calls
 * the Apps Script JSON API (doGet ?api=page / ?api=events / doPost) with
 * fetch. The home page (no ?event=) shows without any API call (the org name
 * is built into the page); only then does it fetch the list of open events.
 *
 * With an edgeUrl (the Cloudflare Worker in edge/), an event page's first
 * load and the open events list come from the edge, and from Apps Script
 * only if the edge fails, is slow, or doesn't have it. Everything else, and
 * every later refresh, asks Apps Script, which is always current. After a
 * sign-up or cancellation, the event skips the edge for a few minutes while
 * the change reaches it.
 *
 * Edge check: on a sample of loads served by the edge (edgeCheckRate, default
 * 5%), the page also asks Apps Script in the background, after rendering.
 * If the two differ it logs the differences to the console and reports them
 * to Apps Script, which logs an "edge mismatch" line (src/Edge.js). Add
 * ?compare=1 to a page's address to check every load and see the result in
 * the console (nothing is reported).
 *
 *   npm run build:site            → site/index.html, API URL (and optional
 *                                   edgeUrl and orgName) from site.config.json
 *   node scripts/build-site.js <apiUrl> [outFile]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const read = (name) => fs.readFileSync(path.join(SRC_DIR, name + '.html'), 'utf8');
// Same default as DEFAULT_ORG_NAME in src/Config.js (the ORG_NAME script property).
const DEFAULT_ORG_NAME = 'Bishop School PTO';
const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Browser-side stand-in for google.script.run / google.script.url. */
function apiShim(apiUrl, orgName, edgeUrl, edgeCheckRate) {
  return `<script>
  (function () {
    'use strict';
    var API_URL = ${JSON.stringify(apiUrl)};
    var EDGE_URL = ${JSON.stringify(String(edgeUrl || '').replace(/\/+$/, ''))};
    var EDGE_TIMEOUT_MS = 3000;
    var EDGE_SKIP_MS = 3 * 60 * 1000; // after a sign-up or cancellation
    var EDGE_CHECK_RATE = ${JSON.stringify(Number(edgeCheckRate) || 0)};
    var COMPARE = new URLSearchParams(location.search).get('compare') === '1';
    var ORG_NAME = ${JSON.stringify(orgName).replace(/</g, '\\u003c')};
    var POST_APIS = { submitSignup: 'signup', getShortLink: 'shortLink', cancelSignup: 'cancel', reportEdgeMismatch: 'edgeMismatch' };

    function edgeSkipKey(eventId) { return 'edgeSkip:' + eventId; }

    /** True if this browser changed the event recently, so the edge may not have caught up. */
    function changedRecently(eventId) {
      try { return Number(localStorage.getItem(edgeSkipKey(eventId)) || 0) > Date.now(); } catch (e) { return false; }
    }

    function rememberChange(eventId) {
      try { localStorage.setItem(edgeSkipKey(eventId), String(Date.now() + EDGE_SKIP_MS)); } catch (e) {}
    }

    /** GETs JSON from the edge; rejects on any error, a non-200 answer, or a slow reply. */
    function fromEdge(path) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = controller && setTimeout(function () { controller.abort(); }, EDGE_TIMEOUT_MS);
      return fetch(EDGE_URL + path, { cache: 'no-store', signal: controller && controller.signal })
        .then(function (res) {
          if (!res.ok) throw new Error('Edge HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) { clearTimeout(timer); return data; },
          function (err) { clearTimeout(timer); throw err; });
    }

    /** The edge's copy, falling back to Apps Script; or straight to Apps Script without an edge. */
    function viaEdge(name, arg) {
      var eventId = name === 'getPageData' ? String(arg) : '';
      if (!EDGE_URL || (eventId && changedRecently(eventId) && !COMPARE)) return request(name, arg);
      var edgeCall = eventId
        ? fromEdge('/events/' + encodeURIComponent(eventId)).then(function (data) {
          if (!data || !data.event) throw new Error('Edge: no event');
          return { data: data, page: { orgName: ORG_NAME, baseUrl: location.origin + location.pathname, event: data.event } };
        })
        : fromEdge('/events').then(function (data) {
          if (!data || !Array.isArray(data.events)) throw new Error('Edge: no events');
          return { data: data, page: { events: data.events } };
        });
      return edgeCall.then(function (got) {
        if (COMPARE || Math.random() < EDGE_CHECK_RATE) {
          // After the page has rendered from the edge's copy.
          setTimeout(function () { checkEdge(name, arg, eventId, got.data); }, 0);
        }
        return got.page;
      }, function (err) {
        if (COMPARE) console.info('[edge check] edge unavailable (' + err.message + '); loading from Apps Script');
        return request(name, arg);
      });
    }

    /** Asks Apps Script for the same data, and logs (and, unless ?compare=1, reports) any difference. */
    function checkEdge(name, arg, eventId, edgeData) {
      var what = eventId ? 'event ' + eventId : 'open events list';
      var age = Math.round((Date.now() - (edgeData.publishedAt || 0)) / 1000);
      request(name, arg).then(function (fresh) {
        var diffs = diffJson(eventId ? edgeData.event : edgeData.events, fresh && (eventId ? fresh.event : fresh.events), '', []);
        if (!diffs.length) {
          if (COMPARE) console.info('[edge check] ' + what + ' matches Apps Script (edge copy published ' + age + 's ago)');
          return;
        }
        console.warn('[edge check] ' + what + ' differs from Apps Script (edge copy published ' + age + 's ago):\\n  ' + diffs.join('\\n  '));
        if (!COMPARE) {
          request('reportEdgeMismatch', { eventId: eventId, publishedAt: edgeData.publishedAt || 0, diffs: diffs })
            .catch(function () {});
        }
      }, function (err) {
        if (COMPARE) console.warn('[edge check] could not ask Apps Script: ' + err.message);
      });
    }

    /** Differences between two JSON values, as "path: edge X, apps script Y" (at most 20). */
    function diffJson(a, b, path, out) {
      if (out.length >= 20) return out;
      var objects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
      if (objects) {
        var keys = Object.keys(a).concat(Object.keys(b).filter(function (k) { return !(k in a); }));
        keys.forEach(function (k) {
          diffJson(a[k], b[k], Array.isArray(a) ? path + '[' + k + ']' : (path ? path + '.' : '') + k, out);
        });
      } else if (JSON.stringify(a) !== JSON.stringify(b)) {
        out.push((path || '(all)') + ': edge ' + shortJson(a) + ', apps script ' + shortJson(b));
      }
      return out;
    }

    function shortJson(value) {
      var text = value === undefined ? '(missing)' : JSON.stringify(value);
      return text.length > 60 ? text.slice(0, 57) + '...' : text;
    }

    /** Calls the Apps Script JSON API; resolves with its data or rejects. */
    function request(name, arg) {
      var call;
      if (name === 'getPageData' && !arg) {
        // The home page: the server would only add the org name, which is built in.
        return Promise.resolve({ orgName: ORG_NAME, baseUrl: location.origin + location.pathname, event: null });
      }
      if (name === 'getPageData') {
        call = fetch(API_URL + '?api=page&event=' + encodeURIComponent(arg || ''), { cache: 'no-store' });
      } else if (name === 'getOpenEvents') {
        call = fetch(API_URL + '?api=events', { cache: 'no-store' });
      } else if (name === 'getCancellation') {
        call = fetch(API_URL + '?api=cancellation&event=' + encodeURIComponent(arg.eventId || '') +
          '&cancel=' + encodeURIComponent(arg.token || ''), { cache: 'no-store' });
      } else if (POST_APIS[name]) {
        // text/plain keeps this a "simple" cross-origin request (no CORS preflight).
        call = fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ api: POST_APIS[name], input: arg }),
        });
      } else {
        return Promise.reject(new Error('Unknown server function: ' + name));
      }
      return call
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (data && data.serverError) throw new Error('Server error');
          // Sign-up links built on this page should point at this site.
          if (name === 'getPageData' && data) data.baseUrl = location.origin + location.pathname;
          if ((name === 'submitSignup' || name === 'cancelSignup') && data && data.ok && arg && arg.eventId) {
            rememberChange(String(arg.eventId));
          }
          return data;
        });
    }

    // Start loading the event now, while the rest of the page is still parsing.
    // Only this first load of the event may come from the edge.
    var params = new URLSearchParams(location.search);
    var early = params.get('event') ? { arg: params.get('event'), promise: viaEdge('getPageData', params.get('event')) } : null;

    function runner(onOk, onErr) {
      return new Proxy({}, {
        get: function (_, name) {
          if (name === 'withSuccessHandler') return function (fn) { return runner(fn, onErr); };
          if (name === 'withFailureHandler') return function (fn) { return runner(onOk, fn); };
          return function (arg) {
            var promise = early && name === 'getPageData' && arg === early.arg ? early.promise
              : name === 'getOpenEvents' ? viaEdge(name, arg)
              : request(name, arg);
            early = null;
            promise.then(
              function (data) { if (onOk) onOk(data); },
              function (err) { if (onErr) onErr(err); });
          };
        },
      });
    }

    var parameter = {};
    params.forEach(function (v, k) { parameter[k] = v; });
    window.google = {
      script: {
        run: runner(null, null),
        url: { getLocation: function (cb) { cb({ parameter: parameter, hash: location.hash.slice(1) }); } },
      },
    };
  })();
</script>`;
}

function buildSite({ apiUrl, edgeUrl = '', edgeCheckRate = 0.05, orgName = DEFAULT_ORG_NAME, title = orgName + ' Volunteer Sign-Up' }) {
  if (!apiUrl) throw new Error('buildSite: apiUrl is required');
  const apiOrigin = /^https?:\/\//.test(apiUrl) ? new URL(apiUrl).origin : null;
  const edgeOrigin = /^https?:\/\//.test(edgeUrl) ? new URL(edgeUrl).origin : null;
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(read('PawPrint').trim());

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escapeHtml(title) + '</title>',
    '<link rel="icon" type="image/svg+xml" href="' + favicon + '">',
    // Warm up the connections the API call will need (Apps Script redirects to googleusercontent.com).
    edgeOrigin ? '<link rel="preconnect" href="' + edgeOrigin + '">' : '',
    apiOrigin ? '<link rel="preconnect" href="' + apiOrigin + '">' : '',
    apiOrigin ? '<link rel="preconnect" href="https://script.googleusercontent.com">' : '',
    apiShim(apiUrl, orgName, edgeUrl, edgeCheckRate),
  ].filter(Boolean).join('\n    ');

  const html = read('Index')
    .replace(/<\?!=\s*include\('(\w+)'\)\s*\?>/g, (_, name) => read(name))
    .replace(/<\?!=\s*initialJson\s*\?>/, 'null')
    .replace('<meta charset="utf-8">', head);

  if (html.includes('<?')) throw new Error('buildSite: unprocessed Apps Script scriptlet left in the page');
  return html;
}

module.exports = { buildSite };

if (require.main === module) {
  const config = fs.existsSync(path.join(ROOT, 'site.config.json'))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'))
    : {};
  const apiUrl = process.argv[2] || config.apiUrl;
  const outFile = process.argv[3] || path.join(ROOT, 'site', 'index.html');
  if (!apiUrl) {
    console.error('Usage: node scripts/build-site.js <apiUrl> [outFile]   (or set apiUrl in site.config.json)');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buildSite({ apiUrl, edgeUrl: config.edgeUrl, edgeCheckRate: config.edgeCheckRate, orgName: config.orgName }));
  console.log('Built ' + path.relative(ROOT, outFile) + ' (API: ' + apiUrl + (config.edgeUrl ? ', edge: ' + config.edgeUrl : '') + ')');
}
