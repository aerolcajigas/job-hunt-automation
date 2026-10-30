-- 2026-10-14 (the user): the browser password prompt is replaced by a PIN screen (web/jobs/pin.html). Set your own
-- PIN in settings.dash_pin. 5 wrong tries lock it for 15 minutes. dash_token (the cookie
-- value nginx checks) is written by infra/setup.mjs "web" from ~/.jobhunt.json, never stored in this file.
insert into settings(key, value) values ('dash_pin', 'change-me'), ('login_fails', '0'), ('login_locked_until', ''), ('dash_token', '')
on conflict do nothing;
