'use strict';
// Conversation engine: identify the action, collect fields, accept corrections,
// confirm, submit. Entirely driven by the catalogue; nothing here is form-specific.
const nlu = require('./nlu');
const { makeValidators, validateField } = require('./validators');
const { isRequired, activeFields } = require('./catalogue');
const { requestId } = require('./store');
const llm = require('./llm');
const { t, joinList, LANGS } = require('./i18n');

const STATUS = {
  IDLE: 'idle',
  CLARIFYING: 'clarifying',
  COLLECTING: 'collecting',
  CONFIRMING: 'awaiting_confirmation',
  SUBMITTING: 'submitting',
  SUBMITTED: 'submitted',
  CANCELLED: 'cancelled'
};

const ENTITY_TYPES = ['contractNumber', 'producerNumber', 'iban', 'date'];

class DialogueEngine {
  constructor({ catalogue, submitter, requests, uploads }) {
    this.catalogue = catalogue;
    this.submitter = submitter;
    this.requests = requests;
    this.uploads = uploads;
    this.validators = makeValidators(catalogue.fieldFormats);
  }

  initSession(session, { mode = 'human', context = {} } = {}) {
    Object.assign(session, {
      mode,
      status: STATUS.IDLE,
      actionId: null,
      values: {},
      provenance: {},
      invalid: {},
      pendingFieldId: null,
      clarify: null,
      buffer: null,
      draftId: null,
      profile: { producerNumber: context.producerNumber || null, brokerName: context.brokerName || null },
      // Conversation language: the portal's language until the broker's first message decides it, then fixed.
      lang: LANGS.includes(context.language) ? context.language : 'en',
      langLocked: false,
      pageHint: context.actionId && this.catalogue.get(context.actionId) ? context.actionId : null,
      transcript: session.transcript || [],
      submitted: session.submitted || []
    });
    return session;
  }

  // ---------- public entry points ----------

  welcome(session) {
    const out = this.out(session);
    const name = session.profile.brokerName;
    out.say(t(session.lang, 'welcome', { name }));
    return out.done();
  }

  async handle(session, input = {}) {
    const text = String(input.text || '').trim();
    const out = this.out(session);
    session.turns = (session.turns || 0) + 1;
    if (text || input.fileId) session.transcript.push({ role: 'user', text, fileId: input.fileId || null, at: new Date().toISOString() });

    // The language the broker starts in is kept for the whole conversation.
    if (!session.langLocked) {
      const lang = LANGS.includes(input.language) ? input.language : (text ? nlu.detectLanguage(text) : null);
      if (lang) { session.lang = lang; session.langLocked = true; }
    }
    const L = session.lang;

    const meta = text ? nlu.detectMeta(text) : null;

    if (input.reset || meta === 'reset') {
      this.clearRequest(session);
      out.say(t(L, 'reset'));
      return out.done();
    }
    if (meta === 'abort') {
      const had = !!session.actionId;
      this.clearRequest(session);
      session.status = STATUS.CANCELLED;
      out.say(t(L, had ? 'abortHad' : 'abortNone'));
      return out.done();
    }
    if (text && nlu.detectInjection(text)) {
      out.say(t(L, 'injection'), 'notice');
    }
    if (session.status === STATUS.SUBMITTED || session.status === STATUS.CANCELLED) {
      session.status = STATUS.IDLE;
    }

    // 1. Identify the action
    if (!session.actionId) {
      const handled = await this.identify(session, input, text, meta, out);
      if (handled) return out.done();
    }
    const action = this.act(session);

    // 2. Confirmation step
    const entities = text ? nlu.extractEntities(text) : null;
    const hasNewData = !!input.fileId || (input.fields && Object.keys(input.fields).length) ||
      (entities && ENTITY_TYPES.some(t => entities[t].length));

    if (session.status === STATUS.CONFIRMING && !hasNewData) {
      if (input.confirm || meta === 'confirm') return this.submit(session, action, out);
      if (meta === 'deny') {
        session.status = STATUS.COLLECTING;
        session.pendingFieldId = null;
        out.say(t(L, 'denyAsk'));
        out.quick(this.missingOrAll(session, action, true).map(f => ({ label: t(L, 'changeChip', { label: f.label }), text: `change ${f.label}` })));
        return out.done();
      }
    }

    if (meta === 'status') {
      this.reportProgress(session, action, out, { summaryOnly: true });
      return out.done();
    }
    if (meta === 'help' && !hasNewData) {
      const f = action.fields.find(x => x.id === session.pendingFieldId);
      out.say(f ? t(L, 'helpField', { help: f.help || f.prompt }) : t(L, 'helpAction', { title: action.title, summary: action.summary }));
      return out.done();
    }

    // "change producer number" without a value: point at that field
    const ref = text ? nlu.referencedField(text, action) : null;
    if (ref && !hasNewData && nlu.wantsChange(text)) {
      session.status = STATUS.COLLECTING;
      session.pendingFieldId = ref.id;
      out.say(t(L, 'sureAsk', { q: (ref.ask || [ref.prompt])[0] }));
      out.expect(ref);
      return out.done();
    }

    // 3. Apply what the broker gave us
    const llmResult = text && !hasNewData ? await llm.understand({ text, catalogue: this.catalogue, action, pendingField: session.pendingFieldId }) : null;
    const result = this.apply(session, action, { text, entities, fileId: input.fileId, fields: input.fields, llmFields: llmResult?.fields, ref });

    if (meta === 'confirm' && !result.set.length && !result.errors.length && session.status !== STATUS.CONFIRMING) {
      // "yes" while fields are still missing: just continue
    } else if (!result.set.length && !result.errors.length && text && !meta) {
      const f = action.fields.find(x => x.id === session.pendingFieldId);
      if (/\?\s*$/.test(text) && f?.help) { out.lead(f.help.replace(/\.?$/, '.')); out.explained(); }
      else out.noProgress();
    }

    this.reportResult(result, out, L);
    this.reportProgress(session, action, out);
    return out.done();
  }

