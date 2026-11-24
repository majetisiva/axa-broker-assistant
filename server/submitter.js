'use strict';
// Submission adapter: turns the collected request JSON into a call to the existing
// Java APIs (the same ones the Angular webforms call on "TO CONFIRM").
// Point BACKEND_BASE_URL at the real API gateway; by default it targets the mock back end.
const fs = require('fs');

class HttpSubmitter {
  // transport: optional (path, body) => [status, json]. When set (the built-in mock), no HTTP call is made.
  constructor({ baseUrl, uploads, sendFiles = false, headers = {}, transport = null }) {
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.transport = transport;
    this.uploads = uploads;
    this.sendFiles = sendFiles;
    this.headers = headers;
  }

  async submit(action, payload) {
    const body = { ...payload, fields: { ...payload.fields } };
    // Some webform APIs take dates as YYYY-MM-DD ("submitAs": "iso-date"); the request JSON keeps DD/MM/YYYY.
    for (const f of action.fields || []) {
      const v = body.fields[f.id];
      if (f.submitAs === 'iso-date' && typeof v === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(v)) body.fields[f.id] = v.split('/').reverse().join('-');
    }
    if (this.sendFiles) {
      body.documents = Object.entries(payload.fields)
        .filter(([, v]) => v && typeof v === 'object' && v.fileId)
        .map(([fieldId, v]) => {
          const f = this.uploads.get(v.fileId);
          return { fieldId, name: v.name, mime: v.mime, contentBase64: f ? fs.readFileSync(f.path).toString('base64') : null };
        });
    }
    let res, json;
    if (this.transport) {
      const [status, j] = this.transport(action.submission.endpoint, body);
      res = { status, ok: status >= 200 && status < 300 }; json = j;
    } else {
      const url = this.baseUrl + action.submission.endpoint;
      res = await fetch(url, {
        method: action.submission.method || 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': payload.language || 'en', ...this.headers },
        body: JSON.stringify(body)
      });
      json = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 422 && res.status !== 400) console.error(`[submitter] ${url} answered HTTP ${res.status}`);
    }
    if (res.status === 422 || res.status === 400) {
      const fieldErrors = Object.fromEntries((json.errors || []).filter(e => e.field).map(e => [e.field, e.message]));
      return { ok: false, fieldErrors, message: json.message || (json.errors || []).map(e => e.message).join(' ') };
    }
    // Wording of these two cases is chosen by the engine, in the conversation language.
    if (!res.ok) return { ok: false, code: 'http_error', status: res.status };
    if (json.status === 'COMPLETED') return { ok: true, outcome: 'stp_completed', details: { backendReference: json.reference, task: json.task } };
    if (json.status === 'ROUTED') return { ok: true, outcome: 'routed_to_handler', details: { backendReference: json.reference, mail: json.mail } };
    return { ok: false, code: 'unexpected' };
  }
}

module.exports = { HttpSubmitter };
