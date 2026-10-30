-- JobHunt functions used by the n8n "JobHunt / *" workflows. Run as jobs_app. Safe to re-run.

-- "JobHunt / Fetch" and "JobHunt / Gmail Watch": insert new jobs, skip known URLs. Returns how many were new.
create or replace function jh_insert_jobs(p jsonb) returns int language sql as $$
  with ins as (
    insert into jobs(source, source_id, url, title, company, location, salary_text, employment_type, posted_at,
                     description, search_term, rate_usd_hr, rate_ok, status, reject_reason, fp)
    select x.source, x.source_id, x.url, left(x.title, 300), x.company, x.location, x.salary_text, x.employment_type,
           x.posted_at, x.description, x.search_term, x.rate_usd_hr, x.rate_ok, coalesce(x.status, 'review'), x.reject_reason, x.fp
    from (select distinct on (coalesce(y.fp, y.url)) y.* from (
      select r.*, case when length(regexp_replace(lower(coalesce(r.description, '')), '[^a-z0-9]', '', 'g')) >= 80
                  then left(regexp_replace(lower(r.description), '[^a-z0-9]', '', 'g'), 120) end as fp
      from jsonb_to_recordset(p) as r(source text, source_id text, url text, title text, company text, location text,
         salary_text text, employment_type text, posted_at timestamptz, description text, search_term text,
         rate_usd_hr numeric, rate_ok boolean, status text, reject_reason text)) y) x
    where x.url is not null and x.title is not null
      and (x.fp is null or not exists (select 1 from jobs o where o.fp = x.fp and o.created_at > now() - interval '30 days'))
      -- the same post re-listed under a new URL within 30 days
      and not exists (select 1 from jobs o
        where lower(o.title) = lower(x.title)
          and lower(coalesce(o.company, o.salary_text, '')) = lower(coalesce(x.company, x.salary_text, ''))
          and o.created_at > now() - interval '30 days')
    on conflict (url) do nothing
    returning 1
  )
  select count(*)::int from ins
$$;

-- "JobHunt / Score": take up to n new jobs (newest first, LinkedIn + OLJ first because they go stale fastest).
-- Jobs stuck in 'scoring' for an hour (crashed run) go back to 'new'; after 3 failed tries a job is parked.
-- settings.score_budget = how many more jobs may be scored (the user 2026-10-06: start with 30 to vet the filter);
-- every claim spends it, 0 = paused. Jobs are taken round-robin across sources so a batch shows every board.
create or replace function jh_claim_score(n int) returns setof jsonb language plpgsql as $$
declare
  b int := coalesce((select value::int from settings where key = 'score_budget'), 1000000);
  got int;
begin
  update jobs set status = 'new' where status = 'scoring' and updated_at < now() - interval '1 hour';
  update jobs set status = 'rejected', reject_reason = 'scoring failed 3 times' where status = 'new' and attempts >= 3;
  if b <= 0 then return; end if;
  return query
  with c as (
    select id from jobs where id in (
      select id from (
        select id, source, coalesce(posted_at, created_at) as t,
               row_number() over (partition by source order by coalesce(posted_at, created_at) desc) as rn
        from jobs where status = 'new') r
      order by rn, (source in ('linkedin', 'onlinejobs')) desc, t desc
      limit least(n, b))
    for update skip locked
  )
  update jobs j set status = 'scoring', attempts = j.attempts + 1 from c where j.id = c.id
  returning jsonb_build_object('id', j.id, 'source', j.source, 'source_id', j.source_id, 'url', j.url, 'title', j.title,
    'company', j.company, 'location', j.location, 'salary_text', j.salary_text, 'employment_type', j.employment_type,
    'description', j.description);
  get diagnostics got = row_count;
  -- 1000000+ = no limit (dashboard "No limit" button), never counted down
  if got > 0 and b < 1000000 then update settings set value = greatest(b - got, 0)::text where key = 'score_budget'; end if;
end $$;

