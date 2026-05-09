import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveIngredientTextInput,
  resolveRecipeDetailRequestPayload,
} from '../../app.js';

test('resolveIngredientTextInput accepts mobile fallback fields', () => {
  assert.equal(resolveIngredientTextInput({ message: '鸡蛋 番茄' }), '鸡蛋 番茄');
  assert.equal(resolveIngredientTextInput({ prompt: ' 胡萝卜 ' }), '胡萝卜');
  assert.equal(resolveIngredientTextInput({ transcript: ['土豆', '牛肉'] }), '土豆 牛肉');
});

test('resolveIngredientTextInput falls back to query text when body is empty', () => {
  assert.equal(resolveIngredientTextInput({}, { text: '西红柿 鸡蛋' }), '西红柿 鸡蛋');
  assert.equal(resolveIngredientTextInput(null, { message: ['青菜', '豆腐'] }), '青菜 豆腐');
});

test('resolveIngredientTextInput returns empty string for missing text', () => {
  assert.equal(resolveIngredientTextInput({}), '');
  assert.equal(resolveIngredientTextInput(null), '');
});

test('resolveRecipeDetailRequestPayload accepts body-only payload', () => {
  const payload = resolveRecipeDetailRequestPayload({
    profileId: 'cp_001',
    profile: {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油脂'],
    },
    ingredients: [
      {
        id: 'ing_app_detail_1',
        name: '番茄',
        normalizedName: '番茄',
        quantity: '1个',
        source: 'manual',
      },
    ],
    recipe: {
      id: 'recipe_app_detail',
      name: '接口详情测试菜',
    },
  });

  assert.equal(payload.profileId, 'cp_001');
  assert.equal(payload.ingredients[0]?.name, '番茄');
  assert.equal(payload.recipe?.name, '接口详情测试菜');
});
