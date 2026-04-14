'use strict';

const fs   = require('fs');
const path = require('path');
const fse  = require('fs-extra');

/**
 * Port of ReplaceColorsInDuotone.bat.
 *
 * Reads the generated sprite from `inputPath`, applies the 8 Streamline
 * duotone color → CSS-variable replacements in the exact order used by the
 * original bat script, then writes the result to `outputPath`.
 *
 * @param {string} inputPath  - Absolute path to img/streamline-icon-duotone.svg
 * @param {string} outputPath - Absolute path to output/streamline-icon-duotone.svg
 */
function replaceColorsDuotone(inputPath, outputPath) {
  let svg = fs.readFileSync(inputPath, 'utf8');

  // Replacements in the EXACT order from the bat script.
  // Order matters: #ffffff must be replaced before #fff (shorter form).
  svg = svg.replaceAll('#f0f2ff', 'var(--icon-color-1, #f4f4f4)');
  svg = svg.replaceAll('#ffffff', 'var(--icon-color-2, #ffffff) ');  // intentional trailing space
  svg = svg.replaceAll('#fff ',   'var(--icon-color-2, #ffffff) ');  // #fff + space → same token
  svg = svg.replaceAll('#d6daff', 'currentColor');
  svg = svg.replaceAll('#4550e5', 'var(--color-icon-4, #000000)');
  svg = svg.replaceAll('#d9edff', 'var(--icon-color-1, #f4f4f4)');
  svg = svg.replaceAll('#b0d9ff', 'currentColor');
  svg = svg.replaceAll('#020064', 'var(--color-icon-4, #000000)');

  fse.ensureDirSync(path.dirname(outputPath));
  fs.writeFileSync(outputPath, svg, 'utf8');
}

module.exports = { replaceColorsDuotone };
