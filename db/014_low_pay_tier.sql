-- 2026-10-25 (the user): second pay tier. Jobs at $8-11.99/hr (monthly $1,280-1,499) get status 'low_pay' and their own
-- dashboard tab ("Lower pay") instead of 'rejected'. fetch-core.js filterJob sets it for new jobs; the API functions
-- (002) list/count it and let "Write cover letter" turn one into a normal lead.
-- One-off: jobs from the last 3 weeks that the floor rejected inside that band move over. rate_usd_hr is the
-- hourly equivalent (monthly / 160), so rate >= 8 covers both. Guarded so re-running setup.mjs sql never repeats it.
do $$
begin
  if exists (select 1 from settings where key = 'migr_014_low_pay_tier') then return; end if;
  update jobs set status = 'low_pay', reject_reason = null
  where status = 'rejected' and reject_reason like 'pay below floor%'
    and rate_usd_hr >= 8 and rate_usd_hr < 12 and created_at > now() - interval '21 days';
  insert into settings(key, value) values ('migr_014_low_pay_tier', 'done');
end $$;
