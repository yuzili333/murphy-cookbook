import {
  childProfiles,
  createIngredient,
  normalizeIngredientName,
  recipeCatalog,
  summarizeRecipe,
  type RecipeRecommendation,
  type RecipeDetailRecipeInput,
  type ChildProfile,
  type IngredientItem,
  type RecipeDetail,
} from './data.js';
import {
  generateRecipeDetail,
  generateRecipeDetails,
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

const recipeRecommendationModelTimeoutMs = Number(process.env.RECIPE_RECOMMENDATION_MODEL_TIMEOUT_MS ?? 120000);
const recipeDetailModelTimeoutMs = Number(process.env.RECIPE_DETAIL_MODEL_TIMEOUT_MS ?? 60000);
const defaultRecommendationProfile: ChildProfile = {
  id: 'chat_context_profile',
  nickname: '小学阶段学生',
  age: 8,
  tastePreferences: ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
  allergens: [],
  dietaryHabits: ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
};

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

function isRecipeDetailPayload(recipe: RecipeRecommendation | RecipeDetailRecipeInput | RecipeDetail): recipe is RecipeDetail {
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

function hasSameRecipeIdentity(actualName: string, targetName: string) {
  return normalizeIngredientName(actualName).replace(/\s+/g, '').toLowerCase() ===
    normalizeIngredientName(targetName).replace(/\s+/g, '').toLowerCase();
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

function validateDetailInput(
  profileId: string,
  profileInput?: Partial<ChildProfile> | null,
): { profile: ChildProfile } | { error: RecommendationError } {
  const profile = resolveProfile(profileId, profileInput);
  if (!profile) {
    return {
      error: { code: 'PROFILE_NOT_FOUND', message: '无法生成默认儿童推荐档案。' },
    };
  }

  return { profile };
}

function buildDetailIngredients(input: {
  ingredients: IngredientItem[];
  recipe: RecipeDetailRecipeInput | RecipeDetail;
}) {
  if (input.ingredients.length > 0) {
    return input.ingredients;
  }

  const fallbackNames = [
    input.recipe.name,
    ...(input.recipe.extraIngredients ?? []),
  ]
    .flatMap((item) => String(item).split(/[，,、\s]+/))
    .map((item) => item.replace(/\d+(\.\d+)?\s*(个|份|根|把|克|g|ml|毫升|平勺|勺)?/gi, '').trim())
    .filter(Boolean)
    .slice(0, 8);

  return fallbackNames.length > 0
    ? fallbackNames.map((name) => createIngredient(name, 'manual'))
    : [createIngredient(input.recipe.name, 'manual')];
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
      data: await withTimeout(
        generateRecipePlan(profile, ingredients, userPrompt),
        recipeRecommendationModelTimeoutMs,
        '菜谱推荐生成超时，请稍后重试。',
      ),
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
  recipe: RecipeDetailRecipeInput | RecipeDetail;
  profileInput?: Partial<ChildProfile> | null;
}): Promise<{ data: RecipeDetail } | { error: RecommendationError }> {
  const validation = validateDetailInput(input.profileId, input.profileInput);

  if ('error' in validation) {
    return { error: validation.error };
  }

  if (isRecipeDetailPayload(input.recipe)) {
    return { data: input.recipe };
  }

  const catalogRecipe = recipeCatalog.find((item) =>
    item.id === input.recipe.id && hasSameRecipeIdentity(item.name, input.recipe.name),
  );
  if (catalogRecipe) {
    return { data: catalogRecipe };
  }

  const { profile } = validation;
  const detailIngredients = buildDetailIngredients({
    ingredients: input.ingredients,
    recipe: input.recipe,
  });
  if (!isSiliconFlowConfigured()) {
    return {
      error: {
        code: 'MODEL_PROVIDER_NOT_CONFIGURED',
        message: '服务端未配置 SiliconFlow API Key，无法生成菜谱详情。',
      },
    };
  }

  try {
    return {
      data: await withTimeout(
        generateRecipeDetail(profile, detailIngredients, input.recipe),
        recipeDetailModelTimeoutMs,
        '菜谱详情生成超时，请稍后重试。',
      ),
    };
  } catch (error) {
    return {
      error: {
        code: 'RECIPE_DETAIL_FAILED',
        message: error instanceof Error ? error.message : '菜谱详情生成失败。',
      },
    };
  }
}

export async function getRecipeDetailsForRecommendations(input: {
  profileId: string;
  ingredients: IngredientItem[];
  recipes: Array<RecipeRecommendation | RecipeDetail>;
  profileInput?: Partial<ChildProfile> | null;
}): Promise<{ data: RecipeDetail[] } | { error: RecommendationError }> {
  const validation = validateRecommendationInput(input.profileId, input.ingredients, input.profileInput);

  if ('error' in validation) {
    return { error: validation.error };
  }

  const embeddedDetails = input.recipes.filter(isRecipeDetailPayload);
  const catalogDetails = input.recipes
    .filter((recipe) => !isRecipeDetailPayload(recipe))
    .map((recipe) => recipeCatalog.find((item) =>
      item.id === recipe.id && hasSameRecipeIdentity(item.name, recipe.name),
    ))
    .filter((recipe): recipe is RecipeDetail => Boolean(recipe));
  const existingDetailIds = new Set([...embeddedDetails, ...catalogDetails].map((recipe) => recipe.id));
  const missingRecipes = input.recipes
    .filter((recipe): recipe is RecipeRecommendation => !isRecipeDetailPayload(recipe))
    .filter((recipe) => !existingDetailIds.has(recipe.id));

  if (missingRecipes.length === 0) {
    return { data: [...embeddedDetails, ...catalogDetails] };
  }

  if (!isSiliconFlowConfigured()) {
    return {
      error: {
        code: 'MODEL_PROVIDER_NOT_CONFIGURED',
        message: '服务端未配置 SiliconFlow API Key，无法生成菜谱详情。',
      },
    };
  }

  try {
    const generatedDetails = await withTimeout(
      generateRecipeDetails(validation.profile, input.ingredients, missingRecipes),
      recipeDetailModelTimeoutMs,
      '菜谱详情生成超时，请稍后重试。',
    );
    return {
      data: [...embeddedDetails, ...catalogDetails, ...generatedDetails],
    };
  } catch (error) {
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
