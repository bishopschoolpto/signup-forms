const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('../helpers/gas');

const { ctx } = loadGas();

const event = { eventId: 'e1', isOpen: true };
const slot = { slotId: 's1', label: 'Setup', capacity: 2 };
const input = (email) => ({ eventId: 'e1', slotId: 's1', name: 'Pat Lee', email });
const signup = (email, status = 'confirmed') => ({ slotId: 's1', email, name: 'X Y', status });

test('validateSignupInput_ trims, collapses spaces, and lowercases email', () => {
  const r = ctx.validateSignupInput_({ eventId: ' e1 ', slotId: ' s1 ', name: '  Pat   Lee ', email: ' Pat@Example.COM ', phone: ' 555-1234 ' });
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.value), { eventId: 'e1', slotId: 's1', name: 'Pat Lee', email: 'pat@example.com', phone: '555-1234', note: '', waitlist: false, baseUrl: '' });
  assert.equal(ctx.validateSignupInput_({ ...r.value, waitlist: 'yes' }).value.waitlist, false, 'only true means waitlist');
  assert.equal(ctx.validateSignupInput_({ ...r.value, waitlist: true }).value.waitlist, true);
});

test('validateSignupInput_ reports each missing or bad field', () => {
  const r = ctx.validateSignupInput_({ email: 'not-an-email', phone: 'call me' });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.fieldErrors).sort(), ['email', 'eventId', 'name', 'phone', 'slotId']);
});

test('validateSignupInput_ enforces length limits', () => {
  const r = ctx.validateSignupInput_({ eventId: 'e1', slotId: 's1', name: 'A'.repeat(101), email: 'a@b.co', note: 'n'.repeat(501) });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.fieldErrors).sort(), ['name', 'note']);
});

test('validateSignupInput_ tolerates null/undefined input', () => {
  assert.equal(ctx.validateSignupInput_(undefined).ok, false);
  assert.equal(ctx.validateSignupInput_(null).ok, false);
});

test('decideSignup_ allows a sign-up when there is room', () => {
  assert.equal(ctx.decideSignup_(event, slot, [signup('a@x.com')], input('b@x.com')).ok, true);
});

test('decideSignup_ rejects when the slot is full', () => {
  const r = ctx.decideSignup_(event, slot, [signup('a@x.com'), signup('b@x.com')], input('c@x.com'));
  assert.equal(r.error, 'SLOT_FULL');
});

test('decideSignup_ ignores cancelled sign-ups when counting', () => {
  const r = ctx.decideSignup_(event, slot, [signup('a@x.com'), signup('b@x.com', 'cancelled')], input('c@x.com'));
  assert.equal(r.ok, true);
});

test('decideSignup_ rejects the same email twice for one slot, case-insensitively', () => {
  const r = ctx.decideSignup_(event, slot, [signup('Pat@X.com')], input('pat@x.com'));
  assert.equal(r.error, 'DUPLICATE');
});

test('decideSignup_ only counts sign-ups for the same slot', () => {
  const other = { slotId: 's2', email: 'a@x.com', status: 'confirmed' };
  assert.equal(ctx.decideSignup_(event, slot, [other, other], input('a@x.com')).ok, true);
});

test('decideSignup_ rejects closed and missing events, and missing or unlabeled slots', () => {
  assert.equal(ctx.decideSignup_({ eventId: 'e1', isOpen: false }, slot, [], input('a@x.com')).error, 'CLOSED');
  assert.equal(ctx.decideSignup_({ eventId: 'e1' }, slot, [], input('a@x.com')).error, 'CLOSED');
  assert.equal(ctx.decideSignup_(null, slot, [], input('a@x.com')).error, 'NOT_FOUND');
  assert.equal(ctx.decideSignup_(event, null, [], input('a@x.com')).error, 'NOT_FOUND');
  assert.equal(ctx.decideSignup_(event, { ...slot, label: '' }, [], input('a@x.com')).error, 'NOT_FOUND');
});

test('decideSignup_ treats capacity 0 as full', () => {
  const r = ctx.decideSignup_(event, { ...slot, capacity: 0 }, [], input('a@x.com'));
  assert.equal(r.error, 'SLOT_FULL');
});

