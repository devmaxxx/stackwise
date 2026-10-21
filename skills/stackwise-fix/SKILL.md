---
name: stackwise-fix
description: Applies the must and should findings of a stackwise review as minimal patches, one finding at a time, in a .NET + Node.js + React repo. Reuses a stackwise report already in the conversation, or runs the review first. Rebuilds and tests after each patch (dotnet build/test, the repo's npm/pnpm/yarn/bun test, typecheck or tsc), re-runs the finding's breaking input to prove it no longer breaks, and reverts any patch that fails. Commits only with --commit and never pushes. Use when asked to "fix the review findings", "apply the review", "fix the must findings", "fix what stackwise found", "patch these issues", or after a stackwise review when the user wants the defects fixed.
argument-hint: "[PR#|branch|path|review-file] [--commit] [--only must]"
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(gh pr view:*), Bash(gh pr diff:*), Read, Grep, Glob
---

# Fix stackwise findings

Turn verified findings into the smallest patches that remove them, and prove each one.
A patch that cannot be proven is reverted, not kept on hope.

## 1. Parse the arguments

- Target: a PR number or URL, a branch, a path, or a file holding a saved stackwise
  report. Empty means the current branch or local change, as in the `stackwise` skill's
  "Get the diff".
- `--commit`: commit each kept fix. Without it, leave every change uncommitted.
- `--only must`: skip should findings. Default is must, then should. Nits are never
  patched here.

## 2. Get the findings

1. If this conversation already holds a stackwise report for the same target, use its
   must and should findings as numbered there.
2. If the target is a review file, read it and take its must and should sections.
3. Otherwise load the `stackwise` skill and run the full review on the target first.
   Fix only what survived its "Verify every finding" step.

Keep each finding's `path:line`, defect, breaking input and suggested fix. A finding
marked `(likely: assumes …)` is fixed only after you confirm the assumption in the code;
if you cannot, report it as skipped with the open assumption.

## 3. Preconditions

- The code under review must be the checked-out tree. For a PR, compare
  `git rev-parse HEAD` with `gh pr view <n> --json headRefOid -q .headRefOid`. If they
  differ, stop and tell the user to run `gh pr checkout <n>` (and pull) first.
- Run `git status --porcelain`. Uncommitted changes are the user's work: list them, keep
  them, and never run `git checkout`, `git reset`, `git stash` or `git clean` over them.
  A finding whose files carry unrelated uncommitted edits is patched on top of them; the
  revert in step 5 restores them too, from a copy rather than from git.
- Make no other change to the repo: no dependency bumps, no formatting runs, no lockfile
  rewrites.

## 4. Find the build and test commands

Read the project files; do not guess.

| Signal | Build | Test |
|--------|-------|------|
| `*.sln`, `*.slnx` or `*.csproj` | `dotnet build` on the solution (or the touched project) | `dotnet test` on the test projects that reference the touched projects |
| `package.json` | its `build` script if the change needs one | its `test` script; also `typecheck`, or `tsc --noEmit` when a `tsconfig.json` exists and no script covers it |

Pick the Node package manager from the lockfile: `pnpm-lock.yaml` → pnpm,
`yarn.lock` → yarn, `bun.lock` or `bun.lockb` → bun, `package-lock.json` or none → npm.
In a monorepo, run the scripts of the workspace that owns the touched files
(`pnpm --filter`, `npm -w`, `yarn workspace`), plus the root ones if CI runs them.

Run the baseline once before any patch: build, typecheck, tests. Record every failure
that already exists. Later runs are judged against this baseline, not against zero.
If the build itself is broken at baseline, stop and report it; patches cannot be proven
on a tree that does not build.

## 5. Fix one finding at a time

Order: must before should, then by file so related patches stay together. For each:

1. **Save the pre-patch state.** Note every file the patch will touch and copy each one
   to a temp directory outside the repo (`cp -p`). The copies hold earlier fixes and the
   user's own edits byte for byte, which a saved diff does not for binary files, mode
   changes or line endings.
2. **Patch minimally.** Change only what the finding needs: the guard, the `await`, the
   parameter, the dependency array, the lifetime. No renames, no refactors, no drive-by
   fixes of other findings, no reformatting. Match the file's existing style. If the
   right fix needs a design decision the finding does not settle (a new API shape, a
   migration choice, a product rule), skip it and say what has to be decided.
3. **Rebuild and test.** Run the build, typecheck and the affected tests. A new failure
   against the baseline means the patch is wrong or incomplete.
4. **Re-verify the breaking input.** Prove the finding's input no longer breaks, by the
   cheapest executable check:
   - a throwaway script that calls the function with the input
     (`node -e`, `npx tsx`, a `dotnet test --filter` on a temporary test);
   - a request against a test host (`WebApplicationFactory`, `supertest`, the app on a
     local port) with the breaking request;
   - a temporary test that encodes the input.

   Remove temporary checks afterwards unless the user asked to keep them (then hand them
   to the `stackwise-tests` skill's rules). "Verified by reading" is allowed only when no
   executable check exists, such as a race that needs production timing or a
   configuration that needs a real environment; say so in the report.
5. **Keep or revert.**
   - Keep when the build, typecheck and tests are no worse than the baseline and the
     breaking input now behaves.
   - Revert otherwise: copy the saved files back over the patched ones and delete any
     file the patch created. Never `git checkout` them: that would drop the user's edits.
     Run `git diff --stat` to confirm only the patch was removed.
     Report the finding as reverted with the failing command or the input that still
     breaks.
6. **Commit, only with `--commit`.** One commit per kept finding, staging only that
   patch's files (`git add -- <files>`), message in Conventional Commits:
   `fix: <defect in a few words>`. Never commit the user's unrelated edits, never amend,
   never rebase, never push.

Stop after three consecutive reverts and report: the findings are likely wrong, or the
tree is not what the review saw.

## 6. Final check

Run the full build and the test suite once more with every kept patch applied. If that
run fails where the per-finding runs passed, the patches conflict: bisect by reverting
the most recent kept patch first, and report the pair.

## 7. Output

```
## Fixes: <target> (<base>...<head>)
Build: <command> · Tests: <command> · Baseline: <n> pre-existing failures

| # | Grade | Finding | Result | Proof | Files |
|---|-------|---------|--------|-------|-------|
| 1 | must | `src/Api/Orders/OrdersController.cs:42` missing tenant check | fixed | GET /orders/7 as tenant B → 404 (was 200) | OrdersController.cs |
| 2 | should | `src/web/useSearch.ts:18` fetch race | reverted | `pnpm test` → useSearch.test.ts fails: aborted request rejects | — |
| 3 | should | `src/jobs/Sync.cs:30` missing CancellationToken | skipped | needs a decision: retry or drop on shutdown | — |

Commits: <sha subject, one per line> | none (no --commit)
Uncommitted user changes kept: <files> | none
Next: run the stackwise-tests skill to pin fix 1 with a regression test.
```

Results are `fixed`, `reverted` (with the failing command or input) or `skipped` (with
the reason). Name the proof for every `fixed` row; "tests pass" alone is not proof that
the finding's input stopped breaking.

## Never

- Never patch a finding you could not confirm, and never "fix" by deleting a test,
  loosening an assertion, adding a suppression (`#pragma warning disable`,
  `eslint-disable`, `@ts-ignore`, `!`) or catching and ignoring the error.
- Never discard uncommitted work, never force anything, never push.
- Never widen scope: a new problem found while patching goes in the report as a new
  candidate for the next review, not into this patch.
