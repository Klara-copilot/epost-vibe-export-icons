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

  // Vertical offset for non-square icons: when the source viewBox height is
  // significantly less than the grid (blank space > 20% of grid), NucleoApp
  // bottom-aligns the icon within the 256×256 canvas — placing blank space at
  // the TOP.  This aligns the icon to the font baseline (standard convention).
  //
  // Example: custom-right-round-arrow has viewBox="0 0 23 16" in a grid=24 →
  // blank space = (24-16)/24 = 33% → offsetY=8 → shift=85px down → icon at
  // y≈85..256 in canvas → screenTop≈333em, matching reference screenTop=327.
  //
  // Threshold 20%: only apply when blank space > 20% of grid.  Below that the
  // offset introduces more error than it corrects.  Example: Arrange-List-
  // Descending-1 has viewBox="0 0 24 25" grid=30 → blank=(30-25)/30=17% <20%
  // → no offset applied → top≈6.7% matches reference 3.7% much better than
  // the 23.3% the offset would produce.
  //
  // Square icons (viewBox height == grid) always have rawOffsetY=0 → no change.
  const svgTagMatch = svg.match(/<svg\b[^>]*>/i);
  const vbMatch = svgTagMatch?.[0].match(/viewBox="([^"]*)"/i);
  const vbParts = vbMatch?.[1].trim().split(/[\s,]+/).map(Number);
  const vbHeight = vbParts?.length === 4 ? vbParts[3] : null;
  const rawOffsetY = (vbHeight != null && vbHeight < grid) ? (grid - vbHeight) : 0;
  // Apply offset only when blank space exceeds 20% of grid (significant gap).
  const offsetY = (rawOffsetY / grid > 0.20) ? rawOffsetY : 0;

  const transform = offsetY > 0
    ? `scale(${scale}) translate(0, ${offsetY})`
    : `scale(${scale})`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">`,
    `<g class="nc-icon-wrapper" fill="${primaryColor}" transform="${transform}">`,
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

// Maximum path length (in source units) to qualify as a "dot" stroke.
const DOT_LEN_MAX = 0.5;

/**
 * Vector-converts near-zero-length strokes with stroke-linecap="square" into
 * filled rectangle paths.
 *
 * Some icons (e.g. sparkle dot grids) use extremely short paths (≤0.01 units)
 * as square dots via stroke-linecap="square".  Adjacent dots are spaced by
 * exactly stroke-width, leaving a zero geometric gap — rasterization always
 * merges them into blobs regardless of resolution.
 *
 * Adaptive stroke-width cap: when adjacent dots touch (minDist ≤ stroke-width),
 * the effective stroke-width is set to minDist/2, creating a gap equal to half
 * the grid spacing and matching the NucleoApp reference output.
 *
 * After conversion all stroke attributes are stripped so hasSignificantStrokes()
 * returns false, skipping the rasterize+trace pipeline for these icons.
 *
 * @param {string} svgString  — SVGO-optimised source SVG
 * @returns {string}          — SVG with dot-strokes replaced by filled rect paths,
 *                             or the original string unchanged if no dots found.
 */
