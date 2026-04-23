import serverless from 'serverless-http';
import { createApp } from '../../app.js';
import { loadServerEnv } from '../../env.js';

loadServerEnv();

export const handler = serverless(createApp(), {
  binary: ['multipart/form-data', 'application/octet-stream'],
});
