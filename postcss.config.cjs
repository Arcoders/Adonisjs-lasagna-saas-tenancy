const path = require('node:path')

module.exports = {
  plugins: {
    tailwindcss: {
      config: path.resolve(__dirname, 'docs/tailwind.config.cjs'),
    },
    autoprefixer: {},
  },
}
