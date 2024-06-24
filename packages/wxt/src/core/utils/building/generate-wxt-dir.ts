import { Unimport, createUnimport } from 'unimport';
import {
  EslintGlobalsPropValue,
  Entrypoint,
  WxtResolvedUnimportOptions,
  WxtDirEntry,
  WxtDirFileEntry,
} from '~/types';
import fs from 'fs-extra';
import { dirname, relative, resolve } from 'node:path';
import {
  getEntrypointBundlePath,
  isHtmlEntrypoint,
} from '~/core/utils/entrypoints';
import { getEntrypointGlobals, getGlobals } from '~/core/utils/globals';
import { normalizePath } from '~/core/utils/paths';
import path from 'node:path';
import { Message, parseI18nMessages } from '~/core/utils/i18n';
import { writeFileIfDifferent, getPublicFiles } from '~/core/utils/fs';
import { wxt } from '../../wxt';

/**
 * Generate and write all the files inside the `InternalConfig.typesDir` directory.
 */
export async function generateTypesDir(
  entrypoints: Entrypoint[],
): Promise<void> {
  await fs.ensureDir(wxt.config.typesDir);

  const entries: WxtDirEntry[] = [
    // Hard-coded entries
    { module: 'wxt/vite-builder-env' },
  ];

  // Add references to modules installed from NPM to the TS project so their
  // type augmentation can update InlineConfig correctly. Local modules defined
  // in <root>/modules are already apart of the project, so we don't need to
  // add them.
  wxt.config.modules.forEach((module) => {
    if (module.type === 'node_module' && module.configKey != null)
      entries.push({ module: module.id });
  });

  // Auto-imports
  if (wxt.config.imports !== false) {
    const unimport = createUnimport(wxt.config.imports);
    entries.push(await getImportsDeclarationEntry(unimport));
    if (wxt.config.imports.eslintrc.enabled) {
      entries.push(await getImportsEslintEntry(unimport, wxt.config.imports));
    }
  }

  // browser.runtime.getURL
  entries.push(await getPathsDeclarationEntry(entrypoints));

  // browser.i18n.getMessage
  if (await fs.exists(resolve(wxt.config.publicDir, '_locales'))) {
    entries.push(await getI18nDeclarationEntry());
  }

  // import.meta.env.*
  entries.push(await getGlobalsDeclarationEntry());

  // tsconfig.json
  entries.push(await getTsConfigEntry());

  // Let modules add more entries
  await wxt.hooks.callHook('prepare:types', wxt, entries);

  // Add main declaration file, not editable
  entries.push(getMainDeclarationEntry(entries));

  // Write all the files
  const absoluteFileEntries = (
    entries.filter((entry) => 'path' in entry) as WxtDirFileEntry[]
  ).map<WxtDirFileEntry>((entry) => ({
    ...entry,
    path: resolve(wxt.config.wxtDir, entry.path),
  }));

  await Promise.all(
    absoluteFileEntries.map(async (file) => {
      await fs.ensureDir(dirname(file.path));
      await writeFileIfDifferent(file.path, file.text);
    }),
  );
}

async function getImportsDeclarationEntry(
  unimport: Unimport,
): Promise<WxtDirFileEntry> {
  // Load project imports into unimport memory so they are output via generateTypeDeclarations
  await unimport.scanImportsFromDir(undefined, { cwd: wxt.config.srcDir });

  return {
    path: 'types/imports.d.ts',
    text: [
      '// Generated by wxt',
      await unimport.generateTypeDeclarations(),
      '',
    ].join('\n'),
    tsReference: true,
  };
}

async function getImportsEslintEntry(
  unimport: Unimport,
  options: WxtResolvedUnimportOptions,
): Promise<WxtDirFileEntry> {
  const globals: Record<string, EslintGlobalsPropValue> = {};
  const eslintrc = { globals };

  (await unimport.getImports())
    .map((i) => i.as ?? i.name)
    .filter(Boolean)
    .sort()
    .forEach((name) => {
      eslintrc.globals[name] = options.eslintrc.globalsPropValue;
    });

  return {
    path: options.eslintrc.filePath,
    text: JSON.stringify(eslintrc, null, 2) + '\n',
  };
}

