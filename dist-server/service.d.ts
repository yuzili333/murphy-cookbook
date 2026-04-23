import { type IngredientItem } from './data.js';
export declare function parseTextToIngredients(text: string): IngredientItem[];
export declare function recommendRecipes(profileId: string, ingredients: IngredientItem[]): {
    error: {
        code: string;
        message: string;
    };
    data?: undefined;
} | {
    data: {
        recipes: {
            canCookWithCurrentIngredients: boolean;
            extraIngredients: string[];
            id: string;
            name: string;
            ageRange: string;
            difficulty: "easy" | "medium" | "hard";
            estimatedTimeMinutes: number;
            fitReasons: string[];
            riskAlerts: string[];
            nutritionSummary: string;
        }[];
        filteredAllergens: string[];
        sortBy: string;
    };
    error?: undefined;
};
export declare function extractIngredientsFromFilename(filename: string): IngredientItem[];
