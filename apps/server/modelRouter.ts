import type { ChildProfile, IngredientItem, RecipeDetailRecipeInput, RecipeRecommendation } from './data.js';

export type ModelTask =
  | 'ingredient_text'
  | 'ingredient_voice'
  | 'ingredient_normalize'
  | 'ingredient_vision'
  | 'ingredient_knowledge'
  | 'recipe_recommendation'
  | 'recipe_steps'
  | 'recipe_nutrition'
  | 'cooking_feedback';

export interface ModelRouteContext {
  profile?: ChildProfile;
  ingredients?: IngredientItem[];
  recipe?: RecipeDetailRecipeInput | RecipeRecommendation;
  userPrompt?: string;
}

export interface ModelRoute {
  task: ModelTask;
  model: string;
  fallbackModels: string[];
  maxTokens: number;
  temperature: number;
  enableThinking: boolean;
  supportsEnableThinkingParameter?: boolean;
  stream: boolean;
}

const defaultFastModel = 'Qwen/Qwen3.5-9B';
const defaultBalancedModel = 'Qwen/Qwen3.5-27B';
const defaultIngredientTextModel = 'Qwen/Qwen3.5-9B';
const defaultVisionModel = 'Qwen/Qwen3-VL-8B-Instruct';
const defaultVisionFallbackModel = 'Qwen/Qwen3-VL-32B-Instruct';
const defaultFallbackModel = 'Pro/zai-org/GLM-5';

function getModelFromEnv(name: string, fallback: string) {
  return process.env[name]?.trim() || fallback;
}

export class ModelRouter {
  private readonly fastModel = getModelFromEnv('MODEL_FAST', defaultFastModel);
  private readonly balancedModel = getModelFromEnv('MODEL_BALANCED', defaultBalancedModel);
  private readonly ingredientTextModel = getModelFromEnv('MODEL_INGREDIENT_TEXT', defaultIngredientTextModel);
  private readonly visionModel = getModelFromEnv('MODEL_VISION', defaultVisionModel);
  private readonly visionFallbackModel = getModelFromEnv('MODEL_VISION_FALLBACK', defaultVisionFallbackModel);
  private readonly fallbackModel = getModelFromEnv('MODEL_FALLBACK', defaultFallbackModel);

  select(task: ModelTask, context: ModelRouteContext = {}): ModelRoute {
    if (task === 'ingredient_text' || task === 'ingredient_voice' || task === 'ingredient_normalize') {
      const textFallbackModels = [
        this.fastModel,
        this.balancedModel,
        this.fallbackModel,
      ].filter((model) => model !== this.ingredientTextModel);

      return {
        task,
        model: this.ingredientTextModel,
        fallbackModels: textFallbackModels,
        maxTokens: 260,
        temperature: 0.3,
        enableThinking: false,
        stream: false,
      };
    }

    if (task === 'ingredient_knowledge') {
      return {
        task,
        model: this.fastModel,
        fallbackModels: [this.balancedModel].filter((model) => model !== this.fastModel),
        maxTokens: 520,
        temperature: 0.25,
        enableThinking: false,
        stream: false,
      };
    }

    if (task === 'recipe_recommendation') {
      return {
        task,
        model: this.fastModel,
        fallbackModels: [],
        maxTokens: 520,
        temperature: 0.2,
        enableThinking: false,
        stream: false,
      };
    }

    if (task === 'recipe_steps') {
      return {
        task,
        model: this.fastModel,
        fallbackModels: [],
        maxTokens: 850,
        temperature: 0.2,
        enableThinking: false,
        stream: false,
      };
    }

    if (task === 'ingredient_vision') {
      return {
        task,
        model: this.visionModel,
        fallbackModels: [this.visionFallbackModel].filter((model) => model !== this.visionModel),
        maxTokens: 360,
        temperature: 0,
        enableThinking: false,
        supportsEnableThinkingParameter: false,
        stream: false,
      };
    }

    if (task === 'cooking_feedback') {
      return {
        task,
        model: this.balancedModel,
        fallbackModels: [this.fallbackModel],
        maxTokens: 300,
        temperature: 0.2,
        enableThinking: false,
        stream: false,
      };
    }

    return {
      task,
      model: this.fastModel,
      fallbackModels: [this.balancedModel, this.fallbackModel],
      maxTokens: task === 'recipe_nutrition' ? 480 : 320,
      temperature: 0.3,
      enableThinking: false,
      stream: false,
    };
  }
}

export const modelRouter = new ModelRouter();
