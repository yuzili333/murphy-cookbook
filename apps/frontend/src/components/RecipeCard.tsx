import type { RecipeRecommendation } from '../types';
import { RecipeName } from './RecipeName';
import { ZoomableImage } from './ZoomableImage';

interface RecipeCardProps {
  recipe: RecipeRecommendation;
  onSelect: (id: string) => void;
  onToggleFavorite: (recipe: RecipeRecommendation) => void;
  isFavorite: boolean;
}

export function RecipeCard({ recipe, onSelect, onToggleFavorite, isFavorite }: RecipeCardProps) {
  return (
    <article className="recipe-card">
      <ZoomableImage className="recipe-cover" src={recipe.imageUrl} alt={recipe.name} />
      <div className="recipe-header">
        <div>
          <RecipeName as="h3" name={recipe.name} pinyin={recipe.namePinyin} />
          <p className="muted">
            {recipe.ageRange} · {recipe.difficulty} · {recipe.estimatedTimeMinutes}{' '}
            分钟
          </p>
        </div>
        <div className="action-row">
          <button type="button" className="ghost-button" onClick={() => onToggleFavorite(recipe)}>
            {isFavorite ? '取消收藏' : '收藏'}
          </button>
          <button type="button" className="ghost-button" onClick={() => onSelect(recipe.id)}>
            查看详情
          </button>
        </div>
      </div>

      <div className="chip-row">
        {recipe.fitReasons.map((reason) => (
          <span key={reason} className="chip fit-chip">
            {reason}
          </span>
        ))}
      </div>

      <p className="muted">{recipe.nutritionSummary}</p>

      {recipe.extraIngredients.length > 0 ? (
        <p className="muted">
          还需补充：{recipe.extraIngredients.join('、')}
        </p>
      ) : (
        <p className="muted accent-text">现有食材已基本够用，可以直接开做。</p>
      )}

      {recipe.riskAlerts.length > 0 ? (
        <div className="alert-box">
          <strong>安全提醒</strong>
          <ul>
            {recipe.riskAlerts.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
