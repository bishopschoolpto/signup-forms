const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, loadWithEvent, plain, EVENTS_FOLDER, PAST_FOLDER } = require('../helpers/gas');

/** Submits a sign-up to the sample event (or another event's spreadsheet). */
function signUp(gas, n, slotId = 'cleanup', extra = {}, eventId = gas.eventId) {
  return gas.ctx.submitSignup({ eventId, slotId, name: 'Parent ' + n, email: 'parent' + n + '@example.com', ...extra });
}
const signups = (gas, ss = gas.event) => gas.ctx.readTable_(ss, 'Signups');
const withOrganizer = (gas, email = 'organizer@example.com') => { gas.event.setEventField('organizerEmail', email); return gas; };

// ---------- Setup ----------

test('setup creates a full template and a sample event, and a second run changes nothing', () => {
  const gas = loadGas();
  const made = plain(gas.ctx.setup());
  assert.deepEqual(made.created, ['Event Template', 'sample event']);
  assert.equal(made.refreshTrigger, 'every minute');

  const template = gas.spreadsheet(gas.props.TEMPLATE_ID);
  const sample = gas.spreadsheet(gas.props.SAMPLE_EVENT_ID);
  for (const ss of [template, sample]) {
    assert.deepEqual(ss.getSheets().map((s) => s.getName()), ['Start here', 'Event', 'Slots', 'Signups', 'Questions']);
    assert.deepEqual(Object.keys(ss.eventInfo()), ['title', 'description', 'location', 'organizerEmail',
      'confirmationSubject', 'confirmationMessage', 'organizerSubject', 'organizerMessage']);
  }
  assert.equal(template.eventInfo().title, 'Event name');
  assert.equal(gas.ctx.readTable_(template, 'Slots').length, 0);
  assert.deepEqual(plain(gas.ctx.readQuestions_(template)), [], 'the template has an empty Questions tab');
  assert.equal(gas.ctx.readTable_(sample, 'Slots').length, 3);
  assert.equal(gas.ctx.readQuestions_(sample).length, 2, 'the sample shows off questions');
  assert.match(sample.eventInfo().confirmationSubject, /\{firstName\}/, '...and a custom email');

  const again = plain(gas.ctx.setup());
  assert.deepEqual([again.created, again.updated, again.refreshTrigger], [[], [], undefined], 'second run creates and changes nothing');
  assert.equal(gas.triggers.length, 1);
});

test('the template helps organizers: Start here guide, notes, dropdowns, and date formats', () => {
  const gas = loadGas();
  gas.ctx.setup();
  const template = gas.spreadsheet(gas.props.TEMPLATE_ID);
  const guide = template.getSheetByName('Start here').rows.map((r) => r[0]).join('\n');
  for (const topic of ['Event tab', 'Slots tab', 'Questions tab', 'Emails (optional)', 'organizerSubject', 'Get your sign-up link',
    'https://signups.bishopschoolpto.com/', 'waitlist', 'Past events', 'admin@bishopschoolpto.com']) {
    assert.ok(guide.includes(topic), topic);
  }
  const signupsTab = template.getSheetByName('Signups');
  assert.deepEqual(plain(signupsTab.validationFor('status').list), ['confirmed', 'waitlisted', 'cancelled']);
  assert.equal(signupsTab.validationFor('status').allowInvalid, false);
  assert.match(signupsTab.notes['1,' + (signupsTab.rows[0].indexOf('status') + 1)], /waitlisted/);
  const questions = template.getSheetByName('Questions');
  assert.deepEqual(plain(questions.validationFor('type').list), ['text', 'paragraph', 'choice', 'checkbox']);
  assert.deepEqual(plain(questions.validationFor('required').list), ['yes', 'no']);
  const slots = template.getSheetByName('Slots');
  assert.equal(slots.validationFor('capacity').min, 0);
  assert.deepEqual(slots.formats.map((f) => f.col).sort(), [3, 4], 'start and end get a date-time format');
  assert.match(slots.rows[0][6], /Leave slotId blank/, 'help text beside the table');
});

test('setup brings an old template up to date without touching what organizers typed', () => {
  const gas = loadGas();
  // An Event Template from an earlier version: status row, no email rows, no Questions or Start here tab.
  const old = gas.ctx.SpreadsheetApp.create('Event Template');
  old.getSheets()[0].setName('Event');
  old.getSheetByName('Event').rows = [['Field', 'Value', 'Notes'], ['title', 'Our Template', ''], ['description', 'Typed text', ''],
    ['location', '', ''], ['status', 'draft', 'open/closed'], ['organizerEmail', 'pto@example.com', '']];
  old.insertSheet('Slots').rows = [['slotId', 'label', 'start', 'end', 'capacity', '', 'old help']];
  old.insertSheet('Signups').rows = [['signupId', 'slotId', 'slotLabel', 'name', 'email', 'phone', 'note', 'status', 'cancelToken', 'createdAt']];
  gas.props.TEMPLATE_ID = old.getId();

  const result = plain(gas.ctx.setup());
  assert.ok(!result.created.includes('Event Template'), 'not replaced');
  assert.equal(gas.props.TEMPLATE_ID, old.getId(), 'same file, same link');
  assert.equal(result.updated.length, 1);
  for (const change of ['added the Start here tab', 'removed the old status row', 'added the confirmationSubject row',
    'added the confirmationMessage row', 'added the Questions tab']) {
    assert.ok(result.updated[0].includes(change), change);
  }
  assert.deepEqual(old.getSheets().map((s) => s.getName()), ['Start here', 'Event', 'Slots', 'Signups', 'Questions']);
  const info = old.eventInfo();
  assert.equal(info.status, undefined);
  assert.deepEqual([info.title, info.description, info.organizerEmail], ['Our Template', 'Typed text', 'pto@example.com'], 'values kept');
  assert.deepEqual(old.getSheetByName('Slots').rows[0].slice(0, 5), ['slotId', 'label', 'start', 'end', 'capacity']);

  assert.deepEqual(plain(gas.ctx.setup()).updated, [], 'then nothing more to do');
});

test('setup recreates the template or sample if it was deleted', () => {
  const gas = loadGas();
  gas.ctx.setup();
  const oldTemplate = gas.props.TEMPLATE_ID;
  gas.drive.get(oldTemplate).trashed = true;
  const result = plain(gas.ctx.setup());
  assert.deepEqual(result.created, ['Event Template']);
  assert.notEqual(gas.props.TEMPLATE_ID, oldTemplate);
});

