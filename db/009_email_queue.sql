-- 2026-10-14 (the user: nothing may spend API credits automatically). "JobHunt / Gmail Watch" no longer asks Claude
-- Haiku to read job-alert emails and employer replies: it stores new emails here, and a local worker on my PC reads
-- them with Claude Code on a claude.ai plan (API actions email_claim / email_result).
-- PC off = the emails wait here until it is back on.
create table if not exists email_queue (
  id          text primary key,           -- Gmail message id
  thread_id   text,
  sender      text,
  subject     text,
  body        text,
  at          timestamptz not null default now(),
  claimed_at  timestamptz,
  done_at     timestamptz,
  result      jsonb
);
create index if not exists email_queue_open on email_queue(at) where done_at is null;

-- p = [{id, thread_id, from, subject, text}]
create or replace function jh_queue_emails(p jsonb) returns int language sql as $$
  with ins as (
    insert into email_queue(id, thread_id, sender, subject, body)
    select e->>'id', e->>'thread_id', e->>'from', e->>'subject', e->>'text' from jsonb_array_elements(p) e
    where coalesce(e->>'id', '') <> ''
    on conflict (id) do nothing returning 1)
  select count(*)::int from ins
$$;
