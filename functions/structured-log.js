'use strict';

// Structured logging helper. Cloud Logging parses a single-line JSON object on
// stdout/stderr and maps `severity` and `message`; every other key becomes a
// searchable jsonPayload field (log-based metrics and alerts key on `event`).
//
// Privacy contract: callers pass categories and counts only. The helper
// drops values that look like secrets or personal data (email addresses,
// long tokens) as a last line of defence, and truncates strings.

const MAX_STRING = 200;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const TOKEN_RE = /^[A-Za-z0-9_\-.]{40,}$/;
const DROP_KEYS = new Set(['password', 'token', 'email', 'idToken', 'authorization', 'text', 'body']);

function sanitize(value, depth) {
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) return '[redacted-email]';
    if (TOKEN_RE.test(value)) return '[redacted-token]';
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (depth > 3) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 40)) {
      if (DROP_KEYS.has(key)) { out[key] = '[redacted]'; continue; }
      out[key] = sanitize(value[key], depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

function entry(severity, event, fields) {
  return Object.assign({ severity, message: String(event || 'event'), event: String(event || 'event') },
    sanitize(fields || {}, 0));
}

function emit(severity, event, fields, sink) {
  const line = JSON.stringify(entry(severity, event, fields));
  const out = sink || (severity === 'ERROR' || severity === 'WARNING' ? console.error : console.log);
  out(line);
  return line;
}

module.exports = {
  entry, sanitize,
  info: (event, fields, sink) => emit('INFO', event, fields, sink),
  warn: (event, fields, sink) => emit('WARNING', event, fields, sink),
  error: (event, fields, sink) => emit('ERROR', event, fields, sink),
  alert: (event, fields, sink) => emit('ALERT', event, fields, sink)
};
