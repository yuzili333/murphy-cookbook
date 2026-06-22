import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeApiRequestUrl,
  resolveIngredientKnowledgeRequestPayload,
  resolveIngredientTextInput,
  resolveRecommendationRequestPayload,
  resolveRecipeDetailRequestPayload,
  resolveVideoConfigAuthInput,
  resolveVideoConfigAdminCredentials,
  stripRecipeDetailImageFields,
} from '../../app.js';
import { resolveLlmMetricsMongoRuntimeConfig } from '../../llmMetrics.js';

test('normalizeApiRequestUrl maps Netlify function and bare v1 paths to api routes', () => {
  assert.equal(
    normalizeApiRequestUrl('/.netlify/functions/api/v1/video-config/auth'),
    '/api/v1/video-config/auth',
  );
  assert.equal(normalizeApiRequestUrl('/v1/video-config/auth'), '/api/v1/video-config/auth');
  assert.equal(normalizeApiRequestUrl('/api/v1/video-config/auth'), '/api/v1/video-config/auth');
});

test('resolveVideoConfigAdminCredentials falls back to default admin credentials for missing or blank env', () => {
  assert.deepEqual(resolveVideoConfigAdminCredentials({}), {
    username: 'yuzili',
    password: 'yuzili333',
    tokenSecret: 'murphy-cookbook-video-config-local-secret',
  });
  assert.deepEqual(resolveVideoConfigAdminCredentials({
    VIDEO_CONFIG_ADMIN_USER: ' ',
    VIDEO_CONFIG_ADMIN_PASSWORD: '',
    VIDEO_CONFIG_TOKEN_SECRET: '   ',
  }), {
    username: 'yuzili',
    password: 'yuzili333',
    tokenSecret: 'murphy-cookbook-video-config-local-secret',
  });
  assert.deepEqual(resolveVideoConfigAdminCredentials({
    VIDEO_CONFIG_ADMIN_USER: ' admin ',
    VIDEO_CONFIG_ADMIN_PASSWORD: ' password ',
    VIDEO_CONFIG_TOKEN_SECRET: ' secret ',
  }), {
    username: 'admin',
    password: 'password',
    tokenSecret: 'secret',
  });
});

test('resolveLlmMetricsMongoRuntimeConfig uses MongoDB Atlas defaults', () => {
  assert.deepEqual(resolveLlmMetricsMongoRuntimeConfig({
    MONGODB_URI: 'mongodb+srv://user:pass@example.mongodb.net/',
    MONGODB_DB_NAME: 'murphy_cookbook',
  } as NodeJS.ProcessEnv), {
    configured: true,
    scheme: 'mongodb+srv',
    atlasHost: true,
    database: 'murphy_cookbook',
    collection: 'llm_call_metrics',
    serverSelectionTimeoutMs: 3000,
    tls: true,
    family: 4,
  });
});

test('resolveVideoConfigAuthInput accepts direct, stringified, and nested deployed body shapes', () => {
  assert.deepEqual(resolveVideoConfigAuthInput({ username: ' yuzili ', password: 'yuzili333' }), {
    username: 'yuzili',
    password: 'yuzili333',
  });
  assert.deepEqual(resolveVideoConfigAuthInput('{"username":"yuzili","password":"yuzili333"}'), {
    username: 'yuzili',
    password: 'yuzili333',
  });
  assert.deepEqual(resolveVideoConfigAuthInput({ body: '{"username":"yuzili","password":"yuzili333"}' }), {
    username: 'yuzili',
    password: 'yuzili333',
  });
  assert.deepEqual(resolveVideoConfigAuthInput({ payload: { username: 'yuzili', password: 'yuzili333' } }), {
    username: 'yuzili',
    password: 'yuzili333',
  });
  assert.deepEqual(resolveVideoConfigAuthInput({}, { username: 'yuzili', password: 'yuzili333' }), {
    username: 'yuzili',
    password: 'yuzili333',
  });
});

test('resolveIngredientTextInput accepts mobile fallback fields', () => {
  assert.equal(resolveIngredientTextInput({ message: '鸡蛋 番茄' }), '鸡蛋 番茄');
  assert.equal(resolveIngredientTextInput({ prompt: ' 胡萝卜 ' }), '胡萝卜');
  assert.equal(resolveIngredientTextInput({ transcript: ['土豆', '牛肉'] }), '土豆 牛肉');
  assert.equal(resolveIngredientTextInput({ input: '西兰花' }), '西兰花');
});

