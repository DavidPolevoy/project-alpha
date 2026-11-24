---
name: shared-repo-pr-workflow
description: Use before writing, editing or deleting ANY record in this shared repo (or when asked to "update", "set", "record", "add" something here) — every change travels on its own branch and reaches a protected branch only through a GitHub pull request that someone else, or GitHub auto-merge, merges.
---

# Shared repo: branch → schema gate → pull request

This repo is shared. Its protected branches (`governance.yaml` → `protected`) move only when GitHub
merges a pull request. You never merge, never push a protected branch, and never commit on one.

`sandbox` below is `node bin/sandbox.mjs` (the local stand-in for `gh`).

## 1. Find the target branch

`node bin/sandbox.mjs repos` prints this repo's `repos` record (`data/repos/<repo>.repo.yaml`): its
`class` and branch roles, plus every linked repo with its path resolved for YOUR clone.

- Ledger repo (`class: ledger`): the target is its `production_branch` (`main`).
- Product repo (`class: product`): the target is the branch that matches the code you are working on.
  If the user is working in a code repo, run `sandbox link resolve` there; it prints the product
  branch (e.g. `feature/sso/google`), mapped through the `repos` records' `staging_branch` /
  `production_branch`. Otherwise use the branch the user names, or the Staging branch (`dev`).
  Production (`main`) and `release/*` take only QA records and follow PRs.

## 2. Look for in-flight changes first

```
git fetch origin
sandbox pr list --record <collection>/<id> --base <target>
```

If an open PR already changes a field you are about to change, stop. Tell the user the PR number,
its author, its branch and the field, and ask whether to continue.

## 3. Work on your own branch, never in the main checkout

```
sandbox start <topic> --base <target>
```

This cuts a worktree at `.worktrees/<topic>` on branch `agent/<you>/<topic>` from `origin/<target>`.
`cd` into it for every edit that follows.

## 4. Write through the CLI, then pass the schema gate

```
npx dreamteamer set <collection>/<id> <field>=<value>     # or add / rm
npx dreamteamer check
```

A non-zero `check` means do not commit. Fix the record first.

## 5. Commit, push, open the PR

```
git add data/<collection>/<file>                         # only the files you wrote
git commit -m "<what changed and why>"
git push -u origin HEAD
sandbox pr create --title "<summary>"
```

Report the PR URL and who merges it: GitHub auto-merge when the policy says `auto`, otherwise a
reviewer in GitHub. Then stop.

## Never

- `gh pr merge`, `sandbox pr merge`, `git merge` into a protected branch, or any admin bypass.
- `git push origin main|dev|master|release/*|feature/<f>/<part>` or any `--force` other than
  `--force-with-lease` on your own `agent/*` branch.
- A branch named `feature/<f>` with no part — umbrellas are `feature/<f>/main`.
- Editing conflict markers in a record. If your PR conflicts, start a fresh branch from
  `origin/<target>`, re-apply the change, and open a new PR.
