import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Las pruebas de integración ejecutan el código real de la extensión con
      // un doble del módulo `vscode` (Node puro, sin extension host).
      vscode: fileURLToPath(new URL('./test/helpers/mock-vscode.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
