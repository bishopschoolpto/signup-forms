/**
 * Setup. Run setup() from the Apps Script editor, as the account that deploys
 * the web app. Safe to run again at any time: it only creates what's missing.
 *
 * It:
 *   - creates "Event Template" (organizers copy it; the app never shows it) and
 *     "Fall Book Fair (sample)" (a working example) in My Drive, or brings an
 *     existing template up to date (missing tabs, rows and columns, help notes,
 *     dropdowns) without touching anything organizers typed;
 *   - gives both a "Start here" tab explaining how to run a sign-up;
 *   - installs the 1-minute event cache refresh timer;
 *   - checks the configuration (folders, TinyURL token, test email redirect)
 *     and logs a checklist of what's left to do.
 * It can't move files (the app only reads Drive metadata), so it says where to
 * move them.
 */
function setup() {
  // setup() is public so it can be run from the editor, which also means the
  // browser could call it via google.script.run. Only the owner may run it.
  var active = Session.getActiveUser().getEmail();
  if (!active || active !== Session.getEffectiveUser().getEmail()) {
    throw new Error('setup() can only be run by the script owner.');
  }

  var props = PropertiesService.getScriptProperties();
  var result = { created: [], updated: [], checklist: [] };

  var template = openOwnSpreadsheet_(props.getProperty('TEMPLATE_ID'));
  if (!template) {
    template = createEventSpreadsheet_('Event Template', TEMPLATE_INFO, [], []);
    props.setProperty('TEMPLATE_ID', template.getId());
    result.created.push('Event Template');
    result.template = template.getUrl();
  } else {
    var changes = layoutEventSpreadsheet_(template, TEMPLATE_INFO);
    if (changes.length) result.updated.push('Event Template: ' + changes.join('; '));
  }

  var sample = openOwnSpreadsheet_(props.getProperty('SAMPLE_EVENT_ID'));
  if (!sample) {
    sample = createSampleEvent_();
    props.setProperty('SAMPLE_EVENT_ID', sample.getId());
    result.created.push('sample event');
    result.sample = sample.getUrl();
  }

  if (installRefreshTrigger_()) result.refreshTrigger = 'every minute';
  result.checklist = setupChecklist_(template, sample);

  logSetupReport_(result, template, sample);
  return result;
}

/** Event tab values for the template: everything blank but a placeholder title. */
var TEMPLATE_INFO = { title: 'Event name' };

var EVENT_FIELD_NOTES = {
  title: 'Required. Shown at the top of the sign-up page.',
  description: 'Optional. Shown under the title.',
  location: 'Optional.',
  organizerEmail: 'Optional. Gets an email for every sign-up and is shown to volunteers.',
  confirmationSubject: 'Optional. Subject of the email volunteers get. Default: You\'re signed up: {event} – {slot}',
  confirmationMessage: 'Optional. Your message, added below the sign-up details in that email. ' +
    'Can use {firstName} {name} {email} {phone} {event} {slot} {when} {location}.',
  organizerSubject: 'Optional. Subject of the email organizerEmail gets for each sign-up, e.g. [Book Fair] {name} – {slot}. ' +
    'Default: New sign-up: {event} – {slot} ({name})',
  organizerMessage: 'Optional. A note added below the volunteer\'s details in that email. ' +
    'Can use {firstName} {name} {email} {phone} {event} {slot} {when} {location}.',
};

var SLOT_HELP = 'One row per slot. start/end: date and time, e.g. 10/23/2026 9:00 AM. ' +
  'Leave slotId blank; the app fills it in. Never change a slotId once people have signed up.';

var QUESTIONS_HELP = 'Optional: questions for volunteers, one per row. type: text, paragraph, choice or checkbox. ' +
  'options: the choices for a choice question, separated by commas. required: yes or no. ' +
  'Answers appear as new columns in the Signups tab.';