  // Current action in the conversation language
  act(session, id = session.actionId) {
    return this.catalogue.localized(id, session.lang);
  }

  // ---------- step 1: action identification ----------

  async identify(session, input, text, meta, out) {
    const L = session.lang;
    const title = id => this.act(session, id).title;
    let chosen = input.action && this.catalogue.get(input.action) ? input.action : null;

    if (!chosen && session.status === STATUS.CLARIFYING && text) {
      const cands = session.clarify.candidates;
      const said = nlu.norm(text);
      chosen = cands.find(id => said.includes(this.catalogue.get(id).title.toLowerCase()) || said.includes(title(id).toLowerCase())) || null;
      if (!chosen) {
        if (/(suspend|suspension|plate|pause|schors|plaque|nummerplaat)/.test(said) && cands.includes('motor_suspension')) chosen = 'motor_suspension';
        else if (/(terminat|for good|permanent|résili|definiti|définiti|opzeg|something else|other|autre chose|iets anders)/.test(said) && cands.includes('general_request')) chosen = 'general_request';
        else if (/(portfolio|intermediary|broker|mandate|portefeuille|intermédiaire|courtier|tussenpersoon|makelaar)/.test(said) && cands.includes('change_intermediary')) chosen = 'change_intermediary';
      }
      if (!chosen) {
        const r = nlu.detectIntent(text, this.catalogue, cands);
        if (r.type === 'action') chosen = r.actionId;
      }
      if (!chosen && !meta) {
        out.say(t(L, 'clarifyRetry', { question: session.clarify.question }));
        out.quick(cands.map(id => ({ label: title(id), action: id })));
        return true;
      }
    }

    if (!chosen && text) {
      if (meta === 'greeting' || meta === 'help') {
        out.say(meta === 'greeting' ? t(L, 'greeting') : t(L, 'helpIdle', { capabilities: t(L, 'capabilities') }));
        return true;
      }
      let intent = nlu.detectIntent(text, this.catalogue);
      if (intent.type === 'none') {
        const l = await llm.understand({ text, catalogue: this.catalogue });
        if (l?.actionId) intent = { type: 'action', actionId: l.actionId };
        else if (l?.ambiguousBetween?.length > 1) intent = { type: 'ambiguous', candidates: l.ambiguousBetween, question: t(L, 'ambiguousLlm') };
      }
      if (intent.type === 'action') chosen = intent.actionId;
      else if (intent.type === 'ambiguous') {
        const question = intent.question || (intent.term ? this.catalogue.text(intent.term, 'question', L) : t(L, 'ambiguousGeneric'));
        session.status = STATUS.CLARIFYING;
        session.clarify = { candidates: intent.candidates, question };
        session.buffer = { text };
        out.say(question);
        out.quick(intent.candidates.map(id => ({ label: title(id), action: id })));
        return true;
      } else if (intent.type === 'unsupported') {
        out.say(t(L, 'unsupported', { message: this.catalogue.text(intent.entry, 'message', L) }));
        return true;
      } else {
        const e = nlu.extractEntities(text);
        const noted = this.describeEntities(e, L);
        session.buffer = { text: (session.buffer?.text ? session.buffer.text + '\n' : '') + text };
        session.unclear = (session.unclear || 0) + 1;
        if (noted) out.say(t(L, 'notedEntities', { noted }));
        else if (session.unclear === 1) out.say(t(L, 'unclear1'));
        else out.say(t(L, 'unclear2', { capabilities: t(L, 'capabilities') }));
        return true;
      }
    }

    if (!chosen && input.fileId) {
      session.buffer = { ...(session.buffer || {}), fileId: input.fileId };
      out.say(t(L, 'fileFirst'));
      return true;
    }
    if (!chosen) {
      out.say(t(L, 'whatHelp'));
      return true;
    }

    // Action selected
    session.actionId = chosen;
    const action = this.act(session);
    session.status = STATUS.COLLECTING;
    session.clarify = null;
    session.draftId = requestId();
    session.unclear = 0;
    const intro = action.intro?.length ? action.intro[session.turns % action.intro.length] : t(L, 'introFallback', { title: action.title });
    out.lead(intro);
    for (const r of action.rules || []) out.tail(r, 'notice');

    // Reuse what we already know: logged-in producer number and anything said earlier
    const reuse = action.fields.find(f => f.type === 'producerNumber');
    if (reuse && session.profile.producerNumber && session.values[reuse.id] === undefined) {
      const v = validateField(this.validators, reuse, session.profile.producerNumber, L);
      if (v.ok) { session.values[reuse.id] = v.value; session.provenance[reuse.id] = 'reused_from_profile'; }
    }
    const buffered = session.buffer; session.buffer = null;
    const earlier = [buffered?.text, input.action ? null : text].filter(Boolean).join('\n');
    if (earlier || buffered?.fileId) {
      const r = this.apply(session, action, {
        text: earlier, entities: nlu.extractEntities(earlier), fileId: buffered?.fileId,
        initialText: earlier
      });
      this.reportResult(r, out, L);
    }
    if (input.fileId || input.fields) {
      const r = this.apply(session, action, { fileId: input.fileId, fields: input.fields });
      this.reportResult(r, out, L);
    }
    this.reportProgress(session, action, out);
    return true;
  }

