const { loadEnvConfig } = require('@next/env');
const path = require('node:path');

loadEnvConfig(path.resolve(__dirname, '..', '..'));
