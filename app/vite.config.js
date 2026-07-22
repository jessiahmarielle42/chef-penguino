import { defineConfig } from 'vite'

// Vercel serves from the domain root; GitHub Pages serves this repo under
// /chef-penguino/. Vercel sets the VERCEL env var during its build, so we
// can pick the right base automatically without a manual toggle.
export default defineConfig({
  base: process.env.VERCEL ? '/' : '/chef-penguino/',
})
