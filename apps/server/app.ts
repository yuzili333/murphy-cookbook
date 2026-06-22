import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import multer from 'multer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  childProfiles,
  recipeCatalog,
  type ChildProfile,
  type IngredientItem,
  type RecipeRecommendation,
  type RecipeDetail,
  type RecipeDetailRecipeInput,
} from './data.js';
import { getLocalLlmLogFilePath, readLocalLlmLogs, shouldUseLocalDebugLog } from './logger.js';
import { getLlmMetricSummary, resolveLlmMetricsMongoRuntimeConfig } from './llmMetrics.js';
import {
  getRecipeDetailForRecommendation,
  getRecipeDetailsForRecommendations,
  parseIngredientJson,
  parseTextToIngredients,
  recommendRecipes,
} from './service.js';
import {
  generateCookingFeedback,
  generateIngredientKnowledge,
  isSiliconFlowConfigured,
  shouldRequireRealModel,
  understandIngredientsFromImage,
  understandIngredientsFromText,
} from './siliconflow.js';
import { getLocalSeasonalIngredientSuggestions } from './seasonalIngredients.js';
import {
  createRecipeVideo,
  deleteRecipeVideo,
  formatRecipeVideoStorageError,
  listRecipeVideos,
  matchRecipeVideo,
  parseRecipeVideoInput,
  resolveRecipeVideoMatchName,
  resolveRecipeVideoMongoRuntimeConfig,
  updateRecipeVideo,
  type RecipeVideoListOptions,
} from './recipeVideos.js';

interface RequestWithRawBody {
  rawBody?: string;
}

type StreamEvent =
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'card'; id: string; cardType: string; props: Record<string, unknown> }
  | { type: 'error'; id?: string; message: string }
  | { type: 'finish' };

type OutputLocale = 'zh' | 'en';

interface GenerationLocaleOptions {
  locale: OutputLocale;
  pinyinMode: boolean;
}

interface IngredientKnowledgeRequestPayload {
  name: string;
  generationOptions: GenerationLocaleOptions;
}

interface VideoConfigAuthInput {
  username: string;
  password: string;
}

function resolveEnvValue(value: string | undefined, fallback: string) {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

export function resolveVideoConfigAdminCredentials(env: NodeJS.ProcessEnv = process.env) {
  return {
    username: resolveEnvValue(env.VIDEO_CONFIG_ADMIN_USER, 'yuzili'),
    password: resolveEnvValue(env.VIDEO_CONFIG_ADMIN_PASSWORD, 'yuzili333'),
    tokenSecret: resolveEnvValue(env.VIDEO_CONFIG_TOKEN_SECRET, 'murphy-cookbook-video-config-local-secret'),
  };
}

const {
  username: videoConfigAdminUser,
  password: videoConfigAdminPassword,
  tokenSecret: videoConfigTokenSecret,
} = resolveVideoConfigAdminCredentials();

function signVideoConfigToken(username: string, expiresAt: number) {
  return createHmac('sha256', videoConfigTokenSecret).update(`${username}.${expiresAt}`).digest('hex');
}

function createVideoConfigToken(username: string) {
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  return `${username}.${expiresAt}.${signVideoConfigToken(username, expiresAt)}`;
}

function getVideoConfigTokenStatus(token: string) {
  const [username, expiresAtText, signature] = token.split('.');
  const expiresAt = Number(expiresAtText);
  if (!token) return { ok: false, reason: 'missing_token' };
  if (!username || !expiresAt || !signature) return { ok: false, reason: 'malformed_token' };
  if (username !== videoConfigAdminUser) return { ok: false, reason: 'invalid_user' };
  if (expiresAt < Date.now()) return { ok: false, reason: 'expired_token' };

  const expected = signVideoConfigToken(username, expiresAt);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return { ok: false, reason: 'signature_length_mismatch' };
  }

  return timingSafeEqual(actualBuffer, expectedBuffer)
    ? { ok: true, reason: 'valid_token' }
    : { ok: false, reason: 'invalid_signature' };
}

function isLocalVideoConfigDebugRequest(req: Request) {
  const host = String(req.headers.host ?? '').toLocaleLowerCase();
  const isLocalHost = host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('[::1]:');
  const isProductionRuntime = process.env.NODE_ENV === 'production'
    || Boolean(process.env.NETLIFY)
    || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
  return isLocalHost && !isProductionRuntime && process.env.VIDEO_CONFIG_DEV_AUTH_BYPASS !== 'false';
}

function requireVideoConfigPermission(req: Request, res: Response) {
  const authorization = req.headers.authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  const tokenStatus = getVideoConfigTokenStatus(token);
  if (tokenStatus.ok) {
    return true;
  }

  if (isLocalVideoConfigDebugRequest(req)) {
    console.log(`[video-config] local dev auth bypass: ${req.method} ${req.originalUrl} reason=${tokenStatus.reason}`);
    return true;
  }

  console.log(`[video-config] forbidden: ${req.method} ${req.originalUrl} reason=${tokenStatus.reason}`);
  res.status(403).json({
    error: { code: 'VIDEO_CONFIG_FORBIDDEN', message: '没有 video_config_manage 权限，无法访问菜谱视频配置。' },
  });
  return false;
}

