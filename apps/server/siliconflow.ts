import {
  normalizeChildFriendlyQuantity,
  normalizeIngredientName,
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

function extractJsonObjectCandidate(content: string) {
  const normalizedContent = stripMarkdownCodeFence(content);
  const firstBrace = normalizedContent.indexOf('{');
  const lastBrace = normalizedContent.lastIndexOf('}');

  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return normalizedContent;
  }

  return normalizedContent.slice(firstBrace, lastBrace + 1).trim();
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

function parseRecipeStepsPayload(content: string) {
  const normalizedContent = extractJsonObjectCandidate(content);

  try {
    const parsed = JSON.parse(normalizedContent) as {
      steps?: Array<Partial<RecipeDetail['steps'][number]>>;
      recipes?: Array<{ name?: unknown; steps?: Array<Partial<RecipeDetail['steps'][number]>> }>;
    };
    const sourceRecipeName = parsed.recipes?.[0]?.name;
    const steps = Array.isArray(parsed.steps) ? parsed.steps : parsed.recipes?.[0]?.steps;
    return {
      sourceRecipeName: typeof sourceRecipeName === 'string' ? sourceRecipeName : '',
      steps: Array.isArray(steps) ? steps : [],
    };
  } catch {
    throw new Error('菜谱步骤模型返回内容无法解析为有效 JSON。');
  }
}

function parseSeasonalIngredientSuggestionPayload(content: string) {
  const normalizedContent = extractJsonObjectCandidate(content);

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
      .slice(0, 3);
  } catch {
    throw new Error('季节食材推荐模型返回内容无法解析为有效 JSON。');
  }
}

function toDataUrl(file: { buffer: Buffer; mimetype: string }) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

