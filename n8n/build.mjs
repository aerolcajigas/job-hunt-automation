// Builds the "JobHunt / *" n8n workflows from src/ + prompts/, writes them to workflows/*.json.
//   node JobHunt/n8n/build.mjs            -> build only
//   node JobHunt/n8n/build.mjs --deploy   -> also create/update them in n8n (stays inactive unless --activate)
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { api, src, prompt, prompts, constsJs, code, claudeHttp, pgQuery, webhook, chain, SETTINGS, CRED } from './lib.mjs';

const secrets = JSON.parse(readFileSync(`${homedir()}/.jobhunt.json`, 'utf8'));
const PG_CRED_ID = secrets.pg_credential_id || '__JOBS_PG_CRED_ID__';
const SITE = 'https://portfolio.example.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const GET_JS = `const UA = ${JSON.stringify(UA)};
const get = async (url, o = {}) => {
  const r = await this.helpers.httpRequest({ url, method: o.method || 'GET', body: o.body, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(o.headers || {}) }, json: false, timeout: 30000 });
  return typeof r === 'string' ? r : JSON.stringify(r);
};
`;
const P = prompts();
const CLAUDE = constsJs(P) + src('claude-core.js');

function cron(name, expression) {
  return { id: randomUUID(), name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
    parameters: { rule: { interval: [{ field: 'cronExpression', expression }] } } };
}
function switchOn(name, keys) {
  return {
    id: randomUUID(), name, type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [0, 0],
    parameters: {
      mode: 'rules',
      rules: { values: keys.map((k) => ({
        conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: randomUUID(), leftValue: '={{ $json.route }}', rightValue: k, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and' },
        renameOutput: true, outputKey: k })) },
      options: {},
    },
  };
}
function layout(nodes) { nodes.forEach((n, i) => { n.position = [i * 260, (i % 2) * 40]; }); return nodes; }
function conn(map) {
  // map: { 'A': ['B'] , 'Switch': [['X'], ['Y']] }
  const c = {};
  for (const [from, to] of Object.entries(map)) {
    const outs = Array.isArray(to[0]) ? to : [to];
    c[from] = { main: outs.map((o) => o.map((n) => ({ node: n, type: 'main', index: 0 }))) };
  }
  return c;
}

// ---------- JobHunt / Fetch ----------
function wfFetch() {
  const trig = cron('Every hour', '20 * * * *');
  const fetchNode = code('Fetch Boards', GET_JS + src('fetch-core.js') + `
const hourManila = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false }).format(new Date())) % 24;
const { jobs, stats } = await fetchAllJobs(get, hourManila);
return [{ json: { jobs, stats, count: jobs.length } }];`);
  const insert = pgQuery('Insert Jobs', 'select jh_insert_jobs($1::jsonb) as inserted', '={{ [JSON.stringify($json.jobs)] }}');
  return { name: 'JobHunt / Fetch', nodes: layout([trig, fetchNode, insert]), connections: chain(trig, fetchNode, insert), settings: SETTINGS };
}

// ---------- JobHunt / Score ----------
function wfScore() {
  const trig = cron('Every 10 min', '*/10 * * * *');
  const settings = pgQuery('Settings', 'select jh_settings() as s', null, { executeOnce: true });
  const claim = pgQuery('Claim Jobs', 'select jh_claim_score(8) as job');
  const build = code('Details + Score Request', GET_JS + src('detail-core.js') + CLAUDE + `
const out = [];
for (const it of $input.all()) {
  const job = it.json.job;
  if (!job) continue;
  if ((job.description || '').length < 600) {
    try { Object.assign(job, await jobDetail(get, job)); } catch (e) { job.detail_error = String(e.message || e).slice(0, 200); }
  }
  out.push({ json: { job, body: scoreBody(job) } });
}
return out;`);
  const score = claudeHttp('Claude Score');
  const parse = code('Parse Score', CLAUDE + `
