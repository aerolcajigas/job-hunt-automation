// Claude request bodies for scoring (Haiku 4.5) and letters (Sonnet 5). SCORE_SYSTEM / LETTER_SYSTEM are injected
// by build.mjs from JobHunt/prompts/*.md.

const SCORE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    category: { type: 'string', enum: ['automation', 'support', 'other'] },
    reject: { type: 'boolean' },
    reject_reason: { type: 'string' },
    fit_score: { type: 'integer' },
    priority: { type: 'string', enum: ['high', 'normal', 'low'] },
    rate_usd_hr: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    employer_region: { type: 'string' },
    apply_email: { type: 'string' },
    apply_method: { type: 'string', enum: ['email', 'site'] },
    required_phrase: { type: 'string' },
    needs_from_user: { type: 'array', items: { type: 'string' } },
    resume_variant: { type: 'string', enum: ['automation', 'support'] },
    notes: { type: 'string' },
  },
  required: ['category', 'reject', 'reject_reason', 'fit_score', 'priority', 'rate_usd_hr', 'employer_region',
    'apply_email', 'apply_method', 'required_phrase', 'needs_from_user', 'resume_variant', 'notes'],
};

const LETTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { subject: { type: 'string' }, letter: { type: 'string' } },
  required: ['subject', 'letter'],
};

function jobText(job) {
  return [
    `Title: ${job.title}`, `Company: ${job.company || 'not stated'}`, `Source: ${job.source}`,
    `Location: ${job.location || 'not stated'}`, `Employment type: ${job.employment_type || 'not stated'}`,
    `Pay as posted: ${job.salary_text || 'not stated'}`, `URL: ${job.url}`, '', 'Post:', job.description || '(no description)',
  ].join('\n');
}

function scoreBody(job) {
  return {
    model: 'claude-haiku-4-5', max_tokens: 1200, system: SCORE_SYSTEM, cache_control: { type: 'ephemeral' },
    messages: [{ role: 'user', content: jobText(job) }],
    output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA } },
  };
}

// styleNotes = settings.style_notes (my accumulated feedback from the review queue).
function letterBody(job, s, answers, styleNotes, revamp) {
  const extra = [
    `lane: ${s.category}`, `required_phrase: ${s.required_phrase || ''}`,
    `apply_method: ${s.apply_method}`, `screening notes: ${s.notes}`,
    answers ? `my answers to the post's questions (use them):\n${answers}` : '',
    revamp ? `the user reviewed the previous draft and asked for changes. Previous draft:\n${revamp.previous}\n\nHis feedback (apply it):\n${revamp.feedback}` : '',
  ].filter(Boolean).join('\n');
  return {
    model: 'claude-sonnet-5', max_tokens: 4000, cache_control: { type: 'ephemeral' },
    system: LETTER_SYSTEM.replace('{{STYLE_NOTES}}', (styleNotes || '').trim() || '(none yet)'),
    messages: [{ role: 'user', content: `${jobText(job)}\n\n---\n${extra}` }],
    output_config: { format: { type: 'json_schema', schema: LETTER_SCHEMA } },
  };
}

// Reads the JSON object out of a Messages API response (structured output = one text block).
function claudeJson(resp) {
  if (!resp || resp.error) throw new Error('Claude error: ' + JSON.stringify(resp && resp.error).slice(0, 300));
  if (resp.stop_reason === 'refusal') throw new Error('Claude refused');
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// Em/en dashes are banned in anything sent as the user.
const noDashes = (s) => String(s || '').replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');

// my letter layout (2026-10-14), enforced after Claude: opening sentence (ending "I can help you with this
// immediately.") on its own, body, then "You can learn more about me here: portfolio.example.com" /
// "I can start immediately." / "Cheers!" + "the user" as separate paragraphs. The old "If you're looking for someone
// who ..." closer is dropped.
const PORTFOLIO_LINE = 'You can learn more about me here: portfolio.example.com';
function formatLetter(s) {
  let t = noDashes(s).replace(/\r/g, '').trim();
  // strip any sign-off, re-added below
  t = t.replace(/\s*Cheers!?\s*,?\s*(the user( John Name)?)?\s*$/i, '').trim();
  // old-style closer and canned tails
  t = t.replace(/\s*If you'?re looking for someone[\s\S]*?[.!](?=\s|$)/gi, ' ');
  t = t.replace(/,?\s*(then\s+)?(that'?s (me|where I('d| would)? ?fit|what I do|exactly what I do)|I'?m (your|the) (guy|person|one))\s*[.!]/gi, '.');
  // closer and portfolio line are re-added in fixed spots
  t = t.replace(/\s*I can start immediately\.?/gi, ' ');
  t = t.replace(/\s*You can (see my work|learn more about me) here:?\s*(https?:\/\/)?portfolio\.example\.com\/?\.?/gi, ' ');
  let paras = t.split(/\n\s*\n/).map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  // opening sentence on its own
  const m = paras[0] && paras[0].match(/^(.*?I can help you with this immediately\.)\s*(.*)$/is);
  if (m && m[2]) paras.splice(0, 1, m[1], m[2]);
  return [...paras, PORTFOLIO_LINE, 'I can start immediately.', 'Cheers!\nYour Name'].join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
