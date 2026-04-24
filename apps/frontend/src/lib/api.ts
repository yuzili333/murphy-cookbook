import type {
  ChildProfile,
  FeedbackResponse,
  IngredientItem,
  ImageRecognitionResponse,
  RecipeDetail,
  RecommendationResponse,
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

export function parseIngredientText(text: string) {
  return request<{ ingredients: IngredientItem[] }>('/ingredients/parse-text', {
    method: 'POST',
    body: JSON.stringify({ text }),
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

export function fetchRecommendations(profileId: string, ingredients: IngredientItem[]) {
  return request<RecommendationResponse>('/recommendations/recipes', {
    method: 'POST',
    body: JSON.stringify({
      profileId,
      ingredients: ingredients.map((ingredient) => ({
        name: ingredient.name,
        normalizedName: ingredient.normalizedName ?? ingredient.name,
        quantity: ingredient.quantity,
        source: ingredient.source,
      })),
      sortBy: 'balanced',
      allowExtraIngredients: true,
    }),
  });
}

export function fetchRecipeDetail(recipeId: string) {
  return request<RecipeDetail>(`/recipes/${recipeId}`);
}

export function submitCookingFeedback(payload: {
  profileId: string;
  recipeId: string;
  tasteFeedback: string;
  difficultyFeedback: string;
  imageUrl?: string;
}) {
  return request<FeedbackResponse>('/cooking-feedback', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchRecentCooked() {
  return request<RecipeDetail[]>('/history/recent-cooked');
}
