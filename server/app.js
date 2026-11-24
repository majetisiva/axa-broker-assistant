'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadCatalogue, toJsonSchema } = require('./engine/catalogue');
const { DialogueEngine } = require('./engine/dialogue');
const { SessionStore, RequestStore, UploadStore } = require('./engine/store');
const { HttpSubmitter } = require('./submitter');
const { createMockBackend } = require('./mock-backend');

const ROOT = path.join(__dirname, '..');
const MAX_BODY = 15 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.eml': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8' };

function createApp(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 8080);
  const catalogue = loadCatalogue(opts.catalogueDir || path.join(ROOT, 'catalogue'));
  const sessions = new SessionStore();
  const requests = new RequestStore();
  const uploads = new UploadStore();
  const uploadDir = opts.uploadDir || path.join(ROOT, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

  const mockBackend = createMockBackend({ outboxDir: path.join(ROOT, 'outbox'), uploads });
  const submitter = opts.submitter || new HttpSubmitter({
    baseUrl: process.env.BACKEND_BASE_URL,
    transport: process.env.BACKEND_BASE_URL ? null : mockBackend.invoke,
    uploads,
    sendFiles: process.env.BACKEND_SEND_FILES === 'true'
  });
  const engine = new DialogueEngine({ catalogue, submitter, requests, uploads });

  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(data));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });

  // The webforms need the CIF and distributor (DIF) numbers of the portal session. The portal passes them
  // in `context`; in the demo (mock back end) fictitious ones are used so the chat works without a login.
  const demoSession = opts.demoSession ?? !process.env.BACKEND_BASE_URL;
  const DEMO_CONTEXT = { cifNumber: '00012345', difNumber: '0012345' };

  const getSession = (sid, mode = 'human', context = {}) => {
    let s = sid && sessions.get(sid);
    if (!s) {
      const given = Object.fromEntries(Object.entries(context || {}).filter(([, v]) => v !== undefined));
      s = sessions.create({});
      engine.initSession(s, { mode, context: demoSession ? { ...DEMO_CONTEXT, ...given } : given });
    }
    return s;
  };

  const serveStatic = (res, rel) => {
    const file = path.normalize(path.join(ROOT, rel));
    const allowed = ['chat', 'widget', 'demo', 'angular', 'outbox', 'catalogue'].some(d => file.startsWith(path.join(ROOT, d) + path.sep));
    if (!allowed || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { message: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    try {
      if (p === '/health') return send(res, 200, { ok: true, actions: catalogue.actions.length, llm: process.env.LLM_PROVIDER || 'off' });

      if (p.startsWith('/mock-backend/')) return mockBackend.handle(req, res, p.slice('/mock-backend'.length), await readBody(req));

      if (p === '/api/actions' && req.method === 'GET') {
        return send(res, 200, catalogue.actions.map(a => ({
          id: a.id, version: a.version, title: a.title, summary: a.summary, segment: a.segment, lineOfBusiness: a.lineOfBusiness,
          mock: !!a.mock, mode: a.submission.mode,
          fields: a.fields.map(f => ({ id: f.id, label: f.label, type: f.type, required: !!f.required, requiredWhen: f.requiredWhen || null, multiple: !!f.multiple, options: f.options?.map(o => ({ value: o.value, label: o.label })) }))
        })));
      }
      let m = p.match(/^\/api\/actions\/([a-z0-9_]+)\/schema$/);
      if (m) {
        const a = catalogue.get(m[1]);
        return a ? send(res, 200, toJsonSchema(a)) : send(res, 404, { message: 'unknown action' });
      }

      if (p === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const s = getSession(null, body.mode === 'agent' ? 'agent' : 'human', body.context || {});
        return send(res, 200, engine.welcome(s));
      }

      if (p === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req);
        const s = getSession(body.sessionId, 'human', body.context || {});
        return send(res, 200, await engine.handle(s, { text: body.text, fileId: body.fileId, action: body.action }));
      }

      // Agent-to-agent: same engine, machine-friendly answer.
      if (p === '/api/agent/requests' && req.method === 'POST') {
        const body = await readBody(req);
        const s = getSession(body.sessionId, 'agent', body.context || {});
        const r = await engine.handle(s, { text: body.text, fileId: body.fileId, action: body.action, fields: body.fields, confirm: body.confirm === true, language: body.language });
        return send(res, 200, {
          sessionId: r.sessionId,
          status: r.status,
          language: r.language,
          action: r.state.action,
          missingFields: r.state.fields.filter(f => f.status !== 'ok').map(f => ({ id: f.id, label: f.label, type: f.type, prompt: f.prompt, error: f.error, accept: f.accept })),
          providedFields: r.state.fields.filter(f => f.status === 'ok').map(f => ({ id: f.id, value: f.value, source: f.source })),
          nextStep: r.status === 'awaiting_confirmation' ? 'confirm' : r.status === 'submitted' ? 'done' : r.state.action ? 'provide_fields' : 'choose_action',
          message: r.replies.filter(x => x.text).map(x => x.text).join('\n'),
          options: r.quickReplies.filter(q => q.action).map(q => q.action),
          request: r.request
        });
      }

      if (p === '/api/uploads' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.name || !body.dataBase64) return send(res, 400, { message: 'name and dataBase64 are required' });
        const buf = Buffer.from(body.dataBase64, 'base64');
        if (buf.length > 10 * 1024 * 1024) return send(res, 413, { message: 'File larger than 10 MB.' });
        const meta = uploads.save({ name: String(body.name).slice(0, 200), size: buf.length, mime: body.mime || 'application/octet-stream', uploadedAt: new Date().toISOString() });
        meta.path = path.join(uploadDir, meta.fileId);
        fs.writeFileSync(meta.path, buf);
        return send(res, 200, { fileId: meta.fileId, name: meta.name, size: meta.size, mime: meta.mime });
      }

      if (p === '/api/requests' && req.method === 'GET') {
        const list = requests.list({ sessionId: url.searchParams.get('sessionId'), producerNumber: url.searchParams.get('producerNumber') });
        return send(res, 200, list.map(({ _sessionId, ...r }) => r));
      }
      m = p.match(/^\/api\/requests\/([A-Z0-9\-]+)$/);
      if (m) {
        const r = requests.get(m[1]);
        if (!r) return send(res, 404, { message: 'unknown request' });
        const { _sessionId, ...pub } = r;
        return send(res, 200, pub);
      }

      if (p === '/' || p === '/index.html') return serveStatic(res, 'chat/index.html');
      if (p === '/demo' || p === '/demo/') return serveStatic(res, 'demo/index.html');
      if (req.method === 'GET') return serveStatic(res, p.slice(1));
      return send(res, 404, { message: 'not found' });
    } catch (err) {
      console.error(err);
      return send(res, err.status || 500, { message: err.status ? err.message : 'Internal error' });
    }
  });

  return { server, engine, catalogue, sessions, requests, uploads, port };
}

module.exports = { createApp };