test('setup\'s checklist says what is left to do', () => {
  const gas = loadGas();
  const first = plain(gas.ctx.setup()).checklist.join('\n');
  assert.match(first, /OK: the Events folder .* is reachable/);
  assert.match(first, /OK: the Past events folder .* is reachable/);
  assert.match(first, /TODO: move Event Template into the Events folder/);
  assert.match(first, /NOTE: to try the sample event, move it into the Events folder/);
  assert.match(first, /TODO: set the TINYURL_API_TOKEN script property/);
  assert.match(first, /OK: emails go to volunteers and organizers/);

  gas.moveTo(gas.props.TEMPLATE_ID, EVENTS_FOLDER);
  gas.moveTo(gas.props.SAMPLE_EVENT_ID, EVENTS_FOLDER);
  gas.props.TINYURL_API_TOKEN = 'tok';
  gas.props.MAIL_REDIRECT_TO = 'me@example.com';
  gas.props.PAST_EVENTS_FOLDER_ID = 'missingFolder';
  const second = plain(gas.ctx.setup()).checklist.join('\n');
  assert.match(second, /OK: Event Template is in the Events folder/);
  assert.match(second, /NOTE: the sample event is live and listed on the home page/);
  assert.match(second, /OK: TINYURL_API_TOKEN is set/);
  assert.match(second, /NOTE: MAIL_REDIRECT_TO is set, so every email goes to me@example\.com/);
  assert.match(second, /TODO: the Past events folder \(missingFolder\) can't be opened/);
});

// ---------- Which spreadsheets count as events ----------

test('an event spreadsheet in the Events folder is served', () => {
  const gas = loadWithEvent();
  const page = plain(gas.ctx.getPageData(gas.eventId));
  assert.equal(page.orgName, 'Bishop School PTO');
  assert.equal(page.baseUrl, 'https://script.google.com/macros/s/TEST/exec');
  assert.equal(page.event.eventId, gas.eventId);
  assert.equal(page.event.title, 'Fall Book Fair (sample)');
  assert.deepEqual(page.event.slots.map((s) => s.slotId), ['setup', 'checkout', 'cleanup']);
  assert.match(page.event.slots[0].when, /^\w{3}, \w{3} \d+, \d{4}, 8:00 AM – 9:00 AM$/);
});

test('events in Past events are shown with sign-ups closed', () => {
  const gas = loadWithEvent();
  gas.moveTo(gas.eventId, PAST_FOLDER);
  const event = gas.ctx.getPageData(gas.eventId).event;
  assert.equal(event.title, 'Fall Book Fair (sample)');
  assert.equal(event.isOpen, false);
  assert.equal(signUp(gas, 1).error, 'CLOSED');
  assert.equal(signups(gas).length, 0);
});

test('only spreadsheets directly in Events take sign-ups', () => {
  const gas = loadWithEvent();
  assert.equal(gas.ctx.getPageData(gas.eventId).event.isOpen, true);
  assert.equal(signUp(gas, 1).ok, true);
});

test('spreadsheets anywhere else, even in a subfolder of Events, are refused without being opened', () => {
  const gas = loadWithEvent();
  for (const folder of ['root', 'otherFolder', 'sharedDriveRoot', 'subFolder']) {
    const other = gas.addEvent({ title: 'Elsewhere' }, [], folder);
    gas.lockLog.length = 0;
    assert.equal(gas.ctx.getPageData(other.getId()).event, null, folder);
    assert.ok(!gas.lockLog.includes('open'), 'never opened a spreadsheet outside the folder');
  }
});

test('trashed files and non-spreadsheets in the folder are refused', () => {
  const gas = loadWithEvent();
  gas.drive.get(gas.eventId).trashed = true;
  assert.equal(gas.ctx.getPageData(gas.eventId).event, null);

  gas.drive.set('aDocInTheEventsFolder000000000000', { mimeType: 'application/vnd.google-apps.document', parents: [EVENTS_FOLDER] });
  assert.equal(gas.ctx.getPageData('aDocInTheEventsFolder000000000000').event, null);
});

test('malformed or unknown event ids are refused without calling Drive for junk', () => {
  const gas = loadWithEvent();
  for (const bad of ['', 'short', '../etc', 'a'.repeat(101), gas.eventId + '?x=1', { toString: () => 'x' }]) {
    assert.equal(gas.ctx.getPageData(bad).event, null);
  }
  assert.deepEqual(gas.driveLog, [], 'no Drive calls for malformed ids');
  assert.equal(gas.ctx.getPageData('A'.repeat(44)).event, null, 'well-formed but nonexistent');
});

test('the Event Template is never an event, even in the Events folder', () => {
  const gas = loadWithEvent();
  assert.deepEqual(gas.drive.get(gas.props.TEMPLATE_ID).parents, [EVENTS_FOLDER]);
  assert.equal(gas.ctx.getPageData(gas.props.TEMPLATE_ID).event, null);
  assert.equal(gas.ctx.submitSignup({ eventId: gas.props.TEMPLATE_ID, slotId: 'x', name: 'A B', email: 'a@b.co' }).error, 'NOT_FOUND');
});

test('an old status row in the Event tab is ignored', () => {
  const gas = loadWithEvent();
  gas.event.getSheetByName('Event').appendRow(['status', 'draft']);
  assert.equal(gas.ctx.getPageData(gas.eventId).event.isOpen, true);
  assert.equal(signUp(gas, 1).ok, true);
});

test('a spreadsheet with no Event tab is not an event', () => {
  const gas = loadWithEvent();
  gas.event.getSheetByName('Event').setName('Renamed');
  assert.equal(gas.ctx.getPageData(gas.eventId).event, null);
  assert.equal(signUp(gas, 1).error, 'NOT_FOUND');
});

test('the folder check is cached for page views: events for 5 minutes, anything else for 1', () => {
  const gas = loadWithEvent();
  gas.ctx.getPageData(gas.eventId);
  const callsAfterFirst = gas.driveLog.length;
  gas.ctx.getPageData(gas.eventId);
  assert.equal(gas.driveLog.length, callsAfterFirst, 'no further Drive calls');
  assert.deepEqual(gas.cache.get('eventFolder:' + gas.eventId), { value: 'open', seconds: 300 });

  const outside = gas.addEvent({ title: 'Elsewhere' }, [], 'otherFolder');
  gas.ctx.getPageData(outside.getId());
  assert.deepEqual(gas.cache.get('eventFolder:' + outside.getId()), { value: 'none', seconds: 60 });
});

test('a sign-up always checks the folder with Drive, never the cache', () => {
  const gas = loadWithEvent();
  gas.ctx.getPageData(gas.eventId);
  gas.driveLog.length = 0;
  signUp(gas, 1);
  assert.deepEqual(gas.driveLog, [gas.eventId]);
});

test('EVENTS_FOLDER_ID and PAST_EVENTS_FOLDER_ID script properties override the default folders', () => {
  const gas = loadWithEvent({ properties: { EVENTS_FOLDER_ID: 'otherFolder', PAST_EVENTS_FOLDER_ID: 'subFolder' } });
  assert.equal(gas.ctx.getPageData(gas.eventId).event, null);
  const open = gas.addEvent({ title: 'Other' }, [], 'otherFolder');
  assert.equal(gas.ctx.getPageData(open.getId()).event.isOpen, true);
  const past = gas.addEvent({ title: 'Old' }, [], 'subFolder');
  assert.equal(gas.ctx.getPageData(past.getId()).event.isOpen, false);
});

test('getPageData with no event returns no event and never lists events', () => {
  const gas = loadWithEvent();
  const page = plain(gas.ctx.getPageData(''));
  assert.equal(page.event, null);
  assert.equal(page.events, undefined);
  assert.deepEqual(gas.driveLog, []);
});

// ---------- Events are separate ----------

test('each event keeps its own slots and sign-ups', () => {
  const gas = loadWithEvent();
  const other = gas.addEvent({ title: 'Field Day' }, [{ slotId: 'cleanup', label: 'Cleanup', start: '', end: '', capacity: 1 }]);
  assert.equal(signUp(gas, 1, 'cleanup').ok, true);
  assert.equal(signUp(gas, 2, 'cleanup', {}, other.getId()).ok, true, 'same slot id in another event is independent');
  assert.deepEqual(plain(signups(gas).map((s) => s.email)), ['parent1@example.com']);
  assert.deepEqual(plain(signups(gas, other).map((s) => s.email)), ['parent2@example.com']);
});

test('a sign-up cannot target an event outside the folder', () => {
  const gas = loadWithEvent();
  const outside = gas.addEvent({ title: 'Elsewhere' }, [{ slotId: 'x', label: 'X', capacity: 5 }], 'otherFolder');
  const r = signUp(gas, 1, 'x', {}, outside.getId());
  assert.equal(r.error, 'NOT_FOUND');
  assert.equal(signups(gas, outside).length, 0);
});

// ---------- Slots ----------

test('slots added without an id get one written back, once', () => {
  const gas = loadWithEvent();
  const sheet = gas.event.getSheetByName('Slots');
  sheet.appendRow(['', 'Restock', '', '', 2]);
  sheet.appendRow(['', '', '', '', '']); // blank row: ignored

  const first = gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.label === 'Restock');
  assert.match(first.slotId, /^slot-[0-9a-f]{8}$/);
  assert.equal(sheet.rows[4][0], first.slotId, 'written to the sheet');

  const again = gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.label === 'Restock');
  assert.equal(again.slotId, first.slotId, 'stable across reads');
  assert.equal(signUp(gas, 1, first.slotId).ok, true);
});

test('readTable_ coerces Sheets types, skips blank rows, and follows the sheet\'s column order', () => {
  const gas = loadWithEvent();
  const slots = gas.event.getSheetByName('Slots');
  slots.appendRow([42, 'Numeric id', '', '', '5']);
  const rows = gas.ctx.readTable_(gas.event, 'Slots');
  const numeric = rows.find((r) => r.label === 'Numeric id');
  assert.equal(numeric.slotId, '42');
  assert.equal(numeric.capacity, 5);
  assert.match(rows[0].start, /^\d{4}-\d\d-\d\dT/, 'Date cells come back as ISO strings');

  const sheet = gas.event.getSheetByName('Signups');
  sheet.rows = [['email', 'signupId', 'slotId', 'slotLabel', 'name', 'phone', 'note', 'status', 'cancelToken', 'createdAt']];
  signUp(gas, 1);
  assert.equal(sheet.rows[1][0], 'parent1@example.com');
  assert.equal(signups(gas)[0].name, 'Parent 1');
});

// ---------- Submitting ----------

test('submitSignup records the sign-up (with the slot label) and emails a confirmation', () => {
  const gas = loadWithEvent();
  const result = plain(signUp(gas, 1, 'checkout', { phone: '+1 555 0100', note: 'Can stay late' }));
  assert.equal(result.ok, true);
  assert.equal(result.emailSent, true);
  assert.equal(result.slotLabel, 'Checkout table');
  assert.equal(result.cancelToken, undefined, 'cancel token is never sent to the browser');

  const [row] = signups(gas);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.slotLabel, 'Checkout table', 'organizers can read the sheet without looking up ids');
  assert.equal(row.phone, '+1 555 0100', 'leading + survives the formula guard');
  assert.ok(row.cancelToken);

  assert.equal(gas.sentMail.length, 1);
  assert.equal(gas.sentMail[0].to, 'parent1@example.com');
  assert.equal(gas.sentMail[0].subject, 'See you at the Book Fair, Parent!', 'the sample shows off a custom subject');
  assert.match(gas.sentMail[0].body, /Fall Book Fair.*\nSlot: Checkout table/s);
  assert.match(gas.sentMail[0].body, /check in at the library front desk/);
  assert.equal(gas.sentMail[0].name, 'Bishop School PTO');
});

test('submitSignup reads Slots and Signups only while holding the lock, and always releases it', () => {
  const gas = loadWithEvent();
  signUp(gas, 1);
  const lockAt = gas.lockLog.indexOf('lock');
  const unlockAt = gas.lockLog.indexOf('unlock');
  assert.ok(lockAt >= 0 && unlockAt > lockAt);
  for (const read of ['read:Slots', 'read:Signups']) {
    const at = gas.lockLog.indexOf(read);
    assert.ok(at > lockAt && at < unlockAt, read + ' happens under the lock');
  }
  assert.equal(gas.lockLog.filter((e) => e === 'unlock').length, 1);
});

test('the last spot goes to exactly one of two back-to-back sign-ups', () => {
  const gas = loadWithEvent();
  assert.equal(signUp(gas, 1).ok, true);
  assert.equal(signUp(gas, 2).error, 'SLOT_FULL');
  assert.equal(signups(gas).length, 1);
  assert.equal(gas.sentMail.length, 1);
});

test('submitSignup returns BUSY and writes nothing when the lock is unavailable', () => {
  const gas = loadWithEvent({ lockAvailable: false });
  assert.equal(signUp(gas, 1).error, 'BUSY');
  assert.equal(signups(gas).length, 0);
  assert.ok(!gas.lockLog.includes('unlock'), 'does not release a lock it never took');
});

test('submitSignup releases the lock even if the sheet write throws', () => {
  const gas = loadWithEvent();
  gas.event.getSheetByName('Signups').appendRow = () => { throw new Error('Sheets is down'); };
  assert.throws(() => signUp(gas, 1), /Sheets is down/);
  assert.equal(gas.lockLog.at(-1), 'unlock');
});

test('submitSignup returns field errors without touching Drive or the lock', () => {
  const gas = loadWithEvent();
  const r = plain(gas.ctx.submitSignup({ eventId: gas.eventId, slotId: 'setup', name: '', email: 'bad' }));
  assert.equal(r.error, 'INVALID');
  assert.deepEqual(Object.keys(r.fieldErrors).sort(), ['email', 'name']);
  assert.deepEqual(gas.lockLog, []);
  assert.deepEqual(gas.driveLog, []);
});

test('submitSignup rejects an unknown slot', () => {
  const gas = loadWithEvent();
  assert.equal(signUp(gas, 1, 'no-such-slot').error, 'NOT_FOUND');
});

test('submitSignup keeps the sign-up when the email fails', () => {
  const gas = loadWithEvent();
  gas.ctx.MailApp.failNext = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    const r = signUp(gas, 1);
    assert.equal(r.ok, true);
    assert.equal(r.emailSent, false);
  } finally {
    console.error = originalError;
  }
  assert.equal(signups(gas).length, 1);
});

test('formula-looking input is written with a text-forcing apostrophe', () => {
  const gas = loadWithEvent();
  signUp(gas, 1, 'cleanup', { name: '=HYPERLINK("http://evil","click")' });
  const sheet = gas.event.getSheetByName('Signups');
  const nameCol = sheet.rows[0].indexOf('name');
  assert.equal(sheet.rawAppends[0][nameCol], '\'=HYPERLINK("http://evil","click")');
  assert.equal(signups(gas)[0].name, '=HYPERLINK("http://evil","click")');
});

// ---------- Email ----------

test('MAIL_REDIRECT_TO sends every email to the test inbox instead', () => {
  const gas = loadWithEvent({ properties: { MAIL_REDIRECT_TO: 'tester@example.com' } });
  signUp(gas, 1);
  assert.equal(gas.sentMail[0].to, 'tester@example.com');
  assert.match(gas.sentMail[0].subject, /^\[TEST → parent1@example.com\] /);
});

test('organizer email becomes the reply-to address', () => {
  const gas = withOrganizer(loadWithEvent());
  signUp(gas, 1);
  assert.equal(gas.sentMail[0].replyTo, 'organizer@example.com');
});

