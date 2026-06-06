import type {
  ChildProfile,
  CreateChildProfileInput,
  FeedbackResponse,
  IngredientKnowledge,
  IngredientItem,
  ImageRecognitionResponse,
  LlmLogQueryResult,
  RecipeDetail,
  RecipeCookingVideo,
  RecipeVideoConfigInput,
  RecipeVideoConfigListResult,
  RecipeRecommendation,
  RecommendationResponse,
  SeasonalIngredientSuggestion,
  StreamEvent,
  VoiceParseResponse,
} from '../types';
import { parseSseChunk } from './streamAst';

function resolveDefaultApiBase() {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('netlify.app')) {
    return '/.netlify/functions/api/v1';
  }

  return '/api/v1';
}

function normalizeApiBase(base: string) {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

const API_BASE = normalizeApiBase(import.meta.env.VITE_API_BASE_URL ?? resolveDefaultApiBase());

export interface GenerationLocaleOptions {
  locale?: 'zh' | 'en';
  pinyinMode?: boolean;
}

interface ApiEnvelope<T> {
  data: T;
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function getCurrentLocale() {
  try {
    return window.localStorage.getItem('murphy-cookbook.locale.v1') === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

function localizeApiErrorMessage(message: string) {
  if (getCurrentLocale() !== 'en') {
    return message;
  }

  if (!message) {
    return 'Request failed. Please try again later.';
  }

  const exactTranslations: Record<string, string> = {
    '请求失败，请稍后再试。': 'Request failed. Please try again later.',
    '请求失败，请稍后尝试。': 'Request failed. Please try again later.',
    '流式消息解析失败。': 'Failed to parse the streaming response.',
    '菜谱推荐模型返回内容无法解析为有效JSON。': 'The recipe recommendation response could not be parsed.',
    '菜谱推荐模型返回内容无法解析为有效JSON': 'The recipe recommendation response could not be parsed.',
    '菜谱步骤模型返回内容无法解析为有效JSON。': 'The cooking steps response could not be parsed.',
    '菜谱步骤模型返回内容无法解析为有效JSON': 'The cooking steps response could not be parsed.',
    '接口数据响应超时': 'Request timed out.',
    '接口超时，稍后重试。': 'Request timed out. Please try again later.',
    '推荐失败，请稍后重试。': 'Recipe recommendation failed. Please try again later.',
    '菜谱推荐生成失败。': 'Recipe generation failed.',
    '菜谱详情生成失败。': 'Cooking steps generation failed.',
    '菜谱步骤获取失败。': 'Failed to get cooking steps.',
    '文本理解失败。': 'Failed to understand the text.',
    '图片识别失败。': 'Image recognition failed.',
    '图片上传失败。': 'Image upload failed.',
    '食材知识获取失败。': 'Failed to get ingredient notes.',
    '食材识别失败。': 'Ingredient recognition failed.',
    '食材识别失败，请稍后再试。': 'Ingredient recognition failed. Please try again later.',
    '语音文本解析失败。': 'Voice text parsing failed.',
    '语音文本理解失败。': 'Failed to understand the voice input.',
  };
  const normalized = message.replace(/\s+/g, '').replace(/JSON/g, 'JSON');
  if (exactTranslations[message]) {
    return exactTranslations[message];
  }
  if (exactTranslations[normalized]) {
    return exactTranslations[normalized];
  }
  if (message.includes('菜谱推荐模型返回内容无法解析')) {
    return 'The recipe recommendation response could not be parsed. Please try again.';
  }
  if (message.includes('菜谱步骤模型返回内容无法解析')) {
    return 'The cooking steps response could not be parsed. Please try again.';
  }
  if (message.includes('未返回') || message.includes('无效')) {
    return 'The response did not include valid data. Please try again.';
  }
  if (/[\u4e00-\u9fa5]/.test(message)) {
    return 'Request failed. Please try again later.';
  }

  return message;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const headers = new Headers(init?.headers ?? {});

  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let message = getCurrentLocale() === 'en' ? 'Request failed. Please try again later.' : '请求失败，请稍后再试。';
    let code: string | undefined;

    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      code = payload.error?.code;
      message = localizeApiErrorMessage(payload.error?.message ?? message);
    } catch {
      // Ignore JSON parse errors and keep default message.
    }

    throw new ApiError(localizeApiErrorMessage(message), response.status, code);
  }

  const payload = (await response.json()) as ApiEnvelope<T>;
  return payload.data;
}

async function streamRequest(path: string, init: RequestInit, onEvent: (event: StreamEvent) => void) {
  const headers = new Headers(init.headers ?? {});
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok || !response.body) {
    let message = getCurrentLocale() === 'en' ? 'Request failed. Please try again later.' : '请求失败，请稍后再试。';
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      message = localizeApiErrorMessage(payload.error?.message ?? message);
    } catch {
      // Keep default message.
    }
    throw new Error(localizeApiErrorMessage(message));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      onEvent(event);
    }
  }
}

