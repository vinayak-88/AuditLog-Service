import fs from 'fs';
import path from 'path';
import winston from 'winston';

const logsDir = path.resolve(process.cwd(), 'logs');
const isDevelopment = process.env.NODE_ENV === 'development';
if (isDevelopment && !fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production' ? winston.format.json() : winston.format.prettyPrint()
  ),
  transports: [
    new winston.transports.Console(),
    ...(isDevelopment
      ? [
          new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
          new winston.transports.File({ filename: path.join(logsDir, 'combined.log') })
        ]
      : [])
  ]
});

export default logger;
