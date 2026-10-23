# Rework fixtures

A review recorded on 2026-10-16 on the local dogfood board: task #6 of the RosterDock company, "README landing
page", where Wren wrote the change and Edie sent round 1 back with three fixes. Both rounds were taken against
`80f18e27f280cbaa1a0be5dfdccce5b9a0e6e258` of this repository.

- `round-1.diff`: the `changes.diff` artifact of round 1's run, byte for byte as the worker harvested it
  (`git diff --cached --no-renames`). sha256 `d7bbc46771c270e2dde39f8d9b4321b2c121bd33454378a7079217594e7184a2`,
  the review's `diff_sha256` for that round.
- `round-2.diff`: round 2's, the one approved. sha256
  `113754c435f9add157e3e45c225e1acc3925b42a64a42d86b35697e118f81570`.
- `base.json`: the three files both rounds change, as they were at that commit (`docs/README.md` is new in
  both).

Round 1 applies to the base. Once round 2's change is on main, round 1 applies to none of its four files,
which is the base branch moving under a rework run. `apps/worker/test/rework.test.ts` replays both, and
`apps/board/test/reviews.test.ts` sends round 1 back through the board.
