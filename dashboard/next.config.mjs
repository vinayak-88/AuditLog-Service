import nextEnv from '@next/env';
import { resolve } from 'node:path';

const { combinedEnv } = nextEnv.loadEnvConfig(resolve(process.cwd(), '..'));
const configuredApiUrl = combinedEnv.API_URL || combinedEnv.NEXT_PUBLIC_API_URL;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    API_URL: configuredApiUrl,
    NEXT_PUBLIC_API_URL: combinedEnv.NEXT_PUBLIC_API_URL || configuredApiUrl
  }
};

export default nextConfig;
