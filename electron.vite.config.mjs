import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['esptool-js'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['esptool-js'] })]
    // UWAGA: sandboxed preload MUSI zostać CJS (.js) — drugi wpis w
    // rollupOptions.input przełącza output na ESM (.mjs), którego sandbox
    // nie ładuje (window.api = undefined). Nie dodawać wpisów tutaj.
  },
  renderer: {
    resolve: {
      alias: {
        '@': 'src/renderer/src'
      }
    }
  }
})