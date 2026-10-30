// Full job description for sources whose search results only carry a snippet (LinkedIn, OnlineJobs.ph).
// Shared by "JobHunt / Score" and local tests. get(url) resolves to the body string.

const dstrip = (h) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d|ul|ol)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<ojfilter[^>]*>[\s\S]*?<\/ojfilter>/gi, '[hidden by OnlineJobs]').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&#x27;/g, "'").replace(/&#\d+;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

async function jobDetail(get, job) {
  if (job.source === 'linkedin' && job.source_id) {
    const html = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${job.source_id}`);
    const desc = (html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const crit = [...html.matchAll(/criteria-subheader">\s*([^<]+?)\s*<\/h3>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/g)]
      .map((m) => `${m[1]}: ${m[2]}`).join('\n');
    const salary = dstrip((html.match(/salary compensation__salary">([\s\S]*?)<\/div>/) || [])[1]);
    return { description: [crit, salary ? `Salary: ${salary}` : '', dstrip(desc)].filter(Boolean).join('\n\n').slice(0, 12000) };
  }
  if (job.source === 'onlinejobs') {
    const html = await get(job.url);
    const desc = (html.match(/id="job-description"[^>]*>([\s\S]*?)<\/p>\s*<\/div>/) || [])[1];
    const facts = [...html.matchAll(/<h3 class="fs-12 mb-0">([^<]+)<\/h3>\s*<p class="fs-18">([\s\S]*?)<\/p>/g)]
      .map((m) => `${dstrip(m[1])}: ${dstrip(m[2])}`).join('\n');
    return { description: [facts, dstrip(desc)].filter(Boolean).join('\n\n').slice(0, 12000) };
  }
  // JobStreet job pages are behind Cloudflare; the site's GraphQL answers with the full post.
  const js = job.source === 'jobstreet' && (job.source_id || (String(job.url).match(/jobstreet\.com\/(?:[^/]+\/)?job\/(\d+)/) || [])[1]);
  if (js) {
    const query = 'query jobDetails($jobId: ID!) { jobDetails(id: $jobId) { job { content(platform: WEB) salary { label } workTypes { label } } } }';
    const d = JSON.parse(await get('https://ph.jobstreet.com/graphql', { method: 'POST',
      headers: { 'content-type': 'application/json', 'seek-request-brand': 'jobstreet', 'seek-request-country': 'PH' },
      body: JSON.stringify({ operationName: 'jobDetails', variables: { jobId: String(js) }, query }) }));
    const j = (((d || {}).data || {}).jobDetails || {}).job || {};
    const facts = [j.salary && j.salary.label ? `Salary: ${j.salary.label}` : '', j.workTypes && j.workTypes.label ? `Type: ${j.workTypes.label}` : ''].filter(Boolean).join('\n');
    return j.content ? { description: [facts, dstrip(j.content)].filter(Boolean).join('\n\n').slice(0, 12000) } : {};
  }
  // n8n community forum (Discourse): the topic's JSON has the first post as HTML.
  if (job.source === 'n8nforum') {
    const d = JSON.parse(await get(String(job.url).replace(/\/?$/, '.json')));
    const first = ((d.post_stream || {}).posts || [])[0];
    return first ? { description: dstrip(first.cooked).slice(0, 12000) } : {};
  }
  // Any other site (Himalayas, Indeed, ATS pages...): most embed a schema.org JobPosting as JSON-LD.
  // Sites behind bot protection just fail here and the dashboard keeps the snippet.
  if (/^https?:\/\//.test(job.url || '')) {
    const html = await get(job.url);
    for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let d; try { d = JSON.parse(m[1].trim()); } catch (e) { continue; }
      const all = [].concat(d, d && d['@graph'] || []);
      const p = all.find((x) => x && /JobPosting/.test([].concat(x['@type']).join(' ')) && x.description);
      if (p) {
        const html2 = String(p.description).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return { description: dstrip(html2).slice(0, 12000) };
      }
    }
  }
  return {};
}
