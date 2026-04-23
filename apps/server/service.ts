import {
  childProfiles,
  createIngredient,
  normalizeIngredientName,
  recipeCatalog,
  summarizeRecipe,
  type IngredientItem,
} from './data.js';

export function parseTextToIngredients(text: string) {
  const parts = text
    .split(/[，,、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return parts.map((part) =>
    createIngredient(part.replace(/^(两个|一个|半根|半个|一根|一份)/, ''), 'manual'),
  );
}

export function recommendRecipes(profileId: string, ingredients: IngredientItem[]) {
  const profile = childProfiles.find((item) => item.id === profileId);
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
      filteredAllergens: profile.allergens,
      sortBy: 'balanced',
    },
  };
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
