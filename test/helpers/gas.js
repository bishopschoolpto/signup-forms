/**
 * Loads the Apps Script sources (src/*.js) into a Node vm context with
 * in-memory fakes for the Google services they use. The fakes implement only
 * the methods this project calls.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const OWNER = 'owner@example.com';
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'appsscript.json'), 'utf8'));
const EVENTS_FOLDER = '1yX2nxEPACkQkJLyeWYbRjd-8x0MmK55c'; // DEFAULT_EVENTS_FOLDER_ID in Config.js
const PAST_FOLDER = '1jdmAElexrsedV46-6INgjFUMQF7ycAP9'; // DEFAULT_PAST_EVENTS_FOLDER_ID in Config.js
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    this.sheet.touch();
    values.forEach((line, r) => {
      const target = (this.sheet.rows[this.row - 1 + r] ||= []);
      line.forEach((v, c) => { target[this.col - 1 + c] = storeValue(v); });
    });
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  getValue() { return this.getValues()[0][0]; }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  setWrap() { return this; }
  setVerticalAlignment() { return this; }
  /** Formatting the app sets up, recorded per range for tests. */
  setNote(note) { this.sheet.notes[this.row + ',' + this.col] = note; return this; }
  setNumberFormat(format) { this.sheet.formats.push({ col: this.col, row: this.row, numRows: this.numRows, format }); return this; }
  setDataValidation(rule) {
    this.sheet.validations = this.sheet.validations.filter((v) => !(v.col === this.col && v.row === this.row));
    this.sheet.validations.push({ col: this.col, row: this.row, numRows: this.numRows, rule });
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      const line = this.sheet.rows[this.row - 1 + r];
      if (line) for (let c = 0; c < this.numCols; c++) line[this.col - 1 + c] = '';
    }
    return this;
  }
}

/** Mimics Sheets: a leading apostrophe forces text and is not part of the value. */
function storeValue(v) {
  return typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
}

class FakeSheet {
  constructor(name, log, onWrite) {
    this.name = name; this.log = log; this.onWrite = onWrite;
    this.rows = []; this.rawAppends = []; this.frozenRows = 0; this.images = [];
    this.notes = {}; this.formats = []; this.validations = []; this.columnWidths = {};
  }
  touch() { if (this.onWrite) this.onWrite(); }
  getName() { return this.name; }
  setName(name) { this.name = name; return this; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  getDataRange() {
    if (this.log) this.log.push('read:' + this.name);
    return new FakeRange(this, 1, 1, this.getLastRow(), this.getLastColumn());
  }
  appendRow(values) { this.touch(); this.rawAppends.push(values); this.rows.push(values.map(storeValue)); return this; }
  setFrozenRows(n) { this.frozenRows = n; }
  getMaxRows() { return 1000; }
  setColumnWidth(col, width) { this.columnWidths[col] = width; return this; }
  deleteRow(n) { this.touch(); this.rows.splice(n - 1, 1); return this; }
  /** Column validation rule by header name, for tests. */
  validationFor(header) {
    const col = this.rows[0].indexOf(header) + 1;
    const v = this.validations.find((x) => x.col === col);
    return v && v.rule;
  }
  /** Over-grid images, like Sheets' Insert → Image → Over cells. */
  insertImage(blob, column, row) {
    this.touch();
    const sheet = this;
    const image = {
      blob, column, row, altTitle: '',
      getAltTextTitle() { return this.altTitle; },
      setAltTextTitle(t) { this.altTitle = t; return this; },
      remove() { sheet.touch(); sheet.images = sheet.images.filter((i) => i !== image); },
    };
    this.images.push(image);
    return image;
  }
  getImages() { return this.images.slice(); }
}

class FakeSpreadsheet {
  constructor(name, id, log, onWrite) {
    this.name = name;
    this.id = id;
    this.log = log;
    this.onWrite = onWrite;
    this.sheets = [new FakeSheet('Sheet1', log, onWrite)];
  }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name, index) {
    const s = new FakeSheet(name, this.log, this.onWrite);
    if (index === undefined) this.sheets.push(s);
    else this.sheets.splice(index, 0, s);
    return s;
  }
  deleteSheet(sheet) { this.sheets = this.sheets.filter((s) => s !== sheet); }

