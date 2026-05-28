import {
  normalizeChildFriendlyQuantity,
  normalizeIngredientName,
  recipeCatalog,
  type ChildProfile,
  type IngredientItem,
  type IngredientKnowledge,
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
  timeoutMs?: number;
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

async function readSiliconFlowStream(response: Response) {
  if (!response.body) {
    return { content: '', usage: null as Record<string, unknown> | null, finishReason: null as string | null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rawContent = '';
  let content = '';
  let usage: Record<string, unknown> | null = null;
  let finishReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    rawContent += chunk;
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) {
        continue;
      }

      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      try {
        const payload = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string; reasoning_content?: string };
            message?: { content?: string };
            finish_reason?: string | null;
          }>;
          usage?: Record<string, unknown>;
        };
        content += payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? '';
        finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
        usage = payload.usage ?? usage;
      } catch {
        // Ignore malformed event fragments and continue reading the stream.
      }
    }
  }

  if (!content && rawContent.trim()) {
    try {
      const payload = JSON.parse(rawContent) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
        usage?: Record<string, unknown>;
      };
      content = payload.choices?.[0]?.message?.content?.trim() ?? '';
      finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
      usage = payload.usage ?? usage;
    } catch {
      // Keep the streamed content collected so far.
    }
  }

  return { content: content.trim(), usage, finishReason };
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
    const controller = options.timeoutMs ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    try {
      const response = await fetch(SILICONFLOW_API_URL, {
        method: 'POST',
        signal: controller?.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: route.stream,
          enable_thinking: route.enableThinking,
          temperature: route.temperature,
          max_tokens: options.maxTokens ?? route.maxTokens,
        }),
      });
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

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

      let content = '';
      let finishReason: string | null = null;
      let usage: Record<string, unknown> | null = null;
      if (route.stream) {
        const streamPayload = await readSiliconFlowStream(response);
        content = streamPayload.content;
        finishReason = streamPayload.finishReason;
        usage = streamPayload.usage;
      } else {
        const payload = await response.json() as {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: Record<string, unknown>;
        };
        content = payload.choices?.[0]?.message?.content?.trim() ?? '';
        finishReason = payload.choices?.[0]?.finish_reason ?? null;
        usage = payload.usage ?? null;
      }

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
        usage,
        metadata: options.metadata ?? {},
        logFile: getLocalLlmLogFilePath(),
      });

      return content;
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
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

