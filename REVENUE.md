# Road to revenue: PR Receipt

**Bottom line:** the evidence does not show anyone will pay. Demand is inferred (review score 4/10), the core output is free elsewhere, and a funded competitor already ships per-PR cost. The plan below is the cheapest honest test: a free CLI to get users, and one $9/month paid tier that is only offered once 3+ outsiders use the free one. Expect $0 and treat it as a 30-day experiment.

## What changed since the review
Web search found **LangWatch** documents a "pull request usage" endpoint: sessions, tokens and cost per PR, grouped by contributor and agent, from Claude Code and other agents ([docs](https://langwatch.ai/docs/api-reference/coding-agents/get-pull-request-coding-agent-usage), [overview](https://langwatch.ai/docs/coding-agents/overview)). That contradicts the PRD's "gap: PR-native receipt". Its gap is that it is a hosted observability platform needing an account and API key, while PR Receipt is local-first, zero-setup and aggregate-only. I could not find LangWatch's price (listings are inconsistent), so "free vs paid" there is unverified. Evidence strength: moderate that the competitor exists, weak on its pricing.

## Who pays
Not "developers". The only person with a budget and a reason is **an engineering lead or founder of a 2–10 person team on metered Claude API / Teams premium seats**, who got a $400+ monthly agent bill and has to explain it. Anthropic's own figures put average spend at ~$13/dev/active day and $150–250/dev/month ([costs doc](https://code.claude.com/docs/en/costs)), so a 5-person team is a ~$1k/month line item. That is the budget a $9 tool sits inside. I have not found a named person; finding three is the real work.

Subscription (Pro/Max) solo users are not buyers: they pay a flat fee, and PR Receipt would only show an "API-equivalent estimate".

## What they pay today
- $0: `/usage`, ccusage (free, ~18.9k stars), claude-burn-rate (free, per-branch), Anthropic admin dashboards (included with Teams/Console).
- Hosted platforms (Coralogix, LangWatch and similar): paid or freemium; prices unverified.
- A competing paid price anchor: AI code review runs a few cents to ~$25 per PR ([Codacy](https://blog.codacy.com/ai-code-review-cost-per-pull-request-what-engineering-teams-actually-pay-in-2026)). Vendor blog, indicative only.

So the status quo is free and "glance at ccusage". Nothing here shows a cost in hours or dollars from the missing per-PR number. Honest read: a nice-to-have.

## Narrowest version worth paying for
The free CLI (`show`, local `comment`) must stay free: it competes with free tools and is the distribution. What a team lead might pay for is what a free local CLI can't do: **one shared view for the whole team**, i.e. M3/M4 features: `report --since 30d` (cost per merged PR, median, top 5) across all teammates plus the GitHub Action that posts receipts from exported JSON so the lead needn't have anyone's laptop logs. Caveat: that needs teammates to export JSON, and it is untested whether anyone wants it.

Paid tier = "Team Pack": a licence key (or private repo/Action access) unlocking the team report and the Action. Cheapest to deliver with no backend: sell via Stripe payment link, deliver access manually (invite to a private GitHub repo containing the Action) within a day. That is fine for the first 10 customers.

## Price
**$9/month per team (flat, up to 10 devs), or $90/year.** Anchored on: tiny relative to ~$1k/month team agent spend (under 1%), below a single AI-review PR, and low because free alternatives exist and willingness to pay is unproven. A higher price needs evidence I don't have. Stripe Checkout payment link, subscription mode, no backend.

## Before charging
1. Free CLI published to npm and used by 3+ outsiders (not David).
2. Verify on real logs: gitBranch recorded, attribution ≥80–90%, within 5% of ccusage. If this fails, stop; accuracy is the whole product.
3. Stripe payment link, privacy policy and terms pages (the launch checklist lists both as not done), and a one-page site stating the "API-equivalent estimate" label and that no prompts leave the machine.
4. A manual delivery process for the paid tier.

## Shortest path
1. **Days 1–3:** Real-log accuracy check; publish to npm; README with screenshots (house rule).
2. **Days 3–7:** The review's own assignment: post "how do you track what a PR cost in tokens?" in r/ClaudeAI and count unprompted replies. Comment on issues in ccusage asking for branch/PR grouping, to find people who already want it. Post "Show HN" with the free CLI.
3. **Days 7–30:** DM every person who replies or stars with one question: "would your team pay $9/month for a shared cost-per-PR report?" Offer the Stripe link to anyone who says yes. A yes that doesn't click the link doesn't count.

## First ten users
Not paying users: *free* users first. Sources: replies in the r/ClaudeAI and r/ChatGPTCoding threads, people filing issues on ccusage and claude-burn-rate asking for branch/PR features, Show HN commenters. Goal is 10 free users and 3 conversations with team leads. First dollar realistically requires one of those leads to say yes.

## Risks
- LangWatch (and ccusage / claude-burn-rate / Anthropic) already cover per-PR or per-branch cost; a free feature from any of them kills the paid tier.
- No evidence of willingness to pay; paying market for the free-tool category is thin.
- Subscription users dominate; metered teams are a small slice.
- Branch metadata gaps (worktrees, renames) could make numbers wrong and destroy trust.
- Teams may not want spend published on PRs.
- The Action needs exported JSON from each dev, which adds friction.

## Kill criteria
Stop if by day 30 after launch: fewer than 3 outside users; or no team lead says they'd pay; or zero paying customers after 5 direct asks to team leads; or branch attribution is under 80% on real logs; or a competitor ships per-PR cost comments for free. Keep the CLI open source regardless; it costs nothing to leave up.
