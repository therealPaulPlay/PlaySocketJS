import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default [
    {
        input: "src/client/client.ts",
        output: {
            file: "dist/client.js",
            format: "es",
            sourcemap: false
        },
        plugins: [nodeResolve({browser: true}), typescript({sourceMap: false})],
    },
    {
        input: "src/server/server.ts",
        output: {
            file: "dist/server.js",
            format: "es",
            sourcemap: true
        },
        external: ["ws", "http", "express", "cors", "@msgpack/msgpack", "node:http"],
        plugins: [typescript()],
    }
] satisfies import("rollup").RollupOptions[];