const built = $('Details + Score Request').all();
const settings = $('Settings').first().json.s;
return $input.all().map((it, i) => {
  const job = built[i].json.job;
  let s;
  try { s = claudeJson(it.json); } catch (e) { return { json: { route: 'error', id: job.id, err: String(e.message || e) } }; }
  const status = s.reject ? 'rejected' : (s.needs_from_user || []).length ? 'needs_info' : 'review';
  const save = { ...s, id: job.id, description: job.description, status, usage: [{ model: 'claude-haiku-4-5', usage: it.json.usage }] };
  // No automatic letters (the user 2026-10-07): he writes one per job with the dashboard's "Write cover letter" button.
  return { json: { route: 'save', save } };
});`);
  const sw = switchOn('Route', ['error', 'letter', 'save']);
  const unclaim = pgQuery('Unclaim', 'select jh_unclaim($1::bigint, $2)', '={{ [String($json.id), $json.err] }}');
  const letter = claudeHttp('Claude Letter');
  const parseLetter = code('Parse Letter', CLAUDE + `
const src = $('Route').all(1);
return $input.all().map((it, i) => {
  const save = { ...src[i].json.save };
  try {
    const l = claudeJson(it.json);
    save.letter_subject = noDashes(l.subject); save.letter = formatLetter(l.letter);
    save.usage = [...(save.usage || []), { model: 'claude-sonnet-5', usage: it.json.usage }];
  } catch (e) { save.score_error = 'letter failed: ' + String(e.message || e).slice(0, 200); }
  return { json: { save } };
});`);
  const saveNode = pgQuery('Save', 'select jh_save_score($1::jsonb) as r', '={{ [JSON.stringify($json.save)] }}');
  const nodes = layout([trig, settings, claim, build, score, parse, sw, unclaim, letter, parseLetter, saveNode]);
  return {
    name: 'JobHunt / Score', nodes, settings: SETTINGS,
    connections: conn({
      [trig.name]: [settings.name], [settings.name]: [claim.name], [claim.name]: [build.name], [build.name]: [score.name],
      [score.name]: [parse.name], [parse.name]: [sw.name], [sw.name]: [[unclaim.name], [letter.name], [saveNode.name]],
      [letter.name]: [parseLetter.name], [parseLetter.name]: [saveNode.name],
    }),
  };
}

// ---------- JobHunt / Send ----------
function wfSend() {
  const trig = cron('Every 20 min', '*/20 * * * *');
  const claim = pgQuery('Claim Emails', 'select jh_claim_send(2) as j');
  const dl = {
    id: randomUUID(), name: 'Download Resume', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.3, position: [0, 0],
    parameters: {
      url: `=${SITE}/resume/Your-Name-Resume-{{ $json.j.resume_variant === 'support' ? 'Support' : 'Automation' }}.pdf`,
      options: { response: { response: { responseFormat: 'file', outputPropertyName: 'resume' } } },
    },
  };
  const merge = code('Email Data', `
const c = $('Claim Emails').all();
return $input.all().map((it, i) => ({ json: c[i].json.j, binary: it.binary }));`);
  const gmail = {
    id: randomUUID(), name: 'Send Application', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [0, 0],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message', operation: 'send', sendTo: '={{ $json.to }}', subject: '={{ $json.subject }}',
      emailType: 'text', message: '={{ $json.letter }}',
      options: { appendAttribution: false, senderName: 'Your Name', attachmentsUi: { attachmentsBinary: [{ property: 'resume' }] } },
    },
    credentials: CRED.gmail,
  };
  const mark = code('Result', `
const d = $('Email Data').all();
return $input.all().map((it, i) => ({ json: { p: { id: d[i].json.id, to: d[i].json.to, thread_id: it.json.threadId || '', error: it.json.error ? JSON.stringify(it.json.error).slice(0, 300) : '' } } }));`);
  const save = pgQuery('Mark Sent', 'select jh_mark_sent($1::jsonb)', '={{ [JSON.stringify($json.p)] }}');
  return { name: 'JobHunt / Send', nodes: layout([trig, claim, dl, merge, gmail, mark, save]), connections: chain(trig, claim, dl, merge, gmail, mark, save), settings: SETTINGS };
}

// ---------- JobHunt / Gmail Watch ----------
// No Claude here since 2026-10-14 (the user: no automatic API spend): new emails go into email_queue and a local
// worker on my PC reads them with Claude Code.
function wfGmail() {
  const trig = cron('Every 15 min', '*/15 * * * *');
  const q = 'newer_than:2d -from:me -in:sent -in:chats (from:(linkedin.com OR indeed.com OR jobstreet.com OR onlinejobs.ph OR glassdoor.com OR seek.com.au) OR subject:(interview OR application OR applied OR applying OR assessment OR offer OR position OR candidate OR candidacy OR role OR opportunity OR hiring))';
  const gmail = {
    id: randomUUID(), name: 'Recent Emails', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [0, 0],
    alwaysOutputData: false,
    parameters: { operation: 'getAll', limit: 40, simple: false, filters: { q }, options: {} },
    credentials: CRED.gmail,
  };
  const ids = code('Collect Ids', `return [{ json: { arr: '{' + $input.all().map((m) => m.json.id).filter(Boolean).join(',') + '}' } }];`);
  const seen = pgQuery('Only New', 'select jh_new_messages($1::text[]) as ids', '={{ [$json.arr] }}');
  const build = code('Emails For PC', `
