'use strict';

const path = require('path');
const fs   = require('fs');

const {
  generateUuid, findSvgs, readProjectNucleo, buildIconJson,
  spliceIconsIntoRawJson, validateJson, writeProjectNucleo, stripLeadingSlash,
  spawnExportCaptured, backupOutsideRepo,
} = require('./common');
const { replaceColorsDuotone } = require('./replace-colors-duotone');

// Repo root (scripts/lib/pipelines.js -> up two levels)
const REPO_ROOT = path.join(__dirname, '..', '..');

// ─── Icon-map SCSS merge helpers ─────────────────────────────────────────────
// The target _icons-map.scss stores a single `$streamline-icons: ( … )` map,
// tab-indented, one `'name': 'code',` per line (every line, including the last,
// has a trailing comma). To keep PR diffs minimal and non-destructive we MERGE
// new icons into the existing map instead of replacing the whole block:
//   - existing entries keep their exact order + codepoints (byte-identical lines)
//   - only genuinely-new names are appended before the closing `)`
//   - nothing is ever removed

/**
 * Parse a `'name': 'code'` map body into an ordered Map<name, code>.
 * Accepts the raw text found between the outer parentheses.
 */
function parseIconMapEntries(mapBody) {
  const entries = new Map();
  const re = /'([^']+)'\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(mapBody)) !== null) {
    entries.set(m[1], m[2]);
  }
  return entries;
}

/**
 * Serialize an ordered Map<name, code> back into a tab-indented
 * `$streamline-icons: ( … )` block matching the existing file's style
 * (every entry, including the last, ends with a trailing comma).
 */
function serializeStreamlineIconsMap(entries) {
  const lines = [];
  for (const [name, code] of entries) {
    lines.push(`\t'${name}': '${code}',`);
  }
  return `$streamline-icons: (\n${lines.join('\n')}\n)`;
}

/**
 * Read the embedded font version from a deployed SVG webfont's
 * `<metadata><json><![CDATA[ { … "version": "1.39" … } ]]></json></metadata>`
 * block. Returns the version string, or null if unavailable/unparseable.
 */