function compactText(value: unknown, maxLength = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function compactList(items: unknown[] | undefined, maxItems = 4, maxItemLength = 24) {
  return (items ?? [])
    .map((item) => compactText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function getPromptIngredients(ingredients: IngredientItem[]) {
  return ingredients.slice(0, 10);
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
  recipes: RecipeRecommendation[];
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
    .slice(0, 2)
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

function normalizeGeneratedCookingSteps(
  rawSteps: Array<Partial<RecipeDetail['steps'][number]>>,
  ingredients: IngredientItem[],
) {
  const inputIngredients = buildAllowedIngredientNameSet(ingredients);
  const disallowedIngredientNames = buildDisallowedIngredientNames({}, [], inputIngredients);

  return rawSteps
    .filter((step) => step?.title && step?.description)
    .map((step, stepIndex) => ({
      id: String(step.id ?? `step_1_${stepIndex + 1}`),
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
    }));
}

function buildRecipeDetailFromSteps(
  recipe: RecipeDetailRecipeInput,
  ingredients: IngredientItem[],
  steps: RecipeDetail['steps'],
) {
  const detailIngredients = ingredients.map((ingredient) => ({
    name: ingredient.normalizedName || ingredient.name,
    quantity: normalizeChildFriendlyQuantity(ingredient.quantity || '1份'),
  }));
  const normalizedSteps = ensureIngredientOperationsInSteps(steps, detailIngredients);
  const matchedSteps = ensureRecipeNameInSteps(normalizedSteps, recipe.name);
  const totalMinutes = Math.max(1, Number(recipe.estimatedTimeMinutes ?? 20));
  const prepTimeMinutes = Math.max(1, Math.min(8, Math.round(totalMinutes * 0.35)));
  const cookTimeMinutes = Math.max(1, totalMinutes - prepTimeMinutes);

  return {
    id: recipe.id,
    name: recipe.name,
    namePinyin: recipe.namePinyin,
    englishName: recipe.englishName ?? buildFallbackEnglishName(recipe.name),
    nameLearning: buildFallbackNameLearning(recipe.name, recipe.namePinyin),
    ageRange: recipe.ageRange ?? '7-12 岁',
    difficulty: recipe.difficulty ?? 'easy',
    estimatedTimeMinutes: totalMinutes,
    fitReasons: recipe.fitReasons?.length ? recipe.fitReasons : ['适合当前食材'],
    riskAlerts: recipe.riskAlerts?.length ? recipe.riskAlerts : [],
    nutritionSummary: recipe.nutritionSummary ?? '营养搭配均衡，适合作为儿童一餐。',
    extraIngredients: [],
    canCookWithCurrentIngredients:
      typeof recipe.canCookWithCurrentIngredients === 'boolean'
        ? recipe.canCookWithCurrentIngredients
        : true,
    prepTimeMinutes,
    cookTimeMinutes,
    ingredients: detailIngredients,
    steps: matchedSteps,
  } satisfies RecipeDetail;
}

function buildRecipePlanUserPrompt(profile: ChildProfile, ingredients: IngredientItem[], userPrompt = '') {
  const promptIngredients = getPromptIngredients(ingredients);
  const ingredientLines = promptIngredients
    .map((item, index) => `${index + 1}. ${compactText(item.name, 32)}｜${compactText(item.quantity, 24)}`)
    .join('\n');
  const tastePreferences = compactList(profile.tastePreferences, 4).join('、') || '低油脂、轻口味、膳食均衡';
  const allergens = compactList(profile.allergens, 5).join('、') || '无';
  const compactUserPrompt = compactText(userPrompt, 220);

  return [
    '任务: 为儿童生成 1-2 道推荐菜谱卡片摘要，并输出严格 JSON。',
    '儿童档案:',
    `年龄:${profile.age}岁；偏好:${tastePreferences}；过敏原:${allergens}`,
    compactUserPrompt ? '用户本轮对话描述:' : '',
    compactUserPrompt,
    '现有食材清单:',
    ingredientLines,
    '生成要求:',
    '1. 只返回 1-2 道推荐菜谱摘要；优先使用现有食材，并结合用户本轮对话里的口味、场景、时间和限制条件；缺少食材尽量少。',
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
  _profile: ChildProfile,
  ingredients: IngredientItem[],
  recipe: RecipeDetailRecipeInput,
) {
  const ingredientLines = getPromptIngredients(ingredients)
    .map((item, index) => `${index + 1}. ${compactText(item.name, 32)}｜${compactText(item.quantity, 24)}`)
    .join('\n');

  const recipeLines = [
    `菜名: ${compactText(recipe.name, 40)}`,
    `风险提醒: ${compactList(recipe.riskAlerts, 3, 36).join('、') || '无'}`,
  ].join('\n');

  return [
    '为儿童生成 1 道菜的烹饪步骤。输出必须是标准 JSON 对象，第一字符必须是 {，最后字符必须是 }。',
    '允许使用食材清单:',
    ingredientLines,
    '菜谱卡片:',
    recipeLines,
    '规则:',
    '1. 只输出 {"steps":[...]}，不要返回食材清单、用户档案、口味偏好、菜谱摘要、营养摘要、时间、图片或额外说明。',
    `2. steps 必须全部围绕“${recipe.name}”制作，禁止改成其他菜谱、其他主食或相似菜。`,
    '3. steps 里的 title、description、tip、childAction、expectedResult 只能出现“允许使用食材清单”中的食材，禁止新增盐、油、糖、葱姜蒜、酱油、牛奶、面粉等未传入食材。',
    '4. 水、锅、碗、炉具、刀具等可以作为操作工具或介质描述；调味料必须在允许食材清单中才可使用。',
    '5. steps 4-8 步，每步写清本步骤食材和关键动作，适合卡通分镜。',
    '6. description 采用“本步骤食材：A、B；操作：……”格式，说明食材在哪一步加入和怎么处理。',
    `7. 最后一步 expectedResult 必须明确写出“完成${recipe.name}”。`,
    '8. 如果无法用允许食材清单为该菜名生成一致步骤，返回 {"steps":[]}，不要编造其他菜谱。',
    '9. 每步包含 title,description,tip,childAction,parentAction,expectedResult,riskLevel,requiresParentAssist。',
    '10. 涉及开水、热锅、明火、电器、刀具时 riskLevel=medium/high，requiresParentAssist=true，parentAction 写家长全程陪同或由家长操作。',
    '11. JSON 字符串必须使用双引号；不要使用单引号、注释、尾随逗号、代码块标记。',
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
  const childContext = compactText(input.childContext, 80);

  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童时令蔬果推荐器。任务：输出 3 种当前季节适合小朋友食用的蔬菜或水果品种。只输出一个标准 JSON 对象：{"suggestions":[{"name":"蔬菜或水果名","reason":"8字内"}]}。禁止输出菜名、饮品、零食、解释文字、Markdown。',
    },
    {
      role: 'user',
      content: [
        `月份:${month}`,
        `季节:${seasonHint}`,
        `儿童:${childContext || '小学生，低油轻口味，营养均衡'}`,
        '要求: 只给3个蔬菜或水果品种；名称短；适合儿童；避开辛辣、高糖、高油。',
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
        '你是儿童烹饪菜谱智能体。请根据儿童档案和现有食材，生成 1-2 个安全、适龄、简单易上手的儿童菜谱推荐卡片摘要。操作者多为小学阶段儿童，优先选择低油、轻口味、步骤清楚、亲子可执行的菜谱；如涉及明火、天然气灶、电磁炉、微波炉、烤箱、空气炸锅、蒸锅、热锅、热油、开水或锋利刀具，riskAlerts 必须高亮提醒“需家长全程陪同”。如现有食材含花生、坚果、虾、蟹、贝类、海鲜、鱼、牛奶、乳制品、鸡蛋、小麦、大豆、芝麻等高危过敏原食材，riskAlerts 必须增加以“高危过敏原提醒：”开头的提醒。输出严格 JSON：{"recipes":[{"name":"菜名","namePinyin":"带声调拼音","englishName":"自然英文菜名","nameLearning":{"characters":[{"character":"菜","pinyin":"cài","strokes":11,"structure":"上下结构","hint":"儿童可理解的一句话"}]},"ageRange":"7-12 岁","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"fitReasons":["原因"],"riskAlerts":["提醒"],"nutritionSummary":"一句话","extraIngredients":["缺少食材"],"canCookWithCurrentIngredients":true}]}。不要输出 steps、ingredients、imageUrl、imageSearchQuery 或额外说明。',
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
        '你是儿童菜谱步骤生成器。只为用户指定菜名生成烹饪步骤，禁止改菜名、换菜谱、换主食或生成相似菜。烹饪步骤只能使用用户传入的允许食材清单，禁止添加任何未传入食材或调味料。必须只输出一个可被 JSON.parse 解析的标准 JSON 对象，禁止 Markdown、注释、前后说明、单引号、尾随逗号。固定结构：{"steps":[{"title":"步骤标题","description":"本步骤食材：A；操作：具体动作。","tip":"安全提示","childAction":"孩子可做动作","parentAction":"家长协助动作","expectedResult":"完成状态","riskLevel":"low","requiresParentAssist":false}]}。riskLevel 只能是 "low"、"medium"、"high"，requiresParentAssist 只能是布尔值 true 或 false。',
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

  const stepsPayload = parseRecipeStepsPayload(content);
  if (stepsPayload.sourceRecipeName && !hasSameRecipeName(stepsPayload.sourceRecipeName, recipe.name)) {
    throw new Error(`菜谱详情生成失败，返回菜谱与“${recipe.name}”不一致。`);
  }

  const rawSteps = stepsPayload.steps;
  const steps = normalizeGeneratedCookingSteps(rawSteps, ingredients);

  if (steps.length === 0) {
    throw new Error(`菜谱详情生成失败，未返回“${recipe.name}”的有效烹饪步骤。`);
  }

  return buildRecipeDetailFromSteps(recipe, ingredients, steps);
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

  const generatedDetails = await Promise.all(
    missingRecipes.map((recipe) => generateRecipeDetail(profile, ingredients, recipe)),
  );

  return [...catalogDetails, ...generatedDetails];
}

export async function generateCookingFeedback(input: {
  profile: ChildProfile;
  recipe: RecipeDetail;
  tasteFeedback: string;
  difficultyFeedback: string;
}) {
  const compactFeedbackInput = [
    `儿童:${input.profile.age}岁；偏好:${compactList(input.profile.tastePreferences, 3).join('、') || '无'}`,
    `菜谱:${compactText(input.recipe.name, 40)}；难度:${input.recipe.difficulty}`,
    `口味反馈:${compactText(input.tasteFeedback, 80) || '无'}`,
    `困难反馈:${compactText(input.difficultyFeedback, 80) || '无'}`,
  ].join('\n');

  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童烹饪应用的鼓励式点评助手。根据简短反馈输出严格 JSON：{"praise":"一句鼓励","improvement":"一句改进建议","nextSuggestion":"一句下一次建议"}。语气温和具体，不要输出额外说明。',
    },
    {
      role: 'user',
      content: compactFeedbackInput,
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
