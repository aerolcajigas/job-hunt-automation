-- Letters written on my PC by a local Claude Code worker (his claude.ai plan) instead of the
-- Anthropic API (2026-10-07). letter_request = {kind: write|revamp|answer, feedback, at, claimed_at} while queued.
-- letter_engine: 'local' (PC first, API when the worker has not been seen for 10 min) or 'api' (always n8n + API).
alter table jobs add column if not exists letter_request jsonb;
insert into settings(key, value) values ('letter_engine', 'local') on conflict do nothing;
insert into settings(key, value) values ('worker_last_seen', '') on conflict do nothing; -- heartbeat of the local worker
