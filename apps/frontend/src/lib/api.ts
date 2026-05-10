import type {
  ChildProfile,
  CreateChildProfileInput,
  FeedbackResponse,
  IngredientItem,
  ImageRecognitionResponse,
  LlmLogQueryResult,
  RecipeDetail,
  RecipeRecommendation,
  RecommendationResponse,
  SeasonalIngredientSuggestion,
  VoiceParseResponse,
} from '../types';

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

interface ApiEnvelope<T> {
  data: T;
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
    let message = '请求失败，请稍后再试。';

    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      message = payload.error?.message ?? message;
    } catch {
      // Ignore JSON parse errors and keep default message.
    }

    throw new Error(message);
  }

  const payload = (await response.json()) as ApiEnvelope<T>;
  return payload.data;
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
  const query = new URLSearchParams({ text: normalizedText }).toString();

  return request<{ ingredients: IngredientItem[] }>(`/ingredients/parse-text?${query}`, {
    method: 'POST',
    body: JSON.stringify({ text: normalizedText, message: normalizedText }),
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
  const query = new URLSearchParams({
    month: String(month),
    childContext,
  }).toString();

  return request<{ suggestions: SeasonalIngredientSuggestion[] }>(`/ingredients/seasonal-suggestions?${query}`);
}

export function fetchRecommendations(profile: ChildProfile, ingredients: IngredientItem[], userPrompt = '') {
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
    ingredients: normalizedIngredients,
    sortBy: 'balanced',
    allowExtraIngredients: true,
  };
  const query = new URLSearchParams({
    profileId: payload.profileId,
    userPrompt,
    ingredients: JSON.stringify(normalizedIngredients),
  }).toString();

  return request<RecommendationResponse>(`/recommendations/recipes?${query}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchRecipeDetail(recipeId: string) {
  return request<RecipeDetail>(`/recipes/${recipeId}`);
}

export function fetchGeneratedRecipeDetail(payload: {
  profileId: string;
  profile: ChildProfile;
  ingredients: IngredientItem[];
  recipe: RecipeDetail | RecipeRecommendation;
}) {
  const requestPayload = {
    profileId: payload.profileId,
    profile: payload.profile,
    ingredients: payload.ingredients.map((ingredient) => ({
      name: ingredient.name,
      normalizedName: ingredient.normalizedName ?? ingredient.name,
      quantity: ingredient.quantity,
      source: ingredient.source,
    })),
    recipe: payload.recipe,
  };

  return request<RecipeDetail>('/recipes/detail', {
    method: 'POST',
    body: JSON.stringify(requestPayload),
  });
}

export function fetchGeneratedRecipeDetails(payload: {
  profileId: string;
  profile: ChildProfile;
  ingredients: IngredientItem[];
  recipes: Array<RecipeDetail | RecipeRecommendation>;
}) {
  const requestPayload = {
    profileId: payload.profileId,
    profile: payload.profile,
    ingredients: payload.ingredients.map((ingredient) => ({
      name: ingredient.name,
      normalizedName: ingredient.normalizedName ?? ingredient.name,
      quantity: ingredient.quantity,
      source: ingredient.source,
    })),
    recipes: payload.recipes,
  };

  return request<RecipeDetail[]>('/recipes/details', {
    method: 'POST',
    body: JSON.stringify(requestPayload),
  });
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
