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
import { recordLlmCallMetric } from './llmMetrics.js';
import { modelRouter, type ModelRouteContext, type ModelTask } from './modelRouter.js';

const SILICONFLOW_API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const recipeRecommendationPromptVersion = 'compact-v1';
const recipeStepsPromptVersion = 'guided-v3';

interface SiliconFlowMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}

export interface SiliconFlowCallMetrics {
  operation: string;
  task: ModelTask;
  model: string;
  fallback: boolean;
  success: boolean;
  durationMs: number;
  totalDurationMs: number;
  status?: number;
  error?: string;
  usage?: Record<string, unknown> | null;
  finishReason?: string | null;
  metadata?: Record<string, unknown>;
}

interface SiliconFlowCallOptions {
  operation: string;
  task: ModelTask;
  routeContext?: ModelRouteContext;
  metadata?: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
  modelOverride?: string;
  onMetrics?: (metrics: SiliconFlowCallMetrics) => void;
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
  const models = [
    options.modelOverride?.trim() || route.model,
    ...(options.modelOverride ? [] : route.fallbackModels),
  ].filter((model, index, items) => model && items.indexOf(model) === index);

  if (!apiKey) {
    writeLocalJsonLog({
      type: 'llm_call',
      operation: options.operation,
      task: options.task,
      model: route.model,
      modelOverride: options.modelOverride,
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
      const requestBody: Record<string, unknown> = {
        model,
        messages,
        stream: route.stream,
        temperature: route.temperature,
        max_tokens: options.maxTokens ?? route.maxTokens,
      };
      if (route.supportsEnableThinkingParameter !== false) {
        requestBody.enable_thinking = route.enableThinking;
      }

      const response = await fetch(SILICONFLOW_API_URL, {
        method: 'POST',
        signal: controller?.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const text = await response.text();
        options.onMetrics?.({
          operation: options.operation,
          task: options.task,
          model,
          fallback: isFallback,
          success: false,
          durationMs: Date.now() - attemptStartedAt,
          totalDurationMs: Date.now() - startedAt,
        status: response.status,
        error: `SiliconFlow chat completion failed: ${text}`,
        usage: null,
        finishReason: null,
        metadata: options.metadata ?? {},
      });
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
      options.onMetrics?.({
        operation: options.operation,
        task: options.task,
        model,
        fallback: isFallback,
        success: true,
        durationMs: Date.now() - attemptStartedAt,
        totalDurationMs: Date.now() - startedAt,
        usage,
        finishReason,
        metadata: options.metadata ?? {},
      });

      return content;
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      lastError = error instanceof Error ? error : new Error('SiliconFlow chat completion failed.');
      if (error instanceof Error && !error.message.startsWith('SiliconFlow chat completion failed:')) {
        options.onMetrics?.({
          operation: options.operation,
          task: options.task,
          model,
          fallback: isFallback,
          success: false,
          durationMs: Date.now() - attemptStartedAt,
          totalDurationMs: Date.now() - startedAt,
          error: error.message,
          usage: null,
          finishReason: null,
          metadata: options.metadata ?? {},
        });
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

function parseRecipePlanPayload(content: string, options: GenerationLocaleOptions = {}) {
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

    throw new Error(options.locale === 'en'
      ? 'The recipe recommendation response could not be parsed as valid JSON.'
      : '菜谱推荐模型返回内容无法解析为有效 JSON。');
  }
}

function parseRecipeStepsPayload(content: string, options: GenerationLocaleOptions = {}) {
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

    throw new Error(options.locale === 'en'
      ? 'The cooking steps response could not be parsed as valid JSON.'
      : '菜谱步骤模型返回内容无法解析为有效 JSON。');
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

function getUsageNumber(usage: Record<string, unknown> | null | undefined, snakeKey: string, camelKey: string) {
  const value = usage?.[snakeKey] ?? usage?.[camelKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isTimeoutErrorMessage(value: string | undefined) {
  return Boolean(value && /abort|timeout|timed out|超时/i.test(value));
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

function inferRiskLevelFromStep(step: Partial<RecipeDetail['steps'][number]>, locale: GenerationLocaleOptions['locale'] = 'zh') {
  const text = [
    step.title,
    step.description,
    (step as { parentAction?: string }).parentAction,
  ].map((value) => String(value ?? '').toLowerCase()).join(' ');
  const highRiskWords = locale === 'en'
    ? ['flame', 'hot oil', 'boiling', 'steam', 'oven', 'stove', 'deep fry']
    : ['明火', '热油', '开水', '沸水', '蒸', '煮', '烤箱', '炉', '炸'];
  const mediumRiskWords = locale === 'en'
    ? ['knife', 'cut', 'heat', 'pan', 'pot']
    : ['刀', '切', '高温', '热锅', '锅'];

  if (highRiskWords.some((word) => text.includes(word))) {
    return 'high';
  }
  if (Boolean(step.requiresParentAssist) || mediumRiskWords.some((word) => text.includes(word))) {
    return 'medium';
  }
  return 'low';
}

function getStepTextForInference(step: Partial<RecipeDetail['steps'][number]>) {
  return [
    step.title,
    step.description,
    step.tip,
    (step as { parentAction?: string }).parentAction,
  ].map((value) => String(value ?? '').toLowerCase()).join(' ');
}

function inferStepTipFromStep(step: Partial<RecipeDetail['steps'][number]>, isEnglish: boolean) {
  const text = getStepTextForInference(step);

  if (isEnglish) {
    if (/knife|cut|slice|chop/.test(text)) return 'Keep fingers away from the knife edge and cut slowly with adult supervision.';
    if (/boil|steam|hot water/.test(text)) return 'Stand back from steam and wait until the food is no longer too hot.';
    if (/pan|stove|flame|hot oil|heat/.test(text)) return 'Keep the pan stable and watch the color, smell, and texture change.';
    if (/mix|stir|toss/.test(text)) return 'Mix from the bottom upward so the ingredients are evenly coated.';
    return 'Check the visible result before moving to the next step.';
  }

  if (/刀|切|片|丝|丁|剁/.test(text)) return '刀具操作要慢，手指离刀刃远一点。';
  if (/蒸|煮|开水|沸水|热水|焯/.test(text)) return '注意蒸汽和热水，等食材不烫后再靠近。';
  if (/锅|火|热油|加热|翻炒|煎|炒/.test(text)) return '保持锅具放稳，观察颜色、香味和软硬变化。';
  if (/拌|搅|混合|翻匀/.test(text)) return '从碗底往上轻轻翻拌，食材会更均匀。';
  return '进入下一步前，先确认食材状态和操作台面是否安全。';
}

function inferParentActionFromStep(step: Partial<RecipeDetail['steps'][number]>, isEnglish: boolean) {
  const text = getStepTextForInference(step);

  if (!step.requiresParentAssist) {
    return '';
  }

  if (isEnglish) {
    if (/knife|cut|slice|chop/.test(text)) return 'An adult handles the knife work or guides the child hand-over-hand.';
    if (/boil|steam|hot water/.test(text)) return 'An adult handles boiling, steaming, draining, and temperature checks.';
    if (/pan|stove|flame|hot oil|heat/.test(text)) return 'An adult controls the stove, pan, heat level, and hot cookware.';
    return 'An adult completes the risky part and confirms the food is safe to touch or taste.';
  }

  if (/刀|切|片|丝|丁|剁/.test(text)) return '家长负责刀具切配，或手把手指导安全动作。';
  if (/蒸|煮|开水|沸水|热水|焯/.test(text)) return '家长负责蒸煮、捞出、沥水和温度确认。';
  if (/锅|火|热油|加热|翻炒|煎|炒/.test(text)) return '家长负责开火、控温、翻炒和移动热锅。';
  return '家长完成这一步里的高风险动作，并确认食材可以安全触碰或品尝。';
}

export interface GeneratedRecommendationPayload {
  recipes: RecipeRecommendation[];
  recipeDetails: RecipeDetail[];
  filteredAllergens: string[];
  sortBy: string;
}

export interface GenerationLocaleOptions {
  locale?: 'zh' | 'en';
  pinyinMode?: boolean;
  modelOverride?: string;
  timeoutMs?: number;
  onMetrics?: (metrics: SiliconFlowCallMetrics) => void;
}

const configuredChickenVideoRecipeName = '凉拌手撕鸡';
const configuredTomatoEggVideoRecipeName = '番茄炒蛋';

function getStrictIngredientNameSet(ingredients: IngredientItem[]) {
  const names = new Set<string>();

  ingredients.forEach((item) => {
    [item.name, item.normalizedName].forEach((value) => {
      String(value ?? '')
        .split(/[，,、\s]+/)
        .map((name) => normalizeIngredientName(name))
        .filter(Boolean)
        .forEach((name) => names.add(name));
    });
  });

  return names;
}

function hasExactIngredientSet(ingredients: IngredientItem[], expectedNames: string[]) {
  const actualNames = getStrictIngredientNameSet(ingredients);
  return actualNames.size === expectedNames.length && expectedNames.every((name) => actualNames.has(name));
}

function getConfiguredVideoRecipeNameForIngredients(ingredients: IngredientItem[]) {
  if (hasExactIngredientSet(ingredients, ['鸡肉'])) {
    return configuredChickenVideoRecipeName;
  }

  if (hasExactIngredientSet(ingredients, ['番茄', '鸡蛋'])) {
    return configuredTomatoEggVideoRecipeName;
  }

  return '';
}

function buildConfiguredVideoRecipeRecommendation(
  recipeName: string,
  profile: ChildProfile,
  options: GenerationLocaleOptions = {},
): RecipeRecommendation {
  const isEnglish = options.locale === 'en';
  const isTomatoEgg = recipeName === configuredTomatoEggVideoRecipeName;
  const namePinyin = options.pinyinMode === false
    ? ''
    : isTomatoEgg
      ? 'fān qié chǎo dàn'
      : 'liáng bàn shǒu sī jī';
  const nameLearning = options.pinyinMode === false
    ? { characters: [] }
    : isTomatoEgg
      ? {
          characters: [
            { character: '番', pinyin: 'fān', strokes: 12, structure: '上下结构', hint: '上面像采，下面是田。' },
            { character: '茄', pinyin: 'qié', strokes: 8, structure: '上下结构', hint: '草字头说明它和植物有关。' },
            { character: '炒', pinyin: 'chǎo', strokes: 8, structure: '左右结构', hint: '火字旁提示用热锅加热。' },
            { character: '蛋', pinyin: 'dàn', strokes: 11, structure: '上下结构', hint: '下面的虫是古字部件，要整体记。' },
          ],
        }
      : {
          characters: [
            { character: '凉', pinyin: 'liáng', strokes: 10, structure: '左右结构', hint: '两点水表示和温度有关。' },
            { character: '拌', pinyin: 'bàn', strokes: 8, structure: '左右结构', hint: '提手旁提示用手搅拌。' },
            { character: '手', pinyin: 'shǒu', strokes: 4, structure: '独体字', hint: '像张开的手掌。' },
            { character: '撕', pinyin: 'sī', strokes: 15, structure: '左右结构', hint: '提手旁提示动作和手有关。' },
            { character: '鸡', pinyin: 'jī', strokes: 7, structure: '左右结构', hint: '右边的鸟提示它和家禽有关。' },
          ],
        };

  return {
    id: `recipe_gen_summary_${slugifyRecipeName(recipeName)}_configured_video`,
    name: recipeName,
    namePinyin,
    englishName: isTomatoEgg ? 'Tomato Scrambled Eggs' : 'Cold Shredded Chicken Salad',
    nameLearning,
    ageRange: isEnglish ? `${Math.max(3, profile.age - 1)}-${profile.age + 3} years` : `${Math.max(3, profile.age - 1)}-${profile.age + 3} 岁`,
    difficulty: 'easy',
    estimatedTimeMinutes: isTomatoEgg ? 12 : 18,
    fitReasons: [],
    riskAlerts: isEnglish
      ? [isTomatoEgg ? 'A parent should handle the hot pan and stove.' : 'A parent must confirm the chicken is fully cooked before shredding.']
      : [isTomatoEgg ? '热锅和明火步骤需要家长操作' : '鸡肉必须由家长确认完全煮熟后再撕拌'],
    nutritionSummary: isEnglish
      ? isTomatoEgg
        ? 'Tomato adds vitamins and eggs provide protein, making a simple balanced home dish.'
        : 'Chicken provides lean protein, and the chilled shredded style keeps the dish light and kid-friendly.'
      : isTomatoEgg
        ? '番茄提供维生素和酸甜口感，鸡蛋提供优质蛋白，是常见均衡家常菜。'
        : '鸡肉提供优质蛋白，凉拌做法清爽，适合作为儿童轻食或正餐配菜。',
    extraIngredients: [],
    canCookWithCurrentIngredients: true,
  };
}

function ensureConfiguredVideoRecipe(
  payload: GeneratedRecommendationPayload,
  profile: ChildProfile,
  ingredients: IngredientItem[],
  options: GenerationLocaleOptions = {},
) {
  const configuredRecipeName = getConfiguredVideoRecipeNameForIngredients(ingredients);
  if (!configuredRecipeName) {
    return payload;
  }

  const configuredRecipe = buildConfiguredVideoRecipeRecommendation(configuredRecipeName, profile, options);
  const recipes = [
    configuredRecipe,
    ...payload.recipes.filter((recipe) =>
      normalizeRecipeIdentity(recipe.name) !== normalizeRecipeIdentity(configuredRecipeName),
    ),
  ];

  return {
    ...payload,
    recipes: recipes.slice(0, 3),
  } satisfies GeneratedRecommendationPayload;
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
        String(step.tip ?? inferStepTipFromStep(step, isEnglish)),
        disallowedIngredientNames,
      ),
      childAction: removeDisallowedIngredientMentions(
        String((step as { childAction?: string }).childAction ?? step.description ?? ''),
        disallowedIngredientNames,
      ),
      parentAction: removeDisallowedIngredientMentions(
        String(
          (step as { parentAction?: string }).parentAction ??
            inferParentActionFromStep(step, isEnglish),
        ),
        disallowedIngredientNames,
      ),
      expectedResult: removeDisallowedIngredientMentions(String(
        (step as { expectedResult?: string }).expectedResult ??
          (isEnglish
            ? 'After this step, pause and check whether the ingredient color, shape, or texture has changed.'
            : '完成这一步后，先停下来看看食材颜色和形状有没有变化。'),
      ), disallowedIngredientNames),
      riskLevel: step.riskLevel
        ? normalizeRiskLevel(String(step.riskLevel))
        : inferRiskLevelFromStep(step, options.locale),
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
      ? 'Pronunciation fields are optional and may be omitted.'
      : 'Pronunciation fields are optional; include them only if short.'
    : options.pinyinMode === false
      ? '读音字段可省略。'
      : '读音字段可省略；如输出必须简短。';
  const configuredVideoRecipeName = getConfiguredVideoRecipeNameForIngredients(ingredients);
  const configuredVideoRecipeRule = configuredVideoRecipeName
    ? isEnglish
      ? `Configured video recipe post-processing: the server will prepend "${configuredVideoRecipeName}" as one fixed recipe card because the ingredient set exactly matches its uploaded cooking video. Return other useful recipe ideas and do not repeat "${configuredVideoRecipeName}".`
      : `视频菜谱后处理规则:当前食材集合严格匹配已上传视频菜谱，服务端会固定插入“${configuredVideoRecipeName}”作为1道推荐。请返回其它有价值的菜谱思路，不要重复“${configuredVideoRecipeName}”。`
    : '';

  if (isEnglish) {
    return [
      `promptVersion=${recipeRecommendationPromptVersion}. Recommend exactly 3 kid-friendly recipes as JSON only. Output language: ${outputLanguage}.`,
      'Goal: choose simple home dishes that mainly use the listed ingredients, are low-oil, mild, and nutritionally balanced.',
      pronunciationRule,
      `Child age: ${profile.age}; preferences: ${tastePreferences}; allergens: ${allergens}.`,
      compactUserPrompt ? `User note: ${compactUserPrompt}` : '',
      `Ingredients:\n${ingredientLines}`,
      configuredVideoRecipeRule,
      'Required fields per recipe: name,difficulty,estimatedTimeMinutes,riskAlerts,nutritionSummary,canCookWithCurrentIngredients.',
      'Optional short fields: englishName,namePinyin,nameLearning. Omit them if unsure; the server will fill defaults.',
      'Decision rules: canCookWithCurrentIngredients=true only when the dish can be made with current ingredients plus water/tools; riskAlerts max 2 and only for real safety risks.',
      'Do not output cooking steps, ingredient tables, images, prep/cook time split, Markdown, or explanations.',
    ].join('\n');
  }

  return [
    `promptVersion=${recipeRecommendationPromptVersion}。只返回3道儿童菜谱推荐JSON。输出语言:${outputLanguage}。`,
    '目标:优先使用现有食材，推荐简单家常、低油、轻口味、营养均衡的菜。',
    pronunciationRule,
    `儿童:${profile.age}岁；偏好:${tastePreferences}；过敏:${allergens}`,
    compactUserPrompt ? `用户:${compactUserPrompt}` : '',
    `食材:${ingredientLines}`,
    configuredVideoRecipeRule,
    '每道必填:name,difficulty,estimatedTimeMinutes,riskAlerts,nutritionSummary,canCookWithCurrentIngredients。',
    '可选短字段:englishName,namePinyin,nameLearning；不确定可省略，服务端会补齐。',
    '判断规则:现有食材加水和厨具即可完成时canCookWithCurrentIngredients=true；riskAlerts最多2条，仅真实安全风险才填写。',
    '不要输出烹饪步骤、配料表、图片、准备/烹饪拆分时间、Markdown或解释文字。',
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
      `promptVersion=${recipeStepsPromptVersion}. Return exactly 5 actionable kid-friendly cooking steps as JSON only. Output language: ${outputLanguage}.`,
      pronunciationRule,
      `Allowed ingredients:\n${ingredientLines}`,
      `Recipe:\n${recipeLines}`,
      'Rules:',
      `1. Make "${recipe.name}" only; use allowed ingredients plus water/cookware as tools.`,
      '2. Return exactly 5 steps, but choose each step title and order from the real cooking method for this recipe; do not reuse a fixed step template across recipes.',
      '3. Each step outputs title,description,tip,parentAction,requiresParentAssist; the server fills only childAction, expectedResult, and riskLevel.',
      '4. description must let the user follow the step without guessing: include ingredients, exact action order, heat/time when relevant, and a visible done cue.',
      '5. tip must be generated from the real operation in this step, such as cut size, heat level, stirring frequency, softness/color cue, anti-slip, or anti-burn point. Do not reuse the same generic tip.',
      '6. parentAction must match this exact step. For risky steps, name what the adult does; for safe steps, use an empty string. Do not write a fixed generic supervision sentence.',
      '7. description format: "Step ingredients: A, B; Action: 2-3 short sentences covering do this, then this, until you see this result." Keep each description under 65 English words.',
      '8. requiresParentAssist=true for knives, flame, high heat, hot oil, steaming, boiling, oven, or heavy cookware; otherwise false.',
      '9. Do not output recipe card fields, ingredient tables, Markdown, or explanations.',
    ].join('\n');
  }

  return [
    `promptVersion=${recipeStepsPromptVersion}。为指定菜名生成固定5步、可直接照做的儿童烹饪步骤，只返回JSON对象。输出语言:${outputLanguage}。`,
    pronunciationRule,
    `允许食材:${ingredientLines}`,
    `菜谱:${recipeLines}`,
    '规则:',
    `1.只制作“${recipe.name}”；只用允许食材，水和厨具算工具。`,
    '2.只固定输出5步，步骤标题和先后顺序由模型根据该菜谱真实做法生成；不要套用所有菜都相同的固定步骤模板。',
    '3.每步输出:title,description,tip,parentAction,requiresParentAssist；服务端仅补齐childAction、expectedResult、riskLevel。',
    '4.description要能让用户不猜步骤即可操作:包含本步食材、先后动作、需要的火候/时间、完成时能看到的状态。',
    '5.tip必须根据本步骤真实操作生成，如大小厚薄、火候、搅拌频率、软硬/颜色变化、防滑或防烫要点；不要每步复用同一句通用要点。',
    '6.parentAction必须贴合本步骤:高风险步骤写家长具体完成什么；低风险步骤输出空字符串。不要写固定的泛泛陪同句。',
    '7.description固定为“本步骤食材：A、B；操作：2-3句短句，说明先做什么、再做什么、做到什么状态。”每步不超过110个汉字。',
    '8.requiresParentAssist在刀具/明火/高温/热油/蒸煮/烤箱/重厨具时为true，其余为false。',
    '9.不要输出菜谱卡字段、配料表、Markdown或解释文字。',
  ].join('\n');
}

export async function understandIngredientsFromText(userText: string, source: 'manual' | 'voice' = 'manual') {
  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        [
          '你是儿童烹饪应用的食材理解助手。请从用户文本中提取食材名称，输出严格 JSON：{"ingredients":[{"name":"食材名","quantity":"数量或1份"}]}。不要输出额外说明。',
          '支持小朋友用拼音输入食材，包括无声调拼音、带声调拼音、空格分隔拼音和中英文混合输入，如 ji dan、jīdàn、fan qie。',
          '拼音输入只识别蔬菜、肉禽类、水果类食材；不要把鸡蛋、鱼虾水产、米面主食、豆制品、调味料作为拼音候选输出。',
          '如果一个拼音可能对应多个同音食材，只输出与拼音和儿童常见食材最匹配的1个名称，例如 hong luo bo 输出红萝卜，不要同时输出胡萝卜；无法可靠匹配时忽略该拼音。',
          '只输出常见可食用食材名称；数量不明确时 quantity 使用 "1份"。',
        ].join('\n'),
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
          ? 'Kid recipe recommender. Return JSON only: {"recipes":[{"name":"","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"riskAlerts":[],"nutritionSummary":"","canCookWithCurrentIngredients":true}]}. Optional short fields: englishName,namePinyin,nameLearning. No Markdown, explanations, steps, ingredients, images, or extra fields.'
          : '儿童菜谱推荐。只返回JSON:{"recipes":[{"name":"","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"riskAlerts":[],"nutritionSummary":"","canCookWithCurrentIngredients":true}]}。可选短字段:englishName,namePinyin,nameLearning。不要Markdown、解释、步骤、配料表、图片或额外字段。',
    },
    {
      role: 'user',
      content: buildRecipePlanUserPrompt(profile, ingredients, userPrompt, options),
    },
  ], {
    operation: 'generate_recipe_plan',
    task: 'recipe_recommendation',
    timeoutMs: options.timeoutMs ?? 30000,
    modelOverride: options.modelOverride,
    onMetrics: options.onMetrics,
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
      promptVersion: recipeRecommendationPromptVersion,
    },
  });

  return ensureConfiguredVideoRecipe(
    normalizeGeneratedRecipeSummaries(
      parseRecipePlanPayload(content, options),
      profile,
      options,
    ),
    profile,
    ingredients,
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
  if (catalogRecipe && !hasSameRecipeName(recipe.name, configuredChickenVideoRecipeName)) {
    return catalogRecipe;
  }

  let callMetrics: SiliconFlowCallMetrics | null = null;
  const forwardMetrics = options.onMetrics;
  const recordMetric = (metrics: SiliconFlowCallMetrics | null, parseSuccess: boolean, stepCount: number, error?: string) => {
    if (!metrics) {
      return;
    }

    void recordLlmCallMetric({
      operation: metrics.operation,
      task: metrics.task,
      model: metrics.model,
      promptVersion: recipeStepsPromptVersion,
      durationMs: metrics.durationMs,
      timeout: isTimeoutErrorMessage(metrics.error ?? error),
      success: metrics.success && parseSuccess,
      finishReason: metrics.finishReason,
      promptTokens: getUsageNumber(metrics.usage, 'prompt_tokens', 'promptTokens'),
      completionTokens: getUsageNumber(metrics.usage, 'completion_tokens', 'completionTokens'),
      totalTokens: getUsageNumber(metrics.usage, 'total_tokens', 'totalTokens'),
      recipeName: recipe.name,
      ingredientCount: ingredients.length,
      stepCount,
      parseSuccess,
      error: error ?? metrics.error,
    });
  };

  try {
    const content = await callSiliconFlow([
      {
        role: 'system',
        content:
        isEnglish
          ? `Kids cooking step generator. promptVersion=${recipeStepsPromptVersion}. Return JSON only: {"steps":[{"title":"","description":"Step ingredients: A; Action: Do this first. Then do this. It is done when the visible result appears.","requiresParentAssist":false}]}. Exactly 5 steps. No Markdown, explanations, extra fields, or extra wrapper.`
          : `儿童菜谱步骤生成。promptVersion=${recipeStepsPromptVersion}。只返回JSON:{"steps":[{"title":"","description":"本步骤食材：A；操作：先做第一步。再做第二步。看到明确状态就完成。","requiresParentAssist":false}]}。固定5步。不要Markdown、解释、额外字段或额外包裹字段。`,
      },
      {
        role: 'user',
        content: buildRecipeDetailUserPrompt(profile, ingredients, recipe, options),
      },
    ], {
      operation: 'generate_recipe_detail',
      task: 'recipe_steps',
      timeoutMs: options.timeoutMs ?? 30000,
      modelOverride: options.modelOverride,
      onMetrics: (metrics) => {
        callMetrics = metrics;
        forwardMetrics?.(metrics);
      },
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
        promptVersion: recipeStepsPromptVersion,
      },
    });

    const stepsPayload = parseRecipeStepsPayload(content, options);
    if (stepsPayload.sourceRecipeName && !hasSameRecipeName(stepsPayload.sourceRecipeName, recipe.name)) {
      throw new Error(`菜谱详情生成失败，返回菜谱与“${recipe.name}”不一致。`);
    }

    const rawSteps = stepsPayload.steps;
    const steps = normalizeGeneratedCookingSteps(rawSteps, ingredients, options);

    if (steps.length === 0) {
      throw new Error(`菜谱详情生成失败，未返回“${recipe.name}”的有效烹饪步骤。`);
    }

    recordMetric(callMetrics, true, steps.length);
    return buildRecipeDetailFromSteps(recipe, ingredients, steps, options);
  } catch (error) {
    recordMetric(callMetrics, false, 0, error instanceof Error ? error.message : String(error));
    throw error;
  }
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
