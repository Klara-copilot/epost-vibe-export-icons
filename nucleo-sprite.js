#!/usr/bin/env node
/**
 * nucleo-sprite.js
 *
 * Reproduces NucleoApp's SVG <symbol> sprite export pipeline, used for
 * illustration-style sets (no font generation — output is an SVG sprite file
 * consumed via <use href="img/streamline-icons.svg#icon-id">).
 *
 * Reads:
 *   - nc-projects/{uuid}/project.nucleo   — icon list
 *   - nc-projects/{uuid}/{icon_uuid}.svg  — source SVGs
 *
 * Writes (structure matches NucleoApp SVG sprite export exactly):
 *   - {outputDir}/{assetsPath}/{fileName}  — SVG sprite (<symbol> set)
 *   - {outputDir}/style.css               — base CSS with custom properties
 *   - {outputDir}/demo.html               — interactive demo
 *   - {outputDir}/demo/css/style.css      — demo page CSS
 *
 * Usage:
 *   node nucleo-sprite.js [project_dir] [output_dir]
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const fse  = require('fs-extra');
const { optimize: svgoOptimize } = require('svgo');

// ─── Config ───────────────────────────────────────────────────────────────────

const PROJECT_DIR = process.argv[2] || process.env.PROJECT_DIR
  || path.join(__dirname, '../theme_icons/nc-projects/56bdad0faf1a268721a5f4');

const OUTPUT_DIR = process.argv[3] || process.env.OUTPUT_DIR
  || path.join(__dirname, 'dist/illustrations');

// ─── SVGO Preprocessing ───────────────────────────────────────────────────────
// Same plugin list as nucleo-export.js (reverse-engineered from NucleoApp).

const NUCLEO_SVGO_PLUGINS = [
  'cleanupAttrs',
  'removeDoctype',
  'removeXMLProcInst',
  'removeComments',
  'removeMetadata',
  'removeTitle',
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
// For sprite IDs, only replace spaces with hyphens.  Do NOT collapse double
// hyphens — NucleoApp's illustration-naming convention uses "--" as a separator
// between the icon's main name and its tag list (e.g. "Wallet-Money--Payment").
// The icon-font normalizeName collapses "--" for valid CSS class names, but SVG
// IDs have no such restriction.

function normalizeSpriteName(name) {
  return name.replace(/\s+/g, '-');
}

// ─── SVG inner-content extraction ─────────────────────────────────────────────

/**
 * Return the viewBox attribute value from an SVG string, or "0 0 100 100".
 */
function extractViewBox(svgString) {
  const m = svgString.match(/<svg\b[^>]*\bviewBox="([^"]*)"/i);
  return m ? m[1] : '0 0 100 100';
}

/**
 * Return the inner content of an <svg> element (everything between the
 * opening <svg…> tag and </svg>).  Self-closing tags are expanded to
 * open+close pairs so the content embeds cleanly inside <symbol>.
 */
function extractInnerContent(svgString) {
  // Expand self-closing tags (e.g. <path …/>  →  <path …></path>)
  let s = svgString.replace(
    /<([a-zA-Z][a-zA-Z0-9:]*)((?:\s[^>]*)?)\s*\/>/g,
    '<$1$2></$1>',
  );
  const m = s.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/i);
  return m ? m[1].trim() : '';
}

// ─── Sprite file builder ──────────────────────────────────────────────────────

/**
 * Wrap an array of <symbol> strings in a hidden SVG container, matching
 * NucleoApp's sprite file format exactly.
 */
function buildSprite(symbols) {
  // NucleoApp emits the sprite as a single compact line (no newlines between elements).
  return '<svg xmlns="http://www.w3.org/2000/svg" style="height: 0; width: 0; position: absolute;">' +
    symbols.join('') +
    '</svg>';
}

// ─── style.css ────────────────────────────────────────────────────────────────