/** Hover notes on table headers. */
var HEADER_NOTES = {
  Slots: {
    slotId: 'Leave blank: the app fills it in. Never change it once people have signed up.',
    label: 'The job or shift, e.g. "Setup" or "Checkout table".',
    start: 'Date and time it starts, e.g. 10/23/2026 9:00 AM.',
    end: 'Date and time it ends.',
    capacity: 'How many volunteers it needs.',
  },
  Signups: {
    signupId: 'Written by the app. Please only change the status column.',
    cancelToken: 'Secret code in this volunteer\'s cancel link (in their confirmation email). Don\'t share or change it.',
    status: 'confirmed = has the spot · waitlisted = waiting for a spot · cancelled = not coming. ' +
      'When a volunteer cancels with their email link, the next waitlisted person is confirmed automatically. ' +
      'If you cancel someone by hand, change the next person to confirmed yourself and let them know.',
  },
  Questions: {
    question: 'The question, as volunteers see it. Answers get a Signups column with this name.',
    type: 'text (short answer) · paragraph (longer answer) · choice (pick one option) · checkbox (tick a box)',
    options: 'For choice questions: the choices, separated by commas.',
    required: 'yes = volunteers must answer (or tick the box) to sign up.',
  },
};

var SIGNUP_STATUSES = ['confirmed', 'waitlisted', 'cancelled'];
var QUESTION_TYPE_NAMES = ['text', 'paragraph', 'choice', 'checkbox'];
var START_HERE_TAB = 'Start here';

/** Opens a spreadsheet this project made, or returns null if it's gone (deleted, trashed, no access). */
function openOwnSpreadsheet_(id) {
  if (!id) return null;
  try {
    if (Drive.Files.get(id, { fields: 'trashed', supportsAllDrives: true }).trashed) return null;
    return SpreadsheetApp.openById(id);
  } catch (err) {
    return null;
  }
}

/** Creates a fully laid-out event spreadsheet with the given Event values, slots and questions. */
function createEventSpreadsheet_(name, info, slots, questions) {
  var ss = SpreadsheetApp.create(name);
  ss.getSheets()[0].setName(EVENT_TAB);
  layoutEventSpreadsheet_(ss, info);

  var slotSheet = ss.getSheetByName('Slots');
  slots.forEach(function (slot) {
    slotSheet.appendRow(TABLES.Slots.map(function (h) { return h in slot ? slot[h] : ''; }));
  });
  var questionSheet = ss.getSheetByName('Questions');
  (questions || []).forEach(function (q) {
    questionSheet.appendRow(TABLES.Questions.map(function (h) { return h in q ? q[h] : ''; }));
  });
  return ss;
}

/**
 * Brings an event spreadsheet up to the current layout: Start here, Event,
 * Slots, Signups and Questions tabs, every Event field row, every table
 * column, help notes, date formats and dropdowns. Never changes values
 * organizers typed (it only removes the retired "status" row). New Event
 * rows get values from info. Returns a list of what it changed.
 */
function layoutEventSpreadsheet_(ss, info) {
  var changes = [];
  layoutStartHere_(ss, changes);
  layoutEventTab_(ss, info || {}, changes);
  layoutTable_(ss, 'Slots', SLOT_HELP, changes);
  layoutTable_(ss, 'Signups', '', changes);
  layoutTable_(ss, 'Questions', QUESTIONS_HELP, changes);

  var slots = ss.getSheetByName('Slots');
  ['start', 'end'].forEach(function (h) {
    columnBelowHeader_(slots, h).setNumberFormat('m/d/yyyy h:mm am/pm');
  });
  columnBelowHeader_(slots, 'capacity').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false)
    .setHelpText('How many volunteers this slot needs: a whole number, 0 or more.').build());
  columnBelowHeader_(ss.getSheetByName('Signups'), 'status')
    .setDataValidation(dropdown_(SIGNUP_STATUSES, 'confirmed, waitlisted or cancelled.'));
  var questions = ss.getSheetByName('Questions');
  columnBelowHeader_(questions, 'type').setDataValidation(dropdown_(QUESTION_TYPE_NAMES, 'text, paragraph, choice or checkbox.'));
  columnBelowHeader_(questions, 'required').setDataValidation(dropdown_(['yes', 'no'], 'yes or no.'));
  return changes;
}

