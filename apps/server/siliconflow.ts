import {
  buildIngredientImageUrl,
  buildRecipeImageUrl,
  normalizeChildFriendlyQuantity,
  normalizeIngredientName,
  summarizeRecipe,
  type ChildProfile,
  type IngredientItem,
  type RecipeDetail,
} from './data.js';
import { getLocalLlmLogFilePath, writeLocalJsonLog } from './logger.js';

const SILICONFLOW_API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const QWEN_MODEL = process.env.SILICONFLOW_QWEN_MODEL ?? 'Qwen/Qwen3.5-35B-A3B';

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
  metadata?: Record<string, unknown>;
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

  if (!apiKey) {
    writeLocalJsonLog({
      type: 'llm_call',
      operation: options.operation,
      model: QWEN_MODEL,
      success: false,
      durationMs: Date.now() - startedAt,
      error: 'SILICONFLOW_API_KEY is not configured.',
      metadata: options.metadata ?? {},
      logFile: getLocalLlmLogFilePath(),
    });
    throw new Error('SILICONFLOW_API_KEY is not configured.');
  }

  try {
    const response = await fetch(SILICONFLOW_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages,
        stream: false,
        enable_thinking: false,
        temperature: 0.1,
        max_tokens: 1800,
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
        model: QWEN_MODEL,
        success: false,
        durationMs: Date.now() - startedAt,
        status: response.status,
        error: `SiliconFlow chat completion failed: ${text}`,
        requestSummary: summarizeMessages(messages),
        metadata: options.metadata ?? {},
        logFile: getLocalLlmLogFilePath(),
      });
      throw new Error(`SiliconFlow chat completion failed: ${text}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, unknown>;
    };

    const content = payload.choices?.[0]?.message?.content?.trim() ?? '';

    writeLocalJsonLog({
      type: 'llm_call',
      operation: options.operation,
      model: QWEN_MODEL,
      success: true,
      durationMs: Date.now() - startedAt,
      requestSummary: summarizeMessages(messages),
      responsePreview: content.slice(0, 500),
      usage: payload.usage ?? null,
      metadata: options.metadata ?? {},
      logFile: getLocalLlmLogFilePath(),
    });

    return content;
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith('SiliconFlow chat completion failed:')) {
      writeLocalJsonLog({
        type: 'llm_call',
        operation: options.operation,
        model: QWEN_MODEL,
        success: false,
        durationMs: Date.now() - startedAt,
        error: error.message,
        requestSummary: summarizeMessages(messages),
        metadata: options.metadata ?? {},
        logFile: getLocalLlmLogFilePath(),
      });
    }

    throw error;
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

function normalizeGeneratedRecipeDetails(
  payload: {
    recipes?: Array<Partial<RecipeDetail>>;
  },
  profile: ChildProfile,
  ingredients: IngredientItem[],
) {
  const inputIngredients = new Set(ingredients.map((item) => normalizeIngredientName(item.normalizedName ?? item.name)));

  const recipeDetails = (payload.recipes ?? [])
    .filter((recipe) => recipe.name)
    .map((recipe, index) => {
      const normalizedIngredients = (recipe.ingredients ?? []).filter((item) => item?.name);
      const prepTimeMinutes = Math.max(1, Number(recipe.prepTimeMinutes ?? 5));
      const cookTimeMinutes = Math.max(1, Number(recipe.cookTimeMinutes ?? 10));
      const estimatedTimeMinutes = Math.max(
        1,
        Number(recipe.estimatedTimeMinutes ?? prepTimeMinutes + cookTimeMinutes),
      );
      const canCookWithCurrentIngredients = normalizedIngredients.every((item) =>
        inputIngredients.has(normalizeIngredientName(item.name ?? '')),
      );

      return {
        id: String(recipe.id ?? `recipe_gen_${slugifyRecipeName(String(recipe.name))}_${index + 1}`),
        name: String(recipe.name),
        imageUrl: String(recipe.imageUrl ?? buildRecipeImageUrl(String(recipe.name))),
        ageRange: String(recipe.ageRange ?? `${Math.max(3, profile.age - 1)}-${profile.age + 3} 岁`),
        difficulty: recipe.difficulty === 'hard' || recipe.difficulty === 'medium' ? recipe.difficulty : 'easy',
        estimatedTimeMinutes,
        fitReasons: Array.isArray(recipe.fitReasons) ? recipe.fitReasons.map(String).slice(0, 4) : ['适合当前儿童档案'],
        riskAlerts: Array.isArray(recipe.riskAlerts) ? recipe.riskAlerts.map(String).slice(0, 4) : [],
        nutritionSummary: String(recipe.nutritionSummary ?? '营养搭配均衡，适合作为儿童一餐。'),
        extraIngredients: Array.isArray(recipe.extraIngredients) ? recipe.extraIngredients.map(String) : [],
        canCookWithCurrentIngredients:
          typeof recipe.canCookWithCurrentIngredients === 'boolean'
            ? recipe.canCookWithCurrentIngredients
            : canCookWithCurrentIngredients,
        prepTimeMinutes,
        cookTimeMinutes,
        ingredients: normalizedIngredients.map((item) => ({
          name: String(item.name),
          quantity: normalizeChildFriendlyQuantity(String(item.quantity ?? '1平勺')),
          imageUrl: buildIngredientImageUrl(String(item.name)),
        })),
        steps: Array.isArray(recipe.steps)
          ? recipe.steps
              .filter((step) => step?.title && step?.description)
              .map((step, stepIndex) => ({
                id: String(step.id ?? `step_${index + 1}_${stepIndex + 1}`),
                title: String(step.title),
                description: String(step.description),
                tip: String(step.tip ?? '慢慢来，先确认安全再动手。'),
                riskLevel: normalizeRiskLevel(String(step.riskLevel ?? 'medium')),
                requiresParentAssist: Boolean(step.requiresParentAssist),
              }))
          : [],
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

function buildRecipePlanUserPrompt(profile: ChildProfile, ingredients: IngredientItem[]) {
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
    '任务: 为儿童生成 2-4 个推荐菜谱，并输出严格 JSON。',
    '儿童档案:',
    profileLines,
    '现有食材清单:',
    ingredientLines,
    '生成要求:',
    '1. 优先使用现有食材，缺少食材尽量少。',
    '2. 菜谱要适合儿童年龄、口味和饮食习惯。',
    '3. 严格避开过敏原和明显不适宜儿童的做法。',
    '4. 步骤要短、清晰、可执行，适合亲子共做。',
    '5. 每道菜都必须包含安全提醒和家长陪同标记。',
    '6. 菜谱必须提供 imageUrl，配料也必须提供 imageUrl，可使用公开网络图片地址。',
    '7. 任何调味料和近似量不要写“适量/少许/微量”，统一改成儿童可理解的勺数，例如1平勺、半平勺、2平勺。',
    '8. 输出字段必须完整，不要输出任何解释文字。',
  ].join('\n');
}

export async function understandIngredientsFromText(userText: string) {
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
    metadata: {
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
    metadata: {
      filename: file.filename,
      mimetype: file.mimetype,
      bytes: file.buffer.length,
    },
  });

  return content;
}

export async function generateRecipePlan(profile: ChildProfile, ingredients: IngredientItem[]) {
  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童烹饪菜谱智能体。请根据儿童档案和现有食材，生成 2-4 个安全、适龄、可执行的儿童菜谱。输出严格 JSON：{"recipes":[{"id":"可选","name":"菜名","imageUrl":"公开网络图片地址","ageRange":"7-12 岁","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"fitReasons":["原因"],"riskAlerts":["提醒"],"nutritionSummary":"一句话","extraIngredients":["缺少食材"],"canCookWithCurrentIngredients":true,"prepTimeMinutes":5,"cookTimeMinutes":15,"ingredients":[{"name":"食材名","quantity":"1平勺","imageUrl":"公开网络图片地址"}],"steps":[{"id":"可选","title":"步骤标题","description":"步骤描述","tip":"提示","riskLevel":"low|medium|high","requiresParentAssist":false}]}]}。不要输出额外说明。',
    },
    {
      role: 'user',
      content: buildRecipePlanUserPrompt(profile, ingredients),
    },
  ], {
    operation: 'generate_recipe_plan',
    metadata: {
      profileId: profile.id,
      age: profile.age,
      ingredientCount: ingredients.length,
      ingredientNames: ingredients.map((item) => item.name),
    },
  });

  return normalizeGeneratedRecipeDetails(
    JSON.parse(content) as { recipes?: Array<Partial<RecipeDetail>> },
    profile,
    ingredients,
  );
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