-- Settings + approval progress, read by every workflow that writes letters.
create or replace function jh_settings() returns jsonb language sql as $$
  select coalesce((select jsonb_object_agg(key, value) from settings where key not in ('dash_token', 'dash_pin')), '{}'::jsonb)
    || jsonb_build_object('approvals_done', (select count(*) from job_events where kind = 'approved'))
$$;

-- Save Claude's verdict (+ letter when there is one). p = job fields as produced by the Score workflow.
create or replace function jh_save_score(p jsonb) returns jsonb language plpgsql as $$
declare
  s jsonb := jh_settings();
  st text := p->>'status';
begin
  -- Past the review period and auto-send is on: approved-by-default email jobs go straight to the send queue.
  if st = 'review' and p->>'apply_method' = 'email' and coalesce(p->>'apply_email', '') <> ''
     and (s->>'approvals_done')::int >= (s->>'approvals_required')::int and s->>'auto_send' = 'true' then
    st := 'sending';
  end if;
  perform jh_log_usage(p->'usage', 'score');
  update jobs set
    description     = coalesce(nullif(p->>'description', ''), description),
    category        = p->>'category',
    fit_score       = (p->>'fit_score')::int,
    priority        = p->>'priority',
    rate_usd_hr     = coalesce((p->>'rate_usd_hr')::numeric, rate_usd_hr),
    reject_reason   = nullif(p->>'reject_reason', ''),
    score_notes     = p->>'notes',
    resume_variant  = p->>'resume_variant',
    apply_email     = nullif(p->>'apply_email', ''),
    apply_method    = p->>'apply_method',
    required_phrase = nullif(p->>'required_phrase', ''),
    employer_region = p->>'employer_region',
    questions       = case when jsonb_array_length(coalesce(p->'needs_from_user', '[]')) > 0 then p->'needs_from_user' end,
    letter_subject  = coalesce(p->>'letter_subject', letter_subject),
    letter          = coalesce(p->>'letter', letter),
    status          = st
  where id = (p->>'id')::bigint;
  return jsonb_build_object('id', p->>'id', 'status', st);
end $$;

-- A Claude call failed: put the job back so the next run retries it (jh_claim_score parks it after 3 tries).
create or replace function jh_unclaim(p_id bigint, p_err text) returns void language sql as $$
  update jobs set status = 'new' where id = p_id and status in ('scoring');
  insert into job_events(job_id, kind, detail) values (p_id, 'error', left(p_err, 500));
$$;

-- "JobHunt / Send": approved email applications, US business hours only (Mon-Fri 8-16 New York time), daily cap.
create or replace function jh_claim_send(n int) returns setof jsonb language plpgsql as $$
declare
  ny timestamp := now() at time zone 'America/New_York';
  sent_today int := (select count(*) from jobs where applied_via = 'auto-email' and applied_at > now() - interval '24 hours');
  cap int := coalesce((select value::int from settings where key = 'daily_email_cap'), 25);
begin
  if extract(isodow from ny) > 5 or extract(hour from ny) not between 8 and 15 or sent_today >= cap then
    return;
  end if;
  return query
  with c as (select id from jobs where status = 'sending' order by updated_at limit least(n, cap - sent_today) for update skip locked)
  update jobs j set status = 'emailing' from c where j.id = c.id
  returning jsonb_build_object('id', j.id, 'to', j.apply_email, 'subject', j.letter_subject, 'letter', j.letter,
    'resume_variant', coalesce(j.resume_variant, 'automation'), 'title', j.title, 'company', j.company);
end $$;

create or replace function jh_mark_sent(p jsonb) returns void language plpgsql as $$
begin
  if coalesce(p->>'thread_id', '') <> '' then
    update jobs set status = 'applied', applied_at = now(), applied_via = 'auto-email', gmail_thread_id = p->>'thread_id'
    where id = (p->>'id')::bigint;
    insert into job_events(job_id, kind, detail) values ((p->>'id')::bigint, 'email_sent', p->>'to');
  else
    update jobs set status = 'ready', notes = concat_ws(E'\n', notes, 'Auto email failed: ' || coalesce(p->>'error', '?'))
    where id = (p->>'id')::bigint;
  end if;
