// Shared helpers: n8n REST API (key from ~/.claude.json, never written anywhere) + node builders.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const env = process.env; // N8N_API_URL, N8N_API_KEY
export const N8N = env.N8N_API_URL.replace(/\/$/, '');

export async function api(method, path, body) {
  const r = await fetch(N8N + path, {
    method, headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 500)}`);
  return t ? JSON.parse(t) : {};
}

const here = (p) => new URL(p, import.meta.url);
export const src = (name) => readFileSync(here(`./src/${name}`), 'utf8');
export const prompt = (name) => readFileSync(here(`../prompts/${name}`), 'utf8');

export function prompts() {
  const cand = prompt('candidate.md');
  return {
    SCORE_SYSTEM: prompt('score.md').replace('{{CANDIDATE}}', cand),
    LETTER_SYSTEM: prompt('letter.md').replace('{{CANDIDATE}}', cand),
  };
}
export const constsJs = (obj) => Object.entries(obj).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join('\n') + '\n';

export const CRED = {
  anthropic: { anthropicApi: { id: 'CREDENTIAL_ID', name: 'Anthropic account' } },
  gmail: { gmailOAuth2: { id: 'CREDENTIAL_ID', name: 'Gmail - Personal' } },
  pg: { postgres: { id: '__JOBS_PG_CRED_ID__', name: 'JobHunt DB (jobs_app)' } },
};

let x = 0;
const pos = () => [(x++) * 240, 0];
export function code(name, js, mode = 'runOnceForAllItems', extra = {}) {
  return { id: randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(), parameters: { mode, jsCode: js }, ...extra };
}
export function claudeHttp(name, bodyExpr = '$json.body') {
  return {
    id: randomUUID(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.3, position: pos(),
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput',
    parameters: {
      method: 'POST', url: 'https://api.anthropic.com/v1/messages',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'anthropicApi',
      sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
      options: { timeout: 120000 },
    },
    credentials: CRED.anthropic,
  };
}
export function pgQuery(name, query, params, extra = {}) {
  return {
    id: randomUUID(), name, type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: pos(),
    parameters: { operation: 'executeQuery', query, options: params ? { queryReplacement: params } : {} },
    credentials: CRED.pg, ...extra,
  };
}
export function webhook(name, path, method = 'POST', responseMode = 'lastNode') {
  return {
    id: randomUUID(), name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: pos(), webhookId: randomUUID(),
    parameters: { httpMethod: method, path, responseMode, options: {} },
  };
}
export function schedule(name, minutes) {
  return {
    id: randomUUID(), name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: pos(),
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } },
  };
}
// linear chain: chain(a,b,c) -> connections
export function chain(...nodes) {
  const c = {};
  for (let i = 0; i < nodes.length - 1; i++) c[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
  return c;
}
export const SETTINGS = { executionOrder: 'v1', timezone: 'Asia/Manila', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' };

// Create a temp webhook workflow, toggle-activate (stale webhook gotcha), call it, always delete it.
export async function runTemp(wf, path, payload, timeoutMs = 600000) {
  const created = await api('POST', '/api/v1/workflows', wf);
  try {
    await api('POST', `/api/v1/workflows/${created.id}/activate`);
    await api('POST', `/api/v1/workflows/${created.id}/deactivate`);
    await api('POST', `/api/v1/workflows/${created.id}/activate`);
    // Since n8n 2.44 the webhook registers a moment after activate (same fix as setup.mjs, 2026-10-23).
    await new Promise((ok) => setTimeout(ok, 3000));
    const r = await fetch(`${N8N}/webhook/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { status: r.status, raw: t.slice(0, 2000) }; }
  } finally {
    try { await api('POST', `/api/v1/workflows/${created.id}/deactivate`); } catch {}
    try { await api('DELETE', `/api/v1/workflows/${created.id}`); } catch (e) { console.error('WARN temp workflow not deleted', created.id); }
  }
}
