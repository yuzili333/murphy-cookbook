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
  generateRecipeDetail,
  generateRecipePlan,
  isSiliconFlowConfigured,
  shouldRequireRealModel,
  understandIngredientsFromImage,
  understandIngredientsFromText,
} from '../../siliconflow.js';
import {
  getLocalSeasonalIngredientSuggestions,
  seasonalIngredientCacheSize,
} from '../../seasonalIngredients.js';
import { generatedHomeRecipeCatalog, recipeCatalog } from '../../data.js';

test('parseTextToIngredients extracts ingredient tokens from chinese text', () => {
  const ingredients = parseTextToIngredients('两个鸡蛋 一个番茄 半根黄瓜');

  assert.equal(ingredients.length, 3);
  assert.equal(ingredients[0].name, '鸡蛋');
  assert.equal(ingredients[1].name, '番茄');
  assert.equal(ingredients[2].name, '黄瓜');
});

test('parseTextToIngredients maps pinyin input to one best vegetable meat or fruit candidate', () => {
  const ingredients = parseTextToIngredients('ji dan fan qie yu hong luo bo ping guo ji rou');
  const names = ingredients.map((item) => item.name);

  assert.deepEqual(names, ['番茄', '红萝卜', '苹果', '鸡肉']);
});

test('extractIngredientsFromFilename reads ingredient hints from uploaded image filename', () => {
  const ingredients = extractIngredientsFromFilename('今天晚餐-番茄-鸡蛋.jpg');

  assert.ok(ingredients.some((item) => item.name === '番茄'));
  assert.ok(ingredients.some((item) => item.name === '鸡蛋'));
});

test('getLocalSeasonalIngredientSuggestions returns three items from local seasonal cache', () => {
  const suggestions = getLocalSeasonalIngredientSuggestions(7, 3);

  assert.equal(seasonalIngredientCacheSize, 300);
  assert.equal(suggestions.length, 3);
  assert.ok(suggestions.every((item) => item.name && item.reason));
});

test('local home recipe catalog provides 50 generated common recipes', () => {
  assert.equal(generatedHomeRecipeCatalog.length, 50);
  assert.ok(recipeCatalog.length >= 50);
  assert.ok(recipeCatalog.some((recipe) => recipe.name === '番茄炒鸡蛋'));
  assert.ok(recipeCatalog.some((recipe) => recipe.name === '草莓奶昔'));
  assert.ok(recipeCatalog.some((recipe) => recipe.name === '凉拌手撕鸡'));
});

test('recommendRecipes includes configured cold shredded chicken recipe for chicken input locally', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalNetlify = process.env.NETLIFY;
  const originalLambda = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const originalLambdaTaskRoot = process.env.LAMBDA_TASK_ROOT;

  delete process.env.SILICONFLOW_API_KEY;
  process.env.NODE_ENV = 'development';
  delete process.env.NETLIFY;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  delete process.env.LAMBDA_TASK_ROOT;

  const result = await recommendRecipes('cp_001', [
    { id: 'ing_chicken', name: '鸡肉', normalizedName: '鸡肉', quantity: '100克', source: 'manual' },
  ]);

  if ('error' in result) {
    assert.fail(`expected local recommendation data, got ${result.error.code}`);
  }

  assert.ok(result.data.recipes.some((recipe) => recipe.name === '凉拌手撕鸡'));
  assert.equal(result.data.recipeDetails.some((recipe) => recipe.name === '凉拌手撕鸡'), false);

  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (originalNetlify === undefined) {
    delete process.env.NETLIFY;
  } else {
    process.env.NETLIFY = originalNetlify;
  }
  if (originalLambda === undefined) {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  } else {
    process.env.AWS_LAMBDA_FUNCTION_NAME = originalLambda;
  }
  if (originalLambdaTaskRoot === undefined) {
    delete process.env.LAMBDA_TASK_ROOT;
  } else {
    process.env.LAMBDA_TASK_ROOT = originalLambdaTaskRoot;
  }
});

test('generated local recipes follow model prompt output constraints', () => {
  for (const recipe of generatedHomeRecipeCatalog) {
    assert.equal(recipe.fitReasons.length, 0);
    assert.equal(recipe.extraIngredients.length, 0);
    assert.ok(recipe.steps.length >= 4);
    assert.ok(recipe.steps.length <= 8);
    assert.equal(recipe.steps.at(-1)?.expectedResult, `完成${recipe.name}`);

    const ingredientNames = recipe.ingredients.map((item) => item.name);
    for (const step of recipe.steps) {
      assert.ok(step.title);
      assert.match(step.description, /^本步骤食材：.+；操作：.+/);
      assert.ok(step.tip);
      assert.ok(step.childAction);
      assert.ok(step.parentAction);
      assert.ok(step.expectedResult);
      assert.ok(['low', 'medium', 'high'].includes(step.riskLevel));
      assert.equal(typeof step.requiresParentAssist, 'boolean');

      for (const forbidden of ['盐', '油', '糖', '葱', '姜', '蒜', '酱油', '面粉']) {
        if (!ingredientNames.some((name) => name.includes(forbidden))) {
          assert.equal(step.description.includes(forbidden), false);
        }
      }
    }
  }
});

