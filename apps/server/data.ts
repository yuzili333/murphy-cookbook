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
  namePinyin?: string;
  imageUrl?: string;
  englishName: string;
  nameLearning: {
    characters: Array<{
      character: string;
      pinyin: string;
      strokes: number;
      structure: string;
      hint: string;
    }>;
  };
  ageRange: string;
  difficulty: 'easy' | 'medium' | 'hard';
  estimatedTimeMinutes: number;
  fitReasons: string[];
  riskAlerts: string[];
  nutritionSummary: string;
  extraIngredients: string[];
  canCookWithCurrentIngredients?: boolean;
}

export type RecipeDetailRecipeInput = Pick<RecipeRecommendation, 'id' | 'name'> &
  Partial<Omit<RecipeRecommendation, 'id' | 'name' | 'imageUrl' | 'nameLearning'>>;

export interface CookingStep {
  id: string;
  title: string;
  description: string;
  tip: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiresParentAssist: boolean;
  childAction?: string;
  parentAction?: string;
  expectedResult?: string;
}

export interface RecipeDetail extends RecipeRecommendation {
  prepTimeMinutes: number;
  cookTimeMinutes: number;
  ingredients: Array<{ name: string; quantity: string; imageUrl?: string }>;
  steps: CookingStep[];
}

