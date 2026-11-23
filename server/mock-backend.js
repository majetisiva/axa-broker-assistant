'use strict';
// MOCK of the existing Java policy-servicing APIs, so the demo runs end to end.
// All contracts below are fictitious test data. Replace with the real API base URL.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTRACTS = {
  '622382121': { product: 'motor', status: 'active', producer: '1044400', holder: 'Test Client A' },
  '730123456': { product: 'home', status: 'active', producer: '1044400', holder: 'Test Client B' },
  '512345678': { product: 'motor', status: 'suspended', producer: '1055500', holder: 'Test Client C' },
  '498765432': { product: 'motor', status: 'active', producer: '1055500', holder: 'Test Client D' },
  '611122233': { product: 'life', status: 'active', producer: '1033300', holder: 'Test Client E' }
};

const ref = (p) => `${p}-${new Date().getFullYear()}-${crypto.randomInt(10000, 99999)}`;

// The real Java APIs would answer in the broker's language (payload.language / Accept-Language).
const MSG = {
  en: {
    notFound: (no) => `Contract ${no} was not found.`,
    inPortfolio: (no, p) => `Contract ${no} is already in the portfolio of producer ${p}.`,
    notMotor: (no, product) => `Contract ${no} is a ${product} contract; suspension after licence plate cancellation applies to motor contracts only.`,
    suspended: (no) => `Contract ${no} is already suspended.`,
    noFile: () => 'The attached document could not be found.',
    product: { motor: 'motor', home: 'home', life: 'life' }
  },
  fr: {
    notFound: (no) => `Le contrat ${no} est introuvable.`,
    inPortfolio: (no, p) => `Le contrat ${no} se trouve déjà dans le portefeuille du producteur ${p}.`,
    notMotor: (no, product) => `Le contrat ${no} est un contrat ${product} ; la suspension après radiation de la plaque ne concerne que les contrats auto.`,
    suspended: (no) => `Le contrat ${no} est déjà suspendu.`,
    noFile: () => 'Le document joint est introuvable.',
    product: { motor: 'auto', home: 'habitation', life: 'vie' }
  },
  nl: {
    notFound: (no) => `Contract ${no} werd niet gevonden.`,
    inPortfolio: (no, p) => `Contract ${no} zit al in de portefeuille van producent ${p}.`,
    notMotor: (no, product) => `Contract ${no} is een ${product}contract; schorsing na schrapping van de nummerplaat geldt alleen voor autocontracten.`,
    suspended: (no) => `Contract ${no} is al geschorst.`,
    noFile: () => 'Het toegevoegde document werd niet gevonden.',
    product: { motor: 'auto', home: 'woning', life: 'leven' }
  }
};
const msgs = (p) => MSG[p?.language] || MSG.en;

function createMockBackend({ outboxDir, uploads }) {
  fs.mkdirSync(outboxDir, { recursive: true });

  const checkContract = (no, errors, field = 'contractNumber', m = MSG.en) => {
    // Unknown numbers behave like an ordinary active motor contract, so any 9-digit number
    // works in the demo. 000000000 simulates "not found".
    if (no === '000000000') { errors.push({ field, message: m.notFound(no) }); return null; }
    return CONTRACTS[no] || { product: 'motor', status: 'active', producer: '1000000', holder: 'Test client' };
  };
  const checkFile = (f, field, errors, m = MSG.en) => {
    if (!f?.fileId || !uploads.get(f.fileId)) errors.push({ field, message: m.noFile() });
  };

  const handlers = {
    '/policy-servicing/broker-mandate'(p) {
      const errors = []; const m = msgs(p);
      for (const no of p.fields.contractNumbers || []) {
        const c = checkContract(no, errors, 'contractNumbers', m);
        if (c && c.producer === p.fields.producerNumber) errors.push({ field: 'contractNumbers', message: m.inPortfolio(no, p.fields.producerNumber) });
      }
      checkFile(p.fields.noticeOfChange, 'noticeOfChange', errors, m);
      if (errors.length) return [422, { message: errors.map(e => e.message).join(' '), errors }];
      return [200, { status: 'COMPLETED', reference: ref('BM'), task: { system: 'GD', id: ref('GD'), status: 'closed', closedAt: new Date().toISOString() } }];
    },
    '/policy-servicing/suspension'(p) {
      const errors = []; const m = msgs(p);
      const c = checkContract(p.fields.contractNumber, errors, 'contractNumber', m);
      if (c && c.product !== 'motor') errors.push({ field: 'contractNumber', message: m.notMotor(p.fields.contractNumber, m.product[c.product] || c.product) });
      if (c && c.status === 'suspended') errors.push({ field: 'contractNumber', message: m.suspended(p.fields.contractNumber) });
      checkFile(p.fields.noticeOfDeletion, 'noticeOfDeletion', errors, m);
      if (errors.length) return [422, { message: errors.map(e => e.message).join(' '), errors }];
      return [200, { status: 'COMPLETED', reference: ref('SUS'), task: { system: 'DPM', id: ref('DPM'), status: 'closed', closedAt: new Date().toISOString() } }];
    },
    '/policy-servicing/mail-request'(p) {
      const errors = [];
      checkContract(p.fields.contractNumber, errors, 'contractNumber', msgs(p));
      if (errors.length) return [422, { message: errors.map(e => e.message).join(' '), errors }];
      const reference = ref('MAIL');
      const to = 'policy.servicing@axa.be (mock)';
      const eml = [
        `To: ${to}`,
        `Subject: [Broker assistant] ${p.fields.requestCategory} – contract ${p.fields.contractNumber} – ${reference}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Producer: ${p.broker.producerNumber || 'unknown'}`,
        `Broker language: ${p.language || 'en'} (reply in this language)`,
        `Request id: ${p.requestId}`,
        '',
        ...Object.entries(p.fields).map(([k, v]) => `${k}: ${typeof v === 'object' ? v.name : v}`),
        '',
        'Generated by the AXA broker assistant (non-STP route).'
      ].join('\r\n');
      fs.writeFileSync(path.join(outboxDir, `${reference}.eml`), eml);
      return [200, { status: 'ROUTED', reference, mail: { to, reference, file: `outbox/${reference}.eml` } }];
    }
  };

  // Direct call, used by the default in-process submitter (no network hop).
  const invoke = (pathname, body) => {
    const h = handlers[pathname];
    return h ? h(body) : [404, { message: `No mock endpoint ${pathname}` }];
  };

  // HTTP form, kept at /mock-backend/* for tools such as Postman.
  const handle = async (req, res, pathname, body) => {
    const [status, json] = req.method === 'POST' ? invoke(pathname, body) : [404, { message: 'not found' }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  return { invoke, handle };
}

module.exports = { createMockBackend, CONTRACTS };