test('recommendRecipes uses local recipe catalog after model timeout and ignores ingredient order', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('接口数据响应超时');
  }) as typeof fetch;

  const startedAt = performance.now();
  const first = await recommendRecipes('cp_001', [
    { id: 'ing_tomato', name: '番茄', normalizedName: '番茄', quantity: '1个', source: 'manual' },
    { id: 'ing_egg', name: '鸡蛋', normalizedName: '鸡蛋', quantity: '2个', source: 'manual' },
  ]);
  const second = await recommendRecipes('cp_001', [
    { id: 'ing_egg', name: '鸡蛋', normalizedName: '鸡蛋', quantity: '2个', source: 'manual' },
    { id: 'ing_tomato', name: '番茄', normalizedName: '番茄', quantity: '1个', source: 'manual' },
  ]);
  const elapsedMs = performance.now() - startedAt;

  if ('error' in first) {
    assert.fail(`expected local recommendation data, got ${first.error.code}`);
  }
  if ('error' in second) {
    assert.fail(`expected local recommendation data, got ${second.error.code}`);
  }

  assert.equal(fetchCalls, 2);
  assert.ok(elapsedMs < 500);
  assert.ok(first.data.recipes.length <= 3);
  assert.equal('imageUrl' in first.data.recipes[0], false);
  assert.deepEqual(first.data.recipes[0].fitReasons, []);
  assert.deepEqual(first.data.recipes[0].extraIngredients, []);
  assert.deepEqual(
    first.data.recipes.map((recipe) => recipe.name),
    second.data.recipes.map((recipe) => recipe.name),
  );

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('recommendRecipes returns model-generated recipe matches for existing child profile', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return (
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              name: '番茄鸡蛋面',
              englishName: 'Tomato Egg Noodles',
              nameLearning: {
                characters: [{ character: '番', pinyin: 'fān', strokes: 12, structure: '上下结构', hint: '上面像采字头，下面是田。' }],
              },
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
    })
    );
  }) as typeof fetch;

  const ingredients = parseTextToIngredients('神秘菜');
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
  assert.ok(result.data);
  assert.equal(result.data?.recipes[0].name, '番茄鸡蛋面');
  assert.equal(result.data?.recipes[0].englishName, 'Tomato Egg Noodles');
  assert.equal(result.data?.recipes[0].nameLearning.characters[0].character, '番');
  assert.equal(result.data?.filteredAllergens[0], '花生');
  assert.equal(result.data?.recipeDetails.length, 0);
});

