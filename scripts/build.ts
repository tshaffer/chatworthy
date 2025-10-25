import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const isWatch = process.argv.includes('--watch');

async function copyStatic() {
  await mkdir('dist', { recursive: true });
  await cp('manifest.json', 'dist/manifest.json');
  await cp('src/popup.html', 'dist/popup.html');
  await cp('options.html', 'dist/options.html').catch(() => { });
  // Icons (supply your own PNGs)
  await mkdir('dist/icons', { recursive: true });
  await cp('icons/icon16.png', 'dist/icons/icon16.png').catch(() => { });
  await cp('icons/icon48.png', 'dist/icons/icon48.png').catch(() => { });
  await cp('icons/icon128.png', 'dist/icons/icon128.png').catch(() => { });
  // CSS
  await cp('src/injected.css', 'dist/injected.css');
}

async function buildAll() {
  await copyStatic();
  await build({
    entryPoints: [
      'src/content.ts',
      'src/background.ts',
      'src/popup.ts',
      'src/utils/exporters.ts'
    ],
    outdir: 'dist',
    bundle: true,
    format: 'esm',
    sourcemap: true,
    minify: false,
    target: ['chrome120'],
    loader: { '.ts': 'ts' },
    logLevel: 'info',
    watch: isWatch
      ? {
        onRebuild(error, result) {
          if (error) console.error('Rebuild failed:', error);
          else console.log('Rebuild succeeded:', result?.errors?.length ? 'with warnings' : '');
        }
      }
      : false
  });
}

buildAll();
