import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIngredientsFromFilename,
  getRecipeDetailForRecommendation,
  parseIngredientJson,
  parseTextToIngredients,
  recommendRecipes,
} from '../../service.js';
import {
  generateCookingFeedback,
  generateRecipePlan,
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

test('recommendRecipes returns model-generated recipe matches for existing child profile', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              name: '番茄鸡蛋面',
              ageRange: '7-12 岁',
              difficulty: 'easy',
              estimatedTimeMinutes: 20,
              fitReasons: ['使用现有食材'],
              riskAlerts: ['煮面需家长陪同'],
              nutritionSummary: '营养均衡',
              extraIngredients: ['面条'],
              canCookWithCurrentIngredients: false,
              prepTimeMinutes: 5,
              cookTimeMinutes: 15,
              ingredients: [{ name: '番茄', quantity: '1个' }, { name: '鸡蛋', quantity: '2个' }],
              steps: [{
                title: '准备食材',
                description: '洗净番茄，打散鸡蛋。',
                tip: '动作慢一点。',
                riskLevel: 'low',
                requiresParentAssist: false,
              }],
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const ingredients = parseTextToIngredients('鸡蛋 番茄');
  const result = await recommendRecipes('cp_001', ingredients);

  assert.ok('data' in result);
  if (!('data' in result)) {
    assert.fail('expected recommendation data');
  }
  assert.equal(result.data.recipes[0].name, '番茄鸡蛋面');
  assert.equal(result.data.filteredAllergens[0], '花生');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
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

test('recommendRecipes uses provided profile snapshot when profileId is not found', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              name: '番茄鸡蛋面',
              ageRange: '7-12 岁',
              difficulty: 'easy',
              estimatedTimeMinutes: 20,
              fitReasons: ['使用现有食材'],
              riskAlerts: ['煮面需家长陪同'],
              nutritionSummary: '营养均衡',
              extraIngredients: ['面条'],
              canCookWithCurrentIngredients: false,
              prepTimeMinutes: 5,
              cookTimeMinutes: 15,
              ingredients: [{ name: '番茄', quantity: '1个' }, { name: '鸡蛋', quantity: '2个' }],
              steps: [{
                title: '准备食材',
                description: '洗净番茄，打散鸡蛋。',
                tip: '动作慢一点。',
                riskLevel: 'low',
                requiresParentAssist: false,
              }],
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const ingredients = parseTextToIngredients('鸡蛋 番茄');
  const result = await recommendRecipes('local_profile_001', ingredients, {
    id: 'local_profile_001',
    nickname: '小米',
    age: 7,
    tastePreferences: ['清淡'],
    allergens: ['花生'],
    dietaryHabits: ['低盐'],
  });

  assert.ok('data' in result);
  if (!('data' in result)) {
    assert.fail('expected recommendation data');
  }
  assert.equal(result.data.filteredAllergens[0], '花生');
  assert.equal(result.data.recipes[0].name, '番茄鸡蛋面');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('recommendRecipes falls back to mock data in local development when model call fails', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response('upstream failed', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    })) as typeof fetch;

  const ingredients = parseTextToIngredients('鸡蛋 番茄');
  const result = await recommendRecipes('cp_001', ingredients);

  assert.ok('data' in result);
  if (!('data' in result)) {
    assert.fail('expected fallback recommendation data');
  }
  assert.equal(result.data.recipes[0].name, '番茄鸡蛋面');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }

  if (originalNodeEnv) {
    process.env.NODE_ENV = originalNodeEnv;
  } else {
    delete process.env.NODE_ENV;
  }
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

test('generateRecipePlan returns normalized recipe details from model output', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              name: '番茄鸡蛋面',
              ageRange: '7-12 岁',
              difficulty: 'easy',
              estimatedTimeMinutes: 20,
              fitReasons: ['使用现有食材'],
              riskAlerts: ['煮面需家长陪同'],
              nutritionSummary: '营养均衡',
              extraIngredients: ['面条'],
              canCookWithCurrentIngredients: false,
              prepTimeMinutes: 5,
              cookTimeMinutes: 15,
              ingredients: [{ name: '番茄', quantity: '1个' }, { name: '鸡蛋', quantity: '2个' }],
              steps: [{
                title: '准备食材',
                description: '洗净番茄，打散鸡蛋。',
                tip: '动作慢一点。',
                riskLevel: 'low',
                requiresParentAssist: false,
              }],
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const result = await generateRecipePlan(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: ['花生'],
      dietaryHabits: ['低盐'],
    },
    parseTextToIngredients('鸡蛋 番茄'),
  );

  assert.equal(result.recipes[0].name, '番茄鸡蛋面');
  assert.equal(result.recipeDetails.length, 0);
  assert.equal(result.filteredAllergens[0], '花生');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('recommendRecipes uses salvaged model recipes when recipe JSON is truncated', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalNetlify = process.env.NETLIFY;
  const originalLambda = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const originalLambdaTaskRoot = process.env.LAMBDA_TASK_ROOT;

  process.env.SILICONFLOW_API_KEY = 'test-key';
  process.env.NODE_ENV = 'development';
  delete process.env.NETLIFY;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  delete process.env.LAMBDA_TASK_ROOT;

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        finish_reason: 'length',
        message: {
          content: `{
            "recipes": [
              {
                "id": "recipe_001",
                "name": "西兰花鸡蛋软面",
                "imageUrl": "https://example.com/recipe-1.jpg",
                "ageRange": "7-12 岁",
                "difficulty": "easy",
                "estimatedTimeMinutes": 20,
                "fitReasons": ["符合清淡口味"],
                "riskAlerts": ["煮面时注意防烫"],
                "nutritionSummary": "富含膳食纤维和维生素。",
                "extraIngredients": ["鸡蛋 2 个", "细面条 1 把"],
                "canCookWithCurrentIngredients": false,
                "prepTimeMinutes": 5,
                "cookTimeMinutes": 15,
                "ingredients": [
                  { "name": "西兰花", "quantity": "1份", "imageUrl": "https://example.com/broccoli.jpg" },
                  { "name": "鸡蛋", "quantity": "2个", "imageUrl": "https://example.com/egg.jpg" }
                ],
                "steps": [
                  {
                    "title": "准备食材",
                    "description": "把西兰花切小朵，鸡蛋打散。",
                    "tip": "切菜时请家长陪同。",
                    "riskLevel": "medium",
                    "requiresParentAssist": true
                  }
                ]
              },
              {
                "id": "recipe_002",
                "name": "西兰花蒸蛋"`,
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const result = await recommendRecipes('cp_001', [
    {
      id: 'ing_1',
      name: '西兰花',
      normalizedName: '西兰花',
      quantity: '1份',
      source: 'image',
    },
  ]);

  if ('error' in result) {
    assert.fail(`expected salvaged recommendation data, got ${result.error.code}`);
  }

  assert.equal(result.data.recipes.length, 1);
  assert.equal(result.data.recipes[0].name, '西兰花鸡蛋软面');
  assert.equal(result.data.recipeDetails.length, 0);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation generates detail on demand from recipe card', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_dynamic_001',
              name: '西兰花鸡蛋软面',
              imageUrl: 'https://example.com/recipe.jpg',
              ageRange: '7-12 岁',
              difficulty: 'easy',
              estimatedTimeMinutes: 20,
              fitReasons: ['符合清淡口味'],
              riskAlerts: ['煮面时注意防烫'],
              nutritionSummary: '富含膳食纤维和维生素。',
              extraIngredients: ['鸡蛋 2 个', '细面条 1 把'],
              canCookWithCurrentIngredients: false,
              prepTimeMinutes: 5,
              cookTimeMinutes: 15,
              ingredients: [
                { name: '西兰花', quantity: '1份', imageUrl: 'https://example.com/broccoli.jpg' },
                { name: '鸡蛋', quantity: '2个', imageUrl: 'https://example.com/egg.jpg' },
              ],
              steps: [{
                title: '准备食材',
                description: '把西兰花切小朵，鸡蛋打散。',
                tip: '切菜时请家长陪同。',
                riskLevel: 'medium',
                requiresParentAssist: true,
              }],
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const result = await getRecipeDetailForRecommendation({
    profileId: 'cp_001',
    ingredients: [
      {
        id: 'ing_1',
        name: '西兰花',
        normalizedName: '西兰花',
        quantity: '1份',
        source: 'image',
      },
    ],
    recipe: {
      id: 'recipe_dynamic_001',
      name: '西兰花鸡蛋软面',
      imageUrl: 'https://example.com/cover.jpg',
      ageRange: '7-12 岁',
      difficulty: 'easy',
      estimatedTimeMinutes: 20,
      fitReasons: ['符合清淡口味'],
      riskAlerts: ['煮面时注意防烫'],
      nutritionSummary: '富含膳食纤维和维生素。',
      extraIngredients: ['鸡蛋 2 个', '细面条 1 把'],
      canCookWithCurrentIngredients: false,
    },
  });

  if ('error' in result) {
    assert.fail(`expected detail data, got ${result.error.code}`);
  }

  assert.equal(result.data.id, 'recipe_dynamic_001');
  assert.equal(result.data.steps[0].title, '准备食材');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateCookingFeedback returns parsed feedback fields', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"praise":"做得很认真","improvement":"切菜时更慢一点","nextSuggestion":"下次试试加胡萝卜"}',
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const result = await generateCookingFeedback({
    profile: {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: ['花生'],
      dietaryHabits: ['低盐'],
    },
    recipe: {
      id: 'recipe_test',
      name: '番茄鸡蛋面',
      ageRange: '7-12 岁',
      difficulty: 'easy',
      estimatedTimeMinutes: 20,
      fitReasons: ['使用现有食材'],
      riskAlerts: ['煮面需家长陪同'],
      nutritionSummary: '营养均衡',
      extraIngredients: [],
      canCookWithCurrentIngredients: true,
      prepTimeMinutes: 5,
      cookTimeMinutes: 15,
      ingredients: [{ name: '番茄', quantity: '1个' }],
      steps: [{
        id: 'step_1',
        title: '准备食材',
        description: '洗净番茄。',
        tip: '慢慢来。',
        riskLevel: 'low',
        requiresParentAssist: false,
      }],
    },
    tasteFeedback: '很好吃',
    difficultyFeedback: '切菜有点难',
  });

  assert.equal(result.praise, '做得很认真');
  assert.equal(result.improvement, '切菜时更慢一点');
  assert.equal(result.nextSuggestion, '下次试试加胡萝卜');

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
