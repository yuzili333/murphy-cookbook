import cors from 'cors';
import express, { type Express } from 'express';
import multer from 'multer';
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
import {
  getRecipeDetailForRecommendation,
  getRecipeDetailsForRecommendations,
  parseIngredientJson,
  parseTextToIngredients,
  recommendRecipes,
} from './service.js';
import {
  generateCookingFeedback,
  generateSeasonalIngredientSuggestions,
  isSiliconFlowConfigured,
  shouldRequireRealModel,
  understandIngredientsFromImage,
  understandIngredientsFromText,
} from './siliconflow.js';

function normalizeTextInputValue(value: unknown) {
  return Array.isArray(value) ? value.join(' ').trim() : String(value ?? '').trim();
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
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const queryPayload = query && typeof query === 'object' ? query as Record<string, unknown> : {};
  const rawText =
    payload.text ??
    payload.message ??
    payload.prompt ??
    payload.transcript ??
    payload.content ??
    queryPayload.text ??
    queryPayload.message ??
    queryPayload.prompt ??
    queryPayload.transcript ??
    queryPayload.content ??
    '';
  return normalizeTextInputValue(rawText);
}

interface RecipeDetailRequestPayload {
  profileId: string;
  ingredients: IngredientItem[];
  profile: Partial<ChildProfile> | null;
  recipe: Partial<RecipeDetailRecipeInput> | null;
}

interface RecipeDetailsRequestPayload {
  profileId: string;
  ingredients: IngredientItem[];
  profile: Partial<ChildProfile> | null;
  recipes: Array<Partial<RecipeRecommendation>>;
}

interface RecommendationRequestPayload {
  profileId: string;
  ingredients: IngredientItem[];
  profile: Partial<ChildProfile> | null;
  userPrompt: string;
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
  if (typeof value === 'string') {
    return parseJsonInput<Record<string, unknown>>(value, {});
  }

  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function resolveIngredientItems(value: unknown): IngredientItem[] {
  const parsed = typeof value === 'string' ? parseJsonInput<unknown>(value, value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.reduce<IngredientItem[]>((items, item, index) => {
    if (!item || typeof item !== 'object') {
      return items;
    }

    const ingredient = item as Partial<IngredientItem>;
    const name = String(ingredient.name ?? ingredient.normalizedName ?? '').trim();
    if (!name) {
      return items;
    }

    items.push({
      id: String(ingredient.id ?? `ing_request_${index + 1}`),
      name,
      normalizedName: String(ingredient.normalizedName ?? name),
      quantity: String(ingredient.quantity ?? '1份'),
      source: ingredient.source === 'image' || ingredient.source === 'voice' || ingredient.source === 'manual'
        ? ingredient.source
        : 'manual',
      confidence: typeof ingredient.confidence === 'number' ? ingredient.confidence : undefined,
    });

    return items;
  }, []);
}

export function resolveRecommendationRequestPayload(body: unknown, query: unknown = {}): RecommendationRequestPayload {
  const payload = normalizeRequestRecord(body);
  const queryPayload = normalizeRequestRecord(query);

  return {
    profileId: String(payload.profileId ?? queryPayload.profileId ?? ''),
    ingredients: resolveIngredientItems(payload.ingredients ?? queryPayload.ingredients),
    profile: (payload.profile ?? parseJsonInput(queryPayload.profile, null)) as Partial<ChildProfile> | null,
    userPrompt: String(payload.userPrompt ?? queryPayload.userPrompt ?? ''),
  };
}

export function resolveRecipeDetailRequestPayload(body: unknown, query: unknown = {}): RecipeDetailRequestPayload {
  const payload = normalizeRequestRecord(body);
  const queryPayload = normalizeRequestRecord(query);

  return {
    profileId: String(payload.profileId ?? queryPayload.profileId ?? ''),
    ingredients: resolveIngredientItems(payload.ingredients ?? queryPayload.ingredients),
    profile: (payload.profile ?? parseJsonInput(queryPayload.profile, null)) as Partial<ChildProfile> | null,
    recipe: sanitizeRecipeDetailInput(payload.recipe ?? parseJsonInput(queryPayload.recipe, null)),
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
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.url.startsWith('/.netlify/functions/api/')) {
      req.url = req.url.replace('/.netlify/functions/api', '/api');
    } else if (req.url.startsWith('/v1/')) {
      req.url = `/api${req.url}`;
    }

    next();
  });

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
    const text = resolveIngredientTextInput(req.body, req.query);

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

  app.get('/api/v1/ingredients/seasonal-suggestions', async (req, res) => {
    if (!isSiliconFlowConfigured()) {
      res.json({ data: { suggestions: [] } });
      return;
    }

    try {
      const month = Number(req.query.month ?? new Date().getMonth() + 1);
      const childContext = String(req.query.childContext ?? '');
      const suggestions = await generateSeasonalIngredientSuggestions({
        month,
        childContext,
      });

      res.json({ data: { suggestions } });
    } catch {
      res.json({ data: { suggestions: [] } });
    }
  });

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
        ? parseIngredientJson(await understandIngredientsFromText(transcript), 'voice')
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

  app.post('/api/v1/recommendations/recipes', async (req, res) => {
    const { profileId, ingredients, profile, userPrompt } = resolveRecommendationRequestPayload(req.body, req.query);
    const result = await recommendRecipes(profileId, ingredients, profile, userPrompt);

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
  });

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

  app.post('/api/v1/recipes/detail', async (req, res) => {
    const { profileId, ingredients, profile, recipe } = resolveRecipeDetailRequestPayload(req.body, req.query);

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
  });

  app.post('/api/v1/recipes/details', async (req, res) => {
    const { profileId, ingredients, profile, recipes } = resolveRecipeDetailsRequestPayload(req.body, req.query);
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
        qwenModel: process.env.SILICONFLOW_QWEN_MODEL ?? '',
        apiKeyLength: (process.env.SILICONFLOW_API_KEY ?? '').trim().length,
      },
    });
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

  return app;
}
  const canUseDevelopmentFallback = () => !shouldRequireRealModel();