test('confirmation email escapes HTML in user-supplied text', () => {
  const { ctx } = loadGas();
  const msg = ctx.renderConfirmationEmail_({
    event: { title: 'Fair', location: '' }, slot: { label: 'Setup' },
    signup: { name: '<script>alert(1)</script> X' }, when: 'Sat', orgName: 'PTO',
  });
  assert.ok(!msg.htmlBody.includes('<script>'));
  assert.ok(msg.htmlBody.includes('&lt;script&gt;'));
  assert.ok(!msg.body.includes('Where:'), 'omits empty fields');
});

test('organizers can set the confirmation subject and add a message, with placeholders', () => {
  const { ctx } = loadGas();
  const msg = ctx.renderConfirmationEmail_({
    event: {
      title: 'Book Fair', location: 'Library', organizerEmail: 'org@example.com',
      confirmationSubject: 'See you {when}, {firstName}!\n(Bcc: x@evil.example)',
      confirmationMessage: 'Hi again {firstName}: please come to the {location} for {slot}.\nParking map: https://example.com/map?a=1&b=2.\nKeep {unknown} as typed.',
    },
    slot: { label: 'Setup' }, signup: { name: 'Pat Lee' }, when: 'Sat 9 AM', orgName: 'PTO',
  });
  assert.equal(msg.subject, 'See you Sat 9 AM, Pat! (Bcc: x@evil.example)', 'one line');
  assert.match(msg.body, /Where: Library\n\nHi again Pat: please come to the Library for Setup\.\nParking map: https:\/\/example\.com\/map\?a=1&b=2\.\nKeep \{unknown\} as typed\.\n\nNeed to change something\?/);
  assert.ok(msg.htmlBody.includes('Hi again Pat: please come to the Library for Setup.<br>Parking map: ' +
    '<a href="https://example.com/map?a=1&amp;b=2">https://example.com/map?a=1&amp;b=2</a>.<br>Keep {unknown} as typed.'));
  assert.ok(msg.htmlBody.indexOf('Hi again') > msg.htmlBody.indexOf('Library</td>'), 'message comes after the details');
});

test('volunteer emails can use {email} and {phone} too; a blank phone becomes nothing', () => {
  const { ctx } = loadGas();
  const render = (phone) => ctx.renderConfirmationEmail_({
    event: { title: 'Fair', location: '', confirmationSubject: 'Reminder for {email}',
      confirmationMessage: 'We\'ll text {phone} if plans change.' },
    slot: { label: 'Setup' }, signup: { name: 'Pat Lee', email: 'pat@example.com', phone }, when: 'Sat', orgName: 'PTO',
  });
  const withPhone = render('555-0100');
  assert.equal(withPhone.subject, 'Reminder for pat@example.com');
  assert.match(withPhone.body, /We'll text 555-0100 if plans change\./);
  assert.match(render('').body, /We'll text  if plans change\./);
});

test('a custom message cannot inject HTML, and a blank one changes nothing', () => {
  const { ctx } = loadGas();
  const render = (event) => ctx.renderConfirmationEmail_({
    event: { title: 'Fair', location: '', ...event }, slot: { label: 'Setup' },
    signup: { name: '<b>Pat</b> Lee' }, when: 'Sat', orgName: 'PTO',
  });
  const evil = render({ confirmationMessage: '<img src=x onerror=alert(1)> {name} "https://x.example/"onmouseover="alert(1)' });
  assert.ok(!evil.htmlBody.includes('<img'));
  assert.ok(!evil.htmlBody.includes('<b>Pat'));
  assert.ok(!/href="[^"]*onmouseover/.test(evil.htmlBody));
  assert.deepEqual(plain(render({ confirmationSubject: '  ', confirmationMessage: '' })), plain(render({})));
  assert.equal(render({}).subject, 'You\'re signed up: Fair – Setup');
  assert.equal(render({ confirmationSubject: 'x'.repeat(500) }).subject.length, 200);
});

test('the custom email comes from the Event tab', () => {
  const gas = loadWithEvent();
  gas.event.getSheetByName('Event').appendRow(['confirmationMessage', 'Bring gloves, {firstName}!']);
  signUp(gas, 1);
  assert.match(gas.sentMail[0].body, /Bring gloves, Parent!/);
  assert.equal(gas.ctx.getPageData(gas.eventId).event.confirmationMessage, undefined, 'not on the public page');
});

test('confirmation email names the organizer only when one is configured', () => {
  const { ctx } = loadGas();
  const render = (organizerEmail) => ctx.renderConfirmationEmail_({
    event: { title: 'Fair', location: '', organizerEmail }, slot: { label: 'Setup' },
    signup: { name: 'Pat Lee' }, when: 'Sat', orgName: 'PTO',
  });

  const withOrg = render(' organizer@example.com ');
  assert.match(withOrg.body, /Email the organizer at organizer@example\.com\./);
  assert.match(withOrg.htmlBody, /<a href="mailto:organizer@example\.com">organizer@example\.com<\/a>/);

  for (const blank of ['', '   ', undefined]) {
    const msg = render(blank);
    assert.ok(!/change something|organizer|Reply/i.test(msg.body), 'no contact line in text: ' + JSON.stringify(blank));
    assert.ok(!/change something|organizer|Reply/i.test(msg.htmlBody), 'no contact line in HTML: ' + JSON.stringify(blank));
  }
});

test('a blank organizer email does not set a reply-to', () => {
  const gas = withOrganizer(loadWithEvent(), '   ');
  signUp(gas, 1);
  assert.equal(gas.sentMail[0].replyTo, undefined);
});

test('organizer gets a notification with the volunteer\'s details and the slot fill', () => {
  const gas = withOrganizer(loadWithEvent());
  const r = signUp(gas, 1, 'checkout', { phone: '555-0100', note: 'Can stay late' });
  assert.equal(r.organizerEmail, 'organizer@example.com');
  assert.equal(gas.sentMail.length, 2);

  const [toVolunteer, toOrganizer] = gas.sentMail;
  assert.equal(toVolunteer.to, 'parent1@example.com');
  assert.equal(toOrganizer.to, 'organizer@example.com');
  assert.equal(toOrganizer.replyTo, 'parent1@example.com', 'organizer can reply straight to the volunteer');
  assert.equal(toOrganizer.subject, 'New sign-up: Fall Book Fair (sample) – Checkout table (Parent 1)');
  for (const text of ['Email: parent1@example.com', 'Phone: 555-0100', 'Note: Can stay late', 'Status: 1 of 2 spots filled']) {
    assert.ok(toOrganizer.body.includes(text), 'body includes ' + text);
  }
  assert.ok(!toOrganizer.body.includes('now full'));
});

test('organizers can set their own notification subject and add a note, with placeholders', () => {
  const gas = withOrganizer(loadWithEvent());
  const sheet = gas.event.getSheetByName('Event');
  sheet.appendRow(['organizerSubject', '[Book Fair] {name} – {slot}\nBcc: x@evil.example']);
  sheet.appendRow(['organizerMessage', 'Add {firstName} ({email}, {phone}) to the group chat: https://chat.example/x?a=1&b=2']);
  signUp(gas, 1, 'cleanup', { name: 'Pat Lee', phone: '555-0100' });
  const toOrganizer = gas.sentMail[1];
  assert.equal(toOrganizer.subject, '[Book Fair] Pat Lee – Cleanup Bcc: x@evil.example', 'one line');
  assert.match(toOrganizer.body, /Status: .*\n\nAdd Pat \(parent1@example\.com, 555-0100\) to the group chat: https:\/\/chat\.example\/x\?a=1&b=2\n\nReply to this email/);
  assert.ok(toOrganizer.htmlBody.includes('<a href="https://chat.example/x?a=1&amp;b=2">'));
  assert.ok(!gas.sentMail[0].body.includes('group chat'), 'the volunteer never sees the organizer\'s note');
  assert.ok(!gas.sentMail[0].subject.includes('[Book Fair]'));
});

test('a custom organizer subject still flags waitlist entries; blank fields keep the defaults', () => {
  const gas = withOrganizer(loadWithEvent());
  gas.event.getSheetByName('Event').appendRow(['organizerSubject', '[Book Fair] {name}']);
  fillSample(gas);
  gas.sentMail.length = 0;
  joinWaitlist(gas, 1, 'cleanup', { name: 'Wendy Wait' });
  assert.equal(gas.sentMail[1].subject, 'Waitlist: [Book Fair] Wendy Wait');

  const plainGas = withOrganizer(loadWithEvent());
  signUp(plainGas, 1, 'setup', { name: 'Pat Lee' });
  assert.equal(plainGas.sentMail[1].subject, 'New sign-up: Fall Book Fair (sample) – Setup (Pat Lee)');
});

test('the organizer\'s note can\'t inject HTML, and isn\'t on the public page', () => {
  const gas = withOrganizer(loadWithEvent());
  gas.event.getSheetByName('Event').appendRow(['organizerMessage', '<script>x</script> {name}']);
  signUp(gas, 1, 'setup', { name: '<b>Pat</b> Lee' });
  assert.ok(!gas.sentMail[1].htmlBody.includes('<script>'));
  assert.ok(!gas.sentMail[1].htmlBody.includes('<b>Pat'));
  assert.equal(gas.ctx.getPageData(gas.eventId).event.organizerMessage, undefined);
});

test('organizer notification says when the slot is now full, and omits blank fields', () => {
  const gas = withOrganizer(loadWithEvent());
  signUp(gas, 1, 'checkout');
  signUp(gas, 2, 'checkout');
  const last = gas.sentMail.at(-1);
  assert.match(last.body, /Status: 2 of 2 spots filled – this slot is now full/);
  assert.ok(!/Phone:|Note:/.test(last.body));
});

test('no organizer email means no notification and nothing for the confirmation screen', () => {
  const gas = loadWithEvent();
  const r = signUp(gas, 1);
  assert.equal(gas.sentMail.length, 1);
  assert.equal(r.organizerEmail, '');
});

test('organizer notification escapes HTML from the volunteer', () => {
  const gas = withOrganizer(loadWithEvent());
  signUp(gas, 1, 'cleanup', { name: '<b>Bold</b> Parent', note: '<script>x</script>' });
  const html = gas.sentMail[1].htmlBody;
  assert.ok(!html.includes('<script>') && !html.includes('<b>Bold'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('a failed organizer notification does not affect the volunteer', () => {
  const gas = withOrganizer(loadWithEvent());
  let calls = 0;
  const realSend = gas.ctx.MailApp.sendEmail;
  gas.ctx.MailApp.sendEmail = (m) => { if (++calls === 2) throw new Error('quota'); realSend(m); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const r = signUp(gas, 1);
    assert.equal(r.ok, true);
    assert.equal(r.emailSent, true);
  } finally {
    console.error = originalError;
  }
  assert.equal(signups(gas).length, 1);
});

test('MAIL_REDIRECT_TO also catches the organizer notification', () => {
  const gas = withOrganizer(loadWithEvent({ properties: { MAIL_REDIRECT_TO: 'tester@example.com' } }));
  signUp(gas, 1);
  assert.deepEqual(gas.sentMail.map((m) => m.to), ['tester@example.com', 'tester@example.com']);
  assert.match(gas.sentMail[1].subject, /^\[TEST → organizer@example.com\] New sign-up/);
});

// ---------- Latency: data in the page, cached event views ----------

/** The JSON doGet embedded in the page, parsed. */
function embedded(gas, parameter) {
  const html = gas.ctx.doGet({ parameter }).getContent();
  const m = html.match(/<script type="application\/json" id="initial-data">([\s\S]*?)<\/script>/);
  assert.ok(m, 'initial-data script present');
  return { html, data: JSON.parse(m[1]) };
}

test('doGet embeds the event\'s page data so the browser needs no second call', () => {
  const gas = loadWithEvent();
  const { data } = embedded(gas, { event: gas.eventId });
  assert.equal(data.requestedEventId, gas.eventId);
  assert.equal(data.event.title, 'Fall Book Fair (sample)');
  assert.equal(data.event.slots.length, 3);
  assert.equal(data.orgName, 'Bishop School PTO');

  const home = embedded(gas, {}).data;
  assert.equal(home.requestedEventId, '');
  assert.equal(home.event, null);
});

test('doGet sets the title, viewport, and framing options', () => {
  const gas = loadWithEvent();
  const out = gas.ctx.doGet({ parameter: {} });
  assert.equal(out.title, 'Bishop School PTO Volunteer Sign-Up');
  assert.deepEqual(plain(out.metaTags), [['viewport', 'width=device-width, initial-scale=1']]);
  assert.equal(out.xFrameOptions, 'ALLOWALL');
});

test('embedded data cannot break out of its script element', () => {
  const gas = loadWithEvent();
  gas.event.setEventField('title', '</script><script>alert(1)</script><!--');
  const { html, data } = embedded(gas, { event: gas.eventId });
  assert.equal(data.event.title, '</script><script>alert(1)</script><!--', 'round-trips exactly');
  assert.ok(!html.includes('<script>alert(1)'), 'no live script tag in the page');

  const junk = embedded(gas, { event: '</script><img src=x onerror=alert(1)>' });
  assert.equal(junk.data.event, null);
  assert.ok(!junk.html.includes('<img src=x'));
});

test('if building the data fails, doGet embeds null so the page fetches it instead', () => {
  const gas = loadWithEvent();
  gas.ctx.ScriptApp = { getService: () => { throw new Error('boom'); } };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(embedded(gas, { event: gas.eventId }).data, null);
  } finally {
    console.error = originalError;
  }
});

test('a cached event view is served without opening the spreadsheet or calling Drive', () => {
  const gas = loadWithEvent();
  const first = plain(gas.ctx.getPageData(gas.eventId));
  assert.equal(gas.cache.get('publicEvent:' + gas.eventId).seconds, 15 * 60);

  gas.lockLog.length = 0;
  gas.driveLog.length = 0;
  const second = plain(gas.ctx.getPageData(gas.eventId));
  assert.deepEqual(second, first);
  assert.deepEqual(gas.lockLog, [], 'no spreadsheet opened or read');
  assert.deepEqual(gas.driveLog, [], 'no Drive calls');
});

test('a sign-up writes the updated view into the cache, touching only that event', () => {
  const gas = loadWithEvent();
  const other = gas.addEvent({ title: 'Field Day' }, [{ slotId: 'a', label: 'A', capacity: 2 }]);
  gas.ctx.getPageData(gas.eventId);
  const otherCached = gas.cache.get('publicEvent:' + other.getId()) || (gas.ctx.getPageData(other.getId()), gas.cache.get('publicEvent:' + other.getId()));

  assert.equal(signUp(gas, 1, 'setup').ok, true);
  assert.deepEqual(gas.cache.get('publicEvent:' + other.getId()), otherCached, 'other events untouched');

  gas.lockLog.length = 0;
  const setup = gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.slotId === 'setup');
  assert.equal(setup.filled, 1);
  assert.deepEqual(plain(setup.volunteers), ['Parent 1.']);
  assert.ok(!gas.lockLog.includes('open'), 'served from the cache the sign-up wrote');
});

test('a stale cached view can never overbook: sign-ups always check the sheet', () => {
  const gas = loadWithEvent();
  gas.ctx.getPageData(gas.eventId); // caches "cleanup: 1 spot left"
  // Someone fills the spot by editing the sheet directly; the cache still says 1 left.
  gas.event.getSheetByName('Signups').appendRow(['x', 'cleanup', 'Cleanup', 'Typed In', 't@example.com', '', '', 'confirmed', '', '']);
  assert.equal(gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.slotId === 'cleanup').remaining, 1, 'cache is stale');
  assert.equal(signUp(gas, 1, 'cleanup').error, 'SLOT_FULL');
});

test('moving an event to Past events stops sign-ups immediately, even while its view is cached', () => {
  const gas = loadWithEvent();
  gas.ctx.getPageData(gas.eventId);
  gas.moveTo(gas.eventId, PAST_FOLDER);
  assert.equal(signUp(gas, 1).error, 'CLOSED');
  assert.equal(gas.ctx.getPageData(gas.eventId).event.isOpen, false, 'the sign-up attempt refreshed the folder check');
});

test('moving an event between folders updates isOpen on cached views within a timer run', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  gas.moveTo(gas.eventId, PAST_FOLDER); // moving doesn't change a file's modifiedTime
  gas.runTimer();
  assert.equal(gas.ctx.getPageData(gas.eventId).event.isOpen, false);
  gas.moveTo(gas.eventId, EVENTS_FOLDER);
  gas.runTimer();
  assert.equal(gas.ctx.getPageData(gas.eventId).event.isOpen, true);
});

test('hidden or unknown events are never cached', () => {
  const gas = loadWithEvent();
  gas.ctx.getPageData(gas.props.TEMPLATE_ID);
  gas.ctx.getPageData('A'.repeat(44));
  assert.deepEqual([...gas.cache.keys()].filter((k) => k.startsWith('publicEvent:')), []);
});

// ---------- The refresh timer ----------

test('setup installs exactly one 1-minute refresh timer', () => {
  const gas = loadGas();
  assert.equal(gas.ctx.setup().refreshTrigger, 'every minute');
  assert.equal(gas.ctx.setup().refreshTrigger, undefined, 'not installed twice');
  assert.deepEqual(plain(gas.triggers.map((t) => [t.handler, t.minutes])), [['refreshEventCaches', 1]]);
});

test('the timer caches every open and past event (not subfolders), so first visits are fast', () => {
  const gas = loadWithEvent();
  const past = gas.addEvent({ title: 'Old Fair' }, [{ slotId: 'a', label: 'A', capacity: 1 }], PAST_FOLDER);
  const nested = gas.addEvent({ title: 'Nested' }, [], 'subFolder');
  const outside = gas.addEvent({ title: 'Elsewhere' }, [], 'otherFolder');

  const stats = plain(gas.runTimer());
  assert.deepEqual(stats, { events: 2, reused: 0, rebuilt: 2, hidden: 0, failed: 0, skippedForTime: 0, listed: 1 }, 'sample + past; not the template; only the open one listed');
  assert.ok(gas.cache.has('publicEvent:' + gas.eventId));
  assert.ok(gas.cache.has('publicEvent:' + past.getId()));
  for (const id of [gas.props.TEMPLATE_ID, nested.getId(), outside.getId()]) {
    assert.ok(!gas.cache.has('publicEvent:' + id), id);
  }

  gas.lockLog.length = 0;
  gas.driveLog.length = 0;
  assert.equal(gas.ctx.getPageData(gas.eventId).event.title, 'Fall Book Fair (sample)');
  assert.equal(gas.ctx.getPageData(past.getId()).event.isOpen, false);
  assert.deepEqual(gas.lockLog, [], 'a first visit after the timer ran opens no spreadsheet');
  assert.deepEqual(gas.driveLog, [], '...and makes no Drive call');
});

test('the timer reopens only spreadsheets that changed, and extends the rest', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  gas.cache.get('publicEvent:' + gas.eventId).seconds = 1; // nearly expired

  gas.lockLog.length = 0;
  const idle = plain(gas.runTimer());
  assert.equal(idle.rebuilt, 0);
  assert.equal(idle.reused, 1);
  assert.ok(!gas.lockLog.includes('open'), 'no spreadsheet opened when nothing changed');
  assert.equal(gas.cache.get('publicEvent:' + gas.eventId).seconds, 15 * 60, 'expiry extended');
});

