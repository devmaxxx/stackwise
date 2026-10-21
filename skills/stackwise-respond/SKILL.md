---
name: stackwise-respond
description: Works through a pull request's unresolved review threads in a .NET + Node.js + React repo. Reads every open thread through the GitHub GraphQL API, checks each comment against the code and classifies it as valid, wrong or question, fixes the valid ones with minimal tested patches the way the stackwise-fix skill does, and drafts one reply per thread ("Fixed in <sha>" or the technical reason or answer). Prints the drafts; posts them only with --post or an explicit OK, and never resolves threads, pushes, approves or requests changes. Use when asked to "address the review comments", "respond to the PR review", "handle the review threads", "reply to reviewers", "fix what the reviewer asked", or "go through the unresolved comments".
argument-hint: "[PR#|URL] [--post] [--commit]"
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(gh pr view:*), Bash(gh pr diff:*), Read, Grep, Glob
---

# Respond to review threads

Every unresolved thread gets a decision backed by the code and a reply a reviewer can
check. Agreeing without checking and arguing without evidence are both failures.

## 1. Parse the arguments

- Target: a PR number or URL. Empty → the PR for the current branch (`gh pr view`).
- `--commit`: commit each kept fix, so the reply can cite its sha.
- `--post`: post the drafted replies. Without it, or an explicit OK from the user in
  this conversation, print the drafts and post nothing.

## 2. Check out and read the threads

1. `gh pr view <n> --json number,headRefOid,headRefName,baseRefName,url` and
   `gh repo view --json owner,name`. `git rev-parse HEAD` must equal `headRefOid`;
   if it does not, stop and tell the user to run `gh pr checkout <n>` (and pull).
2. Fetch every review thread:

   ```sh
   gh api graphql --paginate \
     -F owner=<owner> -F repo=<name> -F number=<n> \
     -f query='query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
       repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
         reviewThreads(first: 100, after: $endCursor) {
           pageInfo { hasNextPage endCursor }
           nodes { id isResolved isOutdated path line originalLine
             comments(first: 50) { nodes { databaseId author { login } body url createdAt } } } } } } }' \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'
   ```

3. Get your own login: `gh api user -q .login`. Skip a thread whose last comment is
   already yours: it waits on the reviewer, not on you.
4. For an outdated thread (`isOutdated`), find the code it meant through `originalLine`
   and the commit history (`git log -L`), and check whether a later commit already
   addressed it.

Read the whole thread, not just the first comment: a reviewer may have narrowed or
withdrawn the point further down.

## 3. Classify each thread

| Class | Test | Next |
|-------|------|------|
| **valid** | The defect is real: you can state the breaking input, reproduce it, or show a failing check, as in the `stackwise` skill's "Verify every finding" | fix it (step 4) |
| **wrong** | You can cite what makes it not a defect: the caller that never passes that value, the guard upstream, the framework default (`[ApiController]` returning 400, Express 5 forwarding rejections, EF Core parameterising `FromSql`), the test that already covers it | explain (step 5) |
| **question** | The reviewer asks rather than asserts | answer from the code (step 5); if the answer reveals a defect, it is valid |

Also mark threads that ask for a change outside this PR's scope (a refactor, a
follow-up feature). Treat them as valid-but-deferred: no patch, a reply proposing a
follow-up issue, and a line in the report so the user decides.

Style preferences that are consistent with the codebase are a judgement call, not a
defect: draft a short reply that either accepts them as a nit-level change or states
the existing convention, and flag them to the user.

When unsure between valid and wrong, read more code. If still unsure, classify as
question and say what would settle it; never guess in a reply.

## 4. Fix the valid threads

Apply each fix exactly as the `stackwise-fix` skill does: build and test baseline first,
then per thread save the pre-patch state of its files, patch minimally, rebuild and
test against the baseline, re-run the breaking input, and revert the patch if anything
regresses or the input still breaks. Never discard uncommitted work of the user's.

- With `--commit` (or a user OK): one Conventional Commit per thread or per group of
  threads on the same defect, staging only that patch's files. Record each sha.
- Without it: leave the patch uncommitted; the reply says it is fixed in the working
  tree and leaves the sha to fill in.
- A reverted fix turns the reply into "Agreed; my attempt broke <check>, so this needs
  <decision or follow-up>".

Never push, amend, rebase or force anything.

## 5. Draft the replies

One reply per thread, short, specific, no thanks-padding:

- **valid, committed:** `Fixed in <sha>: <what changed, one line>.`
- **valid, uncommitted:** `Fixed in the working tree (not committed yet): <what changed>.`
- **valid, deferred:** `Agreed, but outside this PR: <why>. Proposing a follow-up: <one line>.`
- **wrong:** `I don't think this can happen: <evidence with path:line>. <what would change that>.`
- **question:** the answer, with `path:line` where it helps.

Write each reply to a temp file outside the repo, so backticks and quotes survive.

## 6. Post, only with `--post` or an explicit OK

1. A "Fixed in <sha>" reply needs the sha on the remote: `git branch -r --contains <sha>`
   must name a branch. If it does not, do not post that reply; tell the user to push
   first, and post the others.
2. Post each reply on the thread's first comment:
   `gh api repos/{owner}/{repo}/pulls/<n>/comments/<databaseId>/replies -F body=@<file>`.
3. Never resolve a thread (no `resolveReviewThread`), never submit a review, never
   approve or request changes, never edit or delete someone else's comment.

## 7. Output

```
## Review threads: <PR title> (#<n>) · <k> unresolved, <m> skipped (awaiting reviewer)

| Thread | Reviewer | Gist | Class | Action | Reply draft |
|--------|----------|------|-------|--------|-------------|
| `src/Api/Orders/OrdersController.cs:42` | @alice | missing tenant check | valid | fixed, 3f2a1c9 | Fixed in 3f2a1c9: the query now filters by the caller's tenant. |
| `src/web/useSearch.ts:18` | @bob | "use SWR here" | valid, deferred | none | Agreed, but outside this PR: … |
| `src/Api/Program.cs:12` | @alice | "this endpoint is anonymous" | wrong | none | I don't think this can happen: … |

Commits: <sha subject> | none · Posted: <k> replies | none (drafts only) · Not posted: <thread> — push <sha> first
Needs your decision: <deferred or style threads> | none
```