test('publicDisplayName_ shows first name and last initial only', () => {
  assert.equal(ctx.publicDisplayName_('Jane Doe'), 'Jane D.');
  assert.equal(ctx.publicDisplayName_('Mary Ann van der berg'), 'Mary B.');
  assert.equal(ctx.publicDisplayName_('Cher'), 'Cher');
  assert.equal(ctx.publicDisplayName_('  '), 'Volunteer');
});

test('buildPublicEvent_ sorts slots, skips incomplete rows, counts fills, and exposes no contact info', () => {
  const slots = [
    { slotId: 'b', label: 'Late', start: '2026-10-17T18:00:00.000Z', end: '', capacity: 1 },
    { slotId: 'a', label: 'Early', start: '2026-10-17T16:00:00.000Z', end: '', capacity: 3 },
    { slotId: '', label: 'No id yet', start: '', end: '', capacity: 1 },
    { slotId: 'c', label: '', start: '', end: '', capacity: 1 },
  ];
  const signups = [
    { slotId: 'a', name: 'Jane Doe', email: 'jane@x.com', phone: '555', status: 'confirmed' },
    { slotId: 'b', name: 'Sam Roe', email: 'sam@x.com', status: 'confirmed' },
    { slotId: 'b', name: 'Gone Away', email: 'g@x.com', status: 'cancelled' },
  ];
  const view = plain(ctx.buildPublicEvent_({ ...event, title: 'T' }, slots, signups, () => 'when'));
  assert.deepEqual(view.slots.map((s) => [s.label, s.filled, s.remaining, s.volunteers]), [
    ['Early', 1, 2, ['Jane D.']],
    ['Late', 1, 0, ['Sam R.']],
  ]);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('@'), 'no emails in public view');
  assert.ok(!json.includes('555'), 'no phones in public view');
});

test('sanitizeForSheet_ neutralizes formula-looking text', () => {
  assert.equal(ctx.sanitizeForSheet_('=IMPORTXML("http://evil")'), '\'=IMPORTXML("http://evil")');
  assert.equal(ctx.sanitizeForSheet_('+1 555 1234'), "'+1 555 1234");
  assert.equal(ctx.sanitizeForSheet_('@home'), "'@home");
  assert.equal(ctx.sanitizeForSheet_('Jane'), 'Jane');
  assert.equal(ctx.sanitizeForSheet_(3), 3);
});

// ---------- Waitlist ----------

const full = (slotId, n, status = 'confirmed') => Array.from({ length: n }, (_, i) => ({ slotId, email: slotId + i + '@x.com', name: 'P ' + i, status }));
const wl = (email) => ({ ...input(email), waitlist: true });

test('the waitlist opens only when every slot of an open event is full', () => {
  const a = { slotId: 'a', label: 'A', capacity: 1 };
  const b = { slotId: 'b', label: 'B', capacity: 2 };
  assert.equal(ctx.isWaitlistOpen_(event, [a, b], full('a', 1)), false, 'b has room');
  assert.equal(ctx.isWaitlistOpen_(event, [a, b], [...full('a', 1), ...full('b', 2)]), true);
  assert.equal(ctx.isWaitlistOpen_({ ...event, isOpen: false }, [a, b], [...full('a', 1), ...full('b', 2)]), false, 'closed event');
  assert.equal(ctx.isWaitlistOpen_(event, [], []), false, 'no slots');
  assert.equal(ctx.isWaitlistOpen_(event, [a, b], [...full('a', 1), ...full('b', 2, 'waitlisted')]), false, 'waitlisted don\'t fill a slot');
  assert.equal(ctx.isWaitlistOpen_(event, [a, { ...b, label: '' }], full('a', 1)), true, 'unusable slots are ignored');
});

test('decideSignup_ accepts a waitlist entry only when everything is full', () => {
  const a = { slotId: 'a', label: 'A', capacity: 1 };
  const b = { slotId: 'b', label: 'B', capacity: 1 };
  assert.equal(ctx.decideSignup_(event, a, full('a', 1), wl('new@x.com'), [a, b]).error, 'SPOTS_OPEN');
  const allFull = [...full('a', 1), ...full('b', 1)];
  assert.equal(ctx.decideSignup_(event, a, allFull, wl('new@x.com'), [a, b]).ok, true);
  assert.equal(ctx.decideSignup_(event, a, allFull, input('new@x.com'), [a, b]).error, 'SLOT_FULL', 'a normal sign-up still can\'t overfill');
  assert.equal(ctx.decideSignup_({ ...event, isOpen: false }, a, allFull, wl('new@x.com'), [a, b]).error, 'CLOSED');
});

