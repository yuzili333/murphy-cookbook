import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIngredientsFromFilename, parseTextToIngredients, recommendRecipes } from '../../service.js';
import { isOpenAIConfigured, transcribeAudioWithOpenAI } from '../../openai.js';

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

test('isOpenAIConfigured returns false when OPENAI_API_KEY is missing', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  assert.equal(isOpenAIConfigured(), false);

  if (originalKey) {
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test('transcribeAudioWithOpenAI posts multipart audio and returns transcript text', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({ text: '鸡蛋 番茄 黄瓜' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const transcript = await transcribeAudioWithOpenAI({
    buffer: Buffer.from('fake-audio-binary'),
    filename: 'ingredients.webm',
    mimetype: 'audio/webm',
  });

  assert.equal(transcript, '鸡蛋 番茄 黄瓜');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.OPENAI_API_KEY = originalKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
});
