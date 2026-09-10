import nextEnv from '@next/env';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

nextEnv.loadEnvConfig(resolve(process.cwd(), '..'));

const require = createRequire(import.meta.url);
const { validateDashboardEnv } = require('./scripts/validate-env.cjs');
validateDashboardEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true
};

export default nextConfig;
