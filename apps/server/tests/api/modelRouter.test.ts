import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../../modelRouter.js';

test('ModelRouter routes simple recipe recommendation to fast model', () => {
  const router = new ModelRouter();
  const route = router.select('recipe_recommendation', {
    ingredients: [
      { id: 'ing_1', name: '番茄', normalizedName: '番茄', quantity: '1个', source: 'manual' },
      { id: 'ing_2', name: '鸡蛋', normalizedName: '鸡蛋', quantity: '1个', source: 'manual' },
    ],
    userPrompt: '推荐清淡菜谱',
  });

  assert.equal(route.model, 'Qwen/Qwen3.5-9B');
  assert.deepEqual(route.fallbackModels, ['Qwen/Qwen3.5-27B', 'Pro/zai-org/GLM-5']);
  assert.equal(route.enableThinking, false);
  assert.equal(route.maxTokens, 650);
});

test('ModelRouter upgrades complex recipe recommendation to balanced model', () => {
  const router = new ModelRouter();
  const route = router.select('recipe_recommendation', {
    ingredients: Array.from({ length: 8 }, (_, index) => ({
      id: `ing_${index + 1}`,
      name: `食材${index + 1}`,
      normalizedName: `食材${index + 1}`,
      quantity: '1份',
      source: 'manual' as const,
    })),
    userPrompt: '孩子有严重过敏风险，请严格避开禁忌食材',
  });

  assert.equal(route.model, 'Qwen/Qwen3.5-27B');
  assert.deepEqual(route.fallbackModels, ['Pro/zai-org/GLM-5']);
  assert.equal(route.enableThinking, false);
  assert.equal(route.maxTokens, 850);
});

test('ModelRouter keeps GLM-5 as fallback for recipe steps', () => {
  const router = new ModelRouter();
  const route = router.select('recipe_steps');

  assert.equal(route.model, 'Qwen/Qwen3.5-27B');
  assert.deepEqual(route.fallbackModels, ['Pro/zai-org/GLM-5']);
  assert.equal(route.enableThinking, false);
  assert.equal(route.maxTokens, 760);
});

test('ModelRouter routes text and voice ingredient recognition to small text model', () => {
  const router = new ModelRouter();
  const textRoute = router.select('ingredient_text');
  const voiceRoute = router.select('ingredient_voice');

  assert.equal(textRoute.model, 'Qwen/Qwen3.5-9B');
  assert.equal(voiceRoute.model, 'Qwen/Qwen3.5-9B');
  assert.deepEqual(textRoute.fallbackModels, ['Qwen/Qwen3.5-27B', 'Pro/zai-org/GLM-5']);
  assert.deepEqual(voiceRoute.fallbackModels, ['Qwen/Qwen3.5-27B', 'Pro/zai-org/GLM-5']);
  assert.equal(textRoute.enableThinking, false);
  assert.equal(voiceRoute.enableThinking, false);
  assert.equal(textRoute.maxTokens, 260);
  assert.equal(voiceRoute.maxTokens, 260);
});

test('ModelRouter routes image ingredient recognition to multimodal model', () => {
  const router = new ModelRouter();
  const route = router.select('ingredient_vision');

  assert.equal(route.model, 'Qwen/Qwen3-VL-8B-Instruct');
  assert.deepEqual(route.fallbackModels, ['Qwen/Qwen3-VL-32B-Instruct']);
  assert.equal(route.enableThinking, false);
  assert.equal(route.maxTokens, 360);
});
