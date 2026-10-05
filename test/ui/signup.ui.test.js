/**
 * Drives the real page in headless Chromium against the local dev server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('../../dev/server');
const { PAST_FOLDER } = require('../helpers/gas');

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

/** Fresh server (fresh database) + page for each test. */
async function open(pathname = '/', viewport) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = 'http://localhost:' + server.address().port;
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + pathname.replace('EVENT', server.gas.eventId));
  return {
    page, base, gas: server.gas, errors, rpcLog: server.rpcLog,
    close: async () => { await page.close(); server.close(); },
  };
}

async function fillForm(page, { name, email, phone = '' }) {
  await page.fill('#f-name', name);
  await page.fill('#f-email', email);
  if (phone) await page.fill('#f-phone', phone);
}

test('home page lists open events and turns a spreadsheet link into a sign-up link', async () => {
  const t = await open('/');
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    assert.equal(await t.page.textContent('#org-name'), 'Bishop School PTO');
    const logo = await t.page.locator('.site-header .logo svg').boundingBox();
    assert.ok(logo && logo.width > 20 && logo.height > 20, 'paw print logo is visible');
    await t.page.waitForSelector('#open-events-list:not([hidden])');
    assert.ok(await t.page.isHidden('#open-events-loading'), 'loading indicator removed');
    assert.equal(await t.page.getAttribute('#open-events', 'aria-busy'), null);
    assert.ok(await t.page.evaluate(() => {
      const section = document.getElementById('open-events');
      return section === section.parentElement.lastElementChild;
    }), 'Open sign-ups is last on the home page');
    assert.deepEqual(await t.page.locator('.event-link').allTextContents(), ['Fall Book Fair (sample)'], 'the template is not listed');
    assert.equal(await t.page.getAttribute('.event-link', 'href'), t.base + '/?event=' + t.gas.eventId);
    assert.match(await t.page.textContent('.event-item'), /School Library/);
    assert.match(await t.page.textContent('.event-spots'), /^6 spots left$/);
    assert.ok(t.rpcLog.includes('getOpenEvents'));
    assert.equal(await t.page.locator('.steps > li').count(), 9, 'organizer guide');
    assert.ok(await t.page.isVisible('#link-btn'), 'the link tool is visible right away');
    assert.ok(await t.page.isHidden('text=Open the Events folder'), 'steps 1-6 start collapsed');
    assert.equal(await t.page.getAttribute('.guide-heading + p a', 'href'),
      'https://drive.google.com/drive/folders/1yX2nxEPACkQkJLyeWYbRjd-8x0MmK55c', 'Events folder linked in the intro');
    await t.page.click('#setup-guide summary');
    assert.ok(await t.page.isVisible('text=Open the Events folder'));
    assert.equal(await t.page.textContent('.folder-link .folder-name'), 'Events');
    assert.ok(await t.page.isVisible('.folder-link .folder-icon'), 'a folder icon marks it as a Drive folder');
    assert.equal(await t.page.getAttribute('.folder-link', 'target'), '_blank');
    assert.equal(await t.page.getAttribute('a[href*="drive.google.com"]', 'href'),
      'https://drive.google.com/drive/folders/1yX2nxEPACkQkJLyeWYbRjd-8x0MmK55c');
    assert.ok(await t.page.locator('a[href="mailto:admin@bishopschoolpto.com"]').first().isVisible());

    await t.page.fill('#f-sheet', 'https://docs.google.com/spreadsheets/d/' + t.gas.eventId + '/edit#gid=0');
    await t.page.click('#link-btn');
    await t.page.waitForSelector('#link-result:not([hidden])');
    assert.equal(await t.page.textContent('#link-event-title'), 'Fall Book Fair (sample)');
    const link = await t.page.inputValue('#link-output');
    assert.equal(link, t.base + '/?event=' + t.gas.eventId);

    const suggested = await t.page.inputValue('#f-alias');
    assert.match(suggested, /^bishop-fall-book-fair-20\d\d$/, 'suggested from the org, title and year');
    await t.page.click('#short-btn');
    await t.page.waitForSelector('#short-result:not([hidden])');
    assert.equal(await t.page.inputValue('#short-output'), 'https://tinyurl.com/' + suggested);
    assert.deepEqual(t.gas.fetchLog, ['https://tinyurl.com/api-create.php?url=' + encodeURIComponent(link) + '&alias=' + suggested],
      'on the Apps Script page, the short link goes to the Apps Script page');
    assert.ok(t.rpcLog.includes('getShortLink'));

    await t.page.goto(link);
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.equal(await t.page.textContent('#event-title'), 'Fall Book Fair (sample)');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('clicking a listed event opens its sign-up page', async () => {
  const t = await open('/');
  try {
    await t.page.waitForSelector('.event-item');
    await t.page.click('.event-item'); // anywhere on the card
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.equal(await t.page.textContent('#event-title'), 'Fall Book Fair (sample)');
  } finally { await t.close(); }
});

test('with no open events, the home page says so', async () => {
  const t = await open('/');
  try {
    t.gas.moveTo(t.gas.eventId, 'otherFolder');
    t.gas.cache.clear();
    await t.page.reload();
    await t.page.waitForFunction(() => /No events are taking sign-ups/.test(document.getElementById('open-events-status').textContent));
    assert.ok(await t.page.isHidden('#open-events-list'));
  } finally { await t.close(); }
});

test('the intro\'s "Open sign-ups" button scrolls to the list at the bottom', async () => {
  const t = await open('/', { width: 390, height: 700 });
  try {
    await t.page.waitForSelector('#open-events-list:not([hidden])');
    await t.page.click('#jump-events');
    await t.page.waitForFunction(() => {
      const top = document.getElementById('open-events').getBoundingClientRect().top;
      return top < 700 && top >= -1;
    });
  } finally { await t.close(); }
});

test('step 7 can open the collapsed steps 1-6 and scroll to them', async () => {
  const t = await open('/', { width: 390, height: 700 });
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    assert.ok(await t.page.isHidden('text=Open the Events folder'));
    await t.page.click('#show-setup');
    await t.page.waitForFunction(() => {
      const top = document.getElementById('setup-guide').getBoundingClientRect().top;
      return top >= -1 && top < 50; // smooth scroll finished at the guide
    });
    assert.ok(await t.page.isVisible('text=Open the Events folder'));
    assert.equal(await t.page.evaluate(() => document.activeElement.tagName), 'SUMMARY');
    await t.page.click('#show-setup'); // already open: stays open
    assert.equal(await t.page.evaluate(() => document.getElementById('setup-guide').open), true);
  } finally { await t.close(); }
});

test('link tool explains when a spreadsheet is not a usable event', async () => {
  const t = await open('/');
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    await t.page.fill('#f-sheet', 'not a link');
    await t.page.click('#link-btn');
    assert.match(await t.page.textContent('#link-error'), /doesn't look like a Google Sheets link/);

    // The template is in the Events folder, but is never an event.
    await t.page.fill('#f-sheet', 'https://docs.google.com/spreadsheets/d/' + t.gas.props.TEMPLATE_ID + '/edit');
    await t.page.click('#link-btn');
    await t.page.waitForFunction(() => /No sign-up found/.test(document.getElementById('link-error').textContent));
    assert.ok(await t.page.isHidden('#link-result'));
  } finally { await t.close(); }
});

test('a parent can sign up and sees a confirmation', async () => {
  const t = await open('/?event=EVENT');
  try {
    await t.page.waitForSelector('#slot-checkout');
    assert.match(await t.page.textContent('#slot-checkout .slot-count'), /2 of 2 spots left/);
    assert.deepEqual(t.rpcLog, [], 'slots come with the page; no extra server call');

    await t.page.click('#slot-checkout button');
    assert.equal(await t.page.evaluate(() => document.activeElement.id), 'f-name', 'focus moves to the form');
    await fillForm(t.page, { name: 'Jane Doe', email: 'Jane@Example.com', phone: '555-0100' });
    await t.page.click('#submit-btn');

    await t.page.waitForSelector('#done-view:not([hidden])');
    assert.equal(await t.page.textContent('#done-slot'), 'Checkout table');
    assert.equal(await t.page.textContent('#done-where'), 'School Library');
    assert.match(await t.page.textContent('#done-email'), /on its way to jane@example\.com/);
    assert.ok(await t.page.isHidden('#done-organizer'), 'no organizer line when none is configured');
    assert.equal(t.gas.sentMail.length, 1);

    await t.page.click('#another-btn');
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.match(await t.page.textContent('#slot-checkout .slot-count'), /1 of 2 spots left/);
    assert.match(await t.page.textContent('#slot-checkout .slot-names'), /Jane D\./);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('server-side validation errors appear next to the fields', async () => {
  const t = await open('/?event=EVENT');
  try {
    await t.page.click('#slot-setup button');
    await fillForm(t.page, { name: '', email: 'not-an-email' });
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#err-name:not(:empty)');
    assert.match(await t.page.textContent('#err-email'), /valid email/);
    assert.equal(await t.page.getAttribute('#f-name', 'aria-invalid'), 'true');
    assert.equal(await t.page.evaluate(() => document.activeElement.id), 'f-name');
    assert.equal(t.gas.ctx.readTable_(t.gas.event, 'Signups').length, 0);
  } finally { await t.close(); }
});

test('a full slot has no sign-up button', async () => {
  const t = await open('/?event=EVENT');
  try {
    t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId: 'cleanup', name: 'Sam Roe', email: 'sam@example.com' });
    await t.page.reload();
    await t.page.waitForSelector('#slot-cleanup');
    assert.equal(await t.page.locator('#slot-cleanup button').count(), 0);
    assert.match(await t.page.textContent('#slot-cleanup .slot-count'), /Full \(1 of 1\)/);
  } finally { await t.close(); }
});

test('if someone else takes the last spot first, the page says so and refreshes', async () => {
  const t = await open('/?event=EVENT');
  try {
    await t.page.click('#slot-cleanup button');
    await fillForm(t.page, { name: 'Late Parent', email: 'late@example.com' });
    // Another parent grabs the only Cleanup spot while this form is open.
    t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId: 'cleanup', name: 'Quick Parent', email: 'quick@example.com' });
    await t.page.click('#submit-btn');

    await t.page.waitForSelector('#page-status:not([hidden])');
    assert.match(await t.page.textContent('#page-status'), /just filled up/);
    assert.equal(await t.page.locator('#slot-cleanup button').count(), 0);
    assert.ok(await t.page.isHidden('#signup-form'));
    assert.equal(t.gas.ctx.readTable_(t.gas.event, 'Signups').length, 1);
  } finally { await t.close(); }
});