export function fetchChildProfiles() {
  return request<ChildProfile[]>('/child-profiles');
}

export function createChildProfile(payload: CreateChildProfileInput) {
  return request<ChildProfile>('/child-profiles', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function parseIngredientText(text: string) {
  const normalizedText = text.trim();

  return request<{ ingredients: IngredientItem[] }>('/ingredients/parse-text', {
    method: 'POST',
    body: JSON.stringify({ text: normalizedText }),
  });
}

export function uploadIngredientImage(file: File) {
  const form = new FormData();
  form.append('image', file);

  return request<ImageRecognitionResponse>('/ingredients/recognize-image', {
    method: 'POST',
    body: form,
  });
}

export function uploadVoiceAudio(file: File) {
  const form = new FormData();
  form.append('audio', file);

  return request<VoiceParseResponse>('/ingredients/parse-voice', {
    method: 'POST',
    body: form,
  });
}

export function fetchSeasonalIngredientSuggestions(month: number, childContext: string) {
  return request<{ suggestions: SeasonalIngredientSuggestion[] }>('/ingredients/seasonal-suggestions', {
    method: 'POST',
    body: JSON.stringify({
      month,
      childContext: childContext.trim().slice(0, 120),
    }),
  });
}

export function fetchIngredientKnowledge(name: string, options: GenerationLocaleOptions = {}) {
  return request<IngredientKnowledge>('/ingredients/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      name: name.trim().slice(0, 30),
      locale: options.locale ?? 'zh',
      pinyinMode: options.pinyinMode ?? true,
    }),
  });
}

