# BUILD — PR Receipt

## Plan

Milestone: **M4 — CI-friendly publishing** (ROADMAP.md), the last MVP milestone, built on M1–M3. Planned
with gstack plan-eng-review (Step 0 scope challenge, 1. architecture review, 3. test review), answered
non-interactively. Nobody was asked; every call is written down here or under "Decisions".

### Step 0: Scope challenge

1. **What already solves part of this?**
   - *The receipt itself:* M2's `comment` already builds exactly the receipt a PR should get: sessions in
     this repo and its worktrees, the commit-window fallback, lines changed. `export` reuses that path
     (`buildReceipt` with the same scope) minus the gh lookup, and serializes the `Receipt` object as is. The
     Action renders it with the same `renderReceipt` that `show` uses, so "same markdown as `show`" holds by
     construction rather than through a second renderer. **[Layer 1]**
   - *Posting from CI:* M2's `findPullRequest` + `upsertReceipt` (one marked comment, created once and then
     updated) work unchanged with the `GITHUB_TOKEN`. `gh` is preinstalled on GitHub-hosted runners and reads
     `GH_TOKEN` / `GH_REPO`. `gh pr view <number>` selects the PR exactly. M2 already guards against the PR's
     head branch differing from the receipt's branch.
   - *The Action:* a **composite** action (`action.yml` at the repo root) runs the CLI from the action's own
     checkout. There are zero runtime dependencies, so no `npm install` and no build is needed. Node 24 strips
     the TypeScript types itself, so the action runs `src/bin.ts` directly after `actions/setup-node`. A
     JavaScript action (`runs.using: node24`) would need a committed `dist/`, which is git-ignored and is
     the caller's to commit.
   - *Validation:* `node:fs` + hand-written shape checks, as for gh's JSON in M2/M3. No schema library.
2. **Minimum change set:**
   - `prreceipt export [branch]` writes `.prreceipt.json` at the repository root (`--out` to change it) and
     prints the receipt.
   - `--from <file>` on `comment` (what the Action runs) and on `show` (to preview a file locally).
   - `--pr <number>` on `comment`, because a CI checkout is a detached merge commit with no branch to
     look up.
   - `action.yml`, plus a copyable workflow in `examples/`.
   - `.prreceipt.json` is left out of "lines changed", so committing the receipt doesn't count as work.

   **Deliberately NOT in M4:**
   - Posting on PRs from forks. Their `GITHUB_TOKEN` is read-only, and `pull_request_target` needs a
     separate security design.
   - A job summary, check runs or status badges.
   - Per-branch receipt file names. Two open PRs that both commit `.prreceipt.json` conflict on it;
     this is documented with the fix (export again).
   - Generating the file in CI. CI has no agent logs; "attached as an artifact" is covered by the action's
     `path` input, which can point to a file a previous step downloaded.
   - Signing or verifying the file's numbers. The developer controls their own receipt anyway.
   - npm publish, a release workflow and version tags for the action (deferred, see Distribution).
   - Payments: there is no REVENUE.md, so nothing says who pays or what must exist before charging.
     The MVP ends without a checkout.
3. **Complexity check:**
   - Source: 1 new module (`src/receipt-file.ts`) + `action.yml` (new), with edits to `src/cli.ts` and
     `src/git.ts`. That's 4 files, with 1 new error class and no services.
   - Tests and tooling: a test helper that runs `action.yml`'s steps, the example workflow, the screenshot
     script, `package.json`.
   - Under the 8-file smell.
4. **Search check (WebSearch):**
   - `actions/setup-node` v5 and later run on the node24 runtime (Node 20 left the runners in September 2026).
     The action pins `@v5`, the oldest major that's certain to exist and runs on node24, and turns off
     setup-node's automatic package-manager cache (the user's repo may set `packageManager` without a lock
     file).
   - Composite actions are as open to script injection as workflows **[EUREKA-adjacent, known footgun]**:
     `${{ inputs.x }}` or `${{ github.head_ref }}` inside `run:` is pasted into the shell script, so a branch
     named `$(curl …)` runs. Every value goes through `env:` and is read as a quoted `"$VAR"`, and a test
     fails if any `run:` contains `${{`.
   - Built-ins **[Layer 1]**: `node:fs` (stat, size cap, write), `JSON` (doubles round-trip exactly, so the
     rendered money is identical after the file), `execFile` for gh, `node:test`. The only new dev-only
     packages are `yaml`, so the tests read the real `action.yml`, and `playwright-core` for screenshots.
5. **TODOS:** no TODOS.md. Follow-ups go to "What's left".
6. **Completeness:** in scope because they're cheap:
   - the receipt file is untrusted input on the PR: every field is type-checked; dates must be in Date
     range (otherwise rendering throws); the file is capped at 1 MB; a directory at the path is an error;
   - a future format version gets its own "update prreceipt" message;
   - a stale receipt inherited from `main` lands on another branch's PR → refused, because the PR head ≠
     the receipt branch;
   - no PR number (the workflow ran on `push`);
   - a receipt with 0 sessions posts nothing;
   - running `export` from a subdirectory writes at the repo root;
   - nothing is written when there are no sessions; an unwritable `--out` fails clearly;
   - hostile branch or model names inside the file are sanitized by the existing renderer.
7. **Distribution:**
   - The Action is distributed by the GitHub repo itself: `uses: smithdavedesign/pr-receipt@main`.
     No build step, because the action runs the sources.
   - The CLI's npm publish is still deferred.
   - Version tags (`v1`) for the action are deferred too, so users pin `@main` or a commit SHA; this is
     listed under What's left.

### 1. Architecture review

```
 developer machine                                  GitHub Actions (pull_request, paths: .prreceipt.json)
 ─────────────────                                  ─────────────────────────────────────────────────────
 prreceipt export [branch] [--base] [--out]          actions/checkout   (shallow is fine: no git needed)
   │ logs → parse (M1/M3) → filterByRepo(roots)      uses: smithdavedesign/pr-receipt@main  (action.yml, composite)
   │ git → window + numstat (excl. .prreceipt.json)    ├─ actions/setup-node@v5 (node 24, cache off)
   │ buildReceipt (same as comment, no gh)             └─ bash, values only via env:
   │                                                       node $GITHUB_ACTION_PATH/src/bin.ts
   ├─► stdout: renderReceipt(receipt)  (= show)             comment --from="$PRR_FILE" --pr="$PRR_PR"
   └─► <repo root>/.prreceipt.json                            │
         {"format":"prreceipt/1",                             ├─ receipt-file.ts: stat (exists, file, ≤ 1 MB)
          "exportedAt":"…Z",                                  │    → JSON.parse → shape check → Receipt
          "receipt": { …Receipt… }}                           ├─ gh pr view <n>  (GH_TOKEN, GH_REPO)
         git add + commit + push ───────────────────────────► │    head branch must equal receipt.branch
                                                              ├─ renderReceipt(receipt)   ← same function as show
                                                              └─ upsertReceipt: PATCH ours, else create (M2)
```

- **Boundaries:**
  - `receipt-file.ts` knows the file format only: serialize, read, validate. It doesn't touch gh, git or
    logs.
  - `cli.ts` wires `export` and `--from`. A `--from` run never reads logs or prices, and never runs git.
  - `action.yml` holds no logic beyond passing inputs to the CLI.
- **Data flow / scaling:** the file is a few KB (one row per model). The Action reads one file and makes
  two gh calls (one read, one write). There are no logs in CI, so the PRD's "< 5 s" target is trivially
  met there.
- **Security:**
  - The file comes from the PR, so it's untrusted. Shape and ranges are checked before use, names go
    through the existing markdown sanitizer, and the size is capped.
  - The PR number is validated (`^[1-9][0-9]*$`), and gh gets argument arrays with no shell.
  - The action passes inputs via `env:` only.
  - The workflow example grants `pull-requests: write` + `contents: read` and nothing else.
  - The file holds aggregates only (branch, model and base names, numbers): no prompts, paths or session
    ids. A test greps an exported file for fixture prompt strings and local paths.
- **Production failure scenarios:**
  - The file isn't committed, or the path is wrong → exit 1, "no receipt file at …, run `prreceipt export`".
  - A stale file inherited from `main` (another branch's receipt) → exit 1, "this receipt is for `x`, the
    PR's branch is `y`"; nothing is posted.
  - A newer CLI wrote a `prreceipt/2` file → exit 1 with "update prreceipt or export again".
  - A fork PR (read-only token) → gh's 403 is shown, exit 1 (documented as unsupported).
  - Two pushes at once → the example workflow's `concurrency:` group serializes the runs, so they can't
    both create a comment (M2 review item).
  - The comment written locally by `prreceipt comment` (by the developer) and the Action's (by
    github-actions) are two different authors → two comments. Each one updates only its own. This is
    documented: use one or the other.
  - The receipt is stale vs newer commits → the action logs when it was exported. The receipt shows what
    the developer exported, by design.
- **Distribution architecture:** the action runs straight from the repo at the ref the user pins. Node 24
  comes from setup-node. Nothing is built or published.

### 3. Test review (node:test, `npm test`)

| Exit criterion | Tests (`test/exit-criteria-m4.test.ts`) |
|---|---|
| EC13 the Action run against a fixture JSON produces the same markdown as local `show` | `test/action-runner.ts` reads the real `action.yml` with a YAML parser, checks the setup-node step, evaluates the `${{ }}` expressions it uses (an unknown one fails the test), and runs each `run:` step with bash the way a runner does, with a fake `gh` on PATH. Scenario: a temp repo with commits on `feat/cart`, plus Claude + Codex sessions, a no-branch session in the commit window, one outside it, and another repo's session. `export` writes the file, which is copied into an empty workspace (no logs, no git). The Action's posted body equals marker + `show feat/cart` stdout byte for byte, a second run updates the same comment, and `show --from` and `export`'s stdout are equal too. A committed fixture (`test/fixtures/export/`) renders to its recorded markdown, which pins format v1. |
| EC14 missing or invalid JSON → clear message and non-zero exit | Action runs with: no file, invalid JSON, empty file, a directory, `[]`, `{}`, an unknown format version, a field of the wrong type (message names it), an out-of-range date and an oversized file. Each exits non-zero with the specific message and makes **no gh call at all**. The same through `show --from` in-process. |

Other code paths, each with a test:
- **File format:** round trip (deep-equal `Receipt`, floats exact); pretty-printed with a trailing newline;
  extra fields ignored; every nullable field (window, diff, cacheHitRate, costPerLine, model cost) both ways;
  hostile names in the file sanitized on render.
