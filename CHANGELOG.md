# Changelog

All notable changes to stackwise are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-21

### Added

- Five new references, each wired into the detection table: `nestjs.md` (DI scopes, pipe
  and guard order, DTO validation, serialization, transactions), `nextjs.md` (server and
  client boundary, server actions, route handlers, `proxy`, caching), `api-design.md`
  (idempotency, PATCH, status codes, paging, ETag, 202, rate limits), `performance.md`
  (N+1, unbounded data, waterfalls, blocking, caches, bundle, re-renders) and
  `error-handling.md` (swallowed errors, lost context, fail-open, retries, background
  work, UI errors).
- Risk-scaled depth: auth, money, migrations, concurrency and public contracts get a
  deep pass; docs, styling and test-only diffs get a light one.
- Four lenses over the changed lines: silent failures, test coverage, type design and
  comment accuracy.
- `confirmed` / `likely: assumes …` labels on findings; a must needs `confirmed`.
- Five lens agents with no edit tools (`stackwise-contract`, `stackwise-data`, `stackwise-auth`,
  `stackwise-react-effects`, `stackwise-silent-failure`). The review dispatches them in
  parallel for diffs over 400 changed lines or with an auth, migration or contract risk,
  then merges, dedupes and verifies their findings itself. Small diffs stay single-pass.
- Companion skills, auto-invoked or called as `/stackwise:<name>`:
  - `stackwise-fix`: one minimal patch per must and should finding, rebuilt and tested,
    the breaking input re-run, failures reverted; commits only with `--commit`, never
    pushes.
  - `stackwise-tests`: a fail-before, pass-after regression test per finding in the
    repo's own framework, with the red and green evidence.
  - `stackwise-respond`: reads unresolved review threads through GraphQL, classifies
    each as valid, wrong or question, fixes the valid ones and drafts the replies;
    posts only with `--post`, never resolves threads.
  - `stackwise-describe`: PR title and body with a risk note for migrations, the C# to
    TypeScript contract, auth and config; edits the PR only with `--apply`.
- Hooks, both advisory and never blocking:
  - a `PreToolUse` security guard on `Write`, `Edit` and `MultiEdit` that warns about
    secrets, raw SQL built from strings, `dangerouslySetInnerHTML`, `[AllowAnonymous]`,
    `eval` / `new Function`, `child_process.exec` with a template string and
    `rejectUnauthorized: false` in the new content. `STACKWISE_SECURITY_HOOK=0` turns it
    off.
  - an opt-in pre-push reminder (`STACKWISE_PREPUSH=1`) that names the outgoing commits
    on `git push` and asks for a review of them before any further push or merge.
- `templates/github/stackwise-review.yml`: a GitHub Actions workflow that runs the
  review on pull requests touching the stack, through a pinned
  `anthropics/claude-code-action`, and posts inline comments.
- Install as a plain skill with the `skills` CLI (`npx skills add devmaxxx/stackwise`).
  That installs the review skill and the companion skills only; the
  `/stackwise:review` command, the lens agents and the hooks need the plugin.
- Eval fixtures `dotnet-webhook`, `nestjs` and `fix-node` (a fix run scored by
  `check.mjs`), and validator checks for the companion skills, agents, hooks, the CI
  template, README links and checklist length.
- This changelog.

### Changed

- Every reference was rewritten in more depth, with ❌/✅ snippets or detection cues, and
  opens with a checklist that ends within its first 100 lines. The review reads that
  checklist, then only the snippet sections for items that hit.
- `error-handling.md` loads on every review except docs-only diffs.
- `/stackwise:review` accepts a `.diff` or `.patch` file as the target.
- `ATTRIBUTION.md` now holds only the license notices for adapted material.

### Removed

- `ANALYSIS.md`.

## [0.1.0] - 2026-10-21

### Added

- The `stackwise` review skill: diff-driven stack detection, a vertical and a
  horizontal pass, a verification gate that needs a concrete breaking input, and
  must / should / nit grading.
- References for C#, ASP.NET Core, EF Core, Node.js, TypeScript, React, security,
  testing and the cross-stack C# to TypeScript contract.
- The `/stackwise:review [PR#|branch|path] [--comment]` command.
- Eval fixtures for .NET, Node and React, and `tests/validate.mjs`.

[Unreleased]: https://github.com/devmaxxx/stackwise/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/devmaxxx/stackwise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devmaxxx/stackwise/releases/tag/v0.1.0
