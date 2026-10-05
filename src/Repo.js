/**
 * Data access. Every event is its own spreadsheet, and its folder decides
 * whether it is open (see EVENT_STATE):
 *
 *   Event    key/value rows: title, description, location, organizerEmail,
 *            confirmationSubject, confirmationMessage, organizerSubject, organizerMessage
 *   Slots    one row per slot (table with a header row)
 *   Signups  one row per sign-up, written by the app (plus a column per question)
 *   Questions  optional: organizers' custom questions (see Questions.js)
 *
 * The event's id is its spreadsheet id. Tables are matched by header name,
 * so organizers may reorder or add columns.
 */

var TABLES = {
  Slots: ['slotId', 'label', 'start', 'end', 'capacity'],
  Signups: ['signupId', 'slotId', 'slotLabel', 'name', 'email', 'phone', 'note', 'status', 'cancelToken', 'createdAt'],
  Questions: ['question', 'type', 'options', 'required'],
};

var EVENT_TAB = 'Event';
var EVENT_FIELDS = ['title', 'description', 'location', 'organizerEmail', 'confirmationSubject', 'confirmationMessage',
  'organizerSubject', 'organizerMessage'];

var SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{25,100}$/;
var SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
var FOLDER_CHECK_CACHE_SECONDS = { event: 300, notEvent: 60 };

/**
 * A spreadsheet's folder decides what it is:
 *   directly in the Events folder       OPEN  taking sign-ups
 *   directly in the Past events folder  PAST  shown, no new sign-ups
 *   anywhere else (subfolders too)      NONE  not an event
 * The Event Template (TEMPLATE_ID) is never an event, wherever it is.
 */
var EVENT_STATE = { OPEN: 'open', PAST: 'past', NONE: 'none' };

/**
 * Opens the event spreadsheet for an id from the URL, or returns null if the
 * id is malformed, the file is not an open or past event, or it can't be
 * opened. This is the only way request input reaches openById.
 */
function openEventSpreadsheet_(eventId) {
  var id = String(eventId || '').trim();
  if (getEventState_(id) === EVENT_STATE.NONE) return null;
  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    console.warn('Could not open event spreadsheet ' + id + ': ' + err);
    return null;
  }
}

function eventFolderCacheKey_(fileId) {
  return 'eventFolder:' + fileId;
}

/** Cached EVENT_STATE of a file: moving a spreadsheet takes effect within minutes. */
function getEventState_(fileId) {
  if (!SPREADSHEET_ID_PATTERN.test(fileId)) return EVENT_STATE.NONE;
  var hit = CacheService.getScriptCache().get(eventFolderCacheKey_(fileId));
  return hit || readEventState_(fileId);
}

/** Asks Drive for a file's EVENT_STATE now, and caches the answer. */
function readEventState_(fileId) {
  if (!SPREADSHEET_ID_PATTERN.test(fileId)) return EVENT_STATE.NONE;
  var state = EVENT_STATE.NONE;
  try {
    var file = Drive.Files.get(fileId, { fields: 'mimeType,trashed,parents', supportsAllDrives: true });
    if (!file.trashed && file.mimeType === SPREADSHEET_MIME_TYPE) state = eventStateFor_(fileId, file.parents);
  } catch (err) {
    // Not found / no access: not an event.
  }
  cacheEventState_(fileId, state);
  return state;
}

function cacheEventState_(fileId, state) {
  CacheService.getScriptCache().put(eventFolderCacheKey_(fileId), state,
    state === EVENT_STATE.NONE ? FOLDER_CHECK_CACHE_SECONDS.notEvent : FOLDER_CHECK_CACHE_SECONDS.event);
}

/** EVENT_STATE of a spreadsheet with these parent folder ids. */
function eventStateFor_(fileId, parents) {
  var config = getConfig_();
  parents = parents || [];
  if (fileId === config.templateId) return EVENT_STATE.NONE;
  if (parents.indexOf(config.eventsFolderId) !== -1) return EVENT_STATE.OPEN;
  if (parents.indexOf(config.pastEventsFolderId) !== -1) return EVENT_STATE.PAST;
  return EVENT_STATE.NONE;
}