function generateStyleCss(baseClass) {
  return `/* Generated using nucleoapp.com */

/* --------------------------------

General

-------------------------------- */

:root {
  --icon-color-primary: inherit;
  --icon-color-secondary: currentColor;
}

.${baseClass} {
  display: inline-block;
  color: var(--icon-color-primary); /* icon primary color */
  height: 1em;
  width: 1em;
  line-height: 1;
  flex-shrink: 0;
  max-width: initial;
}

.${baseClass} use {
  /* icon secondary color */
  fill: var(--icon-color-secondary);
  stroke: var(--icon-color-secondary);
}

/* --------------------------------

Themes

-------------------------------- */

.${baseClass}-theme-1 {
  --icon-color-primary: #522462;
  --icon-color-secondary: inherit;
}

/* --------------------------------

Sizes

-------------------------------- */
:root {
  --icon-sm: 0.8em;
  --icon-lg: 1.2em;
}

/* relative units */
.${baseClass}-sm {
  font-size: var(--icon-sm);
}

.${baseClass}-lg {
  font-size: var(--icon-lg);
}

/* absolute units */
.${baseClass}-16 {
  font-size: 16px;
}

.${baseClass}-32 {
  font-size: 32px;
}

/* --------------------------------

Caps/Corners

-------------------------------- */

.${baseClass} use {
  --icon-stroke-linecap-butt: butt;
  stroke-miterlimit: 10;
  stroke-linecap: square;
  stroke-linejoin: miter;
}

.stroke-round use {
  --icon-stroke-linecap-butt: round;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* --------------------------------

Transformations/Animations

-------------------------------- */

.${baseClass}-rotate-90 {
  transform: rotate(90deg);
}

.${baseClass}-rotate-180 {
  transform: rotate(180deg);
}

.${baseClass}-rotate-270 {
  transform: rotate(270deg);
}

.${baseClass}-flip-y {
  transform: scaleY(-1);
}

.${baseClass}-flip-x {
  transform: scaleX(-1);
}

.${baseClass}-is-spinning {
  animation: icon-spin 1s infinite linear;
}

@keyframes icon-spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
`;
}

// ─── demo/css/style.css ───────────────────────────────────────────────────────

function generateDemoCss() {
  return `/* --------------------------------

Reset

-------------------------------- */

*, *::after, *::before {
  box-sizing: inherit;
}

* {
  font: inherit;
}

html, body, div, span, applet, object, iframe,
h1, h2, h3, h4, h5, h6, p, blockquote, pre,
a, abbr, acronym, address, big, cite, code,
del, dfn, em, img, ins, kbd, q, s, samp,
small, strike, strong, sub, sup, tt, var,
b, u, i, center,
dl, dt, dd, ol, ul, li,
fieldset, form, label, legend,
table, caption, tbody, tfoot, thead, tr, th, td,
article, aside, canvas, details, embed,
figure, figcaption, footer, header, hgroup,
menu, nav, output, ruby, section, summary,
time, mark, audio, video, hr {
  margin: 0;
  padding: 0;
  border: 0;
}

html {
  box-sizing: border-box;
}

body {
  background-color: white;
  font-family: system-ui, sans-serif;
  color: hsl(240, 4%, 20%);
  padding: 1em;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

article, aside, details, figcaption, figure,
footer, header, hgroup, menu, nav, section, main, form legend {
  display: block;
}

ol, ul {
  list-style: none;
}

button, input, textarea, select {
  margin: 0;
}

a {
  color: hsl(230, 93%, 66%);
}

/* --------------------------------

Demo

-------------------------------- */
header {
  text-align: center;
  margin: 3em auto;
}

header h1 {
  font-size: 2.6rem;
  font-weight: 600;
}

header p {
  font-size: 1rem;
  margin-top: 1em;
  color: hsla(0, 0%, 0%, 0.5);
}

ul {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
}

ul li {
  border-radius: .4em;
  transition: background-color .2s;
  user-select: none;
  overflow: hidden;
  text-align: center;
  padding: 2em 1em 1em;
}

ul li:hover {
  background: hsla(0, 0%, 0%, 0.05);
}

ul p {
  display: block;
  font-size: 0.75rem;
  color: hsla(0, 0%, 0%, 0.5);
  user-select: auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  max-width: 6rem;
  padding: 8px 0 4px;
}

ul p::selection {
  background: hsl(230, 93%, 66%);
  color: #fff;
}

ul p::-moz-selection {
  background: hsl(230, 93%, 66%);
  color: #fff;
}

.svg-wrapper {
  font-size: 32px;
}

.svg-wrapper svg {
  display: block;
  margin: 0 auto 10px;
}

/* --------------------------------

Icons

-------------------------------- */

:root {
  --icon-color-primary: inherit;
  --icon-color-secondary: currentColor;
}

.icon {
  display: inline-block;
  color: var(--icon-color-primary); /* icon primary color */
  height: 1em;
  width: 1em;
  line-height: 1;
  flex-shrink: 0;
  max-width: initial;
}

.icon use {
  /* icon secondary color */
  fill: var(--icon-color-secondary);
  stroke: var(--icon-color-secondary);
}

/* --------------------------------

Stroke

-------------------------------- */

.stroke-1 {
  stroke-width: 1px;
}

.stroke-2 {
  stroke-width: 2px;
}

.stroke-3 {
  stroke-width: 3px;
}

.stroke-4 {
  stroke-width: 4px;
}

/* --------------------------------

Caps/Corners

-------------------------------- */

.icon use {
  stroke-miterlimit: 10;
  stroke-linecap: round;
  stroke-linejoin: round;
}
`;
}

