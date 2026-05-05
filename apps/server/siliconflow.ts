import {
  buildIngredientImageUrl,
  buildRecipeImageUrl,
  normalizeChildFriendlyQuantity,
  normalizeIngredientName,
  summarizeRecipe,
  recipeCatalog,
  type ChildProfile,
  type IngredientItem,
  type RecipeRecommendation,
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
        max_tokens: options.maxTokens ?? 1800,
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
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: Record<string, unknown>;
    };

    const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
    const finishReason = payload.choices?.[0]?.finish_reason ?? null;

    writeLocalJsonLog({
      type: 'llm_call',
      operation: options.operation,
      model: QWEN_MODEL,
      success: true,
      durationMs: Date.now() - startedAt,
      requestSummary: summarizeMessages(messages),
      responsePreview: content.slice(0, 500),
      finishReason,
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
      .slice(0, 8);
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

export interface GeneratedRecommendationSummaryPayload {
  recipes: RecipeRecommendation[];
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
      const recipeVisualQuery =
        typeof (recipe as { imageSearchQuery?: unknown }).imageSearchQuery === 'string'
          ? String((recipe as { imageSearchQuery?: string }).imageSearchQuery)
          : '';
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
      const name = String(recipe.name);
      const namePinyin = String((recipe as { namePinyin?: string }).namePinyin ?? '');

      return {
        id: String(recipe.id ?? `recipe_gen_${slugifyRecipeName(name)}_${index + 1}`),
        name,
        namePinyin,
        englishName: String(recipe.englishName ?? buildFallbackEnglishName(name)),
        nameLearning: normalizeNameLearning(recipe, name, namePinyin),
        imageUrl: buildRecipeImageUrl(
          name,
          recipeVisualQuery,
          normalizedIngredients.map((item) => String(item.name ?? '')),
        ),
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
          imageUrl: buildIngredientImageUrl(
            String(item.name),
            typeof (item as { imageSearchQuery?: unknown }).imageSearchQuery === 'string'
              ? String((item as { imageSearchQuery?: string }).imageSearchQuery)
              : '',
          ),
        })),
        steps: Array.isArray(recipe.steps)
          ? recipe.steps
              .filter((step) => step?.title && step?.description)
              .map((step, stepIndex) => ({
                id: String(step.id ?? `step_${index + 1}_${stepIndex + 1}`),
                title: String(step.title),
                description: String(step.description),
                tip: String(step.tip ?? '慢慢来，先确认安全再动手。'),
                childAction: String((step as { childAction?: string }).childAction ?? step.description ?? ''),
                parentAction: String(
                  (step as { parentAction?: string }).parentAction ??
                    (step.requiresParentAssist ? '这一小步建议家长在旁边陪着一起完成。' : ''),
                ),
                expectedResult: String(
                  (step as { expectedResult?: string }).expectedResult ??
                    '完成这一步后，先停下来看看食材颜色和形状有没有变化。',
                ),
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

function normalizeGeneratedRecipeSummaries(
  payload: {
    recipes?: Array<Partial<RecipeRecommendation>>;
  },
  profile: ChildProfile,
) {
  const recipes = (payload.recipes ?? [])
    .filter((recipe) => recipe.name)
    .map((recipe, index) => {
      const recipeVisualQuery =
        typeof (recipe as { imageSearchQuery?: unknown }).imageSearchQuery === 'string'
          ? String((recipe as { imageSearchQuery?: string }).imageSearchQuery)
          : '';
      const name = String(recipe.name);
      const namePinyin = String((recipe as { namePinyin?: string }).namePinyin ?? '');

      return {
        id: String(recipe.id ?? `recipe_gen_summary_${slugifyRecipeName(name)}_${index + 1}`),
        name,
        namePinyin,
        englishName: String(recipe.englishName ?? buildFallbackEnglishName(name)),
        nameLearning: normalizeNameLearning(recipe, name, namePinyin),
        imageUrl: buildRecipeImageUrl(name, recipeVisualQuery),
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
    filteredAllergens: profile.allergens,
    sortBy: 'balanced',
  } satisfies GeneratedRecommendationSummaryPayload;
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
    '任务: 为儿童生成 3-5 道推荐菜谱卡片，并输出严格 JSON。',
    '儿童档案:',
    profileLines,
    userPrompt.trim() ? '用户本轮对话描述:' : '',
    userPrompt.trim() ? userPrompt.trim() : '',
    '现有食材清单:',
    ingredientLines,
    '生成要求:',
    '1. 返回 3-5 道推荐菜谱，数量不要少于 3 道，除非食材明显不足；优先使用现有食材，并结合用户本轮对话里的口味、场景、时间和限制条件；缺少食材尽量少。',
    '2. 菜谱要适合儿童年龄、口味和饮食习惯，操作者多为小学阶段儿童，优先推荐简单、低门槛、易上手、步骤清楚、营养均衡的菜谱。',
    '3. 严格避开过敏原和明显不适宜儿童的做法；避免复杂刀工、长时间油炸、重油重辣和需要精准火候的菜谱。',
    '4. 这里只生成推荐卡片摘要，不要生成步骤、配料明细、prepTimeMinutes、cookTimeMinutes。',
    '5. 每道菜都必须包含 namePinyin，使用带声调的汉语拼音，并按词分隔，例如 "fān qié jī dàn miàn"。',
    '6. 每道菜都必须包含 englishName，使用自然英译名，适合儿童听读，不要机械逐字翻译。',
    '7. 每道菜都必须包含 nameLearning.characters，逐字覆盖中文菜名中的汉字；每项包含 character、pinyin、strokes、structure、hint，pinyin 必须使用带调号拼音。',
    '8. 每道菜都必须包含 imageSearchQuery，使用 2-4 个英文单词描述成品图主体，例如 "broccoli egg noodles"；画面必须是这道菜做熟后的成品近景，不能是无关菜品、原料堆或餐厅环境。',
    '9. 不要生成泛化图片词，例如 "food"、"meal"、"dish" 单独出现，必须包含核心主食材和成品形式。',
    '10. 如果菜谱会使用明火、天然气灶、电磁炉、微波炉、烤箱、空气炸锅、蒸锅、热锅、热油、开水或锋利刀具，riskAlerts 必须高亮写明“需家长全程陪同”，difficulty 不要标为 easy，canCookWithCurrentIngredients 不能掩盖安全风险。',
    '11. 输出字段必须完整，不要输出任何解释文字。',
  ].join('\n');
}

function buildRecipeDetailUserPrompt(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  recipe: RecipeRecommendation,
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
    `年龄段: ${recipe.ageRange}`,
    `难度: ${recipe.difficulty}`,
    `预计总时长: ${recipe.estimatedTimeMinutes} 分钟`,
    `适配原因: ${recipe.fitReasons.join('、') || '无'}`,
    `风险提醒: ${recipe.riskAlerts.join('、') || '无'}`,
    `额外食材: ${recipe.extraIngredients.join('、') || '无'}`,
  ].join('\n');

  return [
    '任务: 基于已选推荐卡片，生成 1 道儿童菜谱详情，并输出严格 JSON。',
    '儿童档案:',
    profileLines,
    '现有食材清单:',
    ingredientLines,
    '目标推荐卡片:',
    recipeLines,
    '生成要求:',
    '1. 只生成这一道菜的详情，不要生成其他备选菜。',
    '2. 输出完整字段：id、name、namePinyin、englishName、nameLearning、imageSearchQuery、ageRange、difficulty、estimatedTimeMinutes、fitReasons、riskAlerts、nutritionSummary、extraIngredients、canCookWithCurrentIngredients、prepTimeMinutes、cookTimeMinutes、ingredients、steps。',
    '3. 菜谱必须提供 namePinyin，使用带声调的汉语拼音，并按词分隔，例如 "fān qié jī dàn miàn"。',
    '4. 菜谱必须提供 englishName，使用自然英译名，适合儿童听读，不要机械逐字翻译。',
    '5. 菜谱必须提供 nameLearning.characters，逐字覆盖中文菜名中的汉字；每项包含 character、pinyin、strokes、structure、hint，pinyin 必须使用带调号拼音。',
    '6. 菜谱必须提供 imageSearchQuery，使用 2-4 个英文单词准确描述成品图主体，例如 "broccoli egg noodles"；必须是做熟后的菜品成品图，不要写模糊词。',
    '7. 每个配料必须提供 imageSearchQuery，使用 1-3 个英文单词准确描述单个原料，例如 "broccoli florets"、"raw egg"；必须是单个食材特写，不要把调料或其他食材混进去。',
    '8. 任何调味料和近似量不要写“适量/少许/微量”，统一改成儿童可理解的勺数，例如1平勺、半平勺、2平勺。',
    '9. steps 必须补充全量操作步骤细节，拆成 5-8 个小步骤；不要把“洗切炒煮”合并成一句。每一步都要像教小朋友一样具体：先做什么、用什么工具、放在哪里、等待多久、看到什么状态再进入下一步。',
    '10. 每一步 steps 除了 title、description、tip、riskLevel、requiresParentAssist，必须补充 childAction、parentAction、expectedResult，帮助识字量少的儿童理解；childAction 用儿童能听懂的短句，parentAction 写清家长何时接手或陪同。',
    '11. 如果步骤涉及明火、天然气灶、电磁炉、微波炉、烤箱、空气炸锅、蒸锅、热锅、热油、开水或锋利刀具，riskLevel 必须是 medium 或 high，requiresParentAssist 必须是 true，parentAction 必须明确“家长全程陪同/由家长操作”。',
    '12. 步骤要清晰、适合亲子共做；安全提醒不能只写在总提醒里，相关步骤也必须单独标注。',
    '13. 输出字段必须完整，不要输出任何解释文字。',
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
        '1. 返回 5-8 个食材建议。',
        '2. 春节/冬季偏青菜瓜果、温热暖体、清淡少油；夏季偏牛油果、西瓜、黄瓜、清爽冰沙/酸奶可用食材；秋季偏润燥祛湿；春季偏新鲜青菜和维生素丰富食材。',
        '3. 食材名要短，便于用户点击后直接识别为食材。',
        '4. 不要包含过度辛辣、高糖、高油或明显不适合儿童的食材。',
      ].join('\n'),
    },
  ], {
    operation: 'generate_seasonal_ingredient_suggestions',
    maxTokens: 500,
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
        '你是儿童烹饪菜谱智能体。请根据儿童档案和现有食材，生成 3-5 个安全、适龄、简单易上手的儿童菜谱推荐卡片。操作者多为小学阶段儿童，优先选择低油、轻口味、步骤清楚、亲子可执行的菜谱；如涉及明火、天然气灶、电磁炉、微波炉、烤箱、空气炸锅、蒸锅、热锅、热油、开水或锋利刀具，riskAlerts 必须高亮提醒“需家长全程陪同”。输出严格 JSON：{"recipes":[{"id":"可选","name":"菜名","namePinyin":"带声调拼音","englishName":"自然英文菜名","nameLearning":{"characters":[{"character":"菜","pinyin":"cài","strokes":11,"structure":"上下结构","hint":"儿童可理解的一句话"}]},"imageSearchQuery":"2到4个英文单词的成品图检索词","ageRange":"7-12 岁","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"fitReasons":["原因"],"riskAlerts":["提醒"],"nutritionSummary":"一句话","extraIngredients":["缺少食材"],"canCookWithCurrentIngredients":true}]}。不要输出额外说明。',
    },
    {
      role: 'user',
      content: buildRecipePlanUserPrompt(profile, ingredients, userPrompt),
    },
  ], {
    operation: 'generate_recipe_plan',
    maxTokens: 1200,
    metadata: {
      profileId: profile.id,
      age: profile.age,
      ingredientCount: ingredients.length,
      ingredientNames: ingredients.map((item) => item.name),
      userPromptLength: userPrompt.length,
    },
  });

  const summaryPayload = normalizeGeneratedRecipeSummaries(
    parseRecipePlanPayload(content),
    profile,
  );

  return {
    ...summaryPayload,
    recipeDetails: [],
  };
}

