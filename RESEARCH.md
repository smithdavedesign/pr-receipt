# Research — PR Receipt

## Summary
Teams running coding agents (Claude Code, Codex) can see spend per day, month, session or project, but not "what did this pull request cost?".
The only branch-level tool found is a CLI dashboard (claude-burn-rate) that never reaches the PR, where reviewers and managers decide whether the spend was worth it.
PR Receipt would read local agent session logs, attribute tokens/cost to the git branch, and post a receipt comment on the PR.

## Evidence of the problem
- Anthropic's own docs say average Claude Code cost is ~$13 per developer per active day and $150–250 per developer per month, with 10% of users above $30/day; costs "vary widely based on ... running multiple instances or automation" (https://code.claude.com/docs/en/costs).
- Anthropic's built-in tracking is per session (`/usage`), per user (admin dashboards, spend report CSV), or via OpenTelemetry; none is per branch or PR. Local `/usage` figures are "computed from local session history on this machine" and exclude other devices (https://code.claude.com/docs/en/costs).
- A guide states "most engineering teams have zero visibility into" agent cost per task, that the same task can cost 3x or 30x depending on tool calls/retries, and that teams skipping instrumentation overspend 30–50% (self-reported, vendor-ish: https://www.kunalganglani.com/blog/ai-agent-cost-per-task-2026).
- Reported: Uber exhausted its 2026 AI coding budget in four months and capped tools at $1,500/employee/month; another report cites an OpenClaw maintainer spending >$1.3M in 30 days on ~100 Codex instances (secondhand summaries in search results; treat as anecdotal: https://www.growthaccelerationpartners.com/blog/ai-cost-optimization-and-the-problem-of-runaway-token-costs).
- Developers asking for a "ledger" of per-request model, token counts and limit deltas rather than a progress bar (https://singularitymoments.com/content/clawdmeter-is-the-physical-warning-light-your-api-bill-desperately-needs/). People even build physical usage meters (Clawdmeter), a sign of demand for spend visibility.
- Caveat: no direct forum thread found specifically asking for per-PR cost; the demand is inferred from adjacent complaints.

## Competitors & alternatives
| Name | Price | Gap |
|---|---|---|
| ccusage (https://github.com/ryoppippi/ccusage) | Free, MIT, ~18.9k stars | Reads local data for many agents; groups by day/week/month/session/project/model; no branch or PR grouping, no PR output |
| claude-burn-rate (https://www.producthunt.com/p/claude-burn-rate/claude-burn-rate) | Free CLI (`npx`) | Per-project and per-git-branch cost, Claude Code only, terminal dashboard; doesn't publish to the PR or track cost per merged PR |
| Coralogix Claude Code integration (https://coralogix.com/docs/user-guides/ai/code-agents/claude-code/) | Paid observability platform | Repo-level attribution, hosted/enterprise, heavy for a solo dev or small team |
| Anthropic analytics / Console dashboard (https://code.claude.com/docs/en/costs) | Included with Teams/Enterprise/Console | Per-user and per-day; PR attribution feature labels PRs "claude-code-assisted" and counts lines, not cost; Claude only |
| LiteLLM gateway / OpenTelemetry | Free OSS (self-hosted) | Per-key/user spend; requires infrastructure and doesn't know about git branches |

## Technical notes
- Claude Code stores session transcripts locally; each assistant message carries usage (input, output, cache read/write tokens). Whether every entry records cwd and gitBranch must be verified in an M1 spike. ccusage proves local-log parsing across many agents is feasible.
- Pricing: compute from a list-price table, with an override file for contracted rates (Claude Code itself computes cost "locally from token counts at list price", so the figure is an estimate).
- Attribution: for a PR, collect sessions whose cwd is the repo and whose entries have gitBranch == PR head branch. Fallback: match session timestamps against the branch's commit window.
- Output: markdown receipt (total $, tokens by model, cache hit %, sessions, wall time, $ per changed line), idempotently updated PR comment via `gh`. Logs live on the dev machine, not CI, so a CI Action would read an exported JSON.
- Privacy: only aggregates leave the machine; no prompt content.
- Codex: ccusage supports Codex local data, so a second parser is plausible in M3.

## Risks & open questions
- Branch metadata may be missing or stale for some sessions (renamed branches, worktrees); needs a time-window fallback.
- Subscription users aren't billed per token; "cost" would be an API-equivalent estimate and must be labelled as such.
- Anthropic or ccusage could add branch/PR features; claude-burn-rate already covers branch CLI use.
- Developers may not want spend published on public PRs; make it opt-in and aggregate-only.
- Value for a solo dev is lower than for teams; willingness to pay is unclear.

## Sources
- https://code.claude.com/docs/en/costs
- https://github.com/ryoppippi/ccusage
- https://www.producthunt.com/p/claude-burn-rate/claude-burn-rate
- https://coralogix.com/docs/user-guides/ai/code-agents/claude-code/
- https://www.kunalganglani.com/blog/ai-agent-cost-per-task-2026
- https://www.growthaccelerationpartners.com/blog/ai-cost-optimization-and-the-problem-of-runaway-token-costs
- https://singularitymoments.com/content/clawdmeter-is-the-physical-warning-light-your-api-bill-desperately-needs/