function convertDotStrokesToFill(svgString) {
  const NUM_RE = '[-+]?(?:\\d*\\.)?\\d+(?:[eE][-+]?\\d+)?';

  // Parse a near-zero-length path d= value (M … L/H/V …) into {x1,y1,x2,y2}.
  function parseDotPath(dVal) {
    const d = dVal.trim();
    const lRe = new RegExp(`^M\\s*(${NUM_RE})\\s+(${NUM_RE})\\s*L\\s*(${NUM_RE})\\s+(${NUM_RE})\\s*$`, 'i');
    const hRe = new RegExp(`^M\\s*(${NUM_RE})\\s+(${NUM_RE})\\s*H\\s*(${NUM_RE})\\s*$`, 'i');
    const vRe = new RegExp(`^M\\s*(${NUM_RE})\\s+(${NUM_RE})\\s*V\\s*(${NUM_RE})\\s*$`, 'i');
    let m;
    if ((m = lRe.exec(d))) return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
    if ((m = hRe.exec(d))) return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[2] };
    if ((m = vRe.exec(d))) return { x1: +m[1], y1: +m[2], x2: +m[1], y2: +m[3] };
    return null;
  }

  // Normalise: convert <path ...></path> to <path .../> for uniform processing.
  // SVG <path> elements never have meaningful children, so this is always safe.
  let s = svgString.replace(/<path\b([^>]*)>\s*<\/path>/g, '<path$1/>');

  // ── Pass 1: collect visible dot centers ──────────────────────────────────────
  const dots = [];
  for (const m of s.matchAll(/<path\b((?:[^>]|\/(?!>))*)(\/?>)/g)) {
    const attrs = m[1];
    if (!attrs.includes('stroke-linecap="square"')) continue;
    const sop = parseFloat(attrs.match(/stroke-opacity="([^"]*)"/)?.[1] ?? '1');
    if (sop < 0.5) continue;
    const sw  = parseFloat(attrs.match(/stroke-width="([^"]*)"/)?.[1] ?? '1');
    const dVal = attrs.match(/\bd="([^"]*)"/)?.[1];
    if (!dVal) continue;
    const p = parseDotPath(dVal);
    if (!p || Math.hypot(p.x2 - p.x1, p.y2 - p.y1) > DOT_LEN_MAX) continue;
    dots.push({ cx: (p.x1 + p.x2) / 2, cy: (p.y1 + p.y2) / 2, sw });
  }

  if (dots.length === 0) return svgString; // no dots — nothing to convert

  // ── Guard: bail out if any non-dot stroke paths exist ────────────────────────
  // This function is designed for icons whose ENTIRE geometry is dot-strokes
  // (e.g. sparkle grids).  If the icon also has real stroke paths (closed
  // shapes, long lines, etc.) the final stroke-strip below would make those
  // invisible since they have fill="none".  In that case leave the icon
  // untouched so it falls through to the normal traceStrokedSvg pipeline.
  for (const m of s.matchAll(/<path\b((?:[^>]|\/(?!>))*)(\/?>)/g)) {
    const attrs = m[1];
    // Check for a visible stroke
    const strokeVal = attrs.match(/\bstroke="([^"]*)"/)?.[1];
    if (!strokeVal || strokeVal === 'none') continue;
    const sop = parseFloat(attrs.match(/stroke-opacity="([^"]*)"/)?.[1] ?? '1');
    if (sop < 0.5) continue;
    // Is this a dot? (square-linecap + near-zero length)
    if (!attrs.includes('stroke-linecap="square"')) return svgString; // non-dot stroke
    const dVal = attrs.match(/\bd="([^"]*)"/)?.[1];
    if (!dVal) return svgString;
    const p = parseDotPath(dVal);
    if (!p || Math.hypot(p.x2 - p.x1, p.y2 - p.y1) > DOT_LEN_MAX) return svgString; // non-dot stroke
  }

  // ── Minimum center-to-center distance between any two dots ───────────────────
  let minDist = Infinity;
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      const d = Math.hypot(dots[i].cx - dots[j].cx, dots[i].cy - dots[j].cy);
      if (d < minDist) minDist = d;
    }
  }

  // ── Pass 2: replace matched dot-strokes with filled rect paths ───────────────
  let anyConverted = false;
  s = s.replace(/<path\b((?:[^>]|\/(?!>))*)(\/?>)/g, (match, attrs, close) => {
    if (!attrs.includes('stroke-linecap="square"')) return match;
    const sop = parseFloat(attrs.match(/stroke-opacity="([^"]*)"/)?.[1] ?? '1');
    if (sop < 0.5) return match;
    const sw  = parseFloat(attrs.match(/stroke-width="([^"]*)"/)?.[1] ?? '1');
    const dVal = attrs.match(/\bd="([^"]*)"/)?.[1];
    if (!dVal) return match;
    const p = parseDotPath(dVal);
    if (!p || Math.hypot(p.x2 - p.x1, p.y2 - p.y1) > DOT_LEN_MAX) return match;

    // Adaptive stroke-width: when dots touch (minDist ≤ sw), cap to minDist/2
    // so adjacent squares have a visible gap equal to half the grid spacing.
    const effectiveSw = (isFinite(minDist) && minDist <= sw) ? minDist / 2 : sw;
    const hw = effectiveSw / 2;
    const cx = (p.x1 + p.x2) / 2, cy = (p.y1 + p.y2) / 2;
    const rx = Math.abs(p.x2 - p.x1) / 2 + hw;
    const ry = Math.abs(p.y2 - p.y1) / 2 + hw;
    const fp = `M${cx - rx} ${cy - ry}` +
               ` L${cx + rx} ${cy - ry}` +
               ` L${cx + rx} ${cy + ry}` +
               ` L${cx - rx} ${cy + ry} Z`;
    anyConverted = true;
    return `<path d="${fp}"/>`;
  });

  if (!anyConverted) return svgString;

  // Strip all stroke attributes from path elements so hasSignificantStrokes()
  // returns false for this now-fill-only icon, skipping rasterize+trace.
  s = s.replace(/<path\b((?:[^>]|\/(?!>))*)(\/?>)/g, (m, attrs, close) => {
    const stripped = attrs.replace(/\s+stroke(?:-[-a-z]+)?="[^"]*"/gi, '');
    return `<path${stripped}${close}`;
  });

  // Also strip inherited stroke attrs from any <g> wrappers (e.g. stroke-linecap).
  s = s.replace(/<g\b([^>]*)>/g, (m, attrs) => {
    const stripped = attrs.replace(/\s+stroke(?:-[-a-z]+)?="[^"]*"/gi, '');
    return `<g${stripped}>`;
  });

  return s;
}

