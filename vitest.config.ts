import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Every source file is measured, tested or not, so a file with no test fails the
      // thresholds instead of disappearing from the report.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      // 100 percent on all four metrics, per file: each line and branch is exercised by a
      // test, and unreachable code is deleted rather than excluded (CONTRIBUTING.md).
      thresholds: {
        perFile: true,
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
