const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithEvent, plain, PAST_FOLDER } = require('../helpers/gas');

const EDGE_URL = 'https://signups-edge.example.workers.dev';
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

function withEdge(gas = loadWithEvent()) {
  gas.props.EDGE_URL = EDGE_URL;
  gas.props.EDGE_SECRET = SECRET;
  return gas;
}
const signUp = (gas, n, slotId = 'cleanup') =>
  gas.ctx.submitSignup({ eventId: gas.eventId, slotId, name: 'Parent ' + n, email: 'parent' + n + '@example.com' });
const quietly = (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
};

test('without EDGE_URL and EDGE_SECRET nothing is published', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  signUp(gas, 1);
  assert.deepEqual(gas.edgePublishes, []);
  gas.props.EDGE_URL = EDGE_URL; // a URL alone is not enough
  gas.runTimer();
  assert.deepEqual(gas.edgePublishes, []);
});

test('the timer publishes each event as the page shows it, plus the open events list', () => {
  const gas = withEdge();
  const past = gas.addEvent({ title: 'Old Fair' }, [{ slotId: 'a', label: 'A', capacity: 1 }], PAST_FOLDER);
  const stats = plain(gas.runTimer());
  assert.deepEqual(stats.edge, { published: 2, removed: 0, openEvents: true, failed: false });

  assert.equal(gas.edgePublishes.length, 1);
  const { url, auth, body } = gas.edgePublishes[0];
  assert.equal(url, EDGE_URL + '/publish');
  assert.equal(auth, 'Bearer ' + SECRET);
  assert.deepEqual(plain(body.put[gas.eventId]), plain(gas.ctx.getPageData(gas.eventId).event), 'same as Apps Script serves');
  assert.equal(body.put[past.getId()].isOpen, false);
  assert.deepEqual(plain(body.openEvents), plain(gas.ctx.getOpenEvents().events));
  assert.equal(body.delete, undefined);
});

test('the timer publishes only what changed', () => {
  const gas = withEdge();
  gas.runTimer();
  gas.edgePublishes.length = 0;

  assert.deepEqual(plain(gas.runTimer()).edge, { published: 0, removed: 0, openEvents: false, failed: false });
  assert.deepEqual(gas.edgePublishes, [], 'nothing changed: no request');

  gas.event.setEventField('title', 'Spring Book Fair');
  gas.runTimer();
  assert.equal(gas.edgePublishes.length, 1);
  assert.deepEqual(Object.keys(gas.edgePublishes[0].body.put), [gas.eventId]);
  assert.equal(gas.edgePublishes[0].body.put[gas.eventId].title, 'Spring Book Fair');
  assert.equal(gas.edgePublishes[0].body.openEvents[0].title, 'Spring Book Fair', 'the list changed too');
});

test('moving an event to Past events republishes it as closed; moving it out removes it', () => {
  const gas = withEdge();
  gas.runTimer();
  gas.edgePublishes.length = 0;

  gas.moveTo(gas.eventId, PAST_FOLDER);
  gas.runTimer();
  const closed = gas.edgePublishes[0].body;
  assert.equal(closed.put[gas.eventId].isOpen, false);
  assert.deepEqual(plain(closed.openEvents), [], 'no longer listed as open');

  gas.moveTo(gas.eventId, 'someOtherFolder');
  gas.runTimer();
  const removed = gas.edgePublishes[1].body;
  assert.deepEqual(plain(removed.delete), [gas.eventId]);
  assert.deepEqual(plain(removed.put), {});
  assert.equal(gas.props['edgeEvent:' + gas.eventId], undefined, 'forgotten');
  gas.runTimer();
  assert.equal(gas.edgePublishes.length, 2, 'removed only once');
});

test('an event the timer could not rebuild this run stays published', () => {
  const gas = withEdge();
  gas.runTimer();
  gas.edgePublishes.length = 0;
  gas.event.setEventField('title', 'Changed');
  gas.cache.delete('publicEvent:' + gas.eventId);
  require('node:vm').runInContext('REFRESH_BUDGET_MS = -1', gas.ctx);
  gas.runTimer();
  assert.ok(gas.edgePublishes.every((p) => !(p.body.delete || []).includes(gas.eventId)));
});

