import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Tests run sequentially so each test can safely manage its own DB file
    // without races between parallel workers opening the same SQLite file.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Ensure teardown runs even when a test throws
    passWithNoTests: false,
  },
});
