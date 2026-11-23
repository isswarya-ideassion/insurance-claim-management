// Vercel entry point. Vercel only runs functions from a root-level api/ folder,
// so this file stays here; the backend's handler lives in server/src/serverless.js.
export { default } from '../server/src/serverless.js'