  // ---------- step 2: slot filling ----------

  apply(session, action, { text = '', entities, fileId, fields, llmFields, ref, initialText }) {
    const assignments = []; // [field, raw, source]
    const used = new Set();
    const pending = action.fields.find(f => f.id === session.pendingFieldId) || null;
    const append = text && nlu.wantsAppend(text);

    // Structured input (agent-to-agent mode or quick forms)
    for (const [k, v] of Object.entries(fields || {})) {
      const f = action.fields.find(x => x.id === k);
      if (!f) { assignments.push([{ id: k, label: k, unknown: true }, v, 'agent']); continue; }
      if (f.type === 'file' && typeof v === 'string') assignments.push([f, this.uploads.get(v) || { fileId: v, missing: true }, 'agent']);
      else assignments.push([f, v, 'agent']);
      used.add(f.id);
    }

    // Typed entities found in free text
    if (entities) {
      for (const type of ENTITY_TYPES) {
        const values = entities[type];
        if (!values.length) continue;
        const candidates = action.fields.filter(f => f.type === type && !used.has(f.id));
        if (!candidates.length) continue;
        let target = candidates.length === 1 ? candidates[0]
          : candidates.find(f => f.id === ref?.id) || candidates.find(f => f.id === pending?.id)
            || candidates.find(f => isRequired(f, session.values) && session.values[f.id] === undefined);
        if (!target) continue;
        let raw;
        if (target.multiple) raw = append && Array.isArray(session.values[target.id]) ? [...session.values[target.id], ...values] : values;
        else raw = values[values.length - 1];
        assignments.push([target, raw, 'broker']);
        used.add(target.id);
      }
    }

    // Enum fields: look for an option keyword
    for (const f of action.fields.filter(x => x.type === 'enum' && !used.has(x.id))) {
      if (!text) continue;
      const shouldTry = session.values[f.id] === undefined || ref?.id === f.id || pending?.id === f.id;
      if (!shouldTry) continue;
      const r = this.validators.enum(text, f, session.lang);
      if (r.ok) { assignments.push([f, text, 'broker']); used.add(f.id); }
      else if (pending?.id === f.id && !entities?.contractNumber.length) { assignments.push([f, text, 'broker']); used.add(f.id); }
    }

    // Free-text fields: the opening message, or the answer to a direct question
    for (const f of action.fields.filter(x => x.type === 'text' && !used.has(x.id))) {
      if (initialText && session.values[f.id] === undefined && initialText.length >= (f.minLength || 1)) {
        assignments.push([f, initialText, 'broker']); used.add(f.id);
      } else if (text && pending?.id === f.id) {
        assignments.push([f, text, 'broker']); used.add(f.id);
      }
    }

    // Documents
    if (fileId) {
      const file = this.uploads.get(fileId);
      const fileFields = action.fields.filter(f => f.type === 'file' && !used.has(f.id));
      const target = fileFields.find(f => f.id === pending?.id)
        || fileFields.find(f => isRequired(f, session.values) && session.values[f.id] === undefined)
        || fileFields.find(f => f.id === ref?.id) || fileFields[0];
      if (target) { assignments.push([target, file || { fileId, missing: true }, 'broker']); used.add(target.id); }
      else assignments.push([{ id: '_file', label: 'Document', unknown: true, noFileField: true }, file, 'broker']);
    }

    // LLM suggestions only fill gaps the rules left
    for (const [k, v] of Object.entries(llmFields || {})) {
      const f = action.fields.find(x => x.id === k);
      if (f && !used.has(f.id)) { assignments.push([f, v, 'broker']); used.add(f.id); }
    }

    // Nothing recognised but we asked a precise question: validate the raw answer to show a helpful error
    if (!assignments.length && pending && text && !/\?\s*$/.test(text) && !nlu.detectMeta(text)
        && ['contractNumber', 'producerNumber', 'iban', 'date'].includes(pending.type) && (/\d/.test(text) || (pending.type === 'date' && text.length < 40))) {
      assignments.push([pending, text.replace(/^(it'?s|it is|the|my|c'est|le|la|mon|ma|het is|het|mijn)\s+/i, ''), 'broker']);
    }

    const set = []; const errors = [];
    for (const [f, raw, source] of assignments) {
      if (f.unknown) {
        errors.push({ field: f, error: f.noFileField ? t(session.lang, 'noFileField') : t(session.lang, 'unknownField', { id: f.id, title: action.title }) });
        continue;
      }
      if (f.type === 'file' && raw?.missing) { errors.push({ field: f, error: t(session.lang, 'uploadMissing') }); continue; }
      const r = validateField(this.validators, f, raw, session.lang);
      if (r.ok) {
        const prev = session.values[f.id];
        const changed = prev !== undefined && JSON.stringify(prev) !== JSON.stringify(r.value);
        session.values[f.id] = r.value;
        session.provenance[f.id] = source;
        delete session.invalid[f.id];
        set.push({ field: f, value: r.value, changed, prev });
        if (f.type === 'producerNumber') session.profile.producerNumber = r.value;
      } else {
        session.invalid[f.id] = { raw: typeof raw === 'object' ? raw?.name : raw, error: r.error };
        if (r.partial?.length) session.values[f.id] = r.partial;
        errors.push({ field: f, error: r.error });
      }
    }
    // Conditional fields that no longer apply are dropped
    for (const f of action.fields) {
      if (f.requiredWhen && !isRequired(f, session.values) && session.provenance[f.id] !== 'broker') delete session.values[f.id];
    }
    if (set.length || errors.length) session.draftId = session.draftId || requestId();
    return { set, errors };
  }