const ingredientImageKeywords: Record<string, string> = {
  番茄: 'tomato',
  西红柿: 'tomato',
  圣女果: 'cherry tomato',
  鸡蛋: 'egg',
  鹌鹑蛋: 'quail egg',
  黄瓜: 'cucumber',
  玉米: 'corn',
  玉米粒: 'corn kernels',
  面条: 'noodles',
  挂面: 'dry noodles',
  乌冬面: 'udon noodles',
  土豆: 'potato',
  小土豆: 'baby potato',
  南瓜: 'pumpkin',
  贝贝南瓜: 'kabocha squash',
  胡萝卜: 'carrot',
  白萝卜: 'daikon radish',
  青萝卜: 'green radish',
  洋葱: 'onion',
  紫洋葱: 'red onion',
  大葱: 'leek',
  小葱: 'scallion',
  香葱: 'spring onion',
  韭菜: 'chives',
  韭黄: 'yellow chives',
  蒜苗: 'garlic shoots',
  大蒜: 'garlic',
  生姜: 'ginger',
  姜: 'ginger root',
  西兰花: 'broccoli',
  花椰菜: 'broccoli',
  花菜: 'cauliflower',
  白菜: 'napa cabbage',
  卷心菜: 'cabbage',
  紫甘蓝: 'red cabbage',
  生菜: 'lettuce',
  菠菜: 'spinach',
  油麦菜: 'romaine lettuce',
  上海青: 'bok choy',
  青菜: 'bok choy',
  小白菜: 'baby bok choy',
  空心菜: 'water spinach',
  茼蒿: 'garland chrysanthemum',
  芹菜: 'celery',
  西芹: 'celery stalk',
  香菜: 'cilantro',
  茴香: 'fennel leaves',
  莴笋: 'celtuce',
  苦瓜: 'bitter melon',
  丝瓜: 'luffa',
  冬瓜: 'winter melon',
  节瓜: 'fuzzy gourd',
  佛手瓜: 'chayote',
  黄豆芽: 'soybean sprouts',
  绿豆芽: 'mung bean sprouts',
  豆苗: 'pea shoots',
  荷兰豆: 'snow peas',
  豌豆: 'green peas',
  四季豆: 'green beans',
  豇豆: 'yardlong beans',
  扁豆: 'flat beans',
  毛豆: 'edamame',
  黄豆: 'soybeans',
  黑豆: 'black beans',
  红豆: 'red beans',
  绿豆: 'mung beans',
  芸豆: 'kidney beans',
  鹰嘴豆: 'chickpeas',
  蘑菇: 'mushroom',
  香菇: 'shiitake mushroom',
  平菇: 'oyster mushroom',
  金针菇: 'enoki mushroom',
  杏鲍菇: 'king oyster mushroom',
  口蘑: 'button mushroom',
  茶树菇: 'beech mushroom',
  海鲜菇: 'shimeji mushroom',
  茄子: 'eggplant',
  紫茄子: 'purple eggplant',
  青椒: 'green pepper',
  红椒: 'red pepper',
  黄椒: 'yellow pepper',
  彩椒: 'bell peppers',
  小米椒: 'bird eye chili',
  尖椒: 'long green chili',
  莲藕: 'lotus root',
  山药: 'yam',
  芋头: 'taro',
  红薯: 'sweet potato',
  紫薯: 'purple sweet potato',
  竹笋: 'bamboo shoots',
  春笋: 'spring bamboo shoots',
  秋葵: 'okra',
  菜花: 'cauliflower florets',
  木耳: 'wood ear mushroom',
  银耳: 'white fungus',
  海带: 'kelp',
  紫菜: 'nori seaweed',
  裙带菜: 'wakame',
  豆腐: 'tofu',
  北豆腐: 'firm tofu',
  南豆腐: 'soft tofu',
  内酯豆腐: 'silken tofu',
  豆腐皮: 'tofu skin',
  千张: 'bean curd sheets',
  豆干: 'dried tofu',
  腐竹: 'tofu sticks',
  豆泡: 'fried tofu puffs',
  豆腐丸子: 'tofu balls',
  米饭: 'rice',
  糙米: 'brown rice',
  小米: 'millet',
  燕麦: 'oats',
  面粉: 'flour',
  低筋面粉: 'cake flour',
  高筋面粉: 'bread flour',
  玉米淀粉: 'cornstarch',
  红薯淀粉: 'sweet potato starch',
  糯米粉: 'glutinous rice flour',
  饺子皮: 'dumpling wrappers',
  馄饨皮: 'wonton wrappers',
  面包: 'bread slices',
  吐司: 'toast bread',
  馒头: 'steamed buns',
  花卷: 'steamed rolls',
  包子: 'bao buns',
  年糕: 'rice cakes',
  米粉: 'rice noodles',
  河粉: 'rice sheets',
  粉丝: 'glass noodles',
  意面: 'spaghetti',
  螺丝面: 'fusilli pasta',
  通心粉: 'macaroni',
  苹果: 'apple',
  香蕉: 'banana',
  橙子: 'orange',
  柑橘: 'mandarin orange',
  柚子: 'pomelo',
  梨: 'pear',
  葡萄: 'grapes',
  草莓: 'strawberry',
  蓝莓: 'blueberries',
  树莓: 'raspberries',
  猕猴桃: 'kiwifruit',
  芒果: 'mango',
  菠萝: 'pineapple',
  西瓜: 'watermelon',
  哈密瓜: 'cantaloupe',
  木瓜: 'papaya',
  牛油果: 'avocado',
  柠檬: 'lemon',
  百香果: 'passion fruit',
  石榴: 'pomegranate',
  桃子: 'peach',
  油桃: 'nectarine',
  李子: 'plum',
  樱桃: 'cherries',
  荔枝: 'lychee',
  龙眼: 'longan',
  火龙果: 'dragon fruit',
  榴莲: 'durian',
  牛奶: 'milk',
  酸奶: 'yogurt',
  芝士: 'cheese',
  黄油: 'butter',
  淡奶油: 'whipping cream',
  虾仁: 'shrimp',
  三文鱼: 'salmon',
  鳕鱼: 'cod fillet',
  金枪鱼: 'tuna',
  鸡胸肉: 'chicken breast',
  鸡腿肉: 'chicken thigh',
  鸡翅: 'chicken wings',
  猪里脊: 'pork tenderloin',
  猪肉末: 'ground pork',
  牛肉末: 'ground beef',
  牛肉片: 'sliced beef',
  香肠: 'sausage',
  火腿: 'ham',
  培根: 'bacon',
  虾皮: 'dried shrimp',
  虾米: 'small dried shrimp',
  海苔: 'seaweed sheets',
  花生: 'peanuts',
  腰果: 'cashews',
  核桃: 'walnuts',
  杏仁: 'almonds',
  芝麻: 'sesame seeds',
  白芝麻: 'white sesame',
  黑芝麻: 'black sesame',
  葡萄干: 'raisins',
  红枣: 'red dates',
  枸杞: 'goji berries',
  蜂蜜: 'honey',
  白糖: 'sugar',
  红糖: 'brown sugar',
  冰糖: 'rock sugar',
  盐: 'salt',
  黑胡椒: 'black pepper',
  白胡椒: 'white pepper',
  生抽: 'light soy sauce',
  老抽: 'dark soy sauce',
  蚝油: 'oyster sauce',
  番茄酱: 'ketchup',
  沙拉酱: 'mayonnaise',
  橄榄油: 'olive oil',
  玉米油: 'corn oil',
  菜籽油: 'canola oil',
  花生酱: 'peanut butter',
  芝麻酱: 'sesame paste',
  咖喱块: 'curry cubes',
  椰浆: 'coconut milk',
  海盐: 'sea salt',
  奶粉: 'milk powder',
  泡打粉: 'baking powder',
  酵母: 'yeast',
};

const ingredientAliases: Record<string, string> = {
  西红柿: '番茄',
  番茄: '番茄',
  tomato: '番茄',
  鸡蛋: '鸡蛋',
  egg: '鸡蛋',
  黄瓜: '黄瓜',
  玉米: '玉米',
  corn: '玉米',
  面条: '面条',
  面: '面条',
  noodles: '面条',
  土豆: '土豆',
  potato: '土豆',
  西兰花: '西兰花',
  花椰菜: '西兰花',
  broccoli: '西兰花',
  香菇: '香菇',
  mushroom: '蘑菇',
};

