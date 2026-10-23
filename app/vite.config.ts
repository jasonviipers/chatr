import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const root = import.meta.dirname;

// Same class-name shape CRA produced for CSS modules: Button.module.scss + .button -> Button_button__aB3dE
function scopedName(localName: string, filename: string) {
  const file = path.basename(filename).replace(/\.module\.(css|scss|sass)$/, '');
  const hash = crypto
    .createHash('md5')
    .update(path.relative(root, filename).split(path.sep).join('/') + localName)
    .digest('base64url')
    .slice(0, 5);
  return `${file}_${localName}__${hash}`;
}

// Development is plain HTTP (localhost counts as a secure context, so camera and microphone work).
// HTTPS is opt-in: HTTPS=true (what `ionic serve --https` passes) with cert.pem / key.pem in this folder.
const keyFile = path.resolve(root, 'key.pem');
const certFile = path.resolve(root, 'cert.pem');
const https =
  process.env.HTTPS === 'true' && fs.existsSync(keyFile) && fs.existsSync(certFile)
    ? { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
    : undefined;

export default defineConfig({
  // Keep the REACT_APP_* variable names used by .env, docker-compose and the sources
  envPrefix: 'REACT_APP_',
  plugins: [
    react(),
    VitePWA({
      strategies: 'generateSW',
      filename: 'service-worker.js',
      injectRegister: false, // registered by src/serviceWorker.ts
      manifest: false, // public/manifest.json is used as is
      workbox: {
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // same limit CRA used
        globPatterns: ['**/*'],
        globIgnores: ['**/*.map', 'service-worker.js', 'workbox-*.js'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/_/, /\/[^/?]+\.[^/]+$/],
      },
    }),
  ],
  css: {
    modules: { generateScopedName: scopedName },
  },
  build: {
    outDir: 'build', // Capacitor webDir, nginx and Docker expect ./build
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    host: true,
    allowedHosts: true,
    https,
  },
  preview: {
    port: 3000,
    host: true,
    allowedHosts: true,
    https,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.ts',
    // the Electron wrapper has its own tests, run by Node's test runner (bun run test in electron/)
    exclude: [...configDefaults.exclude, 'electron/**'],
  },
});
