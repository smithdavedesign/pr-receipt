# PRD — PR Receipt

## Problem
Coding agents bill by tokens, and a single task can cost 3x–30x another depending on retries and tool calls. Existing tools report spend by day, session or project, but the unit developers and reviewers reason about is the pull request. Nobody can easily answer "what did this PR cost, and was it worth it?" (see RESEARCH.md: Anthropic cost docs, per-task visibility gap).

## Target user
A developer or tech lead on a small team (1–10 people) using Claude Code and/or Codex daily on API billing or usage credits, who has been surprised by a bill and wants spend attributed to the work shipped. Painful moment: end of month, seeing $400 of agent spend with no idea which features caused it.

## Competitors & gap
ccusage (no branch/PR grouping), claude-burn-rate (branch CLI, Claude only, nothing on the PR), Coralogix (hosted, repo-level), Anthropic analytics (per user/day, line attribution not cost). Gap: a PR-native receipt, multi-agent, local-first, with cost-per-merged-PR trends.

## MVP scope
- `prreceipt scan` parses Claude Code local session logs and groups tokens/cost by repo and git branch.
- Pricing table with list prices per model and a user override file for contracted rates; output labelled "API-equivalent estimate".
- `prreceipt show [branch]` prints a receipt: total $, tokens by model, cache hit %, sessions, wall time, $ per changed line.
- `prreceipt comment` posts/updates a single markdown receipt comment on the current branch's PR via `gh`.
- Time-window fallback attribution when branch metadata is missing (first branch commit to last commit/merge).
- `prreceipt report --since 30d` lists cost per merged PR with median and top 5 most expensive.
- Aggregates only: no prompt text is ever written to the comment or to disk.

## Non-goals
- Hosted dashboard, accounts or team servers.
- Enforcing budgets or blocking agent runs.
- Exact billing reconciliation with invoices.
- Judging code quality or "value" of the PR.
- Proxying API traffic.

## Success metrics
- Receipt total is within 5% of `ccusage` session totals on the same logs for 10 sample sessions.
- At least 90% of sessions in the author's last 30 days are attributed to a branch or window (measured by scan's "unattributed" line).
- `prreceipt comment` completes in under 5 s for 1,000 sessions of logs.
- Author uses it on at least 10 real PRs in the first month; at least 3 outside users try it within 60 days of release (adoption proxy, not revenue).

## Open questions
- Does the Claude Code transcript reliably record gitBranch and cwd on every entry?
- Can Codex logs be attributed to branches the same way?
- Should receipts be committed as a file (`.prreceipt.json`) so CI/Action can comment without dev-machine access?
- Is a public PR comment acceptable, or default to a private output?
