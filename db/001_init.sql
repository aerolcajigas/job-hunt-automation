-- JobHunt schema (database "jobs", owner jobs_app). Run as jobs_app.

create table if not exists jobs (
  id              bigserial primary key,
  source          text not null,              -- onlinejobs | linkedin | indeed | jobstreet | remotive | himalayas | remoteok | jobicy | wwr | other
  source_id       text,
  url             text not null unique,
  title           text not null,
  company         text,
  location        text,
  salary_text     text,
  employment_type text,                       -- full-time | part-time | contract | gig
  posted_at       timestamptz,
  description     text,
  search_term     text,
  -- scoring (Claude)
  category        text,                       -- automation | support | other
  fit_score       int,                        -- 0-100
  priority        text,                       -- high | normal | low
  rate_usd_hr     numeric,                    -- best estimate of offered hourly rate, null if not stated
  rate_ok         boolean,
  reject_reason   text,
  score_notes     text,
  -- application
  status          text not null default 'new',
  -- new -> scoring -> rejected | needs_info | review (letter drafted, waiting for the user) -> ready (approved, apply
  -- on the site) | sending (approved email job) -> applied -> interview -> offer -> won ; also lost | ghosted | skipped
  resume_variant  text,                       -- automation | support
  letter_subject  text,
  letter          text,
  apply_email     text,
  apply_method    text,                       -- email | site
  questions       jsonb,                      -- things only the user can answer
  answers         text,
  applied_at      timestamptz,
  applied_via     text,                       -- auto-email | manual
  gmail_thread_id text,
  interview_at    timestamptz,
  last_reply_at   timestamptz,
  notes           text,
  required_phrase text,
  employer_region text,
  attempts        int not null default 0,         -- failed scoring tries (gives up after 3)
  starred         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists jobs_status_idx on jobs(status);
create index if not exists jobs_created_idx on jobs(created_at desc);
create index if not exists jobs_thread_idx on jobs(gmail_thread_id);

create table if not exists job_events (
  id      bigserial primary key,
  job_id  bigint references jobs(id) on delete cascade,
  at      timestamptz not null default now(),
  kind    text not null,                      -- found | scored | status | email_sent | reply | note
  detail  text
);
create index if not exists job_events_job_idx on job_events(job_id);

create table if not exists settings (
  key   text primary key,
  value text not null
);
-- my review notes on letters ("Revamp with feedback"); the condensed version lives in settings.style_notes.
create table if not exists letter_feedback (
  id       bigserial primary key,
  job_id   bigint references jobs(id) on delete set null,
  at       timestamptz not null default now(),
  feedback text not null,
  before   text,
  after    text
);

-- Gmail messages already processed by "JobHunt / Gmail Watch".
create table if not exists gmail_seen (
  id  text primary key,
  at  timestamptz not null default now()
);

insert into settings(key, value) values
  -- Every letter waits for my approval until he has approved this many (the user 2026-10-06: first 20).
  -- Even after that, auto_send must also be 'true' before an email job sends without review.
  ('approvals_required', '20'),
  ('auto_send', 'false'),
  ('style_notes', ''),
  ('score_budget', '30'),          -- jobs Claude may still screen; the user raises it after vetting the filter
  ('daily_email_cap', '25'),
  ('min_usd_hr', '12'),
  ('min_usd_month', '1500')
on conflict do nothing;

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists jobs_touch on jobs;
create trigger jobs_touch before update on jobs for each row execute function touch_updated_at();

-- status changes are logged automatically
create or replace function log_status() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into job_events(job_id, kind, detail) values (new.id, 'found', new.source);
  elsif new.status is distinct from old.status then
    insert into job_events(job_id, kind, detail) values (new.id, 'status', old.status || ' -> ' || new.status);
  end if;
  return new;
end $$;
drop trigger if exists jobs_log on jobs;
create trigger jobs_log after insert or update on jobs for each row execute function log_status();

-- Claude spend for JobHunt only (dashboard "AI cost"). p = [{model, usage:{input_tokens, output_tokens,
-- cache_creation_input_tokens, cache_read_input_tokens}}]. Prices USD per million tokens (2026-10).
create table if not exists claude_usage (
  id bigserial primary key, at timestamptz not null default now(), model text, purpose text,
  input int, output int, cache_write int, cache_read int, usd numeric
);
create or replace function jh_log_usage(p jsonb, purpose text) returns void language sql as $$
  insert into claude_usage(model, purpose, input, output, cache_write, cache_read, usd)
  select u->>'model', purpose,
    coalesce((u->'usage'->>'input_tokens')::int, 0), coalesce((u->'usage'->>'output_tokens')::int, 0),
    coalesce((u->'usage'->>'cache_creation_input_tokens')::int, 0), coalesce((u->'usage'->>'cache_read_input_tokens')::int, 0),
    (case when u->>'model' like 'claude-sonnet%' then 2.0 else 1.0 end) * (
        coalesce((u->'usage'->>'input_tokens')::numeric, 0)
      + 1.25 * coalesce((u->'usage'->>'cache_creation_input_tokens')::numeric, 0)
      + 0.1 * coalesce((u->'usage'->>'cache_read_input_tokens')::numeric, 0)
      + 5 * coalesce((u->'usage'->>'output_tokens')::numeric, 0)) / 1000000
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) u
  where u->'usage' is not null
$$;

create index if not exists jobs_title_idx on jobs (lower(title));

-- Repost detection: the opening of the post as first seen (normalized). Same employer, new title = same fingerprint.
alter table jobs add column if not exists fp text;
create index if not exists jobs_fp_idx on jobs (fp);
