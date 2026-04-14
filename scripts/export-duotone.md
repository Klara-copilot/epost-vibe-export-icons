# export-duotone.js

Automates the Streamline duotone illustration export pipeline (single Nucleo project).

## What it does

### Phase 1 — Search & Register
1. Searches the UX Duotone source asset directory for `.svg` files matching the name.
2. Lists all matches; auto-selects if there is only one, otherwise prompts (multi-select via checkbox).
3. Copies each selected SVG into the nc-project folder with a UUID filename and registers it in `project.nucleo` with `klass: colored`, `grid: 128`, `fill_all: 0`. A `.bak` backup is made before writing.
4. The `filename` field in `project.nucleo` stores the original SVG name (not the UUID), matching NucleoApp behavior.

### Phase 2 — Export sprite
Pauses and tells you to run the sprite export (`nucleo-sprite.js` / `export-cli.mjs`).
If color replacement (`ReplaceColorsInDuotone.bat`) is needed, run that first.

### Phase 3 — Deploy to klara-theme *(requires `--theme-path`)*
Copies `streamline-icon-duotone.svg` from the export output dir to `<klara-theme>`.

---

## Prerequisites

Set these in your `.env` file (project root):

| Variable | Required | Description |
|---|---|---|
| `PROJECT_ROOT` | Yes | Path to the theme_icons repo |
| `NUCLEO_UUID_ILLUSTRATIONS_DUOTONE` | Yes | UUID of the duotone nc-project |
| `OUTPUT_SUBDIR_ILLUSTRATIONS_DUOTONE` | Yes | Output subdir (relative to PROJECT_ROOT) |
| `ASSETS_MY_SETS` | No | Root of source SVG assets. Defaults to `$PROJECT_ROOT/_Assets/my-sets` |
| `SOURCE_DIR_DUOTONE` | No | Override duotone source dir |

---

## Usage

```bash
# Search + register only
node scripts/export-duotone.js --name "Dove"

# Full pipeline including Phase 3 deploy
node scripts/export-duotone.js --name "Dove" --theme-path /path/to/klara-theme

# Short flags
node scripts/export-duotone.js -n "Dove" -t /path/to/klara-theme

# Name as positional arg
node scripts/export-duotone.js "Dove"
```

---

## Test cases

### Case 1 — Single match, auto-selected

**Input:**
```
--name "Dove"
```
Source dir contains exactly one `Dove.svg`.

**Expected output:**
- "Auto-selecting the only match."
- Copies `Dove.svg` → `<uuid>.svg` in nc-project
- Registers in `project.nucleo` with `filename: "Dove.svg"`, `klass: "colored"`, `fill_all: 0`, `grid: 128`
- `project.nucleo.bak` created

---

### Case 2 — Multiple matches, multi-select

**Input:**
```
--name "Thumbs"
```
Source dir contains: `Thumbs Up.svg`, `Thumbs Down.svg`.

**Expected output:**
- Shows checkbox list: `[1] Thumbs Up.svg` / `[2] Thumbs Down.svg`
- Both are registered if selected
- Both appended in a single `project.nucleo` write with consecutive `place` values

---

### Case 3 — Illustration already registered

**Input:**
```
--name "Dove"
```
`Dove` is already in `project.nucleo`.

**Expected output:**
```
[SKIP] 'Dove' already exists in project.nucleo (uuid: <uuid>)
No new illustrations added.
```
Exits without modifying any files.

---

### Case 4 — No match found

**Input:**
```
--name "Unicorn"
```
No SVG matches in the source dir.

**Expected output:**
```
No illustrations found matching 'Unicorn'.
Available categories:
  - Animals
  - Business
  ...
```
Exits with code 1.

---

### Case 5 — Phase 3, export SVG not found

After confirming export, `streamline-icon-duotone.svg` does not exist at the expected path.

**Expected output:**
```
ERROR: Exported file not found at '/.../StreamlineDuotoneIcons/img/streamline-icon-duotone.svg'.
Ensure the export completed and the file was saved to the correct location.
```
Exits with code 1.
