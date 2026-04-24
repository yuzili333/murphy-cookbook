import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

export function loadServerEnv() {
  if (
    process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT ||
    process.env.NODE_ENV === 'production'
  ) {
    return;
  }

  const cwd = process.cwd();
  const candidates = [
    resolve(cwd, '.env'),
    resolve(cwd, '../.env'),
    resolve(cwd, '../../.env'),
  ];

  const envPath = candidates.find((candidate) => existsSync(candidate));

  if (envPath) {
    config({ path: envPath });
    return;
  }

  config();
}
