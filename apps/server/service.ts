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

const recipeDetailCacheFile = process.env.RECIPE_DETAIL_CACHE_FILE
  ? resolve(process.env.RECIPE_DETAIL_CACHE_FILE)
  : process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? '/tmp/murphy-cookbook-recipe-detail-cache.json'
    : resolve(process.cwd(), '.local', 'cache', 'recipe-detail-cache.json');
const recipeDetailCacheTtlMs = 3 * 24 * 60 * 60 * 1000;
const recipeDetailCacheVersion = 'storyboard-balanced-steps-v6';
const recipeDetailModelTimeoutMs = Number(process.env.RECIPE_DETAIL_MODEL_TIMEOUT_MS ?? 9000);
const recipeDetailMemoryCache = new Map<string, RecipeDetailCacheEntry>();
const pendingRecipeDetailRequests = new Map<string, Promise<{ data: RecipeDetail } | { error: RecommendationError }>>();
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
    ingredients: string[];
    recipeId?: string;
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
  const normalizedNames = ingredients
    .map((ingredient) => normalizeIngredientName(ingredient.normalizedName ?? ingredient.name))
    .filter(Boolean);

  return Array.from(new Set(normalizedNames)).sort();
}

function buildRecipeDetailCacheKey(input: {
  profile: ChildProfile;
  ingredients: IngredientItem[];
  recipeId?: string;
  recipeName: string;
}) {
  const payload = {
    version: recipeDetailCacheVersion,
    profile: {
      id: input.profile.id,
      age: input.profile.age,
      tastePreferences: [...input.profile.tastePreferences].sort(),
      allergens: [...input.profile.allergens].sort(),
      dietaryHabits: [...input.profile.dietaryHabits].sort(),
    },
    ingredients: normalizeIngredientsForCache(input.ingredients),
    recipeId: input.recipeId?.trim() || '',
    recipeName: input.recipeName.trim(),
  };

  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function readRecipeDetailCache() {
  const memoryEntries = Array.from(recipeDetailMemoryCache.values());
  if (!existsSync(recipeDetailCacheFile)) {
    return memoryEntries;
  }

  try {
    const parsed = JSON.parse(readFileSync(recipeDetailCacheFile, 'utf8')) as unknown;
    const fileEntries = Array.isArray(parsed) ? parsed as RecipeDetailCacheEntry[] : [];
    for (const entry of fileEntries) {
      recipeDetailMemoryCache.set(entry.key, entry);
    }
    return Array.from(new Map([...memoryEntries, ...fileEntries].map((entry) => [entry.key, entry])).values());
  } catch {
    return memoryEntries;
  }
}

function getCachedRecipeDetail(key: string) {
  const now = Date.now();
  const memoryEntry = recipeDetailMemoryCache.get(key);
  if (memoryEntry && Date.parse(memoryEntry.expiresAt) > now) {
    return memoryEntry.response;
  }

  const entry = readRecipeDetailCache().find((item) => item.key === key);

  if (!entry || Date.parse(entry.expiresAt) <= now) {
    recipeDetailMemoryCache.delete(key);
    return null;
  }

  recipeDetailMemoryCache.set(key, entry);
  return entry.response;
}

function writeRecipeDetailCache(entry: RecipeDetailCacheEntry) {
  recipeDetailMemoryCache.set(entry.key, entry);

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timeoutId));
  });
}

function toRecipeDetailCacheEntry(input: {
  key: string;
  profile: ChildProfile;
  ingredients: IngredientItem[];
  recipeId?: string;
  recipeName: string;
  response: RecipeDetail;
}): RecipeDetailCacheEntry {
  return {
    key: input.key,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + recipeDetailCacheTtlMs).toISOString(),
    request: {
      profile: input.profile,
      ingredients: normalizeIngredientsForCache(input.ingredients),
      recipeId: input.recipeId,
      recipeName: input.recipeName,
    },
    response: input.response,
  };
}

function isRecipeDetailPayload(recipe: RecipeRecommendation): recipe is RecipeDetail {
  const candidate = recipe as Partial<RecipeDetail>;
  return (
    Array.isArray(candidate.ingredients) &&
    candidate.ingredients.length > 0 &&
    Array.isArray(candidate.steps) &&
    candidate.steps.length > 0 &&
    Number.isFinite(Number(candidate.prepTimeMinutes)) &&
    Number.isFinite(Number(candidate.cookTimeMinutes))
  );
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
    recipeId: input.recipe.id,
    recipeName: input.recipe.name,
  });
  const cachedRecipe = getCachedRecipeDetail(cacheKey);

  if (cachedRecipe) {
    return { data: cachedRecipe };
  }

  const pendingRequest = pendingRecipeDetailRequests.get(cacheKey);
  if (pendingRequest) {
    return pendingRequest;
  }

  const requestPromise = generateRecipeDetailWithCache({
    cacheKey,
    profile,
    input,
  }).finally(() => {
    pendingRecipeDetailRequests.delete(cacheKey);
  });

  pendingRecipeDetailRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

