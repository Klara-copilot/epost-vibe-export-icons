# export-icon.js

Automates the Streamline icon-font export pipeline for all 4 styles (Light / Regular / Bold / Glyph).

## What it does

### Phase 1 — Search & Register
1. Prompts for a search term; searches source dirs for Light, Regular, and Bold **as you type** (live filesystem search).
2. Shows only icons whose name exists in all 3 sources. Icons already added this session are grayed out.
3. After you pick an icon, registers it in all 4 nc-projects with a shared `place` value.
4. Shows a place-sync summary table after each addition.
5. Asks "Add another icon?" — loops until you say no.

### Phase 2 — Export fonts
Pauses and tells you to run the font export tools (`export-cli.mjs` / `nucleo-export.js`).

### Phase 3 — Deploy to klara-theme *(requires `--theme-path`)*
- Copies all font files from the 4 export dirs to `<klara-theme>/public/assets/fonts/`.
- Extracts the icon map from the Regular set's `icons.scss` and merges it into `<klara-theme>/src/lib/styles/core/icons/_icons-map.scss`.

---

## Prerequisites

Set these in your `.env` file (project root):

| Variable | Required | Description |
|---|---|---|
| `PROJECT_ROOT` | Yes | Path to the theme_icons repo |
| `NUCLEO_UUID_LIGHT/REGULAR/BOLD/GLYPH` | Yes | nc-project folder UUIDs |
| `OUTPUT_SUBDIR_LIGHT/REGULAR/BOLD/GLYPH` | Yes | Output subdirs (relative to PROJECT_ROOT) |
| `ASSETS_MY_SETS` | No | Root of source SVG assets. Defaults to `$PROJECT_ROOT/_Assets/my-sets` |
| `SOURCE_DIR_LIGHT/REGULAR/BOLD` | No | Override individual source dirs |

---

## Usage

```bash
# Fully interactive (recommended)
node scripts/export-icon.js

# With theme deploy
node scripts/export-icon.js --theme-path /path/to/klara-theme

# Pre-fill the first search term
node scripts/export-icon.js --name "Lock Shield"
node scripts/export-icon.js --name "Lock Shield" --theme-path /path/to/klara-theme
```

---

## Test cases

### Case 1 — Live search, single result

**Input:**
User types `Lock Shield` in the search prompt.

**Expected output:**
- Dropdown shows: `Lock Shield`
- Selected → copies and registers in all 4 projects
- Place-sync summary printed
- Prompt: "Add another icon? (Y/n)"

---

### Case 2 — Search returns multiple results

**Input:**
User types `Lock` in the search prompt.

**Expected output:**
- Dropdown shows: `Lock`, `Lock Shield`, `Lock Open` (all present in all 3 sources)
- User picks one; others remain available for subsequent searches

---

### Case 3 — Add multiple icons in one session

**Input:**
User adds `Lock Shield`, confirms "Add another", then adds `File Move`, then says no.

**Expected output:**
- Both icons registered
- `2 icon(s) registered: Lock Shield, File Move`
- Proceeds to Phase 2 prompt

---

### Case 4 — Search returns no cross-source results

**Input:**
User types `xyz` — icon not found in all 3 sources.

**Expected output:**
```
No icons matching "xyz" found in all 3 sources
```
Dropdown shows the message as a disabled entry. User can retype to search again.

---

### Case 5 — Icon already registered, shown as grayed out

**Input:**
User searches `Lock Shield` — it already exists in all 4 projects.

**Expected output:**
- Dropdown shows: `Lock Shield  [already added this session]` (disabled/grayed)
- If user somehow selects it: `'Lock Shield' was already present in all 4 projects — nothing added.`

---

### Case 6 — Phase 3 without --theme-path

After export confirmation, no `--theme-path` provided.

**Expected output:**
```
No --theme-path provided. Manual copy required:
  Light fonts: /.../sets/Icons Font Light/fonts
    -> <klara-theme>/public/assets/fonts/
  ...
```
