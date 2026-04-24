const ingredientEmojiMap: Record<string, string> = {
  番茄: '🍅',
  西红柿: '🍅',
  鸡蛋: '🥚',
  黄瓜: '🥒',
  胡萝卜: '🥕',
  土豆: '🥔',
  洋葱: '🧅',
  玉米: '🌽',
  南瓜: '🎃',
  西兰花: '🥦',
  花菜: '🥦',
  生菜: '🥬',
  白菜: '🥬',
  青菜: '🥬',
  菠菜: '🥬',
  蘑菇: '🍄',
  香菇: '🍄',
  茄子: '🍆',
  辣椒: '🌶️',
  青椒: '🫑',
  红椒: '🫑',
  彩椒: '🫑',
  豆腐: '🧈',
  苹果: '🍎',
  香蕉: '🍌',
  草莓: '🍓',
  橙子: '🍊',
  柠檬: '🍋',
  葡萄: '🍇',
};

const ingredientPaletteMap: Record<string, { start: string; end: string }> = {
  番茄: { start: '#ffb3a7', end: '#ff735f' },
  西红柿: { start: '#ffb3a7', end: '#ff735f' },
  鸡蛋: { start: '#fff1b3', end: '#ffd46c' },
  黄瓜: { start: '#c8f3bf', end: '#79c96d' },
  胡萝卜: { start: '#ffd0a8', end: '#ff964f' },
  土豆: { start: '#f2ddbc', end: '#c49a6c' },
  洋葱: { start: '#f0d7ff', end: '#c599f1' },
  玉米: { start: '#fff1a8', end: '#ffc93d' },
  南瓜: { start: '#ffd3a5', end: '#ff9f52' },
  西兰花: { start: '#c8f0ba', end: '#53a65c' },
  花菜: { start: '#eff4d8', end: '#cbd785' },
  生菜: { start: '#d9f5c1', end: '#8ccf65' },
  白菜: { start: '#ecf9d6', end: '#9bcf7a' },
  青菜: { start: '#d4f3c4', end: '#68b56e' },
  菠菜: { start: '#cfeec1', end: '#4ea05a' },
  蘑菇: { start: '#efdcc9', end: '#b68a67' },
  香菇: { start: '#efdcc9', end: '#9d7557' },
  茄子: { start: '#ebd4ff', end: '#9b67d8' },
  辣椒: { start: '#ffc3bc', end: '#ff7364' },
  青椒: { start: '#d2f5bf', end: '#63bb60' },
  红椒: { start: '#ffc7b1', end: '#ff7d58' },
  彩椒: { start: '#ffe5a8', end: '#ff9d52' },
  豆腐: { start: '#fff7db', end: '#f0dfab' },
  苹果: { start: '#ffd0cf', end: '#ff6d6a' },
  香蕉: { start: '#fff0aa', end: '#ffd44f' },
  草莓: { start: '#ffc4d8', end: '#ff6d90' },
  橙子: { start: '#ffd6a8', end: '#ff944d' },
  柠檬: { start: '#fff1a6', end: '#f5d94b' },
  葡萄: { start: '#ead5ff', end: '#9b69d2' },
};

function resolveEmoji(name: string) {
  return ingredientEmojiMap[name] ?? '🥗';
}

function resolvePalette(name: string) {
  return ingredientPaletteMap[name] ?? { start: '#dff4ea', end: '#9bd4b2' };
}

function buildIngredientSvg(name: string) {
  const emoji = resolveEmoji(name);
  const palette = resolvePalette(name);
  const safeLabel = name.replace(/[&<>"']/g, '');

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="${safeLabel}">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${palette.start}" />
          <stop offset="100%" stop-color="${palette.end}" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="24" fill="url(#bg)" />
      <circle cx="48" cy="38" r="22" fill="rgba(255,255,255,0.34)" />
      <text x="48" y="50" text-anchor="middle" font-size="28">${emoji}</text>
      <rect x="12" y="64" width="72" height="18" rx="9" fill="rgba(255,255,255,0.76)" />
      <text x="48" y="77" text-anchor="middle" font-size="11" font-family="Arial, PingFang SC, sans-serif" fill="#294347">${safeLabel}</text>
    </svg>
  `;
}

function toDataUrl(svg: string) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

interface IngredientThumbProps {
  name: string;
}

export function IngredientThumb({ name }: IngredientThumbProps) {
  return <img className="ingredient-thumb" src={toDataUrl(buildIngredientSvg(name))} alt={name} loading="lazy" />;
}
