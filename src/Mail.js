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

/** True for a spreadsheet "yes" (yes, y, true, x, 1), in any case. */
function isYes_(value) {
  return /^(y|yes|true|x|1)$/i.test(String(value == null ? '' : value).trim());
}

/**
 * Fills {placeholders} in an organizer's custom email text. Unknown ones are
 * left as typed, so a typo shows up in the email instead of vanishing.
 */
function fillPlaceholders_(text, values) {
  return String(text || '').replace(/\{(\w+)\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] || '') : match;
  });
}

/**
 * Turns an organizer's message into { text, html }, with a small Markdown
 * subset for HTML emails:
 *   [words](https://…)        a link on those words  → text: "words (https://…)"
 *   ![description](https://…) an image, fit to width  → text: "[description]"
 * plus clickable bare https:// links and kept line breaks. Everything else is
 * escaped, so no other HTML gets in. The Markdown is read from the template
 * before {placeholders} are filled, so volunteers' details ({name}, …) can't
 * become links or images; the only placeholders allowed in an address are
 * {cancelLink}, {eventLink} and {spreadsheetLink}, which the app makes itself.
 * Only http(s) addresses work.
 */
function renderMessage_(template, values) {
  var source = String(template == null ? '' : template).trim();
  var markdown = /(!?)\[([^\]\n]*)\]\(([^()\s]+)\)/g;
  var urlOnly = { cancelLink: values.cancelLink || '', spreadsheetLink: values.spreadsheetLink || '', eventLink: values.eventLink || '' };
  var text = '';
  var html = '';
  var last = 0;
  var match;
  var addText = function (raw) {
    var filled = fillPlaceholders_(raw, values);
    text += filled;
    html += textToHtml_(filled);
  };
  while ((match = markdown.exec(source))) {
    var isImage = match[1] === '!';
    var label = fillPlaceholders_(match[2], values).trim();
    var url = fillPlaceholders_(match[3], urlOnly);
    if (!/^https?:\/\/[^\s"'<>]+$/.test(url)) continue; // not a usable address: left as typed
    addText(source.slice(last, match.index));
    if (isImage) {
      html += '<img src="' + escapeHtml_(url) + '" alt="' + escapeHtml_(label) + '" style="max-width:100%;height:auto;border:0">';
      text += '[' + (label || 'image') + ']';
    } else {
      html += '<a href="' + escapeHtml_(url) + '">' + escapeHtml_(label || url) + '</a>';
      text += label ? label + ' (' + url + ')' : url;
    }
    last = match.index + match[0].length;
  }
  addText(source.slice(last));
  return { text: text.trim(), html: html.trim() };
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
 * {firstName} {name} {email} {phone} {event} {slot} {when} {location}
 * {cancelLink}. If confirmationMessageOnly is yes, the message is
 * the whole confirmation email (not for waitlist or promotion emails).
 */
function renderConfirmationEmail_(ctx) {
  var firstName = String(ctx.signup.name).split(' ')[0];
  var organizerEmail = String(ctx.event.organizerEmail || '').trim();
  var values = {
    firstName: firstName, name: ctx.signup.name, email: ctx.signup.email, phone: ctx.signup.phone,
    event: ctx.event.title, slot: ctx.slot.label, when: ctx.when, location: ctx.event.location,
    cancelLink: ctx.cancelUrl || '', eventLink: ctx.eventUrl || '',
  };
  var waitlisted = !!ctx.waitlistPosition;
  var customSubject = waitlisted || ctx.promoted ? '' : fillPlaceholders_(ctx.event.confirmationSubject, values).replace(/\s+/g, ' ').trim();
  var subject = customSubject
    ? customSubject.slice(0, MAX_SUBJECT_LENGTH)
    : (waitlisted ? 'You\'re on the waitlist: ' : ctx.promoted ? 'A spot opened up – you\'re in: ' : 'You\'re signed up: ') +
      ctx.event.title + ' – ' + ctx.slot.label;
  var custom = waitlisted
    ? renderMessage_('You\'re not confirmed yet. If a spot opens up, you\'ll get an email.', {})
    : renderMessage_(ctx.event.confirmationMessage, values);
  var message = custom.text;
  var intro = waitlisted
    ? 'Thanks for offering to help! Every spot is taken right now, so you\'re #' + ctx.waitlistPosition + ' on the waitlist for:'
    : ctx.promoted
      ? 'Good news! A spot opened up, so you\'re off the waitlist and confirmed for:'
      : 'Thanks for volunteering! You\'re confirmed for:';

  // confirmationMessageOnly: the organizer's message is the whole email (if they wrote one).
  if (!waitlisted && !ctx.promoted && message && isYes_(ctx.event.confirmationMessageOnly)) {
    return messageOnlyEmail_(subject, custom);
  }

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
    .concat(ctx.eventUrl ? ['', EVENT_LINK_TEXT + ': ' + ctx.eventUrl] : [])
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
    (message ? '<p>' + custom.html + '</p>' : '') +
    (ctx.eventUrl ? '<p><a href="' + escapeHtml_(ctx.eventUrl) + '">' + EVENT_LINK_TEXT + '</a></p>' : '') +
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
/**
 * Organizers can customize this email with the event fields
 * cancellationSubject, cancellationMessage (added after the details; links and
 * pictures work) and cancellationMessageOnly (yes = the message is the whole
 * email), using the same placeholders as the confirmation email except
 * {cancelLink}. It applies to cancelled sign-ups and to leaving the waitlist.
 */
function renderCancellationEmail_(ctx) {
  var d = ctx.details;
  var event = ctx.event || {};
  var values = {
    firstName: d.firstName, name: ctx.signup.name, email: ctx.signup.email, phone: ctx.signup.phone,
    event: d.eventTitle, slot: d.slotLabel, when: d.when, location: d.location, eventLink: ctx.eventUrl || '',
  };
  var customSubject = fillPlaceholders_(event.cancellationSubject, values).replace(/\s+/g, ' ').trim();
  var subject = customSubject ? customSubject.slice(0, MAX_SUBJECT_LENGTH) : 'Cancelled: ' + d.eventTitle + ' – ' + d.slotLabel;
  var custom = renderMessage_(event.cancellationMessage, values);
  if (custom.text && isYes_(event.cancellationMessageOnly)) return messageOnlyEmail_(subject, custom);

  var what = ctx.wasStatus === SIGNUP_STATUS.WAITLISTED ? 'your waitlist entry' : 'your sign-up';
  var before = ['Hi ' + d.firstName + ',', '', 'We\'ve cancelled ' + what + ' for:', '']
    .concat([['Event', d.eventTitle], ['Slot', d.slotLabel], ['When', d.when]]
      .filter(function (r) { return r[1]; }).map(function (r) { return r[0] + ': ' + r[1]; }));
  var thanks = 'Thanks for letting us know. If this was a mistake, sign up again on the event page';
  var signOff = ['– ' + ctx.orgName];
  var body = before.concat(custom.text ? ['', custom.text] : [])
    .concat(['', thanks + (ctx.eventUrl ? ': ' + ctx.eventUrl : '.'), ''], signOff).join('\n');
  var htmlBody = EMAIL_DIV + paragraphsHtml_(before) + (custom.html ? '<p>' + custom.html + '</p>' : '') +
    '<p>' + escapeHtml_(thanks.replace(/event page$/, '')) +
    (ctx.eventUrl ? '<a href="' + escapeHtml_(ctx.eventUrl) + '">event page</a>' : 'event page') + '.</p>' +
    paragraphsHtml_(signOff) + '</div>';
  return { subject: subject, body: body, htmlBody: htmlBody };
}

var EMAIL_DIV = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;max-width:560px">';

/** An email that is only the organizer's rendered message ({ text, html } from renderMessage_). */
function messageOnlyEmail_(subject, custom) {
  return {
    subject: subject,
    body: custom.text,
    htmlBody: EMAIL_DIV + '<p>' + custom.html.replace(/(<br>){2,}/g, '</p><p>') + '</p></div>',
  };
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
  lines.push('', 'Their row in the Signups tab now says "cancelled". Reply to this email to contact ' + signup.name + '.');
  var signOff = ['– ' + ctx.orgName + ' volunteer sign-up'];
  return {
    subject: subject,
    body: lines.concat(['', organizerLinksText_(ctx.eventUrl, d.eventId), ''], signOff).join('\n'),
    htmlBody: EMAIL_DIV + paragraphsHtml_(lines) + organizerLinksHtml_(ctx.eventUrl, d.eventId) + paragraphsHtml_(signOff) + '</div>',
  };
}

var SPREADSHEET_LINK_TEXT = 'Open the event spreadsheet';

/** The event spreadsheet's address. Only ever sent to organizers. */
function spreadsheetUrl_(eventId) {
  return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(eventId) + '/edit';
}

var EVENT_LINK_TEXT = 'View the event page';

/** Organizer emails' links: the event page (if known) and the event spreadsheet. */
function organizerLinksText_(eventUrl, eventId) {
  return (eventUrl ? 'Open the event page: ' + eventUrl + '\n' : '') + SPREADSHEET_LINK_TEXT + ': ' + spreadsheetUrl_(eventId);
}

function organizerLinksHtml_(eventUrl, eventId) {
  return '<p>' + (eventUrl ? '<a href="' + escapeHtml_(eventUrl) + '">Open the event page</a> · ' : '') +
    '<a href="' + escapeHtml_(spreadsheetUrl_(eventId)) + '">' + SPREADSHEET_LINK_TEXT + '</a></p>';
}

/** Simple HTML version of plain-text email lines (blank lines separate paragraphs). */
function plainEmailHtml_(lines) {
  return EMAIL_DIV + paragraphsHtml_(lines) + '</div>';
}

/** <p> paragraphs from plain-text lines (blank lines separate paragraphs), escaped. */
function paragraphsHtml_(lines) {
  return lines.join('\n').split(/\n{2,}/).filter(function (para) { return para.trim(); }).map(function (para) {
    return '<p>' + escapeHtml_(para).replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

/**
 * Returns { subject, htmlBody, body } telling the organizer about a new
 * sign-up, including the volunteer's contact details and a link to the event
 * spreadsheet ({spreadsheetLink} in organizerSubject/organizerMessage).
 */
function renderOrganizerNotification_(ctx) {
  var signup = ctx.signup;
  var waitlisted = !!ctx.waitlistPosition;
  // Organizers can set the subject (event field organizerSubject) and add a note
  // below the details (organizerMessage), with the volunteer's details as placeholders.
  var values = {
    firstName: String(signup.name).split(' ')[0], name: signup.name, email: signup.email, phone: signup.phone,
    event: ctx.event.title, slot: ctx.slot.label, when: ctx.when, location: ctx.event.location,
    spreadsheetLink: spreadsheetUrl_(ctx.event.eventId), eventLink: ctx.eventUrl || '',
  };
  var customSubject = fillPlaceholders_(ctx.event.organizerSubject, values).replace(/\s+/g, ' ').trim();
  var subject = customSubject
    ? ((waitlisted ? 'Waitlist: ' : '') + customSubject).slice(0, MAX_SUBJECT_LENGTH)
    : (waitlisted ? 'Waitlist: ' : 'New sign-up: ') + ctx.event.title + ' – ' + ctx.slot.label + ' (' + signup.name + ')';
  var custom = renderMessage_(ctx.event.organizerMessage, values);
  var message = custom.text;
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
      '', organizerLinksText_(ctx.eventUrl, ctx.event.eventId),
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
    (message ? '<p>' + custom.html + '</p>' : '') +
    '<p>Reply to this email to contact ' + escapeHtml_(signup.name) + '.' +
    (waitlisted ? ' To give them a spot, change their status in the Signups tab to <strong>confirmed</strong> and let them know.' : '') + '</p>' +
    organizerLinksHtml_(ctx.eventUrl, ctx.event.eventId) +
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
