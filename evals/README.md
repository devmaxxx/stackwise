# Evals

There are three fixture diffs, each with seeded bugs, plus the findings a correct
review must report. They are run by hand: the skill's output is free text, so the
check is a reading against `expected.md`, not a string match.

| Fixture | Seeded bugs |
|---------|-------------|
| `dotnet/` | A scoped `DbContext` captured by a singleton, and an N+1 over order lines |
| `node/` | An Express 4 async handler that never calls `next(err)`, and `readFileSync` on every request |
| `react/` | A polling effect missing `query`/`customerId` deps (stale closure), and a search fetch with no abort (race) |

## Run one

From any directory, start Claude Code with the plugin loaded and ask it to review
the fixture as a diff:

```sh
claude --plugin-dir /path/to/stackwise
```

```
Use the stackwise skill to review the diff in evals/dotnet/pr.diff (treat it as the PR; the repo is not available).
```

Or pipe it non-interactively:

```sh
claude -p --plugin-dir . "Use the stackwise skill to review this diff: $(cat evals/node/pr.diff)"
```

## Score

For each fixture, compare the report with `expected.md`:

1. **Recall**: every `must` and `should` item is reported, at the stated file:line
   (±1 line), with a breaking input and a fix.
2. **Grading**: the seeded bugs get the stated severity or higher.
3. **Stack detection**: the loaded references match the list at the top of
   `expected.md`. Loading React references for the node fixture is a failure.
4. **Precision**: nothing from "Must not be reported" appears. Items under
   "Acceptable extra findings" neither count for nor against.

A run passes when 1–4 all hold. Record failures alongside the skill change that
fixes them.

`npm test` checks that each fixture's hunk headers match their bodies. That check
keeps the file:line numbers in `expected.md` trustworthy.
