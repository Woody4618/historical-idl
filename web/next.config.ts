import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  experimental: {
    externalDir: true,
  },
  webpack(config) {
    // The core library uses .js extensions in imports (NodeNext resolution).
    // Map .js -> .ts so the bundler can find them.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.js'],
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      '@core': path.resolve(__dirname, '../src'),
    };
    return config;
  },
};

export default nextConfig;