function dropdown_(values, help) {
  return SpreadsheetApp.newDataValidation().requireValueInList(values, true)
    .setAllowInvalid(false).setHelpText('Choose ' + help).build();
}

/** Rows 2 and below of the column with this header. */
function columnBelowHeader_(sheet, header) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  return sheet.getRange(2, headers.indexOf(header) + 1, sheet.getMaxRows() - 1, 1);
}

/** The Event tab: Field | Value | Notes, one row per EVENT_FIELDS entry, no retired "status" row. */
function layoutEventTab_(ss, info, changes) {
  var sheet = ss.getSheetByName(EVENT_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(EVENT_TAB, ss.getSheetByName(START_HERE_TAB) ? 1 : 0);
    changes.push('added the Event tab');
  }
  if (!String(sheet.getRange(1, 1).getValue()).trim()) {
    sheet.getRange(1, 1, 1, 3).setValues([['Field', 'Value', 'Notes']]);
  }
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  sheet.setFrozenRows(1);

  var keys = function () {
    return sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues().map(function (r) {
      return String(r[0]).trim().toLowerCase();
    });
  };
  for (var i = keys().length; i >= 2; i--) {
    if (keys()[i - 1] === 'status') {
      sheet.deleteRow(i);
      changes.push('removed the old status row (folders decide that now)');
    }
  }
  EVENT_FIELDS.forEach(function (field) {
    var row = keys().indexOf(field.toLowerCase()) + 1;
    if (!row) {
      sheet.appendRow([field, info[field] || '', EVENT_FIELD_NOTES[field]]);
      changes.push('added the ' + field + ' row');
    } else if (String(sheet.getRange(row, 3).getValue()) !== EVENT_FIELD_NOTES[field]) {
      sheet.getRange(row, 3).setValue(EVENT_FIELD_NOTES[field]);
    }
  });
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 320);
  sheet.setColumnWidth(3, 480);
}

/** A table tab (Slots, Signups, Questions): header row with every column, notes, and help text. */
function layoutTable_(ss, name, help, changes) {
  var columns = TABLES[name];
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    changes.push('added the ' + name + ' tab');
  }
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var isHelp = function (h) { return h === SLOT_HELP || h === QUESTIONS_HELP; };
  if (headers.every(function (h) { return !h; })) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    headers = columns.slice();
  } else {
    columns.forEach(function (c) {
      if (headers.indexOf(c) !== -1) return;
      // Right after the last real column (moving any help text out of the way).
      var col = headers.filter(function (h) { return h && !isHelp(h); }).length + 1;
      sheet.getRange(1, col).setValue(c);
      headers[col - 1] = c;
      changes.push('added the ' + c + ' column to ' + name);
    });
  }
  sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  var notes = HEADER_NOTES[name] || {};
  Object.keys(notes).forEach(function (h) {
    var col = headers.indexOf(h) + 1;
    if (col) sheet.getRange(1, col).setNote(notes[h]);
  });
  if (help) {
    var helpCol = headers.filter(function (h) { return h && !isHelp(h); }).length + 2;
    if (String(sheet.getRange(1, helpCol).getValue()) !== help) {
      headers.forEach(function (h, i) { if (isHelp(h)) sheet.getRange(1, i + 1).setValue(''); });
      sheet.getRange(1, helpCol).setValue(help);
    }
  }
}

