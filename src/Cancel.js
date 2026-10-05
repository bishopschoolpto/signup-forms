/**
 * Volunteers cancel their own sign-ups with the link in their confirmation
 * email: <page>?event=<id>&cancel=<cancelToken>. The token is a random UUID
 * stored only in the Signups tab and that email, so the link works without
 * an account and nobody else can cancel. Opening the link only shows the
 * sign-up (getCancellation); cancelling takes a click (cancelSignup), so email
 * scanners that open links can't cancel anything.
 *
 * When a confirmed volunteer cancels, the freed spot goes straight to the
 * earliest person on that slot's waitlist (in the same locked step, so nobody
 * else can take it first), and they're emailed that they're confirmed.
 */
var CANCEL_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cancelUrl_(baseUrl, eventId, token) {
  return eventPageUrl_(baseUrl, eventId) + '&cancel=' + encodeURIComponent(token);
}

/** The event's sign-up page, on the page the request came from (see pageBaseUrl_). */
function eventPageUrl_(baseUrl, eventId) {
  return pageBaseUrl_(baseUrl) + '?event=' + encodeURIComponent(eventId);
}

/**
 * Finds the sign-up a cancel link points to. Returns { ss, event, signup,
 * signups } or { error } with NOT_FOUND. Works for open and past events.
 */
function findCancellation_(request, signups) {
  var eventId = String((request && request.eventId) || '').trim();
  var token = String((request && request.token) || '').trim();
  if (!CANCEL_TOKEN_PATTERN.test(token)) return { error: 'NOT_FOUND' };
  var ss = openEventSpreadsheet_(eventId);
  var event = ss ? readEventInfo_(ss) : null;
  if (!event) return { error: 'NOT_FOUND' };
  signups = signups || readTable_(ss, 'Signups');
  var signup = signups.filter(function (s) { return String(s.cancelToken || '') === token; })[0];
  if (!signup) return { error: 'NOT_FOUND' };
  return { ss: ss, event: event, signup: signup, signups: signups };
}

var CANCEL_NOT_FOUND = {
  ok: false, error: 'NOT_FOUND',
  message: 'We couldn\'t find that sign-up. The link may be incomplete: try opening it again from your email.',
};

/** What the cancel page shows: the sign-up's event, slot, time, place and status. Changes nothing. */
function getCancellation(request) {
  var found = findCancellation_(request);
  if (found.error) return CANCEL_NOT_FOUND;
  return cancellationDetails_(found);
}

function cancellationDetails_(found) {
  var slot = findById_(readTable_(found.ss, 'Slots'), 'slotId', found.signup.slotId);
  return {
    ok: true,
    eventId: found.event.eventId,
    eventTitle: found.event.title,
    slotLabel: found.signup.slotLabel || (slot && slot.label) || '',
    when: slot ? makeWhenFormatter_(getConfig_().timeZone)(slot.start, slot.end) : '',
    location: found.event.location,
    firstName: String(found.signup.name || '').split(' ')[0],
    status: found.signup.status,
  };
}

/**
 * Cancels the sign-up a cancel link points to: its status becomes
 * "cancelled", the freed spot goes to the next person on the slot's waitlist
 * (if any), and everyone involved is emailed.
 * Returns { ok: true, ...details } or { ok: false, error, message }
 * (ALREADY_CANCELLED, NOT_FOUND, BUSY).
 */
function cancelSignup(request) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, error: 'BUSY', message: 'Lots of people are signing up right now. Please try again in a moment.' };
  }
  var found, details, wasStatus, waitlist, slot;
  var promoted = [];
  try {
    found = findCancellation_(request);
    if (found.error) return CANCEL_NOT_FOUND;
    details = cancellationDetails_(found);
    wasStatus = found.signup.status;
    if (wasStatus === SIGNUP_STATUS.CANCELLED) {
      details.ok = false;
      details.error = 'ALREADY_CANCELLED';
      details.message = 'This sign-up was already cancelled.';
      return details;
    }
    var sheet = getTab_(found.ss, 'Signups');
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    var statusCol = headers.indexOf('status') + 1;
    var setStatus = function (signup, status) {
      sheet.getRange(signup._row, statusCol).setValue(status);
      signup.status = status;
    };
    setStatus(found.signup, SIGNUP_STATUS.CANCELLED);

    // Give freed spots to the slot's waitlist, earliest first (rows are in sign-up order).
    slot = findById_(readTable_(found.ss, 'Slots'), 'slotId', found.signup.slotId);
    waitlist = signupsForSlot_(found.signups, found.signup.slotId, SIGNUP_STATUS.WAITLISTED);
    if (wasStatus === SIGNUP_STATUS.CONFIRMED && slot) {
      while (waitlist.length && confirmedSignupsForSlot_(found.signups, slot.slotId).length < slot.capacity) {
        var next = waitlist.shift();
        setStatus(next, SIGNUP_STATUS.CONFIRMED);
        promoted.push(next);
      }
    }
    SpreadsheetApp.flush();
    refreshCachedView_(found);
  } finally {
    lock.releaseLock();
  }

  var config = getConfig_();
  var organizerEmail = String(found.event.organizerEmail || '').trim();
  var ctx = {
    details: details, event: found.event, signup: found.signup, orgName: config.orgName, wasStatus: wasStatus,
    eventUrl: eventPageUrl_(request && request.baseUrl, found.event.eventId),
    waitlist: waitlist, promoted: promoted,
    filled: confirmedSignupsForSlot_(found.signups, found.signup.slotId).length, capacity: slot ? slot.capacity : 0,
  };
  try {
    sendEmail_(found.signup.email, renderCancellationEmail_(ctx), { replyTo: organizerEmail });
  } catch (err) {
    console.error('Cancellation email failed for signup ' + found.signup.signupId + ': ' + err);
  }
  promoted.forEach(function (signup) {
    try {
      sendEmail_(signup.email, renderConfirmationEmail_({
        event: found.event, slot: slot, signup: signup, orgName: config.orgName, promoted: true,
        when: details.when, cancelUrl: cancelUrl_('', found.event.eventId, signup.cancelToken),
        eventUrl: eventPageUrl_('', found.event.eventId),
      }), { replyTo: organizerEmail });
    } catch (err) {
      console.error('Promotion email failed for signup ' + signup.signupId + ': ' + err);
    }
  });
  if (organizerEmail) {
    try {
      sendEmail_(organizerEmail, renderOrganizerCancellation_(ctx), { replyTo: found.signup.email });
    } catch (err) {
      console.error('Organizer cancellation notice failed for signup ' + found.signup.signupId + ': ' + err);
    }
  }
  return details;
}

/** Puts the event's updated public view in the cache (its open/closed state is applied when served). */
function refreshCachedView_(found) {
  var view = buildPublicEvent_(found.event, readTable_(found.ss, 'Slots'), found.signups, makeWhenFormatter_(getConfig_().timeZone));
  view.questions = readQuestions_(found.ss);
  cachePublicEvent_(found.event.eventId, view);
}