test('signing up twice for the same slot shows a message in the form', async () => {
  const t = await open('/?event=EVENT');
  try {
    t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId: 'setup', name: 'Jane Doe', email: 'jane@example.com' });
    await t.page.click('#slot-setup button');
    await fillForm(t.page, { name: 'Jane Doe', email: 'JANE@example.com' });
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#form-error:not([hidden])');
    assert.match(await t.page.textContent('#form-error'), /already signed up/);
  } finally { await t.close(); }
});

test('names containing HTML are shown as text, not markup', async () => {
  const t = await open('/?event=EVENT');
  try {
    t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId: 'setup', name: '<img src=x onerror=alert(1)> Doe', email: 'x@example.com' });
    await t.page.reload();
    await t.page.waitForSelector('#slot-setup .slot-names');
    assert.equal(await t.page.locator('#slot-setup .slot-names img').count(), 0);
    assert.match(await t.page.textContent('#slot-setup .slot-names'), /<img/);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('events in Past events show a notice and no sign-up buttons', async () => {
  const t = await open('/?event=EVENT');
  try {
    t.gas.moveTo(t.gas.eventId, PAST_FOLDER);
    t.gas.cache.clear(); // Moves show after the next 1-minute cache refresh.
    await t.page.reload();
    await t.page.waitForSelector('#event-closed:not([hidden])');
    assert.equal(await t.page.locator('.slot button').count(), 0);
  } finally { await t.close(); }
});

test('unknown event shows a friendly error', async () => {
  const t = await open('/?event=does-not-exist');
  try {
    await t.page.waitForSelector('#error-view:not([hidden])');
    assert.match(await t.page.textContent('#error-view'), /couldn't find that sign-up/);
  } finally { await t.close(); }
});

test('layout fits a phone screen without horizontal scrolling', async () => {
  const t = await open('/?event=EVENT', { width: 375, height: 740 });
  try {
    await t.page.waitForSelector('#slot-setup');
    await t.page.click('#slot-setup button');
    const overflow = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, 'page is ' + overflow + 'px wider than the screen');
    await t.page.screenshot({ path: 'test-results/phone-signup-form.png', fullPage: true });
  } finally { await t.close(); }
});

test('confirmation screen shows the organizer email when one is configured', async () => {
  const t = await open('/?event=EVENT');
  try {
    t.gas.event.setEventField('organizerEmail', 'organizer@example.com');
    await t.page.click('#slot-setup button');
    await fillForm(t.page, { name: 'Jane Doe', email: 'jane@example.com' });
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#done-view:not([hidden])');
    assert.ok(await t.page.isVisible('#done-organizer'));
    assert.equal(await t.page.textContent('#done-organizer'), 'Need to change something? Email the organizer at organizer@example.com.');
    assert.equal(await t.page.getAttribute('#done-organizer-link', 'href'), 'mailto:organizer@example.com');
  } finally { await t.close(); }
});

test('when every slot is full, a volunteer can join a slot\'s waitlist', async () => {
  const t = await open('/?event=EVENT');
  try {
    let n = 100;
    for (const [slotId, cap] of [['setup', 3], ['checkout', 2], ['cleanup', 1]]) {
      for (let i = 0; i < cap; i++) {
        t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId, name: 'Parent ' + n, email: 'p' + (n++) + '@example.com' });
      }
    }
    await t.page.reload();
    await t.page.waitForSelector('#event-waitlist:not([hidden])');
    assert.deepEqual(await t.page.locator('.slot button').allTextContents(), ['Join waitlist', 'Join waitlist', 'Join waitlist']);

    await t.page.click('#slot-cleanup button');
    assert.equal(await t.page.textContent('#form-heading'), 'Join the waitlist: Cleanup');
    assert.equal(await t.page.textContent('#submit-btn'), 'Join waitlist');
    await fillForm(t.page, { name: 'Wendy Wait', email: 'wendy@example.com' });
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#done-view:not([hidden])');
    assert.equal(await t.page.textContent('#done-heading'), 'You\'re on the waitlist');
    assert.match(await t.page.textContent('#done-waitlist'), /#1 on the waitlist for this slot/);
    const row = t.gas.ctx.readTable_(t.gas.event, 'Signups').find((s) => s.email === 'wendy@example.com');
    assert.equal(row.status, 'waitlisted');

    await t.page.click('#another-btn');
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.match(await t.page.textContent('#slot-cleanup .slot-count'), /Full \(1 of 1\) · 1 on the waitlist/);
    assert.ok(!(await t.page.textContent('#slot-cleanup')).includes('Wendy'), 'waitlisted names stay private');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('no waitlist while any spot is open; a normal sign-up form is unchanged', async () => {
  const t = await open('/?event=EVENT');
  try {
    await t.page.waitForSelector('#event-view:not([hidden])');
    assert.ok(await t.page.isHidden('#event-waitlist'));
    assert.deepEqual(await t.page.locator('.slot button').allTextContents(), ['Sign up', 'Sign up', 'Sign up']);
    await t.page.click('#slot-setup button');
    assert.equal(await t.page.textContent('#submit-btn'), 'Confirm sign-up');
  } finally { await t.close(); }
});

test('a full event stays on the home page list, marked for its waitlist', async () => {
  const t = await open('/');
  try {
    let n = 100;
    for (const [slotId, cap] of [['setup', 3], ['checkout', 2], ['cleanup', 1]]) {
      for (let i = 0; i < cap; i++) {
        t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId, name: 'Parent ' + n, email: 'p' + (n++) + '@example.com' });
      }
    }
    t.gas.cache.clear();
    await t.page.reload();
    await t.page.waitForSelector('#open-events-list:not([hidden])');
    assert.equal(await t.page.textContent('.event-spots'), 'Full · join the waitlist');
  } finally { await t.close(); }
});

test('volunteers answer the organizer\'s questions, with errors shown on the right field', async () => {
  const t = await open('/?event=EVENT');
  try {
    const sheet = t.gas.event.getSheetByName('Questions');
    sheet.rows = [['question', 'type', 'options', 'required'],
      ['T-shirt size', 'choice', 'S, M, L', 'yes'],
      ['Food allergies?', 'paragraph', '', ''],
      ['I agree to the rules', 'checkbox', '', 'yes']];
    sheet.touch();
    t.gas.cache.clear();
    await t.page.reload();
    await t.page.click('#slot-setup button');
    assert.equal(await t.page.locator('#custom-fields .field').count(), 3);
    assert.deepEqual(await t.page.locator('#f-q0 option').allTextContents(), ['Choose…', 'S', 'M', 'L']);
    assert.equal(await t.page.getAttribute('#f-q1', 'maxlength'), '1000');
    assert.equal(await t.page.getAttribute('#f-q2', 'type'), 'checkbox');
    assert.match(await t.page.textContent('label[for="f-q1"]'), /Food allergies\? \(optional\)/);

    await fillForm(t.page, { name: 'Jane Doe', email: 'jane@example.com' });
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#err-q0:not(:empty)');
    assert.equal(await t.page.textContent('#err-q0'), 'Please answer this question.');
    assert.equal(await t.page.textContent('#err-q2'), 'Please check this box.');
    assert.equal(await t.page.getAttribute('#f-q0', 'aria-invalid'), 'true');
    assert.equal(await t.page.evaluate(() => document.activeElement.id), 'f-q0');

    await t.page.selectOption('#f-q0', 'M');
    await t.page.fill('#f-q1', 'Peanuts');
    await t.page.check('#f-q2');
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#done-view:not([hidden])');
    const row = t.gas.ctx.readTable_(t.gas.event, 'Signups')[0];
    assert.deepEqual([row['T-shirt size'], row['Food allergies?'], row['I agree to the rules']], ['M', 'Peanuts', 'Yes']);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('an event without questions shows the usual form', async () => {
  const t = await open('/?event=EVENT');
  try {
    t.gas.event.deleteSheet(t.gas.event.getSheetByName('Questions'));
    t.gas.cache.clear();
    await t.page.reload();
    await t.page.click('#slot-setup button');
    assert.equal(await t.page.locator('#custom-fields .field').count(), 0);
  } finally { await t.close(); }
});

test('the cancel link in the email shows the sign-up, and cancels only after confirming', async () => {
  const t = await open('/?event=EVENT');
  try {
    await t.page.click('#slot-cleanup button');
    await fillForm(t.page, { name: 'Pat Lee', email: 'pat@example.com' });
    await t.page.click('#submit-btn');
    await t.page.waitForSelector('#done-view:not([hidden])');
    const link = /Can't make it\?.*?(https?:\/\/\S+)/s.exec(t.gas.sentMail[0].body)[1];
    assert.ok(link.startsWith(t.base + '/?event='), 'points back to the page they used: ' + link);

    await t.page.goto(link);
    await t.page.waitForSelector('#cancel-view:not([hidden])');
    assert.equal(await t.page.textContent('#cancel-heading'), 'Cancel your sign-up?');
    assert.equal(await t.page.textContent('#cancel-slot'), 'Cleanup');
    assert.match(await t.page.textContent('#cancel-intro'), /^Hi Pat!/);
    assert.ok(await t.page.isHidden('#event-view'));
    assert.equal(t.gas.ctx.readTable_(t.gas.event, 'Signups')[0].status, 'confirmed', 'opening the link cancels nothing');
    assert.equal(await t.page.getAttribute('#cancel-keep', 'href'), t.base + '/?event=' + t.gas.eventId);

    await t.page.click('#cancel-confirm-btn');
    await t.page.waitForFunction(() => document.getElementById('cancel-heading').textContent === 'Your sign-up is cancelled');
    assert.equal(t.gas.ctx.readTable_(t.gas.event, 'Signups')[0].status, 'cancelled');
    assert.ok(await t.page.isHidden('#cancel-actions'));
    assert.ok(await t.page.isVisible('#cancel-event-link'));

    await t.page.reload();
    await t.page.waitForFunction(() => document.getElementById('cancel-heading').textContent === 'This sign-up is already cancelled');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('a broken cancel link says the sign-up wasn\'t found', async () => {
  const t = await open('/?event=EVENT&cancel=00000000-0000-0000-0000-000000000000');
  try {
    await t.page.waitForSelector('#cancel-view:not([hidden])');
    assert.equal(await t.page.textContent('#cancel-heading'), 'We couldn\'t find that sign-up');
    assert.ok(await t.page.isHidden('#cancel-actions'));
    assert.ok(await t.page.isHidden('#cancel-details'));
  } finally { await t.close(); }
});

test('a waitlisted volunteer\'s link offers to leave the waitlist', async () => {
  const t = await open('/');
  try {
    let n = 100;
    for (const [slotId, cap] of [['setup', 3], ['checkout', 2], ['cleanup', 1]]) {
      for (let i = 0; i < cap; i++) t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId, name: 'Parent ' + n, email: 'p' + (n++) + '@example.com' });
    }
    t.gas.ctx.submitSignup({ eventId: t.gas.eventId, slotId: 'cleanup', name: 'Wendy Wait', email: 'w@example.com', waitlist: true });
    const token = t.gas.ctx.readTable_(t.gas.event, 'Signups').find((s) => s.status === 'waitlisted').cancelToken;
    await t.page.goto(t.base + '/?event=' + t.gas.eventId + '&cancel=' + token);
    await t.page.waitForSelector('#cancel-view:not([hidden])');
    assert.equal(await t.page.textContent('#cancel-heading'), 'Leave the waitlist?');
    assert.equal(await t.page.textContent('#cancel-confirm-btn'), 'Yes, leave the waitlist');
    await t.page.click('#cancel-confirm-btn');
    await t.page.waitForFunction(() => document.getElementById('cancel-heading').textContent === 'You\'ve left the waitlist');
  } finally { await t.close(); }
});

test('optional steps stay collapsed when steps 1-6 are opened, and open on their own', async () => {
  const t = await open('/');
  try {
    await t.page.waitForSelector('#home-view:not([hidden])');
    await t.page.click('#setup-guide summary');
    assert.ok(await t.page.isVisible('text=Open the Events folder'), 'required steps show');
    for (const id of ['step-questions', 'step-email']) {
      assert.ok(await t.page.isVisible('#' + id + ' summary'), id + ' title shows');
      assert.equal(await t.page.evaluate((i) => document.getElementById(i).open, id), false, id + ' stays closed');
    }
    assert.ok(await t.page.isHidden('caption:text("Questions tab")'));
    assert.ok(await t.page.isHidden('.mock-email'));

    await t.page.click('#step-questions summary');
    assert.ok(await t.page.isVisible('caption:text("Questions tab")'));
    assert.ok(await t.page.isHidden('.mock-email'), 'the other optional step is still closed');
    assert.equal(await t.page.locator('.steps > li').count(), 9, 'numbering unchanged');
  } finally { await t.close(); }
});