test('decideSignup_ refuses duplicate waitlist entries and waitlisting a slot you have', () => {
  const a = { slotId: 'a', label: 'A', capacity: 1 };
  const signups = [{ slotId: 'a', email: 'me@x.com', status: 'confirmed' }];
  assert.match(ctx.decideSignup_(event, a, signups, wl('me@x.com'), [a]).message, /already signed up/);
  const withWait = [...full('a', 1), { slotId: 'a', email: 'wait@x.com', status: 'waitlisted' }];
  assert.match(ctx.decideSignup_(event, a, withWait, wl('wait@x.com'), [a]).message, /already on the waitlist/);
  assert.equal(ctx.decideSignup_(event, a, withWait, wl('other@x.com'), [a]).ok, true);
});

test('the public view counts the waitlist per slot and never names waitlisted people', () => {
  const a = { slotId: 'a', label: 'A', capacity: 1 };
  const signups = [...full('a', 1), { slotId: 'a', email: 'w@x.com', name: 'Wendy Wait', status: 'waitlisted' }];
  const view = plain(ctx.buildPublicEvent_(event, [a], signups, () => ''));
  assert.equal(view.allSlotsFull, true);
  assert.equal(view.waitlistOpen, true);
  assert.equal(view.slots[0].waitlisted, 1);
  assert.deepEqual(view.slots[0].volunteers, ['P 0.']);
  assert.ok(!JSON.stringify(view).includes('Wendy'));
});

// ---------- Custom questions ----------

test('parseQuestions_ reads types, options, and required, and skips blanks and repeats', () => {
  const qs = plain(ctx.parseQuestions_([
    { question: ' T-shirt  size ', type: 'Dropdown', options: 'S, M,\nL, M,', required: 'Yes' },
    { question: '', type: 'text' },
    { question: 't-shirt size', type: 'text' },
    { question: 'Allergies', type: 'Long answer', options: 'ignored', required: '' },
    { question: 'Pick one', type: 'choice', options: '' },
    { question: 'Agree', type: 'yes/no', required: 'x' },
    { question: 'Unknown type', type: 'rainbow' },
  ]));
  assert.deepEqual(qs, [
    { label: 'T-shirt size', type: 'choice', options: ['S', 'M', 'L'], required: true },
    { label: 'Allergies', type: 'paragraph', options: [], required: false },
    { label: 'Pick one', type: 'text', options: [], required: false },
    { label: 'Agree', type: 'checkbox', options: [], required: true },
    { label: 'Unknown type', type: 'text', options: [], required: false },
  ]);
  assert.equal(ctx.parseQuestions_(Array.from({ length: 15 }, (_, i) => ({ question: 'Q' + i }))).length, 10, 'at most 10');
});

test('validateAnswers_ fills every question, normalizes, and reports problems', () => {
  const qs = ctx.parseQuestions_([
    { question: 'Size', type: 'choice', options: 'S, M', required: 'yes' },
    { question: 'Agree', type: 'checkbox', required: 'yes' },
    { question: 'Story', type: 'paragraph' },
    { question: 'Nick', type: 'text' },
  ]);
  const ok = plain(ctx.validateAnswers_(qs, { Size: ' M ', Agree: 'on', Story: ' line 1\n line 2 ', Extra: 'ignored' }));
  assert.deepEqual(ok, { ok: true, value: { Size: 'M', Agree: 'Yes', Story: 'line 1\n line 2', Nick: '' } });
  const bad = plain(ctx.validateAnswers_(qs, { Size: 'XL', Agree: false, Story: 'x'.repeat(1001) }));
  assert.deepEqual(bad.fieldErrors, {
    'answer:Size': 'Please pick one of the choices.',
    'answer:Agree': 'Please check this box.',
    'answer:Story': 'Must be 1000 characters or fewer.',
  });
  assert.equal(ctx.validateAnswers_(qs, null).ok, false);
  assert.deepEqual(plain(ctx.validateAnswers_([], undefined)), { ok: true, value: {} });
});
