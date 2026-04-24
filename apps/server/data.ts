export interface ChildProfile {
  id: string;
  nickname: string;
  age: number;
  tastePreferences: string[];
  allergens: string[];
  dietaryHabits: string[];
}

export interface IngredientItem {
  id: string;
  name: string;
  normalizedName?: string;
  quantity: string;
  source: 'image' | 'voice' | 'manual';
  confidence?: number | null;
}

export interface RecipeRecommendation {
  id: string;
  name: string;
  imageUrl?: string;
  ageRange: string;
  difficulty: 'easy' | 'medium' | 'hard';
  estimatedTimeMinutes: number;
  fitReasons: string[];
  riskAlerts: string[];
  nutritionSummary: string;
  extraIngredients: string[];
  canCookWithCurrentIngredients?: boolean;
}

export interface CookingStep {
  id: string;
  title: string;
  description: string;
  tip: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiresParentAssist: boolean;
}

export interface RecipeDetail extends RecipeRecommendation {
  prepTimeMinutes: number;
  cookTimeMinutes: number;
  ingredients: Array<{ name: string; quantity: string; imageUrl?: string }>;
  steps: CookingStep[];
}

const ingredientImageKeywords: Record<string, string> = {
  番茄: 'tomato',
  鸡蛋: 'egg',
  黄瓜: 'cucumber',
  玉米: 'corn',
  面条: 'noodles',
  土豆: 'potato',
  南瓜: 'pumpkin',
  胡萝卜: 'carrot',
  洋葱: 'onion',
  西兰花: 'broccoli',
  青菜: 'bok-choy',
  菠菜: 'spinach',
  香菇: 'shiitake',
  蘑菇: 'mushroom',
  生菜: 'lettuce',
  豆腐: 'tofu',
  米饭: 'rice',
};

const recipeImageKeywords: Record<string, string> = {
  番茄鸡蛋面: 'tomato-egg-noodles',
  黄瓜鸡蛋卷: 'cucumber-egg-roll',
};

const ingredientAliases: Record<string, string> = {
  西红柿: '番茄',
  番茄: '番茄',
  鸡蛋: '鸡蛋',
  黄瓜: '黄瓜',
  玉米: '玉米',
  面条: '面条',
  土豆: '土豆',
  面: '面条',
};

export const childProfiles: ChildProfile[] = [
  {
    id: 'cp_001',
    nickname: 'Murphy',
    age: 8,
    tastePreferences: ['清淡', '喜欢鸡蛋', '喜欢面食'],
    allergens: ['花生'],
    dietaryHabits: ['低盐', '不吃辣'],
  },
];

