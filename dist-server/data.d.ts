export interface ChildProfile {
    id: string;
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
}
export interface RecipeDetail extends RecipeRecommendation {
    prepTimeMinutes: number;
    cookTimeMinutes: number;
    ingredients: Array<{
        name: string;
        quantity: string;
    }>;
    steps: CookingStep[];
}
export declare const childProfiles: ChildProfile[];
export declare const recipeCatalog: RecipeDetail[];
export declare function normalizeIngredientName(name: string): string;
export declare function createIngredient(name: string, source: IngredientItem['source'], quantity?: string): IngredientItem;
export declare function summarizeRecipe(recipe: RecipeDetail): RecipeRecommendation;
