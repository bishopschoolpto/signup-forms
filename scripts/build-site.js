/**
 * Builds the static site for signups.bishopschoolpto.com: one self-contained
 * index.html made from the same page code Apps Script serves (src/*.html).
 * The only difference is a small stand-in for google.script.run that calls
 * the Apps Script JSON API (doGet ?api=page / ?api=events / doPost) with
 * fetch. The home page (no ?event=) shows without any API call (the org name
 * is built into the page); only then does it fetch the list of open events.
 *
 *   npm run build:site            → site/index.html, API URL (and optional
 *                                   orgName) from site.config.json
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
function apiShim(apiUrl, orgName) {
  return `<script>
  (function () {
    'use strict';
    var API_URL = ${JSON.stringify(apiUrl)};
    var ORG_NAME = ${JSON.stringify(orgName).replace(/</g, '\\u003c')};
    var POST_APIS = { submitSignup: 'signup', getShortLink: 'shortLink', cancelSignup: 'cancel' };

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
          return data;
        });
    }

    // Start loading the event now, while the rest of the page is still parsing.
    var params = new URLSearchParams(location.search);
    var early = params.get('event') ? { arg: params.get('event'), promise: request('getPageData', params.get('event')) } : null;

    function runner(onOk, onErr) {
      return new Proxy({}, {
        get: function (_, name) {
          if (name === 'withSuccessHandler') return function (fn) { return runner(fn, onErr); };
          if (name === 'withFailureHandler') return function (fn) { return runner(onOk, fn); };
          return function (arg) {
            var promise = early && name === 'getPageData' && arg === early.arg ? early.promise : request(name, arg);
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

function buildSite({ apiUrl, orgName = DEFAULT_ORG_NAME, title = orgName + ' Volunteer Sign-Up' }) {
  if (!apiUrl) throw new Error('buildSite: apiUrl is required');
  const apiOrigin = /^https?:\/\//.test(apiUrl) ? new URL(apiUrl).origin : null;
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(read('PawPrint').trim());

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escapeHtml(title) + '</title>',
    '<link rel="icon" type="image/svg+xml" href="' + favicon + '">',
    // Warm up the connections the API call will need (Apps Script redirects to googleusercontent.com).
    apiOrigin ? '<link rel="preconnect" href="' + apiOrigin + '">' : '',
    apiOrigin ? '<link rel="preconnect" href="https://script.googleusercontent.com">' : '',
    apiShim(apiUrl, orgName),
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
  fs.writeFileSync(outFile, buildSite({ apiUrl, orgName: config.orgName }));
  console.log('Built ' + path.relative(ROOT, outFile) + ' (API: ' + apiUrl + ')');
}