  // ---------- replies ----------

  reportResult({ set, errors }, out, L = 'en') {
    const fresh = set.filter(s => !s.changed);
    const changed = set.filter(s => s.changed);
    const n = out.turn();
    if (fresh.length) {
      const openers = t(L, 'openers');
      out.lead(`${openers[(n + fresh.length) % openers.length]} ${joinList(fresh.map(s => this.spoken(s.field, s.value)), L)}.`, true);
    }
    if (changed.length) {
      out.lead(t(L, 'updated', { list: joinList(changed.map(c => t(L, 'was', { v: this.spoken(c.field, c.value), prev: this.display(c.field, c.prev) })), L) }), true);
    }
    for (const e of errors) { out.say(e.error, 'error'); out.erred(e.field.id); }
  }

  // Asks for the next missing field. Wording varies with what just happened,
  // so the broker never sees the same template twice in a row.
  reportProgress(session, action, out, { summaryOnly = false } = {}) {
    const L = session.lang;
    const missing = this.missingOrAll(session, action, false);
    session.asked = session.asked || {};
    const lead = out.takeLead();
    if (missing.length) {
      session.status = STATUS.COLLECTING;
      const next = missing.find(f => session.invalid[f.id]) || missing[0];
      session.pendingFieldId = next.id;
      out.expect(next);
      if (next.type === 'enum') out.quick(next.options.map(o => ({ label: o.label, text: o.label })));

      if (summaryOnly) {
        const have = activeFields(action, session.values).filter(f => session.values[f.id] !== undefined && !session.invalid[f.id]);
        out.say(`${have.length ? t(L, 'soFar', { have: joinList(have.map(f => this.spoken(f, session.values[f.id])), L) }) : ''}${t(L, 'stillNeed', { missing: joinList(missing.map(f => f.label.toLowerCase()), L) })}`);
        return;
      }
      // The error message already asks the question: don't repeat it.
      if (out.hasError(next.id)) { if (lead.text) out.say(lead.text); return; }

      const count = session.asked[next.id] || 0;
      session.asked[next.id] = count + 1;
      let q;
      if (session.invalid[next.id]?.source === 'backend') q = t(L, 'differentValue', { label: next.label });
      else if (count > 0 && !out.isExplained() && (out.isNoProgress() || !lead.ack) && next.reask) q = next.reask;
      else { const variants = next.ask?.length ? next.ask : [next.prompt]; q = variants[(count + session.turns) % variants.length]; }

      if (lead.ack && missing.length === 1 && count === 0) q = t(L, 'oneMore', { q: lcFirst(q) });
      else if (lead.ack && missing.length === 2 && count === 0 && session.turns % 2 === 0) q = t(L, 'twoMore', { q });
      out.say([lead.text, q].filter(Boolean).join(' '), 'question');
      return;
    }
    session.status = STATUS.CONFIRMING;
    session.pendingFieldId = null;
    const closers = t(L, 'closers');
    out.say([lead.text, closers[session.turns % closers.length]].filter(Boolean).join(' '), 'question');
    out.summary(activeFields(action, session.values).filter(f => session.values[f.id] !== undefined)
      .map(f => ({ label: f.label, value: this.display(f, session.values[f.id]), reused: session.provenance[f.id] === 'reused_from_profile' })));
    out.quick([{ label: t(L, 'chipConfirm'), text: 'confirm', primary: true }, { label: t(L, 'chipEdit'), text: 'edit' }, { label: t(L, 'chipCancel'), text: 'cancel this request' }]);
  }

