import { resolve } from "node:path";
import { defineConfig } from "vite";

// Tauri 期望固定端口；TAURI_DEV_HOST 用于移动端调试，此处保持默认
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    rollupOptions: {
      // 主面板 + 设置窗口 + Windows 悬浮行情条
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        ticker: resolve(__dirname, "ticker.html"),
      },
    },
  },
});
