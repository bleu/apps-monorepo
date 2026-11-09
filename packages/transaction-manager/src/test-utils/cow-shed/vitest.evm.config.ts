import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/test-utils/cow-shed/atomicRegistration.evm.ts'],
  },
})