test('recommendRecipes ignores model-provided ids that collide with local catalog recipes', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_001',
              name: '清炒猪肝片',
              namePinyin: 'qīng chǎo zhū gān piàn',
              englishName: 'Stir-Fried Pork Liver Slices',
              nameLearning: {
                characters: [{ character: '肝', pinyin: 'gān', strokes: 7, structure: '左右结构', hint: '肝是身体里的一个器官。' }],
              },
              ageRange: '7-12 岁',
              difficulty: 'medium',
              estimatedTimeMinutes: 18,
              fitReasons: ['补充铁元素'],
              riskAlerts: ['热锅需家长全程陪同'],
              nutritionSummary: '富含铁和蛋白质。',
              extraIngredients: [],
              canCookWithCurrentIngredients: true,
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await recommendRecipes('cp_001', [
    { id: 'ing_unknown', name: '神秘菜', normalizedName: '神秘菜', quantity: '1份', source: 'manual' },
  ]);

  if ('error' in result) {
    assert.fail(`expected generated recommendation data, got ${result.error.code}`);
  }

  assert.equal(result.data.recipes[0].name, '清炒猪肝片');
  assert.notEqual(result.data.recipes[0].id, 'recipe_001');
  assert.match(result.data.recipes[0].id, /^recipe_gen_summary_/);

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

  const ingredients = parseTextToIngredients('神秘菜');
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

test('recommendRecipes uses default student profile when no child profile is provided', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;

  const result = await recommendRecipes('', [
    { id: 'ing_1', name: '番茄', normalizedName: '番茄', quantity: '1个', source: 'manual', confidence: 1 },
    { id: 'ing_2', name: '鸡蛋', normalizedName: '鸡蛋', quantity: '2个', source: 'manual', confidence: 1 },
  ]);

  if ('error' in result) {
    assert.fail(`expected default profile recommendation data, got ${result.error.code}`);
  }

  assert.ok(result.data.recipes.length > 0);

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
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ingredients":[{"name":"鸡蛋","quantity":"2个"}]}' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const content = await understandIngredientsFromText('两个鸡蛋');

  assert.equal(content, '{"ingredients":[{"name":"鸡蛋","quantity":"2个"}]}');
  assert.equal(requestBodies[0]?.model, 'Qwen/Qwen3.5-9B');
  assert.equal(requestBodies[0]?.enable_thinking, false);
  assert.equal(requestBodies[0]?.max_tokens, 260);
  const messages = requestBodies[0]?.messages as Array<{ role: string; content: string }> | undefined;
  const systemPrompt = messages?.find((message) => message.role === 'system')?.content ?? '';
  assert.match(systemPrompt, /拼音输入食材/);
  assert.match(systemPrompt, /只识别蔬菜、肉禽类、水果类食材/);
  assert.match(systemPrompt, /只输出与拼音和儿童常见食材最匹配的1个名称/);
  assert.match(systemPrompt, /不要把鸡蛋、鱼虾水产、米面主食、豆制品、调味料作为拼音候选输出/);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('understandIngredientsFromText uses small text model for voice transcript', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ingredients":[{"name":"黄瓜","quantity":"1根"}]}' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const content = await understandIngredientsFromText('一根黄瓜', 'voice');

  assert.equal(content, '{"ingredients":[{"name":"黄瓜","quantity":"1根"}]}');
  assert.equal(requestBodies[0]?.model, 'Qwen/Qwen3.5-9B');
  assert.equal(requestBodies[0]?.enable_thinking, false);
  assert.equal(requestBodies[0]?.max_tokens, 260);

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
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ingredients":[{"name":"番茄","quantity":"1份"}]}' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const content = await understandIngredientsFromImage({
    buffer: Buffer.from('fake-image-binary'),
    filename: 'food.jpg',
    mimetype: 'image/jpeg',
  });

  assert.equal(content, '{"ingredients":[{"name":"番茄","quantity":"1份"}]}');
  assert.equal(requestBodies[0]?.model, 'Qwen/Qwen3-VL-8B-Instruct');
  assert.equal(Object.prototype.hasOwnProperty.call(requestBodies[0] ?? {}, 'enable_thinking'), false);
  assert.equal(requestBodies[0]?.max_tokens, 360);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipePlan returns normalized recipe summaries from model output', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
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
    });
  }) as typeof fetch;

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

  assert.equal(result.recipes[0].name, '番茄炒蛋');
  assert.equal(result.recipes[1].name, '番茄鸡蛋面');
  assert.equal(result.recipeDetails.length, 0);
  assert.equal(result.filteredAllergens[0], '花生');
  const requestBody = requestBodies[0] ?? {};
  assert.equal(requestBody?.model, 'Qwen/Qwen3.5-9B');
  assert.equal(requestBody?.enable_thinking, false);
  assert.equal(requestBody?.stream, false);
  assert.equal(requestBody?.max_tokens, 520);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipePlan uses fast model for simple recommendations without slow fallback', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestedModels: string[] = [];
  const requestedMaxTokens: number[] = [];

  global.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
      model?: string;
      max_tokens?: number;
      enable_thinking?: boolean;
      stream?: boolean;
    };
    requestedModels.push(String(requestBody.model ?? ''));
    requestedMaxTokens.push(Number(requestBody.max_tokens));
    assert.equal(requestBody.enable_thinking, false);
    assert.equal(requestBody.stream, false);

    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_fallback_001',
              name: '番茄鸡蛋',
              englishName: 'Tomato Egg',
              nameLearning: {
                characters: [{ character: '蛋', pinyin: 'dàn', strokes: 11, structure: '上下结构', hint: '鸡蛋的蛋。' }],
              },
              ageRange: '7-12 岁',
              difficulty: 'easy',
              estimatedTimeMinutes: 12,
              fitReasons: ['简单'],
              riskAlerts: [],
              nutritionSummary: '营养均衡。',
              extraIngredients: [],
              canCookWithCurrentIngredients: true,
            }],
          }),
        },
      }],
      usage: { total_tokens: 220 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await generateRecipePlan(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油'],
    },
    [
      { id: 'ing_tomato', name: '番茄', normalizedName: '番茄', quantity: '1个', source: 'manual' },
      { id: 'ing_egg', name: '鸡蛋', normalizedName: '鸡蛋', quantity: '1个', source: 'manual' },
    ],
    '推荐简单菜谱',
  );

  assert.equal(result.recipes[0].name, '番茄炒蛋');
  assert.equal(result.recipes[1].name, '番茄鸡蛋');
  assert.deepEqual(requestedModels, ['Qwen/Qwen3.5-9B']);
  assert.deepEqual(requestedMaxTokens, [520]);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipePlan supports benchmark model override', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_override_001',
              name: '番茄鸡蛋',
              englishName: 'Tomato Egg',
              nameLearning: {
                characters: [{ character: '蛋', pinyin: 'dàn', strokes: 11, structure: '上下结构', hint: '鸡蛋的蛋。' }],
              },
              ageRange: '7-12 岁',
              difficulty: 'easy',
              estimatedTimeMinutes: 12,
              riskAlerts: [],
              nutritionSummary: '营养均衡。',
              canCookWithCurrentIngredients: true,
            }],
          }),
        },
      }],
      usage: { total_tokens: 200 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await generateRecipePlan(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油'],
    },
    [
      { id: 'ing_tomato', name: '番茄', normalizedName: '番茄', quantity: '1个', source: 'manual' },
      { id: 'ing_egg', name: '鸡蛋', normalizedName: '鸡蛋', quantity: '1个', source: 'manual' },
    ],
    '推荐简单菜谱',
    { modelOverride: 'Qwen/Qwen3.5-27B' },
  );

  assert.equal(requestBodies[0]?.model, 'Qwen/Qwen3.5-27B');
  assert.equal(requestBodies[0]?.max_tokens, 520);
  assert.equal(requestBodies[0]?.enable_thinking, false);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipePlan fills stable card fields from compact model output', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              name: '土豆胡萝卜泥',
              difficulty: 'easy',
              estimatedTimeMinutes: 15,
              riskAlerts: [],
              nutritionSummary: '软糯清淡，适合儿童。',
              canCookWithCurrentIngredients: true,
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await generateRecipePlan(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油'],
    },
    [
      { id: 'ing_potato', name: '土豆', normalizedName: '土豆', quantity: '1个', source: 'manual' },
      { id: 'ing_carrot', name: '胡萝卜', normalizedName: '胡萝卜', quantity: '半根', source: 'manual' },
    ],
    '推荐软一点的菜',
  );

  assert.equal(result.recipes[0].name, '土豆胡萝卜泥');
  assert.equal(result.recipes[0].englishName, 'Kids Recipe');
  assert.ok(result.recipes[0].nameLearning.characters.length > 0);
  assert.equal(requestBodies[0]?.max_tokens, 520);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipePlan prepends configured cold shredded chicken recipe only for exact chicken input', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  let userPromptContent = '';

  global.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>;
    };
    userPromptContent = String(requestBody.messages?.find((message) => message.role === 'user')?.content ?? '');

    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [
              {
                name: '鸡肉蔬菜汤',
                englishName: 'Chicken Vegetable Soup',
                ageRange: '7-12 岁',
                difficulty: 'easy',
                estimatedTimeMinutes: 20,
                riskAlerts: ['煮汤需家长陪同'],
                nutritionSummary: '营养均衡。',
                canCookWithCurrentIngredients: true,
              },
              {
                name: '鸡肉土豆泥',
                englishName: 'Chicken Potato Mash',
                ageRange: '7-12 岁',
                difficulty: 'easy',
                estimatedTimeMinutes: 18,
                riskAlerts: [],
                nutritionSummary: '口感柔软。',
                canCookWithCurrentIngredients: true,
              },
              {
                name: '清炒鸡肉丁',
                englishName: 'Stir Fried Chicken Cubes',
                ageRange: '7-12 岁',
                difficulty: 'medium',
                estimatedTimeMinutes: 15,
                riskAlerts: ['热锅需家长陪同'],
                nutritionSummary: '蛋白质充足。',
                canCookWithCurrentIngredients: true,
              },
            ],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await generateRecipePlan(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油'],
    },
    [
      { id: 'ing_chicken', name: '鸡肉', normalizedName: '鸡肉', quantity: '100克', source: 'manual' },
    ],
  );

  assert.match(userPromptContent, /凉拌手撕鸡/);
  assert.equal(result.recipes.length, 3);
  assert.equal(result.recipes[0].name, '凉拌手撕鸡');
  assert.equal(result.recipes[0].canCookWithCurrentIngredients, true);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipePlan does not prepend configured chicken recipe when extra ingredients exist', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  let userPromptContent = '';

  global.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>;
    };
    userPromptContent = String(requestBody.messages?.find((message) => message.role === 'user')?.content ?? '');

    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [
              {
                name: '鸡肉土豆汤',
                englishName: 'Chicken Potato Soup',
                ageRange: '7-12 岁',
                difficulty: 'easy',
                estimatedTimeMinutes: 20,
                riskAlerts: ['煮汤需家长陪同'],
                nutritionSummary: '营养均衡。',
                canCookWithCurrentIngredients: true,
              },
              {
                name: '土豆鸡肉泥',
                englishName: 'Chicken Potato Mash',
                ageRange: '7-12 岁',
                difficulty: 'easy',
                estimatedTimeMinutes: 18,
                riskAlerts: [],
                nutritionSummary: '口感柔软。',
                canCookWithCurrentIngredients: true,
              },
              {
                name: '鸡肉土豆饼',
                englishName: 'Chicken Potato Cakes',
                ageRange: '7-12 岁',
                difficulty: 'medium',
                estimatedTimeMinutes: 25,
                riskAlerts: ['热锅需家长陪同'],
                nutritionSummary: '蛋白质充足。',
                canCookWithCurrentIngredients: true,
              },
            ],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await generateRecipePlan(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油'],
    },
    [
      { id: 'ing_chicken', name: '鸡肉', normalizedName: '鸡肉', quantity: '100克', source: 'manual' },
      { id: 'ing_potato', name: '土豆', normalizedName: '土豆', quantity: '1个', source: 'manual' },
    ],
  );

  assert.doesNotMatch(userPromptContent, /凉拌手撕鸡/);
  assert.equal(result.recipes.length, 3);
  assert.equal(result.recipes.some((recipe) => recipe.name === '凉拌手撕鸡'), false);
  assert.equal(result.recipes[0].name, '鸡肉土豆汤');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipePlan prepends configured tomato egg recipe only for exact tomato and egg input', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  let userPromptContent = '';

  global.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>;
    };
    userPromptContent = String(requestBody.messages?.find((message) => message.role === 'user')?.content ?? '');

    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [
              {
                name: '番茄鸡蛋汤',
                englishName: 'Tomato Egg Soup',
                ageRange: '7-12 岁',
                difficulty: 'easy',
                estimatedTimeMinutes: 12,
                riskAlerts: ['煮汤需家长陪同'],
                nutritionSummary: '营养均衡。',
                canCookWithCurrentIngredients: true,
              },
              {
                name: '番茄蛋花羹',
                englishName: 'Tomato Egg Custard',
                ageRange: '7-12 岁',
                difficulty: 'easy',
                estimatedTimeMinutes: 15,
                riskAlerts: ['蒸煮需家长陪同'],
                nutritionSummary: '口感柔软。',
                canCookWithCurrentIngredients: true,
              },
              {
                name: '番茄鸡蛋面',
                englishName: 'Tomato Egg Noodles',
                ageRange: '7-12 岁',
                difficulty: 'easy',
                estimatedTimeMinutes: 18,
                riskAlerts: ['煮面需家长陪同'],
                nutritionSummary: '主食搭配均衡。',
                canCookWithCurrentIngredients: false,
              },
            ],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await generateRecipePlan(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油'],
    },
    [
      { id: 'ing_tomato', name: '番茄', normalizedName: '番茄', quantity: '1个', source: 'manual' },
      { id: 'ing_egg', name: '鸡蛋', normalizedName: '鸡蛋', quantity: '2个', source: 'manual' },
    ],
  );

  assert.match(userPromptContent, /番茄炒蛋/);
  assert.equal(result.recipes.length, 3);
  assert.equal(result.recipes[0].name, '番茄炒蛋');
  assert.equal(result.recipes[0].canCookWithCurrentIngredients, true);

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
      name: '神秘菜',
      normalizedName: '神秘菜',
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

