export interface SeasonalIngredientSuggestion {
  name: string;
  reason: string;
}

type Season = 'spring' | 'summer' | 'autumn' | 'winter';

const springIngredients = [
  '菠菜', '油菜', '小白菜', '菜心', '芦笋', '春笋', '莴笋', '豌豆', '荷兰豆', '蚕豆',
  '香椿', '荠菜', '马兰头', '韭菜', '蒜苗', '茼蒿', '生菜', '西洋菜', '苋菜', '茭白',
  '樱桃萝卜', '水萝卜', '胡萝卜', '白萝卜', '卷心菜', '紫甘蓝', '西兰花', '花椰菜', '芹菜', '黄瓜',
  '番茄', '草莓', '樱桃', '枇杷', '桑葚', '青梅', '菠萝', '木瓜', '芒果', '莲雾',
  '春橙', '沃柑', '丑橘', '金桔', '柠檬', '青苹果', '梨', '香蕉', '猕猴桃', '蓝莓',
  '甜豆', '豌豆苗', '豆苗', '油麦菜', '空心菜', '丝瓜', '佛手瓜', '冬瓜', '南瓜苗', '土豆',
  '山药', '莲藕', '蘑菇', '香菇', '平菇', '金针菇', '口蘑', '木耳菜', '苦菊', '娃娃菜',
  '上海青', '芥蓝', '青椒', '彩椒', '西葫芦',
];

const summerIngredients = [
  '西瓜', '甜瓜', '哈密瓜', '香瓜', '黄瓜', '丝瓜', '苦瓜', '冬瓜', '南瓜', '西葫芦',
  '番茄', '圣女果', '茄子', '彩椒', '青椒', '玉米', '毛豆', '四季豆', '豇豆', '扁豆',
  '空心菜', '苋菜', '油麦菜', '生菜', '小白菜', '油菜', '芹菜', '苦菊', '茼蒿', '木耳菜',
  '莲藕', '茭白', '荸荠', '菱角', '山药', '土豆', '红薯叶', '南瓜藤', '佛手瓜', '芦笋',
  '桃子', '油桃', '蟠桃', '李子', '杏', '杨梅', '荔枝', '龙眼', '芒果', '菠萝',
  '火龙果', '木瓜', '香蕉', '葡萄', '蓝莓', '树莓', '无花果', '梨', '苹果', '柠檬',
  '百香果', '莲雾', '椰子', '猕猴桃', '牛油果', '秋葵', '芋头', '蘑菇', '香菇', '金针菇',
  '平菇', '口蘑', '竹荪', '银耳', '海带',
];

const autumnIngredients = [
  '南瓜', '贝贝南瓜', '红薯', '紫薯', '山药', '莲藕', '芋头', '土豆', '胡萝卜', '白萝卜',
  '青萝卜', '莴笋', '芹菜', '菠菜', '小白菜', '油菜', '上海青', '娃娃菜', '大白菜', '卷心菜',
  '西兰花', '花椰菜', '紫甘蓝', '秋葵', '玉米', '毛豆', '豌豆', '四季豆', '豇豆', '扁豆',
  '茄子', '番茄', '彩椒', '黄瓜', '冬瓜', '丝瓜', '佛手瓜', '茭白', '荸荠', '菱角',
  '梨', '雪梨', '苹果', '柿子', '葡萄', '提子', '石榴', '猕猴桃', '橙子', '柚子',
  '蜜柚', '橘子', '金桔', '山楂', '枣', '冬枣', '无花果', '火龙果', '香蕉', '木瓜',
  '蓝莓', '柠檬', '百香果', '莲雾', '蘑菇', '香菇', '平菇', '金针菇', '口蘑', '杏鲍菇',
  '木耳', '银耳', '海带', '紫菜', '竹荪',
];

const winterIngredients = [
  '大白菜', '娃娃菜', '小白菜', '油菜', '上海青', '菠菜', '茼蒿', '芹菜', '芥蓝', '菜心',
  '西兰花', '花椰菜', '卷心菜', '紫甘蓝', '白萝卜', '胡萝卜', '青萝卜', '红薯', '紫薯', '土豆',
  '山药', '芋头', '莲藕', '南瓜', '冬瓜', '莴笋', '茭白', '荸荠', '洋葱', '大葱',
  '蒜苗', '韭黄', '豆芽', '黄豆芽', '绿豆芽', '豆腐', '蘑菇', '香菇', '平菇', '金针菇',
  '口蘑', '杏鲍菇', '木耳', '银耳', '海带', '紫菜', '竹荪', '苹果', '梨', '雪梨',
  '橙子', '脐橙', '血橙', '柚子', '蜜柚', '橘子', '砂糖橘', '沃柑', '金桔', '柠檬',
  '猕猴桃', '香蕉', '草莓', '冬枣', '山楂', '甘蔗', '石榴', '木瓜', '火龙果', '牛油果',
  '百合', '莲子', '板栗', '甜玉米', '彩椒',
];

const seasonalIngredients: Record<Season, string[]> = {
  spring: springIngredients,
  summer: summerIngredients,
  autumn: autumnIngredients,
  winter: winterIngredients,
};

function getSeason(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

const seasonReasons: Record<Season, string[]> = {
  spring: ['清新爽口', '维生素多', '适合春天', '口感清甜'],
  summer: ['清爽补水', '夏天解暑', '口感脆甜', '轻爽好吃'],
  autumn: ['润燥温和', '秋天适合', '香甜好做', '营养丰富'],
  winter: ['温和易做', '冬天适合', '清淡暖胃', '营养均衡'],
};

function shuffle<T>(items: T[]) {
  const copied = [...items];
  for (let index = copied.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copied[index], copied[swapIndex]] = [copied[swapIndex], copied[index]];
  }
  return copied;
}

export function getLocalSeasonalIngredientSuggestions(monthInput: number, count = 3): SeasonalIngredientSuggestion[] {
  const month = Number.isFinite(monthInput) && monthInput >= 1 && monthInput <= 12
    ? Math.trunc(monthInput)
    : new Date().getMonth() + 1;
  const season = getSeason(month);
  const reasons = seasonReasons[season];

  return shuffle(seasonalIngredients[season])
    .slice(0, Math.max(1, count))
    .map((name, index) => ({
      name,
      reason: reasons[index % reasons.length],
    }));
}

export const seasonalIngredientCacheSize = Object.values(seasonalIngredients)
  .reduce((total, items) => total + items.length, 0);
