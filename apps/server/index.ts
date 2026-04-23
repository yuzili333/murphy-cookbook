import { createApp } from './app.js';
import { loadServerEnv } from './env.js';

loadServerEnv();

const port = Number(process.env.PORT ?? 3001);

createApp().listen(port, () => {
  console.log(`Murphy Cookbook API listening on http://localhost:${port}`);
});