test('getRecipeDetailForRecommendation returns embedded detail without calling model', async () => {
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
      englishName: 'Broccoli Egg Soft Noodles',
      nameLearning: {
        characters: [{ character: '西', pinyin: 'xī', strokes: 6, structure: '独体字', hint: '先从菜名里读一读。' }],
      },
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
        { name: '西兰花', quantity: '1份' },
        { name: '鸡蛋', quantity: '2个' },
      ],
      steps: [{
        id: 'step_1',
        title: '准备食材',
        description: '把西兰花切小朵，鸡蛋打散。',
        tip: '切菜时请家长陪同。',
        riskLevel: 'medium',
        requiresParentAssist: true,
      }],
    },
  });

  if ('error' in result) {
    assert.fail(`expected detail data, got ${result.error.code}`);
  }

  assert.equal(result.data.id, 'recipe_dynamic_001');
  assert.equal(result.data.steps[0].title, '准备食材');
});

test('getRecipeDetailForRecommendation generates cold shredded chicken detail with model instead of local preset', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            steps: [
              { title: '准备鸡肉', description: '本步骤食材：鸡肉；操作：先把鸡肉放入锅中。再加入清水没过鸡肉。看到锅放稳就完成。', requiresParentAssist: true },
              { title: '煮熟鸡肉', description: '本步骤食材：鸡肉；操作：家长开火煮到鸡肉全白。再捞出放温。看到中间没有粉色就完成。', requiresParentAssist: true },
              { title: '撕成鸡丝', description: '本步骤食材：鸡肉；操作：顺着纹理撕成细丝。再放入大碗。看到粗细接近就完成。', requiresParentAssist: false },
              { title: '处理黄瓜', description: '本步骤食材：黄瓜；操作：先洗净黄瓜。再请家长切成细丝。看到黄瓜丝整齐就完成。', requiresParentAssist: true },
              { title: '拌匀装盘', description: '本步骤食材：鸡肉、黄瓜；操作：先把鸡丝和黄瓜丝放一起。再轻轻拌匀装盘。看到分布均匀就完成。', requiresParentAssist: false },
            ],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await getRecipeDetailForRecommendation({
    profileId: 'cp_001',
    ingredients: [
      { id: 'ing_chicken', name: '鸡肉', normalizedName: '鸡肉', quantity: '100克', source: 'manual' },
      { id: 'ing_cucumber', name: '黄瓜', normalizedName: '黄瓜', quantity: '半根', source: 'manual' },
    ],
    recipe: {
      id: 'recipe_003',
      name: '凉拌手撕鸡',
      englishName: 'Cold Shredded Chicken Salad',
      ageRange: '7-12 岁',
      difficulty: 'easy',
      estimatedTimeMinutes: 18,
      fitReasons: [],
      riskAlerts: ['鸡肉必须煮熟'],
      nutritionSummary: '鸡肉提供优质蛋白。',
      extraIngredients: [],
      canCookWithCurrentIngredients: true,
    },
  });

  if ('error' in result) {
    assert.fail(`expected generated detail data, got ${result.error.code}`);
  }

  assert.equal(requestBodies.length, 1);
  assert.equal(requestBodies[0]?.model, 'Qwen/Qwen3.5-9B');
  assert.equal(result.data.name, '凉拌手撕鸡');
  assert.equal(result.data.steps.length, 5);
  assert.equal(result.data.steps[0].title, '准备鸡肉');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation generates model detail for summary-only generated card', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_generated_detail_001',
              name: '番茄鸡蛋软面',
              englishName: 'Tomato Egg Soft Noodles',
              nameLearning: {
                characters: [{ character: '面', pinyin: 'miàn', strokes: 9, structure: '左右结构', hint: '面条的面。' }],
              },
              ageRange: '7-12 岁',
              difficulty: 'easy',
              estimatedTimeMinutes: 18,
              fitReasons: ['适合清淡饮食'],
              riskAlerts: ['热锅需家长陪同'],
              nutritionSummary: '搭配均衡。',
              extraIngredients: [],
              canCookWithCurrentIngredients: true,
              prepTimeMinutes: 5,
              cookTimeMinutes: 13,
              ingredients: [{ name: '番茄', quantity: '1个' }, { name: '鸡蛋', quantity: '1个' }],
              steps: [{
                title: '番茄鸡蛋',
                description: '番茄切块，鸡蛋打散。',
                tip: '刀具交给家长。',
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
    });
  }) as typeof fetch;

  const result = await getRecipeDetailForRecommendation({
    profileId: 'cp_001',
    ingredients: [
      {
        id: 'ing_unavailable_1',
        name: '番茄',
        normalizedName: '番茄',
        quantity: '1个',
        source: 'manual' as const,
      },
      {
        id: 'ing_unavailable_2',
        name: '鸡蛋',
        normalizedName: '鸡蛋',
        quantity: '1个',
        source: 'manual' as const,
      },
    ],
    recipe: {
      id: `recipe_summary_only_${Date.now()}`,
      name: '番茄鸡蛋软面',
      englishName: 'Cached Soft Noodles',
      nameLearning: {
        characters: [{ character: '面', pinyin: 'miàn', strokes: 9, structure: '左右结构', hint: '面条的面。' }],
      },
      ageRange: '7-12 岁',
      difficulty: 'easy' as const,
      estimatedTimeMinutes: 18,
      fitReasons: ['适合清淡饮食'],
      riskAlerts: ['注意防烫'],
      nutritionSummary: '搭配均衡。',
      extraIngredients: [],
      canCookWithCurrentIngredients: true,
    },
  });

  if ('error' in result) {
    assert.fail(`expected generated detail data, got ${result.error.code}`);
  }

  assert.equal(result.data.name, '番茄鸡蛋软面');
  assert.equal(result.data.steps[0].title, '番茄鸡蛋');
  assert.equal(requestBodies[0]?.model, 'Qwen/Qwen3.5-9B');
  assert.equal(requestBodies[0]?.enable_thinking, false);
  assert.equal(requestBodies[0]?.stream, false);
  assert.equal(requestBodies[0]?.max_tokens, 850);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipeDetail fills step fields from guided model output', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  const requestBodies: Array<Record<string, unknown>> = [];

  global.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            steps: [
              { title: '洗净削皮', description: '本步骤食材：土豆、胡萝卜；操作：先把表面泥土洗掉。再削去外皮。看到表面干净就完成。', tip: '削皮前擦干食材，拿起来更稳。', parentAction: '家长负责削皮器操作。', requiresParentAssist: true },
              { title: '切成小块', description: '本步骤食材：土豆、胡萝卜；操作：先切成厚片。再改成小块。看到大小接近就完成。', tip: '小块越接近，蒸软时间越一致。', parentAction: '家长负责刀具切配。', requiresParentAssist: true },
              { title: '上锅蒸软', description: '本步骤食材：土豆、胡萝卜；操作：把小块放进蒸碗。中火蒸到筷子能轻松插入。看到边缘变软就完成。', tip: '蒸汽很烫，开盖时先等几秒。', parentAction: '家长负责开火、开盖和取出蒸碗。', requiresParentAssist: true },
              { title: '压成细泥', description: '本步骤食材：土豆、胡萝卜；操作：放到温热后用勺背压碎。再反复碾压。看到没有明显硬块就完成。', tip: '趁温热压更省力，太烫时不要碰。', parentAction: '', requiresParentAssist: false },
              { title: '整理装盘', description: '本步骤食材：土豆、胡萝卜；操作：把泥整理成小圆堆。再抹平表面。看到形状稳定就完成。', tip: '勺子蘸一点温水，表面更容易抹平。', parentAction: '', requiresParentAssist: false },
            ],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await generateRecipeDetail(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油'],
    },
    [
      { id: 'ing_potato', name: '土豆', normalizedName: '土豆', quantity: '1个', source: 'manual' },
      { id: 'ing_carrot', name: '胡萝卜', normalizedName: '胡萝卜', quantity: '半根', source: 'manual' },
    ],
    {
      id: `recipe_minimal_steps_${Date.now()}`,
      name: '土豆胡萝卜泥',
      englishName: 'Potato Carrot Mash',
      ageRange: '7-12 岁',
      difficulty: 'easy',
      estimatedTimeMinutes: 15,
      riskAlerts: ['蒸煮需要家长协助'],
      nutritionSummary: '软糯清淡。',
      canCookWithCurrentIngredients: true,
    },
  );

  assert.equal(result.name, '土豆胡萝卜泥');
  assert.equal(result.steps.length, 5);
  assert.ok(result.steps.every((step) => step.tip && step.childAction && step.expectedResult));
  assert.ok(result.steps.every((step) => Object.prototype.hasOwnProperty.call(step, 'parentAction')));
  assert.equal(result.steps[1].tip, '小块越接近，蒸软时间越一致。');
  assert.equal(result.steps[2].parentAction, '家长负责开火、开盖和取出蒸碗。');
  assert.equal(result.steps[4].parentAction, '');
  assert.equal(requestBodies[0]?.model, 'Qwen/Qwen3.5-9B');
  assert.equal(requestBodies[0]?.max_tokens, 850);
  const messages = requestBodies[0]?.messages as Array<{ role: string; content: string }> | undefined;
  const promptText = messages?.map((message) => message.content).join('\n') ?? '';
  assert.match(promptText, /promptVersion=guided-v3|promptVersion=guided-v3。/);
  assert.match(promptText, /固定5步|Exactly 5 steps/);
  assert.match(promptText, /不要套用所有菜都相同的固定步骤模板|do not reuse a fixed step template/);
  assert.match(promptText, /每步输出:title,description,tip,parentAction,requiresParentAssist|Each step outputs title,description,tip,parentAction,requiresParentAssist/);
  assert.match(promptText, /不要每步复用同一句通用要点|Do not reuse the same generic tip/);
  assert.match(promptText, /不要写固定的泛泛陪同句|Do not write a fixed generic supervision sentence/);
  assert.equal(promptText.includes('准备工具、清洗切配、加热或拌匀、判断成熟、装盘'), false);
  assert.equal(promptText.includes('prepare tools, wash/cut, cook or mix, check doneness, plate'), false);
  assert.match(promptText, /火候\/时间|heat\/time/);
  assert.match(promptText, /能看到的状态|visible done cue/);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation strips step ingredients outside submitted list', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_generated_broad_bean',
              name: '清煮鲜蚕豆',
              namePinyin: 'qīng zhǔ xiān cán dòu',
              englishName: 'Boiled Fresh Broad Beans',
              ageRange: '7-12 岁',
              difficulty: 'medium',
              estimatedTimeMinutes: 15,
              fitReasons: ['清淡简单'],
              riskAlerts: ['开水需家长陪同'],
              nutritionSummary: '富含植物蛋白。',
              extraIngredients: ['少许盐'],
              canCookWithCurrentIngredients: true,
              prepTimeMinutes: 5,
              cookTimeMinutes: 10,
              ingredients: [{ name: '蚕豆', quantity: '1小碗' }, { name: '盐', quantity: '半勺' }],
              steps: [{
                title: '蚕豆加盐煮',
                description: '把蚕豆放进锅里，加入少许盐一起煮。',
                tip: '盐不要放太多。',
                childAction: '观察蚕豆变软，不要碰热锅和盐罐。',
                parentAction: '家长负责开火、加盐和倒热水。',
                expectedResult: '蚕豆带一点盐味并变软。',
                riskLevel: 'high',
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
    profileId: 'chat_context_profile',
    profileInput: {
      id: 'chat_context_profile',
      nickname: '小学阶段学生',
      age: 8,
      tastePreferences: ['低油脂', '轻口味'],
      allergens: [],
      dietaryHabits: ['膳食均衡'],
    },
    ingredients: [{ id: 'ing_broad_bean', name: '蚕豆', normalizedName: '蚕豆', quantity: '1小碗', source: 'manual' }],
    recipe: {
      id: `recipe_generated_broad_bean_${Date.now()}`,
      name: '清煮鲜蚕豆',
      namePinyin: 'qīng zhǔ xiān cán dòu',
      englishName: 'Boiled Fresh Broad Beans',
      ageRange: '7-12 岁',
      difficulty: 'medium' as const,
      estimatedTimeMinutes: 15,
      fitReasons: ['清淡简单'],
      riskAlerts: ['开水需家长陪同'],
      nutritionSummary: '富含植物蛋白。',
      extraIngredients: ['少许盐'],
      canCookWithCurrentIngredients: true,
    },
  });

  if ('error' in result) {
    assert.fail(`expected generated detail data, got ${result.error.code}`);
  }

  assert.deepEqual(result.data.extraIngredients, []);
  assert.deepEqual(result.data.ingredients.map((item) => item.name), ['蚕豆', '少许盐']);
  assert.equal(JSON.stringify(result.data.steps).includes('盐'), true);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('generateRecipeDetail keeps English fallback step text in English mode', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            steps: [{
              title: 'Wash tomato',
              description: 'Step ingredients: tomato; Action: Wash the tomato under running water. Cut it into small pieces. Put the pieces in a clean bowl. It is done when the tomato is ready.',
              requiresParentAssist: false,
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const result = await generateRecipeDetail(
    {
      id: 'cp_001',
      nickname: 'Murphy',
      age: 8,
      tastePreferences: ['清淡'],
      allergens: [],
      dietaryHabits: ['低油'],
    },
    [
      { id: 'ing_tomato', name: 'tomato', normalizedName: 'tomato', quantity: '1 piece', source: 'manual' },
      { id: 'ing_egg', name: 'egg', normalizedName: 'egg', quantity: '1 piece', source: 'manual' },
    ],
    {
      id: 'recipe_en_detail_dynamic',
      name: 'Tomato Egg Bowl',
      englishName: 'Tomato Egg Bowl',
      namePinyin: 'to-ma-to egg bowl',
      ageRange: '7-12 years',
      difficulty: 'easy',
      estimatedTimeMinutes: 12,
      riskAlerts: [],
      nutritionSummary: 'Balanced and mild.',
      canCookWithCurrentIngredients: true,
    },
    { locale: 'en', pinyinMode: true },
  );

  const stepText = JSON.stringify(result.steps);
  assert.equal(stepText.includes('Extra ingredient action'), true);
  assert.equal(stepText.includes('补充食材操作'), false);
  assert.equal(stepText.includes('也要确认'), false);
  assert.equal(stepText.includes('完成后就是'), false);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation ensures each detail ingredient appears in cooking steps', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_generated_tomato_egg',
              name: '番茄鸡蛋',
              namePinyin: 'fān qié jī dàn',
              englishName: 'Tomato Egg',
              ageRange: '7-12 岁',
              difficulty: 'medium',
              estimatedTimeMinutes: 12,
              fitReasons: ['营养均衡'],
              riskAlerts: ['热锅需家长陪同'],
              nutritionSummary: '蛋白质和维生素搭配。',
              extraIngredients: [],
              canCookWithCurrentIngredients: true,
              prepTimeMinutes: 5,
              cookTimeMinutes: 7,
              ingredients: [{ name: '番茄', quantity: '1个' }, { name: '鸡蛋', quantity: '1个' }],
              steps: [{
                title: '处理番茄',
                description: '本步骤食材：番茄；操作：把番茄洗干净切小块。',
                tip: '刀具交给家长。',
                childAction: '把番茄递给家长。',
                parentAction: '家长负责切番茄。',
                expectedResult: '番茄变成小块。',
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
      { id: 'ing_tomato', name: '番茄', normalizedName: '番茄', quantity: '1个', source: 'manual' },
      { id: 'ing_egg', name: '鸡蛋', normalizedName: '鸡蛋', quantity: '1个', source: 'manual' },
    ],
    recipe: {
      id: `recipe_generated_tomato_egg_${Date.now()}`,
      name: '番茄鸡蛋',
      namePinyin: 'fān qié jī dàn',
      englishName: 'Tomato Egg',
      ageRange: '7-12 岁',
      difficulty: 'medium' as const,
      estimatedTimeMinutes: 12,
      fitReasons: ['营养均衡'],
      riskAlerts: ['热锅需家长陪同'],
      nutritionSummary: '蛋白质和维生素搭配。',
      extraIngredients: [],
      canCookWithCurrentIngredients: true,
    },
  });

  if ('error' in result) {
    assert.fail(`expected generated detail data, got ${result.error.code}`);
  }

  const stepText = JSON.stringify(result.data.steps);
  assert.equal(stepText.includes('番茄'), true);
  assert.equal(stepText.includes('鸡蛋'), true);
  assert.match(stepText, /清洗|整理|加入|切小/);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation parses standard JSON object when model adds surrounding text', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: [
            '下面是标准 JSON：',
            JSON.stringify({
              steps: [{
                title: '处理蚕豆',
                description: '本步骤食材：蚕豆；操作：把蚕豆洗净，放入锅中煮软。',
                tip: '热锅和开水由家长操作。',
                childAction: '把洗好的蚕豆递给家长。',
                parentAction: '家长负责开火和倒热水。',
                expectedResult: '蚕豆变软，完成清煮鲜蚕豆。',
                riskLevel: 'high',
                requiresParentAssist: true,
              }],
            }),
          ].join('\n'),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const result = await getRecipeDetailForRecommendation({
    profileId: 'chat_context_profile',
    ingredients: [{ id: 'ing_broad_bean', name: '蚕豆', normalizedName: '蚕豆', quantity: '1小碗', source: 'manual' }],
    recipe: {
      id: `recipe_generated_broad_bean_surrounded_${Date.now()}`,
      name: '清煮鲜蚕豆',
      namePinyin: 'qīng zhǔ xiān cán dòu',
      englishName: 'Boiled Fresh Broad Beans',
      ageRange: '7-12 岁',
      difficulty: 'medium' as const,
      estimatedTimeMinutes: 15,
      fitReasons: ['清淡简单'],
      riskAlerts: ['开水需家长陪同'],
      nutritionSummary: '富含植物蛋白。',
      extraIngredients: [],
      canCookWithCurrentIngredients: true,
    },
  });

  if ('error' in result) {
    assert.fail(`expected generated detail data, got ${result.error.code}`);
  }

  assert.equal(result.data.steps[0].title, '处理蚕豆');
  assert.equal(result.data.steps[0].description.includes('蚕豆'), true);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation salvages complete steps from truncated model JSON', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        finish_reason: 'length',
        message: {
          content: `{"steps":[{"title":"清洗菠菜","description":"本步骤食材：菠菜；操作：先把菠菜放进清水。再轻轻搓洗叶片。看到没有泥沙就完成。","tip":"一片片分开洗。","childAction":"清洗菠菜叶片。","parentAction":"在旁边看护","expectedResult":"菠菜洗净。","riskLevel":"low","requiresParentAssist":false},{"title":"切配菠菜","description":"本步骤食材：菠菜；操作：先把洗好的菠菜放在案板上。再切成小段。看到长短接近就完成。","tip":"手指离刀远一点。","childAction":"在看护下摆放菜段。","parentAction":"在旁边看护","expectedResult":"菠菜切成小段。","riskLevel":"low","requiresParentAssist":false},{"title":"入锅`,
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const result = await getRecipeDetailForRecommendation({
    profileId: 'chat_context_profile',
    ingredients: [{ id: 'ing_spinach', name: '菠菜', normalizedName: '菠菜', quantity: '适量', source: 'manual' }],
    recipe: {
      id: `recipe_generated_spinach_truncated_${Date.now()}`,
      name: '清炒菠菜',
      namePinyin: 'qīng chǎo bō cài',
      englishName: 'Stir-fried Spinach',
      ageRange: '7-12 岁',
      difficulty: 'medium' as const,
      estimatedTimeMinutes: 12,
      fitReasons: ['清淡简单'],
      riskAlerts: ['热锅需家长陪同'],
      nutritionSummary: '富含膳食纤维。',
      extraIngredients: [],
      canCookWithCurrentIngredients: true,
    },
  });

  if ('error' in result) {
    assert.fail(`expected salvaged detail data, got ${result.error.code}`);
  }

  assert.equal(result.data.steps.length >= 2, true);
  assert.equal(result.data.steps[0].title, '清洗菠菜');
  assert.equal(result.data.steps[1].title, '切配菠菜');

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation rejects model detail with mismatched recipe name', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';

  global.fetch = (async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_wrong_name',
              name: '蚕豆炒饭',
              namePinyin: 'cán dòu chǎo fàn',
              englishName: 'Broad Bean Fried Rice',
              ageRange: '7-12 岁',
              difficulty: 'medium',
              estimatedTimeMinutes: 15,
              fitReasons: ['清淡简单'],
              riskAlerts: ['热锅需家长陪同'],
              nutritionSummary: '富含植物蛋白。',
              extraIngredients: [],
              canCookWithCurrentIngredients: true,
              prepTimeMinutes: 5,
              cookTimeMinutes: 10,
              ingredients: [{ name: '蚕豆', quantity: '1小碗' }],
              steps: [{
                title: '炒蚕豆',
                description: '本步骤食材：蚕豆；操作：把蚕豆放进锅里翻炒。',
                tip: '热锅交给家长。',
                childAction: '观察蚕豆颜色。',
                parentAction: '家长负责开火。',
                expectedResult: '完成蚕豆炒饭。',
                riskLevel: 'high',
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
    profileId: 'chat_context_profile',
    profileInput: {
      id: 'chat_context_profile',
      nickname: '小学阶段学生',
      age: 8,
      tastePreferences: ['低油脂', '轻口味'],
      allergens: [],
      dietaryHabits: ['膳食均衡'],
    },
    ingredients: [{ id: 'ing_broad_bean', name: '蚕豆', normalizedName: '蚕豆', quantity: '1小碗', source: 'manual' }],
    recipe: {
      id: `recipe_expected_broad_bean_${Date.now()}`,
      name: '清煮鲜蚕豆',
      namePinyin: 'qīng zhǔ xiān cán dòu',
      englishName: 'Boiled Fresh Broad Beans',
      ageRange: '7-12 岁',
      difficulty: 'medium' as const,
      estimatedTimeMinutes: 15,
      fitReasons: ['清淡简单'],
      riskAlerts: ['开水需家长陪同'],
      nutritionSummary: '富含植物蛋白。',
      extraIngredients: [],
      canCookWithCurrentIngredients: true,
    },
  });

  if (!('error' in result)) {
    assert.fail('expected mismatched model detail to be rejected');
  }

  assert.equal(result.error.code, 'RECIPE_DETAIL_UNAVAILABLE');
  assert.match(result.error.message, /不一致/);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation does not return local catalog detail when generated id collides', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  const originalFetch = global.fetch;
  process.env.SILICONFLOW_API_KEY = 'test-key';
  let fetchCalled = false;

  global.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            recipes: [{
              id: 'recipe_001',
              name: '清炒猪肝片',
              namePinyin: 'qīng chǎo zhū gān piàn',
              englishName: 'Stir-Fried Pork Liver Slices',
              ageRange: '7-12 岁',
              difficulty: 'medium',
              estimatedTimeMinutes: 18,
              fitReasons: ['补充铁元素'],
              riskAlerts: ['热锅需家长全程陪同'],
              nutritionSummary: '富含铁和蛋白质。',
              extraIngredients: [],
              canCookWithCurrentIngredients: true,
              prepTimeMinutes: 8,
              cookTimeMinutes: 10,
              ingredients: [{ name: '猪肝', quantity: '1份' }],
              steps: [{
                title: '处理猪肝',
                description: '本步骤食材：猪肝；操作：把猪肝冲洗干净并切成薄片。',
                tip: '刀具由家长操作。',
                childAction: '观察猪肝颜色，帮忙递盘子。',
                parentAction: '家长负责切片和热锅。',
                expectedResult: '猪肝片准备好，最后完成清炒猪肝片。',
                riskLevel: 'high',
                requiresParentAssist: true,
              }],
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await getRecipeDetailForRecommendation({
    profileId: 'cp_001',
    ingredients: [
      { id: 'ing_liver', name: '猪肝', normalizedName: '猪肝', quantity: '1份', source: 'manual' },
    ],
    recipe: {
      id: 'recipe_001',
      name: '清炒猪肝片',
      namePinyin: 'qīng chǎo zhū gān piàn',
      englishName: 'Stir-Fried Pork Liver Slices',
      ageRange: '7-12 岁',
      difficulty: 'medium' as const,
      estimatedTimeMinutes: 18,
      fitReasons: ['补充铁元素'],
      riskAlerts: ['热锅需家长全程陪同'],
      nutritionSummary: '富含铁和蛋白质。',
      extraIngredients: [],
      canCookWithCurrentIngredients: true,
    },
  });

  if ('error' in result) {
    assert.fail(`expected generated detail data, got ${result.error.code}: ${result.error.message}`);
  }

  assert.equal(fetchCalled, true);
  assert.equal(result.data.id, 'recipe_001');
  assert.equal(result.data.name, '清炒猪肝片');
  assert.equal(result.data.ingredients[0].name, '猪肝');
  assert.equal(JSON.stringify(result.data.steps).includes('番茄鸡蛋面'), false);

  global.fetch = originalFetch;
  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  } else {
    delete process.env.SILICONFLOW_API_KEY;
  }
});

test('getRecipeDetailForRecommendation does not reject empty ingredients as invalid argument', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;

  const result = await getRecipeDetailForRecommendation({
    profileId: 'cp_001',
    ingredients: [],
    recipe: {
      id: `recipe_empty_ingredients_${Date.now()}`,
      name: '鸡蛋羹',
      englishName: 'Steamed Egg',
      ageRange: '7-12 岁',
      difficulty: 'easy' as const,
      estimatedTimeMinutes: 12,
      fitReasons: ['清淡软嫩'],
      riskAlerts: ['蒸锅需家长陪同'],
      nutritionSummary: '蛋白质丰富。',
      extraIngredients: ['鸡蛋'],
      canCookWithCurrentIngredients: true,
    },
  });

  if (!('error' in result)) {
    assert.fail('expected provider configuration error when model is not configured');
  }

  assert.notEqual(result.error.code, 'INVALID_ARGUMENT');

  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
  }
});

