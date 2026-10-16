# Brand and voice

## Voice

- Plain, calm, specific. A manager talking to a manager. Short sentences.
- Say what it does, then why it matters. Never "revolutionary", "game-changing", "unleash", "supercharge",
  "seamless", "cutting-edge" or "AI-powered".
- Name the people and teammates: "Peter plans it, Cody builds it, Verifier reviews it."
- Manager language on the surface: tasks, reviews, approvals, conversations. Not lanes, leases, run specs
  or blocker codes.
- One idea per paragraph. Numbers with their unit and where they came from.

## Colour

| Token   | Light     | Dark      | Means                      |
| ------- | --------- | --------- | -------------------------- |
| ground  | `#f6f5f2` | `#141513` | page background            |
| surface | `#ffffff` | `#1e1f1c` | cards, panels              |
| border  | `#e6e3dc` | `#2c2e29` | lines                      |
| ink     | `#1c1b19` | `#ecebe6` | text                       |
| muted   | `#6b675f` | `#9a9d95` | secondary text             |
| green   | `#1f7a5c` | `#4fb58a` | only "an agent is working" |
| amber   | `#c98a1c` | `#e2b75a` | only "needs you"           |
| red     | `#b3261e` | `#e07a72` | only "blocked"             |
| blue    | `#4f6bd8` | `#8fa3ea` | review or mention          |

These are the product's own tokens (`apps/web/src/styles/tokens.css` in the RosterDock repository).

Colour carries meaning, so it is never decoration. Buttons are ink on surface, or surface on ink.

## Type and shape

- UI and headings: Schibsted Grotesk; fall back to the system sans.
- Ids, numbers, code and diffs: IBM Plex Mono; fall back to the system mono.
- Cards have an 8 px radius, controls 6 px. Borders are 1 px in the border colour. No shadows beyond a
  faint one on a raised card.

## The name

RosterDock, never "Rosterdock", "ROSTERDOCK" or "RosterDock AI". The company that makes it is Lighthouse.
