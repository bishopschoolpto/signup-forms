/**
 * Publishes each event's public view to the Cloudflare Worker in edge/, so
 * the static site's first page load takes about 100 ms instead of waiting
 * for Apps Script. Apps Script stays the source of truth: sign-ups,
 * cancellations and every refresh after the first load still come here.
 *
 *   - The 1-minute timer calls syncEdge_ after refreshing the cache. It sends
 *     only views that changed since they were last published (kept in Script
 *     Properties as "edgeEvent:<eventId>" = "<hash>|<published ms>"), removes events that left
 *     the Events and Past events folders, and sends the open events list when
 *     it changes.
 *   - At least every EDGE_HEARTBEAT_MINUTES it publishes even when nothing
 *     changed. The Worker stops serving data that hasn't been confirmed for
 *     20 minutes, so if this timer stops, the site falls back to Apps Script
 *     instead of showing stale data.
 *   - A sign-up or cancellation publishes its event at once.
 *
 * Publishing happens under the script lock, so two publishes of one event
 * can't arrive in the wrong order. Does nothing unless the EDGE_URL and
 * EDGE_SECRET script properties are set.
 */

var EDGE_EVENT_HASH_PREFIX = 'edgeEvent:';
var EDGE_OPEN_EVENTS_HASH_KEY = 'edgeOpenEvents';
var EDGE_SYNCED_AT_KEY = 'edgeSyncedAt';
var EDGE_HEARTBEAT_MINUTES = 10;
var EDGE_MAX_EVENTS_PER_PUBLISH = 50; // Keeps each Worker run well inside its KV operation limit.

function edgeConfigured_(config) {
  return !!(config.edgeUrl && config.edgeSecret);
}

/** The view as the page shows it: open/closed comes from the event's folder. */
function applyEventState_(view, state) {
  view.isOpen = state === EVENT_STATE.OPEN;
  view.waitlistOpen = view.isOpen && !!view.allSlotsFull;
  return view;
}

