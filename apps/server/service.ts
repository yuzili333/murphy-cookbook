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

  if (!profileInput?.nickname || !profileInput?.age) {
    return null;
  }

  const resolvedProfileId = String(profileInput.id ?? normalizedProfileId).trim() || `profile_snapshot_${Date.now()}`;

  return {
    id: resolvedProfileId,
    nickname: String(profileInput.nickname),
    age: Number(profileInput.age),
    tastePreferences: Array.isArray(profileInput.tastePreferences) ? profileInput.tastePreferences : [],
    allergens: Array.isArray(profileInput.allergens) ? profileInput.allergens : [],
    dietaryHabits: Array.isArray(profileInput.dietaryHabits) ? profileInput.dietaryHabits : [],
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
      error: { code: 'PROFILE_NOT_FOUND', message: '推荐前需要先选择儿童档案。' },
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
          title: '准备食材',
          description: '把食材洗净，摆放整齐，先让家长确认需要切开的部分。',
          tip: '先准备好小碗和勺子，再开始动手。',
          riskLevel: 'low',
          requiresParentAssist: false,
        },
        {
          id: `step_${input.recipe.id}_2`,
          title: '开始烹饪',
          description: '按照推荐菜名完成主要烹饪步骤，涉及明火和热锅时请家长全程陪同。',
          tip: '每完成一步都停下来检查一下安全和口味。',
          riskLevel: 'high',
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

    return { data: fallbackRecipe };
  }

  try {
    return {
      data: await generateRecipeDetail(profile, input.ingredients, input.recipe),
    };
  } catch (error) {
    if (!shouldRequireRealModel()) {
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
