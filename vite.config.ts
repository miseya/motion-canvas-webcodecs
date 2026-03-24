import {defineConfig} from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
    }),
  ],
  build: {
    lib: {
      entry: "src/webcodecs.ts",
      formats: ["es"],
      fileName: "webcodecs",
    },
    rollupOptions: {
      external: ["@motion-canvas/core", "mediabunny"],
      output: {
        globals: {
          "@motion-canvas/core": "@motion-canvas/core",
          "mediabunny": "mediabunny",
        },
      },
    },
  },
});
