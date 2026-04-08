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
const { optimize: svgoOptimize } = require('svgo');
const { SVGPathData, SVGPathDataTransformer } = require('svg-pathdata');

// ── Stroke-to-path tracing (resvg + Potrace) ───────────────────────────────
let _resvg = null;
function getResvg() {
  if (!_resvg) _resvg = require('@resvg/resvg-js');
  return _resvg;
}
const potrace = require('./lib/potrace');

// ─── Config ───────────────────────────────────────────────────────────────────

const PROJECT_DIR = process.argv[2] || process.env.PROJECT_DIR
  || path.join(__dirname, '../theme_icons/nc-projects/0fb05cef24426bce2d2320');

const OUTPUT_DIR = process.argv[3] || process.env.OUTPUT_DIR
  || path.join(__dirname, 'dist/glyph');

// Templates copied from the Nucleo app.asar bundle (node_modules/webfont/templates/)
const TEMPLATE_DIR = path.join(__dirname, 'templates');

// ─── SVGO Preprocessing ───────────────────────────────────────────────────────
// NucleoApp applies SVGO to every source SVG before building font intermediates.
// Plugin list reverse-engineered from NucleoApp's bundled JS (chunk-common.*.js):
//   new SVGO({ full: true, plugins: [...] })
// Translated here to SVGO v3 API (full:true → explicit plugin list).

const NUCLEO_SVGO_PLUGINS = [
  'cleanupAttrs',
  'removeDoctype',
  'removeXMLProcInst',
  'removeComments',
  'removeMetadata',
  'removeTitle',          // NucleoApp: { removeTitle: true }
  'removeDesc',
  'removeUselessDefs',
  'removeEditorsNSData',
  'removeEmptyAttrs',
  'removeHiddenElems',
  'removeEmptyText',
  'removeEmptyContainers',
  'cleanupEnableBackground',
  'convertStyleToAttrs',
  'convertColors',
  'removeNonInheritableGroupAttrs',
  'removeUnusedNS',
  'cleanupNumericValues',
  'collapseGroups',
  'removeRasterImages',
  'convertShapeToPath',
  'convertTransform',
];

function optimizeSourceSvg(svgString) {
  const result = svgoOptimize(svgString, { plugins: NUCLEO_SVGO_PLUGINS });
  return result.data;
}

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

// ─── Path H/V Normalization ───────────────────────────────────────────────────
// svg-pathdata's matrix() transform does not correctly handle H (horizontal-line)
// and V (vertical-line) commands when the matrix contains rotation/skew — it
// treats them as standalone x/y values instead of expanding them to full (x,y)
// points first.  This manifests when SVGO's convertShapeToPath converts a
// <rect transform="matrix(…)"> into a <path transform="rotate(…)"> whose `d`
// uses H/V shorthands.  svgicons2svgfont later applies the combined
// scale×rotate matrix via svg-pathdata and produces astronomically wrong coords.
//
// Fix: for any <path> element in the intermediate SVG that still carries a
// transform attribute, expand its H/V commands to full L commands before
// svgicons2svgfont processes the file.  Pure scale/translate transforms in the
// group wrapper are handled correctly without this fix.

function normalizeHVInTransformedPaths(svgContent) {
  // Match opening <path …> tags (after self-closing → open/close conversion).
  return svgContent.replace(/<path\b([^>]*)>/g, (match, attrs) => {
    // Only touch paths that carry a transform attribute.
    if (!attrs.includes('transform=')) return match;
    const dMatch = attrs.match(/\bd="([^"]*)"/);
    if (!dMatch) return match;
    try {
      const normalized = new SVGPathData(dMatch[1])
        .toAbs()
        .transform(SVGPathDataTransformer.NORMALIZE_HVZ(true, true, true))
        .encode();
      return '<path' + attrs.replace(/\bd="[^"]*"/, `d="${normalized}"`) + '>';
    } catch (_) {
      return match; // leave untouched on parse error
    }
  });
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
// After SVGO preprocessing, the source SVG structure varies:
//   • Single inner element → collapseGroups moves class="nc-icon-wrapper" to that element
//   • Multiple inner elements → group is preserved with class="nc-icon-wrapper"
// In both cases we strip the wrapper and rebuild it with the correct attributes.

