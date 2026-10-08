/**
 * Drives the static site (scripts/build-site.js) in headless Chromium. The dev
 * server serves it at /static and emulates the Apps Script JSON API at /exec
 * using the real server code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('../../dev/server');
const { buildSite } = require('../../scripts/build-site');

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function open(pathname, viewport, serverOptions) {
  const server = createServer(serverOptions);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = 'http://localhost:' + server.address().port;
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  const errors = [];
  const consoleLines = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => consoleLines.push(m.type() + ': ' + m.text()));
  await page.goto(base + pathname.replace('EVENT', server.gas.eventId));
  return {
    page, base, server, gas: server.gas, errors, consoleLines,
    close: async () => { await page.close(); server.close(); },
  };
}

test('the built page is self-contained and has no Apps Script leftovers', () => {
  const html = buildSite({ apiUrl: 'https://script.google.com/macros/s/ABC/exec' });
  assert.ok(!html.includes('<?'), 'no scriptlets');
  assert.ok(!/<(script|link)[^>]+(src|href)="(?!https:\/\/script\.google|https:\/\/script\.googleusercontent|data:)/.test(html), 'no external files to host');
  assert.ok(html.includes('<link rel="preconnect" href="https://script.google.com">'));
  assert.ok(html.includes('rel="icon"'), 'paw print favicon');
  assert.match(html, /<script type="application\/json" id="initial-data">null<\/script>/);
  assert.throws(() => buildSite({}), /apiUrl is required/);
});

test('the org name is built in, safely, and sets the title', async () => {
  const html = buildSite({ apiUrl: '/exec', orgName: 'Lincoln </script><b>PTO' });
  assert.ok(html.includes('<title>Lincoln &lt;/script&gt;&lt;b&gt;PTO Volunteer Sign-Up</title>'));
  assert.ok(!html.includes('Lincoln </script>'), 'cannot end the script element');
  const page = await browser.newPage();
  try {
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://localhost/');
    await page.waitForSelector('#home-view:not([hidden])');
    assert.equal(await page.textContent('#org-name'), 'Lincoln </script><b>PTO');
  } finally { await page.close(); }
});

test('an event page loads with a single API call and no Apps Script page', async () => {
  const t = await open('/static?event=EVENT');
  try {
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.equal(await t.page.textContent('#event-title'), 'Fall Book Fair (sample)');
    assert.equal(await t.page.locator('.slot').count(), 3);
    assert.ok(await t.page.locator('.site-header .logo svg').isVisible());
    assert.deepEqual(t.server.apiLog, ['GET page'], 'the early fetch is reused, not repeated');
    assert.deepEqual(t.server.rpcLog, []);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('a parent can sign up on the static site', async () => {
  const t = await open('/static?event=EVENT');
  try {
    t.gas.event.setEventField('organizerEmail', 'organizer@example.com');
    t.gas.cache.clear();
    await t.page.reload();
    await t.page.click('#slot-checkout button');
    await t.page.fill('#f-name', 'Jane Doe');
    await t.page.fill('#f-email', 'jane@example.com');
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#done-view:not([hidden])');
    assert.equal(await t.page.textContent('#done-slot'), 'Checkout table');
    assert.ok(await t.page.isVisible('#done-organizer'));
    assert.equal(t.gas.ctx.readTable_(t.gas.event, 'Signups').length, 1);
    assert.equal(t.gas.sentMail.length, 2, 'volunteer + organizer');
    assert.ok(t.server.apiLog.includes('POST signup'));

    await t.page.click('#another-btn');
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.match(await t.page.textContent('#slot-checkout .slot-names'), /Jane D\./);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('validation errors and a slot filling up behave the same as on Apps Script', async () => {
  const t = await open('/static?event=EVENT');
  try {
    await t.page.click('#slot-cleanup button');
    await t.page.fill('#f-name', '');
    await t.page.fill('#f-email', 'bad');
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#err-name:not(:empty)');

    t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId: 'cleanup', name: 'Quick Parent', email: 'quick@example.com' });
    await t.page.fill('#f-name', 'Late Parent');
    await t.page.fill('#f-email', 'late@example.com');
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#page-status:not([hidden])');
    assert.match(await t.page.textContent('#page-status'), /just filled up/);
    assert.equal(await t.page.locator('#slot-cleanup button').count(), 0);
  } finally { await t.close(); }
});

test('the link tool builds links to the static site, not to Apps Script', async () => {
  const t = await open('/static');
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    assert.equal(await t.page.textContent('#org-name'), 'Bishop School PTO');
    await t.page.waitForSelector('#open-events-list:not([hidden])');
    assert.deepEqual(t.server.apiLog, ['GET events'], 'one call, for the list of open events');
    assert.equal(await t.page.getAttribute('.event-link', 'href'), t.base + '/static?event=' + t.gas.eventId, 'links stay on the static site');
    await t.page.fill('#f-sheet', 'https://docs.google.com/spreadsheets/d/' + t.gas.eventId + '/edit');
    await t.page.click('#link-btn');
    await t.page.waitForSelector('#link-result:not([hidden])');
    assert.equal(await t.page.inputValue('#link-output'), t.base + '/static?event=' + t.gas.eventId);
  } finally { await t.close(); }
});

test('the home page shows before the event list arrives, and copes if it fails', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const page = await browser.newPage();
  try {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/exec?api=events', async (route) => { await held; await route.abort(); });
    await page.goto('http://localhost:' + server.address().port + '/static');
    await page.waitForSelector('#home-view:not([hidden])');
    assert.ok(await page.isVisible('#open-events-loading .spinner'), 'loading indicator while the list loads');
    assert.equal(await page.locator('#open-events-loading .skeleton').count(), 2);
    assert.match(await page.textContent('#open-events-loading'), /Loading open sign-ups…/);
    assert.equal(await page.getAttribute('#open-events', 'aria-busy'), 'true');
    assert.ok(await page.isVisible('#link-btn'));
    release();
    await page.waitForFunction(() => /couldn't load the list/.test(document.getElementById('open-events-status').textContent));
    assert.ok(await page.isHidden('#open-events-loading'), 'indicator gone after failure');
    assert.ok(await page.isHidden('#error-view'), 'no full-page error');
  } finally { await page.close(); server.close(); }
});

test('the link tool makes a TinyURL and a QR code, via the JSON API', async () => {
  const t = await open('/static');
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    await t.page.fill('#f-sheet', t.gas.eventId);
    await t.page.click('#link-btn');
    await t.page.waitForSelector('#link-result:not([hidden])');
    assert.ok(await t.page.isHidden('#short-result'), 'only on request');
    assert.match(await t.page.inputValue('#f-alias'), /^bishop-fall-book-fair-20\d\d$/, 'text suggested from the title');
    await t.page.fill('#f-alias', ''); // blank: a random link
    await t.page.click('#short-btn');
    await t.page.waitForSelector('#short-result:not([hidden])');
    assert.equal(await t.page.inputValue('#short-output'), 'https://tinyurl.com/fake1');
    assert.deepEqual(t.gas.fetchLog, ['https://tinyurl.com/api-create.php?url=' +
      encodeURIComponent('https://signups.bishopschoolpto.com/?event=' + t.gas.eventId)], 'links to the real site, not localhost');
    assert.ok(t.server.apiLog.includes('POST shortLink'));
    assert.deepEqual(t.server.rpcLog, []);

    const qr = await t.page.evaluate(() => {
      const img = document.getElementById('qr-image');
      return { src: img.src, width: img.naturalWidth, shown: img.getBoundingClientRect().width };
    });
    assert.match(qr.src, /^data:image\/png;base64,/);
    assert.ok(qr.width >= 290 && qr.shown > 100, JSON.stringify({ width: qr.width, shown: qr.shown }));
    assert.equal(await t.page.getAttribute('#qr-download', 'href'), qr.src);
    assert.equal(await t.page.getAttribute('#qr-download', 'download'), 'fall-book-fair-sample-qr-code.png');
    assert.match(await t.page.textContent('#short-saved'), /Also saved in your spreadsheet/);
    assert.ok(await t.page.isVisible('#short-saved'));
    assert.ok(await t.page.isHidden('#short-not-saved'));

    // Looking up another spreadsheet starts over, with a new suggestion.
    const other = t.gas.addEvent({ title: 'Spring Carnival 2027' });
    await t.page.fill('#f-alias', 'leftover-text');
    await t.page.fill('#f-sheet', other.getId());
    await t.page.click('#link-btn');
    await t.page.waitForFunction(() => document.getElementById('f-alias').value === 'bishop-spring-carnival-2027');
    assert.ok(await t.page.isHidden('#short-result'));
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('organizers can choose the short link text, and fix it if TinyURL refuses', async () => {
  const t = await open('/static');
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    await t.page.fill('#f-sheet', t.gas.eventId);
    await t.page.click('#link-btn');
    await t.page.waitForSelector('#link-result:not([hidden])');

    await t.page.fill('#f-alias', 'no');
    await t.page.click('#short-btn');
    assert.match(await t.page.textContent('#short-error'), /5–30 letters/);
    assert.deepEqual(t.gas.fetchLog, [], 'checked in the browser first');

    t.gas.ctx.UrlFetchApp.tinyUrls['book-fair'] = 'https://elsewhere.example/';
    await t.page.fill('#f-alias', 'tinyurl.com/book-fair');
    const originalError = console.error;
    console.error = () => {};
    try {
      await t.page.click('#short-btn');
      await t.page.waitForFunction(() => /already taken/.test(document.getElementById('short-error').textContent));
    } finally {
      console.error = originalError;
    }
    assert.equal(await t.page.inputValue('#f-alias'), 'book-fair', 'pasted prefix removed');
    assert.equal(await t.page.evaluate(() => document.activeElement.id), 'f-alias');

    await t.page.fill('#f-alias', 'bishop-book-fair');
    await t.page.click('#short-btn');
    await t.page.waitForSelector('#short-result:not([hidden])');
    assert.ok(await t.page.isHidden('#short-error'));
    assert.equal(await t.page.inputValue('#short-output'), 'https://tinyurl.com/bishop-book-fair');
    assert.ok(await t.page.isVisible('#short-btn'), 'can change it again');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('if the spreadsheet can\'t be written, the page says the link wasn\'t saved there', async () => {
  const t = await open('/static');
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    await t.page.fill('#f-sheet', t.gas.eventId);
    await t.page.click('#link-btn');
    await t.page.waitForSelector('#link-result:not([hidden])');
    t.gas.event.getSheetByName('Event').insertImage = () => { throw new Error('You do not have permission'); };
    const originalError = console.error;
    console.error = () => {};
    try {
      await t.page.click('#short-btn');
      await t.page.waitForSelector('#short-result:not([hidden])');
    } finally {
      console.error = originalError;
    }
    assert.ok(await t.page.isVisible('#short-not-saved'));
    assert.ok(await t.page.isHidden('#short-saved'));
  } finally { await t.close(); }
});

test('if TinyURL fails, the link tool says so and can try again', async () => {
  const t = await open('/static');
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    await t.page.fill('#f-sheet', t.gas.eventId);
    await t.page.click('#link-btn');
    await t.page.waitForSelector('#link-result:not([hidden])');
    t.gas.ctx.UrlFetchApp.nextReply = { code: 503, text: 'Busy' };
    const originalError = console.error;
    console.error = () => {};
    try {
      await t.page.click('#short-btn');
      await t.page.waitForSelector('#short-error:not([hidden])');
    } finally {
      console.error = originalError;
    }
    assert.match(await t.page.textContent('#short-error'), /couldn't make a short link/);
    assert.ok(await t.page.isHidden('#short-result'));
    await t.page.click('#short-btn');
    await t.page.waitForSelector('#short-result:not([hidden])');
    assert.ok(await t.page.isHidden('#short-error'));
  } finally { await t.close(); }
});

test('the cancel page works on the static site, through the JSON API', async () => {
  const t = await open('/static');
  try {
    t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId: 'setup', name: 'Pat Lee', email: 'pat@example.com', baseUrl: t.base + '/static' });
    const token = t.gas.ctx.readTable_(t.gas.event, 'Signups')[0].cancelToken;
    await t.page.goto(t.base + '/static?event=' + t.gas.eventId + '&cancel=' + token);
    await t.page.waitForSelector('#cancel-view:not([hidden])');
    assert.equal(await t.page.textContent('#cancel-slot'), 'Setup');
    await t.page.click('#cancel-confirm-btn');
    await t.page.waitForFunction(() => document.getElementById('cancel-heading').textContent === 'Your sign-up is cancelled');
    assert.ok(t.server.apiLog.includes('GET cancellation'));
    assert.ok(t.server.apiLog.includes('POST cancel'));
    assert.deepEqual(t.server.rpcLog, []);
    assert.equal(await t.page.getAttribute('#cancel-event-link', 'href'), t.base + '/static?event=' + t.gas.eventId);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('a server error shows the friendly message', async () => {
  const t = await open('/static?event=EVENT');
  try {
    await t.page.waitForSelector('#event-view:not([hidden])');
    t.gas.event.getSheetByName('Signups').appendRow = () => { throw new Error('Sheets is down'); };
    const originalError = console.error;
    console.error = () => {};
    try {
      await t.page.click('#slot-setup button');
      await t.page.fill('#f-name', 'Jane Doe');
      await t.page.fill('#f-email', 'jane@example.com');
      await t.page.click('#submit-btn');
      await t.page.waitForSelector('#error-view:not([hidden])');
    } finally {
      console.error = originalError;
    }
    assert.match(await t.page.textContent('#error-view'), /Something went wrong/);
    assert.equal(await t.page.isEnabled('#submit-btn'), true, 'button re-enabled');
  } finally { await t.close(); }
});

test('if the API is unreachable, the page says so instead of spinning forever', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const page = await browser.newPage();
  try {
    await page.route('**/exec**', (route) => route.abort());
    await page.goto('http://localhost:' + server.address().port + '/static?event=' + server.gas.eventId);
    await page.waitForSelector('#error-view:not([hidden])');
    assert.match(await page.textContent('#error-view'), /Something went wrong/);
  } finally { await page.close(); server.close(); }
});