const fresh = new Set($input.first().json.ids || []);
const toText = (m) => {
  let t = m.text || '';
  if (!t || t.length < 200) {
    t = String(m.html || '').replace(/<a [^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/gi, (x, h, l) => ' ' + l.replace(/<[^>]+>/g, ' ') + ' (' + h + ') ')
      .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\\s+/g, ' ');
  }
  return t.slice(0, 20000);
};
const emails = $('Recent Emails').all().filter((m) => fresh.has(m.json.id)).map((m) => {
  const e = m.json;
  const from = (e.from && (e.from.text || (e.from.value || []).map((v) => v.address).join(','))) || '';
  return { id: e.id, thread_id: e.threadId, from, subject: e.subject || '', text: toText(e) };
});
return emails.length ? [{ json: { emails } }] : [];`);
  const queue = pgQuery('Queue For PC', 'select jh_queue_emails($1::jsonb) as queued', '={{ [JSON.stringify($json.emails)] }}');
  return {
    name: 'JobHunt / Gmail Watch', nodes: layout([trig, gmail, ids, seen, build, queue]), settings: SETTINGS,
    connections: chain(trig, gmail, ids, seen, build, queue),
  };
}

// ---------- JobHunt / API ----------
function wfApi() {
  const wh = webhook('Dashboard API', 'jobhunt-api');
  const auth = code('Check Key', `
const it = $input.first().json;
if ((it.headers || {})['x-jobhunt-key'] !== ${JSON.stringify(secrets.api_secret)}) throw new Error('unauthorized');
const b = it.body || {};
// nginx's /api/login (the only route open without the PIN cookie) sets this header: it may only try a PIN.
if ((it.headers || {})['x-jobhunt-login'] === '1') return [{ json: { action: 'login', p: JSON.stringify({ pin: String((b.p || {}).pin || '').slice(0, 12) }) } }];
return [{ json: { action: String(b.action || ''), p: JSON.stringify(b.p || {}) } }];`);
  const q = pgQuery('Run Action', 'select jh_api($1, $2::jsonb) as r', '={{ [$json.action, $json.p] }}');
  const iff = {
    id: randomUUID(), name: 'Needs Letter?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [0, 0],
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: randomUUID(), leftValue: '={{ !!($json.r && $json.r.letter_job) }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and' }, options: {} },
  };
  const build = code('Letter Request', GET_JS + src('detail-core.js') + CLAUDE + `
const r = $input.first().json.r;
const j = r.letter_job;
// No AI screening since 2026-10-07, so LinkedIn etc. arrive without the post text: fetch it before writing.
let fetched = '';
if ((j.description || '').length < 600) {
  try { const d = await jobDetail(get, j); if (d.description && d.description.length > (j.description || '').length) fetched = j.description = d.description; } catch (e) {}
}
const s = { category: j.category || 'not screened', required_phrase: j.required_phrase, apply_method: j.apply_method || 'site', notes: j.score_notes || '' };
const revamp = r.feedback ? { previous: (j.letter_subject ? 'Subject: ' + j.letter_subject + '\\n\\n' : '') + (j.letter || ''), feedback: r.feedback } : null;
return [{ json: { id: j.id, description: fetched, body: letterBody(j, s, j.answers, r.style_notes, revamp) } }];`);
  const claude = claudeHttp('Claude Letter');
  const parse = code('Parse Letter', CLAUDE + `
