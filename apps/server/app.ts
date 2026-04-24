import cors from 'cors';
import express, { type Express } from 'express';
import multer from 'multer';
import {
  childProfiles,
  recipeCatalog,
} from './data.js';
import {
  extractIngredientsFromFilename,
  parseIngredientJson,
  parseTextToIngredients,
  recommendRecipes,
} from './service.js';
import {
  isSiliconFlowConfigured,
  shouldRequireRealModel,
  understandIngredientsFromImage,
  understandIngredientsFromText,
} from './siliconflow.js';

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
    const text = String(req.body?.text ?? '').trim();

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
      if (!isSiliconFlowConfigured() && shouldRequireRealModel()) {
        res.status(500).json({
          error: {
            code: 'MODEL_PROVIDER_NOT_CONFIGURED',
            message: '服务端未配置 SiliconFlow API Key，无法使用生产环境图片识别能力。',
          },
        });
        return;
      }

      const ingredients = isSiliconFlowConfigured()
        ? parseIngredientJson(
            await understandIngredientsFromImage({
              buffer: req.file.buffer,
              mimetype: req.file.mimetype,
              filename: req.file.originalname,
            }),
            'image',
          )
        : extractIngredientsFromFilename(req.file.originalname);

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

  app.post('/api/v1/recommendations/recipes', (req, res) => {
    const profileId = String(req.body?.profileId ?? '');
    const ingredients = req.body?.ingredients ?? [];
    const profile = req.body?.profile ?? null;
    const result = recommendRecipes(profileId, ingredients, profile);

    if (result.error) {
      const status = result.error.code === 'PROFILE_NOT_FOUND' ? 404 : 400;
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

  app.post('/api/v1/cooking-feedback', (req, res) => {
    const { recipeId, tasteFeedback = '', difficultyFeedback = '' } = req.body ?? {};
    const recipe = recipeCatalog.find((item) => item.id === recipeId);

    if (!recipe) {
      res.status(404).json({
        error: { code: 'RECIPE_NOT_FOUND', message: '未找到对应菜谱，无法生成点评。' },
      });
      return;
    }

    res.json({
      data: {
        praise: `${recipe.name} 的颜色搭配很棒，看起来已经很有食欲了。`,
        improvement: difficultyFeedback
          ? `你提到“${difficultyFeedback}”，下次可以把困难步骤交给家长一起完成。`
          : '下次可以把食材切得更均匀一点，成品会更整齐。',
        nextSuggestion: tasteFeedback
          ? `既然你觉得“${tasteFeedback}”，下一次可以试试同样清淡风格的鸡蛋料理。`
          : '下次可以继续挑战一道类似难度的儿童主食。',
      },
    });
  });

  app.get('/api/v1/history/recent-cooked', (_req, res) => {
    res.json({ data: recipeCatalog.slice(0, 2) });
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

  return app;
}
