## Shared repo rules

This is a SHARED workspace. Its protected branches move only when GitHub merges a pull request.

- Before writing any record, load the `shared-repo-pr-workflow` skill and follow it.
- Never commit on, push to, or merge into a protected branch (`governance.yaml` → `protected`).
- Never merge a pull request yourself. Open it and report its link; a reviewer in GitHub, or GitHub
  auto-merge, merges it.
- `node bin/sandbox.mjs` is the stand-in for `gh` in this demo: `pr list`, `pr view`, `pr create`,
  `start`, `link resolve`.
