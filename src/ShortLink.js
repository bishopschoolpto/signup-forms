/**
 * TinyURL short links for organizers to share (the page also turns them into
 * QR codes). TinyURL only answers browsers on its own site, so the page asks
 * this server to make them.
 *
 * With a TINYURL_API_TOKEN script property (from a TinyURL account), links are
 * made with TinyURL's current API. Without one, the server falls back to the
 * old keyless api-create.php, which TinyURL has deprecated.
 *
 * Only links to events can be shortened, so this is not an open URL
 * shortener. Nothing is remembered between requests: each request makes a new
 * TinyURL and overwrites the event's Event tab (rows "shortLink" and
 * "qrCode"). The one exception: asking again for text (alias) that already
 * points to this event reuses that link, since TinyURL won't make it twice.
 * The server draws its own QR code rather than taking the browser's, so
 * anonymous callers can't put arbitrary images into a spreadsheet.
 */
var TINYURL_API = 'https://api.tinyurl.com/create';
var TINYURL_LEGACY_API = 'https://tinyurl.com/api-create.php?url=';
var TINYURL_PATTERN = /^https:\/\/tinyurl\.com\/[A-Za-z0-9_-]+$/;
// Organizers may choose the text after tinyurl.com/ (TinyURL's "alias").
var SHORT_LINK_ALIAS_PATTERN = /^[A-Za-z0-9_-]{5,30}$/;
// Anyone can call getShortLink and each call makes a TinyURL, so new links are
// rate-limited per event. The count lives in the script cache and expires.
var MAX_NEW_SHORT_LINKS_PER_EVENT = 10;
var SHORT_LINK_LIMIT_SECONDS = 6 * 60 * 60; // CacheService's maximum
var SHORT_LINK_COUNT_PREFIX = 'shortLinkCount:';
var SHORT_LINK_FIELD = 'shortLink';
var QR_CODE_FIELD = 'qrCode';
var QR_IMAGE_TITLE = 'Sign-up QR code';

/**
 * request: { eventId, baseUrl, alias }. baseUrl is the page the organizer is
 * on; the short link goes there only if it is this Apps Script web app, and to
 * the static site (SITE_URL) otherwise. alias (optional) is the text wanted
 * after tinyurl.com/. Always makes a new link (or reuses the alias if it
 * already points here) and writes it into the spreadsheet.
 * Returns { ok: true, shortUrl, longUrl, savedToSheet } or { ok: false, error, message }.
 */
function getShortLink(request) {
  var eventId = String((request && request.eventId) || '').trim();
  if (!getPageData(eventId).event) {
    return { ok: false, error: 'NOT_FOUND', message: 'No sign-up found for that spreadsheet.' };
  }
  var alias = String(request.alias || '').trim().replace(/^(https?:\/\/)?(www\.)?tinyurl\.com\//i, '');
  if (alias && !SHORT_LINK_ALIAS_PATTERN.test(alias)) {
    return { ok: false, error: 'INVALID_ALIAS', message: 'Short link text must be 5–30 letters, numbers, dashes (-) or underscores (_).' };
  }
  var longUrl = pageBaseUrl_(request.baseUrl) + '?event=' + encodeURIComponent(eventId);

  var cache = CacheService.getScriptCache();
  var countKey = SHORT_LINK_COUNT_PREFIX + eventId;
  var count = Number(cache.get(countKey)) || 0;
  if (count >= MAX_NEW_SHORT_LINKS_PER_EVENT) {
    return { ok: false, error: 'RATE_LIMITED', message: 'Too many short links were made for this event recently. ' +
      'Please try again in a few hours, or email admin@bishopschoolpto.com.' };
  }

  var made = createTinyUrl_(longUrl, alias);
  if (!made.shortUrl && made.error === 'ALIAS_REJECTED' && tinyUrlTarget_(alias) === longUrl) {
    made = { shortUrl: 'https://tinyurl.com/' + alias, reused: true }; // made earlier for this same event
  }
  if (!made.shortUrl) return { ok: false, error: made.error, message: made.message };
  if (!made.reused) cache.put(countKey, String(count + 1), SHORT_LINK_LIMIT_SECONDS);

  var savedToSheet = false;
  try {
    savedToSheet = saveShortLinkToSheet_(eventId, made.shortUrl);
  } catch (err) {
    // The link still works; it just isn't in the spreadsheet this time.
    console.error('Could not save short link to event ' + eventId + ': ' + err);
  }
  return { ok: true, shortUrl: made.shortUrl, longUrl: longUrl, savedToSheet: savedToSheet };
}

/** Where an existing tinyurl.com/<alias> link goes (from its redirect), or ''. */
function tinyUrlTarget_(alias) {
  try {
    var res = UrlFetchApp.fetch('https://tinyurl.com/' + encodeURIComponent(alias), { followRedirects: false, muteHttpExceptions: true });
    if (res.getResponseCode() < 300 || res.getResponseCode() >= 400) return '';
    var headers = res.getHeaders();
    for (var name in headers) {
      if (name.toLowerCase() === 'location') return String(headers[name]);
    }
  } catch (err) {
    console.warn('Could not look up tinyurl.com/' + alias + ': ' + err);
  }
  return '';
}

/**
 * Writes shortUrl into the Event tab's "shortLink" row and replaces the QR
 * code image over its "qrCode" row, adding the rows at the end if missing
 * (skipping the write if that link and its QR code are already there).
 * Returns true if the spreadsheet now has them, false if it couldn't be
 * written this time (busy, or no Event tab).
 */
function saveShortLinkToSheet_(eventId, shortUrl) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var ss = openEventSpreadsheet_(eventId);
    var sheet = ss && ss.getSheetByName(EVENT_TAB);
    if (!sheet) return false;
    var linkRow = findOrAddFieldRow_(sheet, SHORT_LINK_FIELD, 'Written by the app: the latest short link to the sign-up page.');
    var qrRow = findOrAddFieldRow_(sheet, QR_CODE_FIELD, 'Written by the app: a QR code for the short link.');
    var images = sheet.getImages().filter(function (img) { return img.getAltTextTitle() === QR_IMAGE_TITLE; });
    if (String(sheet.getRange(linkRow, 2).getValue()) === shortUrl && images.length === 1) return true;

    sheet.getRange(linkRow, 2).setValue(shortUrl);
    images.forEach(function (img) { img.remove(); });
    sheet.insertImage(qrCodeGif_(shortUrl), 2, qrRow).setAltTextTitle(QR_IMAGE_TITLE);
    SpreadsheetApp.flush();
    return true;
  } finally {
    lock.releaseLock();
  }
}