// ─── demo.html ────────────────────────────────────────────────────────────────

function generateDemoHtml(iconMeta, spriteContent, spriteRelPath, baseClass) {
  const esc = s =>
    s.replace(/&/g, '&amp;')
     .replace(/</g, '&lt;')
     .replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;');

  // NucleoApp click-to-select script — minified, all on one line
  const SELECT_SCRIPT =
    `<script>function SelectText(element) {var doc = document , text = element` +
    ` , range, selection; if (doc.body.createTextRange) { range = document.body` +
    `.createTextRange(); range.moveToElementText(text); range.select(); } else if` +
    ` (window.getSelection) { selection = window.getSelection(); range = document` +
    `.createRange(); range.selectNodeContents(text); selection.removeAllRanges();` +
    ` selection.addRange(range); }}window.onload = function() {var listItems =` +
    ` document.getElementsByTagName("li");for (var i = 0; i < listItems.length;` +
    ` i++) {listItems[i].onclick = function fun() {var item = this` +
    `.getElementsByTagName("p");SelectText(item[0]);}}}</script>`;

  // NucleoApp puts data-size only on the FIRST icon (as representative sample size).
  // All subsequent icons use <p  data-folder=…> with a double-space placeholder.
  const firstVbParts = ((iconMeta[0]?.viewBox) || '0 0 100 100').trim().split(/[\s,]+/);
  const firstSize = parseInt(firstVbParts[2], 10) || 100;

  const items = iconMeta.map(({ id }, idx) => {
    const externalRef = `${spriteRelPath}#${id}`;
    const snippet = `&lt;svg class="${baseClass}"&gt;&lt;use href="${esc(externalRef)}"/&gt;&lt;/svg&gt;`;
    const pTag = idx === 0
      ? `<p data-size="${firstSize}" data-folder="${spriteRelPath}">`
      : `<p  data-folder="${spriteRelPath}">`;
    return [
      `<li>`,
      `    <div class="svg-wrapper"><svg class="${baseClass}"><use href="#${id}"/></svg></div>`,
      `    ${pTag}${snippet}</p>`,
      `</li>`,
    ].join('\n');
  });

  // First <li> merges onto same line as </header><ul>; rest are on separate lines
  const firstItemBody = items.length > 0 ? items[0].replace(/^<li>\n/, '') : '';
  const restItems     = items.slice(1).join('\n');
  const listHtml      = `</header><ul><li>\n${firstItemBody}${restItems ? '\n' + restItems : ''}`;

  return `<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="demo/css/style.css">
  <link rel="icon" type="image/svg+xml" href="demo/favicon.svg">
  <title>SVG Symbol Icons | Nucleo</title>
</head>

<body>
  ${spriteContent}

  <header>
    <h1>SVG Symbol Icons</h1>
    <p>Generated using <a href="https://nucleoapp.com">nucleoapp.com</a></p>
  ${listHtml}
</ul>${SELECT_SCRIPT}</body></html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Read project ─────────────────────────────────────────────────────────────
  const projectFile = path.join(PROJECT_DIR, 'project.nucleo');
  if (!fs.existsSync(projectFile)) {
    console.error(`ERROR: project.nucleo not found at ${projectFile}`);
    process.exit(1);
  }

  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const icons   = project.icons || [];

  console.log(`Project : ${project.title}`);
  console.log(`Icons   : ${icons.length}`);

  // ── Export config ─────────────────────────────────────────────────────────────
  let exportCfg = null;
  if (process.env.EXPORT_CONFIG && fs.existsSync(process.env.EXPORT_CONFIG)) {
    exportCfg = JSON.parse(fs.readFileSync(process.env.EXPORT_CONFIG, 'utf8'));
  }

  const spriteCfg = exportCfg?.svgsprite ?? {
    baseClass:      'streamline-icons',
    idPrefix:       'streamline-icon-',
    assetsPath:     'img',
    fileName:       'streamline-icons.svg',
    metadataEnable: false,
    metadata: {
      author:      'Klara Design',
      description: 'Built on Streamline',
      version:     '0.1',
      copyright:   'Klara Design',
    },
  };

  const baseClass  = spriteCfg.baseClass  || 'streamline-icons';
  const idPrefix   = spriteCfg.idPrefix   || 'streamline-icon-';
  const assetsPath = spriteCfg.assetsPath || 'img';
  const fileName   = spriteCfg.fileName   || 'streamline-icons.svg';

  console.log(`Base CSS : .${baseClass}`);
  console.log(`Output   : ${OUTPUT_DIR}\n`);

  // ── Deduplicate by place ──────────────────────────────────────────────────────
  // When multiple icons share the same `place` value, the last one wins
  // (matching NucleoApp's gallery overwrite semantics).
  const byPlace = new Map();
  for (const icon of icons) byPlace.set(icon.place, icon);
  // Sort by place ascending — NucleoApp emits symbols in gallery slot order.
  const dedupedIcons = [...byPlace.values()].sort((a, b) => a.place - b.place);

  if (dedupedIcons.length !== icons.length) {
    console.log(`Deduped  : ${icons.length} → ${dedupedIcons.length} icons (${icons.length - dedupedIcons.length} duplicate places removed)`);
  }

  // ── Build <symbol> elements ───────────────────────────────────────────────────
  const symbols  = [];
  const iconMeta = [];
  let skipped = 0;

  for (const icon of dedupedIcons) {
    const srcPath = path.join(PROJECT_DIR, icon.uuid + '.svg');
    if (!fs.existsSync(srcPath)) {
      console.warn(`  SKIP ${icon.name} (${icon.uuid}.svg not found)`);
      skipped++;
      continue;
    }

    const rawSvg    = fs.readFileSync(srcPath, 'utf8');
    const sourceSvg = optimizeSourceSvg(rawSvg);

    const viewBox  = extractViewBox(sourceSvg);
    const inner    = extractInnerContent(sourceSvg);
    const iconName = normalizeSpriteName(icon.name);
    const symbolId = `${idPrefix}${iconName}`;

    // Build compact <symbol> — NucleoApp emits the whole sprite on one line.
    symbols.push(`<symbol id="${symbolId}" viewBox="${viewBox}">${inner}</symbol>`);
    iconMeta.push({ id: symbolId, viewBox });
  }

  const iconCount = symbols.length;
  console.log(`Prepared : ${iconCount} icons (${skipped} skipped)`);

  if (iconCount === 0) {
    console.error('No icons to process.');
    process.exit(1);
  }

  // ── Write output ──────────────────────────────────────────────────────────────
  const spriteContent = buildSprite(symbols);
  const spriteDir     = path.join(OUTPUT_DIR, assetsPath);
  const spritePath    = path.join(spriteDir, fileName);
  const spriteRelPath = `${assetsPath}/${fileName}`;

  fse.ensureDirSync(spriteDir);
  fse.ensureDirSync(path.join(OUTPUT_DIR, 'demo', 'css'));

  // Copy favicon (NucleoApp's Nucleo logo icon, used in demo.html)
  const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12.006" cy="11.699" r="2.6" fill="#5E5E5E"/><path d="M20.669,4.385,13.919.507a3.87,3.87,0,0,0-3.861.018l-8.7,5.023V6.5H17.2A3.9,3.9,0,0,0,20.669,4.385Z" fill="#5E5E5E"/><path d="M1.341,7.852s.017,7.772.017,7.786A3.866,3.866,0,0,0,3.3,18.972L12.007,24l.823-.475L4.9,9.8A3.9,3.9,0,0,0,1.341,7.852Z" fill="#5E5E5E"/><path d="M21.835,5.072,13.909,18.8a3.9,3.9,0,0,0,.1,4.057l6.734-3.908A3.864,3.864,0,0,0,22.657,15.6l0-10.051Z" fill="#5E5E5E"/></svg>';

  fs.writeFileSync(spritePath,                                          spriteContent,               'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'style.css'),                  generateStyleCss(baseClass), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'demo', 'css', 'style.css'),   generateDemoCss(),           'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'demo', 'favicon.svg'),        FAVICON_SVG,                 'utf8');
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'demo.html'),
    generateDemoHtml(iconMeta, spriteContent, spriteRelPath, baseClass),
    'utf8',
  );

  console.log('\n✓ Done');
  console.log(`  ${spriteRelPath}  → ${iconCount} symbols`);
  console.log(`  style.css`);
  console.log(`  demo.html`);
  console.log(`  demo/css/style.css`);
  console.log(`\n  Output: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