test('an organizer\'s edit in the spreadsheet shows up after the next timer run', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  gas.event.setEventField('title', 'Spring Book Fair');
  assert.equal(gas.ctx.getPageData(gas.eventId).event.title, 'Fall Book Fair (sample)', 'still cached');
  assert.equal(plain(gas.runTimer()).rebuilt, 1);
  assert.equal(gas.ctx.getPageData(gas.eventId).event.title, 'Spring Book Fair');
});

test('removing the Event tab hides an event on the next timer run', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  gas.event.getSheetByName('Event').setName('Renamed');
  gas.event.getSheetByName('Slots').touch();
  assert.equal(plain(gas.runTimer()).hidden, 1);
  assert.equal(gas.ctx.getPageData(gas.eventId).event, null);
});

test('moving a spreadsheet out of Events (or into a subfolder) unpublishes it even while its view is cached', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  gas.moveTo(gas.eventId, 'subFolder');
  gas.runTimer(); // no longer listed, so its folder check isn't renewed
  gas.cache.delete('eventFolder:' + gas.eventId); // the 5-minute folder check expires
  assert.ok(gas.cache.has('publicEvent:' + gas.eventId), 'view is still cached');
  assert.equal(gas.ctx.getPageData(gas.eventId).event, null);
  assert.equal(signUp(gas, 1).error, 'NOT_FOUND');
});

test('a sign-up makes the next timer run rebuild that event once', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  signUp(gas, 1);
  assert.equal(plain(gas.runTimer()).rebuilt, 1);
  assert.equal(plain(gas.runTimer()).rebuilt, 0);
});

test('the timer stops opening spreadsheets when its time budget is used up', () => {
  const gas = loadWithEvent();
  require('node:vm').runInContext('REFRESH_BUDGET_MS = -1', gas.ctx);
  const stats = plain(gas.runTimer());
  assert.equal(stats.skippedForTime, stats.events);
  assert.equal(stats.rebuilt, 0);
});

test('one broken event spreadsheet does not stop the timer refreshing the others', () => {
  const gas = loadWithEvent();
  const broken = gas.addEvent({ title: 'Broken' }, []);
  broken.getSheetByName('Slots').setName('Renamed');
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const stats = plain(gas.runTimer());
    assert.equal(stats.failed, 1);
    assert.equal(stats.rebuilt, 1);
  } finally {
    console.warn = originalWarn;
  }
});

// ---------- Custom questions ----------

