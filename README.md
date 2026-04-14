# vibe_icon — Nucleo Export Pipeline

Headless reproduction of NucleoApp's export pipeline. Generates icon fonts and SVG sprite sets from Nucleo project files without requiring the NucleoApp GUI.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
  - [.env file](#env-file)
  - [Environment variables reference](#environment-variables-reference)
- [Usage](#usage)
  - [Interactive CLI (recommended)](#interactive-cli-recommended)
  - [Direct script invocation](#direct-script-invocation)
  - [Watch mode](#watch-mode)
- [Output structure](#output-structure)
  - [Icon font pipeline](#icon-font-pipeline)
  - [SVG sprite pipeline](#svg-sprite-pipeline)
- [Styles reference](#styles-reference)

---

## Prerequisites

- **Node.js** 18+
- **NucleoApp** project files — each style maps to a Nucleo project folder identified by a UUID (e.g. `nc-projects/0fb05cef24426bce2d2320/`). Each folder must contain:
  - `project.nucleo` — JSON project manifest (icon list, palette, export config)
  - `{icon_uuid}.svg` — one SVG file per icon

---

## Installation

```bash
npm install
```

---

## Configuration

### .env file

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Then edit `.env`. All paths support `~` as shorthand for your home directory.

### Environment variables reference

#### `PROJECT_ROOT` *(required)*

Root directory that contains all your icon project data. The scripts derive all other paths from this.

```
PROJECT_ROOT=~/Work/Projects/theme_icons
```

Expected layout under `PROJECT_ROOT`:

```
theme_icons/
├── nc-projects/
│   ├── {NUCLEO_UUID_GLYPH}/        ← project.nucleo + *.svg
│   ├── {NUCLEO_UUID_REGULAR}/
│   ├── {NUCLEO_UUID_BOLD}/
│   ├── {NUCLEO_UUID_LIGHT}/
│   ├── {NUCLEO_UUID_ILLUSTRATIONS}/
│   ├── {NUCLEO_UUID_ILLUSTRATIONS_DUOTONE}/
│   └── {NUCLEO_UUID_ILLUSTRATIONS_PART3}/
└── _Assets/                        ← generated output
    ├── StreamlineIcons/
    ├── StreamlineIllustrator/
    └── StreamlineDuotoneIcons/
```

#### Nucleo project UUIDs

Each style maps to a Nucleo project by UUID. Find these in NucleoApp under *Project → Info*.

| Variable | Style |
|---|---|
| `NUCLEO_UUID_GLYPH` | streamline-icons-glyph |
| `NUCLEO_UUID_REGULAR` | streamline-icons-regular |
| `NUCLEO_UUID_BOLD` | streamline-icons-bold |
| `NUCLEO_UUID_LIGHT` | streamline-icons-light |
| `NUCLEO_UUID_ILLUSTRATIONS` | streamline-illustrations |
| `NUCLEO_UUID_ILLUSTRATIONS_DUOTONE` | streamline-illustrations-duotone |
| `NUCLEO_UUID_ILLUSTRATIONS_PART3` | streamline-illustrations-3 |

#### Output subdirectories

Each style writes its output to a subdirectory relative to `PROJECT_ROOT`. Customize these if your asset folder layout differs.

| Variable | Default value |
|---|---|
| `OUTPUT_SUBDIR_GLYPH` | `/_Assets/StreamlineIcons/sets/Icons Font Glyph` |
| `OUTPUT_SUBDIR_REGULAR` | `/_Assets/StreamlineIcons/sets/Icons Font Regular` |
| `OUTPUT_SUBDIR_BOLD` | `/_Assets/StreamlineIcons/sets/Icons Font Bold` |
| `OUTPUT_SUBDIR_LIGHT` | `/_Assets/StreamlineIcons/sets/Icons Font Light` |
| `OUTPUT_SUBDIR_ILLUSTRATIONS` | `/_Assets/StreamlineIllustrator` |
| `OUTPUT_SUBDIR_ILLUSTRATIONS_DUOTONE` | `/_Assets/StreamlineDuotoneIcons` |
| `OUTPUT_SUBDIR_ILLUSTRATIONS_PART3` | `/_Assets/StreamlineIllustrator` |

#### Source SVG directories (optional)

Used by the helper import scripts (`scripts/export-illustration.js`, `scripts/export-duotone.js`). Set `ASSETS_MY_SETS` to point at your Streamline asset root, or override individual directories:

```
#ASSETS_MY_SETS=~/path/to/assets
#SOURCE_DIR_LIGHT=
#SOURCE_DIR_REGULAR=
#SOURCE_DIR_BOLD=
#SOURCE_DIR_DUOTONE=
#SOURCE_DIR_ILLUSTRATIONS_FILLED=
#SOURCE_DIR_ILLUSTRATIONS_LINE=
```

---

## Usage

### Interactive CLI (recommended)

```bash
npm run cli
# or
node export-cli.mjs
```

The CLI will:
1. Ask which style to export (glyph / regular / bold / light / illustrations / duotone / illustrations-3)
2. Prompt for metadata (author, version, description, copyright) — all have sensible defaults
3. Prompt for font settings (font name, class prefix, base class) — pre-filled from the style preset
4. Confirm the project directory and output directory (derived automatically from `.env`)
5. Ask for final confirmation, then launch the appropriate script

### Direct script invocation

You can bypass the CLI and call the underlying scripts directly.

**Icon font** (glyph / regular / bold / light):

```bash
node nucleo-export.js [project_dir] [output_dir]

# Example — export the Regular set:
node nucleo-export.js \
  ~/Work/Projects/theme_icons/nc-projects/c5edc7b0c2248ad45629e8 \
  ~/Work/Projects/theme_icons/_Assets/StreamlineIcons/sets/Icons\ Font\ Regular
```

**SVG sprite** (illustrations / duotone / illustrations-3):

```bash
node nucleo-sprite.js [project_dir] [output_dir]

# Example — export illustrations:
node nucleo-sprite.js \
  ~/Work/Projects/theme_icons/nc-projects/56bdad0faf1a268721a5f4 \
  ~/Work/Projects/theme_icons/_Assets/StreamlineIllustrator
```

Both scripts also accept paths via environment variables as a fallback:

```bash
PROJECT_DIR=/path/to/nc-projects/uuid OUTPUT_DIR=/path/to/output node nucleo-export.js
```

When launched by `export-cli.mjs`, the export config is passed through a temporary JSON file via the `EXPORT_CONFIG` environment variable — no need to set this manually.

### Watch mode

Watches the project directory for changes to `project.nucleo` or any `*.svg` file and re-runs the icon font export automatically (300 ms debounce):

```bash
npm run watch
# or
node nucleo-watch.js [project_dir] [output_dir]
```

> **Note:** Watch mode runs `nucleo-export.js` only (icon font pipeline). For sprite sets, re-run `nucleo-sprite.js` manually after making changes.

---

## Output structure

### Icon font pipeline

```
{outputDir}/
├── fonts/
│   ├── {fontname}.eot
│   ├── {fontname}.ttf
│   ├── {fontname}.woff
│   ├── {fontname}.woff2
│   └── {fontname}.svg
├── css/
│   └── icons.css
├── scss/
│   └── icons.scss
├── less/
│   └── icons.less
├── unicodesMap.json
├── demo.html
└── demo/
```

### SVG sprite pipeline

```
{outputDir}/
├── img/
│   └── streamline-icons.svg   ← SVG <symbol> sprite
├── style.css                  ← base CSS with custom properties
├── demo.html                  ← interactive demo page
└── demo/
    └── css/
        └── style.css
```

Reference icons in HTML via:

```html
<svg class="streamline-icon">
  <use href="img/streamline-icons.svg#streamline-icon-{name}"></use>
</svg>
```

---

## Styles reference

| Style key | Pipeline | Class base | Output subdir |
|---|---|---|---|
| `streamline-icons-glyph` | icon font | `stg` | `_Assets/StreamlineIcons/sets/Icons Font Glyph` |
| `streamline-icons-regular` | icon font | `str` | `_Assets/StreamlineIcons/sets/Icons Font Regular` |
| `streamline-icons-bold` | icon font | `stb` | `_Assets/StreamlineIcons/sets/Icons Font Bold` |
| `streamline-icons-light` | icon font | `stl` | `_Assets/StreamlineIcons/sets/Icons Font Light` |
| `streamline-illustrations` | SVG sprite | `sti` | `_Assets/StreamlineIllustrator` |
| `streamline-illustrations-duotone` | SVG sprite | `stid` | `_Assets/StreamlineDuotoneIcons` |
| `streamline-illustrations-3` | SVG sprite | `sti3` | `_Assets/StreamlineIllustrator` |