test('resolveIngredientTextInput falls back to query text when body is empty', () => {
  assert.equal(resolveIngredientTextInput({}, { text: '西红柿 鸡蛋' }), '西红柿 鸡蛋');
  assert.equal(resolveIngredientTextInput(null, { message: ['青菜', '豆腐'] }), '青菜 豆腐');
});

test('resolveIngredientTextInput accepts deployed string and nested payload shapes', () => {
  assert.equal(resolveIngredientTextInput('{"text":"鸡蛋 番茄"}'), '鸡蛋 番茄');
  assert.equal(resolveIngredientTextInput({ body: '{"text":"黄瓜"}' }), '黄瓜');
  assert.equal(resolveIngredientTextInput({ payload: { message: '土豆 牛肉' } }), '土豆 牛肉');
  assert.equal(resolveIngredientTextInput('胡萝卜 玉米'), '胡萝卜 玉米');
});

test('resolveIngredientTextInput returns empty string for missing text', () => {
  assert.equal(resolveIngredientTextInput({}), '');
  assert.equal(resolveIngredientTextInput(null), '');
});

test('resolveIngredientKnowledgeRequestPayload accepts deployed body shapes', () => {
  assert.equal(resolveIngredientKnowledgeRequestPayload({ name: '番茄' }).name, '番茄');
  assert.equal(resolveIngredientKnowledgeRequestPayload('{"name":"鸡蛋","locale":"en"}').name, '鸡蛋');
  assert.equal(resolveIngredientKnowledgeRequestPayload({ body: '{"ingredientName":"黄瓜"}' }).name, '黄瓜');
  assert.equal(resolveIngredientKnowledgeRequestPayload({ payload: { ingredient: '西兰花' } }).name, '西兰花');
  assert.equal(resolveIngredientKnowledgeRequestPayload('胡萝卜').name, '胡萝卜');
  assert.equal(resolveIngredientKnowledgeRequestPayload({}, { q: '土豆', locale: 'en' }).name, '土豆');
  assert.equal(resolveIngredientKnowledgeRequestPayload({}, { q: '土豆', locale: 'en' }).generationOptions.locale, 'en');
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

const broadBeanDetailPayload = {
  profileId: 'chat_context_profile',
  profile: {
    id: 'chat_context_profile',
    nickname: '小学阶段学生',
    age: 8,
    tastePreferences: ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
    allergens: [],
    dietaryHabits: ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
  },
  ingredients: [{ name: '蚕豆', normalizedName: '蚕豆', quantity: '适量', source: 'manual' }],
  recipe: {
    id: '1',
    name: '清煮鲜蚕豆',
    namePinyin: 'qīng zhǔ xiān cán dòu',
    englishName: 'Boiled Fresh Broad Beans',
    ageRange: '7-12 岁',
    difficulty: 'medium',
    estimatedTimeMinutes: 15,
    fitReasons: ['做法最简单，保留蚕豆原味', '低油脂，符合轻口味需求', '操作门槛低，适合儿童初次尝试'],
    riskAlerts: ['需家长全程陪同', '涉及开水和燃气灶/电磁炉'],
    nutritionSummary: '富含植物蛋白和膳食纤维，清淡易消化。',
    extraIngredients: ['少许盐'],
    canCookWithCurrentIngredients: true,
  },
};

test('resolveRecipeDetailRequestPayload accepts deployed broad bean detail payload', () => {
  const payload = resolveRecipeDetailRequestPayload(broadBeanDetailPayload);

  assert.equal(payload.profileId, 'chat_context_profile');
  assert.equal(payload.ingredients[0]?.name, '蚕豆');
  assert.equal(payload.recipe?.id, '1');
  assert.equal(payload.recipe?.name, '清煮鲜蚕豆');
});

test('resolveRecipeDetailRequestPayload accepts nested serverless payload shape', () => {
  const payload = resolveRecipeDetailRequestPayload({
    body: JSON.stringify(broadBeanDetailPayload),
  });

  assert.equal(payload.profileId, 'chat_context_profile');
  assert.equal(payload.ingredients[0]?.name, '蚕豆');
  assert.equal(payload.recipe?.id, '1');
});

test('resolveRecipeDetailRequestPayload accepts raw buffer body', () => {
  const payload = resolveRecipeDetailRequestPayload(Buffer.from(JSON.stringify(broadBeanDetailPayload), 'utf8'));

  assert.equal(payload.profileId, 'chat_context_profile');
  assert.equal(payload.ingredients[0]?.name, '蚕豆');
  assert.equal(payload.recipe?.id, '1');
  assert.equal(payload.recipe?.name, '清煮鲜蚕豆');
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
