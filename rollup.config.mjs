import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default [
  // Client module (ES)
  {
    input: 'src/client/client.js',
    output: {
      file: 'dist/playsocket-client.js',
      format: 'es'
    },
    plugins: [resolve(), commonjs()]
  },
  // Server module (CommonJS)
  {
    input: 'src/server/server.js',
    output: {
      file: 'dist/playsocket-server.cjs',
      format: 'cjs',
      exports: 'default'
    },
    external: ['ws', 'http', 'express', 'cors'],
    plugins: [resolve({ preferBuiltins: true }), commonjs()]
  },
  // Server module (ES)
  {
    input: 'src/server/server.js',
    output: {
      file: 'dist/playsocket-server.mjs',
      format: 'es'
    },
    external: ['ws', 'http', 'express', 'cors'],
    plugins: [resolve({ preferBuiltins: true }), commonjs()]
  }
];