import resolve from '@rollup/plugin-node-resolve';

export default [
  // Client module (ES)
  {
    input: 'src/client/client.js',
    output: {
      file: 'dist/playsocket-client.js',
      format: 'es'
    },
    plugins: [resolve()]
  },
  // Server module (ES)
  {
    input: 'src/server/server.js',
    output: {
      file: 'dist/playsocket-server.js',
      format: 'es'
    },
    external: ['ws', 'http', 'express', 'cors'],
    plugins: [resolve({ preferBuiltins: true })]
  }
];