# Verdict: PASS — score 4/10

A weekend-buildable, $0 CLI, but demand is inferred rather than observed, the nearest competitor already does per-branch cost, and nobody has shown they would pay.

## Six Forcing Questions

### Q1 Demand Reality — 3/10
Evidence is adjacent pain, not pull: Anthropic's cost docs (~$13/dev/day, $150–250/dev/month; https://code.claude.com/docs/en/costs), vendor-ish blogs on "zero visibility" per task, and anecdotes (Uber budget, Clawdmeter hardware meter). RESEARCH.md admits "no direct forum thread found specifically asking for per-PR cost." Nobody has paid, asked when it ships, or built a workaround for per-PR cost. That is interest in spend visibility, not demand for a PR receipt. Stronger evidence: a team lead saying "I hand-compute this today", or users installing claude-burn-rate and asking for a PR comment. Would change my mind: 3+ people in a thread asking for per-PR cost unprompted.

### Q2 Status Quo — 4/10
Users already use `/usage`, ccusage and claude-burn-rate (which already does per-branch cost). The gap is the last step: putting the number on the PR. That is a convenience over free tools, not a painful workaround costing hours or dollars. Team admins can also use Anthropic's dashboards and OpenTelemetry. The workaround is "glance at ccusage", which is cheap.

### Q3 Desperate Specificity — 4/10
The PRD names "a developer or tech lead on a small team (1–10 people) on API billing", with the painful moment of a $400 month and no breakdown. That is a category, not a person, and nobody has been spoken to. Subscription users (most solo devs) don't pay per token, so the best-fit user is the narrow set of metered small teams. A named lead whose budget gets questioned would be the right answer; none exists in the evidence.

### Q4 Narrowest Wedge — 6/10
The wedge is sharp and buildable: parse Claude Code JSONL, group by gitBranch, print a markdown receipt (M1). It ships in days. But the thing someone would pay for this week is unclear, because the free `claude-burn-rate` covers the M1 output. The differentiator (the PR comment, M2) is the real wedge, and M1 doesn't test it.

### Q5 Observation (pre-product)
Watch M1 users: do they run `show` on a branch and then paste it into a PR themselves? Do they care about $ per line or only the total? Do they hesitate to publish spend on a PR? Does branch attribution fail on worktrees or renamed branches?

### Q6 Future-Fit — 4/10
Agent spend growing makes cost attribution plausible, but that is a rising-tide argument. Anthropic, GitHub, ccusage or claude-burn-rate can add per-branch or per-PR cost, and the PR attribution feature already exists in Anthropic's analytics (lines, not cost). A feature, not a company; the moat is thin.

## Premises
1. Teams care about cost per PR rather than per day or per user. Unsupported: no direct evidence.
2. Local session logs record gitBranch and cwd reliably. Unverified (open question in the PRD).
3. Developers will publish spend on PRs. Doubtful for public repos; plausible for private team repos.
4. Metered billing is common enough among small teams. Partly supported (Teams/API usage), but many individuals are on flat subscriptions.
5. Willingness to pay exists. Not supported; it is a free-tool market (ccusage, 18.9k stars).

## Alternatives
- **Minimal:** a single-file script or `ccusage` wrapper that groups by branch and prints a PR-ready markdown block (S effort, low risk). Open source it and measure stars, not signups.
- **Ideal:** GitHub Action plus exported JSON, multi-agent, with cost-per-merged-PR trend dashboards (L effort, high risk; hosted, so it conflicts with $0).
- **Lateral / extend existing:** contribute a `--branch`/PR-comment feature to ccusage or claude-burn-rate. Zero distribution cost and the existing audience, but no ownership.
- **David's repos:** the context search shows idea-factory siblings (pr-split) and RepoHQ/Github-HQ; none does cost attribution, and RepoHQ could host a cost panel, but there's no overlap with David's code.

## Narrowest wedge
`prreceipt comment`: a one-command, idempotent PR comment with an aggregate receipt from local logs. Skip the report, Codex and CI Action until someone uses the comment.

## M1 feasibility
- One-weekend build: yes (TypeScript + Node, fixture-based tests, no network).
- $0: yes (local CLI, npm publish is free, `gh` for GitHub I/O).
- The one test that proves M1: the fixture of 3 messages × (1,000 in / 500 out) at $3/$15 per M gives $0.0315 and 4,500 tokens, plus a real-logs check that totals are within 5% of ccusage.
- Hidden risk: whether gitBranch is recorded on every entry.

## Risks
- Free incumbents (ccusage, claude-burn-rate) cover most of the value; Anthropic could add this natively.
- Monetization unclear for a local, open-source CLI; likely no revenue.
- Branch metadata gaps (worktrees, renames) hurt accuracy and trust.
- Subscription users see only an "API-equivalent estimate", which is weaker pain.
- Public-PR privacy concerns.
- Overlaps David's thin interest signal: his bookmarks lean to design, job search and Webflow, not dev cost tooling.

## Kill criteria
Drop it if: after 14 days, fewer than 50 visitors convert at under 5%; or fewer than 3 people in target threads ask for per-PR cost; or branch attribution covers under 80% of sessions on real logs; or claude-burn-rate/ccusage ships PR comments.

## What to watch M1 users doing
See Q5: whether they paste the receipt into a PR, which metric they read first, and whether they ever re-run it.

## Assignment
Before building, post once in the Claude Code and r/ClaudeAI communities asking "how do you track what a PR cost in tokens?" and count unprompted replies.
