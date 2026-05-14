import {
  normalizeChildFriendlyQuantity,
  normalizeIngredientName,
  summarizeRecipe,
  recipeCatalog,
  type ChildProfile,
  type IngredientItem,
  type RecipeRecommendation,
  type RecipeDetailRecipeInput,
  type RecipeDetail,
} from './data.js';
import { getLocalLlmLogFilePath, writeLocalJsonLog } from './logger.js';
import { modelRouter, type ModelRouteContext, type ModelTask } from './modelRouter.js';

const SILICONFLOW_API_URL = 'https://api.siliconflow.cn/v1/chat/completions';

interface SiliconFlowMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}

interface SiliconFlowCallOptions {
  operation: string;
  task: ModelTask;
  routeContext?: ModelRouteContext;
  metadata?: Record<string, unknown>;
  maxTokens?: number;
}

export function isSiliconFlowConfigured() {
  return Boolean(process.env.SILICONFLOW_API_KEY?.trim());
}

export function shouldRequireRealModel() {
  return Boolean(
    process.env.NETLIFY ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      process.env.NODE_ENV === 'production',
  );
}

function summarizeMessages(messages: SiliconFlowMessage[]) {
  return messages.map((message) => {
    if (typeof message.content === 'string') {
      return {
        role: message.role,
        contentPreview: message.content.slice(0, 240),
      };
    }

    return {
      role: message.role,
      content: message.content.map((item) => {
        if (item.type === 'text') {
          return {
            type: 'text',
            textPreview: item.text.slice(0, 180),
          };
        }

        return {
          type: 'image_url',
          urlPreview: item.image_url.url.startsWith('data:')
            ? item.image_url.url.slice(0, item.image_url.url.indexOf(';base64,')) + ';base64,<omitted>'
            : item.image_url.url.slice(0, 180),
        };
      }),
    };
  });
}

