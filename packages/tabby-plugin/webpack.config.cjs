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
            transpileOnly: true,
            compilerOptions: {
              noEmit: false,
              skipLibCheck: true,
              types: [],
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