end $$;

-- "JobHunt / Gmail Watch": which message ids are new (marks them seen).
create or replace function jh_new_messages(ids text[]) returns text[] language sql as $$
  with ins as (insert into gmail_seen(id) select unnest(ids) on conflict do nothing returning id)
  select coalesce(array_agg(id), '{}') from ins
$$;

-- An employer replied. Match by Gmail thread first, then by company name among jobs he applied to.
-- p = {thread_id, from, subject, company, job_title, outcome, interview_at, summary}
create or replace function jh_reply(p jsonb) returns jsonb language plpgsql as $$
declare
  jid bigint;
  new_status text := case p->>'outcome'
    when 'interview_invite' then 'interview' when 'assessment' then 'interview' when 'offer' then 'offer'
    when 'rejection' then 'lost' else null end;
begin
  select id into jid from jobs where gmail_thread_id = p->>'thread_id' limit 1;
  if jid is null and coalesce(p->>'company', '') <> '' then
    select id into jid from jobs
    where status in ('applied', 'interview', 'offer', 'ready')
      and company is not null and length(company) > 2
      and (lower(p->>'company') like '%' || lower(company) || '%' or lower(company) like '%' || lower(p->>'company') || '%')
    order by applied_at desc nulls last limit 1;
  end if;
  insert into job_events(job_id, kind, detail)
  values (jid, 'reply', concat(p->>'outcome', ': ', p->>'summary', ' | from ', p->>'from', ' | ', p->>'subject'));
  if jid is not null then
    update jobs set last_reply_at = now(),
      interview_at = coalesce(nullif(p->>'interview_at', '')::timestamptz, interview_at),
      -- never move a job backwards (an interview stays an interview if a "thanks for applying" arrives late)
      status = case
        when new_status is null then status
        when status in ('won') then status
        when new_status = 'lost' then 'lost'
        when new_status = 'offer' then 'offer'
        when new_status = 'interview' and status not in ('offer') then 'interview'
        else status end
    where id = jid;
  end if;
  return jsonb_build_object('job_id', jid, 'status', new_status);
end $$;

-- Dashboard API (jobs.example.com -> nginx -> n8n "JobHunt / API" -> here).
create or replace function jh_api(action text, p jsonb) returns jsonb language plpgsql as $$
declare
  r jsonb;
  jid bigint := nullif(p->>'id', '')::bigint;
  j jobs;