/** Replaces the sample event's questions (rows of [question, type, options, required]). */
function setQuestions(gas, rows) {
  const sheet = gas.event.getSheetByName('Questions');
  sheet.rows = [['question', 'type', 'options', 'required'], ...rows];
  sheet.touch();
  gas.cache.clear();
}

test('the sign-up page gets the event\'s questions', () => {
  const gas = loadWithEvent();
  setQuestions(gas, [['Dietary needs', 'paragraph', '', ''], ['Background check done?', 'checkbox', '', 'yes']]);
  assert.deepEqual(plain(gas.ctx.getPageData(gas.eventId).event.questions), [
    { label: 'Dietary needs', type: 'paragraph', options: [], required: false },
    { label: 'Background check done?', type: 'checkbox', options: [], required: true },
  ]);
});

test('answers are saved in their own Signups columns, added when first needed', () => {
  const gas = withOrganizer(loadWithEvent());
  setQuestions(gas, [['T-shirt size', 'choice', 'S, M, L', 'yes'], ['Background check done?', 'checkbox', '', 'yes'], ['Note', 'text', '', '']]);
  const r = signUp(gas, 1, 'setup', { answers: { 'T-shirt size': 'M', 'Background check done?': true, Note: 'ok' } });
  assert.equal(r.ok, true);
  const headers = gas.event.getSheetByName('Signups').rows[0];
  assert.deepEqual(headers.slice(-3), ['T-shirt size', 'Background check done?', 'Note (answer)'], 'a clash with a built-in column gets "(answer)"');
  const row = signups(gas)[0];
  assert.deepEqual([row['T-shirt size'], row['Background check done?'], row['Note (answer)']], ['M', 'Yes', 'ok']);

  signUp(gas, 2, 'setup', { answers: { 'T-shirt size': 'L', 'Background check done?': 'yes' } });
  assert.equal(gas.event.getSheetByName('Signups').rows[0].length, headers.length, 'columns added only once');
  assert.match(gas.sentMail[1].body, /T-shirt size: M\nBackground check done\?: Yes\nNote \(answer\)|T-shirt size: M/);
  assert.ok(!gas.sentMail[0].body.includes('T-shirt'), 'the volunteer\'s own email doesn\'t repeat answers');
});

test('missing or bad answers come back as field errors, and nothing is saved', () => {
  const gas = loadWithEvent();
  setQuestions(gas, [['T-shirt size', 'choice', 'S, M, L', 'yes'], ['Agree to rules', 'checkbox', '', 'yes'], ['Comments', 'text', '', '']]);
  const r = plain(signUp(gas, 1, 'setup', { answers: { 'T-shirt size': 'XXL', Comments: 'x'.repeat(201) } }));
  assert.equal(r.error, 'INVALID');
  assert.deepEqual(Object.keys(r.fieldErrors).sort(), ['answer:Agree to rules', 'answer:Comments', 'answer:T-shirt size']);
  assert.equal(signups(gas).length, 0);
});

test('answer errors are reported together with the basic fields', () => {
  const gas = loadWithEvent();
  setQuestions(gas, [['Agree to rules', 'checkbox', '', 'yes']]);
  gas.ctx.getPageData(gas.eventId); // the page has been viewed, so its questions are cached
  const r = plain(signUp(gas, 1, 'setup', { name: '', answers: {} }));
  assert.deepEqual(Object.keys(r.fieldErrors).sort(), ['answer:Agree to rules', 'name']);
});

test('events without a Questions tab work as before', () => {
  const gas = loadWithEvent();
  gas.event.deleteSheet(gas.event.getSheetByName('Questions'));
  gas.cache.clear();
  assert.deepEqual(plain(gas.ctx.getPageData(gas.eventId).event.questions), []);
  assert.equal(signUp(gas, 1).ok, true);
  assert.equal(gas.event.getSheetByName('Signups').rows[0].length, 10, 'no answer columns');
});

test('answers that look like formulas are stored as text', () => {
  const gas = loadWithEvent();
  setQuestions(gas, [['Comments', 'text', '', '']]);
  signUp(gas, 1, 'setup', { answers: { Comments: '=IMPORTRANGE("x")' } });
  const sheet = gas.event.getSheetByName('Signups');
  assert.equal(sheet.rawAppends[0][sheet.rows[0].indexOf('Comments')], '\'=IMPORTRANGE("x")');
});

// ---------- Cancel link ----------