const { id, description } = $('Letter Request').first().json;
try {
  const l = claudeJson($input.first().json);
  return [{ json: { action: 'save_letter', p: JSON.stringify({ id, description, subject: noDashes(l.subject), letter: formatLetter(l.letter), usage: [{ model: 'claude-sonnet-5', usage: $input.first().json.usage }] }) } }];
} catch (e) { return [{ json: { action: 'letter_failed', p: JSON.stringify({ id, error: String(e.message || e) }) } }]; }`);
  const save = pgQuery('Save Letter', 'select jh_api($1, $2::jsonb) as r', '={{ [$json.action, $json.p] }}');
  const reply = code('Reply', 'return $input.all();');
  // Dashboard popup: fetch the full job post when only a snippet is stored (action fetch_detail -> save_detail).
  const iffDet = { ...iff, id: randomUUID(), name: 'Needs Detail?', parameters: JSON.parse(JSON.stringify(iff.parameters).replace('$json.r.letter_job', '$json.r.detail_job')) };
  iffDet.parameters.conditions.conditions[0].id = randomUUID();
  const detFetch = code('Fetch Detail', GET_JS + src('detail-core.js') + `
const j = $input.first().json.r.detail_job;
let description = '';
try { description = (await jobDetail(get, j)).description || ''; } catch (e) {}
return [{ json: { action: 'save_detail', p: JSON.stringify({ id: j.id, description }) } }];`);
  const detSave = pgQuery('Save Detail', 'select jh_api($1, $2::jsonb) as r', '={{ [$json.action, $json.p] }}');
  const nodes = layout([wh, auth, q, iff, build, claude, parse, save, reply, iffDet, detFetch, detSave]);
  return {
    name: 'JobHunt / API', nodes, settings: { ...SETTINGS, saveDataErrorExecution: 'all' },
    connections: conn({ [wh.name]: [auth.name], [auth.name]: [q.name], [q.name]: [iff.name], [iff.name]: [[build.name], [iffDet.name]],
      [build.name]: [claude.name], [claude.name]: [parse.name], [parse.name]: [save.name],
      [iffDet.name]: [[detFetch.name], [reply.name]], [detFetch.name]: [detSave.name] }),
  };
}

// ---------- JobHunt / Portfolio Chat ----------
// 2026-10-16 (the user): AI chat on portfolio.example.com for employers. nginx /api/chat -> this webhook. Claude Haiku 5.5
// answers from prompts/portfolio-chat.md + the claim bank; unsafe/unrelated/unclear/unanswerable/rates/contact = escalate:
// the reply gives his email and he gets the transcript by email (1 per chat, CHAT.emailsPerDay per day). Only counters are
// stored (db/011), never chat text.
const CHAT = { model: 'claude-haiku-5-5', perChat: 20, perIp: 40, perDay: 400, emailsPerDay: 10, email: 'you@example.com',
  reportTo: 'you@example.com' }; // daily report inbox (the user 2026-10-16); escalations still go to `email`
function wfChat() {
  // the claim bank without HOOKS (those only map projects to job posts for letters)
  const facts = prompt('candidate.md').replace(/\nHOOKS[\s\S]*?(?=\nNOT TRUE)/, '\n');
  const system = prompt('portfolio-chat.md').replace('{{CANDIDATE}}', facts);
  const wh = webhook('Chat Webhook', 'jobhunt-portfolio-chat', 'POST', 'responseNode');
  const clean = code('Clean', `
const it = $input.first().json, h = it.headers || {}, b = it.body || {};
if (h['x-jobhunt-key'] !== ${JSON.stringify(secrets.api_secret)}) throw new Error('unauthorized');
const sid = String(b.sid || '').replace(/[^\\w-]/g, '').slice(0, 64);
if (sid.length < 8) throw new Error('bad sid');
// last 16 turns, user first, roles alternating, each turn capped
const msgs = [];
for (const m of (Array.isArray(b.messages) ? b.messages : []).slice(-16)) {
  const role = m && m.role === 'assistant' ? 'assistant' : 'user';
  const content = String((m && m.content) || '').trim().slice(0, 1000);
  if (!content) continue;
  if (!msgs.length && role === 'assistant') continue;
  if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\\n' + content;
  else msgs.push({ role, content });
}
if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new Error('no question');
const ip = String(h['x-chat-ip'] || '').slice(0, 64);
// my own tests stay out of the daily report: browser marked via /?me, or our test scripts
const tester = b.me === true || ip === 'test' || /^(test|live-check)-/.test(sid);
return [{ json: { sid, ip, tester, messages: msgs } }];`);
  const count = pgQuery('Count', 'select jh_chat_hit($1, $2, $3::boolean) as c', '={{ [$json.sid, $json.ip, String($json.tester)] }}');
  const gate = code('Gate', `
