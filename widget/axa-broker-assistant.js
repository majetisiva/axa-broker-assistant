/*
 * <axa-broker-assistant> – embeddable broker chatbot (framework-agnostic Web Component).
 *
 *   <script src="https://<host>/widget/axa-broker-assistant.js" defer></script>
 *   <axa-broker-assistant api-base="https://<host>" producer-number="1055500"
 *                         broker-name="Jan" action-hint="motor_suspension"></axa-broker-assistant>
 *
 * Attributes
 *   api-base        Base URL of the assistant API (default: same origin)
 *   producer-number Logged-in broker's producer number (reused, never asked twice)
 *   broker-name     Shown in the greeting
 *   action-hint     Catalogue id of the webform page the broker is on
 *   variant         "floating" (default, launcher bubble) or "inline" (fills its container)
 *   open            Present → panel starts open
 *   language        en | fr | nl: portal language, used until the broker's first message
 *                   sets the conversation language (the widget then follows the server)
 *
 * Events (bubble, composed)
 *   assistant-state      detail = current state (action, fields, progress)
 *   request-submitted    detail = final request JSON
 */
(() => {
  if (customElements.get('axa-broker-assistant')) return;

  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14h4"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    min: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    clip: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6"/></svg>',
    cal: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>',
    expand: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>'
  };

  // UI wording. The conversation itself comes from the server in the broker's language.
  const UI = {
    en: {
      launcher: 'Ask the assistant', title: 'Broker assistant', subtitle: 'Policy servicing requests',
      newReq: 'New request', newReqEcho: 'Start a new request', expand: 'Expand', minimise: 'Minimise', attach: 'Attach document', pickDate: 'Pick a date', send: 'Send', message: 'Message', date: 'Date',
      tabChat: 'Chat', tabJson: 'Request JSON', tabRequests: 'My requests',
      phIdle: 'Describe what you need…', phAnswer: 'Type your answer…', phFile: 'Attach the document with the paperclip, or type…',
      footer: 'Values are checked again by AXA\'s systems when you submit.', drop: 'Drop the document to attach it',
      unreachable: 'The assistant is not reachable right now. Please try again later or use the webform.',
      postError: 'Something went wrong ({e}). Your information is kept; please try again.',
      badType: '".{ext}" files are not accepted here. Allowed: {list}.', tooBig: 'The file is larger than 10 MB.', uploadFailed: 'Upload failed ({e}). Please try again.',
      summary: 'Request summary', fromProfile: 'from your profile', profileTag: 'from profile', conditional: 'conditional', missing: 'Missing',
      reqRow: 'Request', task: '{system} task', routedTo: 'Routed to', mailRef: 'Mail reference', backendRef: 'Back-end ref.', viewJson: 'View JSON',
      current: 'Current request', tipsIntro: 'No request yet. Just describe what you need in your own words, for example:',
      tips: ['My client handed in the licence plate of his car', 'I\'m taking over contract 622382121 from another broker', 'The client moved, please update the address'],
      tipsOutro: 'I\'ll find the right form, ask only for what\'s missing, and show your progress here.',
      stp: 'Straight-through', mail: 'Routed by mail', mock: 'mock', ofRequired: '{a} of {b} required fields',
      jsonEmpty: 'The request JSON appears here as soon as a request is in progress.', status: 'Status', requiredFields: 'required fields', copy: 'Copy', copied: 'Copied', schema: 'Schema',
      loading: 'Loading…', noRequests: 'No requests submitted in this session yet.', steps: ['Collected', 'Submitted', 'Processed', 'With handler'],
      st: { idle: 'Ready', clarifying: 'Clarifying', collecting: 'Collecting info', awaiting_confirmation: 'Ready to submit', submitting: 'Submitting…', submitted: 'Submitted', cancelled: 'Cancelled', stp_completed: 'Completed (STP)', routed_to_handler: 'Sent to handler', draft: 'Draft', ready: 'Ready' },
      locale: 'en-GB'
    },
    fr: {
      launcher: 'Demander à l\'assistant', title: 'Assistant courtier', subtitle: 'Demandes de gestion de contrats',
      newReq: 'Nouvelle demande', newReqEcho: 'Commencer une nouvelle demande', expand: 'Agrandir', minimise: 'Réduire', attach: 'Joindre un document', pickDate: 'Choisir une date', send: 'Envoyer', message: 'Message', date: 'Date',
      tabChat: 'Chat', tabJson: 'JSON de la demande', tabRequests: 'Mes demandes',
      phIdle: 'Décrivez ce dont vous avez besoin…', phAnswer: 'Tapez votre réponse…', phFile: 'Joignez le document avec le trombone, ou tapez…',
      footer: 'Les valeurs sont à nouveau vérifiées par les systèmes d\'AXA lors de l\'envoi.', drop: 'Déposez le document pour le joindre',
      unreachable: 'L\'assistant n\'est pas joignable pour le moment. Réessayez plus tard ou utilisez le formulaire.',
      postError: 'Une erreur s\'est produite ({e}). Vos informations sont conservées ; veuillez réessayer.',
      badType: 'Les fichiers « .{ext} » ne sont pas acceptés ici. Autorisés : {list}.', tooBig: 'Le fichier dépasse 10 Mo.', uploadFailed: 'L\'envoi du fichier a échoué ({e}). Veuillez réessayer.',
      summary: 'Récapitulatif de la demande', fromProfile: 'de votre profil', profileTag: 'du profil', conditional: 'conditionnel', missing: 'Manquant',
      reqRow: 'Demande', task: 'Tâche {system}', routedTo: 'Transmis à', mailRef: 'Référence mail', backendRef: 'Réf. back-end', viewJson: 'Voir le JSON',
      current: 'Demande en cours', tipsIntro: 'Pas encore de demande. Décrivez simplement ce dont vous avez besoin, par exemple :',
      tips: ['Mon client a rendu la plaque d\'immatriculation de sa voiture', 'Je reprends le contrat 622382121 d\'un autre courtier', 'Le client a déménagé, merci de mettre l\'adresse à jour'],
      tipsOutro: 'Je trouve le bon formulaire, je ne demande que ce qui manque et j\'affiche votre progression ici.',
      stp: 'Traitement automatique', mail: 'Transmis par mail', mock: 'simulation', ofRequired: '{a} sur {b} champs obligatoires',
      jsonEmpty: 'Le JSON de la demande s\'affiche ici dès qu\'une demande est en cours.', status: 'Statut', requiredFields: 'champs obligatoires', copy: 'Copier', copied: 'Copié', schema: 'Schéma',
      loading: 'Chargement…', noRequests: 'Aucune demande envoyée dans cette session.', steps: ['Collectée', 'Envoyée', 'Traitée', 'Chez le gestionnaire'],
      st: { idle: 'Prêt', clarifying: 'Clarification', collecting: 'Collecte des infos', awaiting_confirmation: 'Prête à envoyer', submitting: 'Envoi…', submitted: 'Envoyée', cancelled: 'Annulée', stp_completed: 'Terminée (STP)', routed_to_handler: 'Chez un gestionnaire', draft: 'Brouillon', ready: 'Prête' },
      locale: 'fr-BE'
    },
    nl: {
      launcher: 'Vraag het de assistent', title: 'Makelaarsassistent', subtitle: 'Aanvragen voor polisbeheer',
      newReq: 'Nieuwe aanvraag', newReqEcho: 'Een nieuwe aanvraag starten', expand: 'Vergroten', minimise: 'Minimaliseren', attach: 'Document toevoegen', pickDate: 'Kies een datum', send: 'Versturen', message: 'Bericht', date: 'Datum',
      tabChat: 'Chat', tabJson: 'JSON van de aanvraag', tabRequests: 'Mijn aanvragen',
      phIdle: 'Beschrijf wat u nodig hebt…', phAnswer: 'Typ uw antwoord…', phFile: 'Voeg het document toe met de paperclip, of typ…',
      footer: 'De waarden worden bij het indienen opnieuw gecontroleerd door de systemen van AXA.', drop: 'Sleep het document hierheen om het toe te voegen',
      unreachable: 'De assistent is momenteel niet bereikbaar. Probeer het later opnieuw of gebruik het webformulier.',
      postError: 'Er ging iets mis ({e}). Uw gegevens blijven bewaard; probeer het opnieuw.',
      badType: '".{ext}"-bestanden worden hier niet aanvaard. Toegelaten: {list}.', tooBig: 'Het bestand is groter dan 10 MB.', uploadFailed: 'Uploaden mislukt ({e}). Probeer het opnieuw.',
      summary: 'Overzicht van de aanvraag', fromProfile: 'uit uw profiel', profileTag: 'uit profiel', conditional: 'voorwaardelijk', missing: 'Ontbreekt',
      reqRow: 'Aanvraag', task: '{system}-taak', routedTo: 'Doorgestuurd naar', mailRef: 'Mailreferentie', backendRef: 'Backend-ref.', viewJson: 'JSON bekijken',
      current: 'Huidige aanvraag', tipsIntro: 'Nog geen aanvraag. Beschrijf gewoon in uw eigen woorden wat u nodig hebt, bijvoorbeeld:',
      tips: ['Mijn klant heeft de nummerplaat van zijn auto ingeleverd', 'Ik neem contract 622382121 over van een andere makelaar', 'De klant is verhuisd, pas het adres aan'],
      tipsOutro: 'Ik zoek het juiste formulier, vraag alleen wat ontbreekt en toon hier uw voortgang.',
      stp: 'Automatische verwerking', mail: 'Doorgestuurd per mail', mock: 'simulatie', ofRequired: '{a} van {b} verplichte velden',
      jsonEmpty: 'De JSON van de aanvraag verschijnt hier zodra een aanvraag loopt.', status: 'Status', requiredFields: 'verplichte velden', copy: 'Kopiëren', copied: 'Gekopieerd', schema: 'Schema',
      loading: 'Laden…', noRequests: 'Nog geen aanvragen ingediend in deze sessie.', steps: ['Verzameld', 'Ingediend', 'Verwerkt', 'Bij dossierbeheerder'],
      st: { idle: 'Klaar', clarifying: 'Verduidelijken', collecting: 'Gegevens verzamelen', awaiting_confirmation: 'Klaar om in te dienen', submitting: 'Indienen…', submitted: 'Ingediend', cancelled: 'Geannuleerd', stp_completed: 'Afgerond (STP)', routed_to_handler: 'Bij dossierbeheerder', draft: 'Concept', ready: 'Klaar' },
      locale: 'nl-BE'
    }
  };
  const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

  const CSS = `
  :host { --blue:#00008f; --blue-2:#1f1f9c; --blue-soft:#eef0fb; --red:#ff1721; --ink:#1a1a2e; --muted:#5f6577;
          --line:#e3e5ee; --ok:#138636; --ok-soft:#e8f5ec; --err:#c91432; --err-soft:#fdecef; --warn-soft:#fff6e0;
          --radius:14px; font-family:"Source Sans Pro","Source Sans 3","Segoe UI",system-ui,-apple-system,sans-serif;
          color:var(--ink); font-size:15px; line-height:1.45; }
  * { box-sizing:border-box; }
  button { font:inherit; cursor:pointer; }
  .launcher { position:fixed; right:24px; bottom:24px; z-index:2147483000; display:flex; align-items:center; gap:10px;
              background:var(--blue); color:#fff; border:none; border-radius:999px; padding:12px 20px 12px 16px;
              box-shadow:0 10px 30px rgba(0,0,143,.35); font-weight:600; transition:transform .15s; }
  .launcher:hover { transform:translateY(-2px); }
  .launcher .dot { width:8px; height:8px; border-radius:50%; background:var(--red); margin-left:2px; }
  .panel { position:fixed; right:24px; bottom:24px; z-index:2147483001; width:420px; height:min(680px, calc(100vh - 48px));
           background:#fff; border-radius:var(--radius); box-shadow:0 24px 60px rgba(10,10,60,.28), 0 0 0 1px rgba(0,0,0,.04);
           display:flex; flex-direction:column; overflow:hidden; transition:width .2s; }
  .panel.wide { width:min(860px, calc(100vw - 48px)); }
  :host([variant="inline"]) .panel { position:relative; right:auto; bottom:auto; width:100%; height:100%; box-shadow:0 0 0 1px var(--line); }
  :host([variant="inline"]) .launcher, :host([variant="inline"]) .btn-min { display:none; }
  :host([variant="page"]) { display:block; height:100%; }
  :host([variant="page"]) .panel { position:relative; right:auto; bottom:auto; width:100%; height:100%; border-radius:18px;
                                   box-shadow:0 20px 60px rgba(10,10,60,.14), 0 0 0 1px rgba(0,0,0,.04); }
  :host([variant="page"]) .launcher, :host([variant="page"]) .btn-min, :host([variant="page"]) .btn-wide { display:none; }
  :host([variant="page"]) header { padding:18px 22px; }
  :host([variant="page"]) .log { padding:24px 28px 10px; }
  :host([variant="page"]) .msg { max-width:72%; }
  :host([variant="page"]) .side { width:360px; }
  .tips { padding:0 16px; font-size:13.5px; color:var(--muted); }
  .tips p { margin:0 0 8px; }
  .tips i { display:block; background:#fff; border:1px solid var(--line); border-radius:10px; padding:8px 10px; margin-bottom:6px; font-style:normal; color:var(--ink); }
  .hidden { display:none !important; }

  header { background:var(--blue); color:#fff; padding:14px 14px 12px 18px; display:flex; align-items:center; gap:10px; }
  header .avatar { width:34px; height:34px; border-radius:50%; background:#fff; color:var(--blue); display:grid; place-items:center; font-weight:800; font-size:13px; letter-spacing:.5px; flex:none; }
  header .t { flex:1; min-width:0; }
  header .t b { display:block; font-size:16px; }
  header .t span { font-size:12.5px; opacity:.85; }
  .hbtn { background:transparent; border:none; color:#fff; width:32px; height:32px; border-radius:8px; display:grid; place-items:center; opacity:.9; }
  .hbtn:hover { background:rgba(255,255,255,.14); opacity:1; }

  .tabs { display:flex; border-bottom:1px solid var(--line); background:#fafbff; padding:0 10px; }
  .tab { background:none; border:none; padding:10px 12px; font-size:13.5px; color:var(--muted); border-bottom:2px solid transparent; font-weight:600; }
  .tab[aria-selected="true"] { color:var(--blue); border-color:var(--blue); }
  .tab .count { background:var(--blue-soft); color:var(--blue); border-radius:999px; padding:0 7px; font-size:12px; margin-left:4px; }

  .main { flex:1; display:flex; min-height:0; }
  .chatcol { flex:1; display:flex; flex-direction:column; min-width:0; }
  .side { width:330px; border-left:1px solid var(--line); background:#fafbff; overflow:auto; display:none; }
  .panel.wide .side { display:block; }
  .panel.wide .progress-strip { display:none; }

  .progress-strip { border-bottom:1px solid var(--line); background:#fff; }
  .ps-head { width:100%; display:flex; align-items:center; gap:10px; padding:10px 16px; background:none; border:none; text-align:left; }
  .ps-head .name { flex:1; font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ps-head .frac { font-size:12.5px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .bar { height:4px; background:var(--line); border-radius:4px; overflow:hidden; margin:0 16px 10px; }
  .bar i { display:block; height:100%; background:var(--ok); transition:width .3s; }
  .ps-body { padding:0 16px 12px; max-height:230px; overflow:auto; }

  .pill { font-size:11.5px; font-weight:700; padding:2px 9px; border-radius:999px; background:var(--blue-soft); color:var(--blue); white-space:nowrap; }
  .pill.ok { background:var(--ok-soft); color:var(--ok); } .pill.warn { background:var(--warn-soft); color:#8a5a00; } .pill.err { background:var(--err-soft); color:var(--err); }

  .fields { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
  .fields li { display:flex; gap:9px; align-items:flex-start; font-size:13.5px; padding:7px 9px; border-radius:9px; background:#fff; border:1px solid var(--line); }
  .fields li.pending { border-color:var(--blue); box-shadow:0 0 0 2px var(--blue-soft); }
  .fields .ic { width:20px; height:20px; border-radius:50%; flex:none; display:grid; place-items:center; margin-top:1px; }
  .fields .ok .ic { background:var(--ok); color:#fff; } .fields .missing .ic { border:2px dashed #b9bdcc; } .fields .invalid .ic { background:var(--err); color:#fff; }
  .fields .lbl { font-weight:600; } .fields .val { color:var(--muted); word-break:break-all; } .fields .er { color:var(--err); font-size:12.5px; }
  .fields .tag { font-size:11px; color:var(--blue); background:var(--blue-soft); border-radius:5px; padding:0 5px; margin-left:4px; font-weight:600; }
  .side h4 { margin:16px 16px 8px; font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); }
  .side .sect { padding:0 16px 8px; }
  .side .action-title { font-size:16px; font-weight:700; color:var(--blue); margin:0 0 2px; }
  .side .meta { font-size:12.5px; color:var(--muted); margin-bottom:10px; }
  .empty { color:var(--muted); font-size:13.5px; padding:6px 0; }

  .log { flex:1; overflow-y:auto; padding:18px 16px 8px; display:flex; flex-direction:column; gap:8px; background:linear-gradient(#fff,#fbfbfe); }
  .log > * { flex-shrink:0; }
  .msg { max-width:86%; padding:9px 13px; border-radius:14px; white-space:pre-wrap; word-wrap:break-word; animation:pop .18s ease-out; }
  @keyframes pop { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  .msg.bot { background:#f1f2f8; border-bottom-left-radius:4px; align-self:flex-start; }
  .msg.user { background:var(--blue); color:#fff; border-bottom-right-radius:4px; align-self:flex-end; }
  .msg.ack { background:var(--ok-soft); color:#0d5e26; font-size:14px; display:flex; gap:7px; }
  .msg.ack .ic { flex:none; margin-top:3px; }
  .msg.error { background:var(--err-soft); color:#8f0c22; border-left:3px solid var(--err); }
  .msg.notice { background:var(--warn-soft); color:#6b4a00; font-size:13.5px; }
  .msg.success { background:var(--ok-soft); border:1px solid #bfe3ca; color:#0d5e26; font-weight:600; }
  .msg.question { background:#f1f2f8; }
  .msg.file { display:flex; align-items:center; gap:8px; }
  .card { align-self:stretch; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:#fff; animation:pop .18s ease-out; }
  .card table { width:100%; border-collapse:collapse; font-size:14px; }
  .card td { padding:8px 12px; border-top:1px solid var(--line); vertical-align:top; }
  .card tr:first-child td { border-top:none; }
  .card td:first-child { color:var(--muted); width:44%; }
  .card td:last-child { font-weight:600; word-break:break-all; }
  .card .reused { font-size:11px; font-weight:600; color:var(--blue); background:var(--blue-soft); border-radius:5px; padding:0 5px; margin-left:6px; }
  .card .ch { background:var(--blue); color:#fff; padding:8px 12px; font-size:13px; font-weight:700; display:flex; justify-content:space-between; }
  .typing { align-self:flex-start; background:#f1f2f8; border-radius:14px; padding:10px 14px; display:flex; gap:4px; }
  .typing i { width:6px; height:6px; border-radius:50%; background:#9aa0b5; animation:blink 1s infinite; }
  .typing i:nth-child(2){animation-delay:.15s} .typing i:nth-child(3){animation-delay:.3s}
  @keyframes blink { 0%,80%,100%{opacity:.3} 40%{opacity:1} }

  .quick { display:flex; flex-wrap:wrap; gap:6px; padding:6px 16px 10px; }
  .chip { border:1.5px solid var(--blue); color:var(--blue); background:#fff; border-radius:999px; padding:6px 13px; font-size:13.5px; font-weight:600; }
  .chip:hover { background:var(--blue-soft); }
  .chip.primary { background:var(--blue); color:#fff; }

  .composer { border-top:1px solid var(--line); padding:10px 12px; display:flex; gap:8px; align-items:flex-end; background:#fff; }
  .composer textarea { flex:1; resize:none; border:1.5px solid var(--line); border-radius:12px; padding:9px 12px; font:inherit; max-height:120px; min-height:40px; outline:none; }
  .composer textarea:focus { border-color:var(--blue); }
  .ibtn { width:40px; height:40px; border-radius:12px; border:1.5px solid var(--line); background:#fff; color:var(--blue); display:grid; place-items:center; flex:none; position:relative; }
  .ibtn:hover { border-color:var(--blue); }
  .ibtn.attn { border-color:var(--red); color:var(--red); animation:pulse 1.4s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(255,23,33,.35)} 70%{box-shadow:0 0 0 8px rgba(255,23,33,0)} 100%{box-shadow:0 0 0 0 rgba(255,23,33,0)} }
  .ibtn input[type=date] { position:absolute; inset:0; opacity:0; cursor:pointer; }
  .sbtn { width:40px; height:40px; border-radius:12px; border:none; background:var(--blue); color:#fff; display:grid; place-items:center; flex:none; }
  .sbtn:disabled { opacity:.4; cursor:default; }
  .hint { font-size:12px; color:var(--muted); padding:0 16px 8px; }
  .drop { position:absolute; inset:0; background:rgba(0,0,143,.88); color:#fff; display:grid; place-items:center; font-size:18px; font-weight:700; z-index:5; border-radius:var(--radius); }

  .pane { flex:1; overflow:auto; padding:14px 16px; }
  pre.json { margin:0; background:#0f1030; color:#d7dbff; padding:14px; border-radius:12px; font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow:auto; white-space:pre; }
  pre.json .k { color:#9fb4ff; } pre.json .s { color:#a6e3a1; } pre.json .n { color:#fab387; } pre.json .b { color:#f38ba8; }
  .jsonbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; gap:8px; }
  .jsonbar .small { font-size:12.5px; color:var(--muted); }
  .lbtn { border:1.5px solid var(--line); background:#fff; border-radius:8px; padding:4px 10px; font-size:13px; color:var(--blue); font-weight:600; }
  .req { border:1px solid var(--line); border-radius:12px; padding:11px 13px; margin-bottom:9px; background:#fff; }
  .req .top { display:flex; justify-content:space-between; gap:8px; align-items:center; }
  .req .id { font-weight:700; font-size:13.5px; font-variant-numeric:tabular-nums; }
  .req .what { font-size:14px; margin:3px 0; }
  .req .sub { font-size:12.5px; color:var(--muted); }
  .steps { display:flex; gap:4px; margin-top:8px; }
  .steps span { flex:1; height:4px; border-radius:3px; background:var(--line); }
  .steps span.on { background:var(--ok); }
  .footer-note { font-size:11.5px; color:var(--muted); text-align:center; padding:0 12px 8px; }
  @media (max-width:520px) { .panel { right:0; bottom:0; width:100vw; height:100vh; border-radius:0; } .launcher { right:16px; bottom:16px; } }
  `;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const highlight = json => esc(JSON.stringify(json, null, 2))
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?/g, (m, s, colon) => colon ? `<span class="k">${s}</span>${colon}` : `<span class="s">${s}</span>`)
    .replace(/\b(-?\d+(?:\.\d+)?)\b(?![^<]*<\/span>)/g, '<span class="n">$1</span>')
    .replace(/\b(true|false|null)\b/g, '<span class="b">$1</span>');

  class BrokerAssistant extends HTMLElement {
    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
      this.sessionId = null;
      this.state = null;
      this.request = null;
      this.expect = null;
      this.busy = false;
      this.tab = 'chat';
      this.psOpen = false;
      this.submitted = [];
      this.lang = null;
      this.titles = {};   // requestId → action title in the conversation language
    }

    // UI text in the current language
    L(key, vars) {
      const dict = UI[this.lang] || UI.en;
      const v = dict[key] ?? UI.en[key];
      return typeof v === 'string' ? fill(v, vars) : v;
    }
    statusLabel(s) { return this.L('st')[s] || s; }

    get api() { return (this.getAttribute('api-base') || '').replace(/\/$/, ''); }

    connectedCallback() {
      this.lang = UI[this.getAttribute('language')] ? this.getAttribute('language') : 'en';
      this.render();
      const v = this.getAttribute('variant');
      if (v === 'page') {
        const fit = () => this.$('.panel').classList.toggle('wide', this.getBoundingClientRect().width >= 900);
        new ResizeObserver(fit).observe(this); fit();
      }
      if (this.hasAttribute('open') || v === 'inline' || v === 'page') this.openPanel();
    }

    // Public API for host apps (e.g. Angular): element.openPanel(), element.send('...')
    openPanel() {
      this.$('.panel').classList.remove('hidden');
      this.$('.launcher').classList.add('hidden');
      if (!this.sessionId) this.start();
      setTimeout(() => this.$('textarea').focus(), 50);
    }
    closePanel() {
      this.$('.panel').classList.add('hidden');
      this.$('.launcher').classList.remove('hidden');
    }
    send(text) { return this.post({ text }, text); }

    $(s) { return this.root.querySelector(s); }

    render() {
      this.root.innerHTML = `
        <style>${CSS}</style>
        <button class="launcher" part="launcher" aria-label="Open broker assistant">${ICONS.chat}<span class="i-launcher"></span><span class="dot"></span></button>
        <section class="panel hidden" role="dialog" aria-label="AXA broker assistant">
          <header>
            <div class="avatar">AXA</div>
            <div class="t"><b class="i-title"></b><span class="hstatus"></span></div>
            <button class="hbtn btn-new">${ICONS.plus}</button>
            <button class="hbtn btn-wide">${ICONS.expand}</button>
            <button class="hbtn btn-min">${ICONS.min}</button>
          </header>
          <nav class="tabs" role="tablist">
            <button class="tab" role="tab" data-tab="chat" aria-selected="true"><span class="i-tab"></span></button>
            <button class="tab" role="tab" data-tab="json" aria-selected="false"><span class="i-tab"></span></button>
            <button class="tab" role="tab" data-tab="requests" aria-selected="false"><span class="i-tab"></span> <span class="count hidden">0</span></button>
          </nav>
          <div class="main">
            <div class="chatcol">
              <div class="view view-chat" style="display:flex;flex-direction:column;flex:1;min-height:0">
                <div class="progress-strip hidden"></div>
                <div class="log" aria-live="polite"></div>
                <div class="quick"></div>
                <div class="hint hidden"></div>
                <div class="composer">
                  <button class="ibtn btn-attach">${ICONS.clip}</button>
                  <input type="file" class="file hidden" />
                  <button class="ibtn btn-date hidden">${ICONS.cal}<input type="date"/></button>
                  <textarea rows="1"></textarea>
                  <button class="sbtn btn-send" disabled>${ICONS.send}</button>
                </div>
                <div class="footer-note"></div>
              </div>
              <div class="view view-json pane hidden"></div>
              <div class="view view-requests pane hidden"></div>
            </div>
            <aside class="side"></aside>
          </div>
          <div class="drop hidden"></div>
        </section>`;
      this.applyLang();

      this.$('.launcher').onclick = () => this.openPanel();
      this.$('.btn-min').onclick = () => this.closePanel();
      this.$('.btn-wide').onclick = () => this.$('.panel').classList.toggle('wide');
      this.$('.btn-new').onclick = () => this.post({ text: 'start over' }, this.L('newReqEcho'));
      this.root.querySelectorAll('.tab').forEach(t => t.onclick = () => this.showTab(t.dataset.tab));

      const ta = this.$('textarea');
      ta.addEventListener('input', () => {
        ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
        this.$('.btn-send').disabled = !ta.value.trim() || this.busy;
      });
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submitText(); } });
      this.$('.btn-send').onclick = () => this.submitText();

      const file = this.$('.file');
      this.$('.btn-attach').onclick = () => file.click();
      file.onchange = () => { if (file.files[0]) this.upload(file.files[0]); file.value = ''; };

      const date = this.$('.btn-date input');
      date.onchange = () => {
        if (!date.value) return;
        const [y, m, d] = date.value.split('-');
        this.post({ text: `${d}/${m}/${y}` }, `${d}/${m}/${y}`);
        date.value = '';
      };

      const panel = this.$('.panel'); const drop = this.$('.drop');
      panel.addEventListener('dragover', e => { e.preventDefault(); drop.classList.remove('hidden'); });
      drop.addEventListener('dragleave', () => drop.classList.add('hidden'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.add('hidden'); if (e.dataTransfer.files[0]) this.upload(e.dataTransfer.files[0]); });
    }

    // Writes every static label in the current language (called on render and when the language changes).
    applyLang() {
      const set = (sel, text) => { const el = this.$(sel); if (el) el.textContent = text; };
      const label = (sel, text) => { const el = this.$(sel); if (el) { el.title = text; el.setAttribute('aria-label', text); } };
      this.$('.panel').lang = this.lang;
      set('.i-launcher', this.L('launcher')); set('.i-title', this.L('title'));
      label('.btn-new', this.L('newReq')); label('.btn-wide', this.L('expand')); label('.btn-min', this.L('minimise'));
      label('.btn-attach', this.L('attach')); label('.btn-date', this.L('pickDate')); label('.btn-send', this.L('send'));
      this.$('.btn-date input').setAttribute('aria-label', this.L('date'));
      this.$('textarea').setAttribute('aria-label', this.L('message'));
      const tabs = this.root.querySelectorAll('.tab .i-tab');
      [this.L('tabChat'), this.L('tabJson'), this.L('tabRequests')].forEach((t, i) => { tabs[i].textContent = t; });
      set('.footer-note', this.L('footer')); set('.drop', this.L('drop'));
      this.renderHeader(); this.renderExpect(); this.renderProgress();
    }

    renderHeader() {
      const s = this.state;
      this.$('.hstatus').textContent = s?.action ? `${s.action.title} · ${this.statusLabel(this.status || s.status)}` : this.L('subtitle');
    }

    showTab(tab) {
      this.tab = tab;
      this.root.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
      this.$('.view-chat').classList.toggle('hidden', tab !== 'chat');
      this.$('.view-chat').style.display = tab === 'chat' ? 'flex' : 'none';
      this.$('.view-json').classList.toggle('hidden', tab !== 'json');
      this.$('.view-requests').classList.toggle('hidden', tab !== 'requests');
      if (tab === 'json') this.renderJson();
      if (tab === 'requests') this.loadRequests();
    }

    async start() {
      this.showTyping(true);
      try {
        const res = await this.call('/api/sessions', {
          mode: 'human',
          context: {
            producerNumber: this.getAttribute('producer-number') || undefined,
            brokerName: this.getAttribute('broker-name') || undefined,
            actionId: this.getAttribute('action-hint') || undefined
          }
        });
        this.apply(res);
      } catch (e) {
        this.showTyping(false);
        this.addBot({ text: this.L('unreachable'), kind: 'error' });
      }
    }

    submitText() {
      const ta = this.$('textarea');
      const text = ta.value.trim();
      if (!text || this.busy) return;
      ta.value = ''; ta.style.height = 'auto';
      this.$('.btn-send').disabled = true;
      this.post({ text }, text);
    }

    async post(body, echo) {
      if (this.busy) return;
      if (this.tab !== 'chat') this.showTab('chat');
      if (echo) this.addUser(echo);
      this.setBusy(true);
      try {
        const res = await this.call('/api/chat', { sessionId: this.sessionId, ...body });
        this.apply(res);
      } catch (e) {
        this.showTyping(false);
        this.addBot({ text: this.L('postError', { e: e.message }), kind: 'error' });
      } finally {
        this.setBusy(false);
      }
    }

    async upload(file) {
      const accept = this.expect?.accept;
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (accept && !accept.includes(ext)) {
        this.addBot({ text: this.L('badType', { ext, list: accept.join(', ').toUpperCase() }), kind: 'error' });
        return;
      }
      if (file.size > 10 * 1024 * 1024) { this.addBot({ text: this.L('tooBig'), kind: 'error' }); return; }
      this.addUser(`📎 ${file.name}`, 'file');
      this.setBusy(true);
      try {
        const dataBase64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        const up = await this.call('/api/uploads', { name: file.name, mime: file.type, dataBase64, sessionId: this.sessionId });
        const res = await this.call('/api/chat', { sessionId: this.sessionId, fileId: up.fileId });
        this.apply(res);
      } catch (e) {
        this.showTyping(false);
        this.addBot({ text: this.L('uploadFailed', { e: e.message }), kind: 'error' });
      } finally {
        this.setBusy(false);
      }
    }

    async call(path, body) {
      const res = await fetch(this.api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
      return json;
    }

    setBusy(b) {
      this.busy = b;
      this.showTyping(b);
      this.$('.btn-send').disabled = b || !this.$('textarea').value.trim();
    }

    apply(res) {
      this.showTyping(false);
      this.sessionId = res.sessionId;
      this.state = res.state;
      this.request = res.request;
      this.expect = res.expect;
      this.status = res.status;
      if (res.state?.action) this.lastTitle = res.state.action.title;
      const lang = res.language || res.state?.language;
      if (UI[lang] && lang !== this.lang) { this.lang = lang; this.applyLang(); }
      for (const r of res.replies) this.addBot(r);
      this.renderQuick(res.quickReplies || []);
      this.renderExpect();
      this.renderProgress();
      this.renderHeader();
      this.dispatchEvent(new CustomEvent('assistant-state', { detail: res.state, bubbles: true, composed: true }));
      if (res.status === 'submitted' && res.request) {
        this.submitted.unshift(res.request);
        const c = this.$('.tab .count'); c.textContent = this.submitted.length; c.classList.remove('hidden');
        this.addRequestCard(res.request);
        this.dispatchEvent(new CustomEvent('request-submitted', { detail: res.request, bubbles: true, composed: true }));
      }
      if (this.tab === 'json') this.renderJson();
    }

    addUser(text, kind) {
      const el = document.createElement('div');
      el.className = `msg user ${kind || ''}`;
      el.textContent = text;
      this.append(el);
    }

    addBot(r) {
      if (r.kind === 'summary' && r.rows) {
        const el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = `<div class="ch"><span>${esc(this.L('summary'))}</span><span>${this.state?.action ? esc(this.state.action.title) : ''}</span></div><table>${r.rows.map(row =>
          `<tr><td>${esc(row.label)}</td><td>${esc(row.value)}${row.reused ? `<span class="reused">${esc(this.L('fromProfile'))}</span>` : ''}</td></tr>`).join('')}</table>`;
        return this.append(el);
      }
      const el = document.createElement('div');
      const kind = r.kind === 'summary' || r.kind === 'text' ? 'bot' : `bot ${r.kind}`;
      el.className = `msg ${kind}`;
      if (r.kind === 'ack') el.innerHTML = `<span class="ic">${ICONS.check}</span><span>${esc(r.text)}</span>`;
      else el.textContent = r.text;
      this.append(el);
    }

    addRequestCard(req) {
      const el = document.createElement('div');
      el.className = 'card';
      const task = req.submission?.task; const mail = req.submission?.mail;
      const title = this.titles[req.requestId] = this.lastTitle || req.action.title;
      el.innerHTML = `<div class="ch" style="background:var(--ok)"><span>${esc(req.requestId)}</span><span>${esc(this.statusLabel(req.status))}</span></div>
        <table>
          <tr><td>${esc(this.L('reqRow'))}</td><td>${esc(title)}</td></tr>
          ${task ? `<tr><td>${esc(this.L('task', { system: task.system }))}</td><td>${esc(task.id)} · ${esc(task.status)}</td></tr>` : ''}
          ${mail ? `<tr><td>${esc(this.L('routedTo'))}</td><td>${esc(mail.to)}</td></tr><tr><td>${esc(this.L('mailRef'))}</td><td>${esc(mail.reference)}</td></tr>` : ''}
          <tr><td>${esc(this.L('backendRef'))}</td><td>${esc(req.submission?.backendReference || '–')}</td></tr>
        </table>
        <div style="padding:8px 12px;border-top:1px solid var(--line)"><button class="lbtn">${esc(this.L('viewJson'))}</button></div>`;
      el.querySelector('.lbtn').onclick = () => { this.request = req; this.showTab('json'); };
      this.append(el);
    }

    append(el) {
      const log = this.$('.log');
      const typing = log.querySelector('.typing');
      log.insertBefore(el, typing || null);
      log.scrollTop = log.scrollHeight;
    }

    showTyping(on) {
      const log = this.$('.log');
      let t = log.querySelector('.typing');
      if (on && !t) { t = document.createElement('div'); t.className = 'typing'; t.innerHTML = '<i></i><i></i><i></i>'; log.appendChild(t); log.scrollTop = log.scrollHeight; }
      if (!on && t) t.remove();
    }

    renderQuick(list) {
      const q = this.$('.quick');
      q.innerHTML = '';
      for (const item of list) {
        const b = document.createElement('button');
        b.className = `chip ${item.primary ? 'primary' : ''}`;
        b.textContent = item.label;
        b.onclick = () => item.action ? this.post({ action: item.action }, item.label) : this.post({ text: item.text || item.label }, item.label);
        q.appendChild(b);
      }
    }

    renderExpect() {
      const ex = this.expect;
      const attach = this.$('.btn-attach'); const date = this.$('.btn-date'); const hint = this.$('.hint');
      attach.classList.toggle('attn', ex?.type === 'file');
      date.classList.toggle('hidden', ex?.type !== 'date');
      const f = this.state?.fields?.find(x => x.id === ex?.fieldId);
      if (f?.help) { hint.textContent = f.help; hint.classList.remove('hidden'); } else hint.classList.add('hidden');
      const file = this.$('.file');
      file.accept = ex?.accept ? ex.accept.map(a => '.' + a).join(',') : '';
      this.$('textarea').placeholder = ex?.type === 'file' ? this.L('phFile') : this.state?.action ? this.L('phAnswer') : this.L('phIdle');
    }

    fieldsHtml(s) {
      return `<ul class="fields">${s.fields.map(f => `
        <li class="${f.status} ${s.pendingFieldId === f.id ? 'pending' : ''}">
          <span class="ic">${f.status === 'ok' ? ICONS.check : f.status === 'invalid' ? ICONS.warn : ''}</span>
          <span><span class="lbl">${esc(f.label)}</span>${f.conditional ? `<span class="tag">${esc(this.L('conditional'))}</span>` : ''}${f.source === 'reused_from_profile' ? `<span class="tag">${esc(this.L('profileTag'))}</span>` : ''}
          <div class="val">${f.status === 'ok' ? esc(f.display) : f.status === 'missing' ? esc(this.L('missing')) : ''}</div>
          ${f.error ? `<div class="er">${esc(f.error)}</div>` : ''}</span>
        </li>`).join('')}</ul>`;
    }

    renderProgress() {
      const s = this.state;
      const strip = this.$('.progress-strip'); const side = this.$('.side');
      if (!s?.action) {
        strip.classList.add('hidden');
        side.innerHTML = `<h4>${esc(this.L('current'))}</h4><div class="tips"><p>${esc(this.L('tipsIntro'))}</p>
          ${this.L('tips').map(x => `<i>${esc(x)}</i>`).join('')}
          <p>${esc(this.L('tipsOutro'))}</p></div>`;
        return;
      }
      const pct = s.progress.required ? Math.round(100 * s.progress.completed / s.progress.required) : 0;
      const pillCls = s.status === 'awaiting_confirmation' ? 'ok' : Object.values(s.fields).some(f => f.status === 'invalid') ? 'err' : 'warn';
      strip.classList.remove('hidden');
      strip.innerHTML = `
        <button class="ps-head" aria-expanded="${this.psOpen}">
          <span class="name">${esc(s.action.title)}</span>
          <span class="pill ${pillCls}">${esc(this.statusLabel(s.status))}</span>
          <span class="frac">${s.progress.completed}/${s.progress.required}</span>
        </button>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="ps-body ${this.psOpen ? '' : 'hidden'}">${this.fieldsHtml(s)}</div>`;
      strip.querySelector('.ps-head').onclick = () => { this.psOpen = !this.psOpen; this.renderProgress(); };

      side.innerHTML = `
        <h4>${esc(this.L('current'))}</h4>
        <div class="sect">
          <p class="action-title">${esc(s.action.title)}</p>
          <div class="meta">${esc(s.action.segment)} · ${esc(s.action.lineOfBusiness)} · ${esc(this.L(s.action.mode === 'stp' ? 'stp' : 'mail'))}${s.action.mock ? ` · ${esc(this.L('mock'))}` : ''}</div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span class="pill ${pillCls}">${esc(this.statusLabel(s.status))}</span><span class="frac" style="font-size:12.5px;color:var(--muted)">${esc(this.L('ofRequired', { a: s.progress.completed, b: s.progress.required }))}</span></div>
          <div class="bar" style="margin:0 0 12px"><i style="width:${pct}%"></i></div>
          ${this.fieldsHtml(s)}
        </div>`;
    }

    renderJson() {
      const pane = this.$('.view-json');
      if (!this.request) { pane.innerHTML = `<div class="empty">${esc(this.L('jsonEmpty'))}</div>`; return; }
      pane.innerHTML = `<div class="jsonbar"><span class="small">${esc(this.L('status'))} <b>${esc(this.request.status)}</b> · ${this.request.completeness.provided}/${this.request.completeness.required} ${esc(this.L('requiredFields'))}</span>
        <span><button class="lbtn cp">${esc(this.L('copy'))}</button> <a class="lbtn" style="text-decoration:none" target="_blank" href="${this.api}/api/actions/${esc(this.request.action.id)}/schema">${esc(this.L('schema'))}</a></span></div>
        <pre class="json">${highlight(this.request)}</pre>`;
      pane.querySelector('.cp').onclick = e => { navigator.clipboard?.writeText(JSON.stringify(this.request, null, 2)); e.target.textContent = this.L('copied'); };
    }

    async loadRequests() {
      const pane = this.$('.view-requests');
      pane.innerHTML = `<div class="empty">${esc(this.L('loading'))}</div>`;
      let list = this.submitted;
      try {
        const res = await fetch(`${this.api}/api/requests?sessionId=${encodeURIComponent(this.sessionId || '')}`, { credentials: 'include' });
        if (res.ok) list = await res.json();
      } catch { /* keep local list */ }
      if (!list.length) { pane.innerHTML = `<div class="empty">${esc(this.L('noRequests'))}</div>`; return; }
      const [collected, submitted, processed, withHandler] = this.L('steps');
      pane.innerHTML = list.map(r => {
        const done = r.status === 'stp_completed' || r.status === 'routed_to_handler';
        const steps = [collected, submitted, r.submission?.mode === 'stp' ? processed : withHandler];
        return `<div class="req">
          <div class="top"><span class="id">${esc(r.requestId)}</span><span class="pill ${done ? 'ok' : 'warn'}">${esc(this.statusLabel(r.status))}</span></div>
          <div class="what">${esc(this.titles[r.requestId] || r.action.title)} · ${esc([].concat(r.fields.contractNumber || r.fields.contractNumbers || []).join(', '))}</div>
          <div class="sub">${new Date(r.submittedAt).toLocaleString(this.L('locale'))} · ${r.submission?.task ? esc(r.submission.task.system + ' ' + r.submission.task.id) : esc(r.submission?.mail?.reference || '')}</div>
          <div class="steps">${steps.map(() => `<span class="on"></span>`).join('')}</div>
          <div class="sub" style="display:flex;justify-content:space-between;margin-top:3px">${steps.map(s => `<span>${s}</span>`).join('')}</div>
        </div>`;
      }).join('');
    }
  }

  customElements.define('axa-broker-assistant', BrokerAssistant);
})();
