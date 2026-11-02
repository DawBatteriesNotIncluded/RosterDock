# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Layout: **single-context**, kept in the plan. `apps/board`, `apps/web`, `apps/worker` and `packages/shared` share
one vocabulary through `@rosterdock/shared`. The plan changes only in `docs/plan.html` (`CLAUDE.md`), so its
terms and decisions live there and in the milestones' notes. This repo has no `GLOSSARY.md` and no `docs/adr/`,
and none is created.

## Before exploring, read these

- **Terms:** Core concepts in `docs/plan.html` (`#nouns`), one row per noun: what it is and what owns it.
- **Rules:** "Rules that never soften" in `CLAUDE.md`, and the same rules in `docs/plan.html` (`#rules`).
- **Decisions:** in `docs/plan.html`, the decisions before M0 (`#decisions`) and each later section's Decided
  table; in the milestones' notes (`docs/m*.md`), the Decided and "Decisions taken while building" sections of
  the milestone that touches your area.

## Recording terms and decisions

`/domain-modeling` (reached through `/grill-with-docs` and `/improve-codebase-architecture`) records what it
resolves in the plan, not in new files:

- A resolved term is a row in Core concepts (`#nouns`): the noun, what it is, and what owns it. A term for
  something a slice has yet to build waits for that slice, which adds the row when it lands.
- A decision goes in the current milestone's `docs/m*.md`: under Decided while the milestone is planned, and
  under "Decisions taken while building" once it is being built. A decision that changes the plan changes
  `docs/plan.html` too.
- `docs/plan.html` is hand-written HTML that Prettier skips: keep its markup as it is, and open the page to
  check it.

## Use the plan's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name),
use the term as Core concepts defines it. Don't drift to synonyms. On the surface, use manager language
(`CLAUDE.md`): names, tasks, conversations, reviews, approvals.

If the concept you need isn't in Core concepts yet, that's a signal: either you're inventing language the
project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag conflicts

If your output contradicts a rule in `CLAUDE.md`, a decision in the plan, or a milestone's notes, surface it
explicitly rather than silently overriding:

> _Contradicts "Policy only narrows" (`CLAUDE.md`), but worth reopening because…_
