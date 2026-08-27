import pino from 'pino';
import { config } from '../config.js';

/**
 * Message bodies and phone numbers are deliberately never logged at info level;
 * see docs/PRIVACY.md for the retention rules this supports.
 */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['phone', 'waId', 'body', '*.phone', '*.waId', '*.body'],
    censor: '[redacted]',
  },
  transport: config.isProduction
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } },
});

export type Logger = typeof logger;
