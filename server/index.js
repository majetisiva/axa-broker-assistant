'use strict';
const { createApp } = require('./app');

const app = createApp();
app.server.listen(app.port, () => {
  console.log(`AXA broker assistant running on http://localhost:${app.port}`);
  console.log(`  actions loaded : ${app.catalogue.actions.map(a => a.id).join(', ')}`);
  console.log(`  back end       : ${process.env.BACKEND_BASE_URL || 'mock (built-in)'}`);
  console.log(`  LLM            : ${process.env.LLM_PROVIDER || 'off (rule-based NLU)'}`);
});
