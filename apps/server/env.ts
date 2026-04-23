import { config } from 'dotenv';

export function loadServerEnv() {
  if (process.env.NETLIFY || process.env.NODE_ENV === 'production') {
    return;
  }

  config({ path: new URL('../../.env', import.meta.url) });
}