async function callSiliconFlow(messages: SiliconFlowMessage[], options: SiliconFlowCallOptions) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const startedAt = Date.now();
  const route = modelRouter.select(options.task, options.routeContext);
  const models = [route.model, ...route.fallbackModels].filter((model, index, items) => model && items.indexOf(model) === index);

  if (!apiKey) {
    writeLocalJsonLog({
      type: 'llm_call',
      operation: options.operation,
      task: options.task,
      model: route.model,
      success: false,
      durationMs: Date.now() - startedAt,
      error: 'SILICONFLOW_API_KEY is not configured.',
      metadata: options.metadata ?? {},
      logFile: getLocalLlmLogFilePath(),
    });
    throw new Error('SILICONFLOW_API_KEY is not configured.');
  }

  let lastError: Error | null = null;

  for (const [modelIndex, model] of models.entries()) {
    const attemptStartedAt = Date.now();
    const isFallback = modelIndex > 0;
    try {
      const response = await fetch(SILICONFLOW_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          enable_thinking: route.enableThinking,
          temperature: route.temperature,
          max_tokens: options.maxTokens ?? route.maxTokens,
          response_format: {
            type: 'json_object',
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        writeLocalJsonLog({
          type: 'llm_call',
          operation: options.operation,
          task: options.task,
          model,
          fallback: isFallback,
          success: false,
          durationMs: Date.now() - attemptStartedAt,
          totalDurationMs: Date.now() - startedAt,
          status: response.status,
          error: `SiliconFlow chat completion failed: ${text}`,
          requestSummary: summarizeMessages(messages),
          metadata: options.metadata ?? {},
          logFile: getLocalLlmLogFilePath(),
        });
        throw new Error(`SiliconFlow chat completion failed: ${text}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: Record<string, unknown>;
      };

      const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
      const finishReason = payload.choices?.[0]?.finish_reason ?? null;

      writeLocalJsonLog({
        type: 'llm_call',
        operation: options.operation,
        task: options.task,
        model,
        fallback: isFallback,
        success: true,
        durationMs: Date.now() - attemptStartedAt,
        totalDurationMs: Date.now() - startedAt,
        requestSummary: summarizeMessages(messages),
        responsePreview: content.slice(0, 500),
        finishReason,
        usage: payload.usage ?? null,
        metadata: options.metadata ?? {},
        logFile: getLocalLlmLogFilePath(),
      });

      return content;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('SiliconFlow chat completion failed.');
      if (error instanceof Error && !error.message.startsWith('SiliconFlow chat completion failed:')) {
        writeLocalJsonLog({
          type: 'llm_call',
          operation: options.operation,
          task: options.task,
          model,
          fallback: isFallback,
          success: false,
          durationMs: Date.now() - attemptStartedAt,
          totalDurationMs: Date.now() - startedAt,
          error: error.message,
          requestSummary: summarizeMessages(messages),
          metadata: options.metadata ?? {},
          logFile: getLocalLlmLogFilePath(),
        });
      }
    }
  }

  throw lastError ?? new Error('SiliconFlow chat completion failed.');
}

function stripMarkdownCodeFence(content: string) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function extractRecipesFromPossiblyTruncatedJson(content: string) {
  const recipesKeyIndex = content.indexOf('"recipes"');
  if (recipesKeyIndex === -1) {
    return [];
  }

  const arrayStartIndex = content.indexOf('[', recipesKeyIndex);
  if (arrayStartIndex === -1) {
    return [];
  }

  const results: Array<Partial<RecipeDetail>> = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectStart = -1;

  for (let index = arrayStartIndex + 1; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        objectStart = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        const candidate = content.slice(objectStart, index + 1);
        try {
          results.push(JSON.parse(candidate) as Partial<RecipeDetail>);
        } catch {
          // Skip incomplete or malformed recipe objects.
        }
        objectStart = -1;
      }
      continue;
    }

    if (char === ']' && depth === 0) {
      break;
    }
  }

  return results;
}

function parseRecipePlanPayload(content: string) {
  const normalizedContent = stripMarkdownCodeFence(content);

  try {
    return JSON.parse(normalizedContent) as { recipes?: Array<Partial<RecipeDetail>> };
  } catch {
    const salvagedRecipes = extractRecipesFromPossiblyTruncatedJson(normalizedContent);
    if (salvagedRecipes.length > 0) {
      return { recipes: salvagedRecipes };
    }

    throw new Error('菜谱推荐模型返回内容无法解析为有效 JSON。');
  }
}

function parseSeasonalIngredientSuggestionPayload(content: string) {
  const normalizedContent = stripMarkdownCodeFence(content);

  try {
    const parsed = JSON.parse(normalizedContent) as {
      suggestions?: Array<{ name?: unknown; reason?: unknown }>;
    };

    return (parsed.suggestions ?? [])
      .map((item) => ({
        name: String(item.name ?? '').trim(),
        reason: String(item.reason ?? '').trim(),
      }))
      .filter((item) => item.name)
      .slice(0, 5);
  } catch {
    throw new Error('季节食材推荐模型返回内容无法解析为有效 JSON。');
  }
}

function toDataUrl(file: { buffer: Buffer; mimetype: string }) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

function slugifyRecipeName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function buildFallbackEnglishName(name: string) {
  return `${name} Kids Recipe`;
}

function buildFallbackNameLearning(name: string, namePinyin = ''): RecipeRecommendation['nameLearning'] {
  const pinyinParts = namePinyin.split(/\s+/).filter(Boolean);
  const characters = Array.from(name).filter((character) => /\p{Script=Han}/u.test(character));

  return {
    characters: characters.map((character, index) => ({
      character,
      pinyin: pinyinParts[index] ?? '',
      strokes: 1,
      structure: '待补充',
      hint: `认识“${character}”这个字，先从菜名里读一读。`,
    })),
  };
}

function normalizeNameLearning(
  recipe: Partial<RecipeRecommendation | RecipeDetail>,
  name: string,
  namePinyin = '',
): RecipeRecommendation['nameLearning'] {
  const rawCharacters = recipe.nameLearning?.characters;
  if (!Array.isArray(rawCharacters) || rawCharacters.length === 0) {
    return buildFallbackNameLearning(name, namePinyin);
  }

  return {
    characters: rawCharacters
      .filter((item) => item?.character)
      .map((item) => ({
        character: String(item.character).slice(0, 1),
        pinyin: String(item.pinyin ?? ''),
        strokes: Math.max(1, Number(item.strokes ?? 1)),
        structure: String(item.structure ?? '待补充'),
        hint: String(item.hint ?? `认识“${item.character}”这个字，先从菜名里读一读。`),
      })),
  };
}

function normalizeRiskLevel(value: string): 'low' | 'medium' | 'high' {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }

  return 'medium';
}

export interface GeneratedRecommendationPayload {
  recipes: ReturnType<typeof summarizeRecipe>[];
  recipeDetails: RecipeDetail[];
  filteredAllergens: string[];
  sortBy: string;
}

function normalizeGeneratedRecipeSummaries(
  payload: {
    recipes?: Array<Partial<RecipeRecommendation>>;
  },
  profile: ChildProfile,
) {
  const recipes = (payload.recipes ?? [])
    .filter((recipe) => recipe.name)
    .map((recipe, index) => {
      const name = String(recipe.name);
      const namePinyin = String((recipe as { namePinyin?: string }).namePinyin ?? '');

      return {
        id: `recipe_gen_summary_${slugifyRecipeName(name)}_${index + 1}`,
        name,
        namePinyin,
        englishName: String(recipe.englishName ?? buildFallbackEnglishName(name)),
        nameLearning: normalizeNameLearning(recipe, name, namePinyin),
        ageRange: String(recipe.ageRange ?? `${Math.max(3, profile.age - 1)}-${profile.age + 3} 岁`),
        difficulty: recipe.difficulty === 'hard' || recipe.difficulty === 'medium' ? recipe.difficulty : 'easy',
        estimatedTimeMinutes: Math.max(1, Number(recipe.estimatedTimeMinutes ?? 20)),
        fitReasons: Array.isArray(recipe.fitReasons) ? recipe.fitReasons.map(String).slice(0, 3) : ['适合当前儿童档案'],
        riskAlerts: Array.isArray(recipe.riskAlerts) ? recipe.riskAlerts.map(String).slice(0, 3) : [],
        nutritionSummary: String(recipe.nutritionSummary ?? '营养搭配均衡，适合作为儿童一餐。'),
        extraIngredients: Array.isArray(recipe.extraIngredients) ? recipe.extraIngredients.map(String).slice(0, 4) : [],
        canCookWithCurrentIngredients:
          typeof recipe.canCookWithCurrentIngredients === 'boolean'
            ? recipe.canCookWithCurrentIngredients
            : false,
      } satisfies RecipeRecommendation;
    })
    .filter((recipe) => recipe.fitReasons.length > 0);

  return {
    recipes,
    recipeDetails: [],
    filteredAllergens: profile.allergens,
    sortBy: 'balanced',
  } satisfies GeneratedRecommendationPayload;
}

const commonUnlistedCookingIngredientNames = [
  '食盐',
  '盐',
  '食用油',
  '油',
  '白糖',
  '糖',
  '酱油',
  '生抽',
  '老抽',
  '醋',
  '香油',
  '料酒',
  '蚝油',
  '鸡精',
  '味精',
  '胡椒粉',
  '淀粉',
  '面粉',
  '葱',
  '姜',
  '蒜',
  '牛奶',
  '黄油',
  '芝士',
];

function buildAllowedIngredientNameSet(ingredients: IngredientItem[]) {
  const names = new Set<string>();

  ingredients.forEach((item) => {
    [item.name, item.normalizedName].forEach((name) => {
      if (name) {
        names.add(normalizeIngredientName(name));
      }
    });
  });

  return names;
}

function isAllowedIngredientName(name: string, allowedNames: Set<string>) {
  if (allowedNames.size === 0) {
    return true;
  }

  return allowedNames.has(normalizeIngredientName(name));
}

function normalizeRecipeIdentity(value: string) {
  return normalizeIngredientName(value).replace(/\s+/g, '').toLowerCase();
}

function hasSameRecipeName(actualName: string, targetName: string) {
  return normalizeRecipeIdentity(actualName) === normalizeRecipeIdentity(targetName);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDisallowedIngredientNames(
  recipe: Partial<RecipeDetail>,
  generatedIngredients: Array<{ name?: string }>,
  allowedNames: Set<string>,
) {
  const names = new Set<string>();
  const candidates = [
    ...generatedIngredients.map((item) => item.name),
    ...(Array.isArray(recipe.extraIngredients) ? recipe.extraIngredients : []),
    ...commonUnlistedCookingIngredientNames,
  ];

  candidates.forEach((candidate) => {
    const name = String(candidate ?? '').trim();
    if (name && !isAllowedIngredientName(name, allowedNames)) {
      names.add(name);
    }
  });

  return [...names].sort((left, right) => right.length - left.length);
}

function removeDisallowedIngredientMentions(value: string, disallowedNames: string[]) {
  let next = value;

  disallowedNames.forEach((name) => {
    next = next.replace(new RegExp(escapeRegExp(name), 'g'), '');
  });

  return next
    .replace(/加入(少许|适量|一点|半勺|一勺)?([，。、；;])/g, '继续$2')
    .replace(/放入(少许|适量|一点|半勺|一勺)?([，。、；;])/g, '继续$2')
    .replace(/[，、]\s*[，、]/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAllowedExtraIngredients(value: unknown, allowedNames: Set<string>) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(String)
    .filter((name) => isAllowedIngredientName(name, allowedNames));
}

function getRecipeStepText(step: RecipeDetail['steps'][number]) {
  return [
    step.title,
    step.description,
    step.tip,
    step.childAction,
    step.parentAction,
    step.expectedResult,
  ].join(' ');
}

function ensureIngredientOperationsInSteps(
  steps: RecipeDetail['steps'],
  recipeIngredients: RecipeDetail['ingredients'],
) {
  if (steps.length === 0 || recipeIngredients.length === 0) {
    return steps;
  }

  const missingIngredientNames = recipeIngredients
    .map((ingredient) => ingredient.name)
    .filter((name) => !steps.some((step) => getRecipeStepText(step).includes(name)));

  if (missingIngredientNames.length === 0) {
    return steps;
  }

  const targetStepIndex = steps.findIndex((step) => step.riskLevel === 'low');
  const fallbackStepIndex = targetStepIndex >= 0 ? targetStepIndex : 0;
  const missingNamesText = missingIngredientNames.join('、');

  return steps.map((step, index) => {
    if (index !== fallbackStepIndex) {
      return step;
    }

    return {
      ...step,
      description: `${step.description} 补充食材操作：把${missingNamesText}清洗或整理好，需要时切小，再按这一步一起加入。`,
      childAction: `${step.childAction} 也要确认${missingNamesText}已经准备好并放到操作台旁。`,
      expectedResult: `${step.expectedResult} ${missingNamesText}也完成清洗、整理或加入。`,
    };
  });
}

function ensureRecipeNameInSteps(steps: RecipeDetail['steps'], recipeName: string) {
  if (steps.length === 0 || !recipeName.trim()) {
    return steps;
  }

  if (steps.some((step) => getRecipeStepText(step).includes(recipeName))) {
    return steps;
  }

  const lastStepIndex = steps.length - 1;

  return steps.map((step, index) => {
    if (index === 0) {
      return {
        ...step,
        description: `制作${recipeName}：${step.description}`,
      };
    }

    if (index === lastStepIndex) {
      return {
        ...step,
        expectedResult: `${step.expectedResult || '完成这一步后观察成品状态。'} 完成后就是${recipeName}。`,
      };
    }

    return step;
  });
}

function findGeneratedDetailForRecipe(details: RecipeDetail[], recipe: RecipeDetailRecipeInput | RecipeRecommendation) {
  return details.find((detail) => hasSameRecipeName(detail.name, recipe.name));
}

function normalizeGeneratedRecipeDetails(
  payload: {
    recipes?: Array<Partial<RecipeDetail>>;
  },
  profile: ChildProfile,
  ingredients: IngredientItem[],
) {
  const inputIngredients = buildAllowedIngredientNameSet(ingredients);

  const recipeDetails = (payload.recipes ?? [])
    .filter((recipe) => recipe.name)
    .map((recipe, index) => {
      const rawIngredients = (recipe.ingredients ?? []).filter((item) => item?.name);
      const disallowedIngredientNames = buildDisallowedIngredientNames(recipe, rawIngredients, inputIngredients);
      const normalizedIngredients = rawIngredients.filter((item) =>
        isAllowedIngredientName(String(item.name ?? ''), inputIngredients),
      );
      const normalizedIngredientItems = normalizedIngredients.map((item) => ({
        name: String(item.name),
        quantity: normalizeChildFriendlyQuantity(String(item.quantity ?? '1平勺')),
      }));
      const prepTimeMinutes = Math.max(1, Number(recipe.prepTimeMinutes ?? 5));
      const cookTimeMinutes = Math.max(1, Number(recipe.cookTimeMinutes ?? 10));
      const estimatedTimeMinutes = Math.max(
        1,
        Number(recipe.estimatedTimeMinutes ?? prepTimeMinutes + cookTimeMinutes),
      );
      const canCookWithCurrentIngredients = normalizedIngredients.every((item) =>
        isAllowedIngredientName(String(item.name ?? ''), inputIngredients),
      );
      const name = String(recipe.name);
      const namePinyin = String((recipe as { namePinyin?: string }).namePinyin ?? '');
      const normalizedSteps = Array.isArray(recipe.steps)
        ? recipe.steps
            .filter((step) => step?.title && step?.description)
            .map((step, stepIndex) => ({
              id: String(step.id ?? `step_${index + 1}_${stepIndex + 1}`),
              title: removeDisallowedIngredientMentions(String(step.title), disallowedIngredientNames),
              description: removeDisallowedIngredientMentions(String(step.description), disallowedIngredientNames),
              tip: removeDisallowedIngredientMentions(
                String(step.tip ?? '慢慢来，先确认安全再动手。'),
                disallowedIngredientNames,
              ),
              childAction: removeDisallowedIngredientMentions(
                String((step as { childAction?: string }).childAction ?? step.description ?? ''),
                disallowedIngredientNames,
              ),
              parentAction: removeDisallowedIngredientMentions(
                String(
                  (step as { parentAction?: string }).parentAction ??
                    (step.requiresParentAssist ? '这一小步建议家长在旁边陪着一起完成。' : ''),
                ),
                disallowedIngredientNames,
              ),
              expectedResult: removeDisallowedIngredientMentions(String(
                (step as { expectedResult?: string }).expectedResult ??
                  '完成这一步后，先停下来看看食材颜色和形状有没有变化。',
              ), disallowedIngredientNames),
              riskLevel: normalizeRiskLevel(String(step.riskLevel ?? 'medium')),
              requiresParentAssist: Boolean(step.requiresParentAssist),
            }))
        : [];

      return {
        id: String(recipe.id ?? `recipe_gen_${slugifyRecipeName(name)}_${index + 1}`),
        name,
        namePinyin,
        englishName: String(recipe.englishName ?? buildFallbackEnglishName(name)),
        nameLearning: normalizeNameLearning(recipe, name, namePinyin),
        ageRange: String(recipe.ageRange ?? `${Math.max(3, profile.age - 1)}-${profile.age + 3} 岁`),
        difficulty: recipe.difficulty === 'hard' || recipe.difficulty === 'medium' ? recipe.difficulty : 'easy',
        estimatedTimeMinutes,
        fitReasons: Array.isArray(recipe.fitReasons) ? recipe.fitReasons.map(String).slice(0, 4) : ['适合当前儿童档案'],
        riskAlerts: Array.isArray(recipe.riskAlerts) ? recipe.riskAlerts.map(String).slice(0, 4) : [],
        nutritionSummary: String(recipe.nutritionSummary ?? '营养搭配均衡，适合作为儿童一餐。'),
        extraIngredients: normalizeAllowedExtraIngredients(recipe.extraIngredients, inputIngredients),
        canCookWithCurrentIngredients:
          typeof recipe.canCookWithCurrentIngredients === 'boolean'
            ? recipe.canCookWithCurrentIngredients
            : canCookWithCurrentIngredients,
        prepTimeMinutes,
        cookTimeMinutes,
        ingredients: normalizedIngredientItems,
        steps: ensureIngredientOperationsInSteps(normalizedSteps, normalizedIngredientItems),
      } satisfies RecipeDetail;
    })
    .filter((recipe) => recipe.ingredients.length > 0 && recipe.steps.length > 0);

  return {
    recipes: recipeDetails.map((recipe) => summarizeRecipe(recipe)),
    recipeDetails,
    filteredAllergens: profile.allergens,
    sortBy: 'balanced',
  } satisfies GeneratedRecommendationPayload;
}

function buildRecipePlanUserPrompt(profile: ChildProfile, ingredients: IngredientItem[], userPrompt = '') {
  const ingredientLines = ingredients
    .map((item, index) => `${index + 1}. ${item.name}｜数量:${item.quantity}｜来源:${item.source}`)
    .join('\n');

  const profileLines = [
    `昵称: ${profile.nickname}`,
    `年龄: ${profile.age} 岁`,
    `口味偏好: ${profile.tastePreferences.join('、') || '无'}`,
    `过敏原: ${profile.allergens.join('、') || '无'}`,
    `饮食习惯: ${profile.dietaryHabits.join('、') || '无'}`,
  ].join('\n');

  return [
    '任务: 为儿童生成 3-5 道推荐菜谱卡片摘要，并输出严格 JSON。',
    '儿童档案:',
    profileLines,
    userPrompt.trim() ? '用户本轮对话描述:' : '',
    userPrompt.trim() ? userPrompt.trim() : '',
    '现有食材清单:',
    ingredientLines,
    '生成要求:',
    '1. 返回 3-5 道推荐菜谱摘要，数量不要少于 3 道，除非食材明显不足；优先使用现有食材，并结合用户本轮对话里的口味、场景、时间和限制条件；缺少食材尽量少。',
    '2. 菜谱要适合儿童年龄、口味和饮食习惯，操作者多为小学阶段儿童，优先推荐简单、低门槛、易上手、步骤清楚、营养均衡的菜谱。',
    '3. 严格避开过敏原和明显不适宜儿童的做法；避免复杂刀工、长时间油炸、重油重辣和需要精准火候的菜谱。',
    '4. 这里只生成推荐卡片摘要，不要生成 steps、ingredients、prepTimeMinutes、cookTimeMinutes，烹饪步骤会由详情接口单独生成。',
    '5. 每道菜都必须包含 namePinyin，使用带声调的汉语拼音，并按词分隔，例如 "fān qié jī dàn miàn"。',
    '6. 每道菜都必须包含 englishName，使用自然英译名，适合儿童听读，不要机械逐字翻译。',
    '7. 每道菜都必须包含 nameLearning.characters，逐字覆盖中文菜名中的汉字；每项包含 character、pinyin、strokes、structure、hint，pinyin 必须使用带调号拼音。',
    '8. 不要输出 imageUrl、imageSearchQuery 或任何图片相关字段。',
    '9. 如果菜谱会使用明火、天然气灶、电磁炉、微波炉、烤箱、空气炸锅、蒸锅、热锅、热油、开水或锋利刀具，riskAlerts 必须高亮写明“需家长全程陪同”，difficulty 不要标为 easy，canCookWithCurrentIngredients 不能掩盖安全风险。',
    '10. 检查“现有食材清单”中是否包含高危过敏原食材，例如花生、坚果、虾、蟹、贝类、海鲜、鱼、牛奶、乳制品、鸡蛋、小麦、大豆、芝麻等。若存在，请在 riskAlerts 增加以“高危过敏原提醒：”开头的醒目提醒，说明该食材可能诱发急性过敏、呼吸困难等危及生命风险，必须由家长确认儿童无相关确诊过敏后再制作。',
    '11. 如果只是普通常见食材且未命中高危过敏原，不要额外输出过敏原提醒，避免制造不必要焦虑。',
    '12. 输出字段必须完整，不要输出任何解释文字。',
  ].join('\n');
}

function buildRecipeDetailUserPrompt(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  recipe: RecipeDetailRecipeInput,
) {
  const ingredientLines = ingredients
    .map((item, index) => `${index + 1}. ${item.name}｜数量:${item.quantity}｜来源:${item.source}`)
    .join('\n');

  const profileLines = [
    `昵称: ${profile.nickname}`,
    `年龄: ${profile.age} 岁`,
    `口味偏好: ${profile.tastePreferences.join('、') || '无'}`,
    `过敏原: ${profile.allergens.join('、') || '无'}`,
    `饮食习惯: ${profile.dietaryHabits.join('、') || '无'}`,
  ].join('\n');

  const recipeLines = [
    `菜名: ${recipe.name}`,
    `英文名: ${recipe.englishName || '无'}`,
    `年龄段: ${recipe.ageRange || '7-12 岁'}`,
    `难度: ${recipe.difficulty || 'easy'}`,
    `预计总时长: ${recipe.estimatedTimeMinutes ?? 20} 分钟`,
    `适配原因: ${recipe.fitReasons?.join('、') || '无'}`,
    `风险提醒: ${recipe.riskAlerts?.join('、') || '无'}`,
  ].join('\n');

  return [
    '为儿童生成 1 道菜谱详情，严格 JSON，不要解释。',
    '儿童:',
    profileLines,
    '允许使用食材清单:',
    ingredientLines,
    '菜谱卡片:',
    recipeLines,
    '规则:',
    '1. 只生成这一道菜。',
    `2. 返回的 id/name/namePinyin/englishName 必须与菜谱卡片完全一致: ${recipe.id} / ${recipe.name} / ${recipe.namePinyin || ''} / ${recipe.englishName || ''}。`,
    `3. steps 必须全部围绕“${recipe.name}”制作，不要改成其他菜谱、其他主食或相似菜；title、description、childAction、expectedResult 禁止出现与“${recipe.name}”不一致的其他菜名。`,
    '4. 输出字段: id,name,namePinyin,englishName,ageRange,difficulty,estimatedTimeMinutes,fitReasons,riskAlerts,nutritionSummary,extraIngredients,canCookWithCurrentIngredients,prepTimeMinutes,cookTimeMinutes,ingredients,steps。',
    '5. 不要输出 nameLearning、imageUrl、imageSearchQuery。',
    '6. ingredients 只能从“允许使用食材清单”中选择，写食材名和儿童可理解用量，不要写“适量/少许”。',
    '7. steps 里的 title、description、tip、childAction、expectedResult 只能出现“允许使用食材清单”中的食材，禁止新增盐、油、糖、葱姜蒜、酱油、牛奶、面粉等未传入食材。',
    '8. 水、锅、碗、炉具、刀具等可以作为操作工具或介质描述；调味料必须在允许食材清单中才可使用。',
    '9. extraIngredients 必须返回 []，不要补充任何不在允许食材清单中的食材。',
    '10. steps 4-8 步，每步写清本步骤食材和关键动作，适合卡通分镜。',
    '11. ingredients 中列出的每一种食材都必须至少出现在一个 step 的 title、description、childAction 或 expectedResult 中，并说明如何清洗、切分、加入、搅拌、蒸煮或装盘。',
    '12. description 建议采用“本步骤食材：A、B；操作：……”格式，确保孩子能看懂每种食材在哪一步加入和怎么处理。',
    `13. 最后一步 expectedResult 必须明确写出“完成${recipe.name}”，确保成品菜名与推荐卡片一致。`,
    '14. 如果无法用允许食材清单为该菜名生成一致步骤，返回 {"recipes":[]}，不要编造其他菜谱。',
    '15. 每步包含 title,description,tip,childAction,parentAction,expectedResult,riskLevel,requiresParentAssist。',
    '16. 涉及开水、热锅、明火、电器、刀具时 riskLevel=medium/high，requiresParentAssist=true，parentAction 写家长全程陪同或由家长操作。',
  ].join('\n');
}

function buildRecipeDetailsUserPrompt(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  recipes: RecipeRecommendation[],
) {
  const ingredientLines = ingredients
    .map((item, index) => `${index + 1}. ${item.name}｜数量:${item.quantity}｜来源:${item.source}`)
    .join('\n');

  const profileLines = [
    `昵称: ${profile.nickname}`,
    `年龄: ${profile.age} 岁`,
    `口味偏好: ${profile.tastePreferences.join('、') || '无'}`,
    `过敏原: ${profile.allergens.join('、') || '无'}`,
    `饮食习惯: ${profile.dietaryHabits.join('、') || '无'}`,
  ].join('\n');

  const recipeLines = recipes
    .map((recipe, index) => [
      `${index + 1}. 菜名: ${recipe.name}`,
      `id: ${recipe.id}`,
      `英文名: ${recipe.englishName}`,
      `年龄段: ${recipe.ageRange}`,
      `难度: ${recipe.difficulty}`,
      `预计总时长: ${recipe.estimatedTimeMinutes} 分钟`,
      `适配原因: ${recipe.fitReasons.join('、') || '无'}`,
      `风险提醒: ${recipe.riskAlerts.join('、') || '无'}`,
    ].join('\n'))
    .join('\n\n');

  return [
    '任务: 基于推荐卡片列表，为每一道菜生成完整儿童菜谱详情，并输出严格 JSON。',
    '儿童档案:',
    profileLines,
    '现有食材清单:',
    ingredientLines,
    '目标推荐卡片列表:',
    recipeLines,
    '生成要求:',
    `1. 必须为上述 ${recipes.length} 道菜各生成 1 个详情，输出顺序和目标推荐卡片列表一致，不要新增其他菜。`,
    '2. 每道菜输出完整字段：id、name、namePinyin、englishName、nameLearning、ageRange、difficulty、estimatedTimeMinutes、fitReasons、riskAlerts、nutritionSummary、extraIngredients、canCookWithCurrentIngredients、prepTimeMinutes、cookTimeMinutes、ingredients、steps。',
    '3. 尽量沿用目标推荐卡片的 id、name、englishName、ageRange、difficulty、fitReasons、riskAlerts、nutritionSummary、canCookWithCurrentIngredients。',
    '4. ingredients 和 steps 只能使用“现有食材清单”中的食材，禁止新增盐、油、糖、葱姜蒜、酱油、牛奶、面粉等未传入食材；extraIngredients 必须返回 []。',
    '5. 不要输出 imageUrl、imageSearchQuery 或任何图片相关字段；任何调味料和近似量不要写“适量/少许/微量”，统一改成儿童可理解的勺数。',
    '6. steps 控制在 4-8 个步骤，适合前端按步骤生成卡通手绘风分镜插画。',
    '7. 每一步都要明确写出本步骤需要的食材清单，并把食材名称写进 title 或 description，且食材范围必须属于“现有食材清单”。',
    '8. ingredients 中列出的每一种食材都必须至少出现在一个 step 的 title、description、childAction 或 expectedResult 中，并说明如何清洗、切分、加入、搅拌、蒸煮或装盘。',
    '9. description 建议采用“本步骤食材：A、B；操作：……”格式，确保孩子能看懂每种食材在哪一步加入和怎么处理。',
    '10. 每一道详情的 name、steps、expectedResult 必须与对应目标推荐卡片的菜名完全一致，禁止生成相似菜、换主食、换菜名或混入其他菜名。',
    '11. 每一道详情最后一步 expectedResult 必须明确写出完成对应菜名。',
    '12. 如果无法用现有食材清单为某个目标菜名生成一致步骤，该菜返回空缺，不要编造其他菜谱。',
    '13. 每一步都要包含食材处理或烹饪动作的简短细节，描述精炼易懂但不能只有标签。',
    '14. 每一步除了 title、description、tip、riskLevel、requiresParentAssist，必须补充 childAction、parentAction、expectedResult。',
    '15. 如果步骤涉及明火、天然气灶、电磁炉、微波炉、烤箱、空气炸锅、蒸锅、热锅、热油、开水或锋利刀具，riskLevel 必须是 medium 或 high，requiresParentAssist 必须是 true，parentAction 必须明确“家长全程陪同/由家长操作”。',
    '16. 输出字段必须完整，不要输出任何解释文字。',
  ].join('\n');
}

export async function understandIngredientsFromText(userText: string, source: 'manual' | 'voice' = 'manual') {
  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童烹饪应用的食材理解助手。请从用户文本中提取食材名称，输出严格 JSON：{"ingredients":[{"name":"食材名","quantity":"数量或1份"}] }。不要输出额外说明。',
    },
    {
      role: 'user',
      content: `请从这段文本中识别食材：${userText}`,
    },
  ], {
    operation: 'understand_ingredients_text',
    task: source === 'voice' ? 'ingredient_voice' : 'ingredient_text',
    metadata: {
      source,
      textLength: userText.length,
    },
  });

  return content;
}

export async function understandIngredientsFromImage(file: {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}) {
  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童烹饪应用的视觉食材识别助手。请识别图片中明显可见的常见食材，输出严格 JSON：{"ingredients":[{"name":"食材名","quantity":"1份"}]}。如果不确定，只输出最明显的食材。不要输出额外说明。',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `请识别这张图片里的食材，文件名是 ${file.filename}。`,
        },
        {
          type: 'image_url',
          image_url: {
            url: toDataUrl(file),
          },
        },
      ],
    },
  ], {
    operation: 'understand_ingredients_image',
    task: 'ingredient_vision',
    metadata: {
      filename: file.filename,
      mimetype: file.mimetype,
      bytes: file.buffer.length,
    },
  });

  return content;
}

function getSeasonHint(month: number) {
  if (month === 1 || month === 2) {
    return '冬季与春节前后，偏暖体温热、清淡年节蔬果、少油少糖';
  }

  if (month >= 3 && month <= 5) {
    return '春季，偏新鲜青菜、应季瓜果、维生素丰富、轻口味';
  }

  if (month >= 6 && month <= 8) {
    return '夏季，偏祛暑补水、牛油果、西瓜、黄瓜、清爽冰沙或酸奶类食材';
  }

  if (month >= 9 && month <= 11) {
    return '秋季，偏润燥、祛湿、温和滋养、梨、山药、南瓜、莲藕等食材';
  }

  return '冬季，偏暖体、温热、易消化、汤羹粥类适配食材';
}

export async function generateSeasonalIngredientSuggestions(input: {
  month: number;
  childContext: string;
}) {
  const month = Number.isFinite(input.month) && input.month >= 1 && input.month <= 12
    ? Math.trunc(input.month)
    : new Date().getMonth() + 1;
  const seasonHint = getSeasonHint(month);

  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童食材推荐助手。请根据当前月份、季节/节令和默认小学生健康饮食原则，推荐儿童可能感兴趣且适合做儿童菜谱的食材。输出严格 JSON：{"suggestions":[{"name":"食材名","reason":"12字以内理由"}]}。只推荐食材或适合解析为食材的短词，不要推荐完整菜名，不要输出解释文字。',
    },
    {
      role: 'user',
      content: [
        `当前月份: ${month} 月`,
        `季节/节令提示: ${seasonHint}`,
        `儿童默认原则: ${input.childContext || '小学1-6年级学生，低油脂、轻口味、膳食均衡、维生素丰富、搭配均衡'}`,
        '生成要求:',
        '1. 只返回 5 个食材建议。',
        '2. 春节/冬季偏青菜瓜果、温热暖体、清淡少油；夏季偏牛油果、西瓜、黄瓜、清爽冰沙/酸奶可用食材；秋季偏润燥祛湿；春季偏新鲜青菜和维生素丰富食材。',
        '3. 食材名要短，便于用户点击后直接识别为食材。',
        '4. 不要包含过度辛辣、高糖、高油或明显不适合儿童的食材。',
      ].join('\n'),
    },
  ], {
    operation: 'generate_seasonal_ingredient_suggestions',
    task: 'seasonal_suggestions',
    metadata: {
      month,
      seasonHint,
    },
  });

  return parseSeasonalIngredientSuggestionPayload(content);
}

export async function generateRecipePlan(profile: ChildProfile, ingredients: IngredientItem[], userPrompt = '') {
  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童烹饪菜谱智能体。请根据儿童档案和现有食材，生成 3-5 个安全、适龄、简单易上手的儿童菜谱推荐卡片摘要。操作者多为小学阶段儿童，优先选择低油、轻口味、步骤清楚、亲子可执行的菜谱；如涉及明火、天然气灶、电磁炉、微波炉、烤箱、空气炸锅、蒸锅、热锅、热油、开水或锋利刀具，riskAlerts 必须高亮提醒“需家长全程陪同”。如现有食材含花生、坚果、虾、蟹、贝类、海鲜、鱼、牛奶、乳制品、鸡蛋、小麦、大豆、芝麻等高危过敏原食材，riskAlerts 必须增加以“高危过敏原提醒：”开头的提醒，提示可能诱发急性过敏、呼吸困难等危及生命风险，需家长确认无相关确诊过敏后再制作；普通常见食材未命中高危过敏原时不要额外输出过敏提醒。输出严格 JSON：{"recipes":[{"id":"可选","name":"菜名","namePinyin":"带声调拼音","englishName":"自然英文菜名","nameLearning":{"characters":[{"character":"菜","pinyin":"cài","strokes":11,"structure":"上下结构","hint":"儿童可理解的一句话"}]},"ageRange":"7-12 岁","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"fitReasons":["原因"],"riskAlerts":["提醒"],"nutritionSummary":"一句话","extraIngredients":["缺少食材"],"canCookWithCurrentIngredients":true}]}。不要输出 imageUrl、imageSearchQuery 或额外说明。',
    },
    {
      role: 'user',
      content: buildRecipePlanUserPrompt(profile, ingredients, userPrompt),
    },
  ], {
    operation: 'generate_recipe_plan',
    task: 'recipe_recommendation',
    routeContext: {
      profile,
      ingredients,
      userPrompt,
    },
    metadata: {
      profileId: profile.id,
      age: profile.age,
      ingredientCount: ingredients.length,
      ingredientNames: ingredients.map((item) => item.name),
      userPromptLength: userPrompt.length,
    },
  });

  return normalizeGeneratedRecipeSummaries(
    parseRecipePlanPayload(content),
    profile,
  );
}

export async function generateRecipeDetail(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  recipe: RecipeDetailRecipeInput,
) {
  const catalogRecipe = recipeCatalog.find((item) => item.id === recipe.id && hasSameRecipeName(item.name, recipe.name));
  if (catalogRecipe) {
    return catalogRecipe;
  }

  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童菜谱详情生成器。必须只为用户指定的同一道菜生成步骤，禁止改菜名、换菜谱、换主食或生成相似菜。返回的 name 必须与用户指定菜名完全一致；steps、expectedResult 和 ingredients 必须服务于同一道菜。烹饪步骤和配料只能使用用户传入的允许食材清单，禁止添加任何未传入食材或调味料。ingredients 中每个食材都必须在 steps 中说明在哪一步加入和如何处理。只输出 JSON：{"recipes":[{"id":"","name":"","namePinyin":"","englishName":"","ageRange":"7-12 岁","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"fitReasons":[],"riskAlerts":[],"nutritionSummary":"","extraIngredients":[],"canCookWithCurrentIngredients":true,"prepTimeMinutes":5,"cookTimeMinutes":15,"ingredients":[{"name":"","quantity":""}],"steps":[{"title":"","description":"","tip":"","childAction":"","parentAction":"","expectedResult":"","riskLevel":"low|medium|high","requiresParentAssist":false}]}]}。禁止输出 nameLearning、imageUrl、imageSearchQuery。',
    },
    {
      role: 'user',
      content: buildRecipeDetailUserPrompt(profile, ingredients, recipe),
    },
  ], {
    operation: 'generate_recipe_detail',
    task: 'recipe_steps',
    routeContext: {
      profile,
      ingredients,
      recipe,
    },
    metadata: {
      profileId: profile.id,
      recipeId: recipe.id,
      recipeName: recipe.name,
      ingredientCount: ingredients.length,
      ingredientNames: ingredients.map((item) => item.name),
    },
  });

  const detailPayload = normalizeGeneratedRecipeDetails(
    parseRecipePlanPayload(content),
    profile,
    ingredients,
  );

  const matched = findGeneratedDetailForRecipe(detailPayload.recipeDetails, recipe);
  if (!matched) {
    throw new Error(`菜谱详情生成失败，返回菜谱与“${recipe.name}”不一致。`);
  }
  const matchedSteps = ensureRecipeNameInSteps(matched.steps, recipe.name);

  return {
    ...matched,
    id: recipe.id || matched.id,
    name: recipe.name || matched.name,
    namePinyin: recipe.namePinyin || matched.namePinyin,
    englishName: recipe.englishName || matched.englishName,
    ageRange: recipe.ageRange || matched.ageRange,
    difficulty: recipe.difficulty || matched.difficulty,
    estimatedTimeMinutes: recipe.estimatedTimeMinutes || matched.estimatedTimeMinutes,
    fitReasons: recipe.fitReasons?.length ? recipe.fitReasons : matched.fitReasons,
    riskAlerts: recipe.riskAlerts?.length ? recipe.riskAlerts : matched.riskAlerts,
    nutritionSummary: recipe.nutritionSummary || matched.nutritionSummary,
    extraIngredients: matched.extraIngredients,
    steps: matchedSteps,
    canCookWithCurrentIngredients:
      typeof recipe.canCookWithCurrentIngredients === 'boolean'
        ? recipe.canCookWithCurrentIngredients
        : matched.canCookWithCurrentIngredients,
  } satisfies RecipeDetail;
}

export async function generateRecipeDetails(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  recipes: RecipeRecommendation[],
) {
  const catalogDetails = recipes
    .map((recipe) => recipeCatalog.find((item) => item.id === recipe.id && hasSameRecipeName(item.name, recipe.name)))
    .filter((recipe): recipe is RecipeDetail => Boolean(recipe));
  const missingRecipes = recipes.filter((recipe) => !catalogDetails.some((detail) => detail.id === recipe.id));

  if (missingRecipes.length === 0) {
    return catalogDetails;
  }

  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童烹饪菜谱智能体。请根据儿童档案、现有食材和推荐卡片列表，为每道菜生成完整儿童菜谱详情。steps 必须适合前端生成卡通手绘风分镜插画：总步数 4-8 步，每步必须明确写出该步骤需要的食材清单，并用短句写清关键食材处理或烹饪动作。每道详情的 name 必须与对应推荐卡片菜名完全一致；steps、expectedResult 和 ingredients 必须服务于同一道菜，禁止换菜名、换主食或生成相似菜。ingredients 中每个食材都必须在 steps 中说明在哪一步加入和如何处理。烹饪步骤和配料只能使用用户传入的现有食材清单，禁止添加任何未传入食材或调味料。如涉及明火、热源、电器、开水或锋利刀具，必须在 riskAlerts 和对应 step 中高亮提醒需家长全程陪同。输出严格 JSON：{"recipes":[{"id":"沿用推荐卡片id","name":"菜名","namePinyin":"带声调拼音","englishName":"自然英文菜名","nameLearning":{"characters":[{"character":"菜","pinyin":"cài","strokes":11,"structure":"上下结构","hint":"儿童可理解的一句话"}]},"ageRange":"7-12 岁","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"fitReasons":["原因"],"riskAlerts":["提醒"],"nutritionSummary":"一句话","extraIngredients":[],"canCookWithCurrentIngredients":true,"prepTimeMinutes":5,"cookTimeMinutes":15,"ingredients":[{"name":"食材名","quantity":"1平勺"}],"steps":[{"id":"可选","title":"步骤标题","description":"本步骤食材和动作短句","tip":"短句提示","childAction":"孩子关键动作","parentAction":"家长何时介入","expectedResult":"完成状态短句","riskLevel":"low|medium|high","requiresParentAssist":false}]}]}。不要输出 imageUrl、imageSearchQuery 或额外说明。',
    },
    {
      role: 'user',
      content: buildRecipeDetailsUserPrompt(profile, ingredients, missingRecipes),
    },
  ], {
    operation: 'generate_recipe_details',
    task: 'recipe_steps_batch',
    routeContext: {
      profile,
      ingredients,
      recipes: missingRecipes,
    },
    metadata: {
      profileId: profile.id,
      recipeCount: missingRecipes.length,
      recipeNames: missingRecipes.map((recipe) => recipe.name),
      ingredientCount: ingredients.length,
      ingredientNames: ingredients.map((item) => item.name),
    },
  });

  const detailPayload = normalizeGeneratedRecipeDetails(
    parseRecipePlanPayload(content),
    profile,
    ingredients,
  );

  const generatedDetails = missingRecipes.reduce<RecipeDetail[]>((details, recipe) => {
    const matched = findGeneratedDetailForRecipe(detailPayload.recipeDetails, recipe);
    if (!matched) {
      return details;
    }
    const matchedSteps = ensureRecipeNameInSteps(matched.steps, recipe.name);

    details.push({
      ...matched,
      id: recipe.id || matched.id,
      name: recipe.name || matched.name,
      namePinyin: recipe.namePinyin || matched.namePinyin,
      englishName: recipe.englishName || matched.englishName,
      nameLearning: recipe.nameLearning ?? matched.nameLearning,
      ageRange: recipe.ageRange || matched.ageRange,
      difficulty: recipe.difficulty || matched.difficulty,
      estimatedTimeMinutes: recipe.estimatedTimeMinutes || matched.estimatedTimeMinutes,
      fitReasons: recipe.fitReasons.length > 0 ? recipe.fitReasons : matched.fitReasons,
      riskAlerts: recipe.riskAlerts.length > 0 ? recipe.riskAlerts : matched.riskAlerts,
      nutritionSummary: recipe.nutritionSummary || matched.nutritionSummary,
      extraIngredients: matched.extraIngredients,
      steps: matchedSteps,
      canCookWithCurrentIngredients:
        typeof recipe.canCookWithCurrentIngredients === 'boolean'
          ? recipe.canCookWithCurrentIngredients
          : matched.canCookWithCurrentIngredients,
    } satisfies RecipeDetail);

    return details;
  }, []);

  return [...catalogDetails, ...generatedDetails];
}

export async function generateCookingFeedback(input: {
  profile: ChildProfile;
  recipe: RecipeDetail;
  tasteFeedback: string;
  difficultyFeedback: string;
}) {
  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童烹饪应用的鼓励式点评助手。请根据儿童档案、菜谱和用户反馈，输出严格 JSON：{"praise":"一句鼓励","improvement":"一句改进建议","nextSuggestion":"一句下一次建议"}。语气温和、具体、适合家长和孩子一起阅读。不要输出额外说明。',
    },
    {
      role: 'user',
      content: JSON.stringify(input),
    },
  ], {
    operation: 'generate_cooking_feedback',
    task: 'cooking_feedback',
    routeContext: {
      profile: input.profile,
      recipe: input.recipe,
    },
    metadata: {
      profileId: input.profile.id,
      recipeId: input.recipe.id,
      recipeName: input.recipe.name,
      tasteFeedbackLength: input.tasteFeedback.length,
      difficultyFeedbackLength: input.difficultyFeedback.length,
    },
  });

  const parsed = JSON.parse(content) as {
    praise?: string;
    improvement?: string;
    nextSuggestion?: string;
  };

  return {
    praise: String(parsed.praise ?? `${input.recipe.name} 做得很认真，已经很棒了。`),
    improvement: String(parsed.improvement ?? '下次可以把步骤放慢一点，每一步都先确认安全。'),
    nextSuggestion: String(parsed.nextSuggestion ?? '下次可以挑战一道类似难度、但多一种蔬菜的菜谱。'),
  };
}