/** The "Start here" tab: how to run a sign-up, first in the spreadsheet. Rewritten to the current text. */
function layoutStartHere_(ss, changes) {
  var lines = startHereLines_();
  var sheet = ss.getSheetByName(START_HERE_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(START_HERE_TAB, 0);
    changes.push('added the Start here tab');
  } else {
    var current = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues()
      .map(function (r) { return String(r[0]); }).join('\n').replace(/\n+$/, '');
    if (current === lines.map(function (l) { return l.text; }).join('\n')) return;
    sheet.getRange(1, 1, Math.max(sheet.getLastRow(), lines.length), 1).clearContent();
    changes.push('updated the Start here tab');
  }
  sheet.getRange(1, 1, lines.length, 1).setValues(lines.map(function (l) { return [l.text]; }))
    .setWrap(true).setVerticalAlignment('top');
  lines.forEach(function (l, i) {
    if (l.heading) sheet.getRange(i + 1, 1).setFontWeight('bold').setFontSize(i === 0 ? 16 : 12);
  });
  sheet.setColumnWidth(1, 900);
}

/** The Start here tab's text: { text, heading } per row. */
function startHereLines_() {
  var config = getConfig_();
  var h = function (text) { return { text: text, heading: true }; };
  var p = function (text) { return { text: text }; };
  return [
    h('Start here: running a volunteer sign-up'),
    p('This spreadsheet is one event. Fill it in, keep it directly in the Events folder, and share the sign-up link. ' +
      'Volunteers sign up on the PTO website, and their sign-ups appear on the Signups tab.'),
    h('1. Event tab'),
    p('Fill in the Value column: title (required), description, location, and organizerEmail (gets an email for every sign-up).'),
    h('2. Slots tab'),
    p('One row per job or shift: label, start and end (date and time), and capacity (how many volunteers). ' +
      'Leave slotId blank: the app fills it in. Never change or delete a slot people have signed up for.'),
    h('3. Questions tab (optional)'),
    p('One row per question for volunteers: question, type (text, paragraph, choice or checkbox), options (for choice, ' +
      'separated by commas) and required (yes or no). Each question\'s answers get their own column on the Signups tab.'),
    h('4. Emails (optional)'),
    p('On the Event tab, confirmationSubject replaces the subject of the email volunteers get, and confirmationMessage adds your ' +
      'own note (parking, what to bring). organizerSubject and organizerMessage do the same for the email organizerEmail ' +
      'gets for each sign-up, for example to make those emails easy to filter. All four can use {firstName} {name} {email} {phone} {event} {slot} {when} {location}.'),
    h('5. Get your sign-up link'),
    p('Make sure this spreadsheet is directly in the Events folder, not in a subfolder. Then go to ' + config.siteUrl +
      ', paste this spreadsheet\'s link into "Get your sign-up link", and share the link, short link or QR code. ' +
      'The short link and QR code are also saved on the Event tab. Open events are listed on that page too.'),
    h('6. Watch the Signups tab'),
    p('Each sign-up adds a row. Only change the status column: confirmed, waitlisted or cancelled. When every slot is full, ' +
      'volunteers can join a waitlist. Volunteers can cancel with the link in their confirmation email: their status becomes ' +
      'cancelled, the next person on that slot\'s waitlist gets the spot automatically (and an email), and you get an email. ' +
      'Changing a status yourself doesn\'t move anyone up: if you cancel someone, change the next waitlisted person to confirmed ' +
      'and let them know.'),
    h('7. When sign-ups should stop'),
    p('Move this spreadsheet into the Past events folder. Its page still shows who signed up, but takes no new sign-ups.'),
    p('Questions? Email ' + config.adminEmail + '. You can delete this tab; the app doesn\'t use it.'),
  ];
}

function createSampleEvent_() {
  var day = new Date();
  day.setDate(day.getDate() + 21);
  day.setHours(0, 0, 0, 0);
  function at(hour) {
    var d = new Date(day);
    d.setHours(hour);
    return d;
  }
  return createEventSpreadsheet_('Fall Book Fair (sample)', {
    title: 'Fall Book Fair (sample)',
    description: 'Help students find books, run the checkout table, and restock shelves.',
    location: 'School Library',
    organizerEmail: '',
    confirmationSubject: 'See you at the Book Fair, {firstName}!',
    confirmationMessage: 'Please check in at the library front desk 5 minutes before your slot. Thank you for helping!',
  }, [
    { slotId: 'setup', label: 'Setup', start: at(8), end: at(9), capacity: 3 },
    { slotId: 'checkout', label: 'Checkout table', start: at(9), end: at(11), capacity: 2 },
    { slotId: 'cleanup', label: 'Cleanup', start: at(14), end: at(15), capacity: 1 },
  ], [
    { question: 'T-shirt size', type: 'choice', options: 'S, M, L, XL', required: 'no' },
    { question: 'Anything we should know? (allergies, accessibility)', type: 'paragraph', options: '', required: 'no' },
  ]);
}