export const recipeCatalog: RecipeDetail[] = [
  {
    id: 'recipe_001',
    name: '番茄鸡蛋面',
    imageUrl: buildRecipeImageUrl('番茄鸡蛋面'),
    ageRange: '7-12 岁',
    difficulty: 'easy',
    estimatedTimeMinutes: 20,
    fitReasons: ['使用现有食材', '口味清淡', '适合 8 岁儿童参与'],
    riskAlerts: ['煮面和开火步骤需要家长陪同'],
    nutritionSummary: '含蛋白质和碳水，适合作为一餐主食。',
    extraIngredients: ['面条'],
    canCookWithCurrentIngredients: false,
    prepTimeMinutes: 5,
    cookTimeMinutes: 15,
    ingredients: [
      { name: '番茄', quantity: '1个', imageUrl: buildIngredientImageUrl('番茄') },
      { name: '鸡蛋', quantity: '2个', imageUrl: buildIngredientImageUrl('鸡蛋') },
      { name: '面条', quantity: '1份', imageUrl: buildIngredientImageUrl('面条') },
    ],
    steps: [
      {
        id: 'step_1',
        title: '准备食材',
        description: '把番茄洗干净，鸡蛋打进小碗里。',
        tip: '打鸡蛋时轻轻敲开外壳就好。',
        riskLevel: 'low',
        requiresParentAssist: false,
      },
      {
        id: 'step_2',
        title: '切番茄',
        description: '把番茄切成小块，方便煮软和入味。',
        tip: '切的时候慢一点，手指离刀远一点。',
        riskLevel: 'medium',
        requiresParentAssist: true,
      },
      {
        id: 'step_3',
        title: '炒香番茄和鸡蛋',
        description: '先把鸡蛋炒熟，再放入番茄翻炒出汁。',
        tip: '锅边会热，要站远一点。',
        riskLevel: 'high',
        requiresParentAssist: true,
      },
      {
        id: 'step_4',
        title: '煮面',
        description: '加入水后下面条，煮到软软的就可以了。',
        tip: '看到水沸腾时不要靠太近。',
        riskLevel: 'high',
        requiresParentAssist: true,
      },
      {
        id: 'step_5',
        title: '盛出享用',
        description: '把面装进碗里，稍微放凉一点再吃。',
        tip: '先闻一闻香味，再慢慢尝一口。',
        riskLevel: 'low',
        requiresParentAssist: false,
      },
    ],
  },
  {
    id: 'recipe_002',
    name: '黄瓜鸡蛋卷',
    imageUrl: buildRecipeImageUrl('黄瓜鸡蛋卷'),
    ageRange: '7-12 岁',
    difficulty: 'easy',
    estimatedTimeMinutes: 15,
    fitReasons: ['步骤短', '口味清爽', '孩子容易参与摆盘'],
    riskAlerts: ['平底锅加热时需要家长陪同'],
    nutritionSummary: '含优质蛋白和新鲜蔬菜，适合作为轻食加餐。',
    extraIngredients: [],
    canCookWithCurrentIngredients: true,
    prepTimeMinutes: 5,
    cookTimeMinutes: 10,
    ingredients: [
      { name: '黄瓜', quantity: '1根', imageUrl: buildIngredientImageUrl('黄瓜') },
      { name: '鸡蛋', quantity: '2个', imageUrl: buildIngredientImageUrl('鸡蛋') },
    ],
    steps: [
      {
        id: 'step_1',
        title: '切黄瓜条',
        description: '把黄瓜切成细细的小条。',
        tip: '如果不好切，可以请家长帮忙。',
        riskLevel: 'medium',
        requiresParentAssist: true,
      },
      {
        id: 'step_2',
        title: '摊蛋皮',
        description: '把蛋液倒进锅里，做成薄薄的蛋皮。',
        tip: '锅热的时候不要碰锅边。',
        riskLevel: 'high',
        requiresParentAssist: true,
      },
      {
        id: 'step_3',
        title: '卷起来',
        description: '把黄瓜条放在蛋皮上，慢慢卷起来。',
        tip: '卷的时候轻一点，蛋皮就不容易破。',
        riskLevel: 'low',
        requiresParentAssist: false,
      },
    ],
  },
];

export function normalizeIngredientName(name: string) {
  return ingredientAliases[name.trim()] ?? name.trim();
}

export function buildIngredientImageUrl(name: string) {
  const normalized = normalizeIngredientName(name);
  const keyword = ingredientImageKeywords[normalized] ?? encodeURIComponent(normalized);
  return `https://loremflickr.com/320/240/${keyword}`;
}

export function buildRecipeImageUrl(name: string) {
  const keyword = recipeImageKeywords[name.trim()] ?? encodeURIComponent(name.trim());
  return `https://loremflickr.com/640/420/${keyword},food`;
}

export function normalizeChildFriendlyQuantity(quantity: string) {
  const normalized = quantity.trim();

  if (!normalized) {
    return '1平勺';
  }

  if (/(适量|少许|微量|一点点|少量)/.test(normalized)) {
    return '1平勺';
  }

  if (/半勺/.test(normalized)) {
    return '半平勺';
  }

  if (/一勺|1勺/.test(normalized)) {
    return '1平勺';
  }

  if (/两勺|2勺/.test(normalized)) {
    return '2平勺';
  }

  if (/三勺|3勺/.test(normalized)) {
    return '3平勺';
  }

  return normalized;
}

export function createIngredient(name: string, source: IngredientItem['source'], quantity = '1份'): IngredientItem {
  const normalizedName = normalizeIngredientName(name);

  return {
    id: `ing_${normalizedName}_${Math.random().toString(36).slice(2, 8)}`,
    name: normalizedName,
    normalizedName,
    quantity,
    source,
    confidence: source === 'manual' ? null : 0.92,
  };
}

export function summarizeRecipe(recipe: RecipeDetail): RecipeRecommendation {
  return {
    id: recipe.id,
    name: recipe.name,
    imageUrl: recipe.imageUrl,
    ageRange: recipe.ageRange,
    difficulty: recipe.difficulty,
    estimatedTimeMinutes: recipe.estimatedTimeMinutes,
    fitReasons: recipe.fitReasons,
    riskAlerts: recipe.riskAlerts,
    nutritionSummary: recipe.nutritionSummary,
    extraIngredients: recipe.extraIngredients,
    canCookWithCurrentIngredients: recipe.canCookWithCurrentIngredients,
  };
}
