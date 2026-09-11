const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// `sharp` is a build-time-only devDependency (see scripts/generate-icons.mjs) and is
// never part of the app bundle. It pulls in per-platform `@img/*` optional packages
// that npm adds and prunes as it installs, so Metro's file watcher can crash with
// ENOENT while walking into one that no longer exists. Keep both out of the file map.
const nativeImageBinaries = /[\/]node_modules[\/](@img|sharp)([\/]|$)/;

const existingBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList)
    ? existingBlockList
    : existingBlockList
      ? [existingBlockList]
      : []),
  nativeImageBinaries,
];

module.exports = config;
