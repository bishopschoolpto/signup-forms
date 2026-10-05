const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadGas, loadWithEvent, SRC_DIR } = require('../helpers/gas');

// Apps Script exposes every global function not ending in "_" to
// google.script.run, i.e. to anonymous visitors. Keep this list tiny and
// review any change to it.
const PUBLIC_FUNCTIONS = ['cancelSignup', 'doGet', 'doPost', 'getCancellation', 'getOpenEvents', 'getPageData', 'getShortLink', 'include', 'refreshEventCaches', 'setup', 'submitSignup'];

test('only the intended functions are callable from the browser', () => {
  const { ctx } = loadGas();
  const exposed = vm.runInContext(
    'Object.getOwnPropertyNames(globalThis).filter(function (k) {' +
    '  return typeof globalThis[k] === "function" && !/_$/.test(k); })',
    ctx,
  ).filter((name) => !(name in globalThis)); // drop built-ins like Object, Array
  assert.deepEqual([...exposed].sort(), PUBLIC_FUNCTIONS);
});

test('setup() refuses anonymous callers', () => {
  const gas = loadGas();
  gas.session.activeUser = '';
  assert.throws(() => gas.ctx.setup(), /only be run by the script owner/);
  assert.equal(gas.props.TEMPLATE_ID, undefined);
  assert.equal(gas.props.SAMPLE_EVENT_ID, undefined);
});

test('setup() refuses a signed-in visitor who is not the owner', () => {
  const gas = loadGas();
  gas.session.activeUser = 'someone@else.com';
  assert.throws(() => gas.ctx.setup(), /only be run by the script owner/);
});

test('refreshEventCaches() refuses browser calls: it needs one of this project\'s trigger uids', () => {
  const gas = loadWithEvent();
  for (const fake of [undefined, {}, { triggerUid: '' }, { triggerUid: 'guessed-uid' }]) {
    assert.throws(() => gas.ctx.refreshEventCaches(fake), /only runs from its timer/, JSON.stringify(fake));
  }
  assert.deepEqual(gas.driveLog, [], 'no work done for refused calls');
  assert.ok(gas.runTimer().events >= 1, 'the real trigger works');
});

test('getPageData never returns volunteer contact info, cancel tokens, or the organizer email', () => {
  const gas = loadWithEvent();
  gas.event.setEventField('organizerEmail', 'organizer@example.com');
  gas.ctx.submitSignup({ eventId: gas.eventId, slotId: 'setup', name: 'Jane Doe', email: 'jane@example.com', phone: '555-0199' });
  const token = gas.ctx.readTable_(gas.event, 'Signups')[0].cancelToken;
  for (const page of [gas.ctx.getPageData(''), gas.ctx.getPageData(gas.eventId)]) {
    const json = JSON.stringify(page);
    assert.ok(!json.includes('jane@example.com'));
    assert.ok(!json.includes('555-0199'));
    assert.ok(!json.includes(token));
    assert.ok(!json.includes('organizer@example.com'));
  }
});

test('getOpenEvents lists only public summary fields, never slots, names, or contact info', () => {
  const gas = loadWithEvent();
  gas.event.setEventField('organizerEmail', 'organizer@example.com');
  gas.ctx.submitSignup({ eventId: gas.eventId, slotId: 'setup', name: 'Jane Doe', email: 'jane@example.com', phone: '555-0199' });
  const list = JSON.parse(JSON.stringify(gas.ctx.getOpenEvents()));
  assert.equal(list.events.length, 1);
  assert.deepEqual(Object.keys(list.events[0]).sort(), ['dates', 'eventId', 'location', 'spotsLeft', 'title', 'waitlistOpen']);
  const json = JSON.stringify(list);
  for (const secret of ['jane@example.com', '555-0199', 'Jane', 'organizer@example.com', 'setup']) {
    assert.ok(!json.includes(secret), secret);
  }
});

test('cancelling needs the exact token from that volunteer\'s email, and reveals no contact info', () => {
  const gas = loadWithEvent();
  gas.ctx.submitSignup({ eventId: gas.eventId, slotId: 'setup', name: 'Jane Doe', email: 'jane@example.com', phone: '555-0199' });
  const token = gas.ctx.readTable_(gas.event, 'Signups')[0].cancelToken;
  for (const bad of [undefined, {}, { eventId: gas.eventId }, { eventId: gas.eventId, token: '' },
    { eventId: gas.eventId, token: token.toUpperCase().replace(/^./, '0') }, { eventId: gas.eventId, token: token + 'x' },
    { eventId: gas.props.TEMPLATE_ID, token }, { eventId: 'A'.repeat(44), token }]) {
    assert.equal(gas.ctx.getCancellation(bad).error, 'NOT_FOUND', JSON.stringify(bad));
    assert.equal(gas.ctx.cancelSignup(bad).error, 'NOT_FOUND', JSON.stringify(bad));
  }
  assert.equal(gas.ctx.readTable_(gas.event, 'Signups')[0].status, 'confirmed', 'nothing cancelled');
  const json = JSON.stringify(gas.ctx.getCancellation({ eventId: gas.eventId, token }));
  for (const secret of ['jane@example.com', '555-0199', 'Doe', token]) assert.ok(!json.includes(secret), secret);
});

test('the app asks Google for read-only Drive metadata access (never full Drive access), plus triggers and outside requests (TinyURL)', () => {
  const manifest = JSON.parse(require('node:fs').readFileSync(require('node:path').join(SRC_DIR, 'appsscript.json'), 'utf8'));
  assert.deepEqual([...manifest.oauthScopes].sort(), [
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/script.send_mail',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
  ]);
});

test('getShortLink only shortens links to events, on this app or the static site', () => {
  const gas = loadWithEvent();
  gas.moveTo(gas.eventId, 'subFolder');
  const outside = gas.addEvent({ title: 'Elsewhere' }, [], 'otherFolder');
  for (const request of [null, {}, { eventId: 'https://evil.example/' }, { eventId: gas.eventId }, { eventId: outside.getId() }]) {
    assert.equal(gas.ctx.getShortLink(request).ok, false, JSON.stringify(request));
  }
  assert.deepEqual(gas.fetchLog, [], 'TinyURL never called');

  const open = gas.addEvent({ title: 'Open' });
  const res = gas.ctx.getShortLink({ eventId: open.getId(), baseUrl: 'https://evil.example/' });
  assert.equal(res.longUrl, 'https://signups.bishopschoolpto.com/?event=' + open.getId(), 'other base URLs are ignored');
});

test('the server\'s QR code library is private and is the same as the browser\'s copy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const lib = (file) => {
    const text = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    return text.slice(text.indexOf('var qrcode=function()'), text.indexOf('(function(){return qrcode});') + 28);
  };
  assert.ok(lib('QrCode.html').length > 10000);
  assert.equal(lib('QrCodeLib.js'), lib('QrCode.html'));
  const { ctx } = loadGas();
  assert.equal(typeof ctx.qrcode_, 'function');
  assert.equal(typeof ctx.qrcode, 'undefined', 'no public qrcode global');
});

test('src/PawPrint.html is an exact copy of img/bishop_paw_print.svg', () => {
  // Apps Script can't serve image files, so the logo is inlined via include('PawPrint').
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'PawPrint.html'), 'utf8'),
    fs.readFileSync(path.join(root, 'img', 'bishop_paw_print.svg'), 'utf8'),
    'Re-copy: cp img/bishop_paw_print.svg src/PawPrint.html',
  );
});