/**
 * Rasterize the SOURCE SVG at 512×512, trace the bitmap with Potrace, and
 * return a new 256×256 SVG containing a single filled path.  This replicates
 * NucleoApp's improveOutline pipeline (svg-outline-stroke at 512×512 +
 * Potrace + fontGrid=512).
 *
 * Rasterizing the source avoids the size under-run caused by the intermediate:
 * buildFontSvg scales by 256/grid, so icons whose viewBox < grid (e.g. 24×25
 * in a grid-30 project) end up with content filling only vbW/grid × vbH/grid
 * of the canvas — 80%×83% for ALD1 → 800×833 em-units vs the reference
 * 960×1000 em-units.  By rendering the source SVG directly to a 512×512
 * square canvas (xMidYMid meet preserveAspectRatio), the traced content fills
 * the canvas proportional to the viewBox, and scaling 0.5× lands it at the
 * correct em-unit size.
 *
 * @param {string} sourceSvg      — SVGO-optimised source SVG
 * @param {string} fontSvgString  — fallback 256×256 intermediate (used only if tracing fails)
 * @param {string} iconName
 * @returns {Promise<string>}     — 256×256 SVG with a single filled <path>
 */
async function traceStrokedSvg(sourceSvg, fontSvgString, iconName) {
  const RENDER_SIZE = 512;
  const { Resvg } = getResvg();

  // Render at a 512×512 square canvas (matching NucleoApp's svg-outline-stroke
  // call with {width:512, height:512}).  The source viewBox content is scaled
  // preserveAspectRatio=xMidYMid meet to fit within the square, so a tall icon
  // fills the full 512px height and a wide icon fills the full 512px width.
  // Replacing width/height with 512 keeps the viewBox (and therefore the
  // content aspect ratio) intact.
  const svgForRender = sourceSvg.replace(
    /<svg\b([^>]*)>/i,
    (match, attrs) => {
      const cleaned = attrs
        .replace(/\s+width="[^"]*"/g, '')
        .replace(/\s+height="[^"]*"/g, '');
      return `<svg${cleaned} width="${RENDER_SIZE}" height="${RENDER_SIZE}">`;
    }
  );

  const resvg = new Resvg(svgForRender, {
    fitTo: { mode: 'width', value: RENDER_SIZE },
  });
  const rendered = resvg.render();
  const rgba   = rendered.pixels;
  const width  = rendered.width;
  const height = rendered.height;

  // Run Potrace (coordinates in 0..512 × 0..512 pixel space)
  potrace.clear();
  potrace.loadFromRGBA(rgba, width, height);
  potrace.setParameter({ turdsize: 1, optcurve: true, alphamax: 1, opttolerance: 0.2 });
  potrace.process();
  const tracedSvg = potrace.getSVG(1);

  const dMatch = tracedSvg.match(/<path\b[^>]*\bd="([^"]+)"/);
  if (!dMatch) return fontSvgString; // fallback: return intermediate

  const pathData = dMatch[1];

  // Scale the 512×512 traced path down to the 256×256 font canvas.
  // scale(0.5) matches fontGrid=512 in NucleoApp's buildFontSvg call.
  const scale = 256 / RENDER_SIZE; // = 0.5

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">`,
    `<g class="nc-icon-wrapper" fill="#111111" transform="scale(${scale})">`,
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
    let   sourceSvg = optimizeSourceSvg(rawSvg);   // Phase 1: SVGO (NucleoApp-exact config)

    // Vector-convert near-zero-length square-linecap strokes to filled rects.
    // Must run before hasSignificantStrokes() so converted icons skip tracing.
    sourceSvg = convertDotStrokesToFill(sourceSvg);

    const grid      = icon.grid || icon.width || 24;
    let fontSvg = buildFontSvg(sourceSvg, iconName, primaryColor, grid);
    // If the source SVG uses strokes, rasterize+trace to get clean filled outlines
    // (matches NucleoApp's Potrace pipeline for outline-klass icons).
    // Skip for 'colored' icons: NucleoApp passes those directly without tracing —
    // they carry mixed fill+stroke geometry that should reach svgicons2svgfont as-is.
    if (hasSignificantStrokes(sourceSvg)) {
      fontSvg = await traceStrokedSvg(sourceSvg, fontSvg, iconName);
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