const cancelLinkIn = (mail) => (/Can't make it\?.*?(https?:\/\/\S+)/s.exec(mail.body) || [])[1];
const tokenOf = (url) => new URL(url).searchParams.get('cancel');

test('the confirmation email has a cancel link with that sign-up\'s token, on the page they used', () => {
  const gas = loadWithEvent();
  signUp(gas, 1, 'setup');
  const url = cancelLinkIn(gas.sentMail[0]);
  const row = signups(gas)[0];
  assert.equal(url, 'https://signups.bishopschoolpto.com/?event=' + gas.eventId + '&cancel=' + row.cancelToken);
  assert.ok(gas.sentMail[0].htmlBody.includes('>Cancel your sign-up</a>'));

  signUp(gas, 2, 'setup', { baseUrl: 'https://script.google.com/macros/s/TEST/exec' });
  assert.match(cancelLinkIn(gas.sentMail[1]), /^https:\/\/script\.google\.com\/macros\/s\/TEST\/exec\?event=/);
  signUp(gas, 3, 'setup', { baseUrl: 'https://evil.example/' });
  assert.match(cancelLinkIn(gas.sentMail[2]), /^https:\/\/signups\.bishopschoolpto\.com\//, 'other pages are ignored');
});

test('opening a cancel link only shows the sign-up; cancelling takes a second step', () => {
  const gas = loadWithEvent();
  signUp(gas, 1, 'checkout', { name: 'Pat Lee' });
  const token = tokenOf(cancelLinkIn(gas.sentMail[0]));
  const shown = plain(gas.ctx.getCancellation({ eventId: gas.eventId, token }));
  assert.equal(shown.ok, true);
  assert.deepEqual([shown.eventTitle, shown.slotLabel, shown.location, shown.firstName, shown.status],
    ['Fall Book Fair (sample)', 'Checkout table', 'School Library', 'Pat', 'confirmed']);
  assert.match(shown.when, /9:00 AM – 11:00 AM/);
  assert.equal(signups(gas)[0].status, 'confirmed', 'looking changes nothing');
});

test('cancelling frees the spot, updates the page at once, and emails the volunteer and organizer', () => {
  const gas = withOrganizer(loadWithEvent());
  signUp(gas, 1, 'cleanup', { name: 'Pat Lee' }); // cleanup has 1 spot
  const token = tokenOf(cancelLinkIn(gas.sentMail[0]));
  assert.equal(gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.slotId === 'cleanup').remaining, 0);
  gas.sentMail.length = 0;

  const r = plain(gas.ctx.cancelSignup({ eventId: gas.eventId, token }));
  assert.equal(r.ok, true);
  assert.equal(signups(gas)[0].status, 'cancelled');
  assert.equal(gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.slotId === 'cleanup').remaining, 1, 'spot freed, cache updated');
  assert.equal(signUp(gas, 2, 'cleanup').ok, true, 'someone else can take it');

  const [toVolunteer, toOrganizer] = gas.sentMail;
  assert.equal(toVolunteer.to, 'parent1@example.com');
  assert.equal(toVolunteer.subject, 'Cancelled: Fall Book Fair (sample) – Cleanup');
  assert.match(toVolunteer.body, /We've cancelled your sign-up for:/);
  assert.equal(toOrganizer.to, 'organizer@example.com');
  assert.equal(toOrganizer.subject, 'Cancellation: Fall Book Fair (sample) – Cleanup (Pat Lee)');
  assert.match(toOrganizer.body, /A spot opened: 0 of 1 spots are filled now\./);
  assert.equal(toOrganizer.replyTo, 'parent1@example.com');
});

test('cancelling twice says it was already cancelled, and sends nothing more', () => {
  const gas = loadWithEvent();
  signUp(gas, 1);
  const token = tokenOf(cancelLinkIn(gas.sentMail[0]));
  gas.ctx.cancelSignup({ eventId: gas.eventId, token });
  const mailCount = gas.sentMail.length;
  const again = plain(gas.ctx.cancelSignup({ eventId: gas.eventId, token }));
  assert.equal(again.error, 'ALREADY_CANCELLED');
  assert.equal(plain(gas.ctx.getCancellation({ eventId: gas.eventId, token })).status, 'cancelled');
  assert.equal(gas.sentMail.length, mailCount);
});

test('when a confirmed volunteer cancels, the earliest waitlisted person gets the spot automatically', () => {
  const gas = withOrganizer(loadWithEvent());
  gas.event.getSheetByName('Event').appendRow(['confirmationMessage', 'Check in at the front desk.']);
  fillSample(gas);
  joinWaitlist(gas, 1, 'cleanup', { name: 'Wendy Wait' });
  joinWaitlist(gas, 2, 'cleanup', { name: 'Second Wait' });
  joinWaitlist(gas, 3, 'setup', { name: 'Other Slot' });
  const leaving = signups(gas).find((s) => s.slotId === 'cleanup' && s.status === 'confirmed');
  gas.sentMail.length = 0;

  assert.equal(gas.ctx.cancelSignup({ eventId: gas.eventId, token: leaving.cancelToken }).ok, true);
  const byEmail = Object.fromEntries(signups(gas).map((s) => [s.email + ':' + s.slotId, s.status]));
  assert.equal(byEmail[leaving.email + ':cleanup'], 'cancelled');
  assert.equal(byEmail['parent1@example.com:cleanup'], 'confirmed', 'first in line moves up');
  assert.equal(byEmail['parent2@example.com:cleanup'], 'waitlisted', 'second stays waiting');
  assert.equal(byEmail['parent3@example.com:setup'], 'waitlisted', 'other slots untouched');

  const cleanup = gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.slotId === 'cleanup');
  assert.deepEqual([cleanup.filled, cleanup.remaining, cleanup.waitlisted], [1, 0, 1], 'the spot never sits open');
  assert.equal(gas.ctx.getPageData(gas.eventId).event.waitlistOpen, true, 'still full, so the waitlist stays open');
  assert.equal(signUp(gas, 9, 'cleanup').error, 'SLOT_FULL', 'nobody can grab it in between');

  const [toCanceller, toPromoted, toOrganizer] = gas.sentMail;
  assert.equal(toCanceller.to, leaving.email);
  assert.equal(toPromoted.to, 'parent1@example.com');
  assert.equal(toPromoted.subject, 'A spot opened up – you\'re in: Fall Book Fair (sample) – Cleanup');
  assert.match(toPromoted.body, /Good news! A spot opened up, so you're off the waitlist and confirmed for:/);
  assert.match(toPromoted.body, /Check in at the front desk\./, 'includes the organizer\'s message');
  assert.match(toPromoted.body, /Can't make it\?.*cancel=/s, 'with their own cancel link');
  assert.equal(toPromoted.replyTo, 'organizer@example.com');
  assert.match(toOrganizer.subject, /^Cancellation: .* → Wendy Wait moved up$/);
  assert.match(toOrganizer.body, /Wendy Wait \(parent1@example\.com\) was next on the waitlist, so they now have the spot\. We emailed them\./);
  assert.match(toOrganizer.body, /1 of 1 spots are filled now, and 1 still on the waitlist\./);
});

test('the promoted volunteer\'s own cancel link works, and promotes the next person', () => {
  const gas = loadWithEvent();
  fillSample(gas);
  joinWaitlist(gas, 1, 'cleanup');
  joinWaitlist(gas, 2, 'cleanup');
  const first = signups(gas).find((s) => s.slotId === 'cleanup' && s.status === 'confirmed');
  gas.sentMail.length = 0;
  gas.ctx.cancelSignup({ eventId: gas.eventId, token: first.cancelToken });
  const promotedLink = /Can't make it\?.*?(https?:\/\/\S+)/s.exec(gas.sentMail[1].body)[1];
  gas.ctx.cancelSignup({ eventId: gas.eventId, token: new URL(promotedLink).searchParams.get('cancel') });
  const statuses = signups(gas).filter((s) => s.slotId === 'cleanup').map((s) => s.status);
  assert.deepEqual(plain(statuses), ['cancelled', 'cancelled', 'confirmed']);
});

test('no waitlist, or a waitlisted person leaving: nobody is promoted', () => {
  const gas = withOrganizer(loadWithEvent());
  signUp(gas, 1, 'cleanup');
  gas.sentMail.length = 0;
  gas.ctx.cancelSignup({ eventId: gas.eventId, token: signups(gas)[0].cancelToken });
  assert.equal(gas.sentMail.length, 2, 'volunteer + organizer only');
  assert.match(gas.sentMail[1].body, /A spot opened: 0 of 1 spots are filled now\./);

  const g2 = loadWithEvent();
  fillSample(g2);
  joinWaitlist(g2, 1, 'cleanup');
  joinWaitlist(g2, 2, 'cleanup');
  const leaving = signups(g2).find((s) => s.email === 'parent1@example.com');
  g2.ctx.cancelSignup({ eventId: g2.eventId, token: leaving.cancelToken });
  assert.equal(signups(g2).find((s) => s.email === 'parent2@example.com').status, 'waitlisted', 'still waiting: no spot opened');
});

test('if the promotion email fails, the promotion still stands', () => {
  const gas = loadWithEvent();
  fillSample(gas);
  joinWaitlist(gas, 1, 'cleanup');
  const leaving = signups(gas).find((s) => s.slotId === 'cleanup' && s.status === 'confirmed');
  const send = gas.ctx.MailApp.sendEmail;
  gas.ctx.MailApp.sendEmail = (m) => { if (m.to === 'parent1@example.com') throw new Error('quota'); return send(m); };
  quietly(() => gas.ctx.cancelSignup({ eventId: gas.eventId, token: leaving.cancelToken }));
  assert.equal(signups(gas).find((s) => s.email === 'parent1@example.com').status, 'confirmed');
});

test('a waitlisted volunteer can leave the waitlist with their link', () => {
  const gas = withOrganizer(loadWithEvent());
  fillSample(gas);
  gas.sentMail.length = 0;
  joinWaitlist(gas, 1, 'cleanup', { name: 'Wendy Wait' });
  assert.ok(cancelLinkIn(gas.sentMail[0]), 'waitlist emails have the link too');
  gas.sentMail.length = 0;
  const token = signups(gas).find((s) => s.status === 'waitlisted').cancelToken;
  gas.ctx.cancelSignup({ eventId: gas.eventId, token });
  assert.match(gas.sentMail[0].body, /We've cancelled your waitlist entry for:/);
  assert.match(gas.sentMail[1].subject, /^Left the waitlist: /);
  assert.ok(!gas.sentMail[1].body.includes('A spot opened'));
});

test('volunteers can still cancel after the event moves to Past events', () => {
  const gas = loadWithEvent();
  signUp(gas, 1);
  const token = signups(gas)[0].cancelToken;
  gas.moveTo(gas.eventId, PAST_FOLDER);
  assert.equal(gas.ctx.cancelSignup({ eventId: gas.eventId, token }).ok, true);
});

test('cancelling waits its turn for the lock, and always releases it', () => {
  const gas = loadWithEvent({ lockAvailable: false });
  assert.equal(gas.ctx.cancelSignup({ eventId: gas.eventId, token: '00000000-0000-0000-0000-000000000000' }).error, 'BUSY');
  const ok = loadWithEvent();
  signUp(ok, 1);
  ok.lockLog.length = 0;
  ok.ctx.cancelSignup({ eventId: ok.eventId, token: signups(ok)[0].cancelToken });
  ok.ctx.cancelSignup({ eventId: ok.eventId, token: 'nope' });
  assert.deepEqual(ok.lockLog.filter((l) => l === 'lock' || l === 'unlock'), ['lock', 'unlock', 'lock', 'unlock']);
});

test('the cancel page API works over GET and POST for the static site', () => {
  const gas = loadWithEvent();
  signUp(gas, 1);
  const token = signups(gas)[0].cancelToken;
  assert.equal(apiGet(gas, { api: 'cancellation', event: gas.eventId, cancel: token }).status, 'confirmed');
  assert.equal(apiPost(gas, JSON.stringify({ api: 'cancel', input: { eventId: gas.eventId, token } })).ok, true);
  assert.equal(signups(gas)[0].status, 'cancelled');
});

// ---------- Waitlist ----------

const fillSample = (gas) => {
  // Setup 3, checkout 2, cleanup 1 spot(s).
  let n = 100;
  for (const [slotId, cap] of [['setup', 3], ['checkout', 2], ['cleanup', 1]]) {
    for (let i = 0; i < cap; i++) assert.equal(signUp(gas, n++, slotId).ok, true);
  }
};
const joinWaitlist = (gas, n, slotId = 'cleanup', extra = {}) => signUp(gas, n, slotId, { waitlist: true, ...extra });

test('when every slot is full, people can join a slot\'s waitlist', () => {
  const gas = withOrganizer(loadWithEvent());
  fillSample(gas);
  gas.sentMail.length = 0;
  assert.equal(gas.ctx.getPageData(gas.eventId).event.waitlistOpen, true);

  const r = plain(joinWaitlist(gas, 1, 'checkout', { name: 'Wendy Wait' }));
  assert.equal(r.ok, true);
  assert.equal(r.waitlisted, true);
  assert.equal(r.waitlistPosition, 1);
  assert.equal(plain(joinWaitlist(gas, 2, 'checkout')).waitlistPosition, 2);

  const rows = signups(gas).filter((s) => s.status === 'waitlisted');
  assert.deepEqual(plain(rows.map((s) => [s.slotId, s.email])), [['checkout', 'parent1@example.com'], ['checkout', 'parent2@example.com']]);
  const checkout = gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.slotId === 'checkout');
  assert.deepEqual([checkout.filled, checkout.remaining, checkout.waitlisted], [2, 0, 2], 'the waitlist doesn\'t take spots');
  assert.ok(!plain(checkout.volunteers).includes('Wendy W.'));

  const [toVolunteer, toOrganizer] = gas.sentMail;
  assert.match(toVolunteer.subject, /^You're on the waitlist: Fall Book Fair \(sample\) – Checkout table$/);
  assert.match(toVolunteer.body, /#1 on the waitlist for:/);
  assert.match(toVolunteer.body, /You're not confirmed yet\. If a spot opens up, you'll get an email\./);
  assert.match(toOrganizer.subject, /^Waitlist: .* \(Wendy Wait\)$/);
  assert.match(toOrganizer.body, /Wendy Wait joined the waitlist\./);
  assert.match(toOrganizer.body, /Full \(2 of 2\) – #1 on the waitlist/);
  assert.match(toOrganizer.body, /change their status in the Signups tab to "confirmed"/);
});

test('the waitlist is refused while any spot is open, and points to the open spot', () => {
  const gas = loadWithEvent();
  assert.equal(gas.ctx.getPageData(gas.eventId).event.waitlistOpen, false);
  const r = joinWaitlist(gas, 1, 'cleanup');
  assert.equal(r.error, 'SPOTS_OPEN');
  assert.equal(signups(gas).length, 0);
});

test('a waitlist email leaves out the organizer\'s custom subject and message', () => {
  const gas = loadWithEvent();
  gas.event.getSheetByName('Event').appendRow(['confirmationSubject', 'See you there!']);
  gas.event.getSheetByName('Event').appendRow(['confirmationMessage', 'Park in the back.']);
  fillSample(gas);
  gas.sentMail.length = 0;
  joinWaitlist(gas, 1);
  assert.match(gas.sentMail[0].subject, /^You're on the waitlist/);
  assert.ok(!gas.sentMail[0].body.includes('Park in the back'));
});

test('an organizer confirming a waitlisted person (status → confirmed) gives them the spot', () => {
  const gas = loadWithEvent();
  fillSample(gas);
  joinWaitlist(gas, 1, 'cleanup');
  const sheet = gas.event.getSheetByName('Signups');
  const statusCol = sheet.rows[0].indexOf('status');
  const emailCol = sheet.rows[0].indexOf('email');
  sheet.rows.find((r) => r[emailCol] === 'parent100@example.com')[statusCol] = 'cancelled'; // someone drops out
  sheet.rows.find((r) => r[emailCol] === 'parent1@example.com')[statusCol] = 'confirmed';
  gas.cache.clear();
  const setup = gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.slotId === 'setup');
  const cleanup = gas.ctx.getPageData(gas.eventId).event.slots.find((s) => s.slotId === 'cleanup');
  assert.deepEqual([setup.remaining, cleanup.filled, cleanup.waitlisted], [1, 2, 0]);
  assert.equal(gas.ctx.getPageData(gas.eventId).event.waitlistOpen, false, 'a spot opened, so the waitlist closes');
});

test('events in Past events have no waitlist', () => {
  const gas = loadWithEvent();
  fillSample(gas);
  gas.moveTo(gas.eventId, PAST_FOLDER);
  gas.runTimer(); // the page's folder check updates within a minute
  assert.equal(gas.ctx.getPageData(gas.eventId).event.waitlistOpen, false);
  assert.equal(joinWaitlist(gas, 1).error, 'CLOSED');
});

// ---------- The home page's list of open events ----------

test('open events with spots left or a waitlist are listed, soonest first; past, nested, and template are not', () => {
  const gas = loadWithEvent();
  const soon = gas.addEvent({ title: 'Bake Sale', location: 'Gym' },
    [{ slotId: 'a', label: 'A', start: new Date('2026-10-05T14:00:00Z'), end: new Date('2026-10-05T15:00:00Z'), capacity: 2 },
      { slotId: 'b', label: 'B', start: new Date('2026-10-06T14:00:00Z'), end: new Date('2026-10-06T15:00:00Z'), capacity: 1 }]);
  const noDates = gas.addEvent({ title: 'Anytime Helpers' }, [{ slotId: 'a', label: 'A', capacity: 4 }]);
  const full = gas.addEvent({ title: 'Full One' }, [{ slotId: 'a', label: 'A', capacity: 1 }]);
  signUp(gas, 1, 'a', {}, full.getId());
  const past = gas.addEvent({ title: 'Old One' }, [{ slotId: 'a', label: 'A', capacity: 1 }], PAST_FOLDER);
  const nested = gas.addEvent({ title: 'Nested One' }, [{ slotId: 'a', label: 'A', capacity: 1 }], 'subFolder');
  const empty = gas.addEvent({ title: 'No Slots' }, []);

  const events = plain(gas.ctx.getOpenEvents()).events;
  assert.deepEqual(events.map((e) => e.title), ['Bake Sale', 'Fall Book Fair (sample)', 'Anytime Helpers', 'Full One']);
  assert.deepEqual(events[0], { eventId: soon.getId(), title: 'Bake Sale', location: 'Gym',
    dates: 'Mon, Oct 5, 2026 – Tue, Oct 6, 2026', spotsLeft: 3, waitlistOpen: false });
  assert.deepEqual([events[3].spotsLeft, events[3].waitlistOpen], [0, true], 'a full event is listed for its waitlist');
  assert.match(events[1].dates, /^\w{3}, \w{3} \d+, \d{4}$/, 'one-day event: one date');
  assert.equal(events[1].spotsLeft, 6);
  assert.equal(events[2].dates, '', 'no dates');
  for (const ss of [past, nested, empty]) assert.ok(!events.some((e) => e.eventId === ss.getId()), ss.name);
  assert.ok(!events.some((e) => e.eventId === gas.props.TEMPLATE_ID));
  assert.ok(noDates);
});

test('the list comes from the cache the timer keeps, without Drive or spreadsheets', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  gas.lockLog.length = 0;
  gas.driveLog.length = 0;
  assert.equal(plain(gas.ctx.getOpenEvents()).events.length, 1);
  assert.deepEqual(gas.driveLog, []);
  assert.deepEqual(gas.lockLog, []);
});

test('if the cached list has expired, a request rebuilds it once', () => {
  const gas = loadWithEvent();
  assert.equal(gas.cache.get('openEvents'), undefined);
  const first = plain(gas.ctx.getOpenEvents());
  assert.equal(first.events.length, 1);
  assert.equal(gas.cache.get('openEvents').seconds, 15 * 60);
  gas.driveLog.length = 0;
  assert.deepEqual(plain(gas.ctx.getOpenEvents()), first);
  assert.deepEqual(gas.driveLog, [], 'second request served from the cache');
});

test('moving an event to Past events drops it from the list on the next timer run', () => {
  const gas = loadWithEvent();
  gas.runTimer();
  gas.moveTo(gas.eventId, PAST_FOLDER);
  gas.runTimer();
  assert.deepEqual(plain(gas.ctx.getOpenEvents()).events, []);
});

test('GET ?api=events returns the same list', () => {
  const gas = loadWithEvent();
  assert.deepEqual(apiGetEvents(gas), plain(gas.ctx.getOpenEvents()));
});

// ---------- JSON API for the static site ----------

const apiGet = (gas, parameter) => {
  const out = gas.ctx.doGet({ parameter });
  assert.equal(out.mimeType, 'application/json');
  return JSON.parse(out.getContent());
};
const apiGetEvents = (gas) => apiGet(gas, { api: 'events' });
const apiPost = (gas, contents) => {
  const out = gas.ctx.doPost({ postData: { contents, type: 'text/plain' } });
  assert.equal(out.mimeType, 'application/json');
  return JSON.parse(out.getContent());
};

test('GET ?api=page returns the same data as getPageData', () => {
  const gas = loadWithEvent();
  assert.deepEqual(apiGet(gas, { api: 'page', event: gas.eventId }), plain(gas.ctx.getPageData(gas.eventId)));
  assert.equal(apiGet(gas, { api: 'page', event: 'nope' }).event, null);
  assert.equal(apiGet(gas, { api: 'page' }).event, null);
});

test('POST {api: signup} signs up exactly like submitSignup', () => {
  const gas = loadWithEvent();
  const input = { eventId: gas.eventId, slotId: 'cleanup', name: 'Pat Lee', email: 'pat@example.com' };
  const r = apiPost(gas, JSON.stringify({ api: 'signup', input }));
  assert.equal(r.ok, true);
  assert.equal(r.slotLabel, 'Cleanup');
  assert.equal(r.cancelToken, undefined);
  assert.equal(apiPost(gas, JSON.stringify({ api: 'signup', input: { ...input, email: 'other@example.com' } })).error, 'SLOT_FULL');
  assert.equal(signups(gas).length, 1);
});

test('POST rejects bad bodies with JSON errors', () => {
  const gas = loadWithEvent();
  assert.equal(apiPost(gas, 'not json').error, 'INVALID');
  assert.equal(apiPost(gas, '').error, 'INVALID');
  assert.equal(apiPost(gas, JSON.stringify({ api: 'setup' })).error, 'UNKNOWN_API');
  assert.equal(apiPost(gas, 'null').error, 'UNKNOWN_API');
  assert.equal(apiPost(gas, JSON.stringify({ api: 'signup' })).error, 'INVALID', 'missing input');
  assert.equal(gas.ctx.doPost(undefined).mimeType, 'application/json');
});

test('unexpected server errors come back as JSON, without details', () => {
  const gas = loadWithEvent();
  gas.event.getSheetByName('Signups').appendRow = () => { throw new Error('Sheets is down: secret detail'); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const r = apiPost(gas, JSON.stringify({ api: 'signup', input: { eventId: gas.eventId, slotId: 'setup', name: 'A B', email: 'a@b.co' } }));
    assert.deepEqual(r, { serverError: true });
  } finally {
    console.error = originalError;
  }
});

test('POST {api: shortLink} returns the same as getShortLink', () => {
  const gas = loadWithEvent();
  const r = apiPost(gas, JSON.stringify({ api: 'shortLink', input: { eventId: gas.eventId } }));
  assert.deepEqual(r, { ok: true, shortUrl: 'https://tinyurl.com/fake1', longUrl: 'https://signups.bishopschoolpto.com/?event=' + gas.eventId, savedToSheet: true });
  assert.equal(apiPost(gas, JSON.stringify({ api: 'shortLink', input: { eventId: 'nope' } })).error, 'NOT_FOUND');
});

// ---------- Short links (TinyURL) ----------

/** Runs fn with console.error silenced; returns what it would have logged. */
function quietly(fn) {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try { fn(); } finally { console.error = originalError; }
  return logged;
}

test('a short link points to the static site; every request makes a new one, and nothing goes in Script Properties', () => {
  const gas = loadWithEvent();
  const longUrl = 'https://signups.bishopschoolpto.com/?event=' + gas.eventId;
  const propsBefore = { ...gas.props };
  const first = plain(gas.ctx.getShortLink({ eventId: gas.eventId, baseUrl: 'http://localhost:8080/' }));
  assert.deepEqual(first, { ok: true, shortUrl: 'https://tinyurl.com/fake1', longUrl, savedToSheet: true });
  assert.deepEqual(gas.fetchLog, ['https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl)]);
  assert.equal(plain(gas.ctx.getShortLink({ eventId: gas.eventId })).shortUrl, 'https://tinyurl.com/fake2', 'a new link, not a remembered one');
  assert.deepEqual(gas.props, propsBefore, 'Script Properties untouched');
});

test('on the Apps Script page, the short link points to the Apps Script page', () => {
  const gas = loadWithEvent();
  const r = gas.ctx.getShortLink({ eventId: gas.eventId, baseUrl: 'https://script.google.com/macros/s/TEST/exec' });
  assert.equal(r.longUrl, 'https://script.google.com/macros/s/TEST/exec?event=' + gas.eventId);
});

test('SITE_URL script property changes where short links point', () => {
  const gas = loadWithEvent({ properties: { SITE_URL: 'https://signup.example.org/' } });
  assert.equal(gas.ctx.getShortLink({ eventId: gas.eventId }).longUrl, 'https://signup.example.org/?event=' + gas.eventId);
});

test('past events can get a short link', () => {
  const gas = loadWithEvent();
  gas.moveTo(gas.eventId, PAST_FOLDER);
  assert.equal(gas.ctx.getShortLink({ eventId: gas.eventId }).ok, true);
});

test('if TinyURL fails or answers oddly, nothing is saved and the next try asks again', () => {
  const gas = loadWithEvent();
  const replies = [
    { code: 500, text: 'Error' },
    { code: 200, text: '<html>not a link</html>' },
    { code: 200, text: 'https://evil.example/x' },
    { throws: 'Address unavailable' },
  ];
  for (const reply of replies) {
    gas.ctx.UrlFetchApp.nextReply = reply;
    let r;
    const logged = quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId })); });
    assert.equal(r.error, 'SHORTENER_FAILED', JSON.stringify(reply));
    assert.match(r.message, /couldn't make a short link/);
    assert.equal(logged.length, 1, 'logged for the Executions page');
  }
  assert.equal(Object.keys(gas.props).filter((k) => k.startsWith('shortLink:')).length, 0);
  assert.equal(gas.ctx.getShortLink({ eventId: gas.eventId }).ok, true);
  assert.equal(gas.fetchLog.length, replies.length + 1);
});

test('with TINYURL_API_TOKEN, short links come from TinyURL\'s current API', () => {
  const gas = loadWithEvent({ properties: { TINYURL_API_TOKEN: 'tok123' } });
  const r = plain(gas.ctx.getShortLink({ eventId: gas.eventId }));
  assert.equal(r.shortUrl, 'https://tinyurl.com/fake1');
  const [req] = gas.fetchRequests;
  assert.equal(req.url, 'https://api.tinyurl.com/create');
  assert.equal(req.options.method, 'post');
  assert.equal(req.options.headers.Authorization, 'Bearer tok123');
  assert.deepEqual(JSON.parse(req.options.payload), { url: 'https://signups.bishopschoolpto.com/?event=' + gas.eventId, domain: 'tinyurl.com' });
  assert.ok(!gas.fetchLog.some((u) => u.includes('api-create.php')), 'never the deprecated endpoint');
});

test('TinyURL API errors (bad token, bad JSON, odd links) fail cleanly and save nothing', () => {
  const gas = loadWithEvent({ properties: { TINYURL_API_TOKEN: 'tok123' } });
  const replies = [
    { code: 401, text: '{"data":[],"code":1,"errors":["Unauthenticated."]}' },
    { code: 200, text: 'not json' },
    { code: 200, text: '{"data":{"tiny_url":"https://evil.example/x"},"code":0,"errors":[]}' },
    { code: 422, text: '{"data":[],"code":5,"errors":["The url is invalid."]}' },
  ];
  for (const reply of replies) {
    gas.ctx.UrlFetchApp.nextReply = reply;
    let r;
    const logged = quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId })); });
    assert.equal(r.error, 'SHORTENER_FAILED', reply.text);
    assert.equal(logged.length, 1);
  }
  assert.equal(Object.keys(gas.props).filter((k) => k.startsWith('shortLink:')).length, 0);
});

