# export-illustration.js

Automates the Streamline illustration export pipeline for the Part 3 Nucleo project (Filled + UX Line sources).

## What it does

### Phase 1 — Search & Register
1. Searches two source asset directories — **Steamline Filled** and **UX Line** — for `.svg` files matching the name. Results from both sources are merged into a single list.
2. Auto-selects if there is only one match; otherwise shows a multi-select checkbox prompt.
3. Copies each selected SVG into the Part 3 nc-project folder with a UUID filename and registers it in `project.nucleo` with `klass: outline`, `grid: 128`, `fill_all: 1`. A `.bak` backup is made before writing.

### Phase 2 — Export sprite
Pauses and tells you to run the sprite export (`nucleo-sprite.js` / `export-cli.mjs`).
If the output SVG exceeds 1 MB, a warning is shown — consider splitting into a new part.

### Phase 3 — Deploy to klara-theme *(requires `--theme-path`)*
Copies exported SVG file(s) from the output `img/` dir to `<klara-theme>/src/lib/assets/icons/`.
Existing files are backed up with a `.bak` extension before overwriting.

---

## Prerequisites

Set these in your `.env` file (project root):

| Variable | Required | Description |
|---|---|---|
| `PROJECT_ROOT` | Yes | Path to the theme_icons repo |
| `NUCLEO_UUID_ILLUSTRATIONS_PART3` | No | UUID of the Part 3 nc-project. Defaults to `b8eee6355fe83a71ddffaa` |
| `OUTPUT_SUBDIR_ILLUSTRATIONS` | Yes | Output subdir (relative to PROJECT_ROOT) |
| `ASSETS_MY_SETS` | No | Root of source SVG assets. Defaults to `$PROJECT_ROOT/_Assets/my-sets` |
| `SOURCE_DIR_ILLUSTRATIONS_FILLED` | No | Override Steamline Filled source dir |
| `SOURCE_DIR_ILLUSTRATIONS_LINE` | No | Override UX Line source dir |

---

## Usage

```bash
# Search + register only
node scripts/export-illustration.js --name "User Smiling"

# Full pipeline including Phase 3 deploy
node scripts/export-illustration.js --name "User Smiling" --theme-path /path/to/klara-theme

# Short flags
node scripts/export-illustration.js -n "User Smiling" -t /path/to/klara-theme

# Name as positional arg
node scripts/export-illustration.js "User Smiling"
```

---

## Test cases

### Case 1 — Single match, auto-selected

**Input:**
```
--name "User Smiling"
```
Only one `User Smiling.svg` found across both source dirs.

**Expected output:**
- "Auto-selecting the only match."
- Copies `User Smiling.svg` → `<uuid>.svg` in nc-project
- Registers with `klass: "outline"`, `fill_all: 1`, `grid: 128`
- `project.nucleo.bak` created

---

### Case 2 — Results from multiple source dirs

**Input:**
```
--name "Dove"
```
- `Steamline Filled` has `Dove.svg`
- `UX Line` also has `Dove.svg`

**Expected output:**
- Shows checkbox list combining both:
  ```
  [1] Steamline Filled (Fixed with oslllo-svg-fixer)/Dove.svg
  [2] UX Line/Dove.svg
  ```
- User selects desired variant(s)

---

### Case 3 — All selected already registered

**Input:**
```
--name "User Smiling"
```
`User Smiling` is already in `project.nucleo`.

**Expected output:**
```
[SKIP] 'User Smiling' already exists (uuid: <uuid>)
ERROR: All selected illustrations already exist in Part 3. No changes made.
```
Exits without modifying any files.

---

### Case 4 — No match found

**Input:**
```
--name "Dragon"
```
No SVG matches in either source dir.

**Expected output:**
```
No illustrations found matching 'Dragon'.
Searched in:
  - /.../Steamline Filled (Fixed with oslllo-svg-fixer)
  - /.../UX Line
```
Exits with code 1.

---

### Case 5 — Output SVG exceeds 1 MB

After confirming export, the SVG in the `img/` dir is larger than 1 MB.

**Expected output:**
```
Found exported SVG(s):
  streamline-icons.svg (1243.5 KB)
  WARNING: File exceeds 1 MB - consider splitting into a new part!
```

---

### Case 6 — Phase 3, no export SVG found

After confirming the export, the `img/` directory is empty or doesn't exist.

**Expected output:**
```
ERROR: No SVG files found in /.../StreamlineIllustrator/img
Ensure the export ran successfully and saved to the correct folder.
```
Exits with code 1.
