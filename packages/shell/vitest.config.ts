import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // ui/messages-designs: ported sandbox tests travel WITH the code they
    // guard (camera policy, CSS architecture) rather than moving to tests/.
    include: ['tests/**/*.test.ts', 'ui/messages-designs/**/*.test.ts'],
    testTimeout: 20000,
  },
});
