/**
 * Email templates (pure) and sending (MailApp).
 */

function escapeHtml_(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

var MAX_SUBJECT_LENGTH = 200;

/**
 * Fills {placeholders} in an organizer's custom email text. Unknown ones are
 * left as typed, so a typo shows up in the email instead of vanishing.
 */
function fillPlaceholders_(text, values) {
  return String(text || '').replace(/\{(\w+)\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] || '') : match;
  });
}

/** Escapes text for HTML, keeping line breaks and making http(s) links clickable. */
function textToHtml_(text) {
  var urlPattern = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g;
  var source = String(text);
  var html = '';
  var last = 0;
  var match;
  while ((match = urlPattern.exec(source))) {
    var url = escapeHtml_(match[0]);
    html += escapeHtml_(source.slice(last, match.index)) + '<a href="' + url + '">' + url + '</a>';
    last = match.index + match[0].length;
  }
  return (html + escapeHtml_(source.slice(last))).replace(/\r?\n/g, '<br>');
}

/**
 * Returns { subject, htmlBody, body } for a sign-up confirmation; for a
 * waitlist entry if ctx.waitlistPosition (then the organizer's custom subject
 * and message, written for confirmed volunteers, are left out); or for
 * someone just moved off the waitlist if ctx.promoted (own subject and intro,
 * with the organizer's message). Organizers
 * can set the subject (event field confirmationSubject) and add a message
 * below the details (confirmationMessage); both may use the placeholders
 * {firstName} {name} {email} {phone} {event} {slot} {when} {location}.
 */
function renderConfirmationEmail_(ctx) {
  var firstName = String(ctx.signup.name).split(' ')[0];
  var organizerEmail = String(ctx.event.organizerEmail || '').trim();
  var values = {
    firstName: firstName, name: ctx.signup.name, email: ctx.signup.email, phone: ctx.signup.phone,
    event: ctx.event.title, slot: ctx.slot.label, when: ctx.when, location: ctx.event.location,
  };
  var waitlisted = !!ctx.waitlistPosition;
  var customSubject = waitlisted || ctx.promoted ? '' : fillPlaceholders_(ctx.event.confirmationSubject, values).replace(/\s+/g, ' ').trim();
  var subject = customSubject
    ? customSubject.slice(0, MAX_SUBJECT_LENGTH)
    : (waitlisted ? 'You\'re on the waitlist: ' : ctx.promoted ? 'A spot opened up – you\'re in: ' : 'You\'re signed up: ') +
      ctx.event.title + ' – ' + ctx.slot.label;
  var message = waitlisted
    ? 'You\'re not confirmed yet. If a spot opens up, you\'ll get an email.'
    : fillPlaceholders_(ctx.event.confirmationMessage, values).trim();
  var intro = waitlisted
    ? 'Thanks for offering to help! Every spot is taken right now, so you\'re #' + ctx.waitlistPosition + ' on the waitlist for:'
    : ctx.promoted
      ? 'Good news! A spot opened up, so you\'re off the waitlist and confirmed for:'
      : 'Thanks for volunteering! You\'re confirmed for:';

  var details = [
    ['Event', ctx.event.title],
    ['Slot', ctx.slot.label],
    ['When', ctx.when],
    ['Where', ctx.event.location],
  ].filter(function (row) { return row[1]; });

  var body = [
    'Hi ' + firstName + ',',
    '',
    intro,
    '',
  ].concat(details.map(function (row) { return row[0] + ': ' + row[1]; }))
    .concat(message ? ['', message] : [])
    .concat(organizerEmail ? ['', 'Need to change something? Email the organizer at ' + organizerEmail + '.'] : [])
    .concat(ctx.cancelUrl ? ['', CANCEL_PROMPT + ' ' + ctx.cancelUrl] : [])
    .concat(['', '– ' + ctx.orgName])
    .join('\n');

  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;max-width:560px">' +
    '<p>Hi ' + escapeHtml_(firstName) + ',</p>' +
    '<p>' + escapeHtml_(intro) + '</p>' +
    '<table style="border-collapse:collapse;margin:8px 0 16px">' +
    details.map(function (row) {
      return '<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top">' + escapeHtml_(row[0]) +
        '</td><td style="padding:4px 0;font-weight:600">' + escapeHtml_(row[1]) + '</td></tr>';
    }).join('') +
    '</table>' +
    (message ? '<p>' + textToHtml_(message) + '</p>' : '') +
    (organizerEmail
      ? '<p>Need to change something? Email the organizer at <a href="mailto:' + escapeHtml_(organizerEmail) + '">' +
        escapeHtml_(organizerEmail) + '</a>.</p>'
      : '') +
    (ctx.cancelUrl
      ? '<p>' + CANCEL_PROMPT + ' <a href="' + escapeHtml_(ctx.cancelUrl) + '">Cancel your sign-up</a>.</p>'
      : '') +
    '<p style="color:#6b7280">– ' + escapeHtml_(ctx.orgName) + '</p>' +
    '</div>';

  return { subject: subject, htmlBody: htmlBody, body: body };
}