const recipePaletteMap = [
  ['#fff5cc', '#ffc86b', '#ff8b6a'],
  ['#ffe2dd', '#ff9fa7', '#ff6f7f'],
  ['#e5f8d9', '#9ddc7a', '#5ab96d'],
  ['#dff5ff', '#88cfff', '#3e9bff'],
  ['#f7e5ff', '#d29cff', '#9b67d8'],
] as const;

const ingredientPaletteMap = [
  ['#fff4c4', '#ffd46c', '#ffaf3d'],
  ['#ffd8d2', '#ff9c8d', '#ff6f61'],
  ['#d8f5d1', '#8fd38a', '#55a868'],
  ['#d9efff', '#9ccfff', '#4a98ff'],
  ['#ece0ff', '#c3a6ff', '#8b6dd8'],
] as const;

function encodeSvg(svg: string) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function pickPalette(seed: string, palettes: readonly (readonly [string, string, string])[]) {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return palettes[hash % palettes.length];
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRecipeSceneLabel(name: string) {
  if (name.includes('面')) return '热乎乎的面碗';
  if (name.includes('饭')) return '香喷喷的饭盘';
  if (name.includes('卷')) return '卷卷小点心';
  if (name.includes('饼')) return '圆圆小饼';
  if (name.includes('汤')) return '暖暖一碗汤';
  if (name.includes('蒸')) return '软软蒸菜';
  return '儿童友好餐盘';
}

function buildRecipeIllustrationDataUrl(name: string, ingredientNames: string[] = []) {
  const [start, middle, end] = pickPalette(name, recipePaletteMap);
  const tokens = ingredientNames.slice(0, 3).map((item) => normalizeIngredientName(item));
  const labels = Array.from(new Set(tokens)).slice(0, 3);
  const badgeText = labels.length > 0 ? labels.join(' / ') : '适龄儿童菜谱';
  const sceneLabel = buildRecipeSceneLabel(name);
  const safeName = escapeHtml(name);
  const safeScene = escapeHtml(sceneLabel);
  const safeBadge = escapeHtml(badgeText);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${start}" />
          <stop offset="55%" stop-color="${middle}" />
          <stop offset="100%" stop-color="${end}" />
        </linearGradient>
      </defs>
      <rect width="640" height="420" rx="36" fill="url(#bg)" />
      <circle cx="112" cy="92" r="62" fill="rgba(255,255,255,0.28)" />
      <circle cx="548" cy="74" r="44" fill="rgba(255,255,255,0.22)" />
      <ellipse cx="320" cy="252" rx="170" ry="112" fill="#fff9f1" />
      <ellipse cx="320" cy="260" rx="146" ry="92" fill="rgba(255,255,255,0.96)" />
      <ellipse cx="320" cy="278" rx="110" ry="48" fill="rgba(0,0,0,0.08)" />
      <circle cx="266" cy="228" r="24" fill="#ff896f" />
      <circle cx="308" cy="214" r="22" fill="#ffd966" />
      <circle cx="354" cy="226" r="23" fill="#7dc86e" />
      <circle cx="392" cy="212" r="20" fill="#ffb55c" />
      <circle cx="283" cy="262" r="18" fill="#fbd17c" />
      <circle cx="344" cy="258" r="20" fill="#8ccc79" />
      <circle cx="381" cy="260" r="16" fill="#ffd28d" />
      <rect x="84" y="294" width="472" height="74" rx="24" fill="rgba(255,255,255,0.88)" />
      <text x="320" y="120" text-anchor="middle" font-size="40" font-weight="800" fill="#7a3652" font-family="Avenir Next, PingFang SC, sans-serif">${safeName}</text>
      <text x="320" y="151" text-anchor="middle" font-size="20" font-weight="600" fill="#8c5466" font-family="Avenir Next, PingFang SC, sans-serif">${safeScene}</text>
      <text x="320" y="335" text-anchor="middle" font-size="24" font-weight="700" fill="#5a5d77" font-family="Avenir Next, PingFang SC, sans-serif">${safeBadge}</text>
      <text x="320" y="361" text-anchor="middle" font-size="16" font-weight="600" fill="#77839f" font-family="Avenir Next, PingFang SC, sans-serif">AI 生成的儿童菜谱示意图</text>
    </svg>
  `;

  return encodeSvg(svg);
}

function buildIngredientPlaceholderDataUrl(name: string, known: boolean) {
  const [start, middle, end] = pickPalette(name, ingredientPaletteMap);
  const safeName = escapeHtml(name);
  const badge = known ? '常见配料' : '默认占位';
  const icon = known ? '🥕' : '🍽';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${start}" />
          <stop offset="55%" stop-color="${middle}" />
          <stop offset="100%" stop-color="${end}" />
        </linearGradient>
      </defs>
      <rect width="320" height="240" rx="28" fill="url(#bg)" />
      <circle cx="160" cy="92" r="54" fill="rgba(255,255,255,0.88)" />
      <text x="160" y="110" text-anchor="middle" font-size="42">${icon}</text>
      <rect x="36" y="164" width="248" height="42" rx="21" fill="rgba(255,255,255,0.9)" />
      <text x="160" y="191" text-anchor="middle" font-size="24" font-weight="800" fill="#5d5971" font-family="Avenir Next, PingFang SC, sans-serif">${escapeHtml(badge)}</text>
      <text x="160" y="223" text-anchor="middle" font-size="18" font-weight="700" fill="#ffffff" font-family="Avenir Next, PingFang SC, sans-serif">${safeName}</text>
    </svg>
  `;

  return encodeSvg(svg);
}

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

export function normalizeIngredientName(name: string) {
  return ingredientAliases[name.trim()] ?? name.trim();
}

export function hasPresetIngredientImage(name: string) {
  return Object.prototype.hasOwnProperty.call(ingredientImageKeywords, normalizeIngredientName(name));
}

export function buildIngredientImageUrl(name: string, visualQuery?: string) {
  const normalized = normalizeIngredientName(name);
  const known = hasPresetIngredientImage(normalized);

  if (!known) {
    return buildIngredientPlaceholderDataUrl(normalized, false);
  }

  return buildIngredientPlaceholderDataUrl(
    normalized,
    true,
  );
}

export function buildRecipeImageUrl(name: string, _visualQuery?: string, ingredientNames: string[] = []) {
  return buildRecipeIllustrationDataUrl(name, ingredientNames);
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

const curatedRecipeCatalog: RecipeDetail[] = [
  {
    id: 'recipe_001',
    name: '番茄鸡蛋面',
    namePinyin: 'fān qié jī dàn miàn',
    imageUrl: buildRecipeImageUrl('番茄鸡蛋面', undefined, ['番茄', '鸡蛋', '面条']),
    englishName: 'Tomato Egg Noodles',
    nameLearning: {
      characters: [
        { character: '番', pinyin: 'fān', strokes: 12, structure: '上下结构', hint: '上面像采字头，下面是田。' },
        { character: '茄', pinyin: 'qié', strokes: 8, structure: '上下结构', hint: '草字头表示它和植物有关。' },
        { character: '鸡', pinyin: 'jī', strokes: 7, structure: '左右结构', hint: '右边的鸟提示它和小鸟、家禽有关。' },
        { character: '蛋', pinyin: 'dàn', strokes: 11, structure: '上下结构', hint: '下面的虫是这个字的一部分。' },
        { character: '面', pinyin: 'miàn', strokes: 9, structure: '独体字', hint: '笔画包围成一个方方的面。' },
      ],
    },
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
    namePinyin: 'huáng guā jī dàn juǎn',
    imageUrl: buildRecipeImageUrl('黄瓜鸡蛋卷', undefined, ['黄瓜', '鸡蛋']),
    englishName: 'Cucumber Egg Roll',
    nameLearning: {
      characters: [
        { character: '黄', pinyin: 'huáng', strokes: 11, structure: '上中下结构', hint: '中间部分要写得稳，像一层层叠起来。' },
        { character: '瓜', pinyin: 'guā', strokes: 5, structure: '独体字', hint: '撇和捺像瓜藤伸出来。' },
        { character: '鸡', pinyin: 'jī', strokes: 7, structure: '左右结构', hint: '右边的鸟提示它和小鸟、家禽有关。' },
        { character: '蛋', pinyin: 'dàn', strokes: 11, structure: '上下结构', hint: '下面的虫是这个字的一部分。' },
        { character: '卷', pinyin: 'juǎn', strokes: 8, structure: '上下结构', hint: '下面像卷起来的小尾巴。' },
      ],
    },
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

type GeneratedRecipeKind = 'stir' | 'soup' | 'congee' | 'fruit' | 'milkshake' | 'smoothie' | 'juice' | 'salad';

interface GeneratedRecipeSeed {
  name: string;
  ingredients: string[];
  kind: GeneratedRecipeKind;
}

const vegetableSeeds = [
  '番茄', '土豆', '胡萝卜', '黄瓜', '西兰花', '菠菜', '白菜', '生菜', '南瓜', '冬瓜',
  '丝瓜', '玉米', '豌豆', '毛豆', '山药', '莲藕', '蘑菇', '香菇', '金针菇', '豆腐',
  '蒜苗', '青菜', '芹菜', '茄子', '彩椒', '秋葵', '莴笋', '小白菜', '黄豆芽', '绿豆芽',
];
const proteinSeeds = ['鸡蛋', '鸡胸肉', '牛肉', '虾仁', '鱼肉', '猪肉', '猪肝', '豆腐', '牛奶', '酸奶'];
const grainSeeds = ['小米', '大米', '燕麦', '面条', '米粉', '糙米', '玉米粒', '红薯', '南瓜', '山药'];
const fruitSeeds = [
  '苹果', '香蕉', '橙子', '梨', '葡萄', '草莓', '蓝莓', '猕猴桃', '芒果', '菠萝',
  '西瓜', '哈密瓜', '木瓜', '牛油果', '桃子', '石榴', '柠檬', '火龙果', '樱桃', '桑葚',
];

const recipeEnglishKeywordMap: Record<GeneratedRecipeKind, string> = {
  stir: 'Home Stir Fry',
  soup: 'Gentle Soup',
  congee: 'Soft Congee',
  fruit: 'Fruit Plate',
  milkshake: 'Milkshake',
  smoothie: 'Smoothie',
  juice: 'Fresh Juice',
  salad: 'Light Salad',
};

const recipeKindRisk: Record<GeneratedRecipeKind, string[]> = {
  stir: ['热锅和翻炒步骤需要家长陪同'],
  soup: ['煮汤和热水步骤需要家长陪同'],
  congee: ['煮粥和热锅步骤需要家长陪同'],
  fruit: [],
  milkshake: ['使用料理机时需要家长确认盖紧并陪同'],
  smoothie: ['使用料理机时需要家长确认盖紧并陪同'],
  juice: ['使用榨汁机时需要家长陪同'],
  salad: [],
};

const quantityByIngredient: Record<string, string> = {
  鸡蛋: '2个',
  牛奶: '200毫升',
  酸奶: '1杯',
  小米: '半碗',
  大米: '半碗',
  燕麦: '3平勺',
  面条: '1小把',
  米粉: '1小把',
  糙米: '半碗',
  猪肝: '80克',
  牛肉: '80克',
  鸡胸肉: '100克',
  虾仁: '80克',
  鱼肉: '100克',
  猪肉: '80克',
};

function getGeneratedQuantity(name: string) {
  if (quantityByIngredient[name]) return quantityByIngredient[name];
  if (fruitSeeds.includes(name)) return '1份';
  if (vegetableSeeds.includes(name)) return '1小碗';
  return '适量';
}

function buildGeneratedNameLearning(name: string): RecipeRecommendation['nameLearning'] {
  return {
    characters: Array.from(name).slice(0, 8).map((character) => ({
      character,
      pinyin: '',
      strokes: 0,
      structure: '常见汉字',
      hint: `在“${name}”里认一认“${character}”。`,
    })),
  };
}

function buildGeneratedRecipeSteps(kind: GeneratedRecipeKind, ingredients: string[], recipeName: string): CookingStep[] {
  const ingredientText = ingredients.join('、');
  if (kind === 'fruit' || kind === 'salad') {
    return [
      {
        id: 'step_1',
        title: '清洗食材',
        description: `本步骤食材：${ingredientText}；操作：把食材放在流动水下冲洗干净，轻轻搓掉表面杂质。洗好后沥干水分，先放在干净盘子里备用。`,
        tip: '小朋友可以负责冲洗和摆放。',
        riskLevel: 'low',
        requiresParentAssist: false,
        childAction: '清洗、擦干、摆盘。',
        parentAction: '在旁边确认食材洗净。',
        expectedResult: '食材干净清爽。',
      },
      {
        id: 'step_2',
        title: '切成小块',
        description: `本步骤食材：${ingredientText}；操作：把较大的食材切成方便入口的小块，尽量切得大小接近。切好后把软硬不同的食材分开放，后面摆盘更整齐。`,
        tip: '常规切菜可以在家长看护下参与，手指要离刀刃远一点。',
        riskLevel: 'low',
        requiresParentAssist: false,
        childAction: '在家长看护下切软水果或把小块食材分类。',
        parentAction: '在旁边看护并处理较硬食材。',
        expectedResult: '大小适合小朋友咀嚼。',
      },
      {
        id: 'step_3',
        title: '组合摆盘',
        description: `本步骤食材：${ingredientText}；操作：把不同颜色的食材交错摆放，先铺大块，再补小块。看一看颜色是否均匀，做成彩色小餐盘。`,
        tip: '颜色搭配越丰富，看起来越有食欲。',
        riskLevel: 'low',
        requiresParentAssist: false,
        childAction: '按颜色摆盘。',
        parentAction: '检查食材大小和摆盘稳定。',
        expectedResult: '食材颜色分布均匀。',
      },
      {
        id: 'step_4',
        title: '分装享用',
        description: `本步骤食材：${ingredientText}；操作：把摆好的食材分到小碗或小盘中，每份不要装太满。先确认大小适合入口，再准备品尝。`,
        tip: '先少量品尝，冰凉水果不要吃太快。',
        riskLevel: 'low',
        requiresParentAssist: false,
        childAction: '分装到自己的小碗里。',
        parentAction: '确认入口大小合适。',
        expectedResult: `完成${recipeName}`,
      },
    ];
  }

  if (kind === 'milkshake' || kind === 'smoothie' || kind === 'juice') {
    return [
      {
        id: 'step_1',
        title: '洗净处理',
        description: `本步骤食材：${ingredientText}；操作：把水果洗干净，去掉不能入口的硬核或外皮。较大的水果由家长切成小块，方便后面搅打。`,
        tip: '水果块越小，搅打越顺滑。',
        riskLevel: 'medium',
        requiresParentAssist: true,
        childAction: '清洗水果、把小块放入杯中。',
        parentAction: '切块或去核。',
        expectedResult: '食材适合放入料理机。',
      },
      {
        id: 'step_2',
        title: '加入杯中',
        description: `本步骤食材：${ingredientText}；操作：把水果块和少量水放进料理杯，先放软的，再放稍硬的。检查不要超过最高刻度，盖盖前把杯口擦干净。`,
        tip: '盖子盖紧后再启动。',
        riskLevel: 'low',
        requiresParentAssist: false,
        childAction: '倒入冷食材并检查刻度。',
        parentAction: '确认杯盖和刻度安全。',
        expectedResult: '料理杯装好食材。',
      },
      {
        id: 'step_3',
        title: '搅打顺滑',
        description: `本步骤食材：${ingredientText}；操作：家长确认盖子盖紧后启动料理机，先短时间搅打，再观察是否还有大块。继续打到颜色均匀、口感顺滑。`,
        tip: '机器工作时不要把手靠近刀头区域。',
        riskLevel: 'high',
        requiresParentAssist: true,
        childAction: '站在旁边观察变化。',
        parentAction: '启动和关闭料理机。',
        expectedResult: '饮品细腻顺滑。',
      },
      {
        id: 'step_4',
        title: '倒杯品尝',
        description: `本步骤食材：${ingredientText}；操作：把饮品倒入杯中，倒到七八分满即可。先少量品尝甜度和温度，觉得太稠可以再少量加水搅匀。`,
        tip: '冰饮不要一次喝太快。',
        riskLevel: 'low',
        requiresParentAssist: false,
        childAction: '选择杯子并贴上小标签。',
        parentAction: '确认饮品温度和杯口安全。',
        expectedResult: `完成${recipeName}`,
      },
    ];
  }

  if (kind === 'congee' || kind === 'soup') {
    return [
      {
        id: 'step_1',
        title: '清洗准备',
        description: `本步骤食材：${ingredientText}；操作：把食材洗净，谷物提前淘洗到水变清。蔬菜切成小块，较硬的食材切得更小，方便煮软。`,
        tip: '小朋友可以淘洗冷水里的谷物。',
        riskLevel: 'medium',
        requiresParentAssist: true,
        childAction: '淘洗、分类、递冷食材。',
        parentAction: '切块。',
        expectedResult: '食材处理成适合煮软的大小。',
      },
      {
        id: 'step_2',
        title: '加水入锅',
        description: `本步骤食材：${ingredientText}；操作：把食材和清水放入锅中，先放需要久煮的食材。水量没过食材后，再轻轻晃动锅身让食材铺开。`,
        tip: '冷锅时小朋友可以参与放食材。',
        riskLevel: 'low',
        requiresParentAssist: false,
        childAction: '把冷食材放入锅中。',
        parentAction: '确认锅具放稳、水量合适。',
        expectedResult: '锅里食材和水量合适。',
      },
      {
        id: 'step_3',
        title: '煮到软糯',
        description: `本步骤食材：${ingredientText}；操作：家长开火加热，沸腾后转小火慢煮。中途轻轻搅动防粘锅，看到食材变软、汤汁变浓就接近完成。`,
        tip: '热气明显时要离锅远一点。',
        riskLevel: 'high',
        requiresParentAssist: true,
        childAction: '观察颜色和形状变化。',
        parentAction: '开火、搅拌和关火。',
        expectedResult: kind === 'congee' ? '粥变得软糯浓稠。' : '汤味清淡鲜甜。',
      },
      {
        id: 'step_4',
        title: '放温享用',
        description: `本步骤食材：${ingredientText}；操作：盛出后先放到温热，用勺子轻轻搅一搅帮助散热。入口前小口试温，再慢慢品尝。`,
        tip: '入口前先吹一吹。',
        riskLevel: 'low',
        requiresParentAssist: false,
        childAction: '摆勺子和餐垫。',
        parentAction: '确认已经放到适口温度。',
        expectedResult: `完成${recipeName}`,
      },
    ];
  }

  return [
    {
      id: 'step_1',
      title: '处理食材',
      description: `本步骤食材：${ingredientText}；操作：把食材洗净，切成薄片或小段，鸡蛋类先打散。切好的食材按易熟和不易熟分开放，方便下锅时有顺序。`,
      tip: '切菜由家长完成，小朋友可以洗菜和分装。',
      riskLevel: 'medium',
      requiresParentAssist: false,
      childAction: '洗菜、打蛋、递冷食材。',
      parentAction: '在旁边看护切配动作。',
      expectedResult: '食材大小均匀。',
    },
    {
      id: 'step_2',
      title: '下锅加热',
      description: `本步骤食材：${ingredientText}；操作：家长热锅后放入食材，先放不易熟的，再放易熟的。每次加入后先摊开，再翻动，让食材受热更均匀。`,
      tip: '热锅时小朋友站在安全距离外。',
      riskLevel: 'high',
      requiresParentAssist: true,
      childAction: '观察食材颜色变化。',
      parentAction: '开火、下锅、翻炒。',
      expectedResult: '食材开始变软出香味。',
    },
    {
      id: 'step_3',
      title: '翻拌成熟',
      description: `本步骤食材：${ingredientText}；操作：沿锅边加入少量清水，继续翻拌到食材熟透。看到颜色变亮、质地变软，说明已经接近完成。`,
      tip: '不额外添加未列出的调味料，保持食材本味。',
      riskLevel: 'high',
      requiresParentAssist: true,
      childAction: '帮忙准备餐盘。',
      parentAction: '翻拌、确认熟透并关火。',
      expectedResult: '菜品熟透且味道清淡。',
    },
    {
      id: 'step_4',
      title: '装盘',
      description: `本步骤食材：${ingredientText}；操作：关火后装盘，把容易滑落的小块放在盘子中间。稍微放凉后再吃，入口前先确认不烫。`,
      tip: '热菜刚出锅不要急着入口。',
      riskLevel: 'low',
      requiresParentAssist: false,
      childAction: '摆餐具和装饰餐盘。',
      parentAction: '确认餐盘不烫手。',
      expectedResult: `完成${recipeName}`,
    },
  ];
}

function buildGeneratedRecipe(seed: GeneratedRecipeSeed, index: number): RecipeDetail {
  const ingredients = Array.from(new Set(seed.ingredients.map(normalizeIngredientName))).slice(0, 5);
  const cookTime = seed.kind === 'fruit' || seed.kind === 'salad' ? 0 : seed.kind === 'milkshake' || seed.kind === 'smoothie' || seed.kind === 'juice' ? 3 : 12;
  const prepTime = seed.kind === 'congee' ? 8 : 5;

  return {
    id: `local_recipe_${String(index + 1).padStart(3, '0')}`,
    name: seed.name,
    namePinyin: '',
    imageUrl: buildRecipeImageUrl(seed.name, undefined, ingredients),
    englishName: recipeEnglishKeywordMap[seed.kind],
    nameLearning: buildGeneratedNameLearning(seed.name),
    ageRange: '7-12 岁',
    difficulty: seed.kind === 'stir' ? 'medium' : 'easy',
    estimatedTimeMinutes: prepTime + cookTime,
    fitReasons: [],
    riskAlerts: recipeKindRisk[seed.kind],
    nutritionSummary: '结合蔬果、谷物或蛋白质，适合作为儿童日常均衡饮食的一部分。',
    extraIngredients: [],
    canCookWithCurrentIngredients: true,
    prepTimeMinutes: prepTime,
    cookTimeMinutes: cookTime,
    ingredients: ingredients.map((name) => ({
      name,
      quantity: getGeneratedQuantity(name),
      imageUrl: buildIngredientImageUrl(name),
    })),
    steps: buildGeneratedRecipeSteps(seed.kind, ingredients, seed.name),
  };
}

function buildGeneratedRecipeSeeds() {
  const seeds: GeneratedRecipeSeed[] = [
    { name: '番茄炒鸡蛋', ingredients: ['番茄', '鸡蛋'], kind: 'stir' },
    { name: '清爽土豆丝', ingredients: ['土豆', '胡萝卜'], kind: 'stir' },
    { name: '小米粥', ingredients: ['小米'], kind: 'congee' },
    { name: '彩虹水果拼盘', ingredients: ['苹果', '香蕉', '草莓', '蓝莓'], kind: 'fruit' },
    { name: '西瓜冰粉杯', ingredients: ['西瓜'], kind: 'fruit' },
    { name: '草莓奶昔', ingredients: ['草莓', '牛奶'], kind: 'milkshake' },
    { name: '香蕉牛奶昔', ingredients: ['香蕉', '牛奶'], kind: 'milkshake' },
    { name: '苹果胡萝卜汁', ingredients: ['苹果', '胡萝卜'], kind: 'juice' },
    { name: '黄瓜苹果汁', ingredients: ['黄瓜', '苹果'], kind: 'juice' },
    { name: '芒果酸奶杯', ingredients: ['芒果', '酸奶'], kind: 'smoothie' },
    { name: '蓝莓酸奶杯', ingredients: ['蓝莓', '酸奶'], kind: 'smoothie' },
    { name: '牛油果香蕉奶昔', ingredients: ['牛油果', '香蕉', '牛奶'], kind: 'milkshake' },
    { name: '南瓜小米粥', ingredients: ['南瓜', '小米'], kind: 'congee' },
    { name: '山药小米粥', ingredients: ['山药', '小米'], kind: 'congee' },
    { name: '红薯小米粥', ingredients: ['红薯', '小米'], kind: 'congee' },
    { name: '玉米燕麦粥', ingredients: ['玉米', '燕麦'], kind: 'congee' },
    { name: '番茄鸡蛋汤', ingredients: ['番茄', '鸡蛋'], kind: 'soup' },
    { name: '紫菜鸡蛋汤', ingredients: ['紫菜', '鸡蛋'], kind: 'soup' },
    { name: '冬瓜虾仁汤', ingredients: ['冬瓜', '虾仁'], kind: 'soup' },
    { name: '玉米胡萝卜汤', ingredients: ['玉米', '胡萝卜'], kind: 'soup' },
    { name: '菠菜鸡蛋汤', ingredients: ['菠菜', '鸡蛋'], kind: 'soup' },
    { name: '西兰花炒鸡蛋', ingredients: ['西兰花', '鸡蛋'], kind: 'stir' },
    { name: '黄瓜炒鸡蛋', ingredients: ['黄瓜', '鸡蛋'], kind: 'stir' },
    { name: '胡萝卜炒鸡蛋', ingredients: ['胡萝卜', '鸡蛋'], kind: 'stir' },
    { name: '菠菜炒鸡蛋', ingredients: ['菠菜', '鸡蛋'], kind: 'stir' },
    { name: '蒜苗炒鸡蛋', ingredients: ['蒜苗', '鸡蛋'], kind: 'stir' },
    { name: '青菜炒豆腐', ingredients: ['青菜', '豆腐'], kind: 'stir' },
    { name: '番茄豆腐汤', ingredients: ['番茄', '豆腐'], kind: 'soup' },
    { name: '香菇青菜', ingredients: ['香菇', '青菜'], kind: 'stir' },
    { name: '清炒西兰花', ingredients: ['西兰花'], kind: 'stir' },
    { name: '清炒菠菜', ingredients: ['菠菜'], kind: 'stir' },
    { name: '清炒小白菜', ingredients: ['小白菜'], kind: 'stir' },
    { name: '清炒黄瓜片', ingredients: ['黄瓜'], kind: 'stir' },
    { name: '土豆胡萝卜丝', ingredients: ['土豆', '胡萝卜'], kind: 'stir' },
    { name: '彩椒炒鸡胸肉', ingredients: ['彩椒', '鸡胸肉'], kind: 'stir' },
    { name: '胡萝卜炒牛肉', ingredients: ['胡萝卜', '牛肉'], kind: 'stir' },
    { name: '番茄鱼片汤', ingredients: ['番茄', '鱼肉'], kind: 'soup' },
    { name: '虾仁玉米粒', ingredients: ['虾仁', '玉米粒'], kind: 'stir' },
    { name: '毛豆炒鸡蛋', ingredients: ['毛豆', '鸡蛋'], kind: 'stir' },
    { name: '莲藕炒肉片', ingredients: ['莲藕', '猪肉'], kind: 'stir' },
    { name: '猪肝菠菜汤', ingredients: ['猪肝', '菠菜'], kind: 'soup' },
    { name: '苹果香蕉拼盘', ingredients: ['苹果', '香蕉'], kind: 'fruit' },
    { name: '草莓蓝莓拼盘', ingredients: ['草莓', '蓝莓'], kind: 'fruit' },
    { name: '西瓜葡萄拼盘', ingredients: ['西瓜', '葡萄'], kind: 'fruit' },
    { name: '橙子梨拼盘', ingredients: ['橙子', '梨'], kind: 'fruit' },
    { name: '猕猴桃香蕉拼盘', ingredients: ['猕猴桃', '香蕉'], kind: 'fruit' },
    { name: '菠萝芒果拼盘', ingredients: ['菠萝', '芒果'], kind: 'fruit' },
    { name: '西瓜汁', ingredients: ['西瓜'], kind: 'juice' },
    { name: '橙汁', ingredients: ['橙子'], kind: 'juice' },
    { name: '梨汁', ingredients: ['梨'], kind: 'juice' },
    { name: '葡萄汁', ingredients: ['葡萄'], kind: 'juice' },
  ];

  const unique = new Map<string, GeneratedRecipeSeed>();
  for (const seed of seeds) {
    if (!unique.has(seed.name)) {
      unique.set(seed.name, seed);
    }
    if (unique.size >= 50) {
      break;
    }
  }

  return Array.from(unique.values());
}

export const generatedHomeRecipeCatalog: RecipeDetail[] = buildGeneratedRecipeSeeds()
  .map((seed, index) => buildGeneratedRecipe(seed, index));

export const recipeCatalog: RecipeDetail[] = [
  ...curatedRecipeCatalog,
  ...generatedHomeRecipeCatalog,
];

export function summarizeRecipe(recipe: RecipeDetail): RecipeRecommendation {
  return {
    id: recipe.id,
    name: recipe.name,
    namePinyin: recipe.namePinyin,
    englishName: recipe.englishName,
    nameLearning: recipe.nameLearning,
    ageRange: recipe.ageRange,
    difficulty: recipe.difficulty,
    estimatedTimeMinutes: recipe.estimatedTimeMinutes,
    fitReasons: [],
    riskAlerts: recipe.riskAlerts,
    nutritionSummary: recipe.nutritionSummary,
    extraIngredients: [],
    canCookWithCurrentIngredients: recipe.canCookWithCurrentIngredients,
  };
}