/** 1-based row of a field in the Event tab's column A, appending it if missing. */
function findOrAddFieldRow_(sheet, field, note) {
  var keys = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim().toLowerCase() === field.toLowerCase()) return i + 1;
  }
  sheet.appendRow([field, '', note]);
  return sheet.getLastRow();
}

/** A QR code for text as a GIF blob (5px modules, 4-module quiet zone). */
function qrCodeGif_(text) {
  var qr = qrcode_(0, 'M');
  qr.addData(text);
  qr.make();
  var dataUrl = qr.createDataURL(5, 20);
  return Utilities.newBlob(Utilities.base64Decode(dataUrl.split(',')[1]), 'image/gif', 'sign-up-qr-code.gif');
}


var SHORTENER_FAILED = {
  error: 'SHORTENER_FAILED', message: 'We couldn\'t make a short link right now. Please try again later.',
};

/**
 * Asks TinyURL for a short link, with the given alias if any. Returns
 * { shortUrl }, or { error, message } if TinyURL refused or failed.
 */
function createTinyUrl_(longUrl, alias) {
  var token = getConfig_().tinyUrlApiToken;
  try {
    return token ? createTinyUrlWithToken_(longUrl, alias, token) : createTinyUrlLegacy_(longUrl, alias);
  } catch (err) {
    console.error('TinyURL request failed: ' + err);
    return SHORTENER_FAILED;
  }
}

/** TinyURL's current API: POST /create with a bearer token. */
function createTinyUrlWithToken_(longUrl, alias, token) {
  var request = { url: longUrl, domain: 'tinyurl.com' };
  if (alias) request.alias = alias;
  var res = UrlFetchApp.fetch(TINYURL_API, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    payload: JSON.stringify(request),
    muteHttpExceptions: true,
  });
  var text = String(res.getContentText() || '');
  var body = null;
  try {
    body = JSON.parse(text);
  } catch (err) {
    // Not JSON: reported below.
  }
  var shortUrl = String((body && body.code === 0 && body.data && body.data.tiny_url) || '').trim();
  if (res.getResponseCode() === 200 && TINYURL_PATTERN.test(shortUrl)) return { shortUrl: shortUrl };
  console.error('TinyURL answered ' + res.getResponseCode() + ': ' + text.slice(0, 200));
  // TinyURL explains alias problems ("Alias is not available.", "The Alias format is invalid.").
  var reason = String((body && body.errors && body.errors[0]) || '');
  if (alias && res.getResponseCode() === 422 && /alias/i.test(reason)) return aliasRejected_(reason);
  return SHORTENER_FAILED;
}

/** TinyURL's old keyless API (deprecated by TinyURL): answers with the link as text. */
function createTinyUrlLegacy_(longUrl, alias) {
  console.warn('TINYURL_API_TOKEN is not set; using TinyURL\'s deprecated api-create.php.');
  var url = TINYURL_LEGACY_API + encodeURIComponent(longUrl) + (alias ? '&alias=' + encodeURIComponent(alias) : '');
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var text = String(res.getContentText() || '').trim();
  if (res.getResponseCode() === 200 && TINYURL_PATTERN.test(text)) return { shortUrl: text };
  console.error('TinyURL answered ' + res.getResponseCode() + ': ' + text.slice(0, 200));
  if (alias && res.getResponseCode() === 422) return aliasRejected_('');
  return SHORTENER_FAILED;
}

function aliasRejected_(reason) {
  var message = /not available/i.test(reason) || !reason
    ? 'That short link text is already taken. Please try something else.'
    : 'TinyURL didn\'t accept that text: ' + reason;
  return { error: 'ALIAS_REJECTED', message: message };
}