var CANCEL_PROMPT = 'Can\'t make it? Please let us know so someone else can take your spot:';

/** Returns { subject, htmlBody, body } telling a volunteer their sign-up (or waitlist entry) is cancelled. */
function renderCancellationEmail_(ctx) {
  var d = ctx.details;
  var what = ctx.wasStatus === SIGNUP_STATUS.WAITLISTED ? 'your waitlist entry' : 'your sign-up';
  var subject = 'Cancelled: ' + d.eventTitle + ' – ' + d.slotLabel;
  var lines = ['Hi ' + d.firstName + ',', '', 'We\'ve cancelled ' + what + ' for:', '']
    .concat([['Event', d.eventTitle], ['Slot', d.slotLabel], ['When', d.when]]
      .filter(function (r) { return r[1]; }).map(function (r) { return r[0] + ': ' + r[1]; }))
    .concat(['', 'Thanks for letting us know. If this was a mistake, sign up again on the event\'s page.', '', '– ' + ctx.orgName]);
  return { subject: subject, body: lines.join('\n'), htmlBody: plainEmailHtml_(lines) };
}

/**
 * Returns { subject, htmlBody, body } telling the organizer about a
 * cancellation, and who's next on the slot's waitlist if a spot opened.
 */
function renderOrganizerCancellation_(ctx) {
  var d = ctx.details;
  var signup = ctx.signup;
  var wasWaitlisted = ctx.wasStatus === SIGNUP_STATUS.WAITLISTED;
  var promotedNote = ctx.promoted && ctx.promoted.length ? ' → ' + ctx.promoted.map(function (p) { return p.name; }).join(', ') + ' moved up' : '';
  var subject = (wasWaitlisted ? 'Left the waitlist: ' : 'Cancellation: ') + d.eventTitle + ' – ' + d.slotLabel + ' (' + signup.name + ')' + promotedNote;
  var lines = [signup.name + (wasWaitlisted ? ' left the waitlist for ' : ' cancelled their sign-up for ') + d.slotLabel +
    (d.when ? ' (' + d.when + ')' : '') + '.', ''];
  if (!wasWaitlisted) {
    (ctx.promoted || []).forEach(function (p) {
      lines.push(p.name + ' (' + p.email + ') was next on the waitlist, so they now have the spot. We emailed them.');
    });
    lines.push((ctx.promoted && ctx.promoted.length ? '' : 'A spot opened: ') +
      ctx.filled + ' of ' + ctx.capacity + ' spots are filled now' +
      (ctx.waitlist.length ? ', and ' + ctx.waitlist.length + ' still on the waitlist.' : '.'));
  }
  lines.push('', 'Their row in the Signups tab now says "cancelled". Reply to this email to contact ' + signup.name + '.',
    '', '– ' + ctx.orgName + ' volunteer sign-up');
  return { subject: subject, body: lines.join('\n'), htmlBody: plainEmailHtml_(lines) };
}

/** Simple HTML version of plain-text email lines (blank lines separate paragraphs). */
function plainEmailHtml_(lines) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;max-width:560px">' +
    lines.join('\n').split(/\n{2,}/).map(function (para) {
      return '<p>' + escapeHtml_(para).replace(/\n/g, '<br>') + '</p>';
    }).join('') + '</div>';
}

