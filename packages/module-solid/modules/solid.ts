import 'wxt';
import { addImportPreset, addViteConfig, defineWxtModule } from 'wxt/modules';
import solid, { Options as PluginOptions } from 'vite-plugin-solid';

export default defineWxtModule<SolidModuleOptions>({
  name: '@wxt-dev/module-solid',
  configKey: 'solid',
  setup(wxt, options) {
    const { vite } = options ?? {};

    addViteConfig(wxt, () => ({
      // @ts-expect-error: Vite version mismatch
      plugins: [solid(vite)],
      build: {
        target: 'esnext',
      },
    }));

    addImportPreset(wxt, 'solid-js');

    // Enable auto-imports for JSX files
    wxt.hooks.hook('ready', (wxt) => {
      if (wxt.config.imports === false) return;

      wxt.config.imports.dirsScanOptions ??= {};
      wxt.config.imports.dirsScanOptions.filePatterns = [
        // Default plus JSX/TSX
        '*.{ts,js,mjs,cjs,mts,cts,jsx,tsx}',
      ];
    });
  },
});

export interface SolidModuleOptions {
  vite?: PluginOptions;
}

declare module 'wxt' {
  export interface InlineConfig {
    solid?: SolidModuleOptions;
  }
}