  // ---------- step 3: submission ----------

  async submit(session, action, out) {
    const L = session.lang;
    session.status = STATUS.SUBMITTING;
    const payload = this.buildPayload(session, action, 'submitted');
    let result;
    try {
      result = await this.submitter.submit(action, payload);
    } catch (err) {
      result = { ok: false, message: t(L, 'unreachable', { error: err.message }) };
    }
    if (!result.ok) {
      if (result.fieldErrors && Object.keys(result.fieldErrors).length) {
        for (const [fid, msg] of Object.entries(result.fieldErrors)) {
          const f = action.fields.find(x => x.id === fid);
          if (!f) continue;
          session.invalid[fid] = { raw: this.display(f, session.values[fid]), error: msg, source: 'backend' };
          delete session.values[fid];
        }
        out.say(t(L, 'backendRejected', { message: result.message || t(L, 'someRejected') }), 'error');
        this.reportProgress(session, action, out);
        return out.done();
      }
      session.status = STATUS.CONFIRMING;
      const msg = result.code === 'http_error' ? t(L, 'httpError', { status: result.status })
        : result.code === 'unexpected' ? t(L, 'unexpected') : (result.message || t(L, 'submitFailed'));
      out.say(msg, 'error');
      out.quick([{ label: t(L, 'chipRetry'), text: 'confirm', primary: true }, { label: t(L, 'chipCancel'), text: 'cancel this request' }]);
      return out.done();
    }

    payload.status = result.outcome; // stp_completed | routed_to_handler
    payload.submission = { ...payload.submission, ...result.details };
    payload.timeline.push({ status: result.outcome, at: new Date().toISOString() });
    this.requests.save({ ...payload, _sessionId: session.id });
    session.submitted.push(payload.requestId);

    if (result.outcome === 'stp_completed') {
      const task = result.details.task;
      out.say(t(L, 'stpDone', { id: payload.requestId, system: task.system, task: task.id, status: t(L, 'taskStatus')[task.status] || task.status }), 'success');
    } else {
      out.say(t(L, 'routed', { id: payload.requestId, to: result.details.mail.to, ref: result.details.mail.reference }), 'success');
    }
    out.say(t(L, 'anythingElse'));
    out.request(payload);
    this.clearRequest(session);
    session.status = STATUS.SUBMITTED;
    return out.done(payload);
  }