function buildFontSvg(sourceSvg, iconName, primaryColor, grid) {
  const scale = 256 / grid;

  let svg = sourceSvg
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trim();

  // Convert self-closing tags to open+close (required by svgicons2svgfont)
  svg = svg.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)\s*\/>/g, '<$1$2></$1>');

  // Extract inner content (everything between <svg…> and </svg>)
  const innerMatch = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
  let inner = innerMatch ? innerMatch[1] : '';

  // Strip the nc-icon-wrapper group element, keeping its children.
  // After SVGO collapseGroups, the nc-icon-wrapper class may end up on a child
  // element rather than a <g> — handle both cases.
  //
  // Case A: <g [fill="none"] class="nc-icon-wrapper" …>…children…</g>
  // Case B: <el class="nc-icon-wrapper" …/>  (group collapsed onto single child)
  //
  // For Case A we unwrap by replacing the <g> tag pair with just its children.
  // We count nesting depth so inner </g> tags are not confused with the wrapper's.
  inner = unwrapNucleoGroup(inner);

  // Remove any residual class="nc-icon-wrapper" on individual elements (Case B above).
  inner = inner.replace(/\s*class="nc-icon-wrapper"/g, '');

  // Strip any <title> that survived (we add our own for svgicons2svgfont glyph naming).
  inner = inner.replace(/<title>[^<]*<\/title>/g, '').trim();

  // Normalize H/V commands on paths that still carry a transform attribute.
  // svg-pathdata's matrix() mishandles H/V with rotation — see comment above.
  inner = normalizeHVInTransformedPaths(inner);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">`,
    `<g class="nc-icon-wrapper" fill="${primaryColor}" transform="scale(${scale})">`,
    `<title>${iconName}</title>`,
    inner,
    `</g>`,
    `</svg>`,
  ].join('\n');
}

/**
 * If the entire inner content is a single <g class="nc-icon-wrapper"…>…</g>
 * wrapper, strip it and return just its children.  Handles any attribute order
 * and correctly accounts for nested <g> depth so the first inner </g> is not
 * mistaken for the wrapper's closing tag.
 */
function unwrapNucleoGroup(inner) {
  const trimmed = inner.trim();

  // Find the opening <g> tag that carries class="nc-icon-wrapper"
  const openRe = /<g\b[^>]*\bclass="nc-icon-wrapper"[^>]*>/;
  const openMatch = openRe.exec(trimmed);
  if (!openMatch) return inner;   // no such group – nothing to unwrap

  const openStart = openMatch.index;
  const openEnd   = openStart + openMatch[0].length;

  // Walk forward counting <g> open/close nesting to find the matching </g>
  let depth = 1;
  let i     = openEnd;
  while (i < trimmed.length && depth > 0) {
    // Look for the next tag boundary
    const nextOpen  = trimmed.indexOf('<g',  i);
    const nextClose = trimmed.indexOf('</g>', i);

    if (nextClose === -1) break;  // malformed – give up

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Another <g> opens before the next </g>
      depth++;
      i = nextOpen + 2;  // skip past '<g'
    } else {
      depth--;
      if (depth === 0) {
        // Found the matching closing </g>
        const children = trimmed.slice(openEnd, nextClose).trim();
        // Re-assemble: content before the group + children + content after </g>
        const before = trimmed.slice(0, openStart).trim();
        const after  = trimmed.slice(nextClose + 4).trim();   // 4 = len('</g>')
        return [before, children, after].filter(Boolean).join('\n');
      }
      i = nextClose + 4;
    }
  }

  // Could not find matching close – return as-is
  return inner;
}

// ─── SVG Font Post-processing ─────────────────────────────────────────────────

/**
 * webfont v11 unconditionally appends the icon name as a second unicode value
 * (ligature) per glyph, regardless of the `ligatures` option.  This produces
 * two <glyph> elements per icon (one for the PUA codepoint, one for the
 * multi-character ligature sequence).  Strip the ligature glyphs so that only
 * the single-codepoint glyphs remain, matching NucleoApp's SVG font output.
 *
 * Single codepoint:  unicode="&#xEA03;"           → keep
 * Ligature:          unicode="&#x74;&#x61;&#x67;…" → remove
 */
