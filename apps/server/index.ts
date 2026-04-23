import { config } from 'dotenv';
import { createApp } from './app.js';

config({ path: new URL('../../.env', import.meta.url) });

const port = Number(process.env.PORT ?? 3001);

createApp().listen(port, () => {
  console.log(`Murphy Cookbook API listening on http://localhost:${port}`);
});