- **`export`:**
  - writes at the repo root when run from a subdirectory; relative `--out`;
  - repo scope (another repo's same-named branch left out; `--repo` overrides);
  - no sessions → nothing written, exit 0;
  - outside a repo, or on a detached HEAD → exit 1 before scanning logs;
  - no base → warning, file still written; unwritable `--out` → exit 1;
  - no prompt text or paths in the file.
- **`comment --from`:**
  - `--dry-run` prints the body and posts nothing;
  - without `--pr`, the PR is found by the receipt's branch;
  - branch mismatch → nothing posted; 0-session receipt → nothing posted;
  - `--pr` validation; `--pr` without `--from` still checks the head branch.
- **CLI misuse:** `--from` with a branch / `--logs` / `--prices` / `--repo` / `--base` / `--all`, or with
  `report` / `export`; `--out` outside `export`; `--pr` outside `comment`; `export --all` / `--dry-run` /
  `--since`.
- **git:** `.prreceipt.json` is not counted in lines changed, from the repo root or a subdirectory.
- **Action file:** no `${{` in any `run:`; inputs documented; `GH_TOKEN` reaches gh (fake gh checks it);
  `GH_REPO` matches. Example workflow: `pull_request` with a `.prreceipt.json` path filter,
  `pull-requests: write`, a `concurrency` group per PR, and it uses this action.

## M3 plan (built)

Milestone: **M3 — Trends and second agent** (ROADMAP.md), built on M1 + M2. Planned with gstack
plan-eng-review (Step 0 scope challenge, 1. architecture review, 3. test review), answered
non-interactively: nobody was asked, every call is written down here or under "Decisions".

### Step 0: Scope challenge

1. **What already solves part of this?**
   - *Which PRs were merged:* `gh` again (already required by `comment`). `gh pr list --state merged
     --search "merged:>=DATE" --json number,title,url,headRefName,mergedAt,additions,deletions` returns
     the head branch (works for squash and rebase merges, where git history can't tell which branch a
     commit came from) and GitHub's exact diff size. Parsing merge commits from `git log` would miss
     every squash-merged PR, so git isn't used for this. **[Layer 1]**
   - *Cost per PR:* M1's `summarize` (tokens, cost, sessions, unpriced models) is reused per PR. It
     gets exported; no second aggregation path.
   - *Codex logs:* Codex CLI writes `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (default
     `~/.codex/sessions`). Each line is `{timestamp, type, payload}`: `session_meta` (id, cwd,
     `git.branch`, fork parent), `turn_context` (model), and `event_msg` with `payload.type ==
     "token_count"`, which holds `total_token_usage` (running) and `last_token_usage` (this turn).
     `input_tokens` already includes `cached_input_tokens`, and `output_tokens` already includes
     `reasoning_output_tokens`. **[EUREKA]** Summing every `token_count` event, the obvious approach,
     overcounts. Codex repeats snapshots whose running total hasn't moved, and a forked rollout replays
     its parent's snapshots at its head (ccusage issue #884; third-party trackers measured +15% to +33%).
     ccusage now counts `last_token_usage` only when the total moved, and skips the replayed parent
     history. We do the same. The fork replay is handled by keying each snapshot on (root session of
     the fork chain, running total) and reusing the existing dedupe map, so the replayed copies collapse
     onto the parent's originals. That needs no knowledge of where the replay ends inside the file.
   - *ccusage parity:* ccusage's Claude rules match ours already (dedupe on `message.id` + `requestId`
     across files, keep the most complete copy, 1-hour cache writes at 2× input). WebSearch confirmed
     this through ccusage PRs #1661, #1765, #1799, #1838 and issue #899.
2. **Minimum change set:** `prreceipt report [--since 30d]`; a Codex reader chosen per file by
   content, so the same `--logs` flag reads both agents; the Codex sessions dir added to the default log
   dirs; OpenAI prices in `prices.json`; a fixed sample-logs fixture with ccusage reference totals.
   **Deliberately NOT in M3:**
   - commit-window fallback inside `report`. Merged PRs' windows overlap, so one no-branch session
     would be counted on several PRs, and that inflates a sum and a median. `report` counts
     branch-tagged sessions only and shows the rest as "not in any merged PR".
   - filtering PRs by author. PRs with no sessions in these logs (teammates', hand-written) are counted
     in one line and kept out of the median, which handles team repos without an `--author` flag.
   - Codex `archived_sessions/`, zstd-compressed rollouts (`.jsonl.zst`) and the newer compaction
     `token_usage_record` lines.
   - GPT-6 prices. Cached-input rates aren't confirmed, so those models show as "unpriced", with the
     existing hint to add them to a prices file.
   - ccusage's newest dedupe of lines without a `requestId`. An M1 test pins today's behaviour, and
     current Claude Code always writes `requestId`.
   - a `scan` command, charts or per-week buckets.
   - M4 (`.prreceipt.json`, GitHub Action).
   - npm publish and CI (still deferred).
   - payments: there is no REVENUE.md, so nothing says who pays or what must exist before charging.
3. **Complexity check:** 2 new modules (`codex.ts`, `report.ts`) + edits to `parse.ts`, `receipt.ts`,
   `github.ts`, `cli.ts`, `pricing.ts`, `prices.json` = 8 files, no classes, no services. That's at the
   8-file line, not over it. Folding `report.ts` into the 400-line `receipt.ts` would save a file and cost
   readability, so it stays separate.
4. **Search check:** WebSearch was used for the Codex rollout format, ccusage's current counting
   rules and OpenAI list prices (sources under Decisions). WebFetch and the npm registry were denied in
   this sandbox, so **ccusage itself could not be run**. EC12's reference totals are therefore derived
   from ccusage's published rules, not captured from a ccusage run (see Test review and What's left).
   Built-ins **[Layer 1]**: the same `node:readline` streaming, `execFile` for gh, and `node:test`.
5. **TODOS:** no TODOS.md. Follow-ups go to "What's left".
6. **Completeness:** in scope because they're cheap:
   - one branch name reused by two merged PRs (each PR gets the work up to its own merge);
   - work after the merge (not counted for the PR);
   - PRs merged earlier on the day `--since` falls on (GitHub search is per day; we filter on the exact time);
   - the 1,000-result search cap (warned, never silent);
   - hostile PR titles (sanitized, because they go into a markdown table);
   - `0` or unknown lines changed;
   - Codex counter resets, events without `last_token_usage`, rate-limit-only events, unknown models,
     detached `HEAD`, nested forks and spawned subagent threads;
   - a mix of Claude and Codex files in one dir.
7. **Distribution:** unchanged: npm package with the `prreceipt` bin; publish and CI deferred.

### 1. Architecture review

```
 prreceipt report [--since 30d|2w|YYYY-MM-DD] [--logs …] [--prices f] [--repo dir]
        │
        ├─ git.ts ──── repoRoots(cwd): this repo + worktrees (scope; --repo overrides)
        ├─ github.ts ─ listMergedPullRequests: gh pr list --state merged --search "merged:>=DAY"
        │                                      --limit 1000 --json number,title,url,headRefName,baseRefName,mergedAt,additions,deletions
        │              → shape-checked; then filtered on the exact --since time
        ├─ parse.ts ── every *.jsonl under the log dirs; the first record decides the file's format:
        │     ├─ Claude Code line  → parseClaudeRecord (M1)
        │     └─ Codex rollout     → codex.ts reader (per file: session, branch, cwd, model, last total)
        │                             token_count → usage + key "codex:<fork root>:<running total>"
        │                             (same dedupe map as Claude's message.id:requestId)
        └─ report.ts ─ buildReport(entries in repo, merged PRs, prices, since)
              │  bucket entries by branch once; for each head branch, PRs by merge time:
              │    an entry goes to the first PR of that branch merged at/after it (work after the last merge: none)
              │  summarize(bucket) per PR → PRs with sessions: total, median, top 5 by cost
              │  PRs without sessions → one line; repo spend since --since not in any PR → one line
              ▼
           renderReport → markdown on stdout (report never writes to GitHub)
```

- **Boundaries:** `codex.ts` knows the Codex format only. It returns the same `LogEntry` as the Claude
  parser, so receipts, `comment`, the window fallback and `report` all work on Codex sessions with no
  further change. `report.ts` is pure (PR list and entries in, numbers out). `github.ts` stays the only
  module that talks to GitHub. `CliContext` gains an optional `now` so tests pin "30 days ago".
- **Data flow / scaling:** still one O(lines) pass. `report` buckets entries by branch once, so it's
  O(entries + PRs), not entries × PRs. It makes one gh read call and writes nothing. There's a timing
  test at 20,000 lines × 300 PRs.
- **Security:** no shell (argument arrays). The search date is generated, never user text. PR titles
  and branch names from GitHub are sanitized before they enter markdown (pipes, HTML, backticks,
  `@mentions`). The Codex reader never reads message, reasoning or tool payloads, and a test greps for
  fixture prompt strings. No tokens and no network beyond the user's own `gh`.
- **Production failure scenarios:**
  - gh missing / not logged in → exit 1 with gh's message, as in `comment`.
  - More than 1,000 merged PRs in the window (GitHub search cap) → stderr warning to narrow `--since`.
  - Codex changes its rollout format → no usage found for those files, and the receipt simply has no
    Codex rows. Unknown record types are ignored, never mis-parsed as Claude lines (the format is
    decided per file).
  - Codex model not recorded → tokens shown under `codex-unknown-model` as unpriced, never guessed.
  - A forked rollout whose parent file was deleted → the replayed parent snapshots count once, under
    the fork (overcount, documented).
  - A branch name reused across PRs → split at merge times. A PR merged before `--since` isn't listed, so
    its work could land on a later PR with the same branch name (documented).
  - Clock skew between the laptop and GitHub's `mergedAt` → seconds; work in that gap may fall either side.

### 3. Test review (node:test, `npm test`)

| Exit criterion | Tests (`test/exit-criteria-m3.test.ts`) |
|---|---|
| EC10 6 merged PRs → median = mean of the middle two; top 5 in descending cost | fake gh with 6 merged PRs costing $0.10…$1.30 (median $0.40 is neither middle value); `report` prints `Median per PR: $0.4000` and a top-5 table in cost order without the cheapest; library `buildReport` agrees; a PR merged before `--since`, one with no sessions, another repo's sessions and an unmerged branch don't change the numbers; the same through a real process with a fake `gh` on PATH |
| EC11 Codex fixture → expected total; Claude + Codex on one branch sums both | hand-written rollout (repeated snapshot, rate-limit-only event, compaction event) → $0.0450 and 33,000 tokens; `show feat/demo` over the Claude and Codex fixtures → $0.0765, 37,500 tokens, 2 sessions, both models listed; same through `$CLAUDE_CONFIG_DIR` + `$CODEX_HOME` defaults; no Codex prompt text in the posted comment |
| EC12 totals within 5% of ccusage on the sample logs | `test/fixtures/sample-logs`: 10 Claude sessions + 3 Codex rollouts, with streaming copies whose output grows, a resumed session copying earlier requests, 1-hour cache writes, sidechain lines, synthetic messages, a half-written line, repeated Codex snapshots and a fork. Per-session and grand totals (tokens and cost) are within 5% of the reference in ccusage's `session --json` shape. A naive "sum every line" count is shown to miss by more than 5%, so the check has teeth. |

Other code paths, each with a test:
- **Codex reader:** delta fallback without `last_token_usage`, counter reset, `cache_write_input_tokens`,
  model switches, unknown model, `HEAD` / missing git, session id fallback, fork / nested fork /
  spawned-thread dedupe, mixed Claude + Codex dir, no content retained.
- **Prices:** OpenAI snapshot and `openai/` model ids normalize, and Codex models are priced.
- **Since and PR list:** `--since` parsing (days, weeks, dates, invalid); `gh pr list` argument shape and
  output validation (bad JSON, missing fields, non-http URL, bad date).
- **Attribution:** branch reuse split, work after the merge, null timestamps, repo scope.
- **Rendering:** hostile titles, missing / zero lines, no merged PRs, merged PRs but none with sessions,
  the all-PRs table only when there are more than 5.
- **CLI:** misuse (`report` with a branch, `--all`, `--dry-run`, `--base`; `--since` with show/comment),
  outside a repo, gh errors, the 1,000-cap warning, and Codex default-dir resolution.
- **Timing:** 20,000 lines × 300 PRs.

## M2 plan (built)

Milestone: **M2 — Put it on the PR** (ROADMAP.md), built on M1. Planned with gstack plan-eng-review
(Step 0 scope challenge, 1. architecture review, 3. test review), answered non-interactively. Nobody was
asked; every decision is written down here or under "Decisions".

### Step 0: Scope challenge

1. **What already solves part of this?**
   - *Posting the comment:* `gh` does auth, host resolution (github.com and GHES) and fork-aware PR lookup.
     `gh pr view --json comments` already returns every comment with `viewerDidAuthor` and its URL, so a
     single read call finds both the PR and our earlier comment. `gh pr comment --body-file -` creates and
     `gh api --method PATCH …/issues/comments/<id> --input -` updates. `gh pr comment --edit-last` exists
     but edits the user's *last* comment, which may be a human reply, so it isn't idempotent the way EC6
     needs. A hidden marker (`<!-- prreceipt:receipt -->`) is the standard way to do this.
   - *Changed lines:* git computes it. **[EUREKA]** The roadmap says `git diff --shortstat`, but
     shortstat's text is translated by gettext ("3 Dateien geändert…" under a German locale), so parsing it
     breaks for non-English users. `git diff --numstat` gives the same counts in a fixed, machine-readable
     format. Same metric, different flag; recorded under Decisions.
   - *Commit window:* `git log --format='%at %ct' base..branch` lists the branch's own commits.
   - *Receipt, pricing, parsing:* M1's `buildReceipt` / `renderReceipt` are reused as they are. The comment
     body is the `show` receipt plus the marker, so `show` doubles as a preview (no second renderer).
2. **Minimum change set:** `prreceipt comment [branch]`, window fallback inside `buildReceipt` (opt-in
   through a context argument, so M1 callers don't change), a "Lines changed · $ per changed line" receipt
   line, and `--base <ref>` to pick what the branch is compared against.
   **Deliberately NOT in M2:** window fallback in the `--all` overview (it would need a git window per
   branch; the overview stays M1), merged-PR handling (after a merge `base..branch` is empty, so there's no
   window or diff; that belongs to M3's `report`), a public-repo warning or opt-in (PRD open question),
   deleting duplicate receipt comments, `.prreceipt.json` / the GitHub Action (M4), Codex logs (M3), any
   payment (no REVENUE.md), and npm publish / CI (still deferred, see Distribution).
   One small addition: `comment --dry-run` prints the exact body without posting, because REVIEW.md doubts
   people will publish spend on PRs; it's the same code path minus one gh call.
3. **Complexity check:** 2 new source modules (`git.ts`, `github.ts`) + edits to `receipt.ts` and `cli.ts`
   = 4 source files touched, no services, one tiny error class. Under the 8-file / 2-class smell.
4. **Search check:** no web search was run for M2 (M1 used WebSearch for prices only); proceeding with
   in-distribution knowledge of `gh` and git, so gh's flags and JSON shapes still need checking against a
   real gh (see "What's left"). Built-ins used **[Layer 1]**:
   `child_process.execFile` with an argument array for gh (async, with stdin) and `execFileSync` for git
   (as in M1). Known footguns handled: gettext-localised git output (→ numstat), user git config that runs
   external diff drivers or prints signatures (`--no-ext-diff --no-textconv`, `--no-show-signature`),
   option injection through a ref that starts with `-` (rejected; git only ever sees full SHAs after
   `rev-parse --verify`), numeric branch names that `gh pr view` reads as PR numbers (documented), fork PRs
   with the same head branch name (no branch argument → `gh pr view` uses its own fork-aware lookup).
5. **TODOS:** no TODOS.md. Follow-ups go to "What's left".
6. **Completeness:** in scope because they're cheap: worktrees (sessions run in another worktree of the
   same repo count), symlinked repo paths, other people's comments that contain the marker (never edited),
   gh missing / not logged in / no PR (clear exit-1 messages), a branch with no commits of its own (no
   window, no diff line instead of "0 lines"), zero changed lines (no division by zero), and no sessions
   (nothing posted).
7. **Distribution:** unchanged from M1: npm package with a `prreceipt` bin; publish and CI deferred and
   listed under "What's left".

### 1. Architecture review

```
 prreceipt comment [branch] [--base ref] [--dry-run] [--logs …] [--prices f] [--repo dir]
        │
        ├─ git.ts ── currentBranch (moved from cli.ts) · repoRoots (toplevel + worktrees)
        │            resolveCommit (rejects "-…", returns a SHA) · defaultBase (origin/HEAD → main → master)
        │            branchContext(base, branch) → { window: first→last commit time, diff: numstat sums }
        │
        ├─ github.ts ─ Gh = (args, stdin) → stdout     (default: execFile('gh'), 30 s timeout)
        │   findPullRequest:  gh pr view [branch] --json number,url,baseRefName,headRefName,comments
        │   upsertComment:    our marked comment? ── yes → gh api --method PATCH repos/o/r/issues/comments/ID --input -
        │                                         └─ no  → gh pr comment <pr url> --body-file -
        │
        ├─ parse.ts (M1) → entries ──► filter to repo roots (comment only; --repo overrides)
        │
        └─ receipt.ts ── buildReceipt(entries, branch, prices, { window, roots, diff })
                │   branch entries  ∪  window entries: sessions with no gitBranch, cwd inside a repo root,
                │                      whose time span overlaps [first commit, last commit]
                │   unattributed = the null-branch entries that were not picked up
                ▼
            renderReceipt (M1 + "Lines changed · $X per changed line" + "Includes N sessions … by commit window")
                ▼
            "<!-- prreceipt:receipt -->\n" + receipt  ──► gh (or stdout with --dry-run)
```

- **Boundaries:** `git.ts` and `github.ts` are the only modules that spawn processes. `receipt.ts` stays
  pure: it gets the window, the repo roots and the diff as plain data, so attribution is unit-tested without
  git. `cli.ts` wires them; `CliContext` gains an optional `gh` so tests inject a fake GitHub.
- **Base:** `comment` compares against the PR's base branch (`origin/<base>` if fetched, else the local
  branch); `show` uses `--base`, else `origin/HEAD`, else `main`/`master`. No base → no diff line and no
  window fallback (a window without a base would span the whole history).
- **Window rule (decided):** commit times are `min(author, committer)` → `max(author, committer)` over
  `base..branch`, so a rebase (new committer dates) or an amend doesn't shrink the window. Attribution is
  per *session*: a session with no branch, in this repo, whose span overlaps the window is counted whole,
  because the session that creates the first commit starts before it. Only `branch === null` entries are
  ever moved; entries with another branch are never touched.
- **Scope for `comment`:** posting to a repo's PR counts only sessions whose cwd is inside that repo or one
  of its worktrees (`--repo` overrides), so a `feat/login` in another repo doesn't leak in. `show` keeps
  M1's unfiltered default.
- **Data flow / scaling:** unchanged O(lines) parse; git adds ~6 short subprocesses; gh adds 2 network
  calls (one read, one write). PRD target (comment < 5 s on 1,000 sessions) gets a timing test.
- **Security:** no shell anywhere (argument arrays); refs from the user that start with `-` are rejected and
  git only receives SHAs; the comment body is built only from aggregates and log-sourced names that go
  through M1's markdown sanitizer; message content never reaches memory (M1). gh's own auth is used; this
  tool never sees a token.
- **Production failure scenarios:**
  - gh not installed / not logged in / no PR for the branch → exit 1 with gh's message and a hint; nothing posted.
  - Two `comment` runs at once both see no marker and both create → two comments. Low risk for a manual
    CLI; the next run updates the oldest. Listed under Review.
  - Someone else's comment contains the marker → `viewerDidAuthor` is false, so it's left alone and we
    create our own (PATCH would 403 anyway).
  - Base not fetched locally → falls back to the local base branch; neither exists → receipt posted without
    the lines metric and without window fallback, and a stderr note says why.
  - Overlapping windows of two branches → the same no-branch session can appear on both receipts. Each
    receipt says how much came from the window and shows the window, so it's visible, not silent.
  - Locale-translated git output → avoided by numstat.

### 3. Test review (node:test, `npm test`)

| Exit criterion | Tests (`test/exit-criteria-m2.test.ts` unless noted) |
|---|---|
| EC6 `comment` twice → exactly one comment; 2nd call is an update | fake gh in-process: first run = 1 create, second run = 1 PATCH and 0 creates, 1 comment total with the 2nd body; other users' marked comments and unrelated comments untouched; real subprocess run of `bin.ts comment` twice against a fake `gh` executable on PATH |
| EC7 no-branch session inside the commit window → attributed; outside → not | temp git repo with dated commits: in-window session counted (sessions, cost), sessions before/after the window and one from another directory stay unattributed; same through `comment` |
| EC8 40 changed lines, $0.80 → $0.02 per changed line | temp repo: +30 / −10 vs `main`, Haiku 4.5 logs worth exactly $0.80; `show` and the posted comment both say `$0.02 per changed line` |
| EC9 comment body has no prompt text | collects every string under `message.content` / `summary` in the fixture logs and asserts none is in the posted body (create and update), plus a grep for the PROMPT/RESPONSE markers and local paths |

Other code paths, each with a test: numstat parsing (binary files, empty), window from author/committer
times, `resolveCommit` rejecting `-…`, `defaultBase` order, `repoRoots` incl. worktrees, a branch with
no commits of its own, window overlap edge cases (straddling session, null timestamps, outside roots,
no roots), rendering of the lines line (0 lines, unknown) and the window line, `formatUsdShort`,
comment URL parsing (github.com and GHES host), gh error mapping (missing binary, non-zero exit, bad JSON),
`--dry-run`, no sessions → nothing posted, `--all`/`--dry-run` misuse, detached HEAD without a branch,
and the PRD's "< 5 s for 1,000 sessions" timing.

## M1 plan (built)

Milestone: **M1 — Local branch receipt** (ROADMAP.md). Planned with gstack plan-eng-review
(Step 0 scope challenge, architecture review, test review), answered non-interactively.

### Step 0: Scope challenge

1. **What already solves part of this?** ccusage parses the same Claude Code JSONL logs, but it is a
   bundled CLI with no library API and no gitBranch grouping, so depending on it would add a large
   dependency for ~150 lines of parsing. Decision: write our own parser and use ccusage's dedupe key
   (`message.id` + `requestId`) so totals line up with it (needed for the M3 "within 5% of ccusage"
   criterion). Where ccusage keeps the first copy, we keep the largest count of each field; the result is
   the same when copies are identical and correct when early copies have partial usage. Node built-ins cover everything else **[Layer 1]**: `node:util` parseArgs (CLI flags),
   `node:readline` (streaming lines), `fs.readdirSync({recursive})` (finding files), `node:test` (tests),
   `child_process.execFile` (git).
2. **Minimum change set:** a parser, a JSON price table plus an override file, and `prreceipt show [branch]`.
   **Deliberately NOT in M1:** `scan` as a separate command (`show --all`, or `show` outside a git repo,
   prints the all-branches overview with the unattributed row, which covers the "what's here?" need), `comment`/`gh` (M2), time-window
   attribution (M2), `$ per changed line` (M2, needs `git diff`), `report` (M3), Codex logs (M3),
   `.prreceipt.json` export and the GitHub Action (M4), the npm publish pipeline and CI (deferred; see
   distribution below), any network access, accounts or payments (no REVENUE.md exists).
3. **Complexity check:** 4 source modules (`parse`, `pricing`, `receipt`, `cli`) + a 3-line `bin` + `prices.json`.
   No classes or services. Under the 8-file / 2-class smell threshold, so no scope reduction needed.
4. **Search check:** WebFetch is blocked in this sandbox; WebSearch worked and was used to check current
   list prices. Everything else uses in-distribution knowledge of the Claude Code log format.
5. **TODOS:** no TODOS.md exists. New follow-ups go in "What's left" below.
6. **Completeness:** cheap edge cases are in, not deferred: streaming-duplicate dedupe, malformed lines,
   unreadable files, unknown models (shown as "unpriced", never silently $0), 1-hour cache writes,
   Bedrock/Vertex model ids, detached HEAD, override validation.
7. **Distribution:** the artifact is an npm package with a `prreceipt` bin (`npm run build` → `dist/`).
   Publishing to npm and a CI workflow are **deferred** (NOT in scope for M1); BUILD.md documents running it
   from a checkout or via `npm pack`.

### Architecture

```
 --logs DIR | $CLAUDE_CONFIG_DIR/projects | ~/.claude/projects + ~/.config/claude/projects
        │  **/*.jsonl (streamed line by line)
        ▼
 parse.ts ── keeps only sessionId, gitBranch, cwd, timestamp, model, usage counts;
        │    drops message content (no prompt text is ever held or printed);
        │    dedupes streamed copies by message.id:requestId; skips malformed lines
        │  LogEntry[]
        ▼
 receipt.ts ◄── pricing.ts ◄── prices.json (list prices, USD / million tokens)
        │          (normalize model id, merge override field by field, validate)
        │   filter by --repo → bucket by branch (no gitBranch / "HEAD" → unattributed)
        │   → Receipt {cost, tokens by model, cache hit %, sessions, wall time, unattributed}
        ▼
 cli.ts ── parseArgs; branch = argument, else `git symbolic-ref --short HEAD`, else overview (or --all)
        ▼
 stdout: markdown receipt (exit 0)   |  stderr: warnings / errors (bad prices file → exit 1)
```

- **Boundaries:** `parse` knows the log format, `pricing` knows money, `receipt` knows aggregation and
  markdown, `cli` knows argv/env/git. `cli.main()` takes argv, env, cwd, home and output sinks as
  arguments, so tests run it in-process without touching the real home directory.
- **Data flow / scaling:** one pass over all files, O(lines) time; memory is one small record per log
  line. Fine for the PRD's 1,000-session target. Files are streamed, never read whole.
- **Security:** read-only on local files; git runs through `execFile` with an argument array (no shell);
  no network; branch names are escaped before going into markdown.
- **Production failure scenarios:**
  - Claude Code changes its log schema → no usage found. Output says "no sessions found" and the
    number of files scanned, so the failure is visible instead of a fake $0 receipt.
  - A new model is missing from the price table → its tokens are counted and the receipt lists it as
    *unpriced* with a hint to add it to the override file. It is never silently priced at $0 or at a
    sibling model's price (no prefix matching).
  - Streaming writes the same message several times → dedupe by `message.id:requestId`, keeping the
    largest count seen for each token field.
  - Broken JSON line (partial write while a session is running) → skipped and counted on stderr.
  - A typo in the override file → exit 1 with the file path and the offending field.
  - gitBranch missing (old versions, non-git dirs) → shown as "unattributed", excluded from branch
    totals. The M2 time-window fallback will shrink this bucket.

### Test plan (node:test, run with `npm test`)

| Exit criterion | Tests |
|---|---|
| EC1 3 msgs × 1,000 in / 500 out at $3/$15 → $0.0315, 4,500 tokens | receipt numbers (±0.0001) from fixture; CLI output contains `$0.0315` and `4,500` |
| EC2 `show feat/a` only includes feat/a, 2 sessions | session count 2; totals equal feat/a's math; feat/b's cost absent from output |
| EC3 no gitBranch → "unattributed", excluded | branch total excludes it; receipt has an Unattributed line with its tokens/cost; overview has an unattributed row; `HEAD` counts as unattributed |
| EC4 override changes total | override input $6 → $0.0405; override adds a new model (cache prices derived); invalid override → exit 1 with a clear message |
| EC5 no logs → exit 0, "no sessions found" | missing dir, empty dir, branch with no sessions; real subprocess run checks the exit code |

Other code paths covered: dedupe of streamed duplicates, malformed lines, model-id normalization
(date suffix, Bedrock, Vertex), unpriced models, cache-write/read pricing including 1-hour writes,
cache-hit %, wall time, `--repo` filter, current-branch detection from git (plus the detached-HEAD
overview), money/token/duration formatting, `--help` and unknown commands, and a shape check on the
shipped price table.

## What it does now

M1–M4, the whole MVP. Four commands over Claude Code **and Codex** logs, plus a GitHub Action:

- `prreceipt show [branch]` reads the local session logs of both agents and prints a markdown receipt
  for one git branch.
- `prreceipt comment [branch]` puts that receipt on the branch's GitHub pull request through `gh`. The
  first run creates one comment; every later run updates the same comment, which is found by a hidden
  `<!-- prreceipt:receipt -->` tag. Comments by other people are never touched.
- `prreceipt export [branch]` writes the same receipt to `.prreceipt.json` for CI to post (M4).
- **The PR Receipt GitHub Action** (`action.yml`) posts a committed `.prreceipt.json` as that one comment,
  from CI, with the workflow's token. CI needs no agent logs, and the developer needs no `gh` (M4).
- `prreceipt report [--since 30d]` lists what each pull request merged in the window cost, with the
  total, the median per PR and the five most expensive. It only reads from GitHub.

New in M4:

- **`prreceipt export [branch] [--out file] [--base ref]`**
  - Builds exactly the receipt `comment` would post: sessions in this repository and its worktrees
    (`--repo` overrides), the commit-window fallback, and lines changed against `--base`, else
    `origin/HEAD`, `main` or `master`.
  - Writes it to `.prreceipt.json` at the repository root (also from a subdirectory), and prints the receipt
    on stdout, the same markdown as `show`.
  - The file holds aggregates only: the branch, model and base names and the numbers. It contains no
    prompts, responses, paths or session ids.
  - It's pretty-printed JSON, `{"format": "prreceipt/1", "exportedAt": "…Z", "receipt": {…}}`.
  - With no sessions, nothing is written (exit 0). Outside a repo or on a detached HEAD without a branch
    argument, it exits 1 before reading any logs.
- **`--from <file>`** on `show` (print a receipt file) and `comment` (post it).
  - The file is checked field by field. Each problem gets its own message, all with exit 1: a missing
    file, a directory, an empty or oversized file (> 1 MB), invalid JSON, a file that isn't an export, a
    newer format, and a field of the wrong type or range (the field is named).
  - `comment --from` only posts on a PR whose head branch is the receipt's branch, so a receipt inherited
    from `main` can't land on another PR. A receipt with 0 sessions posts nothing.
- **`--pr <number>`** on `comment` picks the PR by number. It's what the Action passes, since a CI checkout
  has no branch. The PR's branch must still match.
- **`action.yml`** is a composite action.
  - It sets up Node 24, which runs the TypeScript sources with no install and no build.
  - It runs `comment --from="$PRR_FILE" --pr="$PRR_PR"` with `GH_TOKEN` and `GH_REPO`.
  - Inputs: `path` (default `.prreceipt.json`, or e.g. a file an earlier step downloaded from an artifact),
    `github-token` (default the workflow token) and `pr` (default the triggering PR).
  - Every value reaches bash through `env:`, never through `${{ }}` in the script.
  - The log says which branch the receipt is for and when it was exported.
- **`examples/prreceipt-workflow.yml`** is the workflow to copy.
  - It runs on `pull_request` when `.prreceipt.json` changes.
  - It has `contents: read` + `pull-requests: write` and nothing else.
  - A `concurrency` group per PR stops two quick pushes from both creating a comment.
- Lines changed and the commit window now leave out a committed `.prreceipt.json`: exporting the receipt
  isn't work on the branch.
- `export` checks its own output with the Action's validator before writing, and writes atomically
  (temp file + rename, which replaces a symlink rather than writing through it). The Action refuses a
  receipt that is a symlink or not a regular file.

The flow:

```sh
# on the PR's branch, on your machine
prreceipt export                         # prints the receipt, writes .prreceipt.json at the repo root
git add .prreceipt.json && git commit -m "PR receipt" && git push
# GitHub Actions (examples/prreceipt-workflow.yml) → uses: smithdavedesign/pr-receipt@main
#   → "posted PR receipt on #42" the first time, "updated …" after each new export
```

New in M3:

- **Codex.** Codex CLI rollouts (`$CODEX_HOME/sessions`, default `~/.codex/sessions`) are read next to
  the Claude Code transcripts, by default and from any `--logs` dir (each file's format is recognised
  by its first record).
  - The session's branch comes from `session_meta.git.branch`, the model from `turn_context`, and the
    tokens from `token_count` events.
  - Cached input is shown as cache reads, and reasoning is already inside output.
  - A repeated snapshot counts once, and a forked rollout doesn't count its parent's history again.
  - Codex sessions show up in receipts, comments, the window fallback and the report like any other.
    A branch worked on by both agents sums both, model by model.
  - OpenAI list prices for the GPT-5.x Codex models are in `prices.json`.
- **`report`**:
  - Merged PRs come from `gh pr list --state merged`, filtered to the exact `--since` time (`30d`, `2w`,
    or a `YYYY-MM-DD` date in UTC).
  - A PR costs the sessions on its head branch, in this repository or its worktrees, up to its merge.
    When one branch name was used for several PRs, each PR gets the work since the previous merge. A PR
    counts at most 90 days of work before its merge. A fork PR whose branch has its base's name (`main` →
    `main`) gets no local sessions, because locally that name is the base branch.
  - Median and top 5 are over the PRs that have sessions in these logs.
  - Merged PRs with no sessions (written by hand, by a teammate, or on another machine) are listed in one
    line. Spend in the repo since `--since` that went into no merged PR (open branches, work after a merge,
    no branch recorded) gets its own line.

What `report` prints (illustrative numbers, the EC10 fixture):

```
## 🧾 PR Receipt report: merged PRs since 2026-09-13 12:00 UTC

- **Merged PRs with agent sessions:** 6 of 7
- **Total:** $3.20 (API-equivalent estimate)
- **Median per PR:** $0.4000

### Top 5 by cost

| # | PR | Branch | Merged | Sessions | Lines changed | $ / line | Cost |
|---:|---|---|---|---:|---:|---:|---:|
| 1 | #102 Search with filters | `feat/b` | 2026-09-25 | 2 | 130 | $0.01 | $1.30 |
| 2 | #104 Checkout flow | `feat/d` | 2026-10-02 | 1 | 400 | $0.002 | $0.8000 |
| 3 | #106 Export orders as CSV | `feat/f` | 2026-10-10 | 2 | 250 | $0.002 | $0.5000 |
| 4 | #103 Cart badge | `feat/c` | 2026-09-28 | 1 | 60 | $0.005 | $0.3000 |
| 5 | #105 Fix login redirect | `feat/e` | 2026-10-06 | 1 | 5 | $0.04 | $0.2000 |

### All 6 merged PRs with sessions, newest first

| PR | Branch | Merged | Sessions | Lines changed | $ / line | Cost |
|---|---|---|---:|---:|---:|---:|
| #106 Export orders as CSV | `feat/f` | 2026-10-10 | 2 | 250 | $0.002 | $0.5000 |
| … |

_1 merged PR had no sessions in these logs: #107._

_Not in any merged PR: 2 sessions · 1,600,000 tokens · $1.60 in this repository since 2026-09-13 12:00 UTC (open or unmerged branches, work after a merge, or no git branch recorded)._

<sub>API-equivalent estimate from local Claude Code and Codex logs, list prices as of 2026-10-13 plus any overrides. Merged PRs come from GitHub via gh; a PR counts the sessions on its branch up to its merge. Generated by prreceipt.</sub>
```

Exit codes for `report`: 0 with a report (also with no merged PRs or no sessions); 1 for misuse (a
branch argument, `--all`/`--dry-run`/`--base`, a bad `--since`), outside a git repo, or a gh error.

Earlier milestones, unchanged:

What a posted receipt looks like (illustrative numbers):

```
<!-- prreceipt:receipt -->
## 🧾 PR Receipt: `feat/cart`

- **Total:** $0.8000 (API-equivalent estimate)
- **Tokens:** 400,000 (input 300,000 · output 100,000 · cache write 0 · cache read 0)
- **Cache hit rate:** 0.0%
- **Sessions:** 2
- **Wall time:** 1h 05m
- **Lines changed:** 40 (+30 / -10 vs `main`) · $0.02 per changed line

| Model | Input | Output | Cache write | Cache read | Cost |
|---|---:|---:|---:|---:|---:|
| claude-haiku-4-5 | 300,000 | 100,000 | 0 | 0 | $0.8000 |

_Includes 1 session · 100,000 tokens · $0.2200 with no git branch recorded, matched by this branch’s commit window (2026-10-02 10:00 → 2026-10-02 12:00 UTC)._

_Unattributed (no git branch): 3 sessions · 28,000 tokens · $0.0840, not included above._

<sub>API-equivalent estimate from local Claude Code and Codex logs, list prices as of 2026-10-13 plus any overrides. Generated by prreceipt.</sub>
```

New in M2:

- **Lines changed and $ per changed line:** insertions + deletions of `git diff --numstat base...branch`
  (three dots, like the PR's "Files changed"). `comment` compares with the PR's base branch
  (`origin/<base>` if fetched, else the local branch); `show` uses `--base <ref>`, else `origin/HEAD`, else
  `main`, else `master`. The line is left out when there's no base, the branch isn't in this repo, or it has
  no commits of its own.
- **Commit-window fallback:** a session with no git branch recorded (old Claude Code versions, detached
  HEAD during a rebase) is added to a branch when it ran inside that repo (or one of its worktrees) and
  its time span overlaps the branch's window, from its first to its last commit (earliest to latest of the
  author and committer times of `base..branch`). The receipt says how much came in this way and shows
  the window. Sessions outside the window stay "unattributed".
- **Repo scope for `comment`:** only sessions whose cwd is inside the repo or its worktrees count, so the
  same branch name in another project doesn't leak onto this PR. `--repo <dir>` replaces that scope.
- **`comment --dry-run`** prints the exact body without posting (it still reads the PR to find its base).
- Exit codes for `comment`: 0 after posting/updating, or when the branch has no sessions (nothing is
  posted); 1 for no branch (detached HEAD), not in a git repo, gh missing / not logged in / no PR, a PR
  whose branch doesn't match the one asked for, or a failed post.

M1's `show` example, unchanged when there's no git data (e.g. run outside the repo):

```
## 🧾 PR Receipt: `feat/a`

- **Total:** $0.0860 (API-equivalent estimate)
- **Tokens:** 20,000 (input 4,000 · output 2,000 · cache write 4,000 · cache read 10,000)
- **Cache hit rate:** 55.6%
- **Sessions:** 2
- **Wall time:** 32m

| Model | Input | Output | Cache write | Cache read | Cost |
|---|---:|---:|---:|---:|---:|
| claude-opus-4-5 | 2,000 | 1,000 | 4,000 | 10,000 | $0.0650 |
| claude-sonnet-4-5 | 2,000 | 1,000 | 0 | 0 | $0.0210 |

_Unattributed (no git branch): 1 session · 400 tokens · $0.0024, not included above._
```

- No branch argument → the current git branch. `--all`, or running outside a git repo / on a detached HEAD
  → a table of every branch (by cost) plus an unattributed row.
- `--repo <dir>` keeps only sessions whose working directory is inside `<dir>` (useful for `main`, which
  exists in every repo).
- `--prices <file>` (or `$XDG_CONFIG_HOME/prreceipt/prices.json`, default `~/.config/prreceipt/prices.json`)
  overrides list prices.
- `--logs <dir>` (repeatable) picks the logs, Claude Code or Codex, and replaces every default. Default:
  `$CLAUDE_CONFIG_DIR/projects` (comma-separated list allowed), else `~/.config/claude/projects` and
  `~/.claude/projects`; plus `$CODEX_HOME/sessions`, else `~/.codex/sessions` (M3).
- Exit codes: 0 for a receipt or "no sessions found"; 1 for usage errors, a bad prices file or a missing
  / invalid receipt file; 2 for an unexpected crash.
- `show` is read-only and offline: no network, nothing written to disk. `export` writes one file and has
  no network. `comment` only talks to GitHub through `gh` (one read, one write), and `report` makes one
  read. No prompt or response text is ever kept, printed, written or posted.

## Run it locally

Requires Node ≥ 22.18 for development: tests and `npm start` run the TypeScript sources directly through
Node's built-in type stripping. The built package (`dist/`) targets Node ≥ 20, but has only been tested on
Node 22.

```sh
npm install                 # dev-only: typescript, @types/node, yaml (tests), playwright-core (screenshots)
npm test                    # 338 tests, node:test (needs git and bash on PATH; gh is faked)
npm run typecheck           # tsc over src + test
npm start -- show --all     # run from source against your own ~/.claude and ~/.codex logs
npm run build               # emit dist/ (bin: dist/bin.js)
node dist/bin.js show feat/my-branch   # or `npm link` once, then `prreceipt show`
CHROMIUM_PATH=/path/to/chromium npm run screenshots   # docs/screenshots/*.png (not part of npm test)
```

M4, the receipt file and the Action, locally:

```sh
npm start -- show                                   # what export will write and the Action will post
npm start -- export                                 # writes .prreceipt.json at the repo root
npm start -- show --from .prreceipt.json            # re-render the file, as the Action will
npm start -- comment --from .prreceipt.json --dry-run   # the exact comment body (reads the PR via gh)
```

The Action's steps are tested by `test/action-runner.ts`. It reads the real `action.yml` and runs its
`run:` steps through bash the way a runner does, with a fake `gh` first on PATH. The screenshot script uses
it too. In a real repository, copy `examples/prreceipt-workflow.yml` to `.github/workflows/`.

Try it on the fixtures:

```sh
npm start -- show feat/a --logs test/fixtures/branches
npm start -- show feat/demo --logs test/fixtures/three-messages --logs test/fixtures/codex   # Claude + Codex
npm start -- show --all --logs test/fixtures/sample-logs                                     # the EC12 sample
```

`report` lists the merged PRs of the repository you run it in, so it needs `gh` (below):

```sh
npm start -- report               # PRs merged in the last 30 days
npm start -- report --since 2w    # or --since 2026-09-01
```

To put a receipt on a real PR, install the GitHub CLI (<https://cli.github.com>, free) and run
`gh auth login` once. Then, inside the repo, on the PR's branch:

```sh
npm start -- comment --dry-run   # see exactly what would be posted
npm start -- comment             # post it; run again after more work to update the same comment
```

The tests never call GitHub: `comment` and `report` take an injectable gh runner, and real-process tests
run against a fake `gh` executable put first on PATH.

To compare with ccusage on your own machine (PRD success metric), run both over the same logs:
`npx ccusage@latest session --json --mode calculate` and `npx @ccusage/codex@latest session --json`, next
to `npm start -- show --all`. Pointing the EC12 test at real ccusage output is described in
`test/fixtures/sample-logs/README.md`.

### Price overrides

Same shape as `prices.json`, USD per million tokens. Each field is merged over the list price. A model
not in the table needs `input` and `output`; if cache prices are left out they default to Anthropic's usual
multipliers (5-minute write 1.25×, 1-hour write 2×, read 0.1× input). Unknown fields, negative or
non-numeric prices are rejected with the file path and field name.

```json
{ "models": { "claude-sonnet-4-5": { "input": 2.4, "output": 12 }, "my-proxy-model": { "input": 1, "output": 4 } } }
```

## Deploy (free tier)

This is a local CLI plus a GitHub Action, so there's nothing to host and it costs $0 to run.
- `comment` and `report` use the user's own `gh` login against GitHub's API, which is free. `comment`
  makes one read and one write per run, `report` one search read.
- **The Action runs on GitHub Actions**, which is free for public repositories and within the free
  minutes of private ones (a run is a few seconds plus setup-node). It uses the workflow's own
  `GITHUB_TOKEN`, so there's still no server, stored secret or paid service.

To deploy the Action:
1. Push this repository to GitHub (`smithdavedesign/pr-receipt`). `action.yml` sits at the root, and
   nothing is built or published: the action runs `src/` from the ref users pin.
2. In a repository that should get receipts, copy `examples/prreceipt-workflow.yml` to
   `.github/workflows/prreceipt.yml`.
3. Optional: tag a release (`v1`) and pin `@v1` instead of `@main` (see What's left).

The CLI's distribution is the free npm registry: `npm run build && npm publish`. `prepack` runs the build
too, and `files` ships only `dist/`, `prices.json` and the README. After that, users run
`npx prreceipt show`. Publishing needs an npm account and a decision on the package name, so it's left to
the owner. Until then, the CLI runs from a checkout (`npm start -- export`, or `npm link`).

This repository has no CI workflow of its own yet.

## Exit criteria

Both M4 exit criteria pass (`test/exit-criteria-m4.test.ts`, one `describe` per criterion). All of M1's,
M2's and M3's still pass, and their test files are unchanged. The only test-infrastructure change is
additive: the fake `gh` executable now also checks `GH_TOKEN` and `GH_REPO` when they're set.

| Exit criterion | Status |
|---|---|
| **M4** EC13 the Action run against a fixture JSON produces the same markdown as local `show` | ✅ pass. The real `action.yml` steps ran through bash against a fake `gh` on PATH, on a workspace holding only the exported file (no logs, no git). The posted body is byte for byte the marker plus `show`'s stdout, for a receipt with every part: lines changed, $ per line, a commit-window session, unattributed spend, and Claude + Codex models. A second run updates the same comment. `export`'s stdout and `show --from` are equal to `show` too. With another repo's same-named branch in the logs it equals `show --repo`. The committed fixture `test/fixtures/export/feat-demo.prreceipt.json` renders to the markdown `show` printed when it was exported. |
| **M4** EC14 missing or invalid JSON fails with a clear message and non-zero exit | ✅ pass. The Action exits 1 with prreceipt's own message (no stack trace) and **no gh call at all** for 11 cases: no file, half-written, empty, a directory, an array, `{}`, a newer format, a cost as text, a model without a name, an out-of-range date, over 1 MB. `show --from` and `comment --from` behave the same in-process. |
| **M3** EC10 6 merged PRs → median is the mean of the middle two; top 5 in descending cost | ✅ pass (`report` in-process and as a real process against a fake `gh` on PATH, plus the library; the $0.40 median is neither middle value; noise PRs and sessions don't move it) |
| **M3** EC11 Codex fixture → expected total; a branch with Claude + Codex sums both | ✅ pass ($0.0450 / 33,000 tokens; feat/demo $0.0765 / 37,500 tokens; through `--logs` and through `$CLAUDE_CONFIG_DIR` + `$CODEX_HOME` / `~/.codex`) |
| **M3** EC12 totals agree with ccusage within 5% on the sample logs | ✅ pass, **against a derived reference**: every one of the 10 Claude and 3 Codex sample sessions, the grand totals and `show --all` are within 5%. A naive count misses by more than 5%. ⚠️ The reference follows ccusage's published rules; it wasn't captured from a ccusage run (npm and web fetches were blocked here). Swapping in real ccusage output is a 2-command step (`test/fixtures/sample-logs/README.md`). |
| **M2** EC6 `comment` twice → exactly one comment; the second call is an update, not a create (gh mocked) | ✅ pass (in-process fake, plus 3 real-process runs against a fake `gh` on PATH) |
| **M2** EC7 no-branch session inside the commit window → attributed; one outside → not | ✅ pass (`show`, `comment` and the library) |
| **M2** EC8 40 changed lines and $0.80 → $0.02 per changed line | ✅ pass (`show` and the posted comment) |
| **M2** EC9 comment body has no prompt text (fixture strings grepped, zero matches) | ✅ pass (create and update bodies; window sessions too) |
| M1 EC1 $0.0315 and 4,500 tokens for 3 × (1,000 in / 500 out) at $3/$15 | ✅ pass |
| M1 EC2 `show feat/a` includes only feat/a; session count 2 | ✅ pass |
| M1 EC3 no gitBranch → "unattributed", excluded from branch totals | ✅ pass |
| M1 EC4 override file changes the total | ✅ pass |
| M1 EC5 no logs → exit 0 and "no sessions found" | ✅ pass |

`npm test`: **338 tests, 338 passing**, 0 skipped, across 14 files (four exit-criteria files, parse,
pricing, receipt, cli, git, github, comment, codex, report, export). `npm run typecheck` and
`npm run build` are clean. `npm run screenshots` produced the six PNGs in `docs/screenshots/`, and each
was checked by eye. The PRD's "`comment` under 5 s for 1,000 sessions" has a timing test (20,000 lines, fake gh), and
`report` has one at 20,000 lines × 300 PRs. Network time isn't included in either.

## Decisions (made without asking)

- **node:test, not vitest.** Node 22 runs `.ts` natively, so `npm test` needs no install and the package has
  zero runtime dependencies. `tsc` is only used to build `dist/` for npm (Node won't strip types inside
  `node_modules`).
- **Attribution is per transcript line, not per session.** A session that switched branches is split
  between them. A session counts toward a branch if it has at least one usage line there. Wall time is
  first→last line of that session on that branch (idle gaps included).
- **`HEAD` counts as unattributed**, like a missing or empty gitBranch (detached HEAD isn't a branch).
- **Tokens = input + output + cache write + cache read**, the same as ccusage's "total tokens". Cache hit rate =
  cache read ÷ (input + cache write + cache read).
- **Cost always comes from tokens × price table**, never from the `costUSD` field older transcripts carry, so
  overrides always apply.
- **Unknown models are never guessed.** Model ids are normalized (date suffix, Bedrock `…-v1:0`, Vertex
  `@date`) and matched exactly; there's no prefix fallback, because e.g. Opus 4 and Opus 4.5 have very
  different prices. Unmatched models are shown as "unpriced" with a hint.
- **Money format:** 4 decimals under $1, 2 above, always en-US separators regardless of locale.
- **`--repo` is opt-in.** The default stays unfiltered so worktrees outside the repo dir still count. M2's
  `comment` will scope to the repo it's posting for.
- **Prices for the Claude 5.x family come from third-party reports.** WebFetch to Anthropic's pricing page
  was blocked in the sandbox; WebSearch results agreed with each other across several sources (Opus 5.5
  $4/$20, cache write $5/$8 (1h), read $0.20; Sonnet 5.5 and Sonnet 5 $2/$10; Fable 5.1 $10/$50, read $0.25;
  Fable 5 read $1; Opus 5 $5/$25; Haiku 4.5 $1/$5). Claude 3.x/4.x entries are long-standing list prices
  (Opus 4.6 / Sonnet 4.6 with slightly less certainty). **Check `prices.json` against
  https://docs.claude.com/en/docs/about-claude/pricing before relying on 5.x numbers.** Sources:
  [benchlm.ai](https://benchlm.ai/anthropic/api-pricing),
  [justinmckelvey.com](https://justinmckelvey.com/blog/claude-opus-5-5),
  [openrouter.ai](https://openrouter.ai/anthropic/claude-opus-5.5),
  [unite.ai](https://www.unite.ai/anthropic-releases-claude-opus-5-5-with-lower-pricing-and-new-safeguards/),
  [venturebeat.com](https://venturebeat.com/technology/anthropics-claude-fable-5-1-and-mythos-5-1-arrive-with-a-75-cost-reduction-for-fable-cache-reads),
  [emergent.sh](https://emergent.sh/learn/claude-fable-5-1-pricing),
  [sentra.app](https://www.sentra.app/articles/claude-api-pricing).
- **M2: `git diff --numstat`, not `--shortstat`.** The roadmap names shortstat, but its summary line is
  translated by gettext, so parsing it breaks under non-English locales. numstat has the same counts
  (insertions + deletions; binary files count 0) in a fixed format. `--no-ext-diff --no-textconv` keep
  user diff drivers out; `--find-renames` makes a pure rename count 0 lines, like GitHub.
- **M2: the window is session-level and overlap-based.** A no-branch session counts whole if its span
  overlaps first→last commit, because the session that makes a branch's first commit starts before that
  commit. Commit times are the min/max of author *and* committer times, so rebases and amends don't shrink
  the window. Only `branch === null` entries ever move, and only from inside the repo or its worktrees.
  If two branches' windows overlap, the same no-branch session can show on both receipts; each receipt
  says how much came from the window.
- **M2: no base → no window and no lines line.** A window from `git log branch` without a base would span
  the whole history. `show` stays quiet about it (outside a repo it's M1's receipt); `comment` says on
  stderr what's missing and still posts.
- **M2: `comment` scopes to the repo, `show` doesn't.** M1 left `show` unfiltered (worktrees outside the
  repo dir); `comment` now includes worktrees through `git worktree list`, so it can safely default to
  "this repository". `show` keeps M1's behaviour so its numbers don't change under existing users.
- **M2: the PR lookup.** No branch argument → `gh pr view` with no selector, so gh's own current-branch
  logic finds fork PRs. With a branch argument, the PR's `headRefName` must equal it, otherwise nothing is
  posted (gh reads `123` as PR #123).
- **M2: always update, even when the body is unchanged.** Matches EC6 ("second call is an update"), costs
  one API call, and keeps the code to one path.
- **M2: the oldest marked comment written by the viewer is the one updated.** Comments without
  `viewerDidAuthor` (older gh) count as ours; if one isn't, GitHub refuses the PATCH and the error is shown.
  Duplicates are never deleted.
- **M2: `@` in model names becomes `_`.** Model names are rendered outside code spans; once posted, an
  `@team` in a proxy's model id would notify people. Branch names were already inside code spans.
- **M2: per-line cost format.** `$0.02`, not `$0.0200`: four decimals under $1 with trailing zeros trimmed
  to the cents. Totals keep M1's format.
- **Added `--all` beyond the roadmap text.** Running the tool here showed that inside a git repo there was
  no way to see which branches have data. The "no sessions found for branch" message now points to it.
- **No payments in M1–M4 (the whole MVP).** There's no REVENUE.md, so nothing says who pays or what must
  exist before charging. No milestone takes money, and no checkout or legal pages were built. REVIEW.md
  calls this a free-tool market and measures adoption, not revenue.
- **M3: merged PRs come from `gh pr list`, not git.** Squash and rebase merges leave no trace of the head
  branch in git history, and GitHub's own diff size (`additions + deletions`) is free in the same call.
  `report` uses one search read (`--state merged --search "merged:>=DAY" --limit 1000`), then filters on
  the exact `--since` time, because GitHub search is per day. Hitting the 1,000 cap prints a warning.
- **M3: a PR costs the sessions on its head branch, in this repo, up to its merge.**
  - When one branch name was used for several merged PRs, each gets the work since the previous one's
    merge.
  - Work after the last merge goes to "not in any merged PR".
  - At most 90 days before the merge count (`PR_LOOKBACK_DAYS`). Otherwise the first PR from a long-lived
    branch (develop → main, main → production) would take every session ever run on it.
  - Lines without a timestamp go to the branch's latest PR.
  - A PR whose head branch has the same name as its base gets no sessions. That's a fork's `main` → `main`
    (found in review): locally `main` is the base, so the maintainer's own work on it isn't the fork's.
    `baseRefName` comes from the same `gh pr list` call.
  - `report`'s gh call gets a 120 s timeout instead of 30 s, because a 1,000-PR search is paged 100 at a
    time.
- **M3: no commit-window fallback in `report`.** Merged PRs' windows overlap, so one no-branch session
  would be counted on several PRs, and that inflates a total and a median. No-branch spend shows in the
  "not in any merged PR" line instead. `comment` receipts still use the window, so a PR's receipt can be
  a little higher than its row in the report.
- **M3: the median and top 5 cover PRs with sessions only.** On a team repo, most merged PRs were written
  on someone else's machine. Counting them as $0 would make the median meaningless, so they're listed in
  one line instead (up to 10 numbers). No `--author` filter was needed.
- **M3: `--since` is `<n>d`, `<n>w` or `YYYY-MM-DD` (00:00 UTC)**, default `30d`, and is shown as a UTC
  time. Months were left out: their length is ambiguous.
- **M3: one `--logs` flag for both agents, format decided per file.** A file is Codex when its first
  record is a known rollout type (`session_meta`, `turn_context`, `event_msg`, `response_item`,
  `compacted`) with a `payload`, and Claude Code otherwise. A Claude line with an unexpected field can't
  flip a file to Codex. Giving `--logs` replaces all defaults (both agents), so fixture runs are hermetic.
  `resolveLogDirs` stays Claude-only (M1 tests pin it), and `resolveCodexDirs` was added next to it.
- **M3: Codex counting rules** (ccusage issue #884 and the trackers cited in the Plan):
  - `input_tokens` includes `cached_input_tokens` (→ cache reads) and `cache_write_input_tokens`
    (→ cache writes, when present); `output_tokens` includes reasoning.
  - A `token_count` counts only when `total_token_usage` changed. A changed total also covers a counter
    restart. It counts `last_token_usage`, or the change in the total when that's missing. Rate-limit-only
    and all-zero events are skipped.
  - The branch is the one at session start (Codex records it only in `session_meta`). Wall time runs from
    `session_meta` to the last counted event.
  - A model that wasn't recorded shows as `codex-unknown-model`, unpriced. ccusage assumes gpt-5 there;
    this tool never guesses (M1 rule).
- **M3: forks are deduped by (fork-chain root, running total)**, not by finding where the replayed head
  ends. The replayed copies of the parent's snapshots get the same keys as the originals, so the
  existing dedupe map drops them, and nested forks and spawned subagent threads work the same way.
  If the parent's rollout isn't among the scanned files (deleted, archived), the replay is counted under
  the fork (overcount, see Review).
- **M3: OpenAI prices.** Standard-tier list prices from OpenAI's model pages as quoted by several
  trackers: gpt-5-codex / 5.1 / 5.1-codex(-max) $1.25 / $10 with $0.125 cached; 5.1-codex-mini and
  5-mini $0.25 / $2; 5.2 / 5.2-codex / 5.3-codex $1.75 / $14; 5.4 $2.50 / $15; 5.5 $5 / $30; 5.6-sol
  $5 / $30 (a promotional $4 / $20 was reported); 5.6-terra $2 / $12; 5.6-luna $0.20 / $1.20.
  Cache writes cost 1.25× input from GPT-5.6 on, and equal input before. GPT-6 models are left out
  because their cached-input prices aren't confirmed. **Bare `gpt-5` is left out too**, because an M1 test
  uses it as its "unknown model" example and earlier milestones' tests aren't edited. It's deprecated,
  and Codex moved to gpt-5-codex in September 2025; an override adds it. Normalization now drops an
  `openai/` prefix and an OpenAI snapshot date (`-2025-08-07`). Sources:
  [devtk.ai](https://devtk.ai/en/models/gpt-5-2-codex/), [eesel.ai](https://www.eesel.ai/blog/gpt-5-6-pricing),
  [cloudzero.com](https://www.cloudzero.com/blog/gpt-5-6-pricing/),
  [pricepertoken.com](https://pricepertoken.com/pricing-page/model/openai-gpt-5.1-codex),
  [openrouter.ai](https://openrouter.ai/openai/gpt-5.3-codex),
  [developers.openai.com](https://developers.openai.com/api/docs/models/gpt-5-codex).
- **M3: EC12's reference is derived, not captured.** Running ccusage was impossible here (npm registry
  and WebFetch denied). A deterministic generator (`test/fixtures/sample-logs/generate.ts`) writes realistic
  logs with every case where tools disagree, and computes the reference from the true per-request usage
  with its own copy of list prices, without going through `src/`. ccusage's published rules recover
  exactly that usage. The files carry an `_reference` note and use ccusage's JSON shape, so real output
  can replace them as is. Sources for the rules: ccusage
  [#884](https://github.com/ccusage/ccusage/issues/884),
  [#888](https://github.com/ryoppippi/ccusage/issues/888),
  [#899](https://github.com/ryoppippi/ccusage/issues/899),
  [#1661](https://github.com/ccusage/ccusage/pull/1661),
  [#1765](https://github.com/ccusage/ccusage/pull/1765),
  [#1838](https://github.com/ccusage/ccusage/pull/1838), the [ccusage Codex guide](https://ccusage.com/guide/codex/),
  and on the Codex format [dev.to](https://dev.to/milkoor/reverse-engineering-codex-cli-rollout-traces-3b9b),
  [relayhistory #210](https://github.com/AgentWorkforce/relayhistory/issues/210) and
  [agentsview #2161](https://github.com/kenn-io/agentsview/issues/2161).
- **M3: ccusage's newest rule for lines without a `requestId` is not adopted.** It dedupes `msg_` ids per
  session. The M1 test "does not dedupe lines without both ids" pins today's behaviour, and current
  Claude Code always writes `requestId`, so only very old logs could differ.
- **M4: the file holds the `Receipt` object itself**, not raw usage. The Action renders it with the same
  `renderReceipt` as `show`, so "same markdown" holds by construction, and prices or logs are never needed
  in CI. JSON round-trips every double exactly, so the money matches to the last digit.
- **M4: `export` builds what `comment` would post**: this repo and its worktrees, base from `--base`, else
  `origin/HEAD`, `main` or `master`. It doesn't use plain `show`'s unscoped default, because the file gets
  published on a PR and another repo's same-named branch must not leak in (M2's reasoning). When every
  session is in the repo (the usual case) that's identical to `show`. Otherwise it equals `show --repo .`.
  `export` prints the markdown too, so the developer sees exactly what will be posted.
- **M4: `export` writes at the repository root by default**, wherever it's run from, because that's where
  the Action looks. `--out` takes any path (relative to the working directory) but doesn't create
  directories. A path that can't be written is exit 1.
- **M4: no sessions → nothing written, exit 0** (like `comment`'s "nothing posted"). A 0-session file would
  only post "no sessions found" on the PR.
- **M4: format `prreceipt/1`, versioned, unknown fields ignored.**
  - A reader refuses any other version with "update prreceipt or export again", rather than guessing.
  - Every known field is type- and range-checked, because in CI the file comes from the PR. Times must be
    inside Date's range (outside it, rendering throws); `asOf` must be a plain date (it's printed
    unescaped in the footer); the file is capped at 1 MB.
  - Names printed outside code spans (model and unpriced names) must look like model ids:
    `[A-Za-z0-9._:/@+-]`, at most 200 characters, with no `://` and no leading `www.`. A receipt therefore
    can't put links, images, autolinked URLs or `#123` references into a comment the bot posts. API,
    Bedrock (ARN), Vertex and proxy ids all fit. Branch and base names are rendered in code spans; they
    only need to be free of control characters.
  - A byte-order mark is accepted. A JSON error reports only where the file broke, never its text: in CI
    that text could be anything.
  - `export` runs the same check on what it's about to write. A model id that couldn't be posted fails
    locally ("can't export: …") instead of in CI, so the validator never rejects a file `export` wrote.
    Token counts may be fractional, as logs can be.
- **M4: no symlinks, both ways.** The Action reads the receipt with `lstat` and refuses a symlink or
  anything that isn't a regular file. Otherwise a PR could commit `.prreceipt.json -> /proc/self/environ`
  or `-> /dev/zero`. `export` writes a temp file and renames it into place, so a symlink shipped in a
  clone is replaced, not written through to its target.
- **M4: `comment --from` only posts when the PR's head branch is the receipt's branch.** A
  `.prreceipt.json` merged into `main` is inherited by every later branch. The `paths:` filter skips it
  while it's unchanged, and the branch check refuses it when it isn't.
- **M4: `--pr <number>` for CI.** The Action's checkout is a detached merge commit, so there's no branch to
  look up. `--pr` also works without `--from`, still with the head-branch check.
- **M4: a composite action that runs `src/` on Node 24.** A JavaScript action (`using: node24`) would need
  a committed `dist/`, which is git-ignored here and the caller's to commit. Node ≥ 22.18 strips types
  itself, so there's no install or build in CI, and there are zero runtime dependencies.
  `actions/setup-node@v5` is the oldest major that runs on node24, whose existence is certain.
  `package-manager-cache: false` keeps setup-node from looking for a lock file in the user's repo.
  Sources: [actions/setup-node](https://github.com/actions/setup-node),
  [setup-node releases](https://github.com/actions/setup-node/releases),
  [Node 24 migration](https://tenki.cloud/blog/migrate-github-actions-node-24); on composite-action
  injection: [GHSA-7x29-qqmq-v6qc](https://github.com/ultralytics/actions/security/advisories/GHSA-7x29-qqmq-v6qc),
  [egui #5458](https://github.com/emilk/egui/issues/5458), [github/docs #29817](https://github.com/github/docs/issues/29817).
- **M4: no `${{ }}` inside `run:`.** All values go through `env:` and are read as quoted `"$VAR"`, which
  is GitHub's hardening guidance for composite actions as well as workflows. `--from="$PRR_FILE"` (with
  `=`) means a path that starts with `-` is still a path. Tests enforce the rule and pass a
  `$(touch pwned)` path and a `--help` path.
- **M4: the example workflow skips fork PRs** (`if: head.repo.full_name == github.repository`), because
  their read-only token can't comment. Skipping them shows a neutral check instead of a red one.
- **M4: the "exported at" note goes to stderr**, so `comment --from --dry-run` on stdout is exactly the body.
- **M4: lines changed and the commit window leave out the root `.prreceipt.json`** (pathspec `:/` minus
  `:(top,exclude).prreceipt.json`). Committing the receipt doesn't inflate the count, deflate $ per
  line, or stretch the window.
  - Both git calls run from the repository's top level, so a `diff.relative` setting can't narrow them
    to the working directory. `git log` uses `--full-history`, so no merge side is pruned.
  - Commits that change nothing else, empty ones included, no longer extend the window.
  - A file written elsewhere with `--out` is counted.
  - `report` still uses GitHub's own additions/deletions, which include a committed receipt (a few dozen
    lines).
- **M4: dev-only `yaml` and `playwright-core`.** `yaml` lets tests read the real `action.yml` and the
  example workflow instead of a hand-written copy. `playwright-core` drives the system Chromium for
  `npm run screenshots` and never downloads a browser. Both work without install scripts.
- **M4: `report --base` keeps M3's error text** ("--base only works with show and comment"), with
  "(and export)" added, because an M3 test pins the wording.

## Infrastructure

None requested for M1–M4, so no `.provision` file was written.
- `comment` and `report` talk to GitHub through the user's own `gh` login.
- The M4 Action uses the `GITHUB_TOKEN` that GitHub Actions gives every workflow run; the workflow grants
  it `pull-requests: write`. Nothing is stored, and the code never sees a token value: gh reads it from
  `GH_TOKEN`.
- There's no GitHub App, OAuth app, database, API key or Vercel project. Codex support reads local files
  only.
- No payments: there is no REVENUE.md, so nothing says who pays or what must exist before charging. The
  MVP has no checkout, pricing page or legal pages; REVIEW.md expects no revenue from a free-tool market.

## What's left

- **Run the Action on real GitHub.**
  - It was tested by running `action.yml`'s steps locally through bash against a fake `gh`, with no
    network here.
  - Not checked for real: `actions/setup-node@v5` on a hosted runner; `gh pr view <n> --json comments` and
    `viewerDidAuthor` with the workflow's bot token; `gh pr comment` / `gh api --method PATCH` with
    `pull-requests: write`; the `paths:` filter's behaviour.
  - First run: push this repo, copy `examples/prreceipt-workflow.yml` into a scratch repo, open a PR with
    an exported `.prreceipt.json`, push twice, and check that one comment is created and then updated.
- **Fork PRs.** Their `GITHUB_TOKEN` is read-only, so the example workflow skips them. Without that `if:`,
  posting fails with gh's 403 (exit 1). `pull_request_target` would work if it never runs PR code, but
  that needs its own security review.
- **Version tags for the Action.** Users pin `@main` or a SHA today. Add a `v1` tag (and move it on
  releases) once it has run on real GitHub.
- **Per-branch receipt files.** Two open PRs that both commit `.prreceipt.json` conflict on it when the
  second one merges. The fix is to export again on the second branch (or take theirs). A
  `.prreceipt/<branch>.json` layout would avoid the conflict; changesets does this.
- **Stale receipts.** The Action posts what was exported. It logs when, but it doesn't compare with newer
  commits on the PR.
- The developer's local `comment` and the Action's comment have different authors, so a PR can carry both.
  Each updates only its own. Use one or the other.
- **Check EC12 against a real ccusage.** Run the two commands in `test/fixtures/sample-logs/README.md`
  on a machine with network access, then `npm test`. Also compare `show --all` with
  `ccusage session` / `ccusage-codex session` on real logs (PRD success metric).
- **`report` against real GitHub.** gh's `pr list --state merged --search … --json …mergedAt,additions,deletions`
  shape was taken from gh's documentation and mirrored in the fake. The first real run should be
  `report --since 7d` in a repo with a few merged PRs.
- **Codex format drift.** Built from third-party descriptions of rollouts (Codex 0.130–0.160) and a
  hand-written fixture. Not covered:
  - zstd-compressed `.jsonl.zst` rollouts and `archived_sessions/`;
  - the newer compaction `token_usage_record` lines (a small undercount on compaction-heavy sessions);
  - a branch switch in the middle of a Codex session (the start branch keeps the whole session).
- **A PR's own commit range for `report`** (gh `commits` or local `git log base..head`) would replace
  the 90-day lookback for long-lived head branches, and would allow a window fallback per PR without
  double counting.
- **Not verified against real GitHub.** `gh` isn't available in this sandbox, so `comment` was tested
  against a fake that copies gh's argument and JSON shapes (`pr view --json …comments`, `pr comment
  --body-file -`, `api --method PATCH … --input -`). The first real run should be `comment --dry-run`,
  then `comment` twice on a scratch PR to confirm it updates in place.
- **Not verified on real logs** (from M1): the first real-machine run should confirm gitBranch is on most
  lines and compare totals with `ccusage session`. M2's window fallback only matters for lines without it.
- Not in M2 on purpose: window fallback in `show --all`, a warning or opt-in before posting on a public
  repo (PRD open question), cleaning up duplicate receipt comments.
- Long-context surcharges (Claude >200K, GPT-5.5+ >272K input), batch / flex / priority tiers, fast mode
  and regional multipliers are not priced.
- npm publish, a CI workflow for this repository, and Windows path testing are not done.

## Review

### M4 review

The tree is still untracked (the caller commits), so `git status` lists everything as new and `git diff`
only shows README.md. I read the M4 files directly:
- new: `src/receipt-file.ts`, `action.yml`, `examples/prreceipt-workflow.yml`, `scripts/screenshots.mjs`,
  `test/action-runner.ts`, `test/exit-criteria-m4.test.ts`, `test/export.test.ts`, `test/fixtures/export/`;
- changed: `src/cli.ts`, `src/git.ts`, `test/fake-gh-bin.ts`, `test/helpers.ts`, `package.json`,
  `README.md`.

The checks were gstack's pre-landing checklist with the Fix-First heuristic. A second, independent review
by a fresh agent covered the same files and checklist and found 1 P2 and 8 P3 issues, no P1. I found one
more P2 myself first. Every security / trust-boundary finding was fixed: the receipt file is untrusted input
in CI, so nothing about it can wait. Each fix got a test that failed first. `npm test` afterwards: 338/338.
Typecheck, build and `npm run screenshots` are clean. The M1–M3 test files are unchanged.

**Pass 1 — CRITICAL**

- SQL & data safety: not applicable (no database).
- Race conditions: **mitigated.** [P2] (confidence: 8/10) `src/github.ts` `upsertReceipt` is still
  find-then-create (M2). The example workflow's `concurrency:` group serializes runs per PR, and a test
  checks the workflow has it. A user workflow without that group could still create two comments when two
  runs start at the same moment. A composite action can't set concurrency itself.
- Unsafe rendering: **fixed.** [P2] (confidence: 9/10) `src/receipt-file.ts`: `receipt.asOf` went into the
  footer unescaped (it normally comes from `prices.json`). A file from a PR could put any markdown in a
  comment the bot posts. It must now be `YYYY-MM-DD`. Found in self-review; test added.
- Unsafe rendering: **fixed.** [P2] (confidence: 8/10) `src/receipt-file.ts`: model and unpriced names
  are printed outside code spans. The sanitizer removes `` ` | < > \ @ `` and control characters, but not
  link/image syntax, bare URLs or `owner/repo#1` references. Names from the file must now look like model
  ids (see Decisions), and `export` applies the same check before writing. Found by the independent
  review; 6 tests added (link, image, URL, `www.`, `#ref`, real Bedrock/Vertex/proxy ids accepted).
- Untrusted file access: **fixed.** [P3→treated as P2] (confidence: 8/10) `src/receipt-file.ts`:
  - `stat` followed symlinks, so a committed `.prreceipt.json -> /proc/self/environ` passed the size cap
    (procfs reports 0 bytes).
  - V8's JSON error then quoted the start of the file into the Actions log, and `-> /dev/zero` made it
    read up to 2 GiB.
  - Now: `lstat`, refuse symlinks and non-regular files; JSON errors give only the position.
  - Separately, `export` wrote through a symlinked `.prreceipt.json` in an untrusted clone, overwriting
    the link's target. It now writes a temp file and renames it into place.
  - Tests added for all three.
- Structured input: every field of the file is type- and range-checked before use. A failing check names
  the field and exits 1, with no gh call. **Fixed:** branch and base names with NUL or other control
  characters reached `execFile` and crashed with exit 2 (`comment --from` without `--pr`). They're now
  rejected. Test added.
- Shell injection: none.
  - `action.yml` passes every value through `env:` and quotes it, and a test fails if any `run:`
    contains `${{`.
  - **Fixed:** a `path` input starting with `-` was read as an option (`--from "$X"` → `--from="$X"`).
    Test added.
  - gh gets argument arrays; `--pr` must be digits.
- Enum/value completeness: I read every consumer of the new values.
  - The `export` command and the `--from` / `--out` / `--pr` flags go through each check in `main()` and
    `misuse()`: positional count, `--all`, `--dry-run`, `--since`, `--base`, the report-only checks, the
    early repo/branch checks, and dispatch. Every misuse case has a test.
  - `FORMAT` is checked in one place; other versions get their own message.
  - `lookUpPullRequest` / `post` (refactored out of `comment`) keep M2's messages, which M2's tests pin.

**Fixed during review (auto-fix)**

- `src/git.ts`:
  - The commit-window `git log` had no pathspec, so the commit that adds the receipt stretched the window.
    It now uses the same pathspec as the diff, with `--full-history`.
  - Both calls run from the repo's top level, because with `diff.relative=true` a subdirectory narrowed
    lines changed even with `:/`.
  - Tests added for both.
- `test/fake-gh-bin.ts`: in CI mode the fake now requires `GH_REPO`, as real gh does in a workspace without
  a GitHub remote. Before, deleting `GH_REPO` from `action.yml` kept every test green. A test now proves
  it's needed.
- `examples/prreceipt-workflow.yml`: fork PRs are skipped with `if:` instead of failing red (test updated).
- A UTF-8 BOM (hand-edited file) is accepted instead of being "not valid JSON".
- `test/export.test.ts`: the "no PR number" Action test passed `undefined` to a defaulted parameter, so it
  ran with a PR. Fixed before the first green run.

**Pass 2 — informational, left as is**

- [P3] (confidence: 6/10) `action.yml`: `actions/setup-node@v5` is a movable tag, not a commit SHA. It also
  switches the rest of the caller's job to Node 24. Pinning by SHA is stricter but needs updating by hand;
  documented here.
- [P3] (confidence: 6/10) `src/cli.ts` `exportReceipt`: `export` compares with `origin/HEAD`, `main` or
  `master`, not the PR's base (there's no gh call). For PRs into a release branch, pass `--base`. The help
  says what the default is.
- [P3] (confidence: 5/10, medium, verify) `src/receipt-file.ts`: only the last path component is checked
  for a symlink. With the default `path` input, the file is at the workspace root, so this is complete. A
  custom `path` under a directory the PR replaced with a symlink would still be followed, though the
  target would have to be named like the input.
- [P3] (confidence: 5/10) `action.yml` `path` input: in a `workflow_run` setup fed by an artifact, the PR
  number must come from the trusted event, not from the artifact. Otherwise a spoofed number plus a
  matching branch name could update another PR's receipt. This is documented for whoever builds that
  setup; the example uses `pull_request`.
- [P3] (confidence: 6/10) Two open PRs that both commit `.prreceipt.json` conflict on it (What's left:
  per-branch file names).
- [P3] (confidence: 5/10) The receipt shows what was exported. Newer commits on the PR aren't compared;
  the action logs the export time.
- Time-window safety: `exportedAt` and the window are UTC epoch ms, printed in UTC.
- Distribution: the Action runs from the repo at the pinned ref, with no build. There are no tags or release
  workflow yet, and npm publish and this repo's own CI are still deferred (What's left).

### M3 review

The tree is still untracked (the caller commits), so `git status` lists everything as new and `git diff`
only shows README.md. I read the M3 files directly:
- new: `src/codex.ts`, `src/report.ts`, the three new test files, the fixtures and the generator;
- changed: `src/parse.ts`, `src/receipt.ts`, `src/github.ts`, `src/cli.ts`, `src/pricing.ts`,
  `prices.json`, `test/fake-gh.ts`, `test/helpers.ts`.

The checks were gstack's pre-landing checklist with the Fix-First heuristic. A second, independent review
by a fresh agent covered the same files and checklist and found 2 P2 and 10 P3 issues, no P1. Nobody can
be asked, so I made the ASK calls myself and wrote them down. `npm test` was rerun after the fixes:
239/239. Typecheck and build are clean. The M1 and M2 test files are unchanged.

**Pass 1 — CRITICAL**

- SQL & data safety: not applicable (no database).
- Race conditions: none. `report` is read-only on GitHub and on disk.
- Wrong-target attribution: **fixed.** [P2] (confidence: 7/10) `src/report.ts` `attribute`: a fork PR
  `main` → `main` matched the maintainer's own local `main` sessions by branch name, which inflated that
  PR, the total and the median. A PR whose head and base names are equal now gets no sessions, so it's
  listed as "no sessions", and the work stays in "not in any merged PR". Test added.
- Wrong-target attribution: **mitigated.** [P2] (confidence: 7/10) `src/report.ts`: the first PR from a
  long-lived branch (develop → main release) had no lower bound and took every session ever run on that
  branch. Now at most 90 days before the merge count. The exact fix (the PR's own commit range) is in
  What's left. Test added.
- Unsafe rendering: **fixed.** [P3] (confidence: 6/10) `src/receipt.ts` `safeText`: PR titles (new, from
  GitHub) and branch names went through a sanitizer that missed C1 controls (U+0080–U+009F, e.g. CSI) and
  bidirectional overrides (U+202A–U+202E, U+2066–U+2069). Both are replaced now. The bidi class is built
  from code points so the source has no invisible characters. Test added.
- Structured tool output: `gh pr list` JSON is shape-checked per item (integer number, http(s) URL,
  string head/base, a parseable `mergedAt`, non-negative or missing diff counts). Anything else is a
  `GhError`, exit 1. Tests cover each rejection.
- Untrusted lookup: **fixed.** [P3] (confidence: 8/10) `src/pricing.ts` `findPrice`: a model named
  `constructor` / `__proto__` / `toString` resolved to an inherited object property, so every cost became
  `$NaN`. Codex's `turn_context.model` is a new place such names can come from. The lookup is now
  own-property only. Test added.
- Shell injection: none. gh runs through `execFile` with an argument array. The `--search` value is
  built from a `Date`, never user text, and `--since` is validated before anything runs.
- Enum/value completeness: I read every consumer.
  - The new command `report` is handled in each `main` check (positional, `--all`, `--dry-run`, `--base`,
    `--since`), in USAGE and in dispatch.
  - Codex `LogEntry`s have `cacheWrite1h = 0`, a possibly null `cwd` / `timestamp`, and
    `codex-unknown-model`. They flow through `summarize`, `matchWindow`, `buildOverview`, `filterByRepo`
    and `report`'s attribution, each of which handles them.
  - The per-file format flag (`undefined | null | reader`) is decided once per file.

**Fixed during review (auto-fix)**

- `src/codex.ts` `isCodexRecord`: a file was read as Codex if its first record had any `type` +
  `payload`. It now needs one of Codex's five record types, so a future Claude Code field can't silently
  drop a whole Claude file. Test added.
- `src/cli.ts`: outside a git repo, `report` scanned every log, printed a misleading "no sessions found",
  and only then failed. The repo check now runs before logs are read. With no sessions at all, `report`
  says where it looked. Tests added.
- `src/github.ts`: `report`'s gh call gets a 120 s timeout (a 1,000-PR search is paged), and `createGh`
  takes the timeout as a parameter.
- Tests: the misuse test would still have passed with the checks deleted, because outside a repo the
  later errors also exit 1. It now runs inside a repo with logs and asserts each specific message, no gh
  call and no log scan. Added a test that the session root is part of the Codex dedupe key.

**Pass 2 — informational, left as is**

- [P2] (confidence: 6/10) EC12's ccusage reference is derived from ccusage's published rules, not
  captured from a ccusage run (npm and WebFetch were denied here). Replacing it with real output is two
  commands (`test/fixtures/sample-logs/README.md`).
- [P3] (confidence: 6/10) `src/report.ts`: a PR whose sessions are all on unpriced models (e.g. a GPT-6
  model, or bare `gpt-5`) counts as $0 in the median and top 5. The unpriced warning is printed under the
  report, but the row itself doesn't say so. Excluding such PRs or flagging the row is a design call (ASK).
- [P3] (confidence: 6/10) `src/cli.ts` `report`: the repo scope is today's `git worktree list`. Sessions
  from a worktree that has since been removed (common for merged PRs) drop out of their PR and of the
  "not in any merged PR" line. Codex's `session_meta.git.repository_url` could be used as a second match
  later.
- [P3] (confidence: 4/10, medium, verify) `src/codex.ts`: fork dedupe depends on reading the parent before
  the fork. Inside one sessions tree, sorted by date, that always holds. Across several `--logs` dirs, a fork
  read first keeps the replayed usage under its own session (totals right, attribution wrong). A
  fork-of-a-fork read before its middle file counts the history twice. Two sibling forks merge an event
  only if their running totals are identical.
- [P3] (confidence: 5/10) `src/report.ts`: markdown links and images in PR titles (`[x](https://…)`)
  render if the report is pasted into GitHub. The report only goes to stdout, and escaping `[` `]` would
  mangle the common "[WIP]" prefix, so it's left.
- [P3] (confidence: 5/10, existing since M1, Windows only) `src/git.ts`, `src/github.ts`: `git` and `gh`
  are started by bare name with the repo as working directory. On Windows, Node's launcher looks there
  before PATH, so an untrusted clone could plant `gh.exe`. Windows isn't tested yet (What's left).
- [P3] (confidence: 6/10) `src/report.ts`: PRs merged before `--since` aren't listed, so if one used the
  same branch name as a PR in the window, its work can land on the later PR (within the 90-day bound).
- [P3] (confidence: 6/10) Codex records the branch only at session start, so a mid-session branch switch
  keeps the whole session on the first branch.
- Time-window safety: all times are UTC epoch ms. `--since` dates are 00:00 UTC, GitHub's per-day search
  is narrowed to the exact time, and the merge time and the 90-day bound are both inclusive.
- Distribution: still no npm publish workflow or CI (What's left).

### M2 review

The whole tree (M1 + M2) is still untracked because the caller commits, so `git status` lists everything
as new and `git diff` only shows README.md. I read the M2 files directly instead: `src/git.ts` and
`src/github.ts` (new), `src/receipt.ts` and `src/cli.ts` (changed), and the new tests and test helpers.
I checked them against gstack's pre-landing checklist with the Fix-First heuristic. Nobody can be asked,
so for ASK items I made the call and wrote it down. `npm test` was rerun after every fix: 170/170.

**Pass 1 — CRITICAL**

- SQL & data safety: not applicable (no database).
- Wrong-target write: **fixed.** [P1] (confidence: 8/10) `src/cli.ts:182`: `comment 123` would have gone
  through `gh pr view 123`, which reads the branch as PR #123, and posted the receipt on an unrelated PR.
  With a branch argument, the PR's `headRefName` must now match it, or nothing is posted. Test added.
- Race condition: **left (ASK).** [P2] (confidence: 8/10) `src/github.ts:124`: find-then-create has no
  uniqueness check on GitHub's side. Two `comment` runs at the same moment both see no marker and both
  create a comment. Later runs update the oldest and the other stays. Locking or deleting duplicates are
  design calls (deleting is destructive), and for a CLI run by hand this is unlikely. M4's Action must use a
  `concurrency:` group.
- Unsafe rendering: **fixed.** [P2] (confidence: 7/10) `src/receipt.ts:320`: model names are rendered
  outside code spans, so an `@team` in a proxy's model id would notify people once posted. `@` is now
  replaced, like the other markdown-active characters. Branch and base names sit in code spans and go
  through the M1 sanitizer (test added for a hostile `--base`).
- Structured tool output: gh's JSON is shape-checked before use. **Fixed during review:** the PR URL must be
  http(s) because it's passed to `gh pr comment` as an argument, and `headRefName` is required. Tests added.
- Shell injection: none. gh and git run through `execFile`/`execFileSync` with argument arrays and no
  shell. User refs that start with `-` are refused (`--base=-x` → exit 1). Only hex SHAs reach `git log` /
  `git diff` ranges. A branch passed to gh can't start with `-`.
- Enum/value completeness: the `branch === null` bucket now has a second path (the window). I read every
  consumer: `buildReceipt` (branch totals include the window entries and `unattributed` excludes them,
  tested), `buildOverview` (unchanged, no window, documented), `renderReceipt` (window line, then the
  unattributed line), and `comment` (through `buildReceipt`). The `'created' | 'updated'` result is mapped in
  `src/cli.ts:207`.

**Fixed during review (auto-fix)**

- `src/receipt.ts:207`: `push(...entries)` could overflow the call stack for one huge no-branch session;
  now a loop.

**Pass 2 — informational, left as is**

- [P3] (confidence: 7/10) `src/git.ts:113`: lines changed use the local branch, so unpushed commits count
  and the number can differ from GitHub's "Files changed" until pushed. Following the roadmap (git diff).
  gh's `additions`/`deletions` would be the exact PR number if that's preferred later.
- [P3] (confidence: 6/10) `src/git.ts` `prBase`: assumes the remote is `origin`. In fork setups with an
  `upstream` remote it falls back to the local base branch, which can be stale and overcount lines.
  `--base upstream/main` works around it.
- [P3] (confidence: 6/10) `src/receipt.ts:189`: when two branches' windows overlap, a no-branch session is
  counted on both receipts. Each receipt shows the window and how much came from it.
- [P3] (confidence: 5/10, medium, verify) `src/receipt.ts:189`: matching on session overlap can pull in a
  long no-branch session that started well before the branch. The other choice, clipping at the first
  commit, would drop the work that made the first commit.
- [P3] (confidence: 6/10) `src/cli.ts:148`: `show --all` doesn't apply the window (it would need a window
  per branch).
- Time-window safety: all times are UTC epoch ms, commit times are epoch seconds and the window covers the
  whole last second, so there are no local-time or day-key windows. Sync git calls inside the async CLI are
  fine for a one-shot CLI (5 s timeout each); this isn't a server.
- Distribution: still no npm publish workflow or CI (What's left).

### M1 review (unchanged findings still open)

Self-review of the full M1 change set: everything was new, so `git diff` was empty and every file was read
directly. Checked against gstack's pre-landing checklist with the Fix-First heuristic.

**Pass 1 — CRITICAL**

- SQL & data safety, race conditions: not applicable (no database; single read-only process).
- Unsafe rendering: **fixed.** [P1] (confidence: 9/10) `src/receipt.ts`: model names from the logs went
  into the markdown table and the unpriced warning unescaped, so a `|` or HTML in a model id would break the
  table, and in M2 that text gets posted to a PR. They now go through the same sanitizer as branch names.
  Test added.
- LLM output trust boundary: not applicable. Transcripts are read for numbers and ids only; message content
  is dropped in `parseLine` and never reaches output (EC1 test greps for prompt markers).
- Shell injection: none. git runs through `execFileSync` with a fixed argument array, no shell, and a 5 s timeout.
- Enum/value completeness: the "unattributed" bucket (`branch === null`) is produced in one place
  (`parseLine`: missing, empty or `HEAD`) and every consumer was read (`buildReceipt`, `buildOverview`, both
  renderers). A branch literally named `unattributed` can't reach the bucket (EC3 test).

**Fixed during review (auto-fix)**

- Dedupe kept the first streamed copy, which undercounts if early copies have partial usage. It now keeps the
  largest count per field (test added). The result is identical when copies match.
- `--help` didn't mention the `$XDG_CONFIG_HOME` default; `prepack` now builds `dist/`; `engines` relaxed to Node ≥ 20.

**Left as is (informational)**

- [P2] (confidence: 7/10) `prices.json`: Claude 5.x prices come from third-party reports, not Anthropic's
  page (see Decisions). Verify before trusting 5.x totals.
- [P3] (confidence: 6/10) `src/cli.ts:141`: with `--repo`, "no sessions found (scanned N log files)"
  doesn't say the repo filter removed everything. Changing user-visible wording falls under ASK in Fix-First, so it's left.
- [P3] (confidence: 7/10) `src/parse.ts`: a half-written last line in a session that's still running is
  reported on stderr as "skipped 1 unreadable line" on every run. Harmless but noisy.
- [P3] (confidence: 6/10) `src/receipt.ts`: wall time includes idle gaps inside a session (a session
  resumed the next day counts the gap). Documented choice; could cap gaps later.
- [P3] (confidence: 5/10, medium, verify) `src/parse.ts`: all entries are held in memory, one small
  object per line. Fine for the PRD's 1,000-session target; very large histories would need aggregation while streaming.
- Distribution: no npm publish workflow or CI yet (listed in NOT in scope and What's left).
