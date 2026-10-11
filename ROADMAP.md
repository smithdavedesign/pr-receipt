# Roadmap — PR Receipt

Suggested stack: TypeScript + Node 20 (same ecosystem as ccusage and `gh` users, easy `npx` distribution); vitest (fast fixture-based tests); `gh` CLI for GitHub I/O (no OAuth app to build); plain JSON price table (auditable, overridable).

## M1 — Local branch receipt (one weekend)
Deliverables:
- Parser for Claude Code session JSONL files from a configurable logs directory.
- Price table + override file.
- `prreceipt show [branch]` CLI printing the receipt in markdown.

Exit criteria:
- Given a fixture log with 3 assistant messages (1,000 input / 500 output tokens each, model priced $3/$15 per M), `show` reports total $0.0315 (±0.0001) and 4,500 tokens.
- Given fixture sessions on branches `feat/a` and `feat/b`, `show feat/a` includes only feat/a sessions (session count equals 2 in the fixture).
- Entries with no gitBranch are listed under "unattributed" and excluded from branch totals.
- An override file changing a model's price changes the total accordingly.
- Running with no logs exits code 0 and prints "no sessions found".

## M2 — Put it on the PR
Deliverables:
- `prreceipt comment` via `gh`, idempotent (updates one comment marked by a hidden HTML tag).
- Time-window fallback attribution using git commit timestamps.
- Changed-lines metric from `git diff --shortstat`.

Exit criteria:
- Running `comment` twice yields exactly one comment (gh mocked: second call is an update, not a create).
- A session without branch metadata whose timestamps fall in the branch's commit window is attributed to it; one outside is not.
- For a fixture diff of 40 changed lines and $0.80 total, the receipt shows $0.02 per changed line.
- Comment body contains no prompt text (test greps fixture prompt strings, expects zero matches).

## M3 — Trends and second agent
Deliverables:
- `prreceipt report --since 30d` (cost per merged PR, median, top 5).
- Codex log parser.

Exit criteria:
- With 6 fixture merged PRs, report prints the median as the mean of the middle two values and lists the top 5 in descending cost.
- A Codex fixture with known tokens yields the expected total; a branch with both Claude and Codex sessions sums both.
- Totals agree with ccusage within 5% on the sample logs.

## M4 — CI-friendly publishing
Deliverables:
- `.prreceipt.json` export committed or attached as an artifact; GitHub Action that renders the comment from it.

Exit criteria:
- Action run against a fixture JSON produces the same markdown as local `show`.
- Missing or invalid JSON fails with a clear message and non-zero exit.
