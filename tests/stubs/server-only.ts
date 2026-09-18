// Next.js provides the `server-only` module at build time (it exists to make
// an accidental client-bundle import a build error). Vitest resolves imports
// with plain Node, where the package does not exist, so a no-op stub is
// aliased in for tests — see vitest.config.mts. This is a test-runner
// shim only; it does not weaken the real boundary, which is enforced by
// the bundler.
export {};
