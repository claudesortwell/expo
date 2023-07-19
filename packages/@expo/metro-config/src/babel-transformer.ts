/**
 * Copyright (c) 650 Industries (Expo). All rights reserved.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
// A fork of the upstream babel-transformer that uses Expo-specific babel defaults
// and adds support for web and Node.js environments.

import { parseSync, PluginItem, transformFromAstSync } from '@babel/core';
import inlineRequiresPlugin from 'babel-preset-fbjs/plugins/inline-requires';
import crypto from 'crypto';
import fs from 'fs';
import { BabelTransformer, BabelTransformerArgs } from 'metro-babel-transformer';
import makeHMRConfig from 'metro-react-native-babel-preset/src/configs/hmr';
import nullthrows from 'nullthrows';
import path from 'path';
import resolveFrom from 'resolve-from';

const cacheKeyParts = [
  fs.readFileSync(__filename),
  require('babel-preset-fbjs/package.json').version,
];

// TS detection conditions copied from metro-react-native-babel-preset
function isTypeScriptSource(fileName: string): boolean {
  return !!fileName && fileName.endsWith('.ts');
}

function isTSXSource(fileName: string): boolean {
  return !!fileName && fileName.endsWith('.tsx');
}

let babelPresetExpo: string | null | undefined = null;

function getBabelPresetExpo(projectRoot: string): string | null {
  if (babelPresetExpo !== undefined) {
    return babelPresetExpo;
  }

  babelPresetExpo = resolveFrom.silent(projectRoot, 'babel-preset-expo') ?? null;
  return babelPresetExpo;
}

/**
 * Return a memoized function that checks for the existence of a
 * project level .babelrc file, and if it doesn't exist, reads the
 * default RN babelrc file and uses that.
 */
const getBabelRC = (function () {
  let babelRC: any | null /*: ?BabelCoreOptions */ = null;

  /* $FlowFixMe[missing-local-annot] The type annotation(s) required by Flow's
   * LTI update could not be added via codemod */
  return function _getBabelRC({
    projectRoot,
    extendsBabelConfigPath,
    ...options
  }: BabelTransformerArgs['options']) {
    if (babelRC != null) {
      return babelRC;
    }

    babelRC = {
      plugins: [],
      extends: extendsBabelConfigPath,
    };

    if (extendsBabelConfigPath) {
      return babelRC;
    }

    // Let's look for a babel config file in the project root.
    let projectBabelRCPath;

    // .babelrc
    if (projectRoot) {
      projectBabelRCPath = path.resolve(projectRoot, '.babelrc');
    }

    if (projectBabelRCPath) {
      // .babelrc.js
      if (!fs.existsSync(projectBabelRCPath)) {
        projectBabelRCPath = path.resolve(projectRoot, '.babelrc.js');
      }

      // babel.config.js
      if (!fs.existsSync(projectBabelRCPath)) {
        projectBabelRCPath = path.resolve(projectRoot, 'babel.config.js');
      }

      // If we found a babel config file, extend our config off of it
      // otherwise the default config will be used
      if (fs.existsSync(projectBabelRCPath)) {
        // $FlowFixMe[incompatible-use] `extends` is missing in null or undefined.
        babelRC.extends = projectBabelRCPath;
      }
    }

    // If a babel config file doesn't exist in the project then
    // the default preset for react-native will be used instead.
    // $FlowFixMe[incompatible-use] `extends` is missing in null or undefined.
    // $FlowFixMe[incompatible-type] `extends` is missing in null or undefined.
    if (!babelRC.extends) {
      const { experimentalImportSupport, ...presetOptions } = options;

      // $FlowFixMe[incompatible-use] `presets` is missing in null or undefined.
      babelRC.presets = [
        [
          require('metro-react-native-babel-preset'),
          {
            projectRoot,
            ...presetOptions,
            disableImportExportTransform: experimentalImportSupport,
            enableBabelRuntime: options.enableBabelRuntime,
          },
        ],
      ];
    }

    return babelRC;
  };
})();