// ---------- Custom short link text (alias) ----------

const withToken = () => loadWithEvent({ properties: { TINYURL_API_TOKEN: 'tok123' } });

test('organizers can choose the short link text', () => {
  const gas = withToken();
  const r = plain(gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'bishop-book-fair' }));
  assert.equal(r.shortUrl, 'https://tinyurl.com/bishop-book-fair');
  assert.equal(JSON.parse(gas.fetchRequests[0].options.payload).alias, 'bishop-book-fair');
  assert.equal(gas.event.getSheetByName('Event').rows.find((row) => row[0] === 'shortLink')[1], 'https://tinyurl.com/bishop-book-fair');
  assert.equal(gas.ctx.getShortLink({ eventId: gas.eventId }).shortUrl, 'https://tinyurl.com/fake2', 'blank text later: a new random link');
  assert.equal(gas.event.getSheetByName('Event').rows.find((row) => row[0] === 'shortLink')[1], 'https://tinyurl.com/fake2', 'overwritten');
});

test('asking again for text that already points to this event reuses it', () => {
  for (const gas of [withToken(), loadWithEvent()]) {
    quietly(() => gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'bishop-book-fair' }));
    quietly(() => gas.ctx.getShortLink({ eventId: gas.eventId })); // the sheet now has a different link
    let r;
    quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'bishop-book-fair' })); });
    assert.equal(r.shortUrl, 'https://tinyurl.com/bishop-book-fair');
    assert.ok(gas.fetchLog.includes('https://tinyurl.com/bishop-book-fair'), 'checked where it points');
    assert.equal(gas.event.getSheetByName('Event').rows.find((row) => row[0] === 'shortLink')[1], 'https://tinyurl.com/bishop-book-fair');
  }
});

