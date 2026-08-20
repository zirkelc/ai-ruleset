import { defineConfig } from 'tsdown';

export default defineConfig({
  /**
   * Run arethetypeswrong after bundling.
   * Requires @arethetypeswrong/core to be installed.
   */
  attw: {
    profile: 'esm-only',
  },
  /**
   * Run publint after bundling.
   * Requires publint to be installed.
   */
  publint: true,
  exports: true,
  /**
   * The spec package is types-only and a dev dependency, so it has to be inlined
   * into the declaration output. Listing it fails the build if anything else ever
   * gets bundled from node_modules.
   */
  deps: {
    onlyBundle: ['@standard-schema/spec'],
  },
  entry: 'src/**/index.ts',
  format: ['esm'],
});
