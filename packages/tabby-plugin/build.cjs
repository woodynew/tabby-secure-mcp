const webpack = require('webpack')
const config = require('./webpack.config.cjs')

webpack(config, (error, stats) => {
  if (error) {
    console.error(error)
    process.exitCode = 1
    return
  }

  const output = stats.toString({ colors: process.stdout.isTTY })
  if (output) {
    console.log(output)
  }

  if (stats.hasErrors()) {
    process.exitCode = 1
  }
})