const { sid, ip, messages } = $('Clean').first().json, c = $input.first().json.c;
const mail = ${JSON.stringify(CHAT.email)};
let reply = '';
if (c.all > ${CHAT.perDay}) reply = 'The chat is taking a break for today. You can reach the user directly at ' + mail + '.';
else if (c.sid > ${CHAT.perChat} || c.ip > ${CHAT.perIp}) reply = "That's the chat limit for today. For anything else, the user reads his email: " + mail + '.';
const body = { model: ${JSON.stringify(CHAT.model)}, max_tokens: 1024, output_config: { effort: 'low' }, system: ${JSON.stringify(system)}, messages };
return [{ json: { sid, ip, messages, reply, ask: !reply, body } }];`);
  const askIf = {
    id: randomUUID(), name: 'Ask Claude?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [0, 0],
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: randomUUID(), leftValue: '={{ $json.ask }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and' }, options: {} },
  };
  const claude = claudeHttp('Claude Chat');
  const parse = code('Parse Reply', `
const r = $input.first().json, g = $('Gate').first().json, mail = ${JSON.stringify(CHAT.email)};
let text = '', reason = '';
if (r.stop_reason === 'refusal' || r.error || !Array.isArray(r.content)) reason = r.stop_reason === 'refusal' ? 'model refused' : 'chat error';
else text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n').trim();
const m = text.match(/\\[\\[\\s*ESCALATE:?\\s*([^\\]]*)\\]\\]/i);
if (m) reason = m[1].trim() || 'escalated';
text = text.replace(/\\[\\[[^\\]]*\\]\\]/g, '').replace(/\\*\\*|^#+\\s*/gm, '').replace(/\\s*[\\u2014\\u2013]\\s*/g, ', ').replace(/,\\s*,/g, ',').trim();
if (!text) text = "I couldn't answer that one here. the user can, though: " + mail + '.';
else if (reason && !text.includes(mail)) text += '\\n\\nYou can reach the user at ' + mail + '.';
const when = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });
const transcript = g.messages.map((x) => (x.role === 'user' ? 'Visitor: ' : 'Assistant: ') + x.content).join('\\n\\n') + '\\n\\nAssistant: ' + text;
return [{ json: { reply: text, escalate: !!reason, reason: reason.slice(0, 80), sid: g.sid,
  mail: 'Why: ' + reason + '\\nWhen (Manila): ' + when + '\\nIP: ' + (g.ip || 'unknown') + '\\n\\n' + transcript } }];`);
  const respond = {
    id: randomUUID(), name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0],
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ reply: $json.reply }) }}', options: {} },
  };
  const escIf = { ...askIf, id: randomUUID(), name: 'Escalated?', parameters: JSON.parse(JSON.stringify(askIf.parameters).replace('$json.ask', '$json.escalate')) };
  escIf.parameters.conditions.conditions[0].id = randomUUID();
  const may = pgQuery('May Email', 'select jh_chat_escalate($1, $2) as ok', `={{ [$json.sid, ${CHAT.emailsPerDay}] }}`);
  const sendIf = { ...askIf, id: randomUUID(), name: 'Send Email?', parameters: JSON.parse(JSON.stringify(askIf.parameters).replace('$json.ask', '$json.ok')) };
  sendIf.parameters.conditions.conditions[0].id = randomUUID();
  const gmail = {
    id: randomUUID(), name: 'Email the user', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [0, 0],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message', operation: 'send', sendTo: CHAT.email,
      subject: "={{ 'Portfolio chat: ' + $('Parse Reply').first().json.reason }}",
      emailType: 'text', message: "={{ $('Parse Reply').first().json.mail }}",
      options: { appendAttribution: false, senderName: 'Portfolio chat' },
    },
    credentials: CRED.gmail,
  };
  const nodes = layout([wh, clean, count, gate, askIf, claude, parse, respond, escIf, may, sendIf, gmail]);
  return {
    name: 'JobHunt / Portfolio Chat', nodes, settings: SETTINGS,
    connections: conn({ [wh.name]: [clean.name], [clean.name]: [count.name], [count.name]: [gate.name], [gate.name]: [askIf.name],
      [askIf.name]: [[claude.name], [respond.name]], [claude.name]: [parse.name], [parse.name]: [respond.name],
      [respond.name]: [escIf.name], [escIf.name]: [may.name], [may.name]: [sendIf.name], [sendIf.name]: [gmail.name] }),
  };
}

// ---------- JobHunt / Chat Report ----------
// 2026-10-16 (the user): daily email at 8:00 Manila with yesterday's portfolio chat usage, his own tests left out (db/012).
function wfChatReport() {
  const trig = cron('Daily 8:00', '0 8 * * *');
  const q = pgQuery('Report', 'select jh_chat_report() as r');
  const build = code('Build Email', `