function beginSse(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function writeStreamEvent(res: Response, event: StreamEvent) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function endSse(res: Response) {
  writeStreamEvent(res, { type: 'finish' });
  res.end();
}

export function normalizeApiRequestUrl(url: string) {
  if (url.startsWith('/.netlify/functions/api/')) {
    return url.replace('/.netlify/functions/api', '/api');
  }

  if (url.startsWith('/v1/')) {
    return `/api${url}`;
  }

  return url;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function writeTypewriterText(res: Response, id: string, text: string, delayMs = 22, chunkSize = 6) {
  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index += chunkSize) {
    writeStreamEvent(res, {
      type: 'text-delta',
      id,
      delta: characters.slice(index, index + chunkSize).join(''),
    });
    await sleep(delayMs);
  }
}

function normalizeTextInputValue(value: unknown) {
  const text = Array.isArray(value) ? value.join(' ').trim() : String(value ?? '').trim();
  return text.slice(0, 500);
}

function parseJsonInput<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value !== 'string') {
    return value as T;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function resolveIngredientTextInput(body: unknown, query: unknown = {}) {
  const textKeys = ['text', 'message', 'prompt', 'transcript', 'content', 'input', 'value', 'q'];
  const payload = resolveNestedRequestRecord(body, textKeys);
  const queryPayload = resolveNestedRequestRecord(query, textKeys);
  const rawText =
    payload.text ??
    payload.message ??
    payload.prompt ??
    payload.transcript ??
    payload.content ??
    payload.input ??
    payload.value ??
    payload.q ??
    queryPayload.text ??
    queryPayload.message ??
    queryPayload.prompt ??
    queryPayload.transcript ??
    queryPayload.content ??
    queryPayload.input ??
    queryPayload.value ??
    queryPayload.q ??
    (typeof body === 'string' ? body : '') ??
    '';
  return normalizeTextInputValue(rawText);
}

interface RecipeDetailRequestPayload {
  profileId: string;
  ingredients: IngredientItem[];
  profile: Partial<ChildProfile> | null;
  recipe: Partial<RecipeDetailRecipeInput> | null;
  generationOptions: GenerationLocaleOptions;
}

interface RecipeDetailsRequestPayload {
  profileId: string;
  ingredients: IngredientItem[];
  profile: Partial<ChildProfile> | null;
  recipes: Array<Partial<RecipeRecommendation>>;
  generationOptions: GenerationLocaleOptions;
}

interface RecommendationRequestPayload {
  profileId: string;
  ingredients: IngredientItem[];
  profile: Partial<ChildProfile> | null;
  userPrompt: string;
  generationOptions: GenerationLocaleOptions;
}

function isRecipeRecommendationInput(recipe: Partial<RecipeDetailRecipeInput> | null): recipe is RecipeDetailRecipeInput {
  return Boolean(recipe?.id && recipe?.name);
}

function isFullRecipeRecommendationInput(recipe: Partial<RecipeRecommendation> | null): recipe is RecipeRecommendation {
  return Boolean(recipe?.id && recipe?.name && recipe?.englishName && recipe?.nameLearning);
}

function sanitizeRecipeDetailInput(recipe: unknown): Partial<RecipeDetailRecipeInput> | null {
  const parsedRecipe = typeof recipe === 'string' ? parseJsonInput<unknown>(recipe, null) : recipe;
  if (!parsedRecipe || typeof parsedRecipe !== 'object') {
    return null;
  }

  const candidate = parsedRecipe as Partial<RecipeRecommendation>;
  const sanitized: Partial<RecipeDetailRecipeInput> = {
    id: typeof candidate.id === 'string' ? candidate.id : undefined,
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    namePinyin: typeof candidate.namePinyin === 'string' ? candidate.namePinyin : undefined,
    englishName: typeof candidate.englishName === 'string' ? candidate.englishName : undefined,
    ageRange: typeof candidate.ageRange === 'string' ? candidate.ageRange : undefined,
    difficulty:
      candidate.difficulty === 'easy' || candidate.difficulty === 'medium' || candidate.difficulty === 'hard'
        ? candidate.difficulty
        : undefined,
    estimatedTimeMinutes: Number.isFinite(Number(candidate.estimatedTimeMinutes))
      ? Number(candidate.estimatedTimeMinutes)
      : undefined,
    fitReasons: Array.isArray(candidate.fitReasons) ? candidate.fitReasons.map(String) : undefined,
    riskAlerts: Array.isArray(candidate.riskAlerts) ? candidate.riskAlerts.map(String) : undefined,
    nutritionSummary: typeof candidate.nutritionSummary === 'string' ? candidate.nutritionSummary : undefined,
    extraIngredients: Array.isArray(candidate.extraIngredients) ? candidate.extraIngredients.map(String) : undefined,
    canCookWithCurrentIngredients:
      typeof candidate.canCookWithCurrentIngredients === 'boolean'
        ? candidate.canCookWithCurrentIngredients
        : undefined,
  };

  return Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined)) as Partial<RecipeDetailRecipeInput>;
}

export function stripRecipeDetailImageFields(detail: RecipeDetail) {
  const { imageUrl: _imageUrl, ingredients, ...rest } = detail;

  return {
    ...rest,
    ingredients: ingredients.map((ingredient) => {
      const { imageUrl: _ingredientImageUrl, ...ingredientRest } = ingredient;
      return ingredientRest;
    }),
  };
}

function normalizeRequestRecord(value: unknown) {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return parseJsonInput<Record<string, unknown>>(value.toString('utf8'), {});
  }

  if (value instanceof Uint8Array) {
    return parseJsonInput<Record<string, unknown>>(Buffer.from(value).toString('utf8'), {});
  }

  if (typeof value === 'string') {
    return parseJsonInput<Record<string, unknown>>(value, {});
  }

  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function resolveNestedRequestRecord(value: unknown, expectedKeys: string[]) {
  const record = normalizeRequestRecord(value);
  if (expectedKeys.some((key) => record[key] !== undefined)) {
    return record;
  }

  for (const key of ['data', 'payload', 'body']) {
    const nested = record[key];
    if (nested === undefined || nested === null) {
      continue;
    }

    const nestedRecord = normalizeRequestRecord(nested);
    if (expectedKeys.some((expectedKey) => nestedRecord[expectedKey] !== undefined)) {
      return nestedRecord;
    }
  }

  return record;
}

export function resolveVideoConfigAuthInput(body: unknown, query: unknown = {}): VideoConfigAuthInput {
  const payload = resolveNestedRequestRecord(body, ['username', 'password']);
  const queryPayload = resolveNestedRequestRecord(query, ['username', 'password']);

  return {
    username: String(payload.username ?? queryPayload.username ?? '').trim(),
    password: String(payload.password ?? queryPayload.password ?? ''),
  };
}

