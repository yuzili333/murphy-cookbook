import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const frontendRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(frontendRoot, '../..');
const certDir = resolve(workspaceRoot, '.local', 'certs');
const certFile = resolve(certDir, 'frontend-dev-cert.pem');
const keyFile = resolve(certDir, 'frontend-dev-key.pem');

function resolveHttpsConfig() {
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    return undefined;
  }

  return {
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
  };
}

const httpsConfig = resolveHttpsConfig();

export default defineConfig({
  root: frontendRoot,
  envDir: workspaceRoot,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // https: httpsConfig,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    https: httpsConfig,
    port: 4173,
  },
});
