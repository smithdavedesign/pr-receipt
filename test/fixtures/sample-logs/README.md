# Sample logs for EC12 (totals agree with ccusage within 5%)

`generate.ts` writes everything in this folder. It's deterministic: running it again changes nothing.

```sh
node --disable-warning=ExperimentalWarning test/fixtures/sample-logs/generate.ts
```

## What's in it

`claude/projects/-home-dev-shop/`: 10 Claude Code sessions (`5e55a000-…-000000000001` … `…010`)
in the current transcript shape. They include the cases where usage tools disagree:

- streamed responses written as 1–3 lines with the same `message.id` + `requestId`, where the early lines
  carry a partial `output_tokens` and only the last one the final count;
- `…010` resumes `…004`: its file starts with a copy of `…004`'s lines (same ids, new session id);
- 1-hour cache writes (`cache_creation.ephemeral_1h_input_tokens`, session `…002`);
- sidechain (subagent) lines in the same file (`…003`);
- a branch switch in the middle of a session (`…005`), a session with no `gitBranch` (`…006`);
- a `<synthetic>` message and a summary line (`…007`), and a half-written last line (`…008`);
- three models: Sonnet 4.5, Opus 4.5 and Haiku 4.5, all with requests under 200K input tokens (no
  long-context tier).

`codex/sessions/2026/10/…`: 3 Codex rollouts:

- `0199b001…` (gpt-5-codex): a repeated `token_count` snapshot whose running total didn't move, a
  rate-limit-only event and a compaction event;
- `0199b002…` (gpt-5.3-codex): one `token_count` without `last_token_usage`;
- `0199b003…`: a fork of `0199b001…`, which starts by replaying its parent's history, snapshots included.

## The reference files

`ccusage-claude-session.json` and `ccusage-codex-session.json` follow the shape of
`ccusage session --json` and `ccusage-codex session --json` (`sessions[]` with `sessionId`,
`totalTokens`, `totalCost` / `costUSD`, plus `totals`).

**They were not captured from a ccusage run.** npm and web fetches were blocked in the sandbox where
this was built, so the generator computes them from the true per-request usage. That is what ccusage's
published rules recover:

- Claude: one count per `message.id` + `requestId`, across files and sessions, keeping the most complete
  copy (ccusage PRs #1661, #1765, #1799, #1838 and issue #888). Cache writes are split into 5-minute
  (1.25× input) and 1-hour (2× input) writes (issue #899). Invalid JSON lines are skipped.
- Codex: `input_tokens` includes `cached_input_tokens`, and `output_tokens` includes the reasoning tokens.
  A snapshot counts only when `total_token_usage` moved (issue #884), and without `last_token_usage`
  the delta of the totals counts. A fork's replayed parent history isn't counted again. Cached input is
  priced at the cache-read rate.
- Prices: LiteLLM / list prices (Sonnet 4.5 $3/$15, Opus 4.5 $5/$25, Haiku 4.5 $1/$5,
  gpt-5-codex $1.25/$10 with $0.125 cached, gpt-5.3-codex $1.75/$14 with $0.175 cached).

`_reference` in each file marks it as derived. To check against ccusage itself, on a machine with
network access, from the repo root:

```sh
CLAUDE_CONFIG_DIR="$PWD/test/fixtures/sample-logs/claude" \
  npx ccusage@latest session --json --mode calculate > test/fixtures/sample-logs/ccusage-claude-session.json
CODEX_HOME="$PWD/test/fixtures/sample-logs/codex" \
  npx @ccusage/codex@latest session --json > test/fixtures/sample-logs/ccusage-codex-session.json
npm test
```

The EC12 test reads those files loosely (`sessions[].sessionId`, `totalTokens`, `totalCost ?? costUSD`,
and the same fields under `totals`). A ccusage session id only has to contain our session id. If a
ccusage version renames these fields, adjust `readCcusage` in `test/exit-criteria-m3.test.ts`.