begin
  if action = 'stats' then
    select jsonb_build_object(
      'found', count(*),
      'found_today', count(*) filter (where created_at > now() - interval '24 hours'),
      'screened', count(*) filter (where status not in ('new', 'scoring')),
      'rejected', count(*) filter (where status = 'rejected'),
      'review', count(*) filter (where status = 'review'),
      'low_pay', count(*) filter (where status = 'low_pay'),
      'needs_info', count(*) filter (where status = 'needs_info'),
      'ready', count(*) filter (where status = 'ready'),
      'leads', count(*) filter (where status in ('review', 'needs_info', 'ready', 'revamping')),
      'high', count(*) filter (where priority = 'high' and status in ('review', 'needs_info', 'ready', 'sending', 'revamping')),
      'applied', count(*) filter (where applied_at is not null),
      'applied_today', count(*) filter (where applied_at > now() - interval '24 hours'),
      'applied_week', count(*) filter (where applied_at > now() - interval '7 days'),
      'interviews', count(*) filter (where status = 'interview' or interview_at is not null),
      'offers', count(*) filter (where status = 'offer'),
      'won', count(*) filter (where status = 'won'),
      'queue_new', count(*) filter (where status in ('new', 'scoring')),
      'emails_waiting', (select count(*) from email_queue where done_at is null),
      'by_source', (select jsonb_object_agg(source, n) from (select source, count(*) n from jobs group by source) s),
      'applied_by_day', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n) order by d), '[]') from (
          select (applied_at at time zone 'Asia/Manila')::date d, count(*) n from jobs
          where applied_at > now() - interval '30 days' group by 1) a),
      'settings', jh_settings(),
      'ai_cost_today', (select coalesce(round(sum(usd), 2), 0) from claude_usage where at > now() - interval '24 hours'),
      'ai_cost_30d', (select coalesce(round(sum(usd), 2), 0) from claude_usage where at > now() - interval '30 days'),
      'ai_cost_by_day', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'usd', usd) order by d), '[]') from (
          select (at at time zone 'Asia/Manila')::date d, round(sum(usd), 3) usd from claude_usage
          where at > now() - interval '30 days' group by 1) c),
      'unmatched_replies', (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'detail', detail) order by at desc), '[]')
          from (select at, detail from job_events where kind = 'reply' and job_id is null order by at desc limit 20) u)
    ) into r from jobs;
    return r;

  elsif action = 'list' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'sort1' - 'sort2' - 'sort3' order by x.sort1 desc nulls last, x.sort2 desc, x.sort3 desc), '[]') into r from (
      select id, source, url, title, company, location, salary_text, employment_type, posted_at, category, fit_score,
             priority, rate_usd_hr, status, reject_reason, score_notes, apply_method, apply_email, starred,
             applied_at, interview_at, last_reply_at, created_at, employer_region,
             case when p->>'tab' in ('applied', 'interviews', 'won') then coalesce(applied_at, created_at) else null end as sort1,
             coalesce(posted_at, created_at) as sort2, created_at as sort3 -- newest first (no AI scores since 2026-10-07)
      from jobs
      where case p->>'tab'
          when 'review' then status in ('review', 'revamping')
          when 'needs_info' then status = 'needs_info'
          when 'low_pay' then status = 'low_pay'
          when 'ready' then status in ('ready', 'sending', 'emailing')
          when 'high' then priority = 'high' and status in ('review', 'needs_info', 'ready', 'sending', 'revamping')
          when 'applied' then applied_at is not null
          when 'interviews' then status in ('interview', 'offer') or interview_at is not null
          when 'won' then status = 'won'
          when 'rejected' then status in ('rejected', 'skipped', 'lost')
          else true end
        and (coalesce(p->>'q', '') = '' or (title || ' ' || coalesce(company, '') || ' ' || coalesce(description, '')) ilike '%' || (p->>'q') || '%')
        and (coalesce(p->>'source', '') = '' or source = p->>'source')
        -- Pay filter: 'posted' = a rate was parsed from the listing, 'tbd' = TBD / negotiable / not posted.
        and case p->>'pay' when 'posted' then rate_usd_hr is not null when 'tbd' then rate_usd_hr is null else true end
      order by sort1 desc nulls last, sort2 desc, sort3 desc
      limit least(coalesce((p->>'limit')::int, 50), 200) offset coalesce((p->>'offset')::int, 0)
    ) x;
    return r;

  elsif action = 'get' then
    select to_jsonb(jobs) || jsonb_build_object('events',
      (select coalesce(jsonb_agg(to_jsonb(e) order by e.at desc), '[]') from job_events e where e.job_id = jobs.id))
    into r from jobs where id = jid;
    return r;

  elsif action = 'fetch_detail' then
    -- Dashboard popup: hand the job to n8n to fetch the full post when we only hold a snippet (search-result text,
    -- alert-email stub, "..." cut-off). Tried at most once a day per job; n8n then calls save_detail.
    select * into j from jobs where id = jid;
    if j.id is null then return jsonb_build_object('error', 'not found'); end if;
    if (length(coalesce(j.description, '')) >= 1500 and j.description not like '%...')
       or coalesce(j.detail_tried_at, '-infinity') > now() - interval '1 day' then
      return jsonb_build_object('description', j.description, 'fetched', false);
    end if;
    update jobs set detail_tried_at = now() where id = jid;
    return jsonb_build_object('detail_job', to_jsonb(j));

  elsif action = 'save_detail' then
    update jobs set description = p->>'description'
    where id = jid and length(coalesce(p->>'description', '')) > length(coalesce(description, ''))
    returning * into j;
    return jsonb_build_object('description', coalesce(j.description, (select description from jobs where id = jid)), 'fetched', j.id is not null);

  elsif action = 'approve' then
    -- p: id, subject?, letter? (his edits). Email jobs go to the send queue, the rest wait for him to apply on the site.
    -- Letters are only written on request (2026-10-07), so a job can reach approve without one.
    if coalesce(nullif(trim(p->>'letter'), ''), (select nullif(trim(letter), '') from jobs where id = jid)) is null then
      return jsonb_build_object('error', 'Write a cover letter first');
    end if;
    update jobs set letter_subject = coalesce(nullif(p->>'subject', ''), letter_subject),
      letter = coalesce(nullif(p->>'letter', ''), letter),
      status = case when apply_method = 'email' and coalesce(apply_email, '') <> '' then 'sending'
                    else 'ready' end
    where id = jid and status in ('review', 'needs_info') returning * into j;
    if j.id is null then return jsonb_build_object('error', 'not in review'); end if;
    insert into job_events(job_id, kind, detail) values (jid, 'approved', j.status);
    return jsonb_build_object('ok', true, 'status', j.status);

  elsif action in ('revamp', 'answer', 'write_letter') then
    -- write_letter = first draft on request (no feedback), from the dashboard's "Write cover letter" button.
    if action = 'write_letter' then
      -- 'revamping' too when he pays to skip a letter still waiting on a sleeping PC (use_api clears letter_request).
      -- 'rejected' too (the user 2026-10-22): he can overrule the filter; the saved letter moves the job into leads.
      -- 'low_pay' (014): same, the $8-11.99/hr tier becomes a normal lead once he asks for a letter.
      if not exists (select 1 from jobs where id = jid and (status in ('review', 'needs_info', 'rejected', 'low_pay')
                     or (status = 'revamping' and coalesce((p->>'use_api')::boolean, false)))) then
        return jsonb_build_object('error', 'not a lead');
      end if;
    end if;
    -- No automatic API spend (the user 2026-10-14): the PC writes it (Claude Code on his plan). When the PC is off,
    -- nothing happens until he presses "Use API credits" (p.use_api = true), checked before any side effect so the
    -- retry doesn't save the feedback / style note twice.
    if not coalesce((p->>'use_api')::boolean, false)
       and coalesce(nullif((select value from settings where key = 'worker_last_seen'), '')::timestamptz, '-infinity') <= now() - interval '10 minutes' then
      return jsonb_build_object('pc_off', true, 'error', 'Your PC is off, so it cannot write the letter for free.');
    end if;
    if action = 'revamp' then
      insert into letter_feedback(job_id, feedback, before) select id, p->>'feedback', letter from jobs where id = jid;
      if coalesce((p->>'remember')::boolean, false) then
        update settings set value = concat_ws(E'\n', nullif(value, ''), '- ' || (p->>'feedback')) where key = 'style_notes';
      end if;
    elsif action = 'answer' then
      update jobs set answers = p->>'answers' where id = jid;
      perform jh_save_answers(p->'pairs'); -- kept for later forms too (013)
    elsif exists (select 1 from jobs where id = jid and status in ('rejected', 'low_pay')) then
      insert into job_events(job_id, kind, detail) values (jid, 'unrejected', 'letter requested on a rejected / lower-pay job, moves to leads');
    end if;
    -- PC engine (008): the local worker on my PC writes it with Claude Code. letter_engine is no longer read.
    if not coalesce((p->>'use_api')::boolean, false) then
      update jobs set status = 'revamping', letter_request = jsonb_build_object('kind', action, 'feedback', p->>'feedback', 'at', now())
      where id = jid;
      return jsonb_build_object('ok', true, 'queued', true);
    end if;
    -- Only reached when the user pressed "Use API credits": n8n writes it with the Anthropic API, then calls save_letter.
    update jobs set status = 'revamping', letter_request = null where id = jid returning * into j;
    return jsonb_build_object('letter_job', to_jsonb(j), 'feedback', p->>'feedback',
      'style_notes', (select value from settings where key = 'style_notes'));

  elsif action = 'letter_claim' then
    -- Local worker: next queued letter (a claim older than 10 min = the worker died mid-letter, hand it out again).
    update settings set value = now()::text where key = 'worker_last_seen';
    update jobs set letter_request = letter_request || jsonb_build_object('claimed_at', now())
    where id = (select id from jobs where status = 'revamping' and letter_request is not null
                  and coalesce((letter_request->>'claimed_at')::timestamptz, '-infinity') < now() - interval '10 minutes'
                order by (letter_request->>'at') limit 1 for update skip locked)
    returning * into j;
    if j.id is null then return jsonb_build_object('job', null); end if;
    return jsonb_build_object('job', to_jsonb(j) - 'letter_request', 'request', j.letter_request,
      'style_notes', (select value from settings where key = 'style_notes'));

  elsif action = 'save_letter' then
    perform jh_log_usage(p->'usage', 'revamp');
    -- back to needs_info when the post's questions are still unanswered, else review
    update jobs set letter_subject = p->>'subject', letter = p->>'letter', letter_request = null,
      description = coalesce(nullif(p->>'description', ''), description), -- full post fetched for the letter
      status = case when questions is not null and coalesce(answers, '') = '' then 'needs_info' else 'review' end
    where id = jid;
    update letter_feedback set after = p->>'letter' where id = (select max(id) from letter_feedback where job_id = jid);
    return jsonb_build_object('ok', true);

  elsif action = 'letter_failed' then
    update jobs set status = case when questions is not null and answers is null then 'needs_info' else 'review' end,
      letter_request = null
    where id = jid and status = 'revamping';
    insert into job_events(job_id, kind, detail) values (jid, 'error', 'letter rewrite failed: ' || coalesce(p->>'error', '?'));
    return jsonb_build_object('ok', false);

  elsif action = 'mark_applied' then
    update jobs set status = 'applied', applied_at = coalesce(applied_at, now()), applied_via = coalesce(applied_via, 'manual')
    where id = jid;
    return jsonb_build_object('ok', true);

  elsif action = 'set_status' then
    if p->>'status' not in ('review', 'ready', 'applied', 'interview', 'offer', 'won', 'lost', 'ghosted', 'skipped', 'rejected') then
      return jsonb_build_object('error', 'bad status');
    end if;
    update jobs set status = p->>'status',
      applied_at = case when p->>'status' in ('applied', 'interview', 'offer', 'won') then coalesce(applied_at, now()) else applied_at end,
      applied_via = case when p->>'status' in ('applied', 'interview', 'offer', 'won') then coalesce(applied_via, 'manual') else applied_via end,
      interview_at = coalesce(nullif(p->>'interview_at', '')::timestamptz, interview_at)
    where id = jid;
    if coalesce(p->>'note', '') <> '' then
      update jobs set notes = concat_ws(E'\n', notes, p->>'note') where id = jid;
      insert into job_events(job_id, kind, detail) values (jid, 'note', p->>'note');
    end if;
    return jsonb_build_object('ok', true);

  elsif action = 'login' then
    -- PIN screen (010). n8n forces this action for requests from nginx's /api/login, the only route open without
    -- the cookie. Returns the cookie value nginx accepts.
    if coalesce(nullif((select value from settings where key = 'login_locked_until'), '')::timestamptz, '-infinity') > now() then
      return jsonb_build_object('error', 'Too many wrong tries. Try again in 15 minutes.');
    end if;
    if coalesce(p->>'pin', '') <> '' and p->>'pin' = (select value from settings where key = 'dash_pin')
       and coalesce((select value from settings where key = 'dash_token'), '') <> '' then
      update settings set value = '0' where key = 'login_fails';
      return jsonb_build_object('ok', true, 'token', (select value from settings where key = 'dash_token'));
    end if;
    update settings set value = (coalesce(nullif(value, ''), '0')::int + 1)::text where key = 'login_fails';
    if (select value::int from settings where key = 'login_fails') >= 5 then
      update settings set value = (now() + interval '15 minutes')::text where key = 'login_locked_until';
      update settings set value = '0' where key = 'login_fails';
      return jsonb_build_object('error', 'Too many wrong tries. Try again in 15 minutes.');
    end if;
    return jsonb_build_object('error', 'Wrong PIN');

  elsif action = 'email_claim' then
    -- Local worker: next email Gmail Watch queued (009). A claim older than 10 min = PC died mid-way.
    update settings set value = now()::text where key = 'worker_last_seen';
    delete from email_queue where done_at < now() - interval '30 days';
    update email_queue e set claimed_at = now()
    where e.id = (select q.id from email_queue q where q.done_at is null
                    and coalesce(q.claimed_at, '-infinity') < now() - interval '10 minutes'
                  order by q.at limit 1 for update skip locked)
    returning jsonb_build_object('id', e.id, 'thread_id', e.thread_id, 'from', e.sender, 'subject', e.subject, 'text', e.body) into r;
    return jsonb_build_object('email', r);

  elsif action = 'email_result' then
    -- p = {email_id, kind, jobs (already code-filtered on the PC), reply}
    if jsonb_array_length(coalesce(p->'jobs', '[]')) > 0 then
      perform jh_insert_jobs(p->'jobs');
    end if;
    if p->>'kind' = 'employer_reply' and p->'reply' is not null then
      perform jh_reply((p->'reply') || (select jsonb_build_object('thread_id', thread_id, 'from', sender, 'subject', subject)
                                        from email_queue where id = p->>'email_id'));
    end if;
    update email_queue set done_at = now(), result = p - 'email_id' where id = p->>'email_id';
    return jsonb_build_object('ok', true);

  elsif action = 'star' then
    update jobs set starred = not starred where id = jid;
    return jsonb_build_object('ok', true);

  elsif action = 'set_setting' then
    if p->>'key' not in ('style_notes', 'auto_send', 'daily_email_cap', 'approvals_required', 'score_budget', 'answers_profile', 'letter_engine') then
      return jsonb_build_object('error', 'bad key');
    end if;
    insert into settings(key, value) values (p->>'key', p->>'value') on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('ok', true);

  elsif action = 'add_job' then
    -- Paste a job by hand (e.g. from a LinkedIn/Indeed page he found himself). Only the post text is required
    -- (2026-10-18): no link = 'manual:<md5 of the post>' (same paste twice = same job), no title = the post's first line.
    if coalesce(nullif(trim(p->>'description'), ''), nullif(trim(p->>'url'), '')) is null then
      return jsonb_build_object('error', 'Paste the job post first');
    end if;
    insert into jobs(source, url, title, company, description, salary_text, status)
    values ('manual',
      coalesce(nullif(trim(p->>'url'), ''), 'manual:' || md5(trim(p->>'description'))),
      coalesce(nullif(trim(p->>'title'), ''), left(trim(substring(trim(p->>'description') from '^[^\n]+')), 120), 'Pasted job'),
      nullif(trim(p->>'company'), ''), nullif(trim(p->>'description'), ''), nullif(trim(p->>'salary_text'), ''), 'review')
    on conflict (url) do update set status = 'review', description = coalesce(excluded.description, jobs.description)
    returning id into jid;
    return jsonb_build_object('ok', true, 'id', jid);
  end if;
  return jsonb_build_object('error', 'unknown action');
end $$;
