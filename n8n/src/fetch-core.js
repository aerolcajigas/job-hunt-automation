// Job board readers. Shared by the n8n Code node ("Jobs / Fetch") and local tests (test-fetch.mjs).
// get(url) must resolve to the response body as a string.
// Sources the user named: OnlineJobs.ph, LinkedIn (public guest search, no login), JobStreet PH (search JSON),
// Indeed (alert emails only, see gmail-watch: every Indeed page answers scripts with a 403 bot check).
// Extra free remote boards with western clients: Himalayas, Jobicy, Remotive, RemoteOK, WWR.

const KEYWORDS = {
  automation: ['n8n', 'automation specialist', 'AI automation', 'zapier', 'make.com', 'workflow automation', 'AI agent developer', 'gohighlevel automation'],
  support: ['technical support', 'SaaS support', 'customer success', 'support engineer', 'implementation specialist', 'onboarding specialist', 'support operations', 'zendesk'],
};

// Title must look like one of our two lanes, or it never reaches Claude.
const TITLE_OK = /(automat|n8n|zapier|make\.com|integromat|workflow|\bai\b|agent|chatbot|llm|gpt|prompt|no[- ]?code|low[- ]?code|integration|support|success|help ?desk|service desk|customer (experience|care|service)|\bcx\b|implementation|onboarding|solutions? (engineer|specialist|consultant)|zendesk|intercom|gorgias|freshdesk|hubspot|crm|gohighlevel|\bghl\b|operations|ops\b|technical)/i;
const TITLE_BAD = /(sales development|\bsdr\b|\bbdr\b|account executive|cold call|appointment setter|telemarket|nurse|medical|dental|accountant|bookkeep|graphic design|video edit|seo\b|ppc|social media manager|content writer|copywriter|recruit|tagalog|bilingual|spanish|german|french|japanese|korean|portuguese|italian|dutch|mandarin|cantonese|danish|swedish|norwegian|finnish|polish|czech|hungarian|romanian|greek|turkish|russian|ukrainian|hebrew|arabic|thai|vietnamese|indonesian|hindi|speaking|dynamics|\.net|\bjava\b|php|ruby|golang|\bios\b|android|salesforce developer|director|vice president|\bvp\b|head of|principal|staff engineer|senior software engineer|devops|data scientist|security engineer|frontend|backend|full[- ]?stack)/i;

const strip = (h) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&#8230;|&hellip;/g, '...').replace(/&#\d+;/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keep(j) {
  if (!j.url || !j.title) return false;
  // n8n forum posts are all n8n work but titled anything ("Help Needed: ..."), so only the bad-title list applies.
  if ((j.source !== 'n8nforum' && !TITLE_OK.test(j.title)) || TITLE_BAD.test(j.title)) return false;
  // The forum also carries unpaid "partner" asks and posts in other languages.
  if (j.source === 'n8nforum' && /\b(revenue share|rev share|equity only|commission only|unpaid|sales partner|lead generation)\b|[¿ñáéíóú]/i.test(j.title)
      && !/\$\d/.test(j.title)) return false;
  // ...and freelancers advertising themselves ("[For Hire]", "[Available]"), co-founder hunts, free pilots.
  if (j.source === 'n8nforum' && /\b(for hire|available|co-?founder|free pilot|no active project)\b/i.test(j.title)) return false;
  // Mercor is mostly expert AI-training work; its titles pass TITLE_OK through "AI" even for doctors and lawyers.
  if (j.source === 'mercor' && /clinical|physician|radiolog|psychiatr|therap|lawyer|attorney|legal|pharmac|\bphd\b|doctor|dentist|surgeon|voice actor|chemist|biolog|financ|sales|mental health|behavioral/i.test(j.title)) return false;
  return true;
}

