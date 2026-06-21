---
name: feature
description: Start a new feature on its own branch and ship it via a pull request — never commit features straight to main. Use when the user begins any new feature/enhancement, says "ทำฟีเจอร์", "feature ใหม่", "/feature", or asks to branch + open a PR for work in this repo.
---

# feature — branch-and-PR workflow

This project's rule (see CLAUDE.md → "Git workflow"): **every new feature goes on its
own branch and merges through a PR. Never commit a feature directly to `main`.**

`gh` is installed and authenticated. Run these steps with Bash.

## 1. Start the branch (before writing feature code)

```
git switch main && git pull --ff-only
git switch -c feature/<slug>      # <slug> = short kebab-case, e.g. feature/recurring-quest
```

- Derive `<slug>` from the feature in 2-4 words.
- If the working tree is dirty, ask whether to stash/commit first — do not silently discard.
- If a `feature/<slug>` already exists, just `git switch` to it.

## 2. Build the feature

Implement on the branch. Commit in logical chunks. End every commit message with:

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

If the change touches `lib/thaiDate.js` parsing, run `node test/thaiDate.test.mjs` before committing.

## 3. Update the knowledge base (REQUIRED before any push)

Before pushing, reflect what changed into the context docs so the next Claude
session understands the project without re-reading all the code (saves tokens):

- **CLAUDE.md** — file tree, architecture, conventions, message API list, rules,
  TODO/"not done yet" list. Tick or add items that this feature changed.
- **docs/FEATURES.md** — add a section for the new feature, pointing at the
  files/functions that implement it.
- **README.md** — only if user-visible behavior changed.

Edit only what actually changed this round; don't rewrite whole files. If the
change has no context impact (typo/format), note "no KB change" and skip.

## 4. Bump the version (REQUIRED before every PR)

**Every PR must bump `version` in `manifest.json`** (semver). The in-app update
notice compares this number on GitHub `main` against the installed copy — if a PR
merges without bumping it, users never get the "new version" banner.

- patch (`0.1.0` → `0.1.1`) = bugfix; minor (`0.1.0` → `0.2.0`) = new feature; major = breaking.
- Bump on the feature branch so it lands with the merge.
- After merge, tag it on `main`: `git tag vX.Y.Z && git push --tags`.

See CLAUDE.md → "Versioning & การแจ้งเตือนอัปเดต".

## 5. Open the PR (when feature is done)

```
git push -u origin feature/<slug>
gh pr create --base main --fill
```

- Prefer `--fill` (uses commits). For a richer PR, pass `--title` / `--body` instead.
- End any PR body you write with:
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- Report the PR URL back to the user. Do **not** merge unless they ask.

## 6. After merge (optional)

```
git switch main && git pull
git branch -d feature/<slug>
```

Exception: trivial typo / comment / docs edits may go straight to `main`.
