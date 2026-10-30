-- Dashboard job popup fetches the full post when only a snippet is stored (2026-10-07).
-- detail_tried_at = last fetch attempt, so a site that blocks us is not re-fetched on every open.
alter table jobs add column if not exists detail_tried_at timestamptz;
