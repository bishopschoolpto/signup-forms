/**
 * Web app entry points.
 *
 * SECURITY: Apps Script lets ANY visitor call ANY global function whose name
 * does not end in "_" via google.script.run. Every internal helper in this
 * project therefore ends in "_". Public functions must validate their input
 * and never return private data (emails, phones, cancel tokens).
 * test/unit/security.test.js fails if a new public function appears.
 */

/**
 * Two jobs:
 *   ?api=page&event=<id>  JSON API for the static site at signups.bishopschoolpto.com
 *   ?api=events           JSON list of open events, for the home page
 *   ?api=cancellation&event=<id>&cancel=<token>  JSON details for the cancel page
 *   anything else         the Apps Script-hosted page, with its data already
 *                         inside so the browser needs no second round trip
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.api === 'page') {
    return jsonResponse_(function () { return getPageData(params.event || ''); });
  }
  if (params.api === 'events') return jsonResponse_(getOpenEvents);
  if (params.api === 'cancellation') {
    return jsonResponse_(function () { return getCancellation({ eventId: params.event, token: params.cancel }); });
  }

  var template = HtmlService.createTemplateFromFile('Index');
  template.initialJson = initialPageJson_(params.event || '', params.cancel || '');
  return template
    .evaluate()
    .setTitle(getConfig_().orgName + ' Volunteer Sign-Up')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * JSON API for the static site. The body is JSON sent as text/plain (a
 * "simple" request, so browsers send it cross-origin without a CORS
 * preflight, which Apps Script can't answer):
 *   { api: 'signup', input }     → submitSignup(input)
 *   { api: 'shortLink', input }  → getShortLink(input)
 *   { api: 'cancel', input }     → cancelSignup(input)
 */
function doPost(e) {
  return jsonResponse_(function () {
    var body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '');
    } catch (err) {
      return { ok: false, error: 'INVALID', message: 'Request body must be JSON.' };
    }
    if (body && body.api === 'signup') return submitSignup(body.input);
    if (body && body.api === 'shortLink') return getShortLink(body.input);
    if (body && body.api === 'cancel') return cancelSignup(body.input);
    return { ok: false, error: 'UNKNOWN_API', message: 'Unknown request.' };
  });
}

/**
 * Runs fn and returns its result as JSON. Unexpected errors become
 * { serverError: true } so the browser can show its generic message instead
 * of receiving Google's HTML error page.
 */