  buildPayload(session, action, status) {
    const fields = {};
    for (const f of activeFields(action, session.values)) if (session.values[f.id] !== undefined) fields[f.id] = session.values[f.id];
    const required = action.fields.filter(f => isRequired(f, session.values));
    const missing = required.filter(f => session.values[f.id] === undefined).map(f => f.id);
    const now = new Date().toISOString();
    const base = this.catalogue.get(action.id); // English metadata for the back end, whatever the conversation language
    return {
      requestId: session.draftId || requestId(),
      schemaVersion: 'axa-be/broker-request/1.0',
      action: { id: base.id, version: base.version, title: base.title, portalRoute: base.portalRoute, lineOfBusiness: base.lineOfBusiness, mock: !!base.mock },
      channel: session.mode === 'agent' ? 'agent-to-agent' : 'broker-chat',
      language: session.lang,
      broker: { producerNumber: session.values.producerNumber || session.profile.producerNumber || null },
      fields,
      provenance: Object.fromEntries(Object.keys(fields).map(k => [k, session.provenance[k] || 'broker'])),
      completeness: { required: required.length, provided: required.length - missing.length, missing, invalid: Object.keys(session.invalid) },
      status,
      submission: { mode: action.submission.mode, endpoint: action.submission.endpoint },
      createdAt: session.createdAt,
      ...(status === 'submitted' ? { submittedAt: now } : {}),
      timeline: [{ status, at: now }]
    };
  }

  // ---------- helpers ----------

  clearRequest(session) {
    Object.assign(session, { status: STATUS.IDLE, actionId: null, values: {}, provenance: {}, invalid: {}, pendingFieldId: null, clarify: null, buffer: null, draftId: null });
  }

  missingOrAll(session, action, all) {
    const fields = action.fields.filter(f => isRequired(f, session.values));
    return all ? activeFields(action, session.values) : fields.filter(f => session.values[f.id] === undefined || session.invalid[f.id]);
  }


  spoken(field, value) {
    const v = this.display(field, value);
    const tpl = Array.isArray(value) && value.length > 1 && field.spokenPlural ? field.spokenPlural : field.spoken;
    return tpl ? tpl.replace('{v}', v) : `${field.label} ${v}`;
  }

  actionQuickReplies() {
    return this.catalogue.actions.map(a => ({ label: a.title, action: a.id }));
  }

