import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildIngredientImageUrl,
  childProfiles,
  createIngredient,
  normalizeIngredientName,
  recipeCatalog,
  summarizeRecipe,
  type RecipeRecommendation,
  type ChildProfile,
  type IngredientItem,
  type RecipeDetail,
} from './data.js';
import {
  generateRecipeDetail,
  generateRecipePlan,
  isSiliconFlowConfigured,
  shouldRequireRealModel,
  type GeneratedRecommendationPayload,
} from './siliconflow.js';

export interface RecommendationError {
  code: string;
  message: string;
}

export type RecommendationResult =
  | { data: GeneratedRecommendationPayload }
  | { error: RecommendationError };

const recipeDetailCacheFile = resolve(process.cwd(), '.local', 'cache', 'recipe-detail-cache.json');
const recipeDetailCacheTtlMs = 3 * 24 * 60 * 60 * 1000;
const recipeDetailCacheVersion = 'child-full-steps-v2';
const defaultRecommendationProfile: ChildProfile = {
  id: 'chat_context_profile',
  nickname: '小学阶段学生',
  age: 8,
  tastePreferences: ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
  allergens: [],
  dietaryHabits: ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
};

interface RecipeDetailCacheEntry {
  key: string;
  createdAt: string;
  expiresAt: string;
  request: {
    profile: ChildProfile;
    ingredients: Array<{
      name: string;
      normalizedName: string;
      quantity: string;
      source: IngredientItem['source'];
    }>;
    recipeName: string;
  };
  response: RecipeDetail;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeIngredientsForCache(ingredients: IngredientItem[]) {
  return ingredients
    .map((ingredient) => ({
      name: ingredient.name.trim(),
      normalizedName: normalizeIngredientName(ingredient.normalizedName ?? ingredient.name),
      quantity: String(ingredient.quantity ?? '').trim() || '1份',
      source: ingredient.source,
    }))
    .sort((left, right) =>
      `${left.normalizedName}|${left.quantity}|${left.source}`.localeCompare(
        `${right.normalizedName}|${right.quantity}|${right.source}`,
      ),
    );
}

function buildRecipeDetailCacheKey(input: {
  profile: ChildProfile;
  ingredients: IngredientItem[];
  recipeName: string;
}) {
  const payload = {
    version: recipeDetailCacheVersion,
    profile: {
      id: input.profile.id,
      nickname: input.profile.nickname,
      age: input.profile.age,
      tastePreferences: [...input.profile.tastePreferences].sort(),
      allergens: [...input.profile.allergens].sort(),
      dietaryHabits: [...input.profile.dietaryHabits].sort(),
    },
    ingredients: normalizeIngredientsForCache(input.ingredients),
    recipeName: input.recipeName.trim(),
  };

  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function readRecipeDetailCache() {
  if (!existsSync(recipeDetailCacheFile)) {
    return [] as RecipeDetailCacheEntry[];
  }

  try {
    const parsed = JSON.parse(readFileSync(recipeDetailCacheFile, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed as RecipeDetailCacheEntry[] : [];
  } catch {
    return [];
  }
}

function getCachedRecipeDetail(key: string) {
  const now = Date.now();
  const entry = readRecipeDetailCache().find((item) => item.key === key);

  if (!entry || Date.parse(entry.expiresAt) <= now) {
    return null;
  }

  return entry.response;
}

function writeRecipeDetailCache(entry: RecipeDetailCacheEntry) {
  try {
    mkdirSync(dirname(recipeDetailCacheFile), { recursive: true });
    const now = Date.now();
    const next = [
      entry,
      ...readRecipeDetailCache().filter((item) =>
        item.key !== entry.key && Date.parse(item.expiresAt) > now,
      ),
    ].slice(0, 200);
    writeFileSync(recipeDetailCacheFile, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // Cache failures must not affect API responses.
  }
}

export function parseTextToIngredients(text: string) {
  const parts = text
    .split(/[，,、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return parts.map((part) =>
    createIngredient(part.replace(/^(两个|一个|半根|半个|一根|一份)/, ''), 'manual'),
  );
}

export function resolveProfile(profileId: string, profileInput?: Partial<ChildProfile> | null) {
  const normalizedProfileId = profileId.trim();
  const matchedProfile = childProfiles.find((item) => item.id === normalizedProfileId);

  if (matchedProfile) {
    return matchedProfile;
  }

  const resolvedProfileId = String(profileInput?.id ?? normalizedProfileId).trim() || defaultRecommendationProfile.id;

  return {
    id: resolvedProfileId || defaultRecommendationProfile.id,
    nickname: profileInput?.nickname ? String(profileInput.nickname) : defaultRecommendationProfile.nickname,
    age: Number.isFinite(Number(profileInput?.age)) && Number(profileInput?.age) > 0
      ? Number(profileInput?.age)
      : defaultRecommendationProfile.age,
    tastePreferences: Array.isArray(profileInput?.tastePreferences) && profileInput.tastePreferences.length > 0
      ? profileInput.tastePreferences
      : defaultRecommendationProfile.tastePreferences,
    allergens: Array.isArray(profileInput?.allergens) ? profileInput.allergens : defaultRecommendationProfile.allergens,
    dietaryHabits: Array.isArray(profileInput?.dietaryHabits) && profileInput.dietaryHabits.length > 0
      ? profileInput.dietaryHabits
      : defaultRecommendationProfile.dietaryHabits,
  } satisfies ChildProfile;
}

function validateRecommendationInput(
  profileId: string,
  ingredients: IngredientItem[],
  profileInput?: Partial<ChildProfile> | null,
): { profile: ChildProfile } | { error: RecommendationError } {
  const profile = resolveProfile(profileId, profileInput);
  if (!profile) {
    return {
      error: { code: 'PROFILE_NOT_FOUND', message: '无法生成默认儿童推荐档案。' },
    };
  }

  if (ingredients.length === 0) {
    return {
      error: { code: 'INVALID_ARGUMENT', message: '至少需要一个食材才能开始推荐。' },
    };
  }

  return { profile };
}

export function getMockRecipeRecommendations(profile: ChildProfile, ingredients: IngredientItem[]): RecommendationResult {

  const normalizedInputs = new Set(
    ingredients.map((item) => normalizeIngredientName(item.normalizedName ?? item.name)),
  );

  const recipes = recipeCatalog
    .map((recipe) => {
      const matchedCount = recipe.ingredients.filter((ingredient) =>
        normalizedInputs.has(normalizeIngredientName(ingredient.name)),
      ).length;
      const canCookWithCurrentIngredients = matchedCount >= Math.max(1, recipe.ingredients.length - 1);

      return {
        recipe,
        matchedCount,
        canCookWithCurrentIngredients,
      };
    })
    .filter((entry) => entry.matchedCount > 0)
    .sort((left, right) => right.matchedCount - left.matchedCount)
    .slice(0, 5)
    .map((entry) => ({
      ...summarizeRecipe(entry.recipe),
      canCookWithCurrentIngredients: entry.canCookWithCurrentIngredients,
      extraIngredients: entry.recipe.ingredients
        .filter((ingredient) => !normalizedInputs.has(normalizeIngredientName(ingredient.name)))
        .map((ingredient) => ingredient.name),
    }));

  if (recipes.length === 0) {
    return {
      error: { code: 'NO_RECIPE_MATCHED', message: '没有找到合适菜谱，请补充一些常见主食或蔬菜。' },
    };
  }

  return {
    data: {
      recipes,
      recipeDetails: recipes
        .map((recipe) => recipeCatalog.find((item) => item.id === recipe.id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
      filteredAllergens: profile.allergens,
      sortBy: 'balanced',
    },
  };
}

export async function recommendRecipes(
  profileId: string,
  ingredients: IngredientItem[],
  profileInput?: Partial<ChildProfile> | null,
  userPrompt = '',
): Promise<RecommendationResult> {
  const validation = validateRecommendationInput(profileId, ingredients, profileInput);

  if ('error' in validation) {
    return { error: validation.error };
  }

  const { profile } = validation;
  const fallbackResult = getMockRecipeRecommendations(profile, ingredients);

  if (!isSiliconFlowConfigured()) {
    if (shouldRequireRealModel()) {
      return {
        error: {
          code: 'MODEL_PROVIDER_NOT_CONFIGURED',
          message: '服务端未配置 SiliconFlow API Key，无法生成生产环境菜谱推荐。',
        },
      };
    }

    return fallbackResult;
  }

  try {
    return {
      data: await generateRecipePlan(profile, ingredients, userPrompt),
    };
  } catch (error) {
    if (!shouldRequireRealModel()) {
      return fallbackResult;
    }

    return {
      error: {
        code: 'RECIPE_RECOMMENDATION_FAILED',
        message: error instanceof Error ? error.message : '菜谱推荐生成失败。',
      },
    };
  }
}

export async function getRecipeDetailForRecommendation(input: {
  profileId: string;
  ingredients: IngredientItem[];
  recipe: RecipeRecommendation;
  profileInput?: Partial<ChildProfile> | null;
}): Promise<{ data: RecipeDetail } | { error: RecommendationError }> {
  const validation = validateRecommendationInput(input.profileId, input.ingredients, input.profileInput);

  if ('error' in validation) {
    return { error: validation.error };
  }

  const { profile } = validation;
  const cacheKey = buildRecipeDetailCacheKey({
    profile,
    ingredients: input.ingredients,
    recipeName: input.recipe.name,
  });
  const cachedRecipe = getCachedRecipeDetail(cacheKey);

  if (cachedRecipe) {
    return { data: cachedRecipe };
  }

  const fallbackRecipe =
    recipeCatalog.find((item) => item.id === input.recipe.id) ??
    ({
      ...input.recipe,
      prepTimeMinutes: Math.max(1, Math.round(input.recipe.estimatedTimeMinutes * 0.3)),
      cookTimeMinutes: Math.max(1, input.recipe.estimatedTimeMinutes - Math.max(1, Math.round(input.recipe.estimatedTimeMinutes * 0.3))),
      ingredients: input.ingredients.map((ingredient) => ({
        name: ingredient.name,
        quantity: ingredient.quantity,
        imageUrl: buildIngredientImageUrl(ingredient.name),
      })),
      steps: [
        {
          id: `step_${input.recipe.id}_1`,
          title: '摆好食材和工具',
          description: '把所有食材放到桌面上，准备一个小碗、一把勺子和一块干净的案板。',
          tip: '先点一遍食材名字，确认没有漏掉。',
          childAction: '把食材排成一排，告诉家长你看到了哪些食材。',
          parentAction: '家长检查食材是否新鲜，并确认工具摆放安全。',
          expectedResult: '桌面整齐，食材和工具都能一眼看到。',
          riskLevel: 'low',
          requiresParentAssist: false,
        },
        {
          id: `step_${input.recipe.id}_2`,
          title: '清洗食材',
          description: '把蔬菜或可清洗食材放进盆里，用流动清水轻轻冲洗。',
          tip: '不要把水开太大，避免溅到衣服上。',
          childAction: '用手轻轻搓一搓表面，再把水倒掉。',
          parentAction: '家长帮忙处理需要削皮或去根的部分。',
          expectedResult: '食材表面干净，没有明显泥沙。',
          riskLevel: 'low',
          requiresParentAssist: false,
        },
        {
          id: `step_${input.recipe.id}_3`,
          title: '切配或分装',
          description: '需要切开的食材由家长处理，孩子负责把切好的食材放进小碗。',
          tip: '刀具只让家长拿，孩子不要抢着切。',
          childAction: '把切好的食材按颜色或种类放进不同小碗。',
          parentAction: '家长使用刀具完成切配，并把刀具放回安全位置。',
          expectedResult: '每种食材都分装好了，大小比较接近。',
          riskLevel: 'medium',
          requiresParentAssist: true,
        },
        {
          id: `step_${input.recipe.id}_4`,
          title: '家长加热烹饪',
          description: '如果这道菜需要加热，请由家长打开明火、电磁炉、微波炉或烤箱，孩子站在安全距离外观察。',
          tip: '看到热锅、热水、热油时，要离远一点。',
          childAction: '站在家长旁边一臂远的位置，说出你观察到的颜色和气味变化。',
          parentAction: '家长全程操作加热设备，并提醒孩子不要触碰锅具和电器。',
          expectedResult: '食材逐渐变软、变香或颜色变深。',
          riskLevel: 'high',
          requiresParentAssist: true,
        },
        {
          id: `step_${input.recipe.id}_5`,
          title: '装盘和确认',
          description: '关火或停止加热后，家长把食物盛到盘子里，稍微放凉再试吃。',
          tip: '先闻一闻，再小口尝，太烫就继续等。',
          childAction: '帮忙摆好餐具，小口尝一尝味道。',
          parentAction: '家长确认温度合适，没有骨刺或硬块后再让孩子食用。',
          expectedResult: '菜品温热不烫，味道清淡，适合入口。',
          riskLevel: 'low',
          requiresParentAssist: true,
        },
      ],
    } satisfies RecipeDetail);

  if (!isSiliconFlowConfigured()) {
    if (shouldRequireRealModel()) {
      return {
        error: {
          code: 'MODEL_PROVIDER_NOT_CONFIGURED',
          message: '服务端未配置 SiliconFlow API Key，无法生成生产环境菜谱详情。',
        },
      };
    }

    writeRecipeDetailCache({
      key: cacheKey,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + recipeDetailCacheTtlMs).toISOString(),
      request: {
        profile,
        ingredients: normalizeIngredientsForCache(input.ingredients),
        recipeName: input.recipe.name,
      },
      response: fallbackRecipe,
    });
    return { data: fallbackRecipe };
  }

  try {
    const recipeDetail = await generateRecipeDetail(profile, input.ingredients, input.recipe);
    writeRecipeDetailCache({
      key: cacheKey,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + recipeDetailCacheTtlMs).toISOString(),
      request: {
        profile,
        ingredients: normalizeIngredientsForCache(input.ingredients),
        recipeName: input.recipe.name,
      },
      response: recipeDetail,
    });

    return {
      data: recipeDetail,
    };
  } catch (error) {
    if (!shouldRequireRealModel()) {
      writeRecipeDetailCache({
        key: cacheKey,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + recipeDetailCacheTtlMs).toISOString(),
        request: {
          profile,
          ingredients: normalizeIngredientsForCache(input.ingredients),
          recipeName: input.recipe.name,
        },
        response: fallbackRecipe,
      });
      return { data: fallbackRecipe };
    }

    return {
      error: {
        code: 'RECIPE_DETAIL_FAILED',
        message: error instanceof Error ? error.message : '菜谱详情生成失败。',
      },
    };
  }
}

const filenameIngredientMap = ['番茄', '鸡蛋', '黄瓜', '玉米', '面条', '土豆', '南瓜', '胡萝卜'];

export function extractIngredientsFromFilename(filename: string) {
  const lowered = filename.toLowerCase();
  const matches = filenameIngredientMap.filter((ingredient) => lowered.includes(ingredient.toLowerCase()));

  if (matches.length > 0) {
    return matches.map((ingredient) => createIngredient(ingredient, 'image'));
  }

  return [createIngredient('番茄', 'image'), createIngredient('鸡蛋', 'image')];
}

export function parseIngredientJson(content: string, source: IngredientItem['source']) {
  const parsed = JSON.parse(content) as {
    ingredients?: Array<{ name?: string; quantity?: string }>;
  };

  const items = parsed.ingredients ?? [];
  return items
    .filter((item) => item.name)
    .map((item) => createIngredient(item.name ?? '', source, item.quantity ?? '1份'));
}