test('a sign-up publishes the event at once, under the lock', () => {
  const gas = withEdge();
  gas.runTimer();
  gas.edgePublishes.length = 0;
  gas.lockLog.length = 0;

  assert.equal(signUp(gas, 1).ok, true);
  assert.equal(gas.edgePublishes.length, 1);
  const published = gas.edgePublishes[0].body.put[gas.eventId];
  assert.equal(published.slots.find((s) => s.slotId === 'cleanup').filled, 1);
  assert.equal(published.isOpen, true);
  assert.deepEqual(plain(published), plain(gas.ctx.getPageData(gas.eventId).event));

  gas.edgePublishes.length = 0;
  assert.equal(plain(gas.runTimer()).edge.published, 0, 'the timer knows it is already published');
});

test('a cancellation publishes the event at once', () => {
  const gas = withEdge();
  signUp(gas, 1);
  const token = gas.ctx.readTable_(gas.event, 'Signups')[0].cancelToken;
  gas.edgePublishes.length = 0;
  assert.equal(gas.ctx.cancelSignup({ eventId: gas.eventId, token }).ok, true);
  assert.equal(gas.edgePublishes.length, 1);
  assert.equal(gas.edgePublishes[0].body.put[gas.eventId].slots.find((s) => s.slotId === 'cleanup').filled, 0);
});

test('an edge failure never fails a sign-up, and the timer retries it', () => {
  const gas = withEdge();
  gas.runTimer();
  gas.ctx.UrlFetchApp.edgeReply = { code: 500, text: 'oops' };
  assert.equal(quietly(() => signUp(gas, 1)).ok, true);
  gas.ctx.UrlFetchApp.edgeReply = { throws: 'Timeout' };
  assert.equal(quietly(() => signUp(gas, 2, 'setup')).ok, true);
  assert.equal(quietly(() => plain(gas.runTimer())).edge.failed, true);

  gas.ctx.UrlFetchApp.edgeReply = null;
  gas.edgePublishes.length = 0;
  const stats = plain(gas.runTimer());
  assert.equal(stats.edge.published, 1, 'retried once the edge is back');
  assert.equal(gas.edgePublishes[0].body.put[gas.eventId].slots.find((s) => s.slotId === 'setup').filled, 1);
});

test('with nothing to publish, the timer still checks in every 10 minutes', () => {
  const gas = withEdge();
  gas.runTimer();
  gas.edgePublishes.length = 0;
  gas.runTimer();
  assert.equal(gas.edgePublishes.length, 0);

  gas.props.edgeSyncedAt = String(Date.now() - 11 * 60 * 1000);
  gas.runTimer();
  assert.equal(gas.edgePublishes.length, 1);
  assert.deepEqual(plain(gas.edgePublishes[0].body), { put: {} });
});

test('many events go out in batches of at most 50', () => {
  const gas = withEdge();
  for (let i = 0; i < 60; i++) gas.addEvent({ title: 'Event ' + i }, []);
  const stats = plain(gas.runTimer());
  assert.equal(stats.edge.published, 61);
  assert.deepEqual(gas.edgePublishes.map((p) => Object.keys(p.body.put).length), [50, 11]);
  assert.equal(gas.edgePublishes[0].body.openEvents, undefined, 'the list comes with the last batch');
  assert.ok(gas.edgePublishes[1].body.openEvents);
});

test('published data never includes contact info, cancel tokens, or the organizer email', () => {
  const gas = withEdge();
  gas.event.setEventField('organizerEmail', 'organizer@example.com');
  gas.ctx.submitSignup({ eventId: gas.eventId, slotId: 'setup', name: 'Jane Doe', email: 'jane@example.com', phone: '555-0199' });
  gas.event.setEventField('title', 'Changed'); // make the timer publish too
  gas.runTimer();
  const token = gas.ctx.readTable_(gas.event, 'Signups')[0].cancelToken;
  const sent = JSON.stringify(gas.edgePublishes.map((p) => p.body));
  for (const secret of ['jane@example.com', '555-0199', token, 'organizer@example.com']) {
    assert.ok(!sent.includes(secret), secret);
  }
});

// ---------- Mismatch reports from the static site's edge check ----------

