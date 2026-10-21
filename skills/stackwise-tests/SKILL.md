---
name: stackwise-tests
description: Writes regression tests for stackwise review findings, or for changed branches that have no test, in a .NET + Node.js + React repo. Each test fails before the fix and passes after, uses the repo's own framework (xUnit, NUnit or MSTest with WebApplicationFactory; Vitest, Jest, Mocha or node:test; React Testing Library), copies the nearest sibling test's style, and pins the behaviour a caller relies on rather than the implementation. Runs every test it writes and reports the red and green evidence. Use when asked to "add a regression test", "write tests for these findings", "pin this fix with a test", "cover the changed branches", "test the review findings", or after the stackwise-fix skill has applied fixes.
argument-hint: "[finding numbers|path] [--keep-red]"
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(gh pr view:*), Bash(gh pr diff:*), Read, Grep, Glob
---

# Regression tests for stackwise findings

One test per finding, red before the fix, green after. A test that is green on the
broken code pins nothing and is not delivered.

## 1. Pick what to test

- Finding numbers (`1 3`) → those must and should findings from the stackwise report in
  this conversation. No report → run the `stackwise` skill first.
- A path → the changed branches in that path that no test exercises.
- Nothing → every must and should finding from the report; if there is no report, every
  changed branch without a test in the current diff ("Get the diff" in the `stackwise`
  skill). A changed branch is a new `if`, guard, validation rule, error path, status
  code, boundary or state transition.
- `--keep-red`: for a finding not fixed yet, keep the failing test in place as the
  specification of the fix. Without it, a test that can only be red is reported but not
  left in the tree.

Skip findings that no test can reach in this repo (a production-only race, an
infrastructure setting) and say why.

## 2. Detect the framework

Read the project files; never introduce a new framework or dependency.

| Stack | Signal | Use |
|-------|--------|-----|
| .NET | `PackageReference` to `xunit`, `NUnit` or `MSTest.TestFramework` in a test `.csproj` | that framework, its assertion library (FluentAssertions, Shouldly) only if already referenced |
| ASP.NET Core | `Microsoft.AspNetCore.Mvc.Testing` referenced | `WebApplicationFactory<Program>` and an `HttpClient` request |
| EF Core | `Testcontainers.*` already used | a real database container as the siblings do; otherwise the siblings' choice (SQLite, InMemory) |
| Node | `vitest`, `jest` or `mocha` in `devDependencies`, or their config files; `node --test` in a script | that runner and its config |
| HTTP (Node) | `supertest` or `light-my-request` present | a request against the app instance |
| React | `@testing-library/react` present | render, query by role or label, `userEvent` |

Find the nearest sibling test: same folder, same kind (endpoint, service, hook,
component). Copy its location, file naming, test naming, setup helpers, fixtures,
builders and auth helpers. A test that looks foreign to the suite will be rewritten or
deleted by the next maintainer.

## 3. Write the test

Read the stackwise skill's `references/testing.md` for assertion quality. In short:

- **Pin the contract.** Assert what a caller observes: HTTP status and body, the
  returned value, the persisted row, the rendered text, the emitted message. Not which
  private method ran, not call counts, unless the call itself is the contract (an email
  sent once, a payment captured once).
- **Use the finding's breaking input.** The test name says the behaviour:
  `returns 404 for another tenant's order`, `ignores a stale search response`,
  `Rejects_role_in_profile_update`.
- **Write the expected value out.** Never recompute it with the code's own formula, never
  copy it from the actual output, never snapshot a whole response or component.
- **Mock only process boundaries.** HTTP to third parties, the clock, the message bus.
  Keep the code under test and its in-process collaborators real.
- **Control time and order.** Fake timers, a deferred promise or a `TaskCompletionSource`
  to force the interleaving a race finding describes; no `sleep`.
- **Assert absence for negative cases.** "Another tenant cannot see it" checks the row
  is missing from the body, not only the status.
- **Await every async assertion** (`await expect(...).rejects.toThrow(TypeError)`,
  `await Assert.ThrowsAsync<...>`), and name the exception type.

If the behaviour the test would lock in looks wrong, surprising or arbitrary, stop and
ask the user before writing it down as expected.

## 4. Prove red, then green

Run only the new test (`dotnet test --filter "FullyQualifiedName~<Name>"`,
`npx vitest run <file> -t "<name>"`, `npx jest <file> -t "<name>"`,
`node --test --test-name-pattern="<name>" <file>`):

1. **Fix not applied yet:** the test must fail, and fail for the finding's reason (the
   assertion on the breaking input), not for a compile error, a missing fixture or a
   timeout. Then either apply the fix (only if the user asked; otherwise the
   `stackwise-fix` skill does it) and see it pass, or keep it red with `--keep-red`.
2. **Fix already applied:** save the fix with `git diff -- <fix files>` to a temp file
   outside the repo, restore those files from `HEAD` (or from the commit before the fix
   when it is committed: `git show <sha>^:<path>`), run the test and see it fail, then
   re-apply the saved diff and see it pass. Confirm with `git diff --stat` that the tree
   is back to where it was. Never touch files outside the fix.

A test that passes before the fix: rewrite it with an input that reaches the defect, or
drop it and say so. A test that fails after the fix: the fix or the test is wrong;
report it, do not loosen the assertion.

Then run the whole affected test project or package once, to show the new tests do not
break siblings (shared fixtures, ordering, global state).

## 5. Never

- Never weaken, skip or delete an existing test, and never edit an expected value to
  match new output.
- Never update snapshots in bulk (`-u`, `--updateSnapshot`, accept-all tools).
- Never add a test dependency, a new runner or a new config file.
- Never commit; the user or the `stackwise-fix` skill's `--commit` owns commits.

## 6. Output

```
## Tests: <target>

| # | Finding | Test | Red (before fix) | Green (after fix) |
|---|---------|------|------------------|-------------------|
| 1 | `src/Api/Orders/OrdersController.cs:42` tenant check | `tests/Api.Tests/OrdersTests.cs:88` Returns_404_for_other_tenants_order | `dotnet test --filter …` → expected 404, got 200 | → passed |
| 2 | `src/web/useSearch.ts:18` fetch race | `src/web/useSearch.test.ts:41` ignores a stale response | `pnpm vitest run …` → rendered "old" | → passed |

Suite: <command> → <n> passed, <n> failed (failures pre-existing: <names> | none)
Not covered: <finding> — <reason> | none
```

Every row names the command and the observed result for both red and green. A row
without red evidence is not a regression test; leave it out.