export function fetchRecommendations(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  userPrompt = '',
  options: GenerationLocaleOptions = {},
) {
  const normalizedIngredients = ingredients.map((ingredient) => ({
    id: ingredient.id,
    name: ingredient.name,
    normalizedName: ingredient.normalizedName ?? ingredient.name,
    quantity: ingredient.quantity,
    source: ingredient.source,
  }));
  const payload = {
    profileId: profile.id,
    profile,
    userPrompt,
    locale: options.locale ?? 'zh',
    pinyinMode: options.pinyinMode ?? true,
    ingredients: normalizedIngredients,
    sortBy: 'balanced',
    allowExtraIngredients: true,
  };

  return request<RecommendationResponse>('/recommendations/recipes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function streamRecommendations(
  profile: ChildProfile,
  ingredients: IngredientItem[],
  userPrompt: string,
  options: GenerationLocaleOptions,
  onEvent: (event: StreamEvent) => void,
) {
  const normalizedIngredients = ingredients.map((ingredient) => ({
    id: ingredient.id,
    name: ingredient.name,
    normalizedName: ingredient.normalizedName ?? ingredient.name,
    quantity: ingredient.quantity,
    source: ingredient.source,
  }));

  return streamRequest('/recommendations/recipes/stream', {
    method: 'POST',
    body: JSON.stringify({
      profileId: profile.id,
      profile,
      userPrompt,
      locale: options.locale ?? 'zh',
      pinyinMode: options.pinyinMode ?? true,
      ingredients: normalizedIngredients,
      sortBy: 'balanced',
      allowExtraIngredients: true,
    }),
  }, onEvent);
}

export function fetchRecipeDetail(recipeId: string) {
  return request<RecipeDetail>(`/recipes/${recipeId}`);
}

export function fetchGeneratedRecipeDetail(payload: {
  profileId: string;
  profile: ChildProfile;
  ingredients: IngredientItem[];
  recipe: RecipeDetail | RecipeRecommendation;
  locale?: 'zh' | 'en';
  pinyinMode?: boolean;
}) {
  const recipe = payload.recipe;
  const requestPayload = {
    profileId: payload.profileId,
    locale: payload.locale ?? 'zh',
    pinyinMode: payload.pinyinMode ?? true,
    ingredients: payload.ingredients.map((ingredient) => ({
      name: ingredient.name,
      normalizedName: ingredient.normalizedName ?? ingredient.name,
      quantity: ingredient.quantity,
      source: ingredient.source,
    })),
    recipe: {
      id: recipe.id,
      name: recipe.name,
      namePinyin: recipe.namePinyin,
      englishName: recipe.englishName,
      ageRange: recipe.ageRange,
      difficulty: recipe.difficulty,
      estimatedTimeMinutes: recipe.estimatedTimeMinutes,
      fitReasons: recipe.fitReasons,
      riskAlerts: recipe.riskAlerts,
      nutritionSummary: recipe.nutritionSummary,
      extraIngredients: recipe.extraIngredients,
      canCookWithCurrentIngredients: recipe.canCookWithCurrentIngredients,
    },
  };

  return request<RecipeDetail>('/recipes/detail', {
    method: 'POST',
    body: JSON.stringify(requestPayload),
  });
}

export function streamGeneratedRecipeDetail(
  payload: {
    profileId: string;
    profile: ChildProfile;
    ingredients: IngredientItem[];
    recipe: RecipeDetail | RecipeRecommendation;
    locale?: 'zh' | 'en';
    pinyinMode?: boolean;
  },
  onEvent: (event: StreamEvent) => void,
) {
  const recipe = payload.recipe;
  return streamRequest('/recipes/detail/stream', {
    method: 'POST',
    body: JSON.stringify({
      profileId: payload.profileId,
      locale: payload.locale ?? 'zh',
      pinyinMode: payload.pinyinMode ?? true,
      ingredients: payload.ingredients.map((ingredient) => ({
        name: ingredient.name,
        normalizedName: ingredient.normalizedName ?? ingredient.name,
        quantity: ingredient.quantity,
        source: ingredient.source,
      })),
      recipe: {
        id: recipe.id,
        name: recipe.name,
        namePinyin: recipe.namePinyin,
        englishName: recipe.englishName,
        ageRange: recipe.ageRange,
        difficulty: recipe.difficulty,
        estimatedTimeMinutes: recipe.estimatedTimeMinutes,
        fitReasons: recipe.fitReasons,
        riskAlerts: recipe.riskAlerts,
        nutritionSummary: recipe.nutritionSummary,
        extraIngredients: recipe.extraIngredients,
        canCookWithCurrentIngredients: recipe.canCookWithCurrentIngredients,
      },
    }),
  }, onEvent);
}

export function submitCookingFeedback(payload: {
  profileId: string;
  profile: ChildProfile;
  recipeId: string;
  recipe: RecipeDetail;
  tasteFeedback: string;
  difficultyFeedback: string;
  imageUrl?: string;
}) {
  return request<FeedbackResponse>('/cooking-feedback', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchLlmLogs(params: {
  start?: string;
  end?: string;
  keyword?: string;
  limit?: number;
}) {
  const search = new URLSearchParams();

  if (params.start) search.set('start', params.start);
  if (params.end) search.set('end', params.end);
  if (params.keyword) search.set('keyword', params.keyword);
  if (params.limit) search.set('limit', String(params.limit));

  const query = search.toString();
  return request<LlmLogQueryResult>(`/debug/llm-logs${query ? `?${query}` : ''}`);
}

export function loginVideoConfig(payload: { username: string; password: string }) {
  return request<{ token: string; user: { username: string; permissions: string[] } }>('/video-config/auth', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchRecipeVideoConfigs(params: {
  token: string;
  page: number;
  pageSize: number;
  keyword?: string;
  resolution?: '' | '720p' | '1080p';
  sortBy?: 'recipeName' | 'durationSeconds' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}) {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.keyword) search.set('keyword', params.keyword);
  if (params.resolution) search.set('resolution', params.resolution);
  if (params.sortBy) search.set('sortBy', params.sortBy);
  if (params.sortOrder) search.set('sortOrder', params.sortOrder);

  return request<RecipeVideoConfigListResult>(`/video-config/recipes?${search.toString()}`, {
    headers: { Authorization: `Bearer ${params.token}` },
  });
}

export function createRecipeVideoConfig(token: string, payload: RecipeVideoConfigInput) {
  return request<RecipeCookingVideo>('/video-config/recipes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export function updateRecipeVideoConfig(token: string, id: string, payload: RecipeVideoConfigInput) {
  return request<RecipeCookingVideo>(`/video-config/recipes/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export function deleteRecipeVideoConfig(token: string, id: string) {
  return request<{ ok: boolean }>(`/video-config/recipes/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function matchRecipeVideo(recipeName: string) {
  return request<{ video: RecipeCookingVideo | null }>('/recipe-videos/match', {
    method: 'POST',
    body: JSON.stringify({ recipeName }),
  });
}