/** Posts a mismatch report the way the static site does; returns the logged line. */
function report(gas, input) {
  const lines = [];
  const warn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    const out = JSON.parse(gas.ctx.doPost({ postData: { contents: JSON.stringify({ api: 'edgeMismatch', input }) } }).getContent());
    return { out, logged: lines.filter((l) => l.startsWith('edge mismatch ')).map((l) => JSON.parse(l.slice('edge mismatch '.length))) };
  } finally { console.warn = warn; }
}
const publishedAt = (gas, id) => Number(gas.props['edgeEvent:' + id].split('|')[1]);

test('Script Properties remember each event\'s hash and when it was published', () => {
  const gas = withEdge();
  const before = Date.now();
  gas.runTimer();
  assert.match(gas.props['edgeEvent:' + gas.eventId], /^[0-9a-z]+\|\d+$/);
  assert.ok(publishedAt(gas, gas.eventId) >= before);
  assert.match(gas.props.edgeOpenEvents, /^[0-9a-z]+\|\d+$/);
});

test('a mismatch right after a change that is not yet published is "not-published"', () => {
  const gas = withEdge();
  gas.runTimer();
  const edgeAt = publishedAt(gas, gas.eventId);
  gas.ctx.UrlFetchApp.edgeReply = { code: 500, text: 'down' };
  quietly(() => signUp(gas, 1)); // cached at once, but not published
  gas.ctx.UrlFetchApp.edgeReply = null;
  const { out, logged } = report(gas, { eventId: gas.eventId, publishedAt: edgeAt, diffs: ['slots[0].filled: edge 0, apps script 1'] });
  assert.deepEqual(out, { ok: true });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].cause, 'not-published');
  assert.equal(logged[0].eventId, gas.eventId);
  assert.deepEqual(logged[0].diffs, ['slots[0].filled: edge 0, apps script 1']);
});

test('an edge copy older than the last publish is "propagating" at first, then "edge-behind"', () => {
  const gas = withEdge();
  gas.runTimer();
  const [hash] = gas.props['edgeEvent:' + gas.eventId].split('|');
  const old = Date.now() - 10 * 60 * 1000;

  gas.props['edgeEvent:' + gas.eventId] = hash + '|' + (Date.now() - 30 * 1000);
  assert.equal(report(gas, { eventId: gas.eventId, publishedAt: old, diffs: ['x'] }).logged[0].cause, 'propagating');

  gas.props['edgeEvent:' + gas.eventId] = hash + '|' + (Date.now() - 3 * 60 * 1000);
  assert.equal(report(gas, { eventId: gas.eventId, publishedAt: old, diffs: ['x'] }).logged[0].cause, 'edge-behind');
});

test('a mismatch when the edge has the latest data is "unexplained"', () => {
  const gas = withEdge();
  gas.runTimer();
  const { logged } = report(gas, { eventId: gas.eventId, publishedAt: publishedAt(gas, gas.eventId), diffs: ['title: edge "A", apps script "B"'] });
  assert.equal(logged[0].cause, 'unexplained');
  assert.equal(typeof logged[0].edgeAgeSec, 'number');
});

test('the open events list can be reported too', () => {
  const gas = withEdge();
  gas.runTimer();
  const at = Number(gas.props.edgeOpenEvents.split('|')[1]);
  const { logged } = report(gas, { eventId: '', publishedAt: at, diffs: ['[0].spotsLeft: edge 6, apps script 5'] });
  assert.equal(logged[0].eventId, '(open events list)');
  assert.equal(logged[0].cause, 'unexplained');
});

test('mismatch reports are checked and capped, since anyone can send them', () => {
  const gas = withEdge();
  gas.runTimer();
  assert.deepEqual(report(gas, { eventId: '../bad', diffs: [] }).out, { ok: false, error: 'INVALID' });
  const long = report(gas, { eventId: gas.eventId, diffs: Array.from({ length: 50 }, () => 'x'.repeat(500)) }).logged[0];
  assert.equal(long.diffs.length, 20);
  assert.ok(long.diffs.every((d) => d.length === 200));
  for (let i = 0; i < 59; i++) report(gas, { eventId: gas.eventId, diffs: [] }); // 60 logged in all
  assert.equal(report(gas, { eventId: gas.eventId, diffs: [] }).logged.length, 0, 'the 61st in an hour is not logged');
});
