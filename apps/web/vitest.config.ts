import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    // Os testes de interface são isolados e não disputam banco nem porta,
    // então podem rodar em paralelo — ao contrário da suíte da API.
    restoreMocks: true,
  },
})
