import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';

export default defineConfig({
  plugins: [
    preact(),
    {
      name: 'post-build-fixup',
      writeBundle() {
        const dist = resolve(__dirname, 'dist');

        // Copy manifest.json to dist
        copyFileSync(resolve(__dirname, 'manifest.json'), resolve(dist, 'manifest.json'));

        // Move HTML files from dist/src/*/ to dist/*/  and fix asset paths
        // Vite generates paths relative to dist/src/page/ but we want them relative to dist/page/
        for (const page of ['sidepanel', 'popup', 'options']) {
          const srcHtml = resolve(dist, `src/${page}/index.html`);
          const destDir = resolve(dist, page);
          if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
          if (existsSync(srcHtml)) {
            let html = readFileSync(srcHtml, 'utf-8');
            // Fix ../../ relative paths → ../ (one level up from page/ to dist root)
            html = html.replace(/\.\.\/\.\.\//g, '../');
            writeFileSync(resolve(destDir, 'index.html'), html);
          }
        }

        // Clean up dist/src
        rmSync(resolve(dist, 'src'), { recursive: true, force: true });

        // Copy icons
        const iconsDir = resolve(dist, 'icons');
        if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });
        for (const size of ['16', '48', '128']) {
          const src = resolve(__dirname, `public/icons/lumen-${size}.png`);
          if (existsSync(src)) {
            copyFileSync(src, resolve(iconsDir, `lumen-${size}.png`));
          }
        }
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyDirFirst: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
        popup: resolve(__dirname, 'src/popup/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
      },
      output: {
        entryFileNames: '[name]/index.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name]/[name][extname]',
      },
    },
    target: 'es2022',
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