test('a pasted tinyurl.com/ prefix is accepted', () => {
  const gas = withToken();
  assert.equal(gas.ctx.getShortLink({ eventId: gas.eventId, alias: ' https://tinyurl.com/fair-2026 ' }).shortUrl, 'https://tinyurl.com/fair-2026');
});

test('bad short link text is refused before asking TinyURL', () => {
  const gas = withToken();
  for (const alias of ['abcd', 'x'.repeat(31), 'has space', 'semi;colon', 'ünïcode', 'a/b/c/d/e']) {
    assert.equal(gas.ctx.getShortLink({ eventId: gas.eventId, alias }).error, 'INVALID_ALIAS', alias);
  }
  assert.deepEqual(gas.fetchLog, []);
});

test('text taken by someone else gets a clear message and leaves the spreadsheet alone', () => {
  const gas = withToken();
  gas.ctx.getShortLink({ eventId: gas.eventId });
  gas.ctx.UrlFetchApp.tinyUrls['book-fair'] = 'https://elsewhere.example/';
  let r;
  quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'book-fair' })); });
  assert.equal(r.error, 'ALIAS_REJECTED');
  assert.match(r.message, /already taken/);
  assert.equal(gas.event.getSheetByName('Event').rows.find((row) => row[0] === 'shortLink')[1], 'https://tinyurl.com/fake1');
});

test('text already used by a different event of ours is still "taken"', () => {
  const gas = withToken();
  const other = gas.addEvent({ title: 'Other' });
  gas.ctx.getShortLink({ eventId: other.getId(), alias: 'shared-text' });
  let r;
  quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'shared-text' })); });
  assert.equal(r.error, 'ALIAS_REJECTED');
});

test('TinyURL\'s other alias complaints are passed on', () => {
  const gas = withToken();
  gas.ctx.UrlFetchApp.nextReply = { code: 422, text: '{"data":[],"code":5,"errors":["The Alias format is invalid."]}' };
  let r;
  quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'fine-text' })); });
  assert.equal(r.message, 'TinyURL didn\'t accept that text: The Alias format is invalid.');
});

test('without a token, custom text uses the old API\'s alias parameter', () => {
  const gas = loadWithEvent();
  let r;
  quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'old-api-fair' })); });
  assert.equal(r.shortUrl, 'https://tinyurl.com/old-api-fair');
  assert.match(gas.fetchLog[0], /api-create\.php\?url=.*&alias=old-api-fair$/);
  quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'old-api-fair' })); });
  gas.ctx.UrlFetchApp.tinyUrls['taken-one'] = 'https://elsewhere.example/';
  quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'taken-one' })); });
  assert.equal(r.error, 'ALIAS_REJECTED');
});

test('new links are rate-limited per event in the cache; failures and reuses don\'t count', () => {
  const gas = withToken();
  gas.ctx.UrlFetchApp.tinyUrls['taken-text'] = 'https://elsewhere.example/';
  quietly(() => gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'taken-text' }));
  for (let i = 1; i <= 10; i++) {
    assert.equal(gas.ctx.getShortLink({ eventId: gas.eventId, alias: i === 1 ? 'first-text' : '' }).ok, true, 'link ' + i);
  }
  const r = plain(gas.ctx.getShortLink({ eventId: gas.eventId }));
  assert.equal(r.error, 'RATE_LIMITED');
  assert.match(r.message, /admin@bishopschoolpto\.com/);
  assert.deepEqual(gas.cache.get('shortLinkCount:' + gas.eventId), { value: '10', seconds: 6 * 60 * 60 });
  const other = gas.addEvent({ title: 'Other' });
  assert.equal(gas.ctx.getShortLink({ eventId: other.getId() }).ok, true, 'limit is per event');
  gas.cache.delete('shortLinkCount:' + gas.eventId); // the 6 hours pass
  assert.equal(gas.ctx.getShortLink({ eventId: gas.eventId }).ok, true);
});

test('reusing text that already points here doesn\'t count toward the limit', () => {
  const gas = withToken();
  gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'mine-text' });
  quietly(() => { for (let i = 0; i < 3; i++) gas.ctx.getShortLink({ eventId: gas.eventId, alias: 'mine-text' }); });
  assert.equal(gas.cache.get('shortLinkCount:' + gas.eventId).value, '1');
});

// ---------- Short link and QR code in the Event tab ----------

const eventRows = (gas) => plain(gas.event.getSheetByName('Event').rows);
const qrImages = (gas) => gas.event.getSheetByName('Event').images;

test('a short link and its QR code are written into the Event tab', () => {
  const gas = loadWithEvent();
  gas.ctx.getShortLink({ eventId: gas.eventId });
  const rows = eventRows(gas);
  const linkRow = rows.findIndex((r) => r[0] === 'shortLink');
  const qrRow = rows.findIndex((r) => r[0] === 'qrCode');
  assert.equal(rows[linkRow][1], 'https://tinyurl.com/fake1');
  assert.match(rows[linkRow][2], /Written by the app/);
  assert.equal(qrRow, linkRow + 1);

  const images = qrImages(gas);
  assert.equal(images.length, 1);
  assert.equal(images[0].getAltTextTitle(), 'Sign-up QR code');
  assert.deepEqual([images[0].column, images[0].row], [2, qrRow + 1], 'over the qrCode row\'s value cell');
  assert.equal(images[0].blob.contentType, 'image/gif');
  assert.deepEqual(images[0].blob.bytes.slice(0, 6), [...Buffer.from('GIF87a')], 'a real GIF');

  assert.equal(gas.ctx.readEventInfo_(gas.event).title, 'Fall Book Fair (sample)', 'event fields unaffected');
  assert.ok(!gas.lockLog.includes('lock-failed'));
  assert.equal(gas.lockLog.filter((l) => l === 'lock').length, gas.lockLog.filter((l) => l === 'unlock').length, 'lock released');
});

test('writing the same link and QR code again is skipped', () => {
  const gas = loadWithEvent();
  gas.ctx.getShortLink({ eventId: gas.eventId });
  const before = gas.drive.get(gas.eventId).modifiedTime;
  assert.equal(gas.ctx.saveShortLinkToSheet_(gas.eventId, 'https://tinyurl.com/fake1'), true, 'already there counts as saved');
  assert.equal(gas.drive.get(gas.eventId).modifiedTime, before);
  assert.equal(qrImages(gas).length, 1);
});

test('a newer short link replaces the old one and its QR code, keeping other images', () => {
  const gas = loadWithEvent();
  const sheet = gas.event.getSheetByName('Event');
  sheet.insertImage({ contentType: 'image/png' }, 4, 1).setAltTextTitle('Organizer logo');
  gas.ctx.getShortLink({ eventId: gas.eventId }); // static site link
  gas.ctx.getShortLink({ eventId: gas.eventId, baseUrl: 'https://script.google.com/macros/s/TEST/exec' });
  const rows = eventRows(gas);
  assert.equal(rows.filter((r) => r[0] === 'shortLink').length, 1);
  assert.equal(rows.find((r) => r[0] === 'shortLink')[1], 'https://tinyurl.com/fake2');
  assert.deepEqual(qrImages(gas).map((i) => i.getAltTextTitle()).sort(), ['Organizer logo', 'Sign-up QR code']);
});

test('existing shortLink and qrCode rows are reused, wherever they are', () => {
  const gas = loadWithEvent();
  const sheet = gas.event.getSheetByName('Event');
  sheet.rows.splice(2, 0, ['QRcode', 'typed here', ''], ['shortlink', 'old', '']);
  const rowCount = sheet.rows.length;
  gas.ctx.getShortLink({ eventId: gas.eventId });
  assert.equal(sheet.rows.length, rowCount, 'no rows added');
  assert.equal(sheet.rows[3][1], 'https://tinyurl.com/fake1');
  assert.equal(qrImages(gas)[0].row, 3);
});

test('if the spreadsheet can\'t be written, the short link is still returned', () => {
  const gas = loadWithEvent();
  gas.event.getSheetByName('Event').insertImage = () => { throw new Error('You do not have permission'); };
  let r;
  const logged = quietly(() => { r = plain(gas.ctx.getShortLink({ eventId: gas.eventId })); });
  assert.equal(r.ok, true);
  assert.equal(r.shortUrl, 'https://tinyurl.com/fake1');
  assert.equal(r.savedToSheet, false);
  assert.match(logged[0], /Could not save short link/);
  assert.equal(gas.lockLog.filter((l) => l === 'lock').length, gas.lockLog.filter((l) => l === 'unlock').length, 'lock released');
});

test('if the lock is busy, the short link is returned without writing the spreadsheet', () => {
  const gas = loadWithEvent({ lockAvailable: false });
  const r = gas.ctx.getShortLink({ eventId: gas.eventId });
  assert.equal(r.ok, true);
  assert.equal(r.savedToSheet, false);
  assert.equal(qrImages(gas).length, 0);
});

test('a past event gets its short link written too', () => {
  const gas = loadWithEvent();
  gas.moveTo(gas.eventId, PAST_FOLDER);
  gas.ctx.getShortLink({ eventId: gas.eventId });
  assert.equal(qrImages(gas).length, 1);
});
