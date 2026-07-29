'use strict';

const {
  resolveIconPaths, searchIconPipeline, findIconExact, registerIconPipeline, deployIconPipeline, runIconExport,
  resolveDuotonePaths, searchDuotonePipeline, registerDuotonePipeline, deployDuotonePipeline, runDuotoneExport,
  resolveIllustrationPaths, searchIllustrationPipeline, registerIllustrationPipeline, deployIllustrationPipeline, runIllustrationExport,
} = require('../../scripts/lib/pipelines');
const { readProjectNucleo } = require('../../scripts/lib/common');

/**
 * Each pipeline exposes a uniform interface over the icon/duotone/illustration
 * differences in scripts/lib/pipelines.js, so routes/*.js don't need pipeline
 * conditionals of their own.
 */
const PIPELINES = {
  icon: {
    resolvePaths: resolveIconPaths,
    search(paths, term) {
      return searchIconPipeline(paths, term).map(r => ({
        name: r.name,
        matchedStyles: ['Light', 'Regular', 'Bold'],
        _icon: r,
      }));
    },
    register(paths, name, log) {
      const icon = findIconExact(paths, name);
      if (!icon) return { registered: false, reason: `"${name}" not found in all 3 source dirs (Light, Regular, Bold).` };
      const count = registerIconPipeline(paths, icon.name, icon.files, log);
      if (count === 0) return { registered: false, reason: `'${icon.name}' already present in all 4 projects.` };
      return { registered: true };
    },
    deploy: deployIconPipeline,
    runExport: runIconExport,
    preview(paths, name) {
      const icon = findIconExact(paths, name);
      return icon ? icon.files['Regular'].fullPath : null;
    },
  },

  duotone: {
    resolvePaths: resolveDuotonePaths,
    search(paths, term) {
      return searchDuotonePipeline(paths, term).map(f => ({ name: f.basename, _file: f }));
    },
    register(paths, name, log) {
      const results = searchDuotonePipeline(paths, name);
      const match = results.find(f => f.basename.toLowerCase() === name.trim().toLowerCase())
        || (results.length === 1 ? results[0] : null);
      if (!match) return { registered: false, reason: `"${name}" not found in duotone source.` };
      const { existingNames } = readProjectNucleo(paths.NUCLEO_PATH);
      const added = registerDuotonePipeline(paths, match, existingNames, log);
      if (!added) return { registered: false, reason: `'${match.basename}' already exists.` };
      return { registered: true };
    },
    deploy: deployDuotonePipeline,
    runExport: runDuotoneExport,
    preview(paths, name) {
      const results = searchDuotonePipeline(paths, name);
      const match = results.find(f => f.basename.toLowerCase() === name.trim().toLowerCase())
        || (results.length === 1 ? results[0] : null);
      return match ? match.fullPath : null;
    },
  },

  illustration: {
    resolvePaths: resolveIllustrationPaths,
    search(paths, term) {
      return searchIllustrationPipeline(paths, term).map(({ file, sourceLabel }) => ({
        name: file.basename, sourceLabel, _file: file,
      }));
    },
    register(paths, name, log) {
      const results = searchIllustrationPipeline(paths, name);
      const match = results.find(r => r.file.basename.toLowerCase() === name.trim().toLowerCase())
        || (results.length === 1 ? results[0] : null);
      if (!match) return { registered: false, reason: `"${name}" not found in source dirs.` };
      const { existingNames } = readProjectNucleo(paths.NUCLEO_PATH);
      const added = registerIllustrationPipeline(paths, match.file, existingNames, log);
      if (!added) return { registered: false, reason: `'${match.file.basename}' already exists.` };
      return { registered: true };
    },
    deploy: deployIllustrationPipeline,
    runExport: runIllustrationExport,
    preview(paths, name, sourceLabel) {
      const results = searchIllustrationPipeline(paths, name);
      const lowerName = name.trim().toLowerCase();
      const match = results.find(r => r.file.basename.toLowerCase() === lowerName && (!sourceLabel || r.sourceLabel === sourceLabel))
        || results.find(r => r.file.basename.toLowerCase() === lowerName)
        || (results.length === 1 ? results[0] : null);
      return match ? match.file.fullPath : null;
    },
  },
};

function getPipeline(name) {
  const pipeline = PIPELINES[name];
  if (!pipeline) {
    throw new Error(`Unknown pipeline "${name}". Valid: ${Object.keys(PIPELINES).join(', ')}`);
  }
  return pipeline;
}

module.exports = { getPipeline, PIPELINE_NAMES: Object.keys(PIPELINES) };
