-- 2026-10-16 (the user): daily usage report for the portfolio chat, without his own tests. A chat is a test when the
-- browser carries the "me" mark (visit /?me once per device), when it came from the test scripts (ip 'test' or sid
-- 'test-...'), or when its IP is in settings.chat_exclude_ips (comma list; his home IP changes, so the mark is the
-- reliable part). Counters are kept 90 days for the 7-day trend.
alter table chat_usage add column if not exists tester boolean not null default false;
update chat_usage set tester = true where ip = 'test' or sid like 'test-%' or sid like 'live-check-%';
insert into settings(key, value) values ('chat_exclude_ips', '136.158.40.11') on conflict do nothing;

drop function if exists jh_chat_hit(text, text);
create or replace function jh_chat_hit(p_sid text, p_ip text, p_tester boolean) returns jsonb language plpgsql as $$
declare d date := (now() at time zone 'Asia/Manila')::date;
begin
  delete from chat_usage where day < d - 90;
  insert into chat_usage(day, sid, ip, msgs, tester) values (d, left(p_sid, 64), left(p_ip, 64), 1, coalesce(p_tester, false))
  on conflict (day, sid) do update set msgs = chat_usage.msgs + 1, tester = chat_usage.tester or excluded.tester;
  return jsonb_build_object(
    'sid', (select msgs from chat_usage where day = d and sid = left(p_sid, 64)),
    'ip', (select coalesce(sum(msgs), 0) from chat_usage where day = d and ip = left(p_ip, 64) and p_ip <> ''),
    'all', (select coalesce(sum(msgs), 0) from chat_usage where day = d));
end $$;

-- Yesterday (Manila) + the 7 days ending yesterday, real visitors only.
create or replace function jh_chat_report() returns jsonb language sql as $$
  with d as (select (now() at time zone 'Asia/Manila')::date - 1 as day),
  x as (select coalesce(array_remove(string_to_array(replace((select value from settings where key = 'chat_exclude_ips'), ' ', ''), ','), ''), '{}') as ips),
  u as (select c.*, (c.tester or c.ip = any(x.ips)) as mine from chat_usage c, d, x where c.day between d.day - 6 and d.day)
  select jsonb_build_object(
    'day', (select day from d),
    'chats', (select count(*) from u, d where u.day = d.day and not mine),
    'msgs', (select coalesce(sum(msgs), 0) from u, d where u.day = d.day and not mine),
    'visitors', (select count(distinct ip) from u, d where u.day = d.day and not mine),
    'escalated', (select count(*) from u, d where u.day = d.day and not mine and emailed),
    'mine', (select count(*) from u, d where u.day = d.day and mine),
    'week', (select coalesce(jsonb_agg(jsonb_build_object('day', g.day, 'chats', g.chats, 'msgs', g.msgs) order by g.day), '[]')
             from (select s.day::date as day, count(u.sid) filter (where not u.mine) as chats, coalesce(sum(u.msgs) filter (where not u.mine), 0) as msgs
                   from d, generate_series(d.day - 6, d.day, interval '1 day') s(day) left join u on u.day = s.day::date group by s.day) g));
$$;