function stripLigatureGlyphs(svgFont) {
  // Split on every glyph opening tag; process each chunk individually.
  const parts = svgFont.split('<glyph ');
  const kept = [parts[0]];

  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const uniMatch = chunk.match(/unicode="([^"]*)"/);
    if (!uniMatch) {
      kept.push('<glyph ' + chunk);
      continue;
    }
    const unicode = uniMatch[1];
    // Count distinct &#x…; entities in the unicode attribute value.
    const entityCount = (unicode.match(/&#x[0-9a-fA-F]+;/g) || []).length;
    if (entityCount <= 1) {
      kept.push('<glyph ' + chunk);
      // single codepoint – keep
    }
    // else: ligature (2+ entities) – silently drop
  }

  return kept.join('');
}

/**
 * Insert a <metadata> block matching NucleoApp's SVG font header format,
 * immediately after the opening <svg> tag.
 */
function injectMetadata(svgFont, meta) {
  if (!meta || !meta.author) return svgFont;

  const json = JSON.stringify({
    author:      meta.author      || '',
    description: meta.description || '',
    version:     meta.version     || '',
    copyright:   meta.copyright   || '',
  }, null, '\t');

  const block = `<metadata><json><![CDATA[${json}]]></json></metadata>\n`;

  return svgFont.replace(/(<svg[^>]*>\n?)/, `$1${block}`);
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

// ─── Stroke-to-path helpers ───────────────────────────────────────────────────

/**
 * Returns true when the SVG string contains at least one stroke attribute that
 * is not explicitly "none" or width "0".  Used to decide whether to run the
 * rasterize-and-trace pipeline on an intermediate font SVG.
 *
 * @param {string} svgString
 * @returns {boolean}
 */
function hasSignificantStrokes(svgString) {
  // Must have stroke= that isn't "none"
  if (!/\bstroke="(?!none)[^"]+"/i.test(svgString)) return false;
  // Simple heuristic: presence of a real stroke value is sufficient.
  return true;
}

/**
 * Rasterize the intermediate font SVG at 256×256, trace the bitmap with
 * Potrace, and return a new SVG containing a single filled path.  This
 * replicates NucleoApp's Canvg+Potrace pipeline for outline-class icons.
 *
 * @param {string} fontSvgString  — the 256×256 intermediate SVG produced by buildFontSvg()
 * @param {string} iconName
 * @returns {Promise<string>}     — replacement SVG with a single filled <path>
 */
async function traceStrokedSvg(fontSvgString, iconName) {
  const RENDER_SIZE = 256;
  const { Resvg } = getResvg();

  // Stroke-only icons: the source SVG had fill="none" on its wrapper group, but
  // buildFontSvg sets fill="#111111" on that wrapper.  When the paths don't have
  // their own fill attribute they inherit "#111111", making them render as solid
  // filled shapes instead of stroke outlines.  Potrace then traces a filled blob
  // instead of clean outline curves, producing only 1 subpath instead of many.
  // Fix: reset the wrapper group's fill to "none" before rasterizing.
  const svgForRender = fontSvgString.replace(
    /(class="nc-icon-wrapper"[^>]*)fill="[^"]*"/,
    '$1fill="none"'
  );

  // Render the 256×256 font intermediate SVG to RGBA pixels
  const resvg = new Resvg(svgForRender, {
    fitTo: { mode: 'width', value: RENDER_SIZE },
  });
  const rendered = resvg.render();
  const rgba   = rendered.pixels; // Uint8ClampedArray, RGBA
  const width  = rendered.width;
  const height = rendered.height;

  // Run Potrace
  potrace.clear();
  potrace.loadFromRGBA(rgba, width, height);
  potrace.setParameter({ turdsize: 1, optcurve: true, alphamax: 1, opttolerance: 0.2 });
  potrace.process();
  const tracedSvg = potrace.getSVG(1); // coordinates in pixel space (0..256)

  // Extract path d attribute from Potrace output (<path d="...">)
  const dMatch = tracedSvg.match(/<path\b[^>]*\bd="([^"]+)"/);
  if (!dMatch) return fontSvgString; // fallback: return original

  const pathData = dMatch[1];

  // Build new intermediate SVG with a single filled path (no strokes)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RENDER_SIZE}" height="${RENDER_SIZE}">`,
    `<g class="nc-icon-wrapper" fill="#111111" transform="scale(1)">`,
    `<title>${iconName}</title>`,
    `<path d="${pathData}" fill="#111111" fill-rule="evenodd"/>`,
    `</g>`,
    `</svg>`,
  ].join('\n');
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

    const rawSvg    = fs.readFileSync(srcPath, 'utf8');
    const sourceSvg = optimizeSourceSvg(rawSvg);   // Phase 1: SVGO (NucleoApp-exact config)
    const grid      = icon.grid || icon.width || 24;
    let fontSvg = buildFontSvg(sourceSvg, iconName, primaryColor, grid);
    // If the source SVG uses strokes, rasterize+trace to get clean filled outlines
    // (matches NucleoApp's Potrace pipeline for outline-klass icons)
    if (hasSignificantStrokes(sourceSvg)) {
      fontSvg = await traceStrokedSvg(fontSvg, iconName);
    }
    const hexPrefix = placeToHexPrefix(icon.place);
    const cssClass  = classprefix + iconName;
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

  // ── Post-process SVG font (Phase 2) ──────────────────────────────────────────
  // webfont unconditionally emits a ligature <glyph> alongside each codepoint
  // glyph (regardless of the `ligatures` flag). Strip them to match NucleoApp.
  let svgFont = result.svg.toString('utf8');
  svgFont = stripLigatureGlyphs(svgFont);

  // Inject <metadata> block matching NucleoApp's SVG font header.
  if (iconfont.metadataEnable && iconfont.metadata) {
    svgFont = injectMetadata(svgFont, iconfont.metadata);
  }

  // ── Write font files ─────────────────────────────────────────────────────────
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'fonts'));
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'css'));
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'scss'));
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'less'));
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'demo'));

  fs.writeFileSync(path.join(OUTPUT_DIR, 'fonts', `${fontname}.svg`), svgFont, 'utf8');

  for (const fmt of ['ttf', 'eot', 'woff', 'woff2']) {
    if (result[fmt]) {
      fs.writeFileSync(
        path.join(OUTPUT_DIR, 'fonts', `${fontname}.${fmt}`),
        result[fmt]
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
    ligatures,
    fontPath:        '../fonts/',
    encode,
    base64opentype:  encodedFont.eot,
    base64woff:      encodedFont.woff,
    base64ttf:       encodedFont.ttf,
    fonts: {
      svg:   () => Buffer.from(svgFont).toString('base64'),
      ttf:   () => Buffer.from(result.ttf).toString('base64'),
      eot:   () => Buffer.from(result.eot).toString('base64'),
      woff:  () => Buffer.from(result.woff).toString('base64'),
      woff2: () => Buffer.from(result.woff2).toString('base64'),
    },
    cacheString: Date.now(),
  };

  const cssOut     = renderTemplate('css',     tplContext);
  const scssOut    = renderTemplate('scss',    tplContext);
  const lessOut    = renderTemplate('less',    tplContext);
  const htmlOut    = renderTemplate('html',    tplContext);
  const cssDemoOut = renderTemplate('cssdemo', tplContext);

  if (cssOut)     fs.writeFileSync(path.join(OUTPUT_DIR, 'css',  'icons.css'),  cssOut,  'utf8');
  if (scssOut)    fs.writeFileSync(path.join(OUTPUT_DIR, 'scss', 'icons.scss'), scssOut, 'utf8');
  if (lessOut)    fs.writeFileSync(path.join(OUTPUT_DIR, 'less', 'icons.less'), lessOut, 'utf8');
  if (htmlOut)    fs.writeFileSync(path.join(OUTPUT_DIR, 'demo.html'),          htmlOut, 'utf8');
  if (cssDemoOut) {
    fse.ensureDirSync(path.join(OUTPUT_DIR, 'demo', 'css'));
    fs.writeFileSync(path.join(OUTPUT_DIR, 'demo', 'css', 'style.css'), cssDemoOut, 'utf8');
  }

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
  console.log(`  demo/css/style.css`);
  console.log(`\n  Output: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