/**
 * Returns { subject, htmlBody, body } telling the organizer about a new
 * sign-up, including the volunteer's contact details.
 */
function renderOrganizerNotification_(ctx) {
  var signup = ctx.signup;
  var waitlisted = !!ctx.waitlistPosition;
  // Organizers can set the subject (event field organizerSubject) and add a note
  // below the details (organizerMessage), with the volunteer's details as placeholders.
  var values = {
    firstName: String(signup.name).split(' ')[0], name: signup.name, email: signup.email, phone: signup.phone,
    event: ctx.event.title, slot: ctx.slot.label, when: ctx.when, location: ctx.event.location,
  };
  var customSubject = fillPlaceholders_(ctx.event.organizerSubject, values).replace(/\s+/g, ' ').trim();
  var subject = customSubject
    ? ((waitlisted ? 'Waitlist: ' : '') + customSubject).slice(0, MAX_SUBJECT_LENGTH)
    : (waitlisted ? 'Waitlist: ' : 'New sign-up: ') + ctx.event.title + ' – ' + ctx.slot.label + ' (' + signup.name + ')';
  var message = fillPlaceholders_(ctx.event.organizerMessage, values).trim();
  var fill = waitlisted
    ? 'Full (' + ctx.filled + ' of ' + ctx.slot.capacity + ') – #' + ctx.waitlistPosition + ' on the waitlist (moved up automatically if someone cancels)'
    : ctx.filled + ' of ' + ctx.slot.capacity + ' spots filled' + (ctx.filled >= ctx.slot.capacity ? ' – this slot is now full' : '');
  var headline = waitlisted ? ' joined the waitlist.' : ' signed up to volunteer.';

  var details = [
    ['Name', signup.name],
    ['Email', signup.email],
    ['Phone', signup.phone],
    ['Note', signup.note],
  ].concat(ctx.answers || []).concat([
    ['Event', ctx.event.title],
    ['Slot', ctx.slot.label],
    ['When', ctx.when],
    ['Status', fill],
  ]).filter(function (row) { return row[1]; });

  var body = [signup.name + headline, '']
    .concat(details.map(function (row) { return row[0] + ': ' + row[1]; }))
    .concat(message ? ['', message] : [])
    .concat(['', 'Reply to this email to contact ' + signup.name + '.' +
      (waitlisted ? ' To give them a spot, change their status in the Signups tab to "confirmed" and let them know.' : ''),
      '', '– ' + ctx.orgName + ' volunteer sign-up'])
    .join('\n');

  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;max-width:560px">' +
    '<p><strong>' + escapeHtml_(signup.name) + '</strong>' + escapeHtml_(headline) + '</p>' +
    '<table style="border-collapse:collapse;margin:8px 0 16px">' +
    details.map(function (row) {
      return '<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top">' + escapeHtml_(row[0]) +
        '</td><td style="padding:4px 0;white-space:pre-line">' + escapeHtml_(row[1]) + '</td></tr>';
    }).join('') +
    '</table>' +
    (message ? '<p>' + textToHtml_(message) + '</p>' : '') +
    '<p>Reply to this email to contact ' + escapeHtml_(signup.name) + '.' +
    (waitlisted ? ' To give them a spot, change their status in the Signups tab to <strong>confirmed</strong> and let them know.' : '') + '</p>' +
    '<p style="color:#6b7280">– ' + escapeHtml_(ctx.orgName) + ' volunteer sign-up</p>' +
    '</div>';

  return { subject: subject, htmlBody: htmlBody, body: body };
}

/**
 * Sends an email, honoring MAIL_REDIRECT_TO so test deployments never
 * email real parents.
 */
function sendEmail_(to, message, options) {
  var config = getConfig_();
  var recipient = to;
  var subject = message.subject;
  if (config.mailRedirectTo) {
    recipient = config.mailRedirectTo;
    subject = '[TEST → ' + to + '] ' + subject;
  }
  var mail = {
    to: recipient,
    subject: subject,
    body: message.body,
    htmlBody: message.htmlBody,
    name: config.orgName,
  };
  if (options && options.replyTo) mail.replyTo = options.replyTo;
  MailApp.sendEmail(mail);
}