function jsonResponse_(fn) {
  var payload;
  try {
    payload = fn();
  } catch (err) {
    console.error('API error: ' + (err && err.stack || err));
    payload = { serverError: true };
  }
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

/** Used by Index.html as <?!= include('Styles') ?>. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Page data as JSON that is safe to place inside a <script> element. Returns
 * 'null' on any error; the page then falls back to calling getPageData.
 */
function initialPageJson_(eventId, cancelToken) {
  var data;
  try {
    data = getPageData(eventId);
    data.requestedEventId = String(eventId).slice(0, 200);
    if (cancelToken) data.requestedCancel = String(cancelToken).slice(0, 100);
  } catch (err) {
    console.error('Could not build initial page data for ' + eventId + ': ' + err);
    data = null;
  }
  // Escaping "<" keeps "</script>" or "<!--" in an event title from ending the script element.
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Everything the page needs in one round trip. With an eventId (a spreadsheet
 * id from the URL), returns that event's public slot view, or event: null if
 * it isn't an open or past event (see EVENT_STATE). The list of open events
 * is getOpenEvents.
 * Views come from the event cache when possible (see Cache.js); the folder
 * check always runs first and sets isOpen, so moving a spreadsheet takes
 * effect even while its view is cached.
 */
function getPageData(eventId) {
  var config = getConfig_();
  var page = { orgName: config.orgName, baseUrl: ScriptApp.getService().getUrl(), event: null };
  var id = String(eventId || '').trim();
  var state = getEventState_(id);
  if (state === EVENT_STATE.NONE) return page;

  page.event = getCachedPublicEvent_(id);
  if (!page.event) {
    var ss = openEventSpreadsheet_(id);
    page.event = ss ? buildEventView_(ss, state === EVENT_STATE.OPEN) : null;
    if (page.event) cachePublicEvent_(id, page.event);
  }
  if (page.event) {
    page.event.isOpen = state === EVENT_STATE.OPEN;
    page.event.waitlistOpen = page.event.isOpen && !!page.event.allSlotsFull;
  }
  return page;
}

/**
 * The home page's list of events taking sign-ups: spreadsheets directly in
 * Events with at least one spot left or an open waitlist, soonest first. Each
 * has eventId, title, location, dates, spotsLeft and waitlistOpen; never slots
 * or volunteer names. The 1-minute
 * timer keeps the list cached; if it has expired, this rebuilds it.
 */
function getOpenEvents() {
  var events = getCachedOpenEvents_();
  if (!events) {
    refreshEventCaches_();
    events = getCachedOpenEvents_() || [];
  }
  return {
    events: events.map(function (e) {
      return { eventId: e.eventId, title: e.title, location: e.location, dates: e.dates, spotsLeft: e.spotsLeft, waitlistOpen: !!e.waitlistOpen };
    }),
  };
}

/**
 * Records a sign-up. The capacity check and the write happen together under
 * the script lock, so two people can never both take the last spot.
 */
function submitSignup(rawInput) {
  var check = validateSignupInput_(rawInput);
  var rawAnswers = rawInput && rawInput.answers;
  if (!check.ok) {
    // Also flag unanswered questions now (from the cached page, if any), so people fix everything at once.
    var cachedView = check.fieldErrors.eventId ? null : getCachedPublicEvent_(String(rawInput.eventId).trim());
    var answerCheck = validateAnswers_((cachedView && cachedView.questions) || [], rawAnswers);
    var fieldErrors = answerCheck.ok ? check.fieldErrors : Object.assign({}, check.fieldErrors, answerCheck.fieldErrors);
    return { ok: false, error: 'INVALID', message: 'Please fix the highlighted fields.', fieldErrors: fieldErrors };
  }
  var input = check.value;

  // Asks Drive now, not the cache: moving an event to Past events stops sign-ups at once.
  var state = readEventState_(input.eventId);
  var ss = state === EVENT_STATE.NONE ? null : openEventSpreadsheet_(input.eventId);
  var event = ss ? readEventInfo_(ss) : null;
  if (!event) {
    return { ok: false, error: 'NOT_FOUND', message: 'This sign-up is no longer available.' };
  }
  event.isOpen = state === EVENT_STATE.OPEN;

  var questions = readQuestions_(ss);
  var answers = validateAnswers_(questions, rawAnswers);
  if (!answers.ok) {
    return { ok: false, error: 'INVALID', message: 'Please fix the highlighted fields.', fieldErrors: answers.fieldErrors };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, error: 'BUSY', message: 'Lots of people are signing up right now. Please try again in a moment.' };
  }

  var slot, record, filled, waitlistPosition;
  try {
    var slots = readTable_(ss, 'Slots');
    slot = findById_(slots, 'slotId', input.slotId);
    var signups = readTable_(ss, 'Signups');
    var decision = decideSignup_(event, slot, signups, input, slots);
    if (!decision.ok) return decision;
    filled = confirmedSignupsForSlot_(signups, slot.slotId).length + (input.waitlist ? 0 : 1);
    waitlistPosition = input.waitlist ? signupsForSlot_(signups, slot.slotId, SIGNUP_STATUS.WAITLISTED).length + 1 : 0;

    record = {
      signupId: Utilities.getUuid(),
      slotId: slot.slotId,
      slotLabel: slot.label,
      name: input.name,
      email: input.email,
      phone: input.phone,
      note: input.note,
      status: input.waitlist ? SIGNUP_STATUS.WAITLISTED : SIGNUP_STATUS.CONFIRMED,
      cancelToken: Utilities.getUuid(),
      createdAt: new Date(),
    };
    var answerHeaders = ensureAnswerColumns_(ss, questions);
    questions.forEach(function (q) { record[answerHeaders[q.label]] = answers.value[q.label]; });
    appendRecord_(ss, 'Signups', record);
    SpreadsheetApp.flush();
    // Put the updated view in the cache now, from data already in hand.
    var view = buildPublicEvent_(event, slots, signups.concat([record]), makeWhenFormatter_(getConfig_().timeZone));
    view.questions = questions;
    cachePublicEvent_(event.eventId, view);
  } finally {
    lock.releaseLock();
  }

  var config = getConfig_();
  var organizerEmail = String(event.organizerEmail || '').trim();
  var mailCtx = {
    event: event, slot: slot, signup: record, orgName: config.orgName,
    when: makeWhenFormatter_(config.timeZone)(slot.start, slot.end),
    filled: filled,
    waitlistPosition: waitlistPosition,
    answers: questions.map(function (q) { return [q.label, answers.value[q.label]]; }),
    cancelUrl: cancelUrl_(input.baseUrl, event.eventId, record.cancelToken),
  };

  // The sign-up is already saved; a mail failure (e.g. daily quota) must not undo it.
  var emailSent = true;
  try {
    sendEmail_(record.email, renderConfirmationEmail_(mailCtx), { replyTo: organizerEmail });
  } catch (err) {
    console.error('Confirmation email failed for signup ' + record.signupId + ': ' + err);
    emailSent = false;
  }
  if (organizerEmail) {
    try {
      sendEmail_(organizerEmail, renderOrganizerNotification_(mailCtx), { replyTo: record.email });
    } catch (err) {
      console.error('Organizer notification failed for signup ' + record.signupId + ': ' + err);
    }
  }

  return {
    ok: true,
    signupId: record.signupId,
    eventTitle: event.title,
    slotLabel: slot.label,
    when: mailCtx.when,
    location: event.location,
    email: record.email,
    emailSent: emailSent,
    organizerEmail: organizerEmail,
    waitlisted: !!waitlistPosition,
    waitlistPosition: waitlistPosition,
  };
}

/** Returns fn(start, end) → "Sat, Oct 17, 2026, 9:00 AM – 10:00 AM". */
function makeWhenFormatter_(timeZone) {
  return function (start, end) {
    var s = new Date(start);
    if (!start || isNaN(s.getTime())) return String(start || '');
    var text = Utilities.formatDate(s, timeZone, 'EEE, MMM d, yyyy, h:mm a');
    var e = new Date(end);
    if (end && !isNaN(e.getTime())) text += ' – ' + Utilities.formatDate(e, timeZone, 'h:mm a');
    return text;
  };
}
