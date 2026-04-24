import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIngredientsFromFilename, parseIngredientJson, parseTextToIngredients, recommendRecipes } from '../../service.js';
import {
  isSiliconFlowConfigured,
  shouldRequireRealModel,
  understandIngredientsFromImage,
  understandIngredientsFromText,
} from '../../siliconflow.js';

test('parseTextToIngredients extracts ingredient tokens from chinese text', () => {
  const ingredients = parseTextToIngredients('两个鸡蛋 一个番茄 半根黄瓜');

  assert.equal(ingredients.length, 3);
  assert.equal(ingredients[0].name, '鸡蛋');
  assert.equal(ingredients[1].name, '番茄');
  assert.equal(ingredients[2].name, '黄瓜');
});

test('extractIngredientsFromFilename reads ingredient hints from uploaded image filename', () => {
  const ingredients = extractIngredientsFromFilename('今天晚餐-番茄-鸡蛋.jpg');

  assert.ok(ingredients.some((item) => item.name === '番茄'));
  assert.ok(ingredients.some((item) => item.name === '鸡蛋'));
});

test('recommendRecipes returns recipe matches for existing child profile', () => {
  const ingredients = parseTextToIngredients('鸡蛋 番茄');
  const result = recommendRecipes('cp_001', ingredients);

  assert.ok(result.data);
  assert.equal(result.data?.recipes[0].name, '番茄鸡蛋面');
  assert.equal(result.data?.filteredAllergens[0], '花生');
});

test('parseIngredientJson converts LLM json output to ingredient items', () => {
  const ingredients = parseIngredientJson(
    '{"ingredients":[{"name":"鸡蛋","quantity":"2个"},{"name":"番茄","quantity":"1个"}]}',
    'manual',
  );

  assert.equal(ingredients.length, 2);
  assert.equal(ingredients[0].name, '鸡蛋');
  assert.equal(ingredients[0].quantity, '2个');
});

test('recommendRecipes uses provided profile snapshot when profileId is not found', () => {
  const ingredients = parseTextToIngredients('鸡蛋 番茄');
  const result = recommendRecipes('local_profile_001', ingredients, {
    id: 'local_profile_001',
    nickname: '小米',
    age: 7,
    tastePreferences: ['清淡'],
    allergens: ['花生'],
    dietaryHabits: ['低盐'],
  });

  assert.ok(result.data);
  assert.equal(result.data?.filteredAllergens[0], '花生');
  assert.equal(result.data?.recipes[0].name, '番茄鸡蛋面');
});

test('isSiliconFlowConfigured returns false when SILICONFLOW_API_KEY is missing', () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;

  assert.equal(isSiliconFlowConfigured(), false);

  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  }
});

test('understandIngredientsFromText posts chat completions request and returns model content', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: '{"ingredients":[{"name":"鸡蛋","quantity":"2个"}]}' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const content = await understandIngredientsFromText('两个鸡蛋');

  assert.equal(content, '{"ingredients":[{"name":"鸡蛋","quantity":"2个"}]}');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('understandIngredientsFromImage posts image message and returns model content', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: '{"ingredients":[{"name":"番茄","quantity":"1份"}]}' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const content = await understandIngredientsFromImage({
    buffer: Buffer.from('fake-image-binary'),
    filename: 'food.jpg',
    mimetype: 'image/jpeg',
  });

  assert.equal(content, '{"ingredients":[{"name":"番茄","quantity":"1份"}]}');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('shouldRequireRealModel returns true in production-like runtime', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalNetlify = process.env.NETLIFY;

  process.env.NODE_ENV = 'production';
  process.env.NETLIFY = 'true';
  assert.equal(shouldRequireRealModel(), true);

  if (originalNodeEnv) {
    process.env.NODE_ENV = originalNodeEnv;
  } else {
    delete process.env.NODE_ENV;
  }

  if (originalNetlify) {
    process.env.NETLIFY = originalNetlify;
  } else {
    delete process.env.NETLIFY;
  }
});

test('shouldRequireRealModel returns false in local non-production runtime', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalNetlify = process.env.NETLIFY;

  delete process.env.NODE_ENV;
  delete process.env.NETLIFY;
  assert.equal(shouldRequireRealModel(), false);

  if (originalNodeEnv) {
    process.env.NODE_ENV = originalNodeEnv;
  } else {
    delete process.env.NODE_ENV;
  }

  if (originalNetlify) {
    process.env.NETLIFY = originalNetlify;
  } else {
    delete process.env.NETLIFY;
  }
});

test('isSiliconFlowConfigured trims whitespace-only values', () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  process.env.SILICONFLOW_API_KEY = '   ';

  assert.equal(isSiliconFlowConfigured(), false);

  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});
