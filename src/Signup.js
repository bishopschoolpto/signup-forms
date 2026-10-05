/**
 * Pure sign-up rules. Nothing in this file touches Google services, so it is
 * fully covered by the Node unit tests.
 */

// waitlisted: wants a spot in a full slot; organizers change it to confirmed to give them one.
var SIGNUP_STATUS = { CONFIRMED: 'confirmed', CANCELLED: 'cancelled', WAITLISTED: 'waitlisted' };

var FIELD_LIMITS = { name: 100, email: 254, phone: 30, note: 500 };

var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Validates and trims raw form input.
 * Returns { ok: true, value } or { ok: false, fieldErrors }.
 */
function validateSignupInput_(input) {
  input = input || {};
  var value = {
    eventId: String(input.eventId || '').trim(),
    slotId: String(input.slotId || '').trim(),
    name: String(input.name || '').trim().replace(/\s+/g, ' '),
    email: normalizeEmail_(input.email),
    phone: String(input.phone || '').trim(),
    note: String(input.note || '').trim(),
    waitlist: input.waitlist === true,
    baseUrl: String(input.baseUrl || '').slice(0, 500), // the page signed up on, for the cancel link
  };
  var fieldErrors = {};

  if (!value.eventId) fieldErrors.eventId = 'Missing event.';
  if (!value.slotId) fieldErrors.slotId = 'Please choose a slot.';
  if (!value.name) fieldErrors.name = 'Please enter your name.';
  if (!value.email) fieldErrors.email = 'Please enter your email.';
  else if (!EMAIL_PATTERN.test(value.email)) fieldErrors.email = 'Please enter a valid email address.';
  if (value.phone && !/^[0-9+().\-\s]+$/.test(value.phone)) {
    fieldErrors.phone = 'Phone can only contain digits, spaces, and + ( ) - .';
  }
  Object.keys(FIELD_LIMITS).forEach(function (field) {
    if (!fieldErrors[field] && value[field].length > FIELD_LIMITS[field]) {
      fieldErrors[field] = 'Must be ' + FIELD_LIMITS[field] + ' characters or fewer.';
    }
  });

  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors: fieldErrors };
  return { ok: true, value: value };
}

function confirmedSignupsForSlot_(signups, slotId) {
  return signupsForSlot_(signups, slotId, SIGNUP_STATUS.CONFIRMED);
}

function signupsForSlot_(signups, slotId, status) {
  return signups.filter(function (s) {
    return s.slotId === slotId && s.status === status;
  });
}

/** Usable slots (with an id and label), soonest first. */
function usableSlots_(slots) {
  return slots
    .filter(function (s) { return s.slotId && s.label; })
    .sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
}

/** True if the event has slots and every one is full. */
function allSlotsFull_(slots, signups) {
  var usable = usableSlots_(slots);
  return usable.length > 0 && usable.every(function (slot) {
    return confirmedSignupsForSlot_(signups, slot.slotId).length >= slot.capacity;
  });
}

/**
 * The waitlist opens only when every slot of an open event is full, so
 * volunteers take free spots first.
 */
function isWaitlistOpen_(event, slots, signups) {
  return !!event && !!event.isOpen && allSlotsFull_(slots, signups);
}

/**
 * Decides whether a (validated) sign-up, or waitlist entry if
 * input.waitlist, may be recorded. event.isOpen says whether the event takes
 * sign-ups (from its folder; see EVENT_STATE). slots (all of the event's) is
 * needed for waitlist entries. Must be called with fresh data while holding
 * the script lock.
 */