function repairJsonObjectCandidate(content: string) {
  return content
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

function compactStringArray(value: unknown, limit: number) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function parseIngredientKnowledge(content: string, fallbackName: string): IngredientKnowledge {
  const candidate = repairJsonObjectCandidate(extractJsonObjectCandidate(content));
  const parsed = JSON.parse(candidate) as Partial<IngredientKnowledge>;
  const nutritionValues = compactStringArray(parsed.nutritionValues, 4);
  const bestPairings = compactStringArray(parsed.bestPairings, 5);

  return {
    name: String(parsed.name ?? fallbackName).trim().slice(0, 30) || fallbackName,
    nutritionValues: nutritionValues.length ? nutritionValues : ['富含对成长有帮助的营养成分'],
    origin: String(parsed.origin ?? '常见于多个适宜种植地区。').trim().slice(0, 120),
    growingClimate: String(parsed.growingClimate ?? '喜欢温和、阳光和水分适中的生长环境。').trim().slice(0, 140),
    bestPairings: bestPairings.length ? bestPairings : ['鸡蛋', '豆腐', '米饭'],
    kidFact: String(parsed.kidFact ?? '认识食材能帮助小朋友更会选择健康食物。').trim().slice(0, 140),
    safetyNote: String(parsed.safetyNote ?? '食用前要清洗干净，如有明确过敏史需避免食用。').trim().slice(0, 140),
  };
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

function extractObjectsFromArrayByKey<T>(content: string, key: string) {
  const keyIndex = content.indexOf(`"${key}"`);
  if (keyIndex === -1) {
    return [];
  }

  const arrayStartIndex = content.indexOf('[', keyIndex);
  if (arrayStartIndex === -1) {
    return [];
  }

  const results: T[] = [];
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
          results.push(JSON.parse(repairJsonObjectCandidate(candidate)) as T);
        } catch {
          // Skip incomplete or malformed objects.
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
  const normalizedContent = extractJsonObjectCandidate(content);

  try {
    const parsed = JSON.parse(repairJsonObjectCandidate(normalizedContent)) as
      | { recipes?: Array<Partial<RecipeDetail>> }
      | Array<Partial<RecipeDetail>>;
    if (Array.isArray(parsed)) {
      return { recipes: parsed };
    }

    return parsed;
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
    const parsed = JSON.parse(repairJsonObjectCandidate(normalizedContent)) as
      | {
          steps?: Array<Partial<RecipeDetail['steps'][number]>>;
          recipes?: Array<{ name?: unknown; steps?: Array<Partial<RecipeDetail['steps'][number]>> }>;
        }
      | Array<Partial<RecipeDetail['steps'][number]>>;
    if (Array.isArray(parsed)) {
      return {
        sourceRecipeName: '',
        steps: parsed,
      };
    }

    const sourceRecipeName = parsed.recipes?.[0]?.name;
    const steps = Array.isArray(parsed.steps) ? parsed.steps : parsed.recipes?.[0]?.steps;
    return {
      sourceRecipeName: typeof sourceRecipeName === 'string' ? sourceRecipeName : '',
      steps: Array.isArray(steps) ? steps : [],
    };
  } catch {
    const salvagedSteps = extractObjectsFromArrayByKey<Partial<RecipeDetail['steps'][number]>>(
      normalizedContent,
      'steps',
    );
    if (salvagedSteps.length > 0) {
      return {
        sourceRecipeName: '',
        steps: salvagedSteps,
      };
    }

    throw new Error('菜谱步骤模型返回内容无法解析为有效 JSON。');
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

function translatePromptTerm(value: string) {
  const dictionary: Record<string, string> = {
    低油脂: 'low oil',
    低油: 'low oil',
    轻口味: 'mild flavor',
    清淡: 'mild flavor',
    膳食均衡: 'balanced meals',
    维生素丰富: 'vitamin-rich',
    搭配均衡: 'balanced ingredient pairing',
    低盐: 'low salt',
    无: 'none',
  };

  return dictionary[value] ?? value;
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

function buildFallbackEnglishName(_name: string) {
  return 'Kids Recipe';
}

function sanitizeEnglishName(value: unknown, recipeName: string) {
  const englishName = String(value ?? '').trim();
  if (!englishName || englishName.includes(recipeName) || /[\u4e00-\u9fa5]/.test(englishName)) {
    return buildFallbackEnglishName(recipeName);
  }

  return englishName.slice(0, 80);
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

interface GenerationLocaleOptions {
  locale?: 'zh' | 'en';
  pinyinMode?: boolean;
}

function normalizeGeneratedRecipeSummaries(
  payload: {
    recipes?: Array<Partial<RecipeRecommendation>>;
  },
  profile: ChildProfile,
  options: GenerationLocaleOptions = {},
) {
  const recipes = (payload.recipes ?? [])
    .slice(0, 3)
    .filter((recipe) => recipe.name)
    .map((recipe, index) => {
      const name = String(recipe.name);
      const namePinyin = options.pinyinMode === false
        ? ''
        : String((recipe as { namePinyin?: string }).namePinyin ?? '');

      return {
        id: `recipe_gen_summary_${slugifyRecipeName(name)}_${index + 1}`,
        name,
        namePinyin,
        englishName: sanitizeEnglishName(recipe.englishName, name),
        nameLearning: options.pinyinMode === false ? { characters: [] } : normalizeNameLearning(recipe, name, namePinyin),
        ageRange: String(recipe.ageRange ?? `${Math.max(3, profile.age - 1)}-${profile.age + 3} 岁`),
        difficulty: recipe.difficulty === 'hard' || recipe.difficulty === 'medium' ? recipe.difficulty : 'easy',
        estimatedTimeMinutes: Math.max(1, Number(recipe.estimatedTimeMinutes ?? 20)),
        fitReasons: [],
        riskAlerts: Array.isArray(recipe.riskAlerts) ? recipe.riskAlerts.map(String).slice(0, 3) : [],
        nutritionSummary: String(recipe.nutritionSummary ?? '营养搭配均衡，适合作为儿童一餐。'),
        extraIngredients: [],
        canCookWithCurrentIngredients:
          typeof recipe.canCookWithCurrentIngredients === 'boolean'
            ? recipe.canCookWithCurrentIngredients
            : false,
      } satisfies RecipeRecommendation;
    })
    .filter((recipe) => recipe.name);

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
  locale: GenerationLocaleOptions['locale'] = 'zh',
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
  const isEnglish = locale === 'en';
  const missingNamesText = missingIngredientNames.join(isEnglish ? ', ' : '、');

  return steps.map((step, index) => {
    if (index !== fallbackStepIndex) {
      return step;
    }

    return {
      ...step,
      description: isEnglish
        ? `${step.description} Extra ingredient action: wash or organize ${missingNamesText}, cut it smaller if needed, and add it during this step.`
        : `${step.description} 补充食材操作：把${missingNamesText}清洗或整理好，需要时切小，再按这一步一起加入。`,
      childAction: isEnglish
        ? `${step.childAction} Also confirm ${missingNamesText} is ready and placed near the work area.`
        : `${step.childAction} 也要确认${missingNamesText}已经准备好并放到操作台旁。`,
      expectedResult: isEnglish
        ? `${step.expectedResult} ${missingNamesText} has also been washed, organized, or added.`
        : `${step.expectedResult} ${missingNamesText}也完成清洗、整理或加入。`,
    };
  });
}

function ensureRecipeNameInSteps(
  steps: RecipeDetail['steps'],
  recipeName: string,
  locale: GenerationLocaleOptions['locale'] = 'zh',
) {
  if (steps.length === 0 || !recipeName.trim()) {
    return steps;
  }

  if (steps.some((step) => getRecipeStepText(step).includes(recipeName))) {
    return steps;
  }

  const lastStepIndex = steps.length - 1;
  const isEnglish = locale === 'en';

  return steps.map((step, index) => {
    if (index === 0) {
      return {
        ...step,
        description: isEnglish ? `Make ${recipeName}: ${step.description}` : `制作${recipeName}：${step.description}`,
      };
    }

    if (index === lastStepIndex) {
      return {
        ...step,
        expectedResult: isEnglish
          ? `${step.expectedResult || 'After this step, check the final color, texture, and temperature.'} The finished dish is ${recipeName}.`
          : `${step.expectedResult || '完成这一步后观察成品状态。'} 完成后就是${recipeName}。`,
      };
    }

    return step;
  });
}

function normalizeGeneratedCookingSteps(
  rawSteps: Array<Partial<RecipeDetail['steps'][number]>>,
  ingredients: IngredientItem[],
  options: GenerationLocaleOptions = {},
) {
  const inputIngredients = buildAllowedIngredientNameSet(ingredients);
  const disallowedIngredientNames = buildDisallowedIngredientNames({}, [], inputIngredients);
  const isEnglish = options.locale === 'en';

  return rawSteps
    .filter((step) => step?.title && step?.description)
    .map((step, stepIndex) => ({
      id: String(step.id ?? `step_1_${stepIndex + 1}`),
      title: removeDisallowedIngredientMentions(String(step.title), disallowedIngredientNames),
      description: removeDisallowedIngredientMentions(String(step.description), disallowedIngredientNames),
      tip: removeDisallowedIngredientMentions(
        String(step.tip ?? (isEnglish ? 'Go slowly and check safety before starting.' : '慢慢来，先确认安全再动手。')),
        disallowedIngredientNames,
      ),
      childAction: removeDisallowedIngredientMentions(
        String((step as { childAction?: string }).childAction ?? step.description ?? ''),
        disallowedIngredientNames,
      ),
      parentAction: removeDisallowedIngredientMentions(
        String(
          (step as { parentAction?: string }).parentAction ??
            (step.requiresParentAssist
              ? isEnglish
                ? 'A parent should stay nearby and complete this part together.'
                : '这一小步建议家长在旁边陪着一起完成。'
              : ''),
        ),
        disallowedIngredientNames,
      ),
      expectedResult: removeDisallowedIngredientMentions(String(
        (step as { expectedResult?: string }).expectedResult ??
          (isEnglish
            ? 'After this step, pause and check whether the ingredient color, shape, or texture has changed.'
            : '完成这一步后，先停下来看看食材颜色和形状有没有变化。'),
      ), disallowedIngredientNames),
      riskLevel: normalizeRiskLevel(String(step.riskLevel ?? 'medium')),
      requiresParentAssist: Boolean(step.requiresParentAssist),
    }));
}

function buildRecipeDetailFromSteps(
  recipe: RecipeDetailRecipeInput,
  ingredients: IngredientItem[],
  steps: RecipeDetail['steps'],
  options: GenerationLocaleOptions = {},
) {
  const isEnglish = options.locale === 'en';
  const detailIngredients = ingredients.map((ingredient) => ({
    name: ingredient.normalizedName || ingredient.name,
    quantity: normalizeChildFriendlyQuantity(ingredient.quantity || '1份'),
  }));
  const normalizedSteps = ensureIngredientOperationsInSteps(steps, detailIngredients, options.locale);
  const matchedSteps = ensureRecipeNameInSteps(normalizedSteps, recipe.name, options.locale);
  const totalMinutes = Math.max(1, Number(recipe.estimatedTimeMinutes ?? 20));
  const prepTimeMinutes = Math.max(1, Math.min(8, Math.round(totalMinutes * 0.35)));
  const cookTimeMinutes = Math.max(1, totalMinutes - prepTimeMinutes);

  return {
    id: recipe.id,
    name: recipe.name,
    namePinyin: recipe.namePinyin,
    englishName: sanitizeEnglishName(recipe.englishName, recipe.name),
    nameLearning: buildFallbackNameLearning(recipe.name, recipe.namePinyin),
    ageRange: recipe.ageRange ?? '7-12 岁',
    difficulty: recipe.difficulty ?? 'easy',
    estimatedTimeMinutes: totalMinutes,
    fitReasons: recipe.fitReasons?.length ? recipe.fitReasons : [isEnglish ? 'Fits the current ingredients' : '适合当前食材'],
    riskAlerts: recipe.riskAlerts?.length ? recipe.riskAlerts : [],
    nutritionSummary: recipe.nutritionSummary ?? (isEnglish ? 'Balanced and suitable for a kid-friendly meal.' : '营养搭配均衡，适合作为儿童一餐。'),
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

function buildRecipePlanUserPrompt(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  userPrompt = '',
  options: GenerationLocaleOptions = {},
) {
  const promptIngredients = getPromptIngredients(ingredients);
  const ingredientLines = promptIngredients
    .map((item, index) =>
      options.locale === 'en'
        ? `${index + 1}. ${compactText(item.name, 20)} (${compactText(item.quantity, 12)})`
        : `${index + 1}.${compactText(item.name, 20)}(${compactText(item.quantity, 12)})`,
    )
    .join('\n');
  const compactUserPrompt = compactText(userPrompt, 120);
  const isEnglish = options.locale === 'en';
  const outputLanguage = isEnglish ? 'English' : '简体中文';
  const tastePreferences = compactList(profile.tastePreferences, 3, 12)
    .map((item) => (isEnglish ? translatePromptTerm(item) : item))
    .join(isEnglish ? ', ' : '、') || (isEnglish ? 'low oil, mild flavor, balanced meals' : '低油、轻口味、均衡');
  const allergens = compactList(profile.allergens, 4, 12)
    .map((item) => (isEnglish ? translatePromptTerm(item) : item))
    .join(isEnglish ? ', ' : '、') || (isEnglish ? 'none' : '无');
  const pronunciationRule = isEnglish
    ? options.pinyinMode === false
      ? 'Pronunciation help off: set namePinyin to an empty string and nameLearning.characters to an empty array.'
      : 'Pronunciation help on: namePinyin must be English word syllables separated by hyphens or spaces, such as "to-ma-to egg soup"; nameLearning must split English words, with pinyin storing the word syllables.'
    : options.pinyinMode === false
      ? '读音辅助关闭:namePinyin输出空字符串；nameLearning.characters输出空数组。'
      : '读音辅助开启:namePinyin输出中文菜名带声调拼音；nameLearning按中文单字拆分，提供拼音、笔画、结构和识字提示。';

  if (isEnglish) {
    return [
      `Generate 3 recipe cards for elementary-school children. Return only a JSON object. Output language: ${outputLanguage}.`,
      'English mode: name must be an English recipe name; englishName must match name or be a natural English title; do not put Chinese text in any output field.',
      pronunciationRule,
      `Child age: ${profile.age}; preferences: ${tastePreferences}; allergens: ${allergens}.`,
      compactUserPrompt ? `User note: ${compactUserPrompt}` : '',
      `Ingredients:\n${ingredientLines}`,
      'Rules: return exactly 3 recipes; keep them simple, low-oil, mild, and nutritionally balanced; prioritize the provided ingredients; do not generate cooking steps or ingredient details.',
      'Safety: only include riskAlerts for open flame, high heat, hot oil, stir-frying, pressure cooking, steaming, boiling, oven use, or severe allergen risk.',
      'Allowed fields only: name,namePinyin,englishName,nameLearning,ageRange,difficulty,estimatedTimeMinutes,riskAlerts,nutritionSummary,canCookWithCurrentIngredients.',
      'Forbidden fields: steps,ingredients,fitReasons,extraIngredients,imageUrl,prepTimeMinutes,cookTimeMinutes.',
    ].join('\n');
  }

  return [
    `为小学生生成3道菜谱卡片，只返回JSON对象。输出语言:${outputLanguage}。`,
    isEnglish ? '英文模式:name使用英文菜名；englishName与name一致或保留英文名；中文内容不要混入字段值。' : '中文模式:name使用中文菜名；englishName输出英文译名。',
    pronunciationRule,
    `儿童:${profile.age}岁；偏好:${tastePreferences}；过敏:${allergens}`,
    compactUserPrompt ? `用户:${compactUserPrompt}` : '',
    `食材:${ingredientLines}`,
    '规则:必须返回3道；简单、低油轻口味、营养均衡；优先用现有食材；不要生成烹饪步骤或配料明细。',
    '安全:仅明火/高温/热油/爆炒/高压/蒸煮/烤箱等高风险操作写riskAlerts；高危过敏原才写高危提醒。',
    '只允许字段:name,namePinyin,englishName,nameLearning,ageRange,difficulty,estimatedTimeMinutes,riskAlerts,nutritionSummary,canCookWithCurrentIngredients。',
    '禁止字段:steps,ingredients,fitReasons,extraIngredients,imageUrl,prepTimeMinutes,cookTimeMinutes。',
  ].join('\n');
}

function buildRecipeDetailUserPrompt(
  _profile: ChildProfile,
  ingredients: IngredientItem[],
  recipe: RecipeDetailRecipeInput,
  options: GenerationLocaleOptions = {},
) {
  const isEnglish = options.locale === 'en';
  const ingredientLines = getPromptIngredients(ingredients)
    .map((item, index) =>
      isEnglish
        ? `${index + 1}. ${compactText(item.name, 20)} (${compactText(item.quantity, 12)})`
        : `${index + 1}.${compactText(item.name, 20)}(${compactText(item.quantity, 12)})`,
    )
    .join('\n');

  const recipeLines = [
    isEnglish ? `Recipe name: ${compactText(recipe.name, 32)}` : `菜名:${compactText(recipe.name, 32)}`,
    isEnglish
      ? `Safety notes: ${compactList(recipe.riskAlerts, 2, 24).join('; ') || 'none'}`
      : `风险:${compactList(recipe.riskAlerts, 2, 24).join('、') || '无'}`,
  ].join('\n');
  const outputLanguage = isEnglish ? 'English' : '简体中文';
  const pronunciationRule = isEnglish
    ? options.pinyinMode === false
      ? 'Pronunciation help is off: do not include pinyin, syllables, or pronunciation notes in any step.'
      : 'Pronunciation help is on: if pronunciation is mentioned, use English word syllables only; do not use Chinese pinyin.'
    : options.pinyinMode === false
      ? '读音辅助关闭:步骤中不要加入拼音或音节说明。'
      : '读音辅助开启:如需要提及菜名读音，使用带声调中文拼音。';

  if (isEnglish) {
    return [
      `Generate detailed, executable cooking steps for the specified recipe. Return only a JSON object. Output language: ${outputLanguage}.`,
      pronunciationRule,
      `Allowed ingredients:\n${ingredientLines}`,
      `Recipe:\n${recipeLines}`,
      'Rules:',
      `1. steps must make "${recipe.name}". Do not switch to another dish, staple food, or similar recipe.`,
      '2. Use only the allowed ingredients. Water, pots, bowls, knives, and heating appliances may be used as tools. Do not add unlisted salt, oil, sugar, scallion, ginger, garlic, soy sauce, milk, or flour.',
      '3. Usually return 5-8 steps in real cooking order: prepare tools, wash, cut, mix, cook or plate, check doneness, finish.',
      '4. Each description must start with "Step ingredients: A, B; Action: ...". The action part should contain 3-5 short sentences covering handling, when to add ingredients, stirring or placement, and the finished state.',
      '5. tip must be one concrete cooking point, such as size, thickness, heat level, stirring frequency, color or softness change, temperature check, or anti-slip/anti-burn reminder.',
      '6. childAction must describe a hands-on task a child can do. Do not only say wait/watch. For high-risk steps, the child can stand back, read the step, or prepare plates.',
      '7. parentAction is only for open flame, high heat, hot oil, stir-frying, pressure cooking, steaming/boiling, oven, or boiling water. For low-risk steps, write "watch nearby".',
      '8. Each step may be used as subtitles for a child-friendly cartoon cooking video, so title should be short and description should work as narration.',
      `9. The final step expectedResult must say "Finish ${recipe.name}". Every step must include: title, description, tip, childAction, parentAction, expectedResult, riskLevel, requiresParentAssist.`,
      '10. If you cannot keep the recipe and ingredients consistent, return {"steps":[]}. Do not explain. Use double quotes for JSON.',
      '11. Do not return recipe card fields such as name, englishName, nameLearning, ageRange, difficulty, estimatedTimeMinutes, nutritionSummary, ingredients, imageUrl, fitReasons, or extraIngredients.',
    ].join('\n');
  }

  return [
    `为指定菜名生成详细、可执行的儿童烹饪步骤，只返回JSON对象。输出语言:${outputLanguage}。`,
    pronunciationRule,
    `允许食材:${ingredientLines}`,
    `菜谱:${recipeLines}`,
    '规则:',
    `1.steps必须制作“${recipe.name}”，禁止换菜名/主食/相似菜。`,
    '2.只能使用允许食材；水/锅/碗/刀具/炉具可作为工具；未列出的盐油糖葱姜蒜酱油牛奶面粉都禁止。',
    '3.steps通常5-8步，按真实烹饪顺序拆分：准备工具/清洗/切配/调和/入锅或装盘/成熟判断/收尾。',
    '4.description固定为“本步骤食材：A、B；操作：……”，操作部分写3-5句短句，必须包含：处理动作、加入时机、搅拌或摆放方式、完成状态。',
    '5.tip写一个具体烹饪要点，如大小厚薄、火候距离、搅拌频率、颜色/软硬变化、试温或防滑防烫提醒。',
    '6.childAction写小朋友能亲手参与的具体动作，不要只写等待/观察；高风险步骤可写站远观察、读步骤、准备餐盘。',
    '7.parentAction仅在明火、高温、热油、爆炒、高压、蒸煮、烤箱、开水等高风险操作中写家长完成的动作；低风险步骤写“在旁边看护”。',
    '8.每步内容将用于生成儿童卡通烹饪视频字幕，请让title适合做短字幕，description适合拆成视频旁白。',
    `9.最后一步 expectedResult 写“完成${recipe.name}”；每步必填:title,description,tip,childAction,parentAction,expectedResult,riskLevel,requiresParentAssist。`,
    '10.无法一致生成则返回{"steps":[]}；不要解释；JSON用双引号。',
    '11.不要返回菜谱卡字段:name,englishName,nameLearning,ageRange,difficulty,estimatedTimeMinutes,nutritionSummary,ingredients,imageUrl,fitReasons,extraIngredients。',
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

export async function generateRecipePlan(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  userPrompt = '',
  options: GenerationLocaleOptions = {},
) {
  const isEnglish = options.locale === 'en';
  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        isEnglish
          ? 'Kid recipe recommendation. Return only JSON parseable by JSON.parse. No Markdown, code fences, explanations, prefixes, or suffixes. Output language: English. Return exactly 3 recipes. Shape: {"recipes":[{"name":"","namePinyin":"","englishName":"","nameLearning":{"characters":[{"character":"","pinyin":"","strokes":1,"structure":"","hint":""}]},"ageRange":"7-12 years","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"riskAlerts":[],"nutritionSummary":"","canCookWithCurrentIngredients":true}]}. Do not output fitReasons, extraIngredients, steps, ingredients, imageUrl, prepTimeMinutes, or cookTimeMinutes.'
          : `儿童菜谱推荐。只返回可被 JSON.parse 解析的 JSON 对象，不要 Markdown、代码块、解释、前后缀文字。输出语言:简体中文。必须返回3道菜。格式：{"recipes":[{"name":"","namePinyin":"","englishName":"","nameLearning":{"characters":[{"character":"","pinyin":"","strokes":1,"structure":"","hint":""}]},"ageRange":"7-12 岁","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"riskAlerts":[],"nutritionSummary":"","canCookWithCurrentIngredients":true}]}。禁止输出fitReasons、extraIngredients、steps、ingredients、imageUrl、prepTimeMinutes、cookTimeMinutes。`,
    },
    {
      role: 'user',
      content: buildRecipePlanUserPrompt(profile, ingredients, userPrompt, options),
    },
  ], {
    operation: 'generate_recipe_plan',
    task: 'recipe_recommendation',
    timeoutMs: 30000,
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
      locale: options.locale ?? 'zh',
      pinyinMode: options.pinyinMode ?? true,
    },
  });

  return normalizeGeneratedRecipeSummaries(
    parseRecipePlanPayload(content),
    profile,
    options,
  );
}

export async function generateRecipeDetail(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  recipe: RecipeDetailRecipeInput,
  options: GenerationLocaleOptions = {},
) {
  const isEnglish = options.locale === 'en';
  const catalogRecipe = recipeCatalog.find((item) => item.id === recipe.id && hasSameRecipeName(item.name, recipe.name));
  if (catalogRecipe) {
    return catalogRecipe;
  }

  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        isEnglish
          ? 'Kids cooking step generator. Return only JSON: {"steps":[{"title":"","description":"Step ingredients: A; Action: First ... Then ... Next ... It is done when ...","tip":"","childAction":"","parentAction":"","expectedResult":"","riskLevel":"low|medium|high","requiresParentAssist":false}]}. No Markdown, explanations, recipe card fields, ingredient table, imageUrl, or extra wrapper.'
          : '儿童菜谱步骤生成。只返回JSON:{"steps":[{"title":"","description":"本步骤食材：A；操作：先……。再……。接着……。看到……就完成。","tip":"","childAction":"","parentAction":"","expectedResult":"","riskLevel":"low|medium|high","requiresParentAssist":false}]}。不要Markdown、解释、菜谱卡字段、配料表、imageUrl或额外包裹字段。',
    },
    {
      role: 'user',
      content: buildRecipeDetailUserPrompt(profile, ingredients, recipe, options),
    },
  ], {
    operation: 'generate_recipe_detail',
    task: 'recipe_steps',
    timeoutMs: 30000,
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
      locale: options.locale ?? 'zh',
      pinyinMode: options.pinyinMode ?? true,
    },
  });

  const stepsPayload = parseRecipeStepsPayload(content);
  if (stepsPayload.sourceRecipeName && !hasSameRecipeName(stepsPayload.sourceRecipeName, recipe.name)) {
    throw new Error(`菜谱详情生成失败，返回菜谱与“${recipe.name}”不一致。`);
  }

  const rawSteps = stepsPayload.steps;
  const steps = normalizeGeneratedCookingSteps(rawSteps, ingredients, options);

  if (steps.length === 0) {
    throw new Error(`菜谱详情生成失败，未返回“${recipe.name}”的有效烹饪步骤。`);
  }

  return buildRecipeDetailFromSteps(recipe, ingredients, steps, options);
}

export async function generateRecipeDetails(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  recipes: RecipeRecommendation[],
  options: GenerationLocaleOptions = {},
) {
  const catalogDetails = recipes
    .map((recipe) => recipeCatalog.find((item) => item.id === recipe.id && hasSameRecipeName(item.name, recipe.name)))
    .filter((recipe): recipe is RecipeDetail => Boolean(recipe));
  const missingRecipes = recipes.filter((recipe) => !catalogDetails.some((detail) => detail.id === recipe.id));

  if (missingRecipes.length === 0) {
    return catalogDetails;
  }

  const generatedDetails = await Promise.all(
    missingRecipes.map((recipe) => generateRecipeDetail(profile, ingredients, recipe, options)),
  );

  return [...catalogDetails, ...generatedDetails];
}

export async function generateIngredientKnowledge(name: string, options: GenerationLocaleOptions = {}) {
  const ingredientName = compactText(normalizeIngredientName(name), 30);
  if (!ingredientName) {
    throw new Error(options.locale === 'en' ? 'Please provide an ingredient name.' : '请提供要查询的食材名称。');
  }

  const isEnglish = options.locale === 'en';
  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        isEnglish
          ? 'You are a kid-friendly ingredient encyclopedia agent. Explain one ingredient for elementary-school children in accurate, short, easy English. Return strict JSON only. Do not output Markdown or extra text. Required JSON shape: {"name":"ingredient name in English","nutritionValues":["nutrition value 1","nutrition value 2","nutrition value 3"],"origin":"common origin or source","growingClimate":"suitable growing climate","bestPairings":["pairing ingredient 1","pairing ingredient 2","pairing ingredient 3"],"kidFact":"one fun kid-friendly fact","safetyNote":"one washing, allergy, or eating safety note"}.'
          : '你是儿童食材百科智能体。面向小学阶段儿童，用准确、简短、容易理解的中文介绍一种食材。只输出严格 JSON，不要 Markdown，不要额外说明。JSON 字段必须为：{"name":"食材名","nutritionValues":["营养价值1","营养价值2","营养价值3"],"origin":"常见产地或来源","growingClimate":"适宜生长气候","bestPairings":["搭配食材1","搭配食材2","搭配食材3"],"kidFact":"一句有趣小知识","safetyNote":"一句清洗、过敏或食用安全提醒"}。',
    },
    {
      role: 'user',
      content: isEnglish
        ? `Ingredient: ${ingredientName}\nRequirements: nutritionValues up to 4 items; bestPairings up to 5 items; each sentence under 18 English words; suitable for kids to read; all field values must be English.`
        : `食材：${ingredientName}\n要求：营养价值最多4条；搭配食材最多5个；每句话不超过28个中文字符；适合小朋友阅读。`,
    },
  ], {
    operation: 'generate_ingredient_knowledge',
    task: 'ingredient_knowledge',
    routeContext: {
      userPrompt: ingredientName,
    },
    metadata: {
      ingredientName,
      locale: options.locale ?? 'zh',
    },
    maxTokens: 520,
    timeoutMs: 30_000,
  });

  return parseIngredientKnowledge(content, ingredientName);
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