  display(field, value) {
    if (value === undefined || value === null) return '–';
    if (field.type === 'file') return value.name;
    if (field.type === 'enum') return field.options.find(o => o.value === value)?.label || value;
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }

  describeEntities(e, L = 'en') {
    const parts = [];
    if (e.contractNumber.length) parts.push(t(L, 'entContract', { v: e.contractNumber.join(', ') }));
    if (e.producerNumber.length) parts.push(t(L, 'entProducer', { v: e.producerNumber[0] }));
    if (e.date.length) parts.push(t(L, 'entDate', { v: e.date[0] }));
    if (e.iban.length) parts.push(t(L, 'entIban', { v: e.iban[0] }));
    return parts.join(', ');
  }

  // Publicly visible state: used by the widget's progress panel and by agents.
  state(session) {
    const action = session.actionId ? this.act(session) : null;
    if (!action) return { sessionId: session.id, status: session.status, language: session.lang, action: null, fields: [], progress: null };
    const fields = action.fields.filter(f => isRequired(f, session.values) || session.values[f.id] !== undefined).map(f => {
      const inv = session.invalid[f.id];
      const has = session.values[f.id] !== undefined;
      return {
        id: f.id, label: f.label, type: f.type, required: isRequired(f, session.values), conditional: !!f.requiredWhen,
        status: inv ? 'invalid' : has ? 'ok' : 'missing',
        value: has ? session.values[f.id] : null,
        display: has ? this.display(f, session.values[f.id]) : null,
        error: inv?.error || null,
        source: session.provenance[f.id] || null,
        prompt: f.prompt, help: f.help || null, accept: f.accept || null
      };
    });
    const req = fields.filter(f => f.required);
    return {
      sessionId: session.id,
      status: session.status,
      language: session.lang,
      action: { id: action.id, title: action.title, segment: action.segment, lineOfBusiness: action.lineOfBusiness, mock: !!action.mock, mode: action.submission.mode },
      fields,
      pendingFieldId: session.pendingFieldId,
      progress: { required: req.length, completed: req.filter(f => f.status === 'ok').length }
    };
  }

  out(session) {
    const engine = this;
    const replies = []; let quickReplies = []; let expect = null; let summary = null; let request = null;
    let lead = []; let leadAck = false; let noProgress = false; let explained = false; const tail = []; const erred = new Set();
    return {
      tail(text, kind) { tail.push({ text, kind }); },
      lead(text, isAck = false) { if (text) { lead.push(text); if (isAck) leadAck = true; } },
      takeLead() { const r = { text: lead.join(' '), ack: leadAck }; lead = []; leadAck = false; return r; },
      erred(id) { erred.add(id); },
      hasError(id) { return erred.has(id); },
      noProgress() { noProgress = true; },
      explained() { explained = true; },
      isExplained() { return explained; },
      isNoProgress() { return noProgress; },
      turn() { return session.turns || 0; },
      say(text, kind = 'text') { if (text) replies.push({ text, kind }); },
      quick(q) { quickReplies = q; },
      expect(field) { expect = { fieldId: field.id, type: field.type, accept: field.accept || null, maxSizeMb: field.maxSizeMb || null }; },
      summary(rows) { summary = rows; replies.push({ kind: 'summary', rows }); },
      request(payload) { request = payload; },
      done(final) {
        if (lead.length) { replies.push({ text: lead.join(' '), kind: 'text' }); lead = []; }
        const cardAt = replies.findIndex(r => r.kind === 'summary' && r.rows);
        replies.splice(cardAt >= 0 ? cardAt : replies.length, 0, ...tail.splice(0));
        for (const r of replies) session.transcript.push({ role: 'assistant', ...r, at: new Date().toISOString() });
        const action = session.actionId ? engine.act(session) : null;
        return {
          sessionId: session.id,
          status: session.status,
          language: session.lang,
          replies,
          quickReplies,
          expect,
          state: engine.state(session),
          request: final || request || (action ? engine.buildPayload(session, action, session.status === STATUS.CONFIRMING ? 'ready' : 'draft') : null)
        };
      }
    };
  }
}

function lcFirst(t) { return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t; }

module.exports = { DialogueEngine, STATUS };