async function generateRecipeDetailWithCache(input: {
  cacheKey: string;
  profile: ChildProfile;
  input: {
    profileId: string;
    ingredients: IngredientItem[];
    recipe: RecipeRecommendation;
    profileInput?: Partial<ChildProfile> | null;
  };
}): Promise<{ data: RecipeDetail } | { error: RecommendationError }> {
  const { cacheKey, profile } = input;
  const detailInput = input.input;

  const fallbackRecipe =
    recipeCatalog.find((item) => item.id === detailInput.recipe.id) ??
    ({
      ...detailInput.recipe,
      prepTimeMinutes: Math.max(1, Math.round(detailInput.recipe.estimatedTimeMinutes * 0.3)),
      cookTimeMinutes: Math.max(1, detailInput.recipe.estimatedTimeMinutes - Math.max(1, Math.round(detailInput.recipe.estimatedTimeMinutes * 0.3))),
      ingredients: detailInput.ingredients.map((ingredient) => ({
        name: ingredient.name,
        quantity: ingredient.quantity,
        imageUrl: buildIngredientImageUrl(ingredient.name),
      })),
      steps: [
        {
          id: `step_${detailInput.recipe.id}_1`,
          title: '摆好食材',
          description: '全部食材和小碗摆好。',
          tip: '先点一遍食材。',
          childAction: '说出食材名字。',
          parentAction: '家长检查新鲜度。',
          expectedResult: '食材清楚可见。',
          riskLevel: 'low',
          requiresParentAssist: false,
        },
        {
          id: `step_${detailInput.recipe.id}_2`,
          title: '清洗食材',
          description: '蔬菜食材清水洗净。',
          tip: '水流不要太大。',
          childAction: '轻轻搓洗表面。',
          parentAction: '家长处理去皮去根。',
          expectedResult: '表面没有泥沙。',
          riskLevel: 'low',
          requiresParentAssist: false,
        },
        {
          id: `step_${detailInput.recipe.id}_3`,
          title: '切配分装',
          description: '蔬菜肉蛋切配分碗。',
          tip: '刀具只让家长拿。',
          childAction: '把食材放小碗。',
          parentAction: '家长切配并收刀。',
          expectedResult: '食材大小接近。',
          riskLevel: 'medium',
          requiresParentAssist: true,
        },
        {
          id: `step_${detailInput.recipe.id}_4`,
          title: '加热烹饪',
          description: '主食材入锅加热。',
          tip: '热锅热油要远离。',
          childAction: '观察颜色变化。',
          parentAction: '家长全程操作热源。',
          expectedResult: '食材变软变香。',
          riskLevel: 'high',
          requiresParentAssist: true,
        },
        {
          id: `step_${detailInput.recipe.id}_5`,
          title: '装盘和确认',
          description: '装盘放凉再试吃。',
          tip: '太烫就再等等。',
          childAction: '摆餐具小口尝。',
          parentAction: '家长确认温度安全。',
          expectedResult: '温热不烫口。',
          riskLevel: 'low',
          requiresParentAssist: true,
        },
      ],
    } satisfies RecipeDetail);

  const persistDetail = (response: RecipeDetail) => {
    writeRecipeDetailCache(toRecipeDetailCacheEntry({
      key: cacheKey,
      profile,
      ingredients: detailInput.ingredients,
      recipeId: detailInput.recipe.id,
      recipeName: detailInput.recipe.name,
      response,
    }));
  };

  if (isRecipeDetailPayload(detailInput.recipe)) {
    persistDetail(detailInput.recipe);
    return { data: detailInput.recipe };
  }

  if (!isSiliconFlowConfigured()) {
    if (shouldRequireRealModel()) {
      return {
        error: {
          code: 'MODEL_PROVIDER_NOT_CONFIGURED',
          message: '服务端未配置 SiliconFlow API Key，无法生成生产环境菜谱详情。',
        },
      };
    }

    persistDetail(fallbackRecipe);
    return { data: fallbackRecipe };
  }

  try {
    const recipeDetail = await withTimeout(
      generateRecipeDetail(profile, detailInput.ingredients, detailInput.recipe),
      recipeDetailModelTimeoutMs,
      '菜谱详情生成超时，已返回快速生成版本。',
    );
    persistDetail(recipeDetail);

    return {
      data: recipeDetail,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes('超时');

    if (isTimeout || isSiliconFlowConfigured() || !shouldRequireRealModel()) {
      persistDetail(fallbackRecipe);
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