async function getPathsDeclarationEntry(
  entrypoints: Entrypoint[],
): Promise<WxtDirFileEntry> {
  const unions = entrypoints
    .map((entry) =>
      getEntrypointBundlePath(
        entry,
        wxt.config.outDir,
        isHtmlEntrypoint(entry) ? '.html' : '.js',
      ),
    )
    .concat(await getPublicFiles())
    .map(normalizePath)
    .map((path) => `    | "/${path}"`)
    .sort()
    .join('\n');

  const template = `// Generated by wxt
import "wxt/browser";

declare module "wxt/browser" {
  export type PublicPath =
{{ union }}
  type HtmlPublicPath = Extract<PublicPath, \`\${string}.html\`>
  export interface WxtRuntime extends Runtime.Static {
    getURL(path: PublicPath): string;
    getURL(path: \`\${HtmlPublicPath}\${string}\`): string;
  }
}
`;

  return {
    path: 'types/paths.d.ts',
    text: template.replace('{{ union }}', unions || '    | never'),
    tsReference: true,
  };
}

async function getI18nDeclarationEntry(): Promise<WxtDirFileEntry> {
  const defaultLocale = wxt.config.manifest.default_locale;
  const template = `// Generated by wxt
import "wxt/browser";

declare module "wxt/browser" {
  /**
   * See https://developer.chrome.com/docs/extensions/reference/i18n/#method-getMessage
   */
  interface GetMessageOptions {
    /**
     * See https://developer.chrome.com/docs/extensions/reference/i18n/#method-getMessage
     */
    escapeLt?: boolean
  }

  export interface WxtI18n extends I18n.Static {
{{ overrides }}
  }
}
`;

  let messages: Message[];
  if (defaultLocale) {
    const defaultLocalePath = path.resolve(
      wxt.config.publicDir,
      '_locales',
      defaultLocale,
      'messages.json',
    );
    const content = JSON.parse(await fs.readFile(defaultLocalePath, 'utf-8'));
    messages = parseI18nMessages(content);
  } else {
    messages = parseI18nMessages({});
  }

  const overrides = messages.map((message) => {
    return `    /**
     * ${message.description || 'No message description.'}
     *
     * "${message.message}"
     */
    getMessage(
      messageName: "${message.name}",
      substitutions?: string | string[],
      options?: GetMessageOptions,
    ): string;`;
  });

  return {
    path: 'types/i18n.d.ts',
    text: template.replace('{{ overrides }}', overrides.join('\n')),
    tsReference: true,
  };
}

async function getGlobalsDeclarationEntry(): Promise<WxtDirFileEntry> {
  const globals = [...getGlobals(wxt.config), ...getEntrypointGlobals('')];
  return {
    path: 'types/globals.d.ts',
    text: [
      '// Generated by wxt',
      'export {}',
      'interface ImportMetaEnv {',
      ...globals.map((global) => `  readonly ${global.name}: ${global.type};`),
      '}',
      'interface ImportMeta {',
      '  readonly env: ImportMetaEnv',
      '}',
      '',
    ].join('\n'),
    tsReference: true,
  };
}

function getMainDeclarationEntry(references: WxtDirEntry[]): WxtDirFileEntry {
  const text = [
    '// Generated by wxt',
    ...references.map((ref) => {
      if ('module' in ref) return `/// <reference types="${ref.module}" />`;
      if (!ref.tsReference) return;

      const absolutePath = resolve(wxt.config.wxtDir, ref.path);
      const relativePath = relative(wxt.config.wxtDir, absolutePath);
      return `/// <reference types="./${normalizePath(relativePath)}" />`;
    }),
  ].join('\n');
  return {
    path: 'wxt.d.ts',
    text,
  };
}

async function getTsConfigEntry(): Promise<WxtDirFileEntry> {
  const dir = wxt.config.wxtDir;
  const getTsconfigPath = (path: string) => normalizePath(relative(dir, path));
  const paths = Object.entries(wxt.config.alias)
    .flatMap(([alias, absolutePath]) => {
      const aliasPath = getTsconfigPath(absolutePath);
      return [
        `      "${alias}": ["${aliasPath}"]`,
        `      "${alias}/*": ["${aliasPath}/*"]`,
      ];
    })
    .join(',\n');

  const text = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "strict": true,
    "skipLibCheck": true,
    "paths": {
${paths}
    }
  },
  "include": [
    "${getTsconfigPath(wxt.config.root)}/**/*",
    "./wxt.d.ts"
  ],
  "exclude": ["${getTsconfigPath(wxt.config.outBaseDir)}"]
}`;

  return {
    path: 'tsconfig.json',
    text,
  };
}
