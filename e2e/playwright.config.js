import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './specs',
    outputDir: './test-results',
    timeout: 30_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: [['list']],
    use: {
        headless: true,
        trace: 'on-first-retry',
    },
    projects: [
        { name: 'firefox', use: { browserName: 'firefox' } },
    ],
});
