import { defineConfig } from "vitest/config";

// 单元测试：happy-dom 提供 window / localStorage / matchMedia；
// mcp/ 下是 MCP 服务端的测试，用文件头的 @vitest-environment node 覆盖环境
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "mcp/**/*.test.mjs"],
  },
});
