---
name: stackwise-describe
description: Writes a pull request title and body for a .NET + Node.js + React change from its diff and commits — summary, why, risk and test plan — with a risk note that names what reviewers and deployers must know about EF Core and SQL migrations (data loss, rename as drop, NOT NULL on a populated table, lock time, deploy order, rollback), C# to TypeScript API contract changes, authentication and authorization changes, and new config or environment settings. Prints the text by default and updates the PR with gh pr edit only with --apply. Use when asked to "write the PR description", "describe this PR", "fill in the PR body", "PR title", "summarize this branch for review", or "what is risky about this change".
argument-hint: "[PR#|branch] [--apply]"
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(gh pr view:*), Bash(gh pr diff:*), Read, Grep, Glob
---

# Describe a pull request

Write what a reviewer and a deployer need, from the diff, not from the branch name.
Every claim in the body must be true of the diff; say less rather than guess.

## 1. Gather

1. Target: a PR number or URL, a branch, or empty for the current branch. Get the diff
   as in the `stackwise` skill's "Get the diff". For a PR, also read its current title
   and body: `gh pr view <n> --json title,body,baseRefName,headRefName,url`.
2. Commits since the base: `git log --format='%h %s%n%b' <base>..<head>`. They carry
   the author's intent; the diff is the truth when they disagree.
3. Changed files by kind: `git diff --stat` and `--name-status` (renames and deletions
   matter for the risk note). Skip lockfile and generated-code bodies; note that they
   changed.
4. The repo's title convention: the last 20 subjects on the base branch
   (`git log --format=%s -20 <base>`) and, when a PR exists, its siblings
   (`gh pr list --state merged --limit 10 --json title` if allowed). Use Conventional
   Commits (`feat:`, `fix:`, scope in parentheses) when the repo does.

Detect the stacks as in "Detect the stacks"; load no reference unless a risk below needs
a rule from it (efcore.md for migrations, cross-stack-contract.md for the wire).

## 2. Title

One line, under 72 characters, imperative, in the repo's convention. Name the
user-visible change, not the mechanism: `feat(orders): let customers cancel unpaid
orders`, not `update OrdersController`. A PR that does two unrelated things gets a title
for the main one and a line in the summary suggesting the split.

## 3. Body

```markdown
## Summary
- <what changes for a caller, user or operator; one bullet per behaviour>

## Why
<the problem or request, in one to three sentences; link the issue if the commits or
branch name cite one>

## Risk
<one subsection per area below that the diff touches, or "Risk: low — <why>">

## Test plan
- [x] <what was run, with the command: `dotnet test`, `pnpm test`, a manual check>
- [ ] <what a reviewer should verify by hand, with the exact steps or request>
```

Tick a test-plan box only for something that was actually run in this session or is
shown by CI on this PR (`gh pr view <n> --json statusCheckRollup`). Everything else
stays unticked.

## 4. Risk note

Write each area only when the diff touches it. Each line names the concrete fact and
what to do about it.

**Migrations** (EF Core `Migrations/`, `*.sql`, Prisma, TypeORM or Knex migrations):
- data loss: a dropped column or table, a type narrowing, a rename that EF Core
  scaffolded as drop + add;
- `NOT NULL` added to a populated table without a default or backfill;
- lock and rewrite time: a new index without `CONCURRENTLY` or `ONLINE`, a column type
  change that rewrites the table, a large `UPDATE` in the migration;
- deploy order: whether the old app version runs against the new schema (expand first,
  contract later) and which goes first, app or migration;
- backfill and rollback: what `Down` does, and whether rolling back loses data written
  after the deploy.

**API contract** (C# DTOs, controllers, minimal-API endpoints ↔ TypeScript types,
clients and generated code):
- fields added, removed or renamed; nullability or optionality changed; enum values
  added or renamed, and whether they serialize as strings or numbers;
- status codes and the error shape (`ProblemDetails`, validation errors) changed;
- whether the generated client was regenerated in this PR; if not, say it must be;
- who must deploy first, and whether old clients (mobile apps, cached SPAs) break.

**Auth**:
- new endpoints and how they are protected; anything anonymous (`[AllowAnonymous]`,
  `.AllowAnonymous()`, a route outside the guard, a public server action);
- changed policies, roles, guards or middleware order;
- token, cookie, session, CORS or CSRF settings.

**Config and environment**:
- new keys in `appsettings*.json`, `.env*`, Helm or compose files, options classes and
  `process.env` reads; which are secrets and where they must be set;
- feature flags and their default in each environment;
- what happens when the key is missing (fail at startup, or a silent default).

Also note, when present: new or bumped dependencies (major versions), background jobs
or schedules, and anything that changes cost or traffic (a new external call per
request, a cache removed).

## 5. Keep what the author wrote

When the PR already has a body, keep lines that must survive: `Closes #n`, `Fixes #n`,
linked issues and tickets, screenshots, checklists the author ticked, and sections a
repo template requires (`.github/pull_request_template.md`). Merge them into the new
body under the matching heading rather than dropping them. Follow the repo's PR template
when one exists: its headings win over the ones above.

## 6. Print or apply

- Default: print the title and the body, ready to paste. Change nothing.
- `--apply`, for an existing PR only: write the body to a temp file outside the repo,
  then `gh pr edit <n> --title "<title>" --body-file <temp file>`. Show the title and a
  one-line summary of what changed in the body.
- No PR exists: print, and suggest `gh pr create --title "<title>" --body-file <file>`.

Never create, merge, close, mark ready or request reviewers, and never push.