/** Short hash of text, to notice changes (cyrb53; not for security). */
function hashText_(text) {
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Timer step: publishes what changed since the last publish. files is the
 * listing refreshEventCaches_ just used. Returns a summary for its log line,
 * or null when the edge isn't configured.
 */
function syncEdge_(files) {
  var config = getConfig_();
  if (!edgeConfigured_(config)) return null;
  var lock = LockService.getScriptLock();
  var locked = lock.tryLock(20000);
  markTiming_('edgeLock');
  if (!locked) return { skipped: 'busy' };
  try {
    return syncEdgeLocked_(config, files);
  } finally {
    lock.releaseLock();
  }
}

function syncEdgeLocked_(config, files) {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperties();
  markTiming_('edgeProps');
  var published = {};
  Object.keys(stored).forEach(function (key) {
    if (key.indexOf(EDGE_EVENT_HASH_PREFIX) === 0) published[key.slice(EDGE_EVENT_HASH_PREFIX.length)] = parsePublished_(stored[key]).hash;
  });

  var cache = CacheService.getScriptCache();
  var put = {}, hashes = {}, keep = {};
  files.forEach(function (file) {
    if (file.state === EVENT_STATE.NONE) return;
    var view = getCachedPublicEvent_(file.id);
    if (!view) {
      // Not built this run (it failed, or the timer ran out of time): leave it
      // as published. One with no Event tab is not an event: remove it.
      if (cache.get(eventStateCacheKey_(file.id)) !== file.modifiedTime + '|hidden') keep[file.id] = true;
      return;
    }
    keep[file.id] = true;
    applyEventState_(view, file.state);
    var hash = hashText_(JSON.stringify(view));
    if (published[file.id] !== hash) {
      put[file.id] = view;
      hashes[file.id] = hash;
    }
  });
  var removed = Object.keys(published).filter(function (id) { return !keep[id]; });

  var openEvents = getCachedOpenEvents_();
  var openEventsHash = null;
  if (openEvents) {
    openEvents = publicOpenEvents_(openEvents);
    openEventsHash = hashText_(JSON.stringify(openEvents));
    if (openEventsHash === parsePublished_(stored[EDGE_OPEN_EVENTS_HASH_KEY]).hash) openEvents = null;
  }

  markTiming_('edgeDiff');
  var ids = Object.keys(put);
  var heartbeatDue = Date.now() - Number(stored[EDGE_SYNCED_AT_KEY] || 0) >= EDGE_HEARTBEAT_MINUTES * 60 * 1000;
  var summary = { published: 0, removed: 0, openEvents: false, failed: false };
  if (!ids.length && !removed.length && !openEvents && !heartbeatDue) return summary;

  // In chunks; the last one also carries the deletions and the open events list.
  var batches = [];
  for (var i = 0; i < ids.length; i += EDGE_MAX_EVENTS_PER_PUBLISH) batches.push(ids.slice(i, i + EDGE_MAX_EVENTS_PER_PUBLISH));
  if (!batches.length) batches.push([]);
  for (var b = 0; b < batches.length; b++) {
    var last = b === batches.length - 1;
    var body = { put: {} };
    batches[b].forEach(function (id) { body.put[id] = put[id]; });
    if (last && removed.length) body['delete'] = removed;
    if (last && openEvents) body.openEvents = openEvents;
    var accepted = postToEdge_(config, body);
    markTiming_('edgePost');
    if (!accepted) {
      summary.failed = true;
      return summary; // Unrecorded hashes are retried on the next run.
    }
    var record = {};
    var now = Date.now();
    batches[b].forEach(function (id) { record[EDGE_EVENT_HASH_PREFIX + id] = hashes[id] + '|' + now; });
    record[EDGE_SYNCED_AT_KEY] = String(now);
    if (last && openEvents) record[EDGE_OPEN_EVENTS_HASH_KEY] = openEventsHash + '|' + now;
    props.setProperties(record);
    markTiming_('edgeRecord');
    summary.published += batches[b].length;
  }
  removed.forEach(function (id) { props.deleteProperty(EDGE_EVENT_HASH_PREFIX + id); });
  markTiming_('edgeRecord');
  summary.removed = removed.length;
  summary.openEvents = !!openEvents;
  return summary;
}

/**
 * Publishes one event's new view right after a sign-up or cancellation.
 * Call while holding the script lock. Never throws: the timer retries.
 */
function publishEventToEdge_(eventId, view) {
  var config = getConfig_();
  if (!edgeConfigured_(config)) return;
  try {
    var state = getEventState_(eventId);
    if (state === EVENT_STATE.NONE) return;
    var shown = applyEventState_(JSON.parse(JSON.stringify(view)), state);
    var body = { put: {} };
    body.put[eventId] = shown;
    if (postToEdge_(config, body)) {
      PropertiesService.getScriptProperties().setProperty(EDGE_EVENT_HASH_PREFIX + eventId, hashText_(JSON.stringify(shown)) + '|' + Date.now());
    }
  } catch (err) {
    console.warn('Could not publish event ' + eventId + ' to the edge: ' + err);
  }
}

/** "<hash>|<published ms>" → { hash, at }. */
function parsePublished_(value) {
  var parts = String(value || '').split('|');
  return { hash: parts[0] || '', at: Number(parts[1]) || 0 };
}

/**
 * A browser found the edge's copy different from Apps Script's (see the
 * static site's check in scripts/build-site.js). Logs one "edge mismatch"
 * line with a likely cause:
 *   edge-behind      the edge served something older than the last publish,
 *                    more than EDGE_PROPAGATION_MS after it: a real problem
 *   propagating      the same, but within KV's normal delay
 *   not-published    Apps Script's current data hasn't been published yet
 *                    (the timer runs every minute): normal right after a change
 *   unexplained      the edge has the latest publish and it matches Apps
 *                    Script's data, yet the browser saw a difference: a bug
 * input: { eventId ('' for the open events list), publishedAt, diffs }.
 * At most EDGE_MISMATCH_REPORTS_PER_HOUR are logged; the rest are counted.
 */
var EDGE_PROPAGATION_MS = 2 * 60 * 1000;
var EDGE_MISMATCH_REPORTS_PER_HOUR = 60;

function reportEdgeMismatch_(input) {
  input = input || {};
  var eventId = String(input.eventId || '');
  if (eventId && !SPREADSHEET_ID_PATTERN.test(eventId)) return { ok: false, error: 'INVALID' };
  var edgePublishedAt = Number(input.publishedAt) || 0;
  var diffs = (Array.isArray(input.diffs) ? input.diffs : []).slice(0, 20).map(function (d) { return String(d).slice(0, 200); });

  var cache = CacheService.getScriptCache();
  var hour = 'edgeMismatches:' + Math.floor(Date.now() / 3600000);
  var count = Number(cache.get(hour) || 0) + 1;
  cache.put(hour, String(count), 3600);
  if (count > EDGE_MISMATCH_REPORTS_PER_HOUR) return { ok: true };

  var props = PropertiesService.getScriptProperties();
  var last = parsePublished_(props.getProperty(eventId ? EDGE_EVENT_HASH_PREFIX + eventId : EDGE_OPEN_EVENTS_HASH_KEY));
  var current = null;
  if (eventId) {
    var view = getCachedPublicEvent_(eventId);
    if (view) current = hashText_(JSON.stringify(applyEventState_(view, getEventState_(eventId))));
  } else {
    var events = getCachedOpenEvents_();
    if (events) current = hashText_(JSON.stringify(publicOpenEvents_(events)));
  }

  var cause;
  if (edgePublishedAt && last.at && edgePublishedAt < last.at - 1000) {
    cause = Date.now() - last.at > EDGE_PROPAGATION_MS ? 'edge-behind' : 'propagating';
  } else if (current && current !== last.hash) {
    cause = 'not-published';
  } else {
    cause = 'unexplained';
  }
  console.warn('edge mismatch ' + JSON.stringify({
    cause: cause,
    eventId: eventId || '(open events list)',
    edgeAgeSec: edgePublishedAt ? Math.round((Date.now() - edgePublishedAt) / 1000) : null,
    lastPublishSec: last.at ? Math.round((Date.now() - last.at) / 1000) : null,
    diffs: diffs,
  }));
  return { ok: true };
}

/** POSTs a publish request to the Worker. Returns true if it was accepted. */
function postToEdge_(config, body) {
  try {
    var res = UrlFetchApp.fetch(config.edgeUrl.replace(/\/+$/, '') + '/publish', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + config.edgeSecret },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 200) return true;
    console.warn('Edge publish failed: HTTP ' + res.getResponseCode() + ' ' + String(res.getContentText()).slice(0, 200));
  } catch (err) {
    console.warn('Edge publish failed: ' + err);
  }
  return false;
}
