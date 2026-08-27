import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WHATSAPP_ENABLED: '0',
      WEB_PORT: '0',
      // Keep anything the tests write to disk out of the real data directory.
      DATA_DIR: './tmp-test-data',
    },
  },
});