  /** Test helpers: the Event tab as { field: value }, and setting one field. */
  eventInfo() {
    return Object.fromEntries(this.getSheetByName('Event').rows.slice(1).map((r) => [r[0], r[1]]));
  }
  setEventField(field, value) {
    const row = this.getSheetByName('Event').rows.find((r) => r[0] === field);
    row[1] = value;
    this.onWrite();
  }
}

/** Formats like Utilities.formatDate for the patterns this project uses. */
function formatDate(date, timeZone, pattern) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const tokens = {
    EEE: parts.weekday, MMM: parts.month, yyyy: parts.year, d: parts.day,
    h: parts.hour, mm: parts.minute, a: parts.dayPeriod,
  };
  return pattern.replace(/EEE|MMM|yyyy|mm|d|h|a/g, (t) => tokens[t]);
}

/**
 * Creates a fresh sandbox. `ctx` exposes every global function defined in
 * src/*.js. Drive starts with: root → (My Drive), and a shared drive holding
 * the Events folder (with a "Subfolder"), the Past events folder, and an
 * unrelated folder.
 */
function loadGas({ properties = {}, timeZone = MANIFEST.timeZone, lockAvailable = true } = {}) {
  const spreadsheets = new Map();
  const sentMail = [];
  const lockLog = [];
  const driveLog = [];
  const fetchLog = [];
  const edgePublishes = [];
  const fetchRequests = [];
  const cache = new Map();
  const props = { ...properties };
  // activeUser is who is calling: the owner in the editor, '' for an anonymous web visitor.
  const session = { activeUser: OWNER };
  let nextId = 1;
  let clock = 0; // Drive modifiedTime source: advances on every spreadsheet write.
  const tick = () => new Date(Date.UTC(2026, 0, 1) + ++clock * 1000).toISOString();
  const triggers = [];
  // Apps Script evaluates local Date methods (setHours etc.) in the script's time zone.
  process.env.TZ = timeZone;

  const drive = new Map([
    ['root', { mimeType: FOLDER_MIME, parents: [] }],
    ['sharedDriveRoot', { mimeType: FOLDER_MIME, parents: [] }],
    [EVENTS_FOLDER, { mimeType: FOLDER_MIME, parents: ['sharedDriveRoot'] }],
    ['subFolder', { mimeType: FOLDER_MIME, parents: [EVENTS_FOLDER] }],
    [PAST_FOLDER, { mimeType: FOLDER_MIME, parents: ['sharedDriveRoot'] }],
    ['otherFolder', { mimeType: FOLDER_MIME, parents: ['sharedDriveRoot'] }],
  ]);

  const SpreadsheetApp = {
    /** Data validation rules, recorded as plain objects. */
    newDataValidation() {
      const rule = { allowInvalid: true };
      const builder = {
        requireValueInList(list, showDropdown) { rule.list = list.slice(); rule.dropdown = showDropdown; return builder; },
        requireNumberGreaterThanOrEqualTo(n) { rule.min = n; return builder; },
        setAllowInvalid(allow) { rule.allowInvalid = allow; return builder; },
        setHelpText(text) { rule.help = text; return builder; },
        build() { return { ...rule }; },
      };
      return builder;
    },
    create(name) {
      // Real ids are 44 characters of [A-Za-z0-9_-].
      const id = '1fake' + String(nextId++).padStart(39, '0');
      const ss = new FakeSpreadsheet(name, id, lockLog, () => { drive.get(id).modifiedTime = tick(); });
      spreadsheets.set(id, ss);
      drive.set(id, { mimeType: SPREADSHEET_MIME, parents: ['root'], trashed: false, modifiedTime: tick() });
      return ss;
    },
    openById(id) {
      const ss = spreadsheets.get(id);
      if (!ss) throw new Error('No spreadsheet with id ' + id);
      lockLog.push('open');
      return ss;
    },
    flush() {},
  };

  const Drive = {
    Files: {
      get(id, options) {
        driveLog.push(id);
        if (!options || !options.supportsAllDrives) throw new Error('Test fake: always pass supportsAllDrives');
        const file = drive.get(id);
        if (!file) throw new Error('GoogleJsonResponseException: File not found: ' + id);
        return { mimeType: file.mimeType, trashed: !!file.trashed, parents: file.parents.slice() };
      },
      list(options) {
        const m = /^'([^']+)' in parents and trashed = false$/.exec(options.q);
        if (!m || !options.supportsAllDrives || !options.includeItemsFromAllDrives) {
          throw new Error('Test fake: unsupported list query ' + JSON.stringify(options));
        }
        driveLog.push('list:' + m[1]);
        const files = [...drive.entries()]
          .filter(([, f]) => f.parents.includes(m[1]) && !f.trashed)
          .map(([id, f]) => ({ id, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
        return { files };
      },
    },
  };

  const CacheService = {
    getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k).value : null),
      put: (k, value, seconds) => { cache.set(k, { value: String(value), seconds }); },
      remove: (k) => { cache.delete(k); },
    }),
  };

  const readHtml = (name) => fs.readFileSync(path.join(SRC_DIR, name + '.html'), 'utf8');
  const htmlOutput = (content) => ({
    content, title: '', metaTags: [], xFrameOptions: null,
    getContent() { return this.content; },
    setTitle(t) { this.title = t; return this; },
    addMetaTag(name, value) { this.metaTags.push([name, value]); return this; },
    setXFrameOptionsMode(mode) { this.xFrameOptions = mode; return this; },
  });
  /** Evaluates the two scriptlet forms this project uses: include('X') and a template variable. */
  const evaluateTemplate = (source, template) => source.replace(/<\?!=\s*([\s\S]*?)\s*\?>/g, (_, expr) => {
    const inc = expr.match(/^include\('(\w+)'\)$/);
    if (inc) return ctx.include(inc[1]);
    if (/^\w+$/.test(expr)) {
      if (!(expr in template)) throw new Error('Template variable not set: ' + expr);
      return String(template[expr]);
    }
    throw new Error('Test fake: unsupported scriptlet ' + expr);
  });
  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    createHtmlOutputFromFile: (name) => htmlOutput(readHtml(name)),
    createTemplateFromFile(name) {
      const template = { evaluate: () => htmlOutput(evaluateTemplate(readHtml(name), template)) };
      return template;
    },
  };

  let lockHeld = false;
  const LockService = {
    getScriptLock: () => ({
      tryLock() {
        if (!lockAvailable || lockHeld) { lockLog.push('lock-failed'); return false; }
        lockHeld = true;
        lockLog.push('lock');
        return true;
      },
      releaseLock() { lockHeld = false; lockLog.push('unlock'); },
    }),
  };

  const ctx = {
    console,
    SpreadsheetApp,
    Drive,
    CacheService,
    HtmlService,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content) => ({
        content, mimeType: 'text/plain',
        getContent() { return this.content; },
        setMimeType(m) { this.mimeType = m; return this; },
      }),
    },
    LockService,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        getProperties: () => ({ ...props }),
        setProperty: (k, v) => { props[k] = String(v); },
        setProperties: (values) => { Object.entries(values).forEach(([k, v]) => { props[k] = String(v); }); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    Session: {
      getScriptTimeZone: () => timeZone,
      getActiveUser: () => ({ getEmail: () => session.activeUser }),
      getEffectiveUser: () => ({ getEmail: () => OWNER }),
    },
    MailApp: {
      sendEmail(message) {
        if (ctx.MailApp.failNext) { ctx.MailApp.failNext = false; throw new Error('Service invoked too many times: email'); }
        sentMail.push(message);
      },
      failNext: false,
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate,
      base64Decode: (text) => [...Buffer.from(text, 'base64')].map((b) => (b > 127 ? b - 256 : b)), // signed bytes, like Apps Script
      newBlob: (bytes, contentType, name) => ({ bytes, contentType, name, getContentType: () => contentType }),
    },
    // TinyURL: api.tinyurl.com/create (JSON, needs a bearer token) and the old
    // api-create.php (answers with the short link as plain text).
    UrlFetchApp: {
      fetch(url, options = {}) {
        fetchLog.push(url);
        fetchRequests.push({ url, options });
        // The Cloudflare edge (src/Edge.js): records each publish; edgeReply overrides the answer.
        if (props.EDGE_URL && url.startsWith(props.EDGE_URL)) {
          const edgeReply = ctx.UrlFetchApp.edgeReply || { code: 200, text: '{"ok":true}' };
          if (edgeReply.throws) throw new Error(edgeReply.throws);
          edgePublishes.push({ url, auth: (options.headers || {}).Authorization, body: JSON.parse(options.payload) });
          return { getResponseCode: () => edgeReply.code, getContentText: () => edgeReply.text };
        }
        const links = ctx.UrlFetchApp.tinyUrls; // alias → long URL, for every TinyURL "made" so far
        const visit = /^https:\/\/tinyurl\.com\/([A-Za-z0-9_-]+)$/.exec(url);
        if (visit) { // Visiting a short link: TinyURL redirects to its long URL.
          const target = links[visit[1]];
          return target
            ? { getResponseCode: () => 301, getContentText: () => '', getHeaders: () => ({ Location: target }) }
            : { getResponseCode: () => 404, getContentText: () => 'Not found', getHeaders: () => ({}) };
        }
        const isApi = url === 'https://api.tinyurl.com/create';
        const longUrl = isApi ? JSON.parse(options.payload || '{}').url : new URL(url).searchParams.get('url');
        const alias = isApi ? JSON.parse(options.payload || '{}').alias : new URL(url).searchParams.get('alias');
        const madeAlias = alias || 'fake' + fetchLog.length;
        const shortUrl = 'https://tinyurl.com/' + madeAlias;
        const taken = alias && alias in links;
        let reply = ctx.UrlFetchApp.nextReply;
        ctx.UrlFetchApp.nextReply = null;
        if (!reply && isApi) {
          const auth = (options.headers || {}).Authorization || '';
          if (!/^Bearer \S+$/.test(auth) || options.method !== 'post') reply = { code: 401, text: '{"data":[],"code":1,"errors":["Unauthenticated."]}' };
          else if (taken) reply = { code: 422, text: '{"data":[],"code":5,"errors":["Alias is not available."]}' };
          else reply = { code: 200, text: JSON.stringify({ data: { domain: 'tinyurl.com', alias, tiny_url: shortUrl, url: JSON.parse(options.payload).url }, code: 0, errors: [] }) };
        }
        if (!reply && taken) reply = { code: 422, text: 'Error' };
        reply = reply || { code: 200, text: shortUrl };
        if (reply.code === 200 && !reply.text.startsWith('{"data":[]')) links[madeAlias] = longUrl; // made now, so taken from here on
        if (reply.throws) throw new Error(reply.throws);
        return { getResponseCode: () => reply.code, getContentText: () => reply.text };
      },
      nextReply: null,
      edgeReply: null,
      tinyUrls: {},
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler, getUniqueId: () => t.uid })),
      newTrigger: (handler) => ({
        timeBased: () => ({
          everyMinutes: (minutes) => ({
            create: () => { triggers.push({ handler, minutes, uid: 'trigger-' + (triggers.length + 1) }); },
          }),
        }),
      }),
    },
  };
  vm.createContext(ctx);

  for (const file of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'), ctx, { filename: file });
  }

  return {
    ctx,
    sentMail,
    props,
    lockLog,
    driveLog,
    fetchLog,
    fetchRequests,
    edgePublishes,
    cache,
    session,
    drive,
    triggers,
    /** Runs the timer the way Apps Script would: with its trigger's uid. */
    runTimer() { return ctx.refreshEventCaches({ triggerUid: triggers[0].uid }); },
    spreadsheet: (id) => spreadsheets.get(id),
    /** Moves a file to a folder, like dragging it in Drive. */
    moveTo(id, folderId) { drive.get(id).parents = [folderId]; },
    /** Creates an event spreadsheet (via the app's own setup code) and moves it into a folder. */
    addEvent(info, slots = [], folderId = EVENTS_FOLDER) {
      const ss = ctx.createEventSpreadsheet_(info.title || 'Event', info, slots);
      drive.get(ss.getId()).parents = [folderId];
      return ss;
    },
  };
}

/**
 * Loads the sandbox, runs setup(), and moves the sample event into the
 * Events folder. `gas.eventId` is the sample's id; `gas.event` its spreadsheet.
 */
function loadWithEvent(options) {
  const gas = loadGas(options);
  gas.ctx.setup();
  gas.eventId = gas.props.SAMPLE_EVENT_ID;
  gas.event = gas.spreadsheet(gas.eventId);
  gas.moveTo(gas.eventId, EVENTS_FOLDER);
  gas.moveTo(gas.props.TEMPLATE_ID, EVENTS_FOLDER);
  gas.lockLog.length = 0;
  gas.driveLog.length = 0;
  return gas;
}

/** Plain-object copy of a vm-context value, so deepStrictEqual works across realms. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { loadGas, loadWithEvent, plain, FakeSheet, SRC_DIR, EVENTS_FOLDER, PAST_FOLDER };
