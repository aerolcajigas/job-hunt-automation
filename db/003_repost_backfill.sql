-- 2026-10-06: fingerprint jobs inserted before repost detection, then skip reposts that already got screened.
-- Idempotent. Only unscored rows still hold the search snippet, so the fingerprint is taken from them; screened
-- rows are matched by employer + pay text, which is how the first batch's triple post showed up.
update jobs set fp = left(regexp_replace(lower(description), '[^a-z0-9]', '', 'g'), 120)
where fp is null and status = 'new' and length(regexp_replace(lower(coalesce(description, '')), '[^a-z0-9]', '', 'g')) >= 80;

with ranked as (
  select id, row_number() over (partition by coalesce(salary_text, ''), lower(left(title, 0)), source,
           -- same OLJ post under several titles: same pay text and same opening words of the post body
           left(regexp_replace(lower(coalesce(substring(description from position(E'\n\n' in description) + 2), description)), '[^a-z0-9]', '', 'g'), 120)
         order by created_at, id) as rn
  from jobs
  where source = 'onlinejobs' and status in ('review', 'needs_info') and salary_text is not null
)
update jobs j set status = 'skipped', notes = concat_ws(E'\n', j.notes, 'Duplicate post (same employer text), skipped automatically')
from ranked r where r.id = j.id and r.rn > 1;
