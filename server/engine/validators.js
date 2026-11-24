'use strict';
// Field-type validators and normalisers.
// The chatbot validates only to guide the dialogue (format, completeness).
// Business validation stays on the existing Java back end, as required.

const { t: tr, joinList } = require('./i18n');

const FORBIDDEN_FILENAME = /[<>:"\/\\|?*]/;

function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const MONTHS = {
  jan: 0, january: 0, janvier: 0, januari: 0,
  feb: 1, february: 1, fevrier: 1, février: 1, februari: 1,
  mar: 2, march: 2, mars: 2, maart: 2,
  apr: 3, april: 3, avril: 3,
  may: 4, mai: 4, mei: 4,
  jun: 5, june: 5, juin: 5, juni: 5,
  jul: 6, july: 6, juillet: 6, juli: 6,
  aug: 7, august: 7, aout: 7, août: 7, augustus: 7,
  sep: 8, sept: 8, september: 8, septembre: 8,
  oct: 9, october: 9, octobre: 9, oktober: 9,
  nov: 10, november: 10, novembre: 10,
  dec: 11, december: 11, decembre: 11, décembre: 11
};

function buildDate(y, m, d) {
  const date = new Date(y, m, d);
  if (date.getFullYear() !== y || date.getMonth() !== m || date.getDate() !== d) return null;
  return date;
}

// Parses a date written in many ways; returns DD/MM/YYYY or null.
function parseDate(text, now = new Date()) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();
  const plusDays = (n) => formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
  if (/(day after tomorrow|après-demain|overmorgen)/.test(t)) return plusDays(2);
  if (/\b(today|aujourd'hui|vandaag)\b/.test(t)) return formatDate(now);
  if (/\b(tomorrow|demain|morgen)\b/.test(t)) return formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  if (/\b(yesterday|hier|gisteren)\b/.test(t)) return formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
    lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, dimanche: 0,
    maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 0 };
  const wd = t.match(/\b(next|coming|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b/);
  if (wd) {
    let diff = (WEEKDAYS[wd[2]] - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff));
  }
  if (/\b(next week|coming week|semaine prochaine|volgende week|komende week)\b/.test(t)) return plusDays(7);
  if (/\b((first|1st) of next month|(premier|1er) (du|de) mois prochain|eerste van (de )?volgende maand)\b/.test(t)) return formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  let m = t.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/);
  if (m) {
    let y = parseInt(m[3], 10); if (y < 100) y += 2000;
    const d = buildDate(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    return d ? formatDate(d) : null;
  }
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const d = buildDate(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return d ? formatDate(d) : null;
  }
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th|er)?\s+(?:of\s+)?([a-zéû]+)\.?(?:\s+(\d{4}))?\b/);
  if (m && MONTHS[m[2]] !== undefined) {
    const y = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    const d = buildDate(y, MONTHS[m[2]], parseInt(m[1], 10));
    return d ? formatDate(d) : null;
  }
  m = t.match(/\b([a-zéû]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (m && MONTHS[m[1]] !== undefined) {
    const y = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    const d = buildDate(y, MONTHS[m[1]], parseInt(m[2], 10));
    return d ? formatDate(d) : null;
  }
  return null;
}

function ibanChecksumOk(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const IBAN_LENGTHS = { BE: 16, NL: 18, LU: 20, FR: 27, DE: 22 };

// Format description in the conversation language, e.g. "9 digits" / "9 chiffres" / "9 cijfers".
function describe(fmt, fallback, lang) {
  return fmt?.i18n?.[lang] || fmt?.description || fallback;
}

// Every validator takes (value, field, lang) and returns { ok, value } or { ok: false, error }.
// Error messages are written to be shown as is and end with a question where possible.
function makeValidators(formats = {}) {
  const contractRe = new RegExp(formats.contractNumber?.pattern || '^\\d{9}$');
  const producerRe = new RegExp(formats.producerNumber?.pattern || '^\\d{6,8}$');
  const ibanCountries = formats.ibanCountries || Object.keys(IBAN_LENGTHS);

  return {
    contractNumber(value, field, lang = 'en') {
      const v = String(value).replace(/[\s.\-]/g, '');
      if (!contractRe.test(v)) {
        const desc = describe(formats.contractNumber, '9 digits', lang);
        return { ok: false, error: /^\d+$/.test(v)
          ? tr(lang, 'v.contractDigits', { value, digits: v.length, desc })
          : tr(lang, 'v.contractFormat', { value, desc }) };
      }
      return { ok: true, value: v };
    },
    producerNumber(value, field, lang = 'en') {
      const v = String(value).replace(/[\s.\-]/g, '');
      if (!producerRe.test(v)) return { ok: false, error: tr(lang, 'v.producer', { value, desc: describe(formats.producerNumber, '6 to 8 digits', lang) }) };
      return { ok: true, value: v };
    },
    date(value, field, lang = 'en') {
      const v = parseDate(value);
      if (!v) return { ok: false, error: tr(lang, 'v.date', { value }) };
      // "maxDate": "today" → today and earlier dates only (e.g. a suspension date)
      if (field?.maxDate === 'today') {
        const [d, m, y] = v.split('/').map(Number);
        const now = new Date();
        if (new Date(y, m - 1, d) > new Date(now.getFullYear(), now.getMonth(), now.getDate())) return { ok: false, error: tr(lang, 'v.dateFuture', { value: v }) };
      }
      return { ok: true, value: v };
    },
    iban(value, field, lang = 'en') {
      const v = String(value).replace(/\s+/g, '').toUpperCase();
      const country = v.slice(0, 2);
      const allowed = field?.countries || ibanCountries; // a form may accept Belgian accounts only
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(v)) return { ok: false, error: tr(lang, 'v.ibanFormat', { value }) };
      if (!allowed.includes(country)) return { ok: false, error: tr(lang, allowed.length === 1 ? 'v.ibanOnly' : 'v.ibanCountry', { country, only: allowed[0] }) };
      if (IBAN_LENGTHS[country] && v.length !== IBAN_LENGTHS[country]) return { ok: false, error: tr(lang, 'v.ibanLength', { country, expected: IBAN_LENGTHS[country], actual: v.length }) };
      if (!ibanChecksumOk(v)) return { ok: false, error: tr(lang, 'v.ibanChecksum') };
      return { ok: true, value: v.replace(/(.{4})/g, '$1 ').trim() };
    },
    text(value, field, lang = 'en') {
      const v = String(value).trim();
      if (field.minLength && v.length < field.minLength) return { ok: false, error: tr(lang, 'v.textShort', { min: field.minLength }) };
      return { ok: true, value: v.slice(0, field.maxLength || 2000) };
    },
    // `field` may be a translated copy: its option labels are then in the conversation language.
    // Keywords of every language stay on the options, so any language is understood.
    enum(value, field, lang = 'en') {
      const t = String(value).toLowerCase().trim();
      // Yes/no questions ("answerOnly") match whole words only, so "no" never matches "now" or "november".
      const hit = field.answerOnly ? (k) => new RegExp(`(^|[^\\p{L}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(t) : (k) => t.includes(k);
      const opt = field.options.find(o => o.value === t || o.label.toLowerCase() === t)
        || field.options.find(o => (o.keywords || []).some(hit));
      if (!opt) return { ok: false, error: tr(lang, field.answerOnly ? 'v.choice' : 'v.enum', { list: joinList(field.options.map(o => o.label.toLowerCase()), lang, 'or') }) };
      return { ok: true, value: opt.value };
    },
    // value is a file reference produced by the upload endpoint: { fileId, name, size, mime }
    file(value, field, lang = 'en') {
      if (!value || typeof value !== 'object' || !value.fileId) return { ok: false, error: tr(lang, 'v.fileNeeded') };
      const ext = (value.name.split('.').pop() || '').toLowerCase();
      if (field.accept && !field.accept.includes(ext)) return { ok: false, error: tr(lang, 'v.fileType', { ext, list: joinList(field.accept.map(a => a.toUpperCase()), lang, 'or') }) };
      if (field.maxSizeMb && value.size > field.maxSizeMb * 1024 * 1024) return { ok: false, error: tr(lang, 'v.fileSize', { max: field.maxSizeMb }) };
      if (field.minSizeKb && value.size < field.minSizeKb * 1024) return { ok: false, error: tr(lang, 'v.fileTooSmall', { min: field.minSizeKb }) };
      if (FORBIDDEN_FILENAME.test(value.name)) return { ok: false, error: tr(lang, 'v.fileName') };
      return { ok: true, value: { fileId: value.fileId, name: value.name, size: value.size, mime: value.mime } };
    }
  };
}

// Text in the conversation language: a plain string, or { en, fr, nl }.
function pick(text, lang) {
  return text && typeof text === 'object' ? (text[lang] ?? text.en) : text;
}

// Form-specific rules on top of the format, from the catalogue, e.g. a contract number
// that must start with 6, or must not start with 720:
//   "checks": [{ "pattern": "^6", "message": { "en": "…", "fr": "…", "nl": "…" } }, { "notPattern": "^720", … }]
function runChecks(field, value, lang) {
  for (const c of field.checks || []) {
    const s = String(value);
    const bad = (c.pattern && !new RegExp(c.pattern).test(s)) || (c.notPattern && new RegExp(c.notPattern).test(s));
    if (bad) return pick(c.message, lang).replace(/\{value\}/g, s);
  }
  return null;
}

// Validates a value (or list of values for multiple fields) against its field definition.
function validateField(validators, field, raw, lang = 'en') {
  const base = validators[field.type];
  if (!base) return { ok: false, error: `Unsupported field type ${field.type}` };
  const fn = (v, f, l) => {
    const r = base(v, f, l);
    if (!r.ok || !f.checks) return r;
    const err = runChecks(f, r.value, l);
    return err ? { ok: false, error: err } : r;
  };
  if (field.multiple) {
    const items = Array.isArray(raw) ? raw : String(raw).split(/[,;]|\band\b|\bet\b|\ben\b/).map(s => s.trim()).filter(Boolean);
    const out = []; const errors = [];
    for (const item of items) {
      const r = fn(item, field, lang);
      if (r.ok) { if (!out.includes(r.value)) out.push(r.value); } else errors.push(r.error);
    }
    if (errors.length) return { ok: false, error: errors.join(' '), partial: out };
    if (!out.length) return { ok: false, error: tr(lang, 'v.noValue') };
    return { ok: true, value: out };
  }
  return fn(raw, field, lang);
}

module.exports = { makeValidators, validateField, parseDate, formatDate, ibanChecksumOk, pick };
