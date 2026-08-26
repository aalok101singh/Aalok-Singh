/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  test: {
    include: ['src/tests/**/*.test.ts', 'src/tests/verify.ts'],
  },
})
