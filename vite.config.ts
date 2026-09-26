import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: false },
  test: {
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
