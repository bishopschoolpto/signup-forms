/**
 * Per-request timing, for investigating latency. Each web request logs one
 * line, e.g.
 *   timing {"api":"page","ms":412,"steps":{"config":95,"state":40,"cache":38,"serialize":2},"cacheHit":true}
 * View them in the Apps Script editor → Executions. Steps add up to about
 * ms; anything not marked lands in the next marked step.
 */

var requestTiming_ = null;

function startTiming_(api) {
  var now = Date.now();
  requestTiming_ = { api: api, started: now, last: now, steps: {}, notes: {} };
}

/** Charges the time since the previous mark to step (adding up repeats). */
function markTiming_(step) {
  if (!requestTiming_) return;
  var now = Date.now();
  requestTiming_.steps[step] = (requestTiming_.steps[step] || 0) + (now - requestTiming_.last);
  requestTiming_.last = now;
}

/** Records a value, such as whether the cache was hit. */
function noteTiming_(key, value) {
  if (requestTiming_) requestTiming_.notes[key] = value;
}

function logTiming_() {
  if (!requestTiming_) return;
  var t = requestTiming_;
  requestTiming_ = null;
  var line = { api: t.api, ms: Date.now() - t.started, steps: t.steps };
  Object.keys(t.notes).forEach(function (k) { line[k] = t.notes[k]; });
  console.log('timing ' + JSON.stringify(line));
}