function decideSignup_(event, slot, signups, input, slots) {
  if (!event || !slot || !slot.label) {
    return { ok: false, error: 'NOT_FOUND', message: 'That slot no longer exists.' };
  }
  if (!event.isOpen) {
    return { ok: false, error: 'CLOSED', message: 'Sign-ups for this event are closed.' };
  }
  var taken = confirmedSignupsForSlot_(signups, slot.slotId);
  var hasEmail = function (s) { return normalizeEmail_(s.email) === input.email; };
  if (taken.some(hasEmail)) {
    return { ok: false, error: 'DUPLICATE', message: 'You are already signed up for this slot.' };
  }
  if (input.waitlist) {
    if (signupsForSlot_(signups, slot.slotId, SIGNUP_STATUS.WAITLISTED).some(hasEmail)) {
      return { ok: false, error: 'DUPLICATE', message: 'You are already on the waitlist for this slot.' };
    }
    if (!isWaitlistOpen_(event, slots || [slot], signups)) {
      return { ok: false, error: 'SPOTS_OPEN', message: 'Good news: a spot is open now, so there\'s no need for the waitlist. Please sign up for it.' };
    }
    return { ok: true };
  }
  if (taken.length >= slot.capacity) {
    return { ok: false, error: 'SLOT_FULL', message: 'Sorry, that slot just filled up. Please pick another.' };
  }
  return { ok: true };
}

/** "Jane Doe" → "Jane D."; public pages never show full names or contact info. */
function publicDisplayName_(fullName) {
  var parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Volunteer';
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

/**
 * Builds the public view of one event: slots in time order with fill counts
 * and display names. Contains no emails or phone numbers.
 */
function buildPublicEvent_(event, slots, signups, formatWhen) {
  var usable = usableSlots_(slots);

  return {
    eventId: event.eventId,
    title: event.title,
    description: event.description,
    location: event.location,
    isOpen: !!event.isOpen,
    allSlotsFull: allSlotsFull_(slots, signups),
    waitlistOpen: isWaitlistOpen_(event, slots, signups),
    // Sheet values (ISO for dates) of the first and last slot, for the home page's event list.
    startsAt: usable.length ? String(usable[0].start || '') : '',
    endsAt: usable.length ? String(usable[usable.length - 1].end || usable[usable.length - 1].start || '') : '',
    slots: usable.map(function (slot) {
      var taken = confirmedSignupsForSlot_(signups, slot.slotId);
      return {
        slotId: slot.slotId,
        label: slot.label,
        when: formatWhen(slot.start, slot.end),
        capacity: slot.capacity,
        filled: taken.length,
        remaining: Math.max(0, slot.capacity - taken.length),
        waitlisted: signupsForSlot_(signups, slot.slotId, SIGNUP_STATUS.WAITLISTED).length,
        volunteers: taken.map(function (s) { return publicDisplayName_(s.name); }),
      };
    }),
  };
}

/**
 * One line of the home page's list of open events, from an event's public
 * view: no slots or names, just what helps someone pick an event. formatDay
 * turns a date value into e.g. "Sat, Oct 17, 2026" ('' if it isn't a date).
 */
function summarizeEvent_(view, formatDay) {
  var first = formatDay(view.startsAt);
  var last = formatDay(view.endsAt);
  return {
    eventId: view.eventId,
    title: view.title,
    location: view.location,
    dates: first && last && last !== first ? first + ' – ' + last : first,
    startsAt: view.startsAt,
    waitlistOpen: !!view.allSlotsFull, // only open events are listed
    spotsLeft: view.slots.reduce(function (sum, s) { return sum + s.remaining; }, 0),
  };
}

/** Open events with spots left or an open waitlist, soonest first; events without dates go last. */
function listOpenSummaries_(summaries) {
  var time = function (s) {
    var t = new Date(s.startsAt).getTime();
    return isNaN(t) ? Infinity : t;
  };
  return summaries
    .filter(function (s) { return s.spotsLeft > 0 || s.waitlistOpen; })
    .sort(function (a, b) { return time(a) - time(b) || String(a.title).localeCompare(String(b.title)); });
}

/**
 * Sheets treats text starting with = + - @ as a formula. Prefixing with an
 * apostrophe stores it as plain text, preventing formula injection.
 */
function sanitizeForSheet_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}
