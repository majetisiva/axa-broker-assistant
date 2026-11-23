'use strict';
// In-memory stores. Swap for Redis / a database in production; the interface stays the same.
const crypto = require('crypto');

const id = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;

class SessionStore {
  constructor(ttlMs = 2 * 60 * 60 * 1000) { this.map = new Map(); this.ttlMs = ttlMs; }
  create(data) {
    const s = { id: id('S'), createdAt: new Date().toISOString(), touchedAt: Date.now(), ...data };
    this.map.set(s.id, s);
    return s;
  }
  get(sid) {
    const s = this.map.get(sid);
    if (!s) return null;
    if (Date.now() - s.touchedAt > this.ttlMs) { this.map.delete(sid); return null; }
    s.touchedAt = Date.now();
    return s;
  }
}

class RequestStore {
  constructor() { this.map = new Map(); }
  save(req) { this.map.set(req.requestId, req); return req; }
  get(rid) { return this.map.get(rid) || null; }
  list(filter = {}) {
    return [...this.map.values()]
      .filter(r => !filter.producerNumber || r.broker?.producerNumber === filter.producerNumber)
      .filter(r => !filter.sessionId || r._sessionId === filter.sessionId)
      .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
  }
}

class UploadStore {
  constructor() { this.map = new Map(); }
  save(meta) { const f = { fileId: id('F'), ...meta }; this.map.set(f.fileId, f); return f; }
  get(fid) { return this.map.get(fid) || null; }
}

function requestId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `REQ-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

module.exports = { SessionStore, RequestStore, UploadStore, requestId };
