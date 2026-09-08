import nextEnv from '@next/env';
import { resolve } from 'node:path';

nextEnv.loadEnvConfig(resolve(process.cwd(), '..'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true
};

export default nextConfig;
