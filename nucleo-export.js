#!/usr/bin/env node
/**
 * nucleo-export.js
 *
 * Reproduces NucleoApp's icon font export pipeline without the UI.
 *
 * Reads:
 *   - nc-projects/{uuid}/project.nucleo          — icon list, palette, export config
 *   - nc-projects/{uuid}/{icon_uuid}.svg         — source SVGs (one per icon)
 *
 * Writes (structure matches NucleoApp export exactly):
 *   - {outputDir}/fonts/{fontname}.{eot,ttf,woff,woff2,svg}
 *   - {outputDir}/css/icons.css
 *   - {outputDir}/scss/icons.scss
 *   - {outputDir}/less/icons.less
 *   - {outputDir}/unicodesMap.json
 *   - {outputDir}/demo.html
 *   - {outputDir}/demo/
 *
 * Usage:
 *   node nucleo-export.js [project_dir] [output_dir]
 *
 * Example:
 *   node nucleo-export.js \
 *     ../theme_icons/nc-projects/0fb05cef24426bce2d2320 \
 *     ./dist/glyph
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const fse      = require('fs-extra');
const os       = require('os');
const nunjucks = require('nunjucks');
const webfont  = require('webfont').default;

// ─── Config ───────────────────────────────────────────────────────────────────

const PROJECT_DIR = process.argv[2] || process.env.PROJECT_DIR
  || path.join(__dirname, '../theme_icons/nc-projects/0fb05cef24426bce2d2320');

const OUTPUT_DIR = process.argv[3] || process.env.OUTPUT_DIR
  || path.join(__dirname, 'dist/glyph');

// Templates copied from the Nucleo app.asar bundle (node_modules/webfont/templates/)
const TEMPLATE_DIR = path.join(__dirname, 'templates');

// ─── Name Normalization ───────────────────────────────────────────────────────
// NucleoApp normalizes icon names: spaces → hyphens, duplicate hyphens collapsed.
// Applied to both the intermediate SVG filename and the CSS class name.

function normalizeName(name) {
  return name.replace(/\s+/g, '-').replace(/-{2,}/g, '-');
}

// ─── Unicode Formula ─────────────────────────────────────────────────────────
// Reverse-engineered from icons_big/ intermediate files.
// Formula: codepoint = 0xEA01 + icon.place
// Verified: place=2 → uea03, place=3 → uea04, place=9 → uea0a, etc.

const UNICODE_BASE = 0xEA01;

function placeToUnicode(place) {
  return UNICODE_BASE + place;
}

function placeToHexPrefix(place) {
  return 'u' + placeToUnicode(place).toString(16).toLowerCase();
}

// ─── SVG Transform for Font Pipeline ─────────────────────────────────────────
// NucleoApp converts the project SVG (viewBox="0 0 {grid} {grid}", no explicit
// width/height) into a 256×256 SVG with a scaled wrapper, for svgicons2svgfont.
//
// Source:  <svg viewBox="0 0 24 24"><g class="nc-icon-wrapper"><title>…</title>…</g></svg>
// Output:  <svg xmlns="…" width="256" height="256">
//            <g class="nc-icon-wrapper" fill="{primaryColor}" transform="scale(10.666…)">
//              <title>…</title>…
//            </g>
//          </svg>
//
// Verified by comparing icons_big/ intermediates against source SVGs.

function buildFontSvg(sourceSvg, iconName, primaryColor, grid) {
  const scale = 256 / grid;

  let svg = sourceSvg
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trim();

  // Convert self-closing tags to open+close (required by svgicons2svgfont)
  svg = svg.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)\s*\/>/g, '<$1$2></$1>');

  // Rebuild <svg> with width/height=256, drop viewBox
  svg = svg.replace(/<svg([^>]*)>/, (_, attrs) => {
    attrs = attrs
      .replace(/\s*viewBox="[^"]*"/g, '')
      .replace(/\s*width="[^"]*"/g, '')
      .replace(/\s*height="[^"]*"/g, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"${attrs}>`;
  });

  // Add fill + transform to the nc-icon-wrapper <g>
  svg = svg.replace(
    /<g class="nc-icon-wrapper"([^>]*)>/,
    `<g class="nc-icon-wrapper" fill="${primaryColor}" transform="scale(${scale})"$1>`
  );

  // Ensure <title> exists (svgicons2svgfont reads it for glyph name)
  if (!svg.includes('<title>')) {
    svg = svg.replace(
      /<g class="nc-icon-wrapper"([^>]*)>/,
      `<g class="nc-icon-wrapper"$1><title>${iconName}</title>`
    );
  }

  return svg;
}

// ─── Template Rendering ───────────────────────────────────────────────────────
// Mirrors what NucleoApp's patched webfont does when template is an array.
// Uses the .njk templates copied from the Nucleo asar bundle.

nunjucks.configure(TEMPLATE_DIR, { autoescape: false });

function renderTemplate(templateName, context) {
  const tplPath = path.join(TEMPLATE_DIR, `template.${templateName}.njk`);
  if (!fs.existsSync(tplPath)) return null;
  return nunjucks.render(`template.${templateName}.njk`, context);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Read project ────────────────────────────────────────────────────────────
  const projectFile = path.join(PROJECT_DIR, 'project.nucleo');
  if (!fs.existsSync(projectFile)) {
    console.error(`ERROR: project.nucleo not found at ${projectFile}`);
    process.exit(1);
  }

  const project      = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const palette      = project.palette || {};
  const primaryColor = palette.primaryColor || '#111111';
  const icons        = project.icons || [];

  console.log(`Project : ${project.title}`);
  console.log(`Icons   : ${icons.length}`);
  console.log(`Color   : ${primaryColor}`);

  // ── Export config (iconfont section from project.nucleo or DB export field) ─
  // If you have the SQLite DB, pass EXPORT_CONFIG=/path/to/export.json
  let exportCfg = null;
  if (process.env.EXPORT_CONFIG && fs.existsSync(process.env.EXPORT_CONFIG)) {
    exportCfg = JSON.parse(fs.readFileSync(process.env.EXPORT_CONFIG, 'utf8'));
  }

  const iconfont = exportCfg?.iconfont ?? {
    classprefix:    'st-',
    classnamebase:  'stg',
    fontname:       'steamline-icons-glyph',
    encode:         false,
    ligatures:      false,
    improveOutline: false,
    metrics:        { enable: false, ascent: '256', descent: '0' },
    metadataEnable: true,
    metadata: {
      author:      'Klara Design',
      description: 'Built on Streamline',
      version:     '0.1',
      copyright:   'Klara Design',
      license:     '',
      url:         '',
    },
  };

  const fontname      = iconfont.fontname;
  const classprefix   = iconfont.classprefix;
  const classnamebase = iconfont.classnamebase;
  const encode        = !!iconfont.encode;
  const ligatures     = !!iconfont.ligatures;
  const descent       = parseInt(iconfont.metrics?.descent ?? '0', 10);
  const ascent        = parseInt(iconfont.metrics?.ascent  ?? '256', 10);
  const fontHeight    = Math.max(1000, ascent + descent);

  // ── Temp dir for 256px intermediate SVGs ────────────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleo-export-'));

  console.log(`\nTemp    : ${tmpDir}`);
  console.log(`Output  : ${OUTPUT_DIR}\n`);

  // ── Prepare intermediate SVGs + build unicodesMap ───────────────────────────
  // Pre-scan: collect names that are already hyphenated (no normalization needed).
  // When a space-normalized name collides with a pre-existing hyphenated name,
  // NucleoApp appends the suffix to the space-normalized icon, not the other way.
  const hyphenatedNames = new Set(
    icons
      .filter(ic => !ic.name.includes(' '))
      .map(ic => normalizeName(ic.name))
  );

  const unicodesMap = {};
  const usedNames   = new Set();
  let skipped = 0;

  for (const icon of icons) {
    const srcPath = path.join(PROJECT_DIR, icon.uuid + '.svg');
    if (!fs.existsSync(srcPath)) {
      console.warn(`  SKIP ${icon.name} (${icon.uuid}.svg not found)`);
      skipped++;
      continue;
    }

    // Normalize name: spaces → hyphens.
    // If the normalized name is already taken by a hyphenated icon, add suffix.
    let iconName = normalizeName(icon.name);
    const needsDedup = icon.name.includes(' ')
      ? hyphenatedNames.has(iconName) || usedNames.has(iconName)
      : usedNames.has(iconName);

    if (needsDedup) {
      const base = iconName;
      let suffix = 2;
      while (usedNames.has(`${base}-${suffix}`)) suffix++;
      iconName = `${base}-${suffix}`;
    }
    usedNames.add(iconName);

    const sourceSvg  = fs.readFileSync(srcPath, 'utf8');
    const grid       = icon.grid || icon.width || 24;
    const fontSvg    = buildFontSvg(sourceSvg, iconName, primaryColor, grid);
    const hexPrefix  = placeToHexPrefix(icon.place);
    const cssClass   = classprefix + iconName;
    const unicodeVal = placeToUnicode(icon.place);

    fs.writeFileSync(path.join(tmpDir, `${hexPrefix}-${iconName}.svg`), fontSvg, 'utf8');
    unicodesMap[cssClass] = unicodeVal;
  }

  const iconCount = Object.keys(unicodesMap).length;
  console.log(`Prepared : ${iconCount} icons (${skipped} skipped)`);

  if (iconCount === 0) {
    console.error('No icons to process.');
    fse.removeSync(tmpDir);
    process.exit(1);
  }

  // ── Run webfont for font binary generation ───────────────────────────────────
  console.log('Building fonts…');
  const globPattern = path.join(tmpDir, '*.svg').replace(/\\/g, '/');

  const result = await webfont({
    files:       globPattern,
    formats:     ['svg', 'ttf', 'eot', 'woff', 'woff2'],
    fontName:    fontname,
    descent,
    fontHeight,
    ligatures,
  });

  // ── Write font files ─────────────────────────────────────────────────────────
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'fonts'));
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'css'));
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'scss'));
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'less'));
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'demo'));

  for (const fmt of ['svg', 'ttf', 'eot', 'woff', 'woff2']) {
    if (result[fmt]) {
      fs.writeFileSync(
        path.join(OUTPUT_DIR, 'fonts', `${fontname}.${fmt}`),
        result[fmt],
        fmt === 'svg' ? 'utf8' : undefined
      );
    }
  }

  // ── Render templates via nunjucks (mirrors Nucleo's patched webfont) ─────────
  // Build the same context object that NucleoApp's webfont passes to nunjucks.
  const encodedFont = { eot: '', woff: '', ttf: '' };
  if (encode) {
    encodedFont.eot  = result.eot.toString('base64');
    encodedFont.woff = result.woff.toString('base64');
    encodedFont.ttf  = result.ttf.toString('base64');
  }

  const glyphs = result.glyphsData.map(g => g.metadata);

  const tplContext = {
    glyphs,
    fontName:        fontname,
    // Template: .{{classBase}} { … }  →  .stg { (base class)
    //           .{{className}}-{{glyph.name}}::before  →  .st-tags-double::before
    // className must NOT have a trailing hyphen; the template adds the separator.
    className:       classprefix.replace(/-$/, ''),   // "st" → .st-tagname
    classBase:       classnamebase,                   // "stg" → .stg { base class }
    fontPath:        '../fonts/',
    encode,
    base64opentype:  encodedFont.eot,
    base64woff:      encodedFont.woff,
    base64ttf:       encodedFont.ttf,
    fonts: {
      svg:   () => Buffer.from(result.svg).toString('base64'),
      ttf:   () => Buffer.from(result.ttf).toString('base64'),
      eot:   () => Buffer.from(result.eot).toString('base64'),
      woff:  () => Buffer.from(result.woff).toString('base64'),
      woff2: () => Buffer.from(result.woff2).toString('base64'),
    },
    cacheString: Date.now(),
  };

  const cssOut  = renderTemplate('css',     tplContext);
  const scssOut = renderTemplate('scss',    tplContext);
  const lessOut = renderTemplate('less',    tplContext);
  const htmlOut = renderTemplate('cssdemo', tplContext);

  if (cssOut)  fs.writeFileSync(path.join(OUTPUT_DIR, 'css',  'icons.css'),  cssOut,  'utf8');
  if (scssOut) fs.writeFileSync(path.join(OUTPUT_DIR, 'scss', 'icons.scss'), scssOut, 'utf8');
  if (lessOut) fs.writeFileSync(path.join(OUTPUT_DIR, 'less', 'icons.less'), lessOut, 'utf8');
  if (htmlOut) fs.writeFileSync(path.join(OUTPUT_DIR, 'demo.html'),           htmlOut, 'utf8');

  // ── unicodesMap.json ─────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'unicodesMap.json'),
    JSON.stringify(unicodesMap, null, 4),
    'utf8'
  );

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  fse.removeSync(tmpDir);

  console.log('\n✓ Done');
  console.log(`  fonts/            → ${fontname}.{eot,ttf,woff,woff2,svg}`);
  console.log(`  css/icons.css`);
  console.log(`  scss/icons.scss`);
  console.log(`  less/icons.less`);
  console.log(`  unicodesMap.json`);
  console.log(`  demo.html`);
  console.log(`\n  Output: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
