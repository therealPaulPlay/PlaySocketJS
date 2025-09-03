import { defineConfig } from "tsdown";

export default defineConfig([
    {
        entry: "src/client.ts",
        platform: "browser",
        target: "es2023",
        minify: true,
        dts: true,
        outDir: "dist/client",
        sourcemap: false,
        noExternal: ["@msgpack/msgpack"],
    },
    {
        entry: "src/server.ts",
        platform: "node",
        minify: false,
        dts: true,
        outDir: "dist/server",
        external: ["ws", "http", "express", "cors", "@msgpack/msgpack"],
    },
]);
