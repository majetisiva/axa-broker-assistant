'use strict';
// Rule-based language understanding. It works offline and is deterministic, so the
// demo never depends on a model. An optional LLM (llm.js) can sit on top of it.
// Understands English, French and Dutch; detectLanguage() picks the conversation language.
const { parseDate } = require('./validators');

function norm(text) {
  return String(text || '').toLowerCase().normalize('NFC').replace(/[’`]/g, "'");
}

function hasTerm(t, term) {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}])${escaped}`, 'u').test(t);
}

const META = {
  reset: /\b(start over|restart|reset|new request|recommencer|nouvelle demande|opnieuw( beginnen)?|nieuwe aanvraag)\b/,
  abort: /^(cancel( this| the| my)? (request|chat|conversation)|abort|never ?mind|stop( this)?( request| chat)?|annuler (la|cette|ma) demande|laisse[zr]? tomber|annuleer (de|deze|mijn) aanvraag|laat (maar|maar zitten)|stop (de|deze) aanvraag)[!. ]*$/,
  confirm: /^(yes|y|yep|yeah|ok|okay|confirm|submit|send( it)?|correct|that's (right|correct)|looks good|go ahead|confirm (&|and) submit|oui|confirmer|je confirme|d'accord|c'est (bon|correct|juste)|envoye[rz]|confirmer et envoyer|ja|akkoord|klopt|bevestig(en)?|verstuur|indienen|prima|in orde|bevestigen en indienen)\b/,
  deny: /^(no|nope|not (yet|correct)|edit|change something|wrong|non|pas correct|incorrect|modifier|modifier quelque chose|nee|niet correct|fout|wijzigen|aanpassen|iets wijzigen)\b/,
  help: /\b(help|what can you do|which (actions|requests)|what requests|options|menu|aide|que pouvez-vous faire|hulp|wat kunt u( doen)?|wat kan je( doen)?)\b/,
  status: /\b(status|what('s| is) missing|progress|where are we|what do you (still )?need|qu'est-ce qui manque|que manque-t-il|où en est-on|où en sommes-nous|wat ontbreekt( er)?|waar staan we|hoe ver staan we)/,
  greeting: /^(hi|hello|hey|good (morning|afternoon|evening)|bonjour|bonsoir|salut|hallo|hoi|goedemorgen|goeiemorgen|goedemiddag|goedenavond|dag)\b[!. ]*$/
};

const INJECTION = new RegExp([
  // English
  'ignore (all |the |your )?(previous|prior|above) (instructions|rules)', 'disregard (the|your) (rules|instructions)', 'you are now', 'system prompt',
  'act as (an? )?(admin|administrator)', 'skip (the )?validation', 'bypass', 'approve (it|this) (anyway|automatically)', 'override (the )?(rules|validation)',
  // French
  'ignore[rz]? (toutes |les |vos |tes )*(règles|instructions|consignes)', 'oublie[rz]? (toutes |les |vos |tes )*(règles|instructions|consignes)',
  'approuve[rz]?(-la|-le)? (la demande )?(quand même|automatiquement)', 'contourne[rz]?', 'sans (validation|vérification|contrôle)',
  '(tu es|vous êtes) maintenant', 'prompt système',
  // Dutch
  'negeer (alle |de |je |uw )*(vorige )?(regels|instructies)', 'vergeet (alle |de |je |uw )*(regels|instructies)',
  'keur (het |dit |de aanvraag )?(toch|automatisch) goed', 'omzeil', 'zonder (validatie|controle)', '(je bent|u bent) nu', 'systeemprompt'
].join('|'));

function detectMeta(text) {
  const t = norm(text).trim();
  for (const [k, re] of Object.entries(META)) if (re.test(t)) return k;
  return null;
}

function detectInjection(text) {
  return INJECTION.test(norm(text));
}

// ---------- language ----------

// Words that are frequent and specific to one language. Words shared by two of them
// (de, en, is, in, client, contract, date, suspension, police…) are deliberately left out.
const LANG_WORDS = {
  en: 'the a an of for and i i\'m want would like please hello hi hey thanks thank my his her their to from with on suspend change address cancel yes no policy customer can could need this that what which next tomorrow today good morning moved plate handed over take monday tuesday wednesday thursday friday saturday sunday week',
  fr: 'le la les du des une un pour et je voudrais veux souhaite souhaiterais contrat cliente bonjour bonsoir salut merci au aux avec sur mon ma mes son sa ses il elle nous vous suspendre adresse changement demande svp oui non résilier résiliation annuler déménagé plaque courtier pouvez peux faire numéro compte partir depuis ce cette qui que quel quelle est sont mettre lundi mardi mercredi jeudi vendredi samedi dimanche prochain prochaine semaine',
  nl: 'het een van voor ik wil graag polis klant goedemorgen goeiemorgen goedemiddag goedenavond hallo hoi dag dank bedankt met op mijn zijn haar verhuisd schorsing schorsen nummerplaat makelaar aanvraag wijziging ja nee alstublieft aub vanaf vandaag morgen opzeggen kunt kan moet wat welk welke rekening adres niet ook naar bij uit maandag dinsdag woensdag donderdag vrijdag zaterdag zondag volgende komende week'
};
const LANG_SETS = Object.fromEntries(Object.entries(LANG_WORDS).map(([l, w]) => [l, new Set(w.split(' '))]));

// Returns 'en' | 'fr' | 'nl', or null when the text gives no clear signal (numbers, "ok", an IBAN…).
function detectLanguage(text) {
  const t = norm(text);
  const words = t.match(/[\p{L}']+/gu) || [];
  const score = { en: 0, fr: 0, nl: 0 };
  for (const w of words) for (const l of Object.keys(score)) if (LANG_SETS[l].has(w)) score[l] += 1;
  // French elision (d'adresse, l'IBAN, j'ai, qu'il) and accented letters
  score.fr += Math.min(2, (t.match(/(?:^|[^\p{L}])(?:d|l|j|qu|n|s|c|m)'\p{L}/gu) || []).length);
  score.fr += Math.min(2, (t.match(/[éèêàçùûôîâ]/g) || []).length);
  // Dutch "ij" words (wijziging, mijn, rij…)
  score.nl += Math.min(2, words.filter(w => /ij/.test(w)).length);
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] < 1 || ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

// ---------- intent ----------

// Scores every action by the keywords it matches. Ambiguous terms (e.g. "cancel")
// only count when nothing more specific is present.
// Returns { type: 'action' | 'ambiguous' | 'unsupported' | 'none', … }. For 'ambiguous',
// `term` is the catalogue entry (its question may be translated); null means "several actions scored alike".
function detectIntent(text, catalogue, restrictTo) {
  const t = norm(text);
  const ambiguousTerms = new Set(catalogue.ambiguousTerms.flatMap(a => a.terms));
  const scores = [];
  for (const a of catalogue.actions) {
    if (restrictTo && !restrictTo.includes(a.id)) continue;
    let score = 0;
    for (const k of a.intent.keywords) {
      if (ambiguousTerms.has(k)) continue;
      if (hasTerm(t, k)) score += k.length;
    }
    const titles = [a.title, ...Object.values(a.i18n || {}).map(x => x.title).filter(Boolean)];
    if (titles.some(title => hasTerm(t, title))) score += 50;
    if (score) scores.push({ actionId: a.id, score });
  }
  scores.sort((x, y) => y.score - x.score);
  if (scores.length) {
    const [top, second] = scores;
    if (second && second.score >= top.score * 0.8) {
      return { type: 'ambiguous', candidates: scores.slice(0, 3).map(s => s.actionId), term: null };
    }
    return { type: 'action', actionId: top.actionId, confidence: Math.min(1, top.score / 20) };
  }
  for (const amb of catalogue.ambiguousTerms) {
    if (amb.terms.some(term => hasTerm(t, term))) {
      const candidates = restrictTo ? amb.candidates.filter(c => restrictTo.includes(c)) : amb.candidates;
      if (candidates.length === 1) return { type: 'action', actionId: candidates[0], confidence: 0.6 };
      if (candidates.length) return { type: 'ambiguous', candidates, term: amb };
    }
  }
  if (!restrictTo) {
    for (const u of catalogue.unsupported) {
      if (u.terms.some(term => hasTerm(t, term))) return { type: 'unsupported', entry: u };
    }
  }
  return { type: 'none' };
}

// ---------- entities ----------

const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag';

// Pulls typed values out of free text. Returns { contractNumber: [...], producerNumber: [...], iban: [...], date: [...] }
function extractEntities(text) {
  let t = String(text || '');
  const out = { contractNumber: [], producerNumber: [], iban: [], date: [] };

  const ibanRe = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi;
  for (const m of t.match(ibanRe) || []) {
    if (/^[A-Z]{2}\d{2}/i.test(m) && /[A-Z]{2}/i.test(m.slice(0, 2))) { out.iban.push(m.toUpperCase()); t = t.replace(m, ' '); }
  }

  const dateRes = [
    /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}(?:st|nd|rd|th|er)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|januari|februari|maart|mei|juni|juli|augustus|oktober)[a-zéû]*\.?(?:\s+\d{4})?(?![\p{L}])/giu,
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi,
    /(?:^|(?<=[^\p{L}]))(?:day after tomorrow|après-demain|overmorgen|today|tomorrow|yesterday|aujourd'hui|demain|hier|vandaag|morgen|gisteren)(?![\p{L}])/giu,
    new RegExp(`\\b(?:next|coming|volgende|komende)\\s+(?:${WEEKDAYS}|week|semaine)\\b`, 'gi'),
    new RegExp(`\\b(?:${WEEKDAYS.split('|').slice(7, 14).join('|')})\\s+prochain\\b`, 'gi'),
    /\b(?:la\s+)?semaine prochaine\b/gi,
    /\b(?:first|1st) of next month\b/gi,
    /\b(?:le\s+)?(?:premier|1er) (?:du|de) mois prochain\b/gi,
    /\b(?:de\s+)?eerste van (?:de\s+)?volgende maand\b/gi
  ];
  for (const re of dateRes) {
    for (const m of t.match(re) || []) {
      const d = parseDate(m);
      if (d) { out.date.push(d); t = t.replace(m, ' '); }
    }
  }

  // Producer numbers: explicitly labelled first, then bare 6-8 digit numbers.
  const labelled = /(?:producer|producteur|producent|producentennummer|prod\.?)\s*(?:no\.?|number|n°|nr\.?|#|numéro)?\s*(?:is|est|:|=)?\s*(\d[\d.]{4,10}\d)/gi;
  for (const m of [...t.matchAll(labelled)]) {
    out.producerNumber.push(m[1].replace(/\./g, ''));
    t = t.replace(m[0], ' ');
  }
  for (const num of t.match(/\b\d[\d.]{4,12}\d\b/g) || []) {
    const digits = num.replace(/\./g, '');
    if (digits.length === 9) out.contractNumber.push(digits);
    else if (digits.length >= 6 && digits.length <= 8) out.producerNumber.push(digits);
  }
  return out;
}

// Which field does the broker refer to by name? e.g. "the date is wrong, use 20/11/2026"
// `action` may be a translated copy, so its labels are in the conversation language.
function referencedField(text, action) {
  const t = norm(text);
  const aliases = {
    contractNumber: ['contract', 'policy', 'polis', 'contrat', 'contractnummer', 'polisnummer'],
    producerNumber: ['producer', 'producteur', 'producent', 'producentennummer'],
    date: ['date', 'datum', 'from', 'effective', 'ingangsdatum', 'schorsingsdatum', 'vanaf'],
    iban: ['iban', 'bank', 'account', 'rekening', 'rekeningnummer', 'compte', 'bancaire'],
    file: ['document', 'file', 'attachment', 'notice', 'pdf', 'pièce', 'attestation', 'avis', 'lettre', 'fichier', 'bijlage', 'attest', 'bewijs', 'brief', 'bestand'],
    text: ['description', 'details', 'omschrijving', 'beschrijving'],
    enum: ['type', 'category', 'catégorie', 'soort', 'split', 'frequency', 'fractionnement', 'fractionment', 'splitsing', 'frequentie', 'holder', 'titulaire', 'rekeninghouder']
  };
  for (const f of action.fields) {
    if (hasTerm(t, f.label.toLowerCase())) return f;
  }
  for (const f of action.fields) {
    if ((aliases[f.type] || []).some(a => hasTerm(t, a))) return f;
  }
  return null;
}

// "change the date", "modifier l'IBAN", "datum wijzigen"
function wantsChange(text) {
  return /\b(change|edit|update|correct|modify|wrong|modifier|changer|corriger|wijzig|wijzigen|aanpassen|verander|veranderen|fout|incorrect)\b/i.test(norm(text));
}

// "skip", "no IBAN", "passer", "overslaan": leave an optional field empty
function wantsSkip(text) {
  return /^(skip|pass|none|no|nope|not needed|no need|n\/a|leave (it )?(empty|blank)|passer|aucun|non|pas de|pas besoin|laisser vide|overslaan|geen|nee|niet nodig|leeg laten)\b/.test(norm(text).trim());
}

function wantsAppend(text) {
  return /\b(also|add|as well|another|plus|aussi|également|ajoute[rz]?|ook|toevoegen|eveneens)\b/.test(norm(text));
}

module.exports = { detectIntent, detectMeta, detectInjection, detectLanguage, extractEntities, referencedField, wantsChange, wantsAppend, wantsSkip, norm, hasTerm };
