# Job Hunt Automation

A pipeline that finds remote jobs, screens them and drafts tailored cover letters, with a phone dashboard where I
review every lead. Built with n8n, Postgres and Claude.

## Pipeline

```
job boards + RSS + job-alert emails
        |  n8n "Fetch" (hourly): dedupe, repost detection, rule-based screening
        v
Postgres (jobs, events, settings)  <->  dashboard (PWA)  <->  me: review / reject / answer questions
        |  letter requested
        v
Claude writes the letter from a claim bank  ->  I apply  ->  status tracked through to interview / offer
        ^
email reader: Claude classifies job alerts and employer replies (alert jobs go through the same filters)
```

- **Fetch** (`n8n/src/fetch-core.js`): pulls from several boards, normalizes them into one shape, drops duplicates and
  reposts, and screens with plain rules (on-site or hybrid, country-locked, other languages, scam signs, too
  senior). Rules in code instead of an LLM screen: free, fast and predictable.
- **Score and letters** (`n8n/src/claude-core.js`, `prompts/`): Claude returns structured JSON (fit score, priority,
  apply method, required phrase, questions only the candidate can answer). Letters may only use facts from a
  claim bank (`prompts/candidate.example.md`), so the model can't invent experience.
- **Questions go to a human.** If a post asks something the profile doesn't cover (rate, video intro, availability),
  the job waits in "Needs you" on the dashboard. My answer is saved as a standard answer for next time.
- **No automatic API spend.** Letters and email reading are queued in Postgres and picked up by a local Claude Code
  worker on my PC (not part of this repo). If the PC is off, the dashboard offers the paid API path as a button.
- **Email applications**: jobs that ask to apply by email are sent through Gmail after I approve the letter, capped
  per day and only during US business hours.
- **Dashboard** (`web/jobs/`): single-file PWA behind nginx + PIN login. Review queue, letters, events timeline, stats.
- **Database** (`db/`): numbered SQL migrations. One `jh_api(action, payload)` function is the whole API, so the n8n
  webhook and the local worker share the same logic.

## Layout

| Path | What |
|---|---|
| `n8n/build.mjs`, `n8n/lib.mjs` | Generate all n8n workflows from `src/` + `prompts/` and deploy them through the n8n API |
| `n8n/src/` | Code that runs inside n8n Code nodes (fetch, detail fetch, Claude calls) |
| `db/` | Postgres schema and API function migrations |
| `web/jobs/` | Dashboard PWA |
| `prompts/` | Generic prompt templates (scoring, letters, portfolio chat) |
| `infra/` | nginx + Dockerfile for the dashboard |

## Setup

1. Copy `prompts/candidate.example.md` to `prompts/candidate.md` and fill in your own details. Adjust the rules in
   `prompts/score.md`.
2. Run the `db/` migrations on a Postgres database.
3. Set `N8N_API_URL` and `N8N_API_KEY`, create the Anthropic / Gmail / Postgres credentials in n8n and put their IDs in
   `n8n/lib.mjs`, then `node n8n/build.mjs`.
4. Secrets (`dash_password`, API secret) go in `~/.jobhunt.json`. Never commit them.

Use it within each job board's terms of service.
