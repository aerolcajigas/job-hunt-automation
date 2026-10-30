-- 2026-10-06: jobs from dropped boards that were never screened are retired.
update jobs set status = 'skipped', reject_reason = 'source dropped (Jobicy / Remote OK / We Work Remotely)'
where source in ('jobicy', 'remoteok', 'wwr') and status = 'new';
