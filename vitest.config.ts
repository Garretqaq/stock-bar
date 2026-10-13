import { defineConfig } from "vitest/config";

// 单元测试：happy-dom 提供 window / localStorage / matchMedia
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