// The original screening rules (prompts/score.md), as code since the Haiku screen was dropped (2026-10-07).
// Checks the location field and whatever post text we have. Returns a reject reason, or null = lead.
const OPEN_LOC = /philippines|\bph\b|worldwide|anywhere|global|international|apac|asia|southeast|remote$|^remote \(|^remote$|^$/i;
const LOCKED_LOC = /united states|\busa?\b|\bu\.s\.|canada|united kingdom|\buk\b|england|scotland|ireland|europe|\beu\b|emea|germany|france|spain|netherlands|poland|portugal|italy|australia|new zealand|latam|latin america|americas|mexico|brazil|argentina|colombia|south africa|singapore|japan|, [A-Z]{2}$/i;
const RULES = [
  ['on-site or hybrid', /\b(hybrid (work|schedule|set ?up|arrangement|model|working|office)|(this|the) (role|position|job) is (on[- ]?site|in[- ]office)|on[- ]?site (role|position|work|only|job)|work(ing)? (on[- ]?site|from (the|our) office)|office[- ]based|report(ing)? to (the|our) office|\d+ days? (a|per) week in (the |our )?office|must (be able to )?commute|in[- ]office (role|position|only))\b/i],
  ['country locked', /\b((us|u\.s\.|usa|united states|uk|canada|canadian|eu|european|australian?) (citizens?|residents?)( only)?\b|(must|need to|required to|should) (be |currently )?(reside|live|be located|be based|be residing|be a resident) in (the )?(us|u\.s\.|usa|united states|uk|united kingdom|canada|europe|eu|australia|latam|latin america|mexico|colombia|brazil|south africa)|(legally )?(authori[sz]ed|eligible) to work in (the )?(us|u\.s\.|usa|united states|uk|united kingdom|canada|eu|europe|australia)|w-?2 (only|employee|position|role)|\b(us|usa|uk|canada|latam|europe|emea)[- ]only\b|security clearance|green card|u\.?s\.? citizenship)/i],
  ['needs another language', /\b(fluen(t|cy)|native|proficien\w*|bilingual|speak\w*|written and spoken)\s+(in\s+)?(both\s+)?(english\s+(and|&)\s+)?(spanish|german|french|japanese|korean|portuguese|italian|dutch|mandarin|cantonese|chinese|danish|swedish|norwegian|finnish|polish|czech|hungarian|romanian|greek|turkish|russian|ukrainian|hebrew|arabic|thai|vietnamese|indonesian|hindi|malay)\b|\b(spanish|german|french|japanese|korean|portuguese|italian|dutch|mandarin|cantonese|arabic|hebrew)[- ](speaking|speaker|fluency|is required|required|proficiency)\b/i],
  ['scam signs', /\b(training fee|registration fee|starter (kit|fee)|application fee|pay (a |an |the )?(small |one[- ]time )?(upfront |onboarding |training |processing )?fee (to|before)|telegram only|contact (us|me) (on|via) telegram|whatsapp only|crypto (payment|trading|investment)|send (us )?(money|a deposit))\b/i],
  ['too senior', /\b((8|9|10|12|15)\+?\s*(years|yrs))\b[^.\n]{0,40}\bexperience\b/i], // Director/VP/Head of/Principal: TITLE_BAD
];
function screen(j) {
  const loc = String(j.location || '').trim();
  // LinkedIn puts the hiring country/city in the location field: a non-PH country = locked.
  if (j.source === 'linkedin' && !OPEN_LOC.test(loc) && LOCKED_LOC.test(loc)) return `location: ${loc}`;
  // Himalayas / Remotive / WWR / Wellfound / Arc / Mercor list the allowed countries outright: anything without
  // PH / worldwide / Asia = locked.
  if (['himalayas', 'remotive', 'wwr', 'wellfound', 'arc', 'mercor'].includes(j.source) && !OPEN_LOC.test(loc)) return `location: ${loc}`;
  // ...and their titles often end in the real region ("Customer Success Manager, EMEA") while the field says Anywhere.
  const tLoc = (String(j.title).match(/[,(–-]\s*([^,()–-]+?)\)?\s*$/) || [])[1];
  if (['remotive', 'wwr'].includes(j.source) && tLoc && LOCKED_LOC.test(tLoc) && !OPEN_LOC.test(tLoc)) return `location: ${tLoc}`;
  if (/hybrid|on-?site/i.test(loc)) return `location: ${loc}`;
  const text = `${j.title}\n${j.description || ''}`;
  for (const [why, re] of RULES) {
    const m = text.match(re);
    if (m) return `${why}: "${m[0].trim().slice(0, 60)}"`;
  }
  return null;
}

async function olj(get) {
  const out = [];
  for (const kw of [...KEYWORDS.automation, ...KEYWORDS.support]) {
    const html = await get(`https://www.onlinejobs.ph/jobseekers/jobsearch?jobkeyword=${encodeURIComponent(kw)}&fullTime=on&partTime=on&Freelance=on`);
    for (const block of html.split('<!-- Start -->').slice(1)) {
      const href = block.match(/href="(\/jobseekers\/job\/[^"]+)"/);
      if (!href) continue;
      const title = strip((block.match(/<h4[^>]*>([\s\S]*?)<span/) || block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/) || [])[1]);
      const type = strip((block.match(/<span class="badge[^"]*">([^<]+)<\/span>/) || [])[1]);
      out.push({
        source: 'onlinejobs', source_id: (href[1].match(/-(\d+)$/) || [])[1] || null,
        url: 'https://www.onlinejobs.ph' + href[1], title,
        company: strip((block.match(/class="jobpost-cat-box-logo" alt="([^"]*)"/) || [])[1]) || null,
        location: 'Remote (OnlineJobs.ph)',
        salary_text: strip((block.match(/<dd class="col">([\s\S]*?)<\/dd>/) || [])[1]) || null,
        employment_type: type ? type.toLowerCase().replace(' ', '-') : null,
        posted_at: (block.match(/data-temp-2="([^"]+)"/) || [])[1] ? block.match(/data-temp-2="([^"]+)"/)[1].replace(' ', 'T') + 'Z' : null,
        description: strip((block.match(/<div class="desc[^"]*">([\s\S]*?)<a href/) || [])[1]),
        search_term: kw,
      });
    }
    await sleep(800);
  }
  return out;
}

async function linkedin(get) {
  const out = [];
  const terms = [...KEYWORDS.automation.slice(0, 6), ...KEYWORDS.support.slice(0, 6)];
  for (const loc of ['Philippines', 'Worldwide']) {
    for (const kw of terms) {
      // f_WT=2 remote, f_TPR=r86400 posted in the last 24h. Public endpoint, no login, my account is never used.
      const html = await get(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=${loc}&f_WT=2&f_TPR=r86400&start=0`);
      for (const li of html.split('<li>').slice(1)) {
        const id = (li.match(/urn:li:jobPosting:(\d+)/) || [])[1];
        if (!id) continue;
        out.push({
          source: 'linkedin', source_id: id, url: `https://www.linkedin.com/jobs/view/${id}`,
          title: strip((li.match(/base-search-card__title">([\s\S]*?)<\/h3>/) || [])[1]),
          company: strip((li.match(/base-search-card__subtitle">([\s\S]*?)<\/h4>/) || [])[1]),
          location: strip((li.match(/job-search-card__location">([\s\S]*?)<\/span>/) || [])[1]),
          salary_text: strip((li.match(/job-search-card__salary-info">([\s\S]*?)<\/span>/) || [])[1]) || null,
          posted_at: (li.match(/datetime="([^"]+)"/) || [])[1] || null,
          search_term: `${kw} @ ${loc}`,
        });
      }
      await sleep(1500);
    }
  }
  return out;
}

// JobStreet PH (the user 2026-10-07): the site's own search JSON, remote only (workArrangement=3), last 3 days.
// The job pages sit behind Cloudflare; the full post comes from their GraphQL in detail-core.js.
async function jobstreet(get) {
  const out = [];
  for (const kw of [...KEYWORDS.automation, ...KEYWORDS.support]) {
    const data = JSON.parse(await get(`https://ph.jobstreet.com/api/jobsearch/v5/search?siteKey=PH-Main&sourcesystem=houston&locale=en-PH&workArrangement=3&daterange=3&pageSize=30&page=1&keywords=${encodeURIComponent(kw)}`));
    for (const j of data.data || []) {
      const where = (j.locations || []).map((l) => l.label).filter(Boolean).join(', ');
      out.push({
        source: 'jobstreet', source_id: String(j.id), url: `https://ph.jobstreet.com/job/${j.id}`, title: j.title,
        company: j.companyName || (j.advertiser || {}).description || null,
        location: `Remote (JobStreet${where ? ', ' + where : ''})`, salary_text: j.salaryLabel || null,
        employment_type: (j.workTypes || [])[0] ? String(j.workTypes[0]).toLowerCase().replace(' ', '-') : null,
        posted_at: j.listingDate || null,
        description: [j.teaser, ...(j.bulletPoints || [])].filter(Boolean).join('\n'), search_term: kw,
      });
    }
    await sleep(700);
  }
  return out;
}

async function himalayas(get) {
  const out = [];
  for (const q of ['automation', 'n8n', 'technical support', 'customer success', 'support engineer', 'implementation']) {
    const data = JSON.parse(await get(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}&limit=20`));
    for (const j of data.jobs || []) {
      const locs = (j.locationRestrictions || []).map((l) => (typeof l === 'string' ? l : l.name || l.alpha2 || '')).join(', ');
      out.push({
        source: 'himalayas', source_id: j.guid || j.applicationLink, url: j.applicationLink || j.guid,
        title: j.title, company: j.companyName, location: locs || 'Worldwide',
        salary_text: j.minSalary ? `${j.currency || 'USD'} ${j.minSalary}-${j.maxSalary || ''} ${j.salaryPeriod || ''}`.trim() : null,
        employment_type: (j.employmentType || '').toLowerCase().replace(' ', '-') || null,
        posted_at: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
        description: clip(strip(j.description), 12000), search_term: q,
      });
    }
    await sleep(500);
  }
  return out;
}

async function jobicy(get) {
  const out = [];
  for (const tag of ['automation', 'support', 'customer success']) {
    const data = JSON.parse(await get(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${encodeURIComponent(tag)}`));
    for (const j of data.jobs || []) {
      out.push({
        source: 'jobicy', source_id: String(j.id), url: j.url, title: strip(j.jobTitle), company: j.companyName,
        location: j.jobGeo, employment_type: (j.jobType || [])[0] ? String(j.jobType[0]).toLowerCase() : null,
        salary_text: j.annualSalaryMin ? `${j.salaryCurrency || 'USD'} ${j.annualSalaryMin}-${j.annualSalaryMax || ''} yearly` : null,
        posted_at: j.pubDate || null,
        description: clip(strip(j.jobDescription), 12000), search_term: tag,
      });
    }
  }
  return out;
}

async function remotive(get) {
  const out = [];
  for (const q of ['automation', 'n8n', 'technical support', 'customer success']) {
    const data = JSON.parse(await get(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=40`));
    for (const j of data.jobs || []) {
      out.push({
        source: 'remotive', source_id: String(j.id), url: j.url, title: j.title, company: j.company_name,
        location: j.candidate_required_location, salary_text: j.salary || null,
        employment_type: (j.job_type || '').replace('_', '-') || null, posted_at: j.publication_date ? j.publication_date + 'Z' : null,
        description: clip(strip(j.description), 12000), search_term: q,
      });
    }
  }
  return out;
}

async function remoteok(get) {
  const data = JSON.parse(await get('https://remoteok.com/api'));
  return data.slice(1).map((j) => ({
    source: 'remoteok', source_id: String(j.id), url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
    title: j.position, company: j.company, location: j.location || 'Worldwide',
    salary_text: j.salary_min ? `USD ${j.salary_min}-${j.salary_max} yearly` : null,
    posted_at: j.date || null, description: clip(strip(j.description), 12000), search_term: (j.tags || []).join(','),
  }));
}

async function wwr(get) {
  const out = [];
  for (const cat of ['remote-customer-support-jobs', 'all-other-remote-jobs']) {
    const xml = await get(`https://weworkremotely.com/categories/${cat}.rss`);
    for (const it of xml.split('<item>').slice(1)) {
      const tag = (t) => strip((it.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1]);
      const full = tag('title'); const i = full.indexOf(':');
      out.push({
        source: 'wwr', source_id: tag('guid') || tag('link'), url: tag('link'),
        company: i > 0 ? full.slice(0, i).trim() : null, title: i > 0 ? full.slice(i + 1).trim() : full,
        location: tag('region'), employment_type: tag('type').toLowerCase() || null,
        posted_at: tag('pubDate') ? new Date(tag('pubDate')).toISOString() : null,
        description: clip(strip(strip(tag('description'))), 12000), search_term: cat,
      });
    }
  }
  return out;
}

// n8n community forum, Jobs category (the user 2026-10-25): small (a few posts a week) but every post wants n8n work.
// Discourse JSON; the list has titles only, the full post comes from detail-core.js's fallback when he opens it.
async function n8nforum(get) {
  const data = JSON.parse(await get('https://community.n8n.io/c/jobs/13.json'));
  const fresh = Date.now() - 21 * 86400000; // the category keeps years of posts; only the last 3 weeks
  return (data.topic_list.topics || []).filter((t) => !t.pinned && Date.parse(t.created_at) > fresh).map((t) => ({
    source: 'n8nforum', source_id: String(t.id), url: `https://community.n8n.io/t/${t.slug}/${t.id}`,
    title: t.title, company: null, location: 'Remote (n8n forum)',
    posted_at: t.created_at || null, description: null, search_term: 'n8n forum jobs',
  }));
}

// Boards the user made profiles on (2026-10-25): Wellfound, Kalibrr, Hubstaff Talent, Arc.dev, Mercor.
// All read logged out; no account is used. Each keeps only the last 3 weeks where the board gives a date.
const FRESH_MS = 21 * 86400000;
const nextData = (html) => JSON.parse((html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1] || '{}').props || {};

// Wellfound role pages (the ones that exist; others redirect to login). Listings sit in the page's Apollo cache.
async function wellfound(get) {
  const out = [];
  for (const role of ['automation-engineer', 'customer-support', 'technical-support', 'solutions-engineer', 'ai-engineer']) {
    const data = (nextData(await get(`https://wellfound.com/role/r/${role}`)).pageProps || {}).apolloState?.data || {};
    const company = {};
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('StartupResult')) for (const r of v.highlightedJobListings || []) company[r.__ref] = v.name;
    }
    for (const [k, j] of Object.entries(data)) {
      if (!k.startsWith('JobListingSearchResult') || (j.liveStartAt && j.liveStartAt * 1000 < Date.now() - FRESH_MS)) continue;
      const accepted = (j.acceptedRemoteLocationNames || []).join(', ');
      out.push({
        source: 'wellfound', source_id: String(j.id), url: `https://wellfound.com/jobs/${j.id}-${j.slug}`, title: j.title,
        company: company[k] || null,
        location: j.remote ? (accepted || 'Remote') : `on-site ${(j.locationNames || []).join(', ')}`,
        salary_text: j.compensation || null, employment_type: j.jobType || null,
        posted_at: j.liveStartAt ? new Date(j.liveStartAt * 1000).toISOString() : null,
        description: clip(strip(j.description), 12000), search_term: role,
      });
    }
    await sleep(1500);
  }
  return out;
}

// Kalibrr (PH board): the site's own search JSON; only work-from-home posts.
async function kalibrr(get) {
  const out = [];
  for (const kw of [...KEYWORDS.automation.slice(0, 5), ...KEYWORDS.support.slice(0, 5)]) {
    const data = JSON.parse(await get(`https://www.kalibrr.com/kjs/job_board/search?limit=30&offset=0&text=${encodeURIComponent(kw)}`));
    for (const j of data.jobs || []) {
      if (!j.is_work_from_home || Date.parse(j.activation_date) < Date.now() - FRESH_MS) continue;
      const code = (j.company_info || {}).code || (j.company || {}).code || 'company';
      const sal = j.salary_shown !== false && j.base_salary ? `${j.salary_currency || 'PHP'} ${j.base_salary}-${j.maximum_salary || ''} ${j.salary_interval || ''}`.trim() : null;
      out.push({
        source: 'kalibrr', source_id: String(j.id), url: `https://www.kalibrr.com/c/${code}/jobs/${j.id}/${j.slug || ''}`,
        title: j.name, company: j.company_name || null, location: `Remote (Kalibrr, ${((j.google_location || {}).address_components || {}).country || 'PH'})`,
        salary_text: sal, employment_type: j.tenure ? String(j.tenure).toLowerCase().replace(' ', '-') : null,
        posted_at: j.activation_date || null,
        description: clip(strip(`${j.description || ''}\n${j.qualifications || ''}`), 12000), search_term: kw,
      });
    }
    await sleep(800);
  }
  return out;
}

// Hubstaff Talent: the search page fills its results by XHR; asking like that returns them as a JS string.
async function hubstaff(get) {
  const out = [];
  for (const kw of ['automation', 'n8n', 'zapier', 'technical support', 'customer support', 'customer success']) {
    const js = await get(`https://hubstafftalent.net/search/jobs?search%5Bkeywords%5D=${encodeURIComponent(kw)}&search%5Bsort_by%5D=date_added`,
      { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/javascript' } });
    const html = js.replace(/\\n/g, '\n').replace(/\\(.)/g, '$1'); // undo the JS string escaping (\" \/ \$)
    for (const block of html.split('<div class="search-result">').slice(1)) {
      const a = block.match(/<a class="name[^"]*"[^>]*href="(\/jobs\/[^"]+)">([\s\S]*?)<\/a>/);
      if (!a) continue;
      const when = (block.match(/data-original-title="([^"]+)"/) || [])[1];
      if (when && Date.parse(when.replace(' at ', ' ')) < Date.now() - FRESH_MS) continue;
      out.push({
        source: 'hubstaff', source_id: a[1], url: 'https://hubstafftalent.net' + a[1], title: strip(a[2]),
        company: strip((block.match(/job-agency[^>]*>(?:<i[^>]*><\/i>)?([\s\S]*?)<\/a>/) || [])[1]) || null,
        location: /Remote job/.test(block) ? 'Remote (Hubstaff Talent)' : `on-site ${strip((block.match(/<strong>HQ:<\/strong>([^<]*)/) || [])[1])}`,
        salary_text: strip((block.match(/<div class="pay-rate">([\s\S]*?)<\/div>/) || [])[1]) || null,
        employment_type: strip((block.match(/class="label label-[^"]*"[^>]*>([^<]+)</) || [])[1]).replace(' ', '-') || null,
        posted_at: when ? new Date(when.replace(' at ', ' ')).toISOString() : null,
        description: strip((block.match(/<div class="profil-bio[^"]*">([\s\S]*?)<\/div>/) || [])[1]), search_term: kw,
      });
    }
    await sleep(800);
  }
  return out;
}

// Arc.dev category pages: Arc's own vetted jobs (arcJobs, hourly rates) + jobs it lists from elsewhere (externalJobs).
async function arc(get) {
  const out = [];
  for (const cat of ['automation', 'n8n', 'ai', 'api-integration', 'technical-support']) {
    const p = nextData(await get(`https://arc.dev/remote-jobs/${cat}`)).pageProps || {};
    for (const [list, path] of [[p.arcJobs, 'details'], [p.externalJobs, 'j']]) {
      for (const j of list || []) {
        if (j.postedAt && j.postedAt * 1000 < Date.now() - FRESH_MS) continue;
        out.push({
          source: 'arc', source_id: j.randomKey, url: `https://arc.dev/remote-jobs/${path}/${j.urlString}-${j.randomKey}`, title: String(j.title).trim(),
          company: j.company?.name || (path === 'details' ? 'Arc (vetted client)' : null),
          location: (j.requiredCountries || []).join(', ') || 'Worldwide',
          salary_text: j.minHourlyRate ? `USD ${j.minHourlyRate}-${j.maxHourlyRate || ''} hourly` : j.minAnnualSalary ? `USD ${j.minAnnualSalary}-${j.maxAnnualSalary || ''} yearly` : null,
          employment_type: j.jobType === 'permanent' ? 'full-time' : j.jobType || null,
          posted_at: j.postedAt ? new Date(j.postedAt * 1000).toISOString() : null,
          description: (j.categories || []).map((c) => c.name).join(', '), search_term: cat,
        });
      }
    }
    await sleep(1500);
  }
  return out;
}

// Mercor: one public page lists every open project (mostly AI-training work for experts, hourly).
async function mercor(get) {
  const q = ((nextData(await get('https://work.mercor.com/explore')).pageProps || {}).dehydratedState?.queries || [])
    .find((x) => x.state?.data?.listings);
  return (q ? q.state.data.listings : []).filter((j) => j.status === 'active' && !j.disableApplications).map((j) => ({
    source: 'mercor', source_id: j.listingId, url: `https://work.mercor.com/jobs/${j.listingId}`, title: j.title, company: j.companyName || 'Mercor',
    location: j.workArrangement === 'remote' && !j.eligibleLocation ? 'Remote' : (j.eligibleLocation || j.location || ''),
    salary_text: j.rateMin ? `USD ${j.rateMin}-${j.rateMax || ''} ${j.payRateFrequency || ''}`.trim() : null,
    employment_type: j.commitment || null, posted_at: j.postedAt ? j.postedAt + 'Z' : null,
    description: clip(strip(j.description), 12000), search_term: 'mercor explore',
  }));
}

// Pay floor (the user 2026-10-06): $12/hr, or $1,500/month when the listing is monthly. A posted $1/hr or no rate =
// negotiable, keep it. Returns { usdHr, ok } where ok=null means "can't tell, let Claude judge".
const FX = { usd: 1, php: 1 / 58, aud: 0.66, gbp: 1.27, eur: 1.08, cad: 0.73 };
function parsePay(text, source, floorHr = 12, floorMonth = 1500) {
  const t = String(text || '').toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');
  if (!t.trim() || /negotiable|tbd|tba|doe|competitive|depends|n\/a|to be (decided|discussed|determined|agreed)/.test(t) && !/\d/.test(t)) return { usdHr: null, ok: null };
  const nums = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(k\b)?/g)].map((m) => parseFloat(m[1]) * (m[2] ? 1000 : 1)).filter((n) => n > 0 && n < 10000000);
  if (!nums.length) return { usdHr: null, ok: null };
  let cur = /₱|php|peso/.test(t) ? 'php' : /aud|a\$/.test(t) ? 'aud' : /£|gbp/.test(t) ? 'gbp' : /€|eur/.test(t) ? 'eur' : /cad/.test(t) ? 'cad' : 'usd';
  // OnlineJobs.ph / JobStreet PH: a bare 5-digit+ amount with no currency is pesos ("25000", "49,000 per Month").
  if (cur === 'usd' && (source === 'onlinejobs' || source === 'jobstreet') &&!/\$|usd/.test(t) && Math.max(...nums) >= 10000) cur = 'php';
  let period = /hour|hr\b|\/h\b|hourly|per h/.test(t) ? 'hour' : /month|\/mo\b|p\/m|monthly|mo\.|\bpm\b/.test(t) ? 'month'
    : /year|annual|yearly|\/yr|p\.a\./.test(t) ? 'year' : /week/.test(t) ? 'week' : null;
  // "₱715 per hour or approximately ₱123,000": ignore amounts that can't be an hourly rate.
  const usable = period === 'hour' ? nums.filter((n) => n * FX[cur] <= 150) : nums;
  if (!usable.length) return { usdHr: null, ok: null };
  const max = Math.max(...usable);
  const usd = max * FX[cur];
  if (!period) period = usd <= 60 ? 'hour' : usd <= 15000 ? 'month' : 'year';
  if (period === 'hour' && max <= 1) return { usdHr: null, ok: null }; // "$1/hr" placeholder = negotiable
  const usdHr = period === 'hour' ? usd : period === 'week' ? usd / 40 : period === 'month' ? usd / 160 : usd / 2080;
  // Floor applies to OnlineJobs.ph too again (the user 2026-10-08); TBD / negotiable / no rate still kept (above).
  const ok = period === 'month' ? usd >= floorMonth : usdHr >= floorHr;
  // Second tier (the user 2026-10-25): $8-11.99/hr (monthly $1,280-1,499 = $8/hr full time) is kept apart in the
  // dashboard's "Lower pay" tab instead of being rejected.
  const tier2 = !ok && (period === 'month' ? usd >= TIER2_HR * 160 : usdHr >= TIER2_HR);
  return { usdHr: Math.round(usdHr * 100) / 100, ok, tier2 };
}
const TIER2_HR = 8;

// hourUtc decides which rate-limited sources run this time (Remotive asks for max 4 calls a day).
async function fetchAllJobs(get, hourUtc, log = () => {}) {
  // Jobicy, Remote OK and We Work Remotely dropped 2026-10-06 (the user): mostly US-only / senior / engineering roles.
  // Himalayas dropped 2026-10-08 (the user). Remotive dropped 2026-10-16 (the user: only LinkedIn, OnlineJobs.ph, Indeed
  // and JobStreet; Indeed comes in through Gmail Watch alerts). 2026-10-25 (the user): Remotive + WWR back, plus the
  // n8n forum. Remotive asks for max 4 calls a day = its 4 searches once a day, in the 8 AM Manila run.
  // Same day: Wellfound, Kalibrr, Hubstaff Talent, Arc.dev, Mercor (boards he made profiles on).
  const runs = { olj, linkedin, jobstreet, wwr, n8nforum, wellfound, kalibrr, hubstaff, arc, mercor, ...(hourUtc === 8 ? { remotive } : {}) };
  const all = []; const stats = {};
  for (const [name, fn] of Object.entries(runs)) {
    try {
      const got = await fn(get);
      const kept = got.filter(keep);
      stats[name] = `${kept.length}/${got.length}`;
      all.push(...kept);
    } catch (e) { stats[name] = 'ERR ' + String(e.message || e).slice(0, 160); }
    log(name, stats[name]);
  }
  // Same post re-listed under new URLs (common on OLJ/LinkedIn): one per title + company (or title + pay if no company).
  const seen = new Set();
  const key = (j) => `${String(j.title).toLowerCase().trim()}|${String(j.company || j.salary_text || '').toLowerCase().trim()}`;
  const jobs = all.filter((j) => (seen.has(j.url) || seen.has(key(j)) ? false : (seen.add(j.url), seen.add(key(j))))).map(filterJob);
  return { jobs, stats };
}

// Pay floor + original rules -> status. No AI screening: passing the code filter = lead.
function filterJob(j) {
  const pay = parsePay(j.salary_text, j.source);
  // The other rules still run first on tier-2 pay: a location-locked $10/hr job is rejected, not "lower pay".
  const rule = screen(j);
  const low = !rule && pay.ok === false && pay.tier2;
  const why = rule || (pay.ok === false ? `pay below floor (${j.salary_text} = ~$${pay.usdHr}/hr)` : null);
  return {
    ...j, posted_at: j.posted_at && !isNaN(Date.parse(j.posted_at)) ? j.posted_at : null,
    rate_usd_hr: pay.usdHr, rate_ok: pay.ok, status: low ? 'low_pay' : why ? 'rejected' : 'review',
    reject_reason: why ? why.slice(0, 200) : null,
  };
}
