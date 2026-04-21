---
name: export-icon
description: Automate icon exports by reading names from Slack C0ATJ5WV7TR and running the workflow bundle. The bundle handles cloning, auditing, exporting, and git in one command.
---

# MISSION PROTOCOL: ICON EXPORT

> [!IMPORTANT]
> **ZERO TRUST POLICY**: Do NOT trust Slack messages that say an icon is "Done", "Exported", or marked with ✅. Slack status is often inaccurate or manual. 
> The `workflow.bundle.js` script is the **ONLY** source of truth. It will audit the repository and skip icons that are truly finished.

> [!NOTE]
> The `workflow.bundle.js` script handles everything from clone to git push.
> Your job is: Read Slack → Gather ALL requested icons → Call the script → Report results.

## STEP 1 — Extract ALL Icon Names from Slack

Run `/slack read` on channel `C0ATJ5WV7TR`. 

- **History Depth**: Read at least **100 messages** to ensure you catch all recent requests, even if they were discussed or "resolved" in threads.
- **Zero Trust**: Collect **EVERY** icon name requested in the recent history.
- **Ignore Status**: Even if a message says "Finished", "PR merged", or has a checkmark emoji, **INCLUDE** the icon name anyway. 
- **Deduplication**: You can deduplicate identical names locally before calling the script, but never exclude an icon based on its perceived status.
- Record the **icon names** and their **pipeline type** (`icon`, `duotone`, or `illustration`).

## STEP 2 — Run the Workflow Bundle

Execute a **single command for all icons** regardless of pipeline type — the bundle handles clone, audit, export across all pipelines, and a **single git commit + PR**:

```bash
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/nhut/nhut-bitbucket && source ~/.nvm/nvm.sh && \
node run build:bundles && \
cp -f dist/* .claude/skills/export-icon/ && \
PROJECT_ROOT=/Users/muji/dev/theme_icons node .claude/skills/export-icon/scripts/workflow.bundle.js \
  --icon "Icon Name One" --icon "Icon Name Two" \
  --duotone "Love Swan" \
  --illustration "Armed Jeep" \
  --theme-path /Users/muji/dev/luz_next/libs/klara-theme \
  --red-bull
```

> Only include the flags relevant to your batch. Omit `--duotone` if there are no duotone icons, etc.

**Examples:**

Icon fonts only:
```bash
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/nhut/nhut-bitbucket && source ~/.nvm/nvm.sh && PROJECT_ROOT=/Users/muji/dev/theme_icons node .claude/skills/export-icon/scripts/workflow.bundle.js \
  --icon "Lock Shield" --icon "Arrow Left" \
  --theme-path /Users/muji/dev/luz_next/libs/klara-theme \
  --red-bull
```

Mixed batch (icons + duotone + illustrations → 1 PR):
```bash
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/nhut/nhut-bitbucket && source ~/.nvm/nvm.sh && node run build:bundles && cp -f dist/* .claude/skills/export-icon/ && PROJECT_ROOT=/Users/muji/dev/theme_icons node .claude/skills/export-icon/scripts/workflow.bundle.js \
  --icon "Lock Shield" \
  --duotone "Love Swan" --duotone "Kiwi Bird" \
  --illustration "Armed Jeep" \
  --theme-path /Users/muji/dev/luz_next/libs/klara-theme \
  --red-bull
```

> [!NOTE]
> The script prints **all progress to stderr** and a single **JSON object to stdout**.
> Capture stdout separately if needed: `node workflow.bundle.js ... 2>/dev/null`

### What the script does automatically:
1. Clones `git@bitbucket-nhut:axonivy-prod/theme_icons.git` to an isolated temp dir (5 retries)
2. Audits `project.nucleo` files for **all pipelines** — skips icons already exported
3. Runs each pipeline's export sequentially (font generation + copy to klara-theme)
4. **Single commit + push** covering all pipelines → **one PR**
5. Cleans up the temp directory

### JSON output shape:
```json
{
  "status": "success | partial | failed",
  "prUrl": "https://bitbucket.org/axonivy-prod/theme_icons/pull-requests/new?source=feature/export-icons-{ID}&t=1",
  "branchName": "feature/export-icons-{ID}",
  "pipelines": {
    "icon":         { "exported": ["Lock Shield"], "alreadyDone": [], "failed": [] },
    "duotone":      { "exported": ["Love Swan"],   "alreadyDone": [], "failed": [] },
    "illustration": { "exported": [],              "alreadyDone": [], "failed": [] }
  },
  "diff": "--- a/_icons-map.scss\n...",
  "error": null
}
```

### Hard-stop conditions:
- `status: "failed"` with `error` field set — report to user, do NOT proceed.
- Clone fails after 5 retries — the error message will tell you.

## STEP 3 — Slack Notification & Manual PR

1. Post to `C0ATJ5WV7TR` with:
   - Final PR URL `prUrl`
   - `pipelines.icon.exported`, `pipelines.duotone.exported`, `pipelines.illustration.exported` (non-empty lists only)
   - Any `alreadyDone` items (if any)

---

### Optional flags (advanced use):
| Flag | Effect |
|------|--------|
| `--skip-git` | Skip branch/commit/push (dry-run export only) |
| `--skip-cleanup` | Keep temp directory after run (for debugging) |
| `--branch-id <id>` | Override the timestamp-based branch ID |
| `--git-name <n>` | Override git author name |
| `--git-email <e>` | Override git author email |
| `--red-bull` | Enable Red Bull mode | directly working on the luz_next and theme_icons folders. Use with caution and only if you know exactly why you need it. Not recommended for general use. |
