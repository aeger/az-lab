/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Don't bundle native/non-ESM server-only packages with Turbopack
  serverExternalPackages: ['ssh2', 'better-sqlite3', 'cpu-features', 'sshcrypto', 'jsdom', '@mozilla/readability'],
  images: {
    remotePatterns: [
      // Immich photos (update host to match your deployment)
      { protocol: 'http', hostname: 'immich-server', pathname: '/api/assets/**' },
      { protocol: 'http', hostname: '192.168.*', pathname: '/api/assets/**' },
    ],
  },
}

module.exports = nextConfig