test('static site fits a phone screen', async () => {
  const t = await open('/static?event=EVENT', { width: 375, height: 740 });
  try {
    await t.page.waitForSelector('#slot-setup');
    await t.page.click('#slot-setup button');
    const overflow = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, 'page is ' + overflow + 'px wider than the screen');
  } finally { await t.close(); }
});

// ---------- Cloudflare edge (edge/worker.js, served by the dev server at /edge) ----------

test('with an edge, the event page loads from it without calling Apps Script', async () => {
  const t = await open('/static-edge?event=EVENT');
  try {
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.equal(await t.page.textContent('#event-title'), 'Fall Book Fair (sample)');
    assert.equal(await t.page.locator('.slot').count(), 3);
    assert.deepEqual(t.server.edgeLog, ['GET /events/' + t.gas.eventId]);
    assert.deepEqual(t.server.apiLog, [], 'Apps Script not called');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('with an edge, the home page lists open events from it', async () => {
  const t = await open('/static-edge');
  try {
    await t.page.waitForSelector('#open-events-list:not([hidden])');
    assert.match(await t.page.textContent('#open-events-list'), /Fall Book Fair \(sample\)/);
    assert.deepEqual(t.server.edgeLog, ['GET /events']);
    assert.deepEqual(t.server.apiLog, []);
  } finally { await t.close(); }
});

test('if the edge lacks the event or is stale, the page asks Apps Script', async () => {
  const t = await open('/static-edge?event=EVENT');
  try {
    await t.page.waitForSelector('#event-view:not([hidden])');
    t.server.edgeEnv.EVENTS.data.delete('event:' + t.gas.eventId);
    t.server.apiLog.length = 0;
    await t.page.reload();
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.equal(await t.page.textContent('#event-title'), 'Fall Book Fair (sample)');
    assert.deepEqual(t.server.apiLog, ['GET page'], 'not published: fell back');

    t.server.edgeEnv.EVENTS.data.set('meta:syncedAt', String(Date.now() - 60 * 60 * 1000));
    t.server.apiLog.length = 0;
    await t.page.goto(t.base + '/static-edge');
    await t.page.waitForSelector('#open-events-list:not([hidden])');
    assert.deepEqual(t.server.apiLog, ['GET events'], 'stale: fell back');
  } finally { await t.close(); }
});

test('if the edge is unreachable, the page still loads from Apps Script', async () => {
  const t = await open('/static-edge?event=EVENT');
  try {
    await t.page.route('**/edge/**', (route) => route.abort());
    t.server.apiLog.length = 0;
    await t.page.reload();
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.deepEqual(t.server.apiLog, ['GET page']);
  } finally { await t.close(); }
});

test('after signing up, the next page load skips the edge, and the edge has the sign-up', async () => {
  const t = await open('/static-edge?event=EVENT');
  try {
    await t.page.click('#slot-checkout button');
    await t.page.fill('#f-name', 'Jane Doe');
    await t.page.fill('#f-email', 'jane@example.com');
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#done-view:not([hidden])');

    t.server.edgeLog.length = 0;
    t.server.apiLog.length = 0;
    await t.page.reload();
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.deepEqual(t.server.edgeLog, [], 'skipped: this browser just changed the event');
    assert.deepEqual(t.server.apiLog, ['GET page']);
    assert.match(await t.page.textContent('#slot-checkout'), /Jane D\./);

    // Another browser gets it from the edge, already updated.
    const other = await browser.newPage();
    try {
      await other.goto(t.base + '/static-edge?event=' + t.gas.eventId);
      await other.waitForSelector('#event-view:not([hidden])');
      assert.match(await other.textContent('#slot-checkout'), /Jane D\./);
      assert.deepEqual(t.server.apiLog, ['GET page'], 'no Apps Script call for the other browser');
    } finally { await other.close(); }
  } finally { await t.close(); }
});

// ---------- Edge check: comparing the edge's copy with Apps Script ----------

/** Waits until the dev server has seen an Apps Script request. */
async function waitForApi(t, entry) {
  for (let i = 0; i < 100 && !t.server.apiLog.includes(entry); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(t.server.apiLog.includes(entry), entry + ' in ' + JSON.stringify(t.server.apiLog));
}

test('?compare=1 checks the edge against Apps Script and logs the result, without reporting', async () => {
  const t = await open('/static-edge?event=EVENT&compare=1');
  try {
    await t.page.waitForSelector('#event-view:not([hidden])');
    await waitForApi(t, 'GET page');
    for (let i = 0; i < 40 && !t.consoleLines.some((l) => l.includes('[edge check]')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(t.consoleLines.some((l) => /^info: \[edge check\] event \S+ matches Apps Script \(edge copy published \d+s ago\)/.test(l)), t.consoleLines.join('\n'));
    assert.deepEqual(t.server.edgeLog, ['GET /events/' + t.gas.eventId], 'rendered from the edge');

    // Make the edge's copy differ: compare mode logs it but reports nothing.
    const key = 'event:' + t.gas.eventId;
    const view = JSON.parse(t.server.edgeEnv.EVENTS.data.get(key));
    view.title = 'Old title';
    t.server.edgeEnv.EVENTS.data.set(key, JSON.stringify(view));
    t.consoleLines.length = 0;
    await t.page.reload();
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.equal(await t.page.textContent('#event-title'), 'Old title');
    for (let i = 0; i < 40 && !t.consoleLines.some((l) => l.includes('differs')); i++) await new Promise((r) => setTimeout(r, 50));
    const line = t.consoleLines.find((l) => l.includes('differs'));
    assert.ok(line && line.startsWith('warning: '), t.consoleLines.join('\n'));
    assert.match(line, /title: edge "Old title", apps script "Fall Book Fair \(sample\)"/);
    assert.ok(!t.server.apiLog.includes('POST edgeMismatch'));
  } finally { await t.close(); }
});

test('a sampled page load reports a difference to Apps Script, after rendering', async () => {
  const t = await open('/static-edge', undefined, { edgeCheckRate: 1 });
  try {
    await t.page.waitForSelector('#open-events-list:not([hidden])');
    await waitForApi(t, 'GET events');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!t.server.apiLog.includes('POST edgeMismatch'), 'the same: nothing reported');

    const key = 'event:' + t.gas.eventId;
    const view = JSON.parse(t.server.edgeEnv.EVENTS.data.get(key));
    view.slots[0].filled = 99;
    t.server.edgeEnv.EVENTS.data.set(key, JSON.stringify(view));
    t.server.apiLog.length = 0;
    const warnings = [];
    const warn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      await t.page.goto(t.base + '/static-edge?event=' + t.gas.eventId);
      await t.page.waitForSelector('#event-view:not([hidden])');
      await waitForApi(t, 'POST edgeMismatch');
      assert.deepEqual(t.server.apiLog, ['GET page', 'POST edgeMismatch']);
    } finally { console.warn = warn; }
    const logged = warnings.find((l) => l.startsWith('edge mismatch '));
    assert.ok(logged, warnings.join('\n'));
    const entry = JSON.parse(logged.slice('edge mismatch '.length));
    assert.equal(entry.eventId, t.gas.eventId);
    assert.match(entry.diffs.join(), /slots\[0\]\.filled: edge 99, apps script 0/);
    assert.equal(entry.cause, 'unexplained', 'the edge has the latest publish, yet differs');
  } finally { await t.close(); }
});
