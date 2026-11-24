'use strict';
// Loads the action catalogue. Adding a new portal webform = dropping a new JSON file
// into catalogue/actions. No code change is needed for ordinary forms.
const fs = require('fs');
const path = require('path');

const KNOWN_TYPES = ['contractNumber', 'producerNumber', 'date', 'iban', 'text', 'enum', 'file'];
const LANGS = ['fr', 'nl'];  // English is the base language of every file
const FIELD_TEXT = ['label', 'prompt', 'help', 'ask', 'reask', 'spoken', 'spokenPlural'];

function lintAction(a, file) {
  const problems = [];
  if (!a.id || !/^[a-z0-9_]+$/.test(a.id)) problems.push('id must be snake_case');
  if (!a.title) problems.push('title missing');
  if (!Array.isArray(a.fields) || !a.fields.length) problems.push('fields missing');
  const ids = new Set();
  for (const f of a.fields || []) {
    if (ids.has(f.id)) problems.push(`duplicate field ${f.id}`);
    ids.add(f.id);
    if (!KNOWN_TYPES.includes(f.type)) problems.push(`field ${f.id}: unknown type ${f.type}`);
    if (!f.prompt) problems.push(`field ${f.id}: prompt missing`);
    if (f.type === 'enum' && !(f.options || []).length) problems.push(`field ${f.id}: enum without options`);
    for (const c of f.checks || []) {
      if (!c.pattern && !c.notPattern) problems.push(`field ${f.id}: check needs pattern or notPattern`);
      try { new RegExp(c.pattern || c.notPattern); } catch { problems.push(`field ${f.id}: invalid check pattern`); }
      if (!c.message) problems.push(`field ${f.id}: check without message`);
    }
    if (f.maxDate && f.maxDate !== 'today') problems.push(`field ${f.id}: maxDate must be "today"`);
    if (f.askIfMissing && f.required) problems.push(`field ${f.id}: askIfMissing is for optional fields`);
    if (f.countries && f.type !== 'iban') problems.push(`field ${f.id}: countries only applies to iban fields`);
  }
  for (const f of a.fields || []) {
    if (f.requiredWhen && !ids.has(f.requiredWhen.field)) problems.push(`field ${f.id}: requiredWhen refers to unknown field ${f.requiredWhen.field}`);
  }
  if (!a.submission || !['stp', 'mail'].includes(a.submission.mode)) problems.push('submission.mode must be stp or mail');
  for (const k of a.session || []) if (!['cifNumber', 'difNumber'].includes(k)) problems.push(`session: unknown identifier ${k}`);
  for (const [lang, tr] of Object.entries(a.i18n || {})) {
    if (!LANGS.includes(lang)) problems.push(`i18n: unknown language ${lang}`);
    for (const [fid, ft] of Object.entries(tr.fields || {})) {
      const f = (a.fields || []).find(x => x.id === fid);
      if (!f) { problems.push(`i18n.${lang}: unknown field ${fid}`); continue; }
      for (const v of Object.keys(ft.options || {})) {
        if (!(f.options || []).some(o => o.value === v)) problems.push(`i18n.${lang}.${fid}: unknown option ${v}`);
      }
    }
  }
  if (problems.length) throw new Error(`Invalid action definition ${file}: ${problems.join('; ')}`);
}

function loadCatalogue(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'catalogue.json'), 'utf8'));
  const actionsDir = path.join(dir, 'actions');
  const actions = fs.readdirSync(actionsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const a = JSON.parse(fs.readFileSync(path.join(actionsDir, f), 'utf8'));
      lintAction(a, f);
      return a;
    })
    .sort((x, y) => (x.order ?? 99) - (y.order ?? 99));
  const byId = Object.fromEntries(actions.map(a => [a.id, a]));
  const cache = new Map();
  return {
    ...meta, actions, byId,
    get: id => byId[id],
    // Same action with titles, questions and labels in `lang`. Ids, types, rules and keywords are unchanged.
    localized(id, lang) {
      const a = byId[id];
      if (!a || !lang || lang === 'en' || !a.i18n?.[lang]) return a;
      const key = `${id}:${lang}`;
      if (!cache.has(key)) cache.set(key, localizeAction(a, a.i18n[lang]));
      return cache.get(key);
    },
    // Translated text of a catalogue entry (ambiguous term question, unsupported message, …)
    text(entry, key, lang) {
      return entry?.i18n?.[lang]?.[key] ?? entry?.[key];
    }
  };
}

function localizeAction(a, tr) {
  const out = { ...a };
  for (const k of ['title', 'summary', 'intro', 'rules']) if (tr[k] !== undefined) out[k] = tr[k];
  out.fields = a.fields.map(f => {
    const ft = tr.fields?.[f.id];
    if (!ft) return f;
    const nf = { ...f };
    for (const k of FIELD_TEXT) if (ft[k] !== undefined) nf[k] = ft[k];
    if (f.options && ft.options) nf.options = f.options.map(o => ({ ...o, label: ft.options[o.value] ?? o.label }));
    return nf;
  });
  return out;
}

// Is this field required given the values collected so far? (conditional fields)
function isRequired(field, values) {
  if (field.required) return true;
  const rule = field.requiredWhen;
  if (!rule) return false;
  const v = values[rule.field];
  if (rule.in) return rule.in.includes(v);
  if ('equals' in rule) return v === rule.equals;
  return false;
}

// Fields shown to the broker: required ones plus optional ones already filled.
function activeFields(action, values) {
  return action.fields.filter(f => isRequired(f, values) || values[f.id] !== undefined || (!f.requiredWhen && !f.required));
}

// JSON Schema (draft 2020-12) for the request payload of one action.
function toJsonSchema(action) {
  const props = {};
  const fieldTypes = {
    contractNumber: { type: 'string', pattern: '^\\d{9}$' },
    producerNumber: { type: 'string', pattern: '^\\d{6,8}$' },
    date: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$' },
    iban: { type: 'string', pattern: '^[A-Z]{2}\\d{2}[A-Z0-9 ]+$' },
    text: { type: 'string' },
    file: {
      type: 'object', required: ['fileId', 'name'],
      properties: { fileId: { type: 'string' }, name: { type: 'string' }, size: { type: 'integer' }, mime: { type: 'string' } }
    }
  };
  for (const f of action.fields) {
    let s = f.type === 'enum' ? { type: 'string', enum: f.options.map(o => o.value) } : { ...fieldTypes[f.type] };
    if (f.multiple) s = { type: 'array', minItems: 1, items: s };
    props[f.id] = { title: f.label, ...s };
  }
  const required = action.fields.filter(f => f.required).map(f => f.id);
  const allOf = action.fields.filter(f => f.requiredWhen).map(f => ({
    if: { properties: { [f.requiredWhen.field]: f.requiredWhen.in ? { enum: f.requiredWhen.in } : { const: f.requiredWhen.equals } }, required: [f.requiredWhen.field] },
    then: { required: [f.id] }
  }));
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:axa-be:broker-request:${action.id}:${action.version}`,
    title: action.title,
    type: 'object',
    required: ['requestId', 'action', 'fields'],
    properties: {
      requestId: { type: 'string' },
      action: {
        type: 'object', required: ['id', 'version'],
        properties: { id: { const: action.id }, version: { type: 'string' } }
      },
      fields: { type: 'object', required, properties: props, additionalProperties: false, ...(allOf.length ? { allOf } : {}) }
    }
  };
}

module.exports = { loadCatalogue, isRequired, activeFields, toJsonSchema };