const r = $input.first().json.r;
const fmt = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const lines = [];
if (!r.chats) lines.push('Nobody used the chat on ' + fmt(r.day) + '.');
else lines.push(fmt(r.day) + ': ' + plural(r.chats, 'chat') + ' from ' + plural(r.visitors, 'visitor') + ', ' + plural(r.msgs, 'message') + ', ' + r.escalated + ' escalated to you.');
lines.push('', 'Last 7 days:');
for (const d of r.week) lines.push('  ' + fmt(d.day) + '   ' + plural(Number(d.chats), 'chat') + ', ' + plural(Number(d.msgs), 'message'));
const total = r.week.reduce((s, d) => s + Number(d.chats), 0);
lines.push('  Total: ' + plural(total, 'chat'));
lines.push('', 'Your own tests left out: ' + plural(r.mine, 'chat') + '.');
lines.push('', 'Escalated chats arrive as separate "Portfolio chat:" emails with the transcript. Chat text is not stored.');
return [{ json: { subject: 'Portfolio chat report: ' + (r.chats ? plural(r.chats, 'chat') : 'no chats') + ' on ' + fmt(r.day), text: lines.join('\\n') } }];`);
  const gmail = {
    id: randomUUID(), name: 'Email Report', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [0, 0],
    parameters: { resource: 'message', operation: 'send', sendTo: CHAT.reportTo, subject: '={{ $json.subject }}', emailType: 'text', message: '={{ $json.text }}',
      options: { appendAttribution: false, senderName: 'Portfolio chat' } },
    credentials: CRED.gmail,
  };
  return { name: 'JobHunt / Chat Report', nodes: layout([trig, q, build, gmail]), connections: chain(trig, q, build, gmail), settings: SETTINGS };
}

// wfScore() (Claude Haiku screening) retired 2026-10-07 by the user: every code-filtered job is a lead. The live
// "JobHunt / Score" workflow is deactivated, not deleted; add wfScore() back here to revive it.
const wfs = [wfFetch(), wfSend(), wfGmail(), wfApi(), wfChat(), wfChatReport()];
for (const wf of wfs) for (const n of wf.nodes) if (n.credentials && n.credentials.postgres) n.credentials.postgres.id = PG_CRED_ID;
mkdirSync(new URL('./workflows/', import.meta.url), { recursive: true });
for (const wf of wfs) {
  const file = wf.name.replace('JobHunt / ', '').toLowerCase().replace(/\W+/g, '-') + '.json';
  // the API workflow holds the dashboard key: keep it out of the repo copy
  const copy = JSON.parse(JSON.stringify(wf).split(secrets.api_secret).join('__API_SECRET__'));
  writeFileSync(new URL(`./workflows/${file}`, import.meta.url), JSON.stringify(copy, null, 1));
}
console.log('built', wfs.map((w) => w.name).join(', '));

if (process.argv.includes('--deploy')) {
  if (PG_CRED_ID.startsWith('__')) throw new Error('No pg_credential_id in ~/.jobhunt.json yet');
  const list = (await api('GET', '/api/v1/workflows?limit=250')).data;
  for (const wf of wfs) {
    const old = list.find((w) => w.name === wf.name);
    const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
    const res = old ? await api('PUT', `/api/v1/workflows/${old.id}`, body) : await api('POST', '/api/v1/workflows', body);
    console.log(old ? 'updated' : 'created', wf.name, res.id);
    if (process.argv.includes('--activate')) {
      try { await api('POST', `/api/v1/workflows/${res.id}/deactivate`); } catch {}
      await api('POST', `/api/v1/workflows/${res.id}/activate`);
      console.log('  active');
    }
  }
}
