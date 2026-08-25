import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        // Integration files share the process-wide auth/space metadata files.
        // One worker prevents cross-file write contention and state leakage.
        fileParallelism: false,
        setupFiles: ['./tests/setup.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'tests/',
                'vitest.config.js'
            ]
        },
        testTimeout: 10000
    }
});