function resolveIngredientItems(value: unknown): IngredientItem[] {
  const parsed = typeof value === 'string' ? parseJsonInput<unknown>(value, value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.slice(0, 10).reduce<IngredientItem[]>((items, item, index) => {
    if (!item || typeof item !== 'object') {
      return items;
    }

    const ingredient = item as Partial<IngredientItem>;
    const name = String(ingredient.name ?? ingredient.normalizedName ?? '').trim().slice(0, 32);
    if (!name) {
      return items;
    }

    items.push({
      id: String(ingredient.id ?? `ing_request_${index + 1}`),
      name,
      normalizedName: String(ingredient.normalizedName ?? name).trim().slice(0, 32),
      quantity: String(ingredient.quantity ?? '1份').trim().slice(0, 24),
      source: ingredient.source === 'image' || ingredient.source === 'voice' || ingredient.source === 'manual'
        ? ingredient.source
        : 'manual',
      confidence: typeof ingredient.confidence === 'number' ? ingredient.confidence : undefined,
    });

    return items;
  }, []);
}

function resolveGenerationLocaleOptions(payload: Record<string, unknown>, queryPayload: Record<string, unknown>): GenerationLocaleOptions {
  const rawLocale = String(payload.locale ?? payload.language ?? queryPayload.locale ?? queryPayload.language ?? 'zh').toLowerCase();
  const rawPinyinMode = payload.pinyinMode ?? payload.enablePinyin ?? queryPayload.pinyinMode ?? queryPayload.enablePinyin;
  const pinyinMode =
    rawPinyinMode === undefined
      ? true
      : rawPinyinMode === true ||
        rawPinyinMode === 'true' ||
        rawPinyinMode === '1' ||
        rawPinyinMode === 'on';

  return {
    locale: rawLocale === 'en' || rawLocale === 'english' ? 'en' : 'zh',
    pinyinMode,
  };
}

export function resolveRecommendationRequestPayload(body: unknown, query: unknown = {}): RecommendationRequestPayload {
  const payload = normalizeRequestRecord(body);
  const queryPayload = normalizeRequestRecord(query);

  return {
    profileId: String(payload.profileId ?? queryPayload.profileId ?? ''),
    ingredients: resolveIngredientItems(payload.ingredients ?? queryPayload.ingredients),
    profile: (payload.profile ?? parseJsonInput(queryPayload.profile, null)) as Partial<ChildProfile> | null,
    userPrompt: String(payload.userPrompt ?? queryPayload.userPrompt ?? ''),
    generationOptions: resolveGenerationLocaleOptions(payload, queryPayload),
  };
}

export function resolveIngredientKnowledgeRequestPayload(body: unknown, query: unknown = {}): IngredientKnowledgeRequestPayload {
  const nameKeys = ['name', 'ingredientName', 'ingredient', 'food', 'q'];
  const payload = resolveNestedRequestRecord(body, nameKeys);
  const queryPayload = resolveNestedRequestRecord(query, nameKeys);
  const rawBodyText = typeof body === 'string' && !body.trim().startsWith('{') ? body : '';
  const rawName =
    payload.name ??
    payload.ingredientName ??
    payload.ingredient ??
    payload.food ??
    payload.q ??
    queryPayload.name ??
    queryPayload.ingredientName ??
    queryPayload.ingredient ??
    queryPayload.food ??
    queryPayload.q ??
    rawBodyText;

  return {
    name: normalizeTextInputValue(rawName),
    generationOptions: resolveGenerationLocaleOptions(payload, queryPayload),
  };
}

export function resolveRecipeDetailRequestPayload(body: unknown, query: unknown = {}): RecipeDetailRequestPayload {
  const payload = resolveNestedRequestRecord(body, ['profileId', 'profile', 'ingredients', 'recipe']);
  const queryPayload = normalizeRequestRecord(query);

  return {
    profileId: String(payload.profileId ?? queryPayload.profileId ?? ''),
    ingredients: resolveIngredientItems(payload.ingredients ?? queryPayload.ingredients),
    profile: (payload.profile ?? parseJsonInput(queryPayload.profile, null)) as Partial<ChildProfile> | null,
    recipe: sanitizeRecipeDetailInput(
      payload.recipe ??
        payload.recipeInput ??
        payload.selectedRecipe ??
        parseJsonInput(queryPayload.recipe, null),
    ),
    generationOptions: resolveGenerationLocaleOptions(payload, queryPayload),
  };
}

export function resolveRecipeDetailsRequestPayload(body: unknown, query: unknown = {}): RecipeDetailsRequestPayload {
  const payload = normalizeRequestRecord(body);
  const queryPayload = normalizeRequestRecord(query);

  return {
    profileId: String(payload.profileId ?? queryPayload.profileId ?? ''),
    ingredients: resolveIngredientItems(payload.ingredients ?? queryPayload.ingredients),
    profile: (payload.profile ?? parseJsonInput(queryPayload.profile, null)) as Partial<ChildProfile> | null,
    recipes: Array.isArray(payload.recipes)
      ? payload.recipes as Array<Partial<RecipeRecommendation>>
      : parseJsonInput<Array<Partial<RecipeRecommendation>>>(queryPayload.recipes, []),
    generationOptions: resolveGenerationLocaleOptions(payload, queryPayload),
  };
}

export function createApp(): Express {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 1,
    },
  });

  app.use(cors());
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as RequestWithRawBody).rawBody = buffer.toString('utf8');
    },
  }));
  app.use((req, _res, next) => {
    req.url = normalizeApiRequestUrl(req.url);
    next();
  });

  const sendRecommendationResponse = async (req: Request, res: Response) => {
    const { profileId, ingredients, profile, userPrompt, generationOptions } = resolveRecommendationRequestPayload(req.body, req.query);
    const result = await recommendRecipes(profileId, ingredients, profile, userPrompt, generationOptions);

    if ('error' in result) {
      const status =
        result.error.code === 'PROFILE_NOT_FOUND'
          ? 404
          : result.error.code === 'INVALID_ARGUMENT' || result.error.code === 'NO_RECIPE_MATCHED'
            ? 400
            : result.error.code === 'MODEL_PROVIDER_NOT_CONFIGURED'
              ? 500
              : 502;
      res.status(status).json({ error: result.error });
      return;
    }

    res.json({
      data: {
        ...result.data,
        sortBy: String(req.body?.sortBy ?? result.data.sortBy),
      },
    });
  };

  const streamRecommendationResponse = async (req: Request, res: Response) => {
    beginSse(res);
    const { profileId, ingredients, profile, userPrompt, generationOptions } = resolveRecommendationRequestPayload(req.body, req.query);
    const textNodeId = `text_${Date.now()}`;
    await writeTypewriterText(
      res,
      textNodeId,
      generationOptions.locale === 'en'
        ? 'Analyzing the ingredients and preparing kid-friendly recipe cards...'
        : '正在分析食材清单，准备生成儿童友好的菜谱卡片...',
    );

    try {
      const result = await recommendRecipes(profileId, ingredients, profile, userPrompt, generationOptions);
      if ('error' in result) {
        writeStreamEvent(res, { type: 'error', message: result.error.message });
        endSse(res);
        return;
      }

      const leadText = result.data.recipes
        .map((recipe, index) => {
          if (generationOptions.locale === 'en') {
            const risk = recipe.riskAlerts.length ? `Note: ${recipe.riskAlerts.slice(0, 2).join('; ')}` : 'Overall risk is low';
            return `\n${index + 1}. ${recipe.name}: ${recipe.nutritionSummary}. Why it fits: uses the current ingredients, keeps flavor gentle, and supports kid participation. ${risk}.`;
          }

          const risk = recipe.riskAlerts.length ? `注意：${recipe.riskAlerts.slice(0, 2).join('；')}` : '整体风险较低';
          return `\n${index + 1}. ${recipe.name}：${recipe.nutritionSummary}。推荐原因：适合当前食材、口味清淡、步骤适合小学阶段参与。${risk}。`;
        })
        .join('');
      await writeTypewriterText(res, textNodeId, leadText);
      await sleep(260);

      writeStreamEvent(res, {
        type: 'card',
        id: `recipe_card_${Date.now()}`,
        cardType: 'recipe-card',
        props: {
          data: {
            ...result.data,
            sortBy: String(req.body?.sortBy ?? result.data.sortBy),
          },
        },
      });
      endSse(res);
    } catch (error) {
      writeStreamEvent(res, {
        type: 'error',
        message: error instanceof Error ? error.message : '菜谱推荐失败，请稍后重试。',
      });
      endSse(res);
    }
  };

  const sendIngredientNormalizeResponse = async (req: Request, res: Response) => {
    const text =
      resolveIngredientTextInput(req.body, req.query) ||
      resolveIngredientTextInput((req as RequestWithRawBody).rawBody, req.query);

    if (!text) {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '请输入要解析的食材文本。' },
      });
      return;
    }

    try {
      if (!isSiliconFlowConfigured() && shouldRequireRealModel()) {
        res.status(500).json({
          error: {
            code: 'MODEL_PROVIDER_NOT_CONFIGURED',
            message: '服务端未配置 SiliconFlow API Key，无法使用生产环境食材理解能力。',
          },
        });
        return;
      }

      const ingredients = isSiliconFlowConfigured()
        ? parseIngredientJson(await understandIngredientsFromText(text), 'manual')
        : parseTextToIngredients(text);

      res.json({ data: { ingredients } });
    } catch (error) {
      res.status(502).json({
        error: {
          code: 'TEXT_UNDERSTANDING_FAILED',
          message: error instanceof Error ? error.message : '文本理解失败。',
        },
      });
    }
  };

  const sendRecipeDetailResponse = async (req: Request, res: Response) => {
    let { profileId, ingredients, profile, recipe, generationOptions } = resolveRecipeDetailRequestPayload(req.body, req.query);

    if (!isRecipeRecommendationInput(recipe)) {
      const fallbackPayload = resolveRecipeDetailRequestPayload((req as RequestWithRawBody).rawBody, req.query);
      profileId = fallbackPayload.profileId;
      ingredients = fallbackPayload.ingredients;
      profile = fallbackPayload.profile;
      recipe = fallbackPayload.recipe;
      generationOptions = fallbackPayload.generationOptions;
    }

    if (!isRecipeRecommendationInput(recipe) && req.params.recipeId) {
      const recipeId = String(req.params.recipeId);
      const catalogRecipe = recipeCatalog.find((item) => item.id === recipeId);
      recipe = catalogRecipe ?? {
        id: recipeId,
        name: String(req.body?.name ?? req.query.name ?? ''),
      };
    }

    if (!isRecipeRecommendationInput(recipe)) {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '请提供有效的推荐菜谱卡片信息。' },
      });
      return;
    }

    const result = await getRecipeDetailForRecommendation({
      profileId,
      ingredients,
      profileInput: profile,
      recipe,
      generationOptions,
    });

    if ('error' in result) {
      const status =
        result.error.code === 'PROFILE_NOT_FOUND'
          ? 404
          : result.error.code === 'INVALID_ARGUMENT' || result.error.code === 'RECIPE_DETAIL_UNAVAILABLE'
            ? 400
            : result.error.code === 'MODEL_PROVIDER_NOT_CONFIGURED'
              ? 500
              : 502;
      res.status(status).json({ error: result.error });
      return;
    }

    res.json({ data: stripRecipeDetailImageFields(result.data) });
  };

  const streamRecipeDetailResponse = async (req: Request, res: Response) => {
    beginSse(res);
    let { profileId, ingredients, profile, recipe, generationOptions } = resolveRecipeDetailRequestPayload(req.body, req.query);

    if (!isRecipeRecommendationInput(recipe)) {
      const fallbackPayload = resolveRecipeDetailRequestPayload((req as RequestWithRawBody).rawBody, req.query);
      profileId = fallbackPayload.profileId;
      ingredients = fallbackPayload.ingredients;
      profile = fallbackPayload.profile;
      recipe = fallbackPayload.recipe;
      generationOptions = fallbackPayload.generationOptions;
    }

    if (!isRecipeRecommendationInput(recipe)) {
      writeStreamEvent(res, { type: 'error', message: '请提供有效的推荐菜谱卡片信息。' });
      endSse(res);
      return;
    }

    const textNodeId = `text_${Date.now()}`;
    await writeTypewriterText(
      res,
      textNodeId,
      generationOptions.locale === 'en'
        ? `Generating kid-friendly cooking steps for ${recipe.name}...`
        : `正在生成《${recipe.name}》的儿童版烹饪步骤...`,
    );

    try {
      const result = await getRecipeDetailForRecommendation({
        profileId,
        ingredients,
        profileInput: profile,
        recipe,
        generationOptions,
      });

      if ('error' in result) {
        writeStreamEvent(res, { type: 'error', message: result.error.message });
        endSse(res);
        return;
      }

      await sleep(220);
      writeStreamEvent(res, {
        type: 'card',
        id: `recipe_detail_${recipe.id}`,
        cardType: 'recipe-detail',
        props: { data: stripRecipeDetailImageFields(result.data) },
      });
      endSse(res);
    } catch (error) {
      writeStreamEvent(res, {
        type: 'error',
        message: error instanceof Error ? error.message : '菜谱步骤获取失败。',
      });
      endSse(res);
    }
  };

  const sendRecipeNutritionResponse = (req: Request, res: Response) => {
    const recipeInput = sanitizeRecipeDetailInput(req.body?.recipe ?? null);
    const recipeId = String(req.params.recipeId);
    const recipe = recipeCatalog.find((item) => item.id === recipeId) ?? recipeInput;

    if (!recipe?.id || !recipe.name) {
      res.status(404).json({
        error: { code: 'RECIPE_NOT_FOUND', message: '未找到对应菜谱，无法生成营养摘要。' },
      });
      return;
    }

    res.json({
      data: {
        recipeId: recipe.id,
        name: recipe.name,
        nutritionSummary: recipe.nutritionSummary ?? '营养搭配均衡，适合作为儿童一餐。',
        riskAlerts: recipe.riskAlerts ?? [],
      },
    });
  };

  app.get('/api/v1/health', (_req, res) => {
    res.json({ data: { ok: true } });
  });

  app.get('/api/v1/child-profiles', (_req, res) => {
    res.json({ data: childProfiles });
  });

  app.post('/api/v1/child-profiles', (req, res) => {
    const { nickname, age, tastePreferences = [], allergens = [], dietaryHabits = [] } = req.body ?? {};

    if (!nickname || !age) {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '昵称和年龄是必填项。' },
      });
      return;
    }

    const profile = {
      id: `cp_${Date.now()}`,
      nickname,
      age,
      tastePreferences,
      allergens,
      dietaryHabits,
    };

    childProfiles.push(profile);
    res.status(201).json({ data: profile });
  });

  app.patch('/api/v1/child-profiles/:profileId', (req, res) => {
    const profile = childProfiles.find((item) => item.id === req.params.profileId);
    if (!profile) {
      res.status(404).json({
        error: { code: 'PROFILE_NOT_FOUND', message: '未找到对应的儿童档案。' },
      });
      return;
    }

    Object.assign(profile, req.body ?? {});
    res.json({ data: profile });
  });

  app.post('/api/v1/ingredients/parse-text', async (req, res) => {
    const text =
      resolveIngredientTextInput(req.body, req.query) ||
      resolveIngredientTextInput((req as RequestWithRawBody).rawBody, req.query);

    if (!text) {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '请输入要解析的食材文本。' },
      });
      return;
    }

    try {
      if (!isSiliconFlowConfigured() && shouldRequireRealModel()) {
        res.status(500).json({
          error: {
            code: 'MODEL_PROVIDER_NOT_CONFIGURED',
            message: '服务端未配置 SiliconFlow API Key，无法使用生产环境食材理解能力。',
          },
        });
        return;
      }

      const ingredients = isSiliconFlowConfigured()
        ? parseIngredientJson(await understandIngredientsFromText(text), 'manual')
        : parseTextToIngredients(text);

      res.json({ data: { ingredients } });
    } catch (error) {
      res.status(502).json({
        error: {
          code: 'TEXT_UNDERSTANDING_FAILED',
          message: error instanceof Error ? error.message : '文本理解失败。',
        },
      });
    }
  });

  app.post('/api/ingredients/normalize', sendIngredientNormalizeResponse);
  app.post('/api/v1/ingredients/normalize', sendIngredientNormalizeResponse);

  const sendSeasonalSuggestionsResponse = async (req: Request, res: Response) => {
    const month = Number(req.body?.month ?? new Date().getMonth() + 1);
    const suggestions = getLocalSeasonalIngredientSuggestions(month, 3);

    res.json({ data: { suggestions } });
  };

  app.post('/api/v1/ingredients/seasonal-suggestions', sendSeasonalSuggestionsResponse);

  const sendIngredientKnowledgeResponse = async (req: Request, res: Response) => {
    let { name, generationOptions } = resolveIngredientKnowledgeRequestPayload(req.body, req.query);
    if (!name && (req as RequestWithRawBody).rawBody) {
      const fallbackPayload = resolveIngredientKnowledgeRequestPayload((req as RequestWithRawBody).rawBody, req.query);
      name = fallbackPayload.name;
      generationOptions = fallbackPayload.generationOptions;
    }
    const isEnglish = generationOptions.locale === 'en';

    if (!name) {
      res.status(400).json({
        error: {
          code: 'INVALID_ARGUMENT',
          message: isEnglish ? 'Please provide an ingredient name.' : '请提供要了解的食材名称。',
        },
      });
      return;
    }

    try {
      if (!isSiliconFlowConfigured() && shouldRequireRealModel()) {
        res.status(500).json({
          error: {
            code: 'MODEL_PROVIDER_NOT_CONFIGURED',
            message: isEnglish
              ? 'The server is missing the SiliconFlow API key, so ingredient notes cannot be generated.'
              : '服务端未配置 SiliconFlow API Key，无法获取食材知识。',
          },
        });
        return;
      }

      if (!isSiliconFlowConfigured()) {
        res.json({
          data: isEnglish
            ? {
                name,
                nutritionValues: ['Supports balanced meals', 'Adds color and texture', 'Good in small kid-friendly portions'],
                origin: 'Commonly found in regions suitable for growing or raising this ingredient.',
                growingClimate: 'Usually grows well with suitable sunlight, water, and temperature.',
                bestPairings: ['egg', 'tofu', 'rice'],
                kidFact: `${name} helps kids learn how food travels from farms to the table.`,
                safetyNote: 'Wash well before eating, and tell an adult about any allergy history.',
              }
            : {
                name,
                nutritionValues: ['富含成长所需营养', '能帮助丰富一餐的颜色和口感', '适量食用有助于饮食均衡'],
                origin: '常见于适合种植或养殖这种食材的地区。',
                growingClimate: '通常喜欢阳光、水分和温度比较合适的环境。',
                bestPairings: ['鸡蛋', '豆腐', '米饭'],
                kidFact: `${name} 可以帮助小朋友认识食物从土地到餐桌的过程。`,
                safetyNote: '食用前要清洗干净，如有过敏史请先告诉家长。',
              },
        });
        return;
      }

      const knowledge = await generateIngredientKnowledge(name, generationOptions);
      res.json({ data: knowledge });
    } catch (error) {
      res.status(502).json({
        error: {
          code: 'INGREDIENT_KNOWLEDGE_FAILED',
          message: error instanceof Error
            ? error.message
            : isEnglish
              ? 'Failed to get ingredient notes.'
              : '食材知识获取失败。',
        },
      });
    }
  };

  app.post('/api/ingredients/knowledge', sendIngredientKnowledgeResponse);
  app.post('/api/v1/ingredients/knowledge', sendIngredientKnowledgeResponse);

  app.post('/api/v1/ingredients/recognize-image', upload.single('image'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '请上传图片文件。' },
      });
      return;
    }

    if (!req.file.mimetype.startsWith('image/')) {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '仅支持图片文件上传。' },
      });
      return;
    }

    try {
      if (!isSiliconFlowConfigured()) {
        res.status(500).json({
          error: {
            code: 'MODEL_PROVIDER_NOT_CONFIGURED',
            message: '服务端未配置 SiliconFlow API Key，无法使用图片识别大模型能力。',
          },
        });
        return;
      }

      const ingredients = parseIngredientJson(
        await understandIngredientsFromImage({
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          filename: req.file.originalname,
        }),
        'image',
      );

      res.json({
        data: {
          ingredients,
          upload: {
            filename: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          },
        },
      });
    } catch (error) {
      res.status(502).json({
        error: {
          code: 'VISION_UNDERSTANDING_FAILED',
          message: error instanceof Error ? error.message : '图片识别失败。',
        },
      });
    }
  });

  app.post('/api/v1/ingredients/parse-voice', upload.single('audio'), async (req, res) => {
    const transcript = String(req.body?.transcript ?? '').trim();

    if (!req.file && !transcript) {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '请上传音频文件或直接提供 transcript。' },
      });
      return;
    }

    if (req.file && !req.file.mimetype.startsWith('audio/') && req.file.mimetype !== 'video/webm') {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '仅支持音频文件上传。' },
      });
      return;
    }

    if (!transcript) {
      res.status(501).json({
        error: {
          code: 'VOICE_TRANSCRIPTION_UNSUPPORTED',
          message: '当前 SiliconFlow Chat Completions 方案仅支持对文本 transcript 做理解，不支持直接音频转写。',
        },
      });
      return;
    }

    try {
      if (!isSiliconFlowConfigured() && shouldRequireRealModel()) {
        res.status(500).json({
          error: {
            code: 'MODEL_PROVIDER_NOT_CONFIGURED',
            message: '服务端未配置 SiliconFlow API Key，无法使用生产环境语音文本理解能力。',
          },
        });
        return;
      }

      const ingredients = isSiliconFlowConfigured()
        ? parseIngredientJson(await understandIngredientsFromText(transcript, 'voice'), 'voice')
        : parseTextToIngredients(transcript).map((item) => ({
            ...item,
            source: 'voice' as const,
          }));

      res.json({
        data: {
          transcript,
          ingredients,
          upload: req.file
            ? {
                filename: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size,
              }
            : null,
        },
      });
    } catch (error) {
      res.status(502).json({
        error: {
          code: 'TEXT_UNDERSTANDING_FAILED',
          message: error instanceof Error ? error.message : '语音文本理解失败。',
        },
      });
    }
  });

  app.post('/api/v1/recommendations/recipes', sendRecommendationResponse);
  app.post('/api/v1/recommendations/recipes/stream', streamRecommendationResponse);
  app.post('/api/recipes/recommend', sendRecommendationResponse);
  app.post('/api/v1/recipes/recommend', sendRecommendationResponse);
  app.post('/api/v1/recipes/recommend/stream', streamRecommendationResponse);

  app.get('/api/v1/recipes/:recipeId', (req, res) => {
    const recipe = recipeCatalog.find((item) => item.id === req.params.recipeId);
    if (!recipe) {
      res.status(404).json({
        error: { code: 'RECIPE_NOT_FOUND', message: '未找到对应菜谱。' },
      });
      return;
    }

    res.json({ data: recipe });
  });

  app.post('/api/v1/recipes/detail', sendRecipeDetailResponse);
  app.post('/api/v1/recipes/detail/stream', streamRecipeDetailResponse);
  app.post('/api/recipes/:recipeId/steps', sendRecipeDetailResponse);
  app.post('/api/v1/recipes/:recipeId/steps', sendRecipeDetailResponse);
  app.post('/api/v1/recipes/:recipeId/steps/stream', streamRecipeDetailResponse);

  app.post('/api/recipes/:recipeId/nutrition', sendRecipeNutritionResponse);
  app.post('/api/v1/recipes/:recipeId/nutrition', sendRecipeNutritionResponse);

  app.post('/api/v1/recipes/details', async (req, res) => {
    const { profileId, ingredients, profile, recipes, generationOptions } = resolveRecipeDetailsRequestPayload(req.body, req.query);
    const validRecipes = recipes.filter(isFullRecipeRecommendationInput);

    if (validRecipes.length === 0) {
      res.status(400).json({
        error: { code: 'INVALID_ARGUMENT', message: '请提供有效的推荐菜谱卡片列表。' },
      });
      return;
    }

    const result = await getRecipeDetailsForRecommendations({
      profileId,
      ingredients,
      profileInput: profile,
      recipes: validRecipes,
      generationOptions,
    });

    if ('error' in result) {
      const status =
        result.error.code === 'PROFILE_NOT_FOUND'
          ? 404
          : result.error.code === 'INVALID_ARGUMENT'
            ? 400
            : result.error.code === 'MODEL_PROVIDER_NOT_CONFIGURED'
              ? 500
              : 502;
      res.status(status).json({ error: result.error });
      return;
    }

    res.json({ data: result.data.map(stripRecipeDetailImageFields) });
  });

  app.post('/api/v1/cooking-feedback', async (req, res) => {
    const { profileId = '', profile = null, recipeId, recipe: recipeInput = null, tasteFeedback = '', difficultyFeedback = '' } = req.body ?? {};
    const recipe = recipeCatalog.find((item) => item.id === recipeId);
    const resolvedRecipe = recipeInput ?? recipe ?? null;
    const resolvedProfile = profile ?? childProfiles.find((item) => item.id === String(profileId));

    if (!resolvedRecipe) {
      res.status(404).json({
        error: { code: 'RECIPE_NOT_FOUND', message: '未找到对应菜谱，无法生成点评。' },
      });
      return;
    }

    const fallbackFeedback = {
      praise: `${resolvedRecipe.name} 的颜色搭配很棒，看起来已经很有食欲了。`,
      improvement: difficultyFeedback
        ? `你提到“${difficultyFeedback}”，下次可以把困难步骤交给家长一起完成。`
        : '下次可以把食材切得更均匀一点，成品会更整齐。',
      nextSuggestion: tasteFeedback
        ? `既然你觉得“${tasteFeedback}”，下一次可以试试同样清淡风格的鸡蛋料理。`
        : '下次可以继续挑战一道类似难度的儿童主食。',
    };

    if (!resolvedProfile) {
      if (canUseDevelopmentFallback()) {
        res.json({ data: fallbackFeedback });
        return;
      }

      res.status(404).json({
        error: { code: 'PROFILE_NOT_FOUND', message: '未找到儿童档案，无法生成点评。' },
      });
      return;
    }

    if (!isSiliconFlowConfigured()) {
      if (canUseDevelopmentFallback()) {
        res.json({ data: fallbackFeedback });
        return;
      }

      res.status(500).json({
        error: {
          code: 'MODEL_PROVIDER_NOT_CONFIGURED',
          message: '服务端未配置 SiliconFlow API Key，无法生成生产环境点评。',
        },
      });
      return;
    }

    try {
      const feedback = await generateCookingFeedback({
        profile: resolvedProfile,
        recipe: resolvedRecipe,
        tasteFeedback: String(tasteFeedback),
        difficultyFeedback: String(difficultyFeedback),
      });
      res.json({ data: feedback });
    } catch (error) {
      if (canUseDevelopmentFallback()) {
        res.json({ data: fallbackFeedback });
        return;
      }

      res.status(502).json({
        error: {
          code: 'COOKING_FEEDBACK_FAILED',
          message: error instanceof Error ? error.message : '点评生成失败。',
        },
      });
    }
  });

  app.get('/api/v1/debug/runtime-config', (_req, res) => {
    res.json({
      data: {
        siliconFlowConfigured: isSiliconFlowConfigured(),
        requireRealModel: shouldRequireRealModel(),
        netlify: Boolean(process.env.NETLIFY),
        lambda: Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT),
        nodeEnv: process.env.NODE_ENV ?? '',
        modelFast: process.env.MODEL_FAST ?? 'Qwen/Qwen3.5-9B',
        modelBalanced: process.env.MODEL_BALANCED ?? 'Qwen/Qwen3.5-27B',
        modelFallback: process.env.MODEL_FALLBACK ?? 'Pro/zai-org/GLM-5',
        apiKeyLength: (process.env.SILICONFLOW_API_KEY ?? '').trim().length,
        videoConfigAuth: {
          adminUserConfigured: Boolean(process.env.VIDEO_CONFIG_ADMIN_USER?.trim()),
          adminPasswordConfigured: Boolean(process.env.VIDEO_CONFIG_ADMIN_PASSWORD?.trim()),
          adminUsernameLength: videoConfigAdminUser.length,
          adminPasswordLength: videoConfigAdminPassword.length,
        },
        recipeVideoMongo: resolveRecipeVideoMongoRuntimeConfig(),
        llmMetricsMongo: resolveLlmMetricsMongoRuntimeConfig(),
      },
    });
  });

  app.post('/api/v1/video-config/auth', (req, res) => {
    const { username, password } = resolveVideoConfigAuthInput(req.body, req.query);

    if (username !== videoConfigAdminUser || password !== videoConfigAdminPassword) {
      res.status(401).json({
        error: {
          code: 'VIDEO_CONFIG_AUTH_FAILED',
          message: '管理员账号或密码错误。',
          details: {
            receivedUsernameLength: username.length,
            receivedPasswordLength: password.length,
            configuredUsernameLength: videoConfigAdminUser.length,
            configuredPasswordLength: videoConfigAdminPassword.length,
          },
        },
      });
      return;
    }

    res.json({
      data: {
        token: createVideoConfigToken(username),
        user: {
          username,
          permissions: ['video_config_manage'],
        },
      },
    });
  });

  app.get('/api/v1/video-config/recipes', async (req, res) => {
    if (!requireVideoConfigPermission(req, res)) return;

    const options: RecipeVideoListOptions = {
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : '',
      resolution: req.query.resolution === '720p' || req.query.resolution === '1080p' ? req.query.resolution : '',
      sortBy: req.query.sortBy === 'recipeName' || req.query.sortBy === 'durationSeconds' || req.query.sortBy === 'updatedAt' ? req.query.sortBy : 'updatedAt',
      sortOrder: req.query.sortOrder === 'asc' ? 'asc' : 'desc',
      page: typeof req.query.page === 'string' ? Number(req.query.page) : 1,
      pageSize: typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : 10,
    };

    try {
      res.json({ data: await listRecipeVideos(options) });
    } catch (error) {
      res.status(500).json({
        error: { code: 'VIDEO_CONFIG_STORAGE_FAILED', message: formatRecipeVideoStorageError(error) },
      });
    }
  });

  app.post('/api/v1/video-config/recipes', async (req, res) => {
    if (!requireVideoConfigPermission(req, res)) return;

    let input;
    try {
      input = parseRecipeVideoInput(req.body);
    } catch (error) {
      res.status(400).json({
        error: { code: 'VIDEO_CONFIG_INVALID', message: error instanceof Error ? error.message : '视频配置提交失败。' },
      });
      return;
    }

    try {
      res.status(201).json({ data: await createRecipeVideo(input) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const isBusinessError = message === '菜谱名称不能重复。';
      res.status(isBusinessError ? 400 : 500).json({
        error: {
          code: isBusinessError ? 'VIDEO_CONFIG_INVALID' : 'VIDEO_CONFIG_STORAGE_FAILED',
          message: isBusinessError ? message : formatRecipeVideoStorageError(error),
        },
      });
    }
  });

  app.put('/api/v1/video-config/recipes/:id', async (req, res) => {
    if (!requireVideoConfigPermission(req, res)) return;

    let input;
    try {
      input = parseRecipeVideoInput(req.body);
    } catch (error) {
      res.status(400).json({
        error: { code: 'VIDEO_CONFIG_INVALID', message: error instanceof Error ? error.message : '视频配置更新失败。' },
      });
      return;
    }

    try {
      res.json({ data: await updateRecipeVideo(req.params.id, input) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const isBusinessError = message === '菜谱名称不能重复。' || message === '未找到对应的视频配置。';
      res.status(isBusinessError ? 400 : 500).json({
        error: {
          code: isBusinessError ? 'VIDEO_CONFIG_INVALID' : 'VIDEO_CONFIG_STORAGE_FAILED',
          message: isBusinessError ? message : formatRecipeVideoStorageError(error),
        },
      });
    }
  });

  app.delete('/api/v1/video-config/recipes/:id', async (req, res) => {
    if (!requireVideoConfigPermission(req, res)) return;

    try {
      await deleteRecipeVideo(req.params.id);
      res.json({ data: { ok: true } });
    } catch (error) {
      res.status(404).json({
        error: { code: 'VIDEO_CONFIG_NOT_FOUND', message: error instanceof Error ? error.message : '视频配置删除失败。' },
      });
    }
  });

  app.post('/api/v1/recipe-videos/match', async (req, res) => {
    const recipeName = resolveRecipeVideoMatchName(req.body, req.query);
    try {
      res.json({ data: { video: await matchRecipeVideo(recipeName) } });
    } catch (error) {
      res.status(500).json({
        error: { code: 'RECIPE_VIDEO_MATCH_FAILED', message: error instanceof Error ? error.message : '菜谱视频匹配失败。' },
      });
    }
  });

  app.get('/api/v1/debug/llm-logs', (req, res) => {
    if (!shouldUseLocalDebugLog()) {
      res.status(404).json({
        error: { code: 'DEBUG_LOG_DISABLED', message: '当前环境未启用本地调试日志。' },
      });
      return;
    }

    const start = typeof req.query.start === 'string' ? req.query.start : undefined;
    const end = typeof req.query.end === 'string' ? req.query.end : undefined;
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

    res.json({
      data: {
        items: readLocalLlmLogs({ start, end, keyword, limit }),
        filters: {
          start: start ?? '',
          end: end ?? '',
          keyword: keyword ?? '',
          limit: limit ?? 200,
        },
        logFile: getLocalLlmLogFilePath(),
      },
    });
  });

  app.get('/api/v1/debug/llm-metrics', async (req, res) => {
    if (!requireVideoConfigPermission(req, res)) {
      return;
    }

    const hours = typeof req.query.hours === 'string' ? Number(req.query.hours) : 24;
    const task = typeof req.query.task === 'string' ? req.query.task : '';
    const model = typeof req.query.model === 'string' ? req.query.model : '';
    const promptVersion = typeof req.query.promptVersion === 'string' ? req.query.promptVersion : '';

    try {
      res.json({
        data: {
          items: await getLlmMetricSummary({
            hours,
            task: task as never,
            model,
            promptVersion,
          }),
          filters: {
            hours: Number.isFinite(hours) && hours > 0 ? hours : 24,
            task,
            model,
            promptVersion,
          },
          runtime: resolveLlmMetricsMongoRuntimeConfig(),
        },
      });
    } catch (error) {
      res.status(500).json({
        error: {
          code: 'LLM_METRICS_QUERY_FAILED',
          message: error instanceof Error ? error.message : '大模型调用指标查询失败。',
        },
      });
    }
  });

  return app;
}
  const canUseDevelopmentFallback = () => !shouldRequireRealModel();
