import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveIngredientTextInput,
  resolveRecommendationRequestPayload,
  resolveRecipeDetailRequestPayload,
  stripRecipeDetailImageFields,
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

test('resolveRecipeDetailRequestPayload strips heavy recipe fields', () => {
  const payload = resolveRecipeDetailRequestPayload({
    profileId: 'cp_001',
    ingredients: [{ name: '鸡蛋', quantity: '1个', source: 'manual' }],
    recipe: {
      id: 'recipe_heavy_fields',
      name: '鸡蛋羹',
      imageUrl: 'https://example.com/egg.jpg',
      nameLearning: {
        characters: [{ character: '蛋', pinyin: 'dàn', strokes: 11, structure: '上下结构', hint: '鸡蛋的蛋。' }],
      },
      englishName: 'Steamed Egg',
      fitReasons: ['清淡'],
    },
  });

  assert.equal(payload.recipe?.id, 'recipe_heavy_fields');
  assert.equal(payload.recipe?.englishName, 'Steamed Egg');
  assert.equal('imageUrl' in (payload.recipe ?? {}), false);
  assert.equal('nameLearning' in (payload.recipe ?? {}), false);
});

test('resolveRecipeDetailRequestPayload accepts stringified recipe in body', () => {
  const payload = resolveRecipeDetailRequestPayload({
    profileId: 'cp_001',
    ingredients: [{ name: '鸡蛋', quantity: '1个', source: 'manual' }],
    recipe: JSON.stringify({
      id: 'recipe_stringified',
      name: '鸡蛋羹',
      imageUrl: 'https://example.com/egg.jpg',
      nameLearning: { characters: [] },
    }),
  });

  assert.equal(payload.recipe?.id, 'recipe_stringified');
  assert.equal(payload.recipe?.name, '鸡蛋羹');
  assert.equal('imageUrl' in (payload.recipe ?? {}), false);
  assert.equal('nameLearning' in (payload.recipe ?? {}), false);
});

test('stripRecipeDetailImageFields removes recipe and ingredient image urls', () => {
  const detail = stripRecipeDetailImageFields({
    id: 'recipe_with_images',
    name: '番茄鸡蛋面',
    namePinyin: 'fān qié jī dàn miàn',
    imageUrl: 'https://example.com/recipe.jpg',
    englishName: 'Tomato Egg Noodles',
    nameLearning: { characters: [] },
    ageRange: '7-12 岁',
    difficulty: 'easy',
    estimatedTimeMinutes: 20,
    fitReasons: ['清淡'],
    riskAlerts: [],
    nutritionSummary: '营养均衡',
    extraIngredients: [],
    canCookWithCurrentIngredients: true,
    prepTimeMinutes: 5,
    cookTimeMinutes: 15,
    ingredients: [{ name: '番茄', quantity: '1个', imageUrl: 'https://example.com/tomato.jpg' }],
    steps: [{
      id: 'step_1',
      title: '洗番茄',
      description: '番茄洗净。',
      tip: '慢慢洗。',
      riskLevel: 'low',
      requiresParentAssist: false,
    }],
  });

  assert.equal('imageUrl' in detail, false);
  assert.equal('imageUrl' in detail.ingredients[0], false);
});

test('resolveRecommendationRequestPayload accepts query ingredients fallback', () => {
  const payload = resolveRecommendationRequestPayload({}, {
    profileId: 'chat_context_profile',
    userPrompt: '请根据当前已识别食材推荐菜谱',
    ingredients: JSON.stringify([
      {
        id: 'ing_query_1',
        name: '鸡蛋',
        normalizedName: '鸡蛋',
        quantity: '1个',
        source: 'manual',
      },
    ]),
  });

  assert.equal(payload.profileId, 'chat_context_profile');
  assert.equal(payload.ingredients.length, 1);
  assert.equal(payload.ingredients[0]?.name, '鸡蛋');
  assert.equal(payload.userPrompt, '请根据当前已识别食材推荐菜谱');
});

test('resolveRecommendationRequestPayload accepts stringified body payload', () => {
  const payload = resolveRecommendationRequestPayload(JSON.stringify({
    profileId: 'chat_context_profile',
    ingredients: [
      {
        name: '番茄',
        quantity: '1个',
        source: 'manual',
      },
    ],
  }));

  assert.equal(payload.ingredients.length, 1);
  assert.equal(payload.ingredients[0]?.name, '番茄');
  assert.equal(payload.ingredients[0]?.source, 'manual');
});
