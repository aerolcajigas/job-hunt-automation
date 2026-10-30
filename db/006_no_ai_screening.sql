-- 2026-10-07 (the user): Claude Haiku screening removed. Every job that passes the code filter is a lead ('review').
-- One-off data move, guarded by a settings flag so re-running setup.mjs sql never repeats it.
do $$
begin
  if exists (select 1 from settings where key = 'migr_006_no_ai_screening') then return; end if;
  -- waiting for (or stuck in) screening
  update jobs set status = 'review' where status in ('new', 'scoring');
  -- rejected by Claude (has a fit score) or by repeated scoring failures, on boards still in use
  update jobs set status = 'review', reject_reason = null
  where status = 'rejected' and source not in ('jobicy', 'remoteok', 'wwr')
    and (fit_score is not null or reject_reason = 'scoring failed 3 times');
  -- OnlineJobs.ph jobs cut by the old pay floor (OLJ has no floor now)
  update jobs set status = 'review', reject_reason = null
  where status = 'rejected' and source = 'onlinejobs' and reject_reason like 'pay below floor%';
  insert into settings(key, value) values ('migr_006_no_ai_screening', 'done');
end $$;
