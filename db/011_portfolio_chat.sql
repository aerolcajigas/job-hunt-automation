-- 2026-10-16 (the user): AI chat on the public portfolio (n8n "JobHunt / Portfolio Chat"). Only counters are kept, never
-- the chat text (he chose "email me the transcript" over logging chats). Limits live in the workflow's Gate node.
create table if not exists chat_usage (
  day date not null,
  sid text not null,
  ip text not null default '',
  msgs int not null default 0,
  emailed boolean not null default false,
  primary key (day, sid)
);
create index if not exists chat_usage_day_ip on chat_usage (day, ip);

-- Count one visitor message, return today's counts (Manila day) for this chat, this IP and the whole site.
create or replace function jh_chat_hit(p_sid text, p_ip text) returns jsonb language plpgsql as $$
declare d date := (now() at time zone 'Asia/Manila')::date;
begin
  delete from chat_usage where day < d - 7;
  insert into chat_usage(day, sid, ip, msgs) values (d, left(p_sid, 64), left(p_ip, 64), 1)
  on conflict (day, sid) do update set msgs = chat_usage.msgs + 1;
  return jsonb_build_object(
    'sid', (select msgs from chat_usage where day = d and sid = left(p_sid, 64)),
    'ip', (select coalesce(sum(msgs), 0) from chat_usage where day = d and ip = left(p_ip, 64) and p_ip <> ''),
    'all', (select coalesce(sum(msgs), 0) from chat_usage where day = d));
end $$;

-- True when this chat may email the owner: one email per chat, at most p_cap per day for the whole site.
create or replace function jh_chat_escalate(p_sid text, p_cap int) returns boolean language plpgsql as $$
declare d date := (now() at time zone 'Asia/Manila')::date;
begin
  if (select count(*) from chat_usage where day = d and emailed) >= p_cap then return false; end if;
  update chat_usage set emailed = true where day = d and sid = left(p_sid, 64) and not emailed;
  return found;
end $$;