function getTab_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Event spreadsheet ' + ss.getId() + ' is missing its "' + name + '" tab.');
  return sheet;
}

/** Reads the Event tab (column A = field, column B = value) into an object. */
function readEventInfo_(ss) {
  var sheet = ss.getSheetByName(EVENT_TAB);
  if (!sheet) return null;
  var info = { eventId: ss.getId() };
  EVENT_FIELDS.forEach(function (f) { info[f] = ''; });
  sheet.getDataRange().getValues().forEach(function (row) {
    var key = String(row[0] || '').trim();
    var match = EVENT_FIELDS.filter(function (f) { return f.toLowerCase() === key.toLowerCase(); })[0];
    if (match) info[match] = String(row[1] == null ? '' : row[1]).trim();
  });
  return info;
}

function normalizeCell_(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Reads every non-blank row of a table tab as an object keyed by header.
 * Each object also carries _row, its 1-based sheet row number.
 */
function readTable_(ss, name) {
  var values = getTab_(ss, name).getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  values.slice(1).forEach(function (row, i) {
    if (row.every(function (cell) { return cell === '' || cell == null; })) return;
    var obj = { _row: i + 2 };
    headers.forEach(function (h, col) { if (h) obj[h] = normalizeCell_(row[col]); });
    rows.push(coerceRow_(name, obj));
  });
  return rows;
}

/** Sheets may turn ids into numbers and capacities into strings; undo that. */
function coerceRow_(name, obj) {
  ['slotId', 'signupId'].forEach(function (key) {
    if (key in obj) obj[key] = String(obj[key] == null ? '' : obj[key]).trim();
  });
  if ('label' in obj) obj.label = String(obj.label == null ? '' : obj.label).trim();
  if (name === 'Signups') obj.status = String(obj.status || '').trim().toLowerCase();
  if (name === 'Slots') obj.capacity = Math.max(0, Math.floor(Number(obj.capacity) || 0));
  return obj;
}

/**
 * Reads slots, first giving an id to any slot an organizer added without one.
 * Ids are written back so sign-ups keep pointing at the right slot even if
 * rows are later reordered.
 */
function readSlots_(ss) {
  var slots = readTable_(ss, 'Slots');
  var missing = slots.filter(function (s) { return s.label && !s.slotId; });
  if (!missing.length) return slots;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return slots; // Slots without ids are simply not offered this time.
  try {
    var sheet = getTab_(ss, 'Slots');
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    var idCol = headers.indexOf('slotId') + 1;
    if (idCol === 0) throw new Error('Slots tab has no "slotId" column.');
    slots = readTable_(ss, 'Slots'); // Re-read under the lock.
    slots.forEach(function (s) {
      if (s.label && !s.slotId) {
        s.slotId = 'slot-' + Utilities.getUuid().slice(0, 8);
        sheet.getRange(s._row, idCol).setValue(s.slotId);
      }
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return slots;
}

/** The event's custom questions, or [] if it has no Questions tab. */
function readQuestions_(ss) {
  return ss.getSheetByName('Questions') ? parseQuestions_(readTable_(ss, 'Questions')) : [];
}

/**
 * Makes sure the Signups tab has a column for each question's answers,
 * adding any missing ones at the end. Returns { label: column header }.
 * Call while holding the script lock.
 */
function ensureAnswerColumns_(ss, questions) {
  var headersByLabel = {};
  if (!questions.length) return headersByLabel;
  var sheet = getTab_(ss, 'Signups');
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  questions.forEach(function (q) {
    var header = answerHeader_(q.label, TABLES.Signups);
    headersByLabel[q.label] = header;
    if (headers.indexOf(header) === -1) {
      headers.push(header);
      sheet.getRange(1, headers.length).setValue(header).setFontWeight('bold');
    }
  });
  return headersByLabel;
}

/** Appends one object as a row, in the tab's current column order. */
function appendRecord_(ss, name, record) {
  var sheet = getTab_(ss, name);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  sheet.appendRow(headers.map(function (h) {
    return h in record ? sanitizeForSheet_(record[h]) : '';
  }));
}

function findById_(rows, key, id) {
  for (var i = 0; i < rows.length; i++) if (rows[i][key] === id) return rows[i];
  return null;
}
