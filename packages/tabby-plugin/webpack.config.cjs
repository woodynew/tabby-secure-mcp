const path = require('node:path')

module.exports = {
  mode: 'production',
  target: 'electron-renderer',
  entry: path.resolve(__dirname, 'src/index.ts'),
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: path.resolve(__dirname, 'tsconfig.json'),
            compilerOptions: {
              noEmit: false,
            },
          },
        },
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  externalsType: 'commonjs',
  externals: [
    ({ request }, callback) => {
      if (typeof request === 'string' && request.startsWith('node:')) {
        callback(null, `commonjs ${request.slice('node:'.length)}`)
        return
      }
      callback()
    },
    /^@angular\/(?!common\/locales(?:\/|$))/,
    /^@ng-bootstrap(?:\/|$)/,
    /^rxjs(?:\/|$)/,
    /^tabby-/,
  ],
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    library: {
      type: 'umd',
    },
    globalObject: 'this',
    clean: true,
  },
}
