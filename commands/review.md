---
description: Review a PR, branch or path in a .NET + Node.js + React repo with the stackwise skill; prints verified findings, posts inline PR comments only with --comment
argument-hint: "[PR#|branch|path] [--comment]"
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh api:*), Bash(gh repo view:*), Bash(git diff:*), Bash(git log:*), Bash(git fetch:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git show:*), Read, Grep, Glob
---

Review the target with the `stackwise` skill. Load it first and follow its workflow
exactly: get the diff, detect the stacks, load only the matching references, run the
vertical and horizontal passes, verify every finding, grade must/should/nit.

Arguments: `$ARGUMENTS`

## Resolve the target

Strip `--comment` from the arguments; what remains is the target.

- A number or a PR URL → that pull request (`gh pr view`, `gh pr diff`).
- A branch name (`git rev-parse --verify <name>` succeeds) → `git diff origin/<base>...<name>`.
- An existing path → the branch diff limited to that path.
- Empty → the open PR for the current branch if `gh pr view` finds one, otherwise the
  local change against the base branch.

Base is the PR's `baseRefName`, else the repo's default branch (`gh repo view --json defaultBranchRef`), else `main`.

## Output

Print the report in the skill's output format. Do not post anything to GitHub unless
`--comment` was passed. Never approve, request changes, push, or edit files.

## With --comment

Only for a PR target, and only for findings that survived verification:

1. Get the head commit: `gh pr view <n> --json headRefOid -q .headRefOid`.
2. Build one review payload and post it in a single call, so the author gets one
   notification:

   ```
   gh api repos/{owner}/{repo}/pulls/<n>/reviews --method POST --input review.json
   ```

   with `review.json` shaped as
   `{"commit_id": "<sha>", "event": "COMMENT", "body": "<verdict + counts>", "comments": [{"path": "...", "line": 42, "side": "RIGHT", "body": "**must** — <defect>. Breaks when: <input>. Fix: <fix>."}]}`.
   Write the file to a temp directory, not the repo.
3. Each comment sits on a line that is part of the diff (`side: RIGHT` for added or
   context lines). A finding whose line is outside the diff goes into the review body
   instead.
4. Add a ```` ```suggestion ```` block only when applying it fixes the issue completely.
5. One comment per finding; skip findings already raised in an existing review thread
   (`gh api repos/{owner}/{repo}/pulls/<n>/comments`).

If there are no findings, post nothing unless `--comment` was passed; then post a
review body stating that no issues were found and what was checked.