export async function generateRecipeDetail(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  recipe: RecipeRecommendation,
) {
  const catalogRecipe = recipeCatalog.find((item) => item.id === recipe.id);
  if (catalogRecipe) {
    return catalogRecipe;
  }

  const content = await callSiliconFlow([
    {
      role: 'system',
      content:
        '你是儿童烹饪菜谱智能体。请根据儿童档案、现有食材和指定推荐卡片，生成 1 个完整儿童菜谱详情。操作者多为小学阶段儿童，步骤必须拆细、引导性强、上手难度低。如涉及明火、天然气灶、电磁炉、微波炉、烤箱、空气炸锅、蒸锅、热锅、热油、开水或锋利刀具，必须在 riskAlerts 和对应 step 中高亮提醒需家长全程陪同。输出严格 JSON：{"recipes":[{"id":"可选","name":"菜名","namePinyin":"带声调拼音","englishName":"自然英文菜名","nameLearning":{"characters":[{"character":"菜","pinyin":"cài","strokes":11,"structure":"上下结构","hint":"儿童可理解的一句话"}]},"imageSearchQuery":"2到4个英文单词的成品图检索词","ageRange":"7-12 岁","difficulty":"easy|medium|hard","estimatedTimeMinutes":20,"fitReasons":["原因"],"riskAlerts":["提醒"],"nutritionSummary":"一句话","extraIngredients":["缺少食材"],"canCookWithCurrentIngredients":true,"prepTimeMinutes":5,"cookTimeMinutes":15,"ingredients":[{"name":"食材名","quantity":"1平勺","imageSearchQuery":"1到3个英文单词的单食材检索词"}],"steps":[{"id":"可选","title":"步骤标题","description":"步骤描述","tip":"提示","childAction":"孩子要做什么","parentAction":"家长何时介入","expectedResult":"完成后看到什么","riskLevel":"low|medium|high","requiresParentAssist":false}]}]}。不要输出额外说明。',
    },
    {
      role: 'user',
      content: buildRecipeDetailUserPrompt(profile, ingredients, recipe),
    },
  ], {
    operation: 'generate_recipe_detail',
    maxTokens: 2600,
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

  const matched = detailPayload.recipeDetails[0];
  if (!matched) {
    throw new Error('菜谱详情生成失败，未返回有效步骤。');
  }

  return {
    ...matched,
    id: recipe.id || matched.id,
    imageUrl: recipe.imageUrl ?? matched.imageUrl,
    name: recipe.name || matched.name,
    namePinyin: recipe.namePinyin || matched.namePinyin,
    ageRange: recipe.ageRange || matched.ageRange,
    difficulty: recipe.difficulty || matched.difficulty,
    estimatedTimeMinutes: recipe.estimatedTimeMinutes || matched.estimatedTimeMinutes,
    fitReasons: recipe.fitReasons.length > 0 ? recipe.fitReasons : matched.fitReasons,
    riskAlerts: recipe.riskAlerts.length > 0 ? recipe.riskAlerts : matched.riskAlerts,
    nutritionSummary: recipe.nutritionSummary || matched.nutritionSummary,
    extraIngredients: recipe.extraIngredients.length > 0 ? recipe.extraIngredients : matched.extraIngredients,
    canCookWithCurrentIngredients:
      typeof recipe.canCookWithCurrentIngredients === 'boolean'
        ? recipe.canCookWithCurrentIngredients
        : matched.canCookWithCurrentIngredients,
  } satisfies RecipeDetail;
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
