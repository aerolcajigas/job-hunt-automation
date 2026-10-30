-- Questions only the user can answer (from the job post) go to him as a form, and his answers are kept
-- for every later letter (the user 2026-10-23: "if you're in need of additional information just send me a form to fill,
-- and save it for future reference. dont make up facts ok").
--   jobs.questions_from = 'manual' when the post wants a Loom / video or its own form so the user applies himself
--   (questions = the reasons), else the post's own questions.
--   jh_save_answers: each {q, a} becomes a "question -> answer" line in settings.answers_profile (standard answers
--   reused by later letters), replacing an older line for the same question.
alter table jobs add column if not exists questions_from text;

create or replace function jh_save_answers(pairs jsonb) returns int language plpgsql as $$
declare
  x jsonb;
  q text;
  a text;
  n int := 0;
begin
  insert into settings(key, value) values ('answers_profile', '') on conflict (key) do nothing;
  for x in select * from jsonb_array_elements(coalesce(pairs, '[]')) loop
    q := trim(regexp_replace(coalesce(x->>'q', ''), '\s*\(options:.*\)\s*$', ''));
    a := trim(regexp_replace(coalesce(x->>'a', ''), '\s+', ' ', 'g'));
    if q = '' or a = '' then continue; end if;
    update settings set value = concat_ws(E'\n',
        nullif(array_to_string(array(select l from unnest(string_to_array(value, E'\n')) l
          where lower(left(l, length(q) + 4)) <> lower(q || ' -> ')), E'\n'), ''),
        q || ' -> ' || a)
    where key = 'answers_profile';
    n := n + 1;
  end loop;
  return n;
end $$;