/**
 * Given a filename and options, build a Babel
 * config object with the appropriate plugins.
 */
function buildBabelConfig(
  filename: string,
  options: BabelTransformerArgs['options'],
  plugins: PluginItem[] = []
) /*: BabelCoreOptions*/ {
  const babelRC = getBabelRC(options);

  const extraConfig /*: BabelCoreOptions */ = {
    babelrc: typeof options.enableBabelRCLookup === 'boolean' ? options.enableBabelRCLookup : true,
    code: false,
    cwd: options.projectRoot,
    filename,
    highlightCode: true,
  };

  let config /*: BabelCoreOptions */ = {
    ...babelRC,
    ...extraConfig,
  };

  // Add extra plugins
  const extraPlugins = [];

  if (options.inlineRequires) {
    extraPlugins.push(inlineRequiresPlugin);
  }

  const withExtrPlugins = (config.plugins = extraPlugins.concat(config.plugins, plugins));

  if (options.dev && options.hot) {
    // Note: this intentionally doesn't include the path separator because
    // I'm not sure which one it should use on Windows, and false positives
    // are unlikely anyway. If you later decide to include the separator,
    // don't forget that the string usually *starts* with "node_modules" so
    // the first one often won't be there.
    const mayContainEditableReactComponents = !filename.includes('node_modules');

    if (mayContainEditableReactComponents) {
      const hmrConfig = makeHMRConfig();
      hmrConfig.plugins = withExtrPlugins.concat(hmrConfig.plugins);
      config = { ...config, ...hmrConfig };
    }
  }

  return {
    ...babelRC,
    ...config,
  };
}

const transform: BabelTransformer['transform'] = ({
  filename,
  options,
  src,
  plugins,
}: BabelTransformerArgs): ReturnType<BabelTransformer['transform']> => {
  const OLD_BABEL_ENV = process.env.BABEL_ENV;
  process.env.BABEL_ENV = options.dev ? 'development' : process.env.BABEL_ENV || 'production';

  // Ensure the default babel preset is Expo.
  options.extendsBabelConfigPath = getBabelPresetExpo(options.projectRoot) ?? undefined;

  try {
    const babelConfig = {
      // ES modules require sourceType='module' but OSS may not always want that
      sourceType: 'unambiguous',
      ...buildBabelConfig(filename, options, plugins),
      caller: {
        name: 'metro',
        bundler: 'metro',
        platform: options.platform,
        // Empower the babel preset to know the env it's bundling for.
        // Metro automatically updates the cache to account for the custom transform options.
        // client | node | undefined
        environment: options.customTransformOptions?.environment,
      },
      ast: true,

      // NOTE(EvanBacon): We split the parse/transform steps up to accommodate
      // Hermes parsing, but this defaults to cloning the AST which increases
      // the transformation time by a fair amount.
      // You get this behavior by default when using Babel's `transform` method directly.
      cloneInputAst: false,
    };
    const sourceAst =
      isTypeScriptSource(filename) || isTSXSource(filename) || !options.hermesParser
        ? parseSync(src, babelConfig)
        : require('hermes-parser').parse(src, {
            babel: true,
            sourceType: babelConfig.sourceType,
          });

    const result = transformFromAstSync(sourceAst, src, babelConfig);

    // The result from `transformFromAstSync` can be null (if the file is ignored)
    if (!result) {
      // BabelTransformer specifies that the `ast` can never be null but
      // the function returns here. Discovered when typing `BabelNode`.
      return { ast: null };
    }

    return { ast: nullthrows(result.ast), metadata: result.metadata };
  } finally {
    if (OLD_BABEL_ENV) {
      process.env.BABEL_ENV = OLD_BABEL_ENV;
    }
  }
};

function getCacheKey() {
  const key = crypto.createHash('md5');
  cacheKeyParts.forEach((part) => key.update(part));
  return key.digest('hex');
}

const babelTransformer: BabelTransformer = {
  transform,
  getCacheKey,
};

module.exports = babelTransformer;
