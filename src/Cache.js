/**
 * Caching of each event's public view (what the sign-up page shows).
 *
 * Views are cached for 15 minutes and kept fresh by a 1-minute timer
 * (installed by setup()). Each run asks Drive for the spreadsheets in the
 * Events and Past events folders and their last-modified times (one call per
 * folder), and only reopens
 * spreadsheets that changed since the last run; unchanged views just have
 * their expiry extended. So:
 *   - first-time visitors usually get a cached page;
 *   - edits typed into a spreadsheet show up within about a minute;
 *   - a sign-up writes the new view into the cache immediately.
 * Sign-ups never trust the cache: capacity is always re-checked in the sheet.
 */

var PUBLIC_EVENT_CACHE_SECONDS = 15 * 60;
var REFRESH_TRIGGER_HANDLER = 'refreshEventCaches';
var REFRESH_BUDGET_MS = 4 * 60 * 1000; // Stay well inside the 6-minute execution limit.
// The home page's list of open events with spots left, rebuilt by every timer run.
var OPEN_EVENTS_CACHE_KEY = 'openEvents';

function publicEventCacheKey_(eventId) {
  return 'publicEvent:' + eventId;
}

/**
 * What the timer last saw for a spreadsheet: "<modifiedTime>|shown" or
 * "<modifiedTime>|hidden". Unchanged spreadsheets are skipped, including
 * ones that aren't events, such as a spreadsheet with no Event tab.
 */
function eventStateCacheKey_(eventId) {
  return 'eventState:' + eventId;
}

function getCachedPublicEvent_(eventId) {
  var cached = CacheService.getScriptCache().get(publicEventCacheKey_(eventId));
  return cached ? JSON.parse(cached) : null;
}

/** Caches a view; modifiedTime (optional) lets the timer skip unchanged spreadsheets. */
function cachePublicEvent_(eventId, view, modifiedTime) {
  var cache = CacheService.getScriptCache();
  try {
    cache.put(publicEventCacheKey_(eventId), JSON.stringify(view), PUBLIC_EVENT_CACHE_SECONDS);
  } catch (err) {
    console.warn('Could not cache event ' + eventId + ' (too large?): ' + err);
    cache.remove(eventStateCacheKey_(eventId));
    return;
  }
  if (modifiedTime) cache.put(eventStateCacheKey_(eventId), modifiedTime + '|shown', PUBLIC_EVENT_CACHE_SECONDS);
  else cache.remove(eventStateCacheKey_(eventId)); // Unknown: the timer will rebuild it once.
}

/** Removes a hidden event's view, remembering it as hidden at this modifiedTime. */
function uncachePublicEvent_(eventId, modifiedTime) {
  var cache = CacheService.getScriptCache();
  cache.remove(publicEventCacheKey_(eventId));
  cache.put(eventStateCacheKey_(eventId), modifiedTime + '|hidden', PUBLIC_EVENT_CACHE_SECONDS);
}

/** Reads an event spreadsheet into its public view, or null if it has no Event tab. */
function buildEventView_(ss, isOpen) {
  var event = readEventInfo_(ss);
  if (!event) return null;
  event.isOpen = isOpen;
  var view = buildPublicEvent_(event, readSlots_(ss), readTable_(ss, 'Signups'), makeWhenFormatter_(getConfig_().timeZone));
  view.questions = readQuestions_(ss);
  return view;
}

/**
 * Timer entry point. It is public (triggers can only call public functions),
 * which also exposes it to google.script.run, so it refuses to run unless
 * called by one of this project's own triggers.
 */
function refreshEventCaches(e) {
  if (!isProjectTrigger_(e)) throw new Error('refreshEventCaches only runs from its timer.');
  return refreshEventCaches_();
}

function isProjectTrigger_(e) {
  var uid = e && e.triggerUid;
  if (!uid) return false;
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === String(uid); });
}

