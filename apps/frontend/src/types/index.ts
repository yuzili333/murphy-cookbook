export type PageId =
  | 'home'
  | 'favorites'
  | 'profile'
  | 'input'
  | 'confirm'
  | 'recipes'
  | 'detail'
  | 'cooking'
  | 'feedback'
  | 'logs';

export interface ChildProfile {
  id: string;
  nickname: string;
  age: number;
  tastePreferences: string[];
  allergens: string[];
  dietaryHabits: string[];
}

export interface CreateChildProfileInput {
  nickname: string;
  age: number;
  tastePreferences: string[];
  allergens: string[];
  dietaryHabits: string[];
}

export interface IngredientItem {
  id: string;
  name: string;
  normalizedName?: string;
  quantity: string;
  source: 'image' | 'voice' | 'manual';
  confidence?: number | null;
}

export interface RecipeRecommendation {
  id: string;
  name: string;
  namePinyin?: string;
  imageUrl?: string;
  ageRange: string;
  difficulty: 'easy' | 'medium' | 'hard';
  estimatedTimeMinutes: number;
  fitReasons: string[];
  riskAlerts: string[];
  nutritionSummary: string;
  extraIngredients: string[];
  canCookWithCurrentIngredients?: boolean;
}

export interface CookingStep {
  id: string;
  title: string;
  description: string;
  tip: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiresParentAssist: boolean;
  childAction?: string;
  parentAction?: string;
  expectedResult?: string;
}

export interface RecipeDetail extends RecipeRecommendation {
  prepTimeMinutes: number;
  cookTimeMinutes: number;
  ingredients: Array<{ name: string; quantity: string; imageUrl?: string }>;
  steps: CookingStep[];
}

export interface RecommendationResponse {
  recipes: RecipeRecommendation[];
  filteredAllergens: string[];
  sortBy: string;
}

export interface FeedbackResponse {
  praise: string;
  improvement: string;
  nextSuggestion: string;
}

export interface UploadResult {
  filename: string;
  mimetype: string;
  size: number;
}

export interface ImageRecognitionResponse {
  ingredients: IngredientItem[];
  upload: UploadResult;
}

export interface VoiceParseResponse {
  transcript: string;
  ingredients: IngredientItem[];
  upload: UploadResult;
}

export interface LlmLogEntry {
  timestamp?: string;
  type?: string;
  operation?: string;
  model?: string;
  success?: boolean;
  durationMs?: number;
  status?: number;
  error?: string;
  responsePreview?: string;
  requestSummary?: unknown;
  metadata?: Record<string, unknown>;
  usage?: Record<string, unknown> | null;
}

export interface LlmLogQueryResult {
  items: LlmLogEntry[];
  filters: {
    start: string;
    end: string;
    keyword: string;
    limit: number;
  };
  logFile: string;
}