function readDeployedFontVersion(svgFontPath) {
  try {
    if (!fs.existsSync(svgFontPath)) return null;
    const svg = fs.readFileSync(svgFontPath, 'utf8');
    const meta = svg.match(/<metadata>\s*<json>\s*<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (!meta) return null;
    const parsed = JSON.parse(meta[1]);
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Bump the last dot-separated numeric segment of a version string.
 * "1.39" -> "1.40", "0.55" -> "0.56". Returns null if not bumpable.
 */
function bumpVersion(version) {
  if (typeof version !== 'string') return null;
  const parts = version.split('.');
  const last = Number(parts[parts.length - 1]);
  if (!Number.isFinite(last)) return null;
  parts[parts.length - 1] = String(last + 1);
  return parts.join('.');
}

/**
 * Before exporting, align each style's embedded font version with what is
 * already deployed in the target theme (read + bump), instead of the hardcoded
 * placeholder defaults. Mutates paths.FONT_EXPORT_CONFIGS in place. Falls back
 * silently to the existing default when the deployed font can't be read.
 * Returns a { style: version } map of what was applied, for logging.
 */
function applyFontVersions(paths, themePath, log = () => {}) {
  const applied = {};
  const fontsDir = path.join(themePath, 'public', 'assets', 'fonts');
  for (const style of paths.STYLE_ORDER) {
    const cfg = paths.FONT_EXPORT_CONFIGS[style];
    const fontname = cfg.iconfont.fontname;            // e.g. streamline-icons-regular
    const deployed = readDeployedFontVersion(path.join(fontsDir, `${fontname}.svg`));
    const bumped = bumpVersion(deployed);
    if (bumped) {
      cfg.iconfont.metadata.version = bumped;
      applied[style] = bumped;
      log(`[VERSION] [${style}] ${deployed} -> ${bumped}`);
    } else {
      applied[style] = cfg.iconfont.metadata.version;
      log(`[VERSION] [${style}] keeping default ${cfg.iconfont.metadata.version} (no deployed version found)`);
    }
  }
  return applied;
}

// ═══════════════════════════════════════════════════════════════════════════
// Icon pipeline (Light / Regular / Bold / Glyph)
// ═══════════════════════════════════════════════════════════════════════════

function resolveIconPaths(projectRoot) {
  const ASSETS_MY_SETS = process.env.ASSETS_MY_SETS
    || path.join(projectRoot, '_Assets', 'my-sets');

  const ICONSET_ROOT = path.join(
    ASSETS_MY_SETS, 'Streamline Iconsets', 'Streamline Iconset 5.0',
  );

  const SOURCE_DIRS = {
    Light:   process.env.SOURCE_DIR_LIGHT   || path.join(ICONSET_ROOT, 'Ultimate Light'),
    Regular: process.env.SOURCE_DIR_REGULAR || path.join(ICONSET_ROOT, 'Ultimate Regular'),
    Bold:    process.env.SOURCE_DIR_BOLD    || path.join(ICONSET_ROOT, 'Ultimate Bold'),
  };

  const NC_PROJECTS = {
    Light:   { dir: path.join(projectRoot, 'nc-projects', process.env.NUCLEO_UUID_LIGHT   || ''), title: 'App / Icons / Light'   },
    Regular: { dir: path.join(projectRoot, 'nc-projects', process.env.NUCLEO_UUID_REGULAR || ''), title: 'App / Icons / Regular' },
    Bold:    { dir: path.join(projectRoot, 'nc-projects', process.env.NUCLEO_UUID_BOLD    || ''), title: 'App / Icons / Bold'    },
    Glyph:   { dir: path.join(projectRoot, 'nc-projects', process.env.NUCLEO_UUID_GLYPH   || ''), title: 'App / Icons / Glyph'   },
  };
  for (const k of Object.keys(NC_PROJECTS)) {
    NC_PROJECTS[k].nucleo = path.join(NC_PROJECTS[k].dir, 'project.nucleo');
  }

  const EXPORT_DIRS = {
    Light:   path.join(projectRoot, stripLeadingSlash(process.env.OUTPUT_SUBDIR_LIGHT   || '_Assets/StreamlineIcons/sets/Icons Font Light')),
    Regular: path.join(projectRoot, stripLeadingSlash(process.env.OUTPUT_SUBDIR_REGULAR || '_Assets/StreamlineIcons/sets/Icons Font Regular')),
    Bold:    path.join(projectRoot, stripLeadingSlash(process.env.OUTPUT_SUBDIR_BOLD    || '_Assets/StreamlineIcons/sets/Icons Font Bold')),
    Glyph:   path.join(projectRoot, stripLeadingSlash(process.env.OUTPUT_SUBDIR_GLYPH   || '_Assets/StreamlineIcons/sets/Icons Font Glyph')),
  };

  const STYLE_ORDER = ['Light', 'Regular', 'Bold', 'Glyph'];

  const SHARED_META = { author: 'Klara Design', description: 'Built on Streamline 3.0', copyright: 'Klara Design', license: '', url: '' };
  const FONT_EXPORT_CONFIGS = {
    Light: {
      iconfont: {
        fontname: 'streamline-icons-light', classprefix: 'st-', classnamebase: 'stl',
        encode: false, ligatures: false, improveOutline: true,
        metrics: { enable: false, ascent: '256', descent: '0' },
        metadataEnable: true, metadata: { ...SHARED_META, version: '0.55' },
      },
    },
    Regular: {
      iconfont: {
        fontname: 'streamline-icons-regular', classprefix: 'st-', classnamebase: 'str',
        encode: false, ligatures: false, improveOutline: true,
        metrics: { enable: false, ascent: '256', descent: '0' },
        metadataEnable: true, metadata: { ...SHARED_META, version: '0.1' },
      },
    },
    Bold: {
      iconfont: {
        fontname: 'streamline-icons-bold', classprefix: 'st-', classnamebase: 'stb',
        encode: false, ligatures: false, improveOutline: false,
        metrics: { enable: false, ascent: '256', descent: '0' },
        metadataEnable: true, metadata: { ...SHARED_META, version: '0.1' },
      },
    },
    Glyph: {
      iconfont: {
        fontname: 'streamline-icons-glyph', classprefix: 'st-', classnamebase: 'stg',
        encode: false, ligatures: false, improveOutline: false,
        metrics: { enable: false, ascent: '256', descent: '0' },
        metadataEnable: true, metadata: { ...SHARED_META, version: '0.1' },
      },
    },
  };

  return {
    SOURCE_DIRS,
    NC_PROJECTS,
    EXPORT_DIRS,
    STYLE_ORDER,
    FONT_EXPORT_CONFIGS,
    NUCLEO_EXPORT_SCRIPT: path.join(REPO_ROOT, 'nucleo-export.js'),
  };
}

/**
 * Search all 3 source dirs for `term` and return icon names that exist in all 3.
 * Returns array of { name, files: { Light, Regular, Bold } }.
 */
function searchIconPipeline(paths, term) {
  if (!term || !term.trim()) return [];

  const foundByStyle = {};
  const nameToStyles = {};

  for (const style of ['Light', 'Regular', 'Bold']) {
    const found = findSvgs(paths.SOURCE_DIRS[style], term.trim());
    foundByStyle[style] = found;
    for (const f of found) {
      if (!nameToStyles[f.basename]) nameToStyles[f.basename] = [];
      nameToStyles[f.basename].push(style);
    }
  }

  return Object.keys(nameToStyles)
    .filter(n => nameToStyles[n].length === 3)
    .sort()
    .map(name => ({
      name,
      files: {
        Light:   foundByStyle['Light'].find(f => f.basename === name),
        Regular: foundByStyle['Regular'].find(f => f.basename === name),
        Bold:    foundByStyle['Bold'].find(f => f.basename === name),
      },
    }));
}

/**
 * Find an icon whose name exactly matches (case-insensitive) across all 3
 * source dirs. Falls back to the sole result if there is exactly one match.
 */
function findIconExact(paths, name) {
  const results = searchIconPipeline(paths, name);
  return results.find(r => r.name.toLowerCase() === name.trim().toLowerCase())
    || (results.length === 1 ? results[0] : null);
}

/**
 * Register one icon into all 4 nc-projects with a shared `place` value.
 * Returns the number of projects the icon was newly registered into
 * (0 if it already existed everywhere).
 */
function registerIconPipeline(paths, iconName, iconFiles, log = () => {}) {
  let maxPlace = 0;
  for (const style of paths.STYLE_ORDER) {
    const { maxPlace: mp } = readProjectNucleo(paths.NC_PROJECTS[style].nucleo);
    if (mp > maxPlace) maxPlace = mp;
  }
  const nextPlace = maxPlace + 1;

  let registeredCount = 0;
  const styleFiles = { ...iconFiles, Glyph: iconFiles['Bold'] };

  for (const style of paths.STYLE_ORDER) {
    const nc      = paths.NC_PROJECTS[style];
    const srcFile = styleFiles[style];

    const { rawJson, obj, existingNames } = readProjectNucleo(nc.nucleo);

    if (existingNames.has(iconName)) {
      const existing = (obj.icons || []).find(i => i.name === iconName);
      log(`[SKIP] [${style}] '${iconName}' already exists (place: ${existing ? existing.place : '?'})`);
      continue;
    }

    const newUuid  = generateUuid();
    const destPath = path.join(nc.dir, newUuid + '.svg');
    fs.copyFileSync(srcFile.fullPath, destPath);
    log(`[COPY] [${style}] ${path.basename(srcFile.fullPath)} -> ${newUuid}.svg`);

    const iconKlass = (style === 'Light' || style === 'Regular') ? 'outline' : 'glyph';
    const iconJson  = buildIconJson({
      uuid: newUuid, name: iconName,
      width: 24, height: 24, klass: iconKlass,
      grid: 24, place: nextPlace, fillAll: 1,
    });

    const initialCount = (obj.icons || []).length;
    const updatedRaw   = spliceIconsIntoRawJson(rawJson, [iconJson], initialCount);
    validateJson(updatedRaw, nc.title);

    writeProjectNucleo(nc.nucleo, updatedRaw);
    log(`[SAVE] [${style}] project.nucleo updated (backup in temp dir)`);
    registeredCount++;
  }

  return registeredCount;
}

/**
 * Copy generated fonts (to BOTH public/ and src/ font dirs) + merge the Regular
 * SCSS icon map into klara-theme. Throws with a descriptive message on any
 * missing source/target path.
 */
function deployIconPipeline(paths, themePath) {
  const fontsTargetDir = path.join(themePath, 'public', 'assets', 'fonts');
  if (!fs.existsSync(fontsTargetDir)) {
    throw new Error(`Fonts target dir not found: ${fontsTargetDir}`);
  }

  // The library also ships a copy under src/lib/assets/fonts (bundled into the
  // published component package). NucleoApp updates both; we must too, or the
  // two dirs drift out of sync. Created if missing.
  const srcFontsTargetDir = path.join(themePath, 'src', 'lib', 'assets', 'fonts');
  fs.mkdirSync(srcFontsTargetDir, { recursive: true });

  const copiedFiles = [];
  for (const style of paths.STYLE_ORDER) {
    const fontsSourceDir = path.join(paths.EXPORT_DIRS[style], 'fonts');
    for (const fname of fs.readdirSync(fontsSourceDir)) {
      const src = path.join(fontsSourceDir, fname);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(fontsTargetDir, fname));
        fs.copyFileSync(src, path.join(srcFontsTargetDir, fname));
        copiedFiles.push(fname);
      }
    }
  }

  const scssSourcePath = path.join(paths.EXPORT_DIRS['Regular'], 'scss', 'icons.scss');
  const scssTargetPath = path.join(
    themePath, 'src', 'lib', 'styles', 'core', 'icons', '_icons-map.scss',
  );

  if (!fs.existsSync(scssSourcePath)) {
    throw new Error(`Generated SCSS not found: ${scssSourcePath}`);
  }
  if (!fs.existsSync(scssTargetPath)) {
    throw new Error(`SCSS target file not found: ${scssTargetPath}`);
  }

  // Generated map (variable name `$icons`).
  const generatedScss = fs.readFileSync(scssSourcePath, 'utf8');
  const mapMatch = generatedScss.match(/\$icons:\s*\(\s*([\s\S]*?)\s*\)/);
  if (!mapMatch) {
    throw new Error(`Could not extract map from generated icons.scss (${scssSourcePath})`);
  }
  const generatedEntries = parseIconMapEntries(mapMatch[1]);

  // Existing target map (variable name `$streamline-icons`).
  const existingScss = fs.readFileSync(scssTargetPath, 'utf8');
  const targetMatch  = existingScss.match(/\$streamline-icons:\s*\(\s*([\s\S]*?)\s*\)/);
  if (!targetMatch) {
    throw new Error(`Could not locate $streamline-icons map in ${scssTargetPath}`);
  }
  const mergedEntries = parseIconMapEntries(targetMatch[1]);

  // Additive merge: keep every existing entry (order + codepoint untouched),
  // append only names not already present. Never remove or reorder.
  let addedCount = 0;
  for (const [name, code] of generatedEntries) {
    if (!mergedEntries.has(name)) {
      mergedEntries.set(name, code);
      addedCount++;
    }
  }

  // Only rewrite the file when something actually changed, to avoid a
  // no-op-but-touched diff.
  const newBlock = serializeStreamlineIconsMap(mergedEntries);
  const updatedScss = existingScss.replace(
    /\$streamline-icons:\s*\(\s*[\s\S]*?\s*\)/,
    () => newBlock,
  );

  if (updatedScss !== existingScss) {
    // Back up to the OS temp dir (NOT a sibling .bak) so the backup never lands
    // inside the luz_next repo and leaks into the PR via `git add .`.
    backupOutsideRepo(scssTargetPath);
    fs.writeFileSync(scssTargetPath, updatedScss, 'utf8');
  }

  return { copiedFiles, scssTargetPath, iconsAdded: addedCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// Duotone illustration pipeline
// ═══════════════════════════════════════════════════════════════════════════

function resolveDuotonePaths(projectRoot) {
  const ASSETS_MY_SETS = process.env.ASSETS_MY_SETS
    || path.join(projectRoot, '_Assets', 'my-sets');
  const UX_ILLUST_ROOT = path.join(ASSETS_MY_SETS, 'Streamline UX Illustrations');

  const SOURCE_DIR = process.env.SOURCE_DIR_DUOTONE
    || path.join(UX_ILLUST_ROOT, 'UX Duotone');

  const NC_PROJECT_UUID = process.env.NUCLEO_UUID_ILLUSTRATIONS_DUOTONE || '';
  const NC_PROJECT_DIR  = path.join(projectRoot, 'nc-projects', NC_PROJECT_UUID);
  const NUCLEO_PATH     = path.join(NC_PROJECT_DIR, 'project.nucleo');

  const OUTPUT_SUBDIR = stripLeadingSlash(process.env.OUTPUT_SUBDIR_ILLUSTRATIONS_DUOTONE || '_Assets/StreamlineDuotoneIcons');
  const OUTPUT_DIR    = path.join(projectRoot, OUTPUT_SUBDIR);
  const SPRITE_INPUT_SVG = path.join(OUTPUT_DIR, 'img', 'streamline-icon-duotone.svg');
  const EXPORT_SVG       = path.join(OUTPUT_DIR, 'output', 'streamline-icon-duotone.svg');

  const SPRITE_CONFIG = {
    svgsprite: {
      baseClass:      'streamline-icon-duotone',
      idPrefix:       'streamline-icon-duotone-',
      assetsPath:     'img',
      fileName:       'streamline-icon-duotone.svg',
      metadataEnable: true,
      metadata: {
        author: 'Klara Design', description: 'Built on Streamline', version: '0.1',
        copyright: 'Klara Design', license: '', url: '',
      },
    },
  };

  return {
    UX_ILLUST_ROOT, SOURCE_DIR, NC_PROJECT_DIR, NUCLEO_PATH,
    OUTPUT_DIR, SPRITE_INPUT_SVG, EXPORT_SVG, SPRITE_CONFIG,
    NUCLEO_SPRITE_SCRIPT: path.join(REPO_ROOT, 'nucleo-sprite.js'),
  };
}

function searchDuotonePipeline(paths, term) {
  if (!term || !term.trim()) return [];
  return findSvgs(paths.SOURCE_DIR, term.trim()).sort((a, b) => a.basename.localeCompare(b.basename));
}

function registerDuotonePipeline(paths, selectedFile, existingNames, log = () => {}) {
  const svgBaseName = selectedFile.basename;
  const rel         = selectedFile.fullPath.replace(paths.UX_ILLUST_ROOT + path.sep, '');

  if (existingNames.has(svgBaseName)) {
    log(`[SKIP] '${svgBaseName}' already exists in project.nucleo (uuid: ${existingNames.get(svgBaseName)})`);
    return null;
  }

  const { rawJson, obj } = readProjectNucleo(paths.NUCLEO_PATH);
  const initialCount     = (obj.icons || []).length;
  const currentMax       = (obj.icons || []).reduce((m, i) => Math.max(m, i.place), 0);
  const nextPlace        = currentMax + 1;

  const newUuid  = generateUuid();
  const destPath = path.join(paths.NC_PROJECT_DIR, newUuid + '.svg');
  fs.copyFileSync(selectedFile.fullPath, destPath);
  log(`[COPY] ${rel} -> ${newUuid}.svg`);

  const iconJson = buildIconJson({
    uuid:     newUuid,
    name:     svgBaseName,
    filename: svgBaseName + '.svg',
    width:    100,
    height:   100,
    klass:    'colored',
    grid:     128,
    place:    nextPlace,
    fillAll:  0,
  });

  const updatedRaw = spliceIconsIntoRawJson(rawJson, [iconJson], initialCount);
  validateJson(updatedRaw, 'project.nucleo');

  writeProjectNucleo(paths.NUCLEO_PATH, updatedRaw);
  existingNames.set(svgBaseName, newUuid);
  log(`[ADD] Registered '${svgBaseName}' (uuid: ${newUuid}, place: ${nextPlace})`);
  return svgBaseName;
}

function deployDuotonePipeline(paths, themePath) {
  if (!fs.existsSync(paths.EXPORT_SVG)) {
    throw new Error(`Exported file not found at '${paths.EXPORT_SVG}'. Ensure the export completed.`);
  }
  const klaraTarget = path.join(themePath, 'src', 'lib', 'assets', 'icons', 'streamline-icon-duotone.svg');
  fs.copyFileSync(paths.EXPORT_SVG, klaraTarget);
  return { copiedFiles: ['streamline-icon-duotone.svg'], target: klaraTarget };
}

// ═══════════════════════════════════════════════════════════════════════════
// Illustration pipeline (Part 3 project — Filled + UX Line)
// ═══════════════════════════════════════════════════════════════════════════

const ILLUSTRATION_SOURCE_LABELS = ['Steamline Filled', 'UX Line'];

function resolveIllustrationPaths(projectRoot) {
  const ASSETS_MY_SETS = process.env.ASSETS_MY_SETS
    || path.join(projectRoot, '_Assets', 'my-sets');
  const UX_ILLUST_ROOT = path.join(ASSETS_MY_SETS, 'Streamline UX Illustrations');

  const SOURCE_DIRS = [
    process.env.SOURCE_DIR_ILLUSTRATIONS_FILLED
      || path.join(UX_ILLUST_ROOT, 'Steamline Filled (Fixed with oslllo-svg-fixer)'),
    process.env.SOURCE_DIR_ILLUSTRATIONS_LINE
      || path.join(UX_ILLUST_ROOT, 'UX Line'),
  ];

  const NC_PROJECT_UUID = process.env.NUCLEO_UUID_ILLUSTRATIONS_PART3 || 'b8eee6355fe83a71ddffaa';
  const NC_PROJECT_DIR  = path.join(projectRoot, 'nc-projects', NC_PROJECT_UUID);
  const NUCLEO_PATH     = path.join(NC_PROJECT_DIR, 'project.nucleo');

  const OUTPUT_SUBDIR = stripLeadingSlash(process.env.OUTPUT_SUBDIR_ILLUSTRATIONS || '_Assets/StreamlineIllustrator');
  const OUTPUT_DIR    = path.join(projectRoot, OUTPUT_SUBDIR);
  const EXPORT_DIR    = path.join(OUTPUT_DIR, 'img');

  const SPRITE_CONFIG = {
    svgsprite: {
      baseClass:      'streamline-icons',
      idPrefix:       'streamline-icons-',
      assetsPath:     'img',
      fileName:       'streamline-icons.svg',
      metadataEnable: true,
      metadata: {
        author: 'Klara Design', description: 'Built on Streamline', version: '0.1',
        copyright: 'Klara Design', license: '', url: '',
      },
    },
  };

  return {
    SOURCE_DIRS, NC_PROJECT_DIR, NUCLEO_PATH, OUTPUT_DIR, EXPORT_DIR, SPRITE_CONFIG,
    NUCLEO_SPRITE_SCRIPT: path.join(REPO_ROOT, 'nucleo-sprite.js'),
  };
}

/**
 * Search both source dirs. Returns array of { file, sourceLabel } sorted by
 * basename. Duplicates (same name in both sources) are kept as separate
 * entries so the caller can pick the preferred variant.
 */
function searchIllustrationPipeline(paths, term) {
  if (!term || !term.trim()) return [];
  const results = [];
  for (let i = 0; i < paths.SOURCE_DIRS.length; i++) {
    if (!fs.existsSync(paths.SOURCE_DIRS[i])) continue;
    for (const f of findSvgs(paths.SOURCE_DIRS[i], term.trim())) {
      results.push({ file: f, sourceLabel: ILLUSTRATION_SOURCE_LABELS[i] });
    }
  }
  return results.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
}

function registerIllustrationPipeline(paths, selectedFile, existingNames, log = () => {}) {
  const svgBaseName = selectedFile.basename;

  if (existingNames.has(svgBaseName)) {
    log(`[SKIP] '${svgBaseName}' already exists (uuid: ${existingNames.get(svgBaseName)})`);
    return null;
  }

  const { rawJson, obj } = readProjectNucleo(paths.NUCLEO_PATH);
  const initialCount     = (obj.icons || []).length;
  const currentMax       = (obj.icons || []).reduce((m, i) => Math.max(m, i.place), 0);
  const nextPlace        = currentMax + 1;

  const newUuid  = generateUuid();
  const destPath = path.join(paths.NC_PROJECT_DIR, newUuid + '.svg');
  fs.copyFileSync(selectedFile.fullPath, destPath);
  log(`[COPY] ${svgBaseName}.svg -> ${newUuid}.svg`);

  const iconJson = buildIconJson({
    uuid:    newUuid,
    name:    svgBaseName,
    width:   100,
    height:  100,
    klass:   'outline',
    grid:    128,
    place:   nextPlace,
    fillAll: 1,
  });

  const updatedRaw = spliceIconsIntoRawJson(rawJson, [iconJson], initialCount);
  validateJson(updatedRaw, 'project.nucleo');

  writeProjectNucleo(paths.NUCLEO_PATH, updatedRaw);
  existingNames.set(svgBaseName, newUuid);
  log(`[ADD] '${svgBaseName}' (uuid: ${newUuid}, place: ${nextPlace})`);
  return svgBaseName;
}

function deployIllustrationPipeline(paths, themePath) {
  const exportedFiles = fs.existsSync(paths.EXPORT_DIR)
    ? fs.readdirSync(paths.EXPORT_DIR).filter(f => f.endsWith('.svg'))
    : [];

  if (exportedFiles.length === 0) {
    throw new Error(`No SVG files found in ${paths.EXPORT_DIR}`);
  }

  const iconsTargetDir = path.join(themePath, 'src', 'lib', 'assets', 'icons');
  if (!fs.existsSync(iconsTargetDir)) {
    throw new Error(`Target dir not found: ${iconsTargetDir}`);
  }

  for (const fname of exportedFiles) {
    fs.copyFileSync(path.join(paths.EXPORT_DIR, fname), path.join(iconsTargetDir, fname));
  }

  return { copiedFiles: exportedFiles };
}

// ═══════════════════════════════════════════════════════════════════════════
// Export runners — used by the bridge server (streamed output) and could
// equally replace the inline spawnExport() call sites in the CLI scripts.
// ═══════════════════════════════════════════════════════════════════════════

/** Export all 4 icon font sets in sequence, streaming combined output via onData. */
async function runIconExport(paths, onData = () => {}) {
  for (const style of paths.STYLE_ORDER) {
    onData(`\n=== ${paths.FONT_EXPORT_CONFIGS[style].iconfont.fontname} ===\n`);
    await spawnExportCaptured(
      paths.NUCLEO_EXPORT_SCRIPT,
      paths.NC_PROJECTS[style].dir,
      paths.EXPORT_DIRS[style],
      paths.FONT_EXPORT_CONFIGS[style],
      onData,
    );
  }
}

/** Export the duotone sprite, then apply the color → CSS-variable replacements. */
async function runDuotoneExport(paths, onData = () => {}) {
  await spawnExportCaptured(
    paths.NUCLEO_SPRITE_SCRIPT, paths.NC_PROJECT_DIR, paths.OUTPUT_DIR, paths.SPRITE_CONFIG, onData,
  );
  onData('\nApplying color replacements...\n');
  replaceColorsDuotone(paths.SPRITE_INPUT_SVG, paths.EXPORT_SVG);
  onData(`Color-replaced sprite written to: ${paths.EXPORT_SVG}\n`);
}

/** Export the illustration sprite. */
async function runIllustrationExport(paths, onData = () => {}) {
  await spawnExportCaptured(
    paths.NUCLEO_SPRITE_SCRIPT, paths.NC_PROJECT_DIR, paths.OUTPUT_DIR, paths.SPRITE_CONFIG, onData,
  );
}

module.exports = {
  resolveIconPaths, searchIconPipeline, findIconExact, registerIconPipeline, deployIconPipeline, runIconExport,
  applyFontVersions,
  resolveDuotonePaths, searchDuotonePipeline, registerDuotonePipeline, deployDuotonePipeline, runDuotoneExport,
  resolveIllustrationPaths, searchIllustrationPipeline, registerIllustrationPipeline, deployIllustrationPipeline, runIllustrationExport,
};