/** What's left for the admin to do, as "TODO:", "NOTE:" or "OK:" lines. */
function setupChecklist_(template, sample) {
  var config = getConfig_();
  var lines = [];
  // Which of the two folders a file is directly in (eventStateFor_ would call the template "not an event").
  var place = function (id) {
    try {
      var parents = Drive.Files.get(id, { fields: 'parents', supportsAllDrives: true }).parents || [];
      if (parents.indexOf(config.eventsFolderId) !== -1) return EVENT_STATE.OPEN;
      if (parents.indexOf(config.pastEventsFolderId) !== -1) return EVENT_STATE.PAST;
    } catch (err) {
      // Not found: treated as elsewhere.
    }
    return '';
  };
  [['Events', config.eventsFolderId, 'EVENTS_FOLDER_ID'], ['Past events', config.pastEventsFolderId, 'PAST_EVENTS_FOLDER_ID']]
    .forEach(function (f) {
      var ok = false;
      try {
        var folder = Drive.Files.get(f[1], { fields: 'mimeType,trashed', supportsAllDrives: true });
        ok = folder.mimeType === 'application/vnd.google-apps.folder' && !folder.trashed;
      } catch (err) {
        ok = false;
      }
      lines.push(ok
        ? 'OK: the ' + f[0] + ' folder (' + f[1] + ') is reachable.'
        : 'TODO: the ' + f[0] + ' folder (' + f[1] + ') can\'t be opened. Share it with this account, or set ' + f[2] + '.');
    });

  lines.push(place(template.getId()) === EVENT_STATE.OPEN
    ? 'OK: Event Template is in the Events folder, where organizers can copy it (it is never shown as an event).'
    : 'TODO: move Event Template into the Events folder so organizers can find and copy it: ' + template.getUrl());
  var samplePlace = place(sample.getId());
  lines.push(samplePlace === EVENT_STATE.OPEN
    ? 'NOTE: the sample event is live and listed on the home page. Move it to Past events (or out of Events) before going live.'
    : samplePlace === EVENT_STATE.PAST
      ? 'OK: the sample event is in Past events (shown read-only, not listed).'
      : 'NOTE: to try the sample event, move it into the Events folder, then to Past events when done: ' + sample.getUrl());

  lines.push(config.tinyUrlApiToken
    ? 'OK: TINYURL_API_TOKEN is set.'
    : 'TODO: set the TINYURL_API_TOKEN script property (from your TinyURL account) so short links use TinyURL\'s current API.');
  lines.push(config.mailRedirectTo
    ? 'NOTE: MAIL_REDIRECT_TO is set, so every email goes to ' + config.mailRedirectTo + '. Remove it when you go live.'
    : 'OK: emails go to volunteers and organizers (MAIL_REDIRECT_TO is not set).');
  lines.push('NOTE: organizers get sign-up links at ' + config.siteUrl + ' (SITE_URL).');
  return lines;
}

function logSetupReport_(result, template, sample) {
  result.created.forEach(function (c) { console.log('Created ' + c + '.'); });
  result.updated.forEach(function (u) { console.log('Updated ' + u + '.'); });
  if (result.refreshTrigger) console.log('Installed the event cache refresh timer (runs every minute).');
  console.log('Event Template: ' + template.getUrl());
  console.log('Sample event: ' + sample.getUrl());
  result.checklist.forEach(function (line) { console.log(line); });
}