test('getRecipeDetailForRecommendation does not reject deployed broad bean payload as invalid argument', async () => {
  const originalKey = process.env.SILICONFLOW_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;

  const result = await getRecipeDetailForRecommendation({
    profileId: 'chat_context_profile',
    profileInput: {
      id: 'chat_context_profile',
      nickname: '小学阶段学生',
      age: 8,
      tastePreferences: ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
      allergens: [],
      dietaryHabits: ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
    },
    ingredients: [{ id: 'ing_broad_bean', name: '蚕豆', normalizedName: '蚕豆', quantity: '适量', source: 'manual' }],
    recipe: {
      id: '1',
      name: '清煮鲜蚕豆',
      namePinyin: 'qīng zhǔ xiān cán dòu',
      englishName: 'Boiled Fresh Broad Beans',
      ageRange: '7-12 岁',
      difficulty: 'medium' as const,
      estimatedTimeMinutes: 15,
      fitReasons: ['做法最简单，保留蚕豆原味', '低油脂，符合轻口味需求', '操作门槛低，适合儿童初次尝试'],
      riskAlerts: ['需家长全程陪同', '涉及开水和燃气灶/电磁炉'],
      nutritionSummary: '富含植物蛋白和膳食纤维，清淡易消化。',
      extraIngredients: ['少许盐'],
      canCookWithCurrentIngredients: true,
    },
  });

  if (!('error' in result)) {
    assert.fail('expected provider configuration error when model is not configured');
  }

  assert.notEqual(result.error.code, 'INVALID_ARGUMENT');

  if (originalKey) {
    process.env.SILICONFLOW_API_KEY = originalKey;
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
      englishName: 'Tomato Egg Noodles',
      nameLearning: {
        characters: [{ character: '番', pinyin: 'fān', strokes: 12, structure: '上下结构', hint: '上面像采字头，下面是田。' }],
      },
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