function refreshEventCaches_() {
  var started = Date.now();
  var cache = CacheService.getScriptCache();
  var stats = { events: 0, reused: 0, rebuilt: 0, hidden: 0, failed: 0, skippedForTime: 0 };

  var files = listEventSpreadsheets_();
  files.forEach(function (file) {
    // Listed from its folder, so its folder check is known: refresh it too.
    cacheEventState_(file.id, file.state);
    if (file.state === EVENT_STATE.NONE) return; // the Event Template
    stats.events++;
    if (Date.now() - started > REFRESH_BUDGET_MS) { stats.skippedForTime++; return; }

    var state = cache.get(eventStateCacheKey_(file.id));
    if (state === file.modifiedTime + '|hidden') {
      cache.put(eventStateCacheKey_(file.id), state, PUBLIC_EVENT_CACHE_SECONDS);
      stats.hidden++;
      return;
    }
    var view = cache.get(publicEventCacheKey_(file.id));
    if (view && state === file.modifiedTime + '|shown') {
      cache.put(publicEventCacheKey_(file.id), view, PUBLIC_EVENT_CACHE_SECONDS);
      cache.put(eventStateCacheKey_(file.id), state, PUBLIC_EVENT_CACHE_SECONDS);
      stats.reused++;
      return;
    }
    try {
      var built = buildEventView_(SpreadsheetApp.openById(file.id), file.state === EVENT_STATE.OPEN);
      if (built) {
        cachePublicEvent_(file.id, built, file.modifiedTime);
        stats.rebuilt++;
      } else {
        uncachePublicEvent_(file.id, file.modifiedTime);
        stats.hidden++;
      }
    } catch (err) {
      console.warn('Could not refresh event ' + file.id + ': ' + err);
      stats.failed++;
    }
  });

  stats.listed = cacheOpenEvents_(files);
  console.log('Event cache refresh: ' + JSON.stringify(stats));
  return stats;
}

/**
 * Builds the open-events list from the cached views of the spreadsheets
 * directly in Events, and caches it. Returns how many events it lists.
 */
function cacheOpenEvents_(files) {
  var timeZone = getConfig_().timeZone;
  var formatDay = function (value) {
    var d = new Date(value);
    return value && !isNaN(d.getTime()) ? Utilities.formatDate(d, timeZone, 'EEE, MMM d, yyyy') : '';
  };
  var summaries = [];
  files.forEach(function (file) {
    if (file.state !== EVENT_STATE.OPEN) return;
    var view = getCachedPublicEvent_(file.id);
    if (view) summaries.push(summarizeEvent_(view, formatDay));
  });
  var open = listOpenSummaries_(summaries);
  try {
    CacheService.getScriptCache().put(OPEN_EVENTS_CACHE_KEY, JSON.stringify(open), PUBLIC_EVENT_CACHE_SECONDS);
  } catch (err) {
    console.warn('Could not cache the open events list (too large?): ' + err);
  }
  return open.length;
}

/** The cached open-events list, or null if it has expired. */
function getCachedOpenEvents_() {
  var cached = CacheService.getScriptCache().get(OPEN_EVENTS_CACHE_KEY);
  return cached ? JSON.parse(cached) : null;
}

/**
 * Spreadsheets directly in the Events and Past events folders (not their
 * subfolders), with modifiedTime and EVENT_STATE.
 */
function listEventSpreadsheets_() {
  var config = getConfig_();
  var found = [];
  [config.eventsFolderId, config.pastEventsFolderId].forEach(function (folderId) {
    var pageToken;
    do {
      var page = Drive.Files.list({
        q: "'" + folderId + "' in parents and trashed = false",
        fields: 'nextPageToken, files(id, mimeType, modifiedTime)',
        pageSize: 200,
        pageToken: pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      (page.files || []).forEach(function (f) {
        if (f.mimeType !== SPREADSHEET_MIME_TYPE) return;
        found.push({ id: f.id, modifiedTime: f.modifiedTime, state: eventStateFor_(f.id, [folderId]) });
      });
      pageToken = page.nextPageToken;
    } while (pageToken);
  });
  return found;
}

/** Creates the 1-minute refresh trigger unless it already exists. Returns true if created. */
function installRefreshTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === REFRESH_TRIGGER_HANDLER;
  });
  if (exists) return false;
  ScriptApp.newTrigger(REFRESH_TRIGGER_HANDLER).timeBased().everyMinutes(1).create();
  return true;
}
