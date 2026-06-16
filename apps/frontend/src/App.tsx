import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent, type TouchEvent } from 'react';
import { motion, useReducedMotion, type PanInfo } from 'framer-motion';
import { AppShell } from './components/AppShell';
import { RecipeName } from './components/RecipeName';
import { RecipeVideoPlayer } from './components/RecipeVideoPlayer';
import audioPlayIcon from './assets/audio-play.svg';
import loadingIcon from './assets/loading.svg';
import newChatIcon from './assets/new-chat.svg';
import sendMessageIcon from './assets/send-message.svg';
import { defaultIngredientVisual, getIngredientVisual } from './data/ingredientVisuals';
import {
  fetchIngredientKnowledge,
  fetchSeasonalIngredientSuggestions,
  matchRecipeVideo,
  parseIngredientText,
  streamGeneratedRecipeDetail,
  streamRecommendations,
  uploadIngredientImage,
} from './lib/api';
import { applyStreamEvent } from './lib/streamAst';
import { buildCharacterSpeech, formatPinyin, speak, stopSpeaking } from './lib/speech';
import type {
  ChildProfile,
  IngredientKnowledge,
  IngredientItem,
  RecipeDetail,
  RecipeCookingVideo,
  RecipeRecommendation,
  RecommendationResponse,
  SeasonalIngredientSuggestion,
  MessageNode,
  StreamEvent,
} from './types';

const favoriteRecipesStorageKey = 'murphy-cookbook.favorite-recipes.v1';
const chatMessagesStorageKey = 'murphy-cookbook.chat-messages.v1';
const likedRecipesStorageKey = 'murphy-cookbook.liked-recipes.v1';
const childContextStorageKey = 'murphy-cookbook.child-context.v1';
const chatSessionsStorageKey = 'murphy-cookbook.chat-sessions.v1';
const activeChatSessionStorageKey = 'murphy-cookbook.active-chat-session.v1';
const recommendationCacheStorageKey = 'murphy-cookbook.recommendation-cache.v1';
const recipeStepCacheStorageKey = 'murphy-cookbook.recipe-step-cache.v2';
const recipeVideoMatchCacheStorageKey = 'murphy-cookbook.recipe-video-match-cache.v1';
const ingredientKnowledgeCacheStorageKey = 'murphy-cookbook.ingredient-knowledge-cache.v1';
const legacyRecipeDetailCacheStorageKey = 'murphy-cookbook.recipe-detail-cache.v1';
const localeStorageKey = 'murphy-cookbook.locale.v1';
const pronunciationModeStorageKey = 'murphy-cookbook.pronunciation-mode.v1';
const splashDismissedStorageKey = 'murphy-cookbook.splash-dismissed.v1';
const webCacheTtlMs = 3 * 24 * 60 * 60 * 1000;
const conversationProfileId = 'chat_context_profile';
const defaultChildContext =
  '默认服务对象为小学 1-6 年级学生。推荐原则：低油脂、轻口味、膳食均衡、维生素丰富、主食蛋白质蔬菜搭配均衡，避免高糖、高盐、油炸和过度辛辣。未明确提及重度急性过敏风险时，不主动要求补充儿童年龄、饮食偏好或过敏原。';
type FavoriteRecipesByProfile = Record<string, RecipeRecommendation[]>;
type TimedCache<T> = Record<string, { createdAt: string; expiresAt: string; data: T }>;
type RecipeVideoCacheValue = {
  video: RecipeCookingVideo | null;
};
type AppLocale = 'zh' | 'en';
type RecipeCarouselMetrics = {
  viewportWidth: number;
  cardWidth: number;
  gap: number;
  paddingLeft: number;
};

const murphyAvatarImage = new URL('../../../design-image/murphy-avatar.png', import.meta.url).href;

const defaultChildContextEn =
  'Default audience: grade 1-6 students. Recipe principles: low oil, mild flavor, balanced meals, vitamin-rich ingredients, and balanced staples, protein, and vegetables. Avoid high sugar, high salt, deep-fried, and very spicy food. Unless a severe acute allergy risk is mentioned, do not ask for age, preferences, or allergens.';

const staticTextTranslations: Record<string, string> = {
  '我是智能儿童菜谱助手，已记录本次对话的特殊饮食信息，告诉我今天有什么食材，也可以拍照上传。':
    'I am your AI cookbook buddy. I saved the special diet notes for this chat. Tell me today’s ingredients or upload a photo.',
  '我是智能儿童菜谱助手，请通过文字、语音或拍照上传提供喜欢的食材':
    'I am your AI cookbook buddy. Share ingredients by typing, speaking, taking a photo, or uploading an image.',
  '我还没有识别到可用食材。你可以输入“鸡蛋、番茄、黄瓜”，或直接拍一张食材照片。':
    'I have not found any usable ingredients yet. Try typing “egg, tomato, cucumber” or take a photo of your ingredients.',
  '正在生成菜谱推荐...': 'Generating recipe ideas...',
  '你提到了可能引发严重急性过敏的情况。我已记录这条特殊饮食信息。为了更安全，请补充孩子是否已确诊相关食材过敏、严重程度，以及是否需要完全避开这类食材。':
    'You mentioned a possible severe allergy risk. I saved this special diet note. For safety, please add whether the child has a confirmed allergy, how severe it is, and whether the ingredient must be fully avoided.',
  '一次最多支持 10 个食材。当前识别后会超过上限，请减少食材或换一组食材。':
    'Up to 10 ingredients are supported at once. This result would exceed the limit, so please remove some ingredients or try another set.',
  '一次最多支持 10 个食材。请先减少食材数量，再获取推荐菜谱。':
    'Up to 10 ingredients are supported at once. Please remove some ingredients before getting recipe ideas.',
  '我识别到了这些食材。你可以继续补充食材，也可以直接搜索菜谱。':
    'I found these ingredients. You can add more or get recipe ideas now.',
  '我暂时没有识别到明确食材，可以换一种说法再试。':
    'I could not find a clear ingredient yet. Try saying it another way.',
  '食材识别失败，请稍后再试。': 'Ingredient recognition failed. Please try again later.',
  '我上传了一张食材图片': 'I uploaded an ingredient photo.',
  '图片识别出的食材加入后会超过 10 个上限，请减少食材后再继续。':
    'The photo result would exceed the 10 ingredient limit. Please remove some ingredients first.',
  '我从图片里识别到了这些食材。': 'I found these ingredients in the photo.',
  '我暂时没有从图片里识别到明确食材。': 'I could not find clear ingredients in the photo yet.',
  接口数据响应超时: 'Request timed out',
  '接口超时，稍后重试。': 'Request timed out. Please try again later.',
  '菜谱推荐生成失败。': 'Recipe generation failed.',
  '菜谱详情生成失败。': 'Cooking steps generation failed.',
  '请提供有效的推荐菜谱卡片信息。': 'Please provide a valid recipe card.',
};

function localizeErrorMessage(message: string, locale: AppLocale) {
  if (locale !== 'en') {
    return message;
  }

  if (!message) {
    return 'Request failed. Please try again later.';
  }

  const normalized = message.replace(/\s+/g, '');
  const exactTranslations: Record<string, string> = {
    '请求失败，请稍后再试。': 'Request failed. Please try again later.',
    '请求失败，请稍后尝试。': 'Request failed. Please try again later.',
    '流式消息解析失败。': 'Failed to parse the streaming response.',
    '菜谱推荐模型返回内容无法解析为有效JSON。': 'The recipe recommendation response could not be parsed.',
    '菜谱步骤模型返回内容无法解析为有效JSON。': 'The cooking steps response could not be parsed.',
    '接口数据响应超时': 'Request timed out.',
    '接口超时，稍后重试。': 'Request timed out. Please try again later.',
    '推荐失败，请稍后重试。': 'Recipe recommendation failed. Please try again later.',
    '菜谱推荐生成失败。': 'Recipe generation failed.',
    '菜谱详情生成失败。': 'Cooking steps generation failed.',
    '菜谱步骤获取失败。': 'Failed to get cooking steps.',
    '食材知识获取失败。': 'Failed to get ingredient notes.',
    '食材识别失败。': 'Ingredient recognition failed.',
    '食材识别失败，请稍后再试。': 'Ingredient recognition failed. Please try again later.',
    '图片上传失败。': 'Image upload failed.',
    '图片识别失败。': 'Image recognition failed.',
    '文本理解失败。': 'Failed to understand the text.',
    '语音文本解析失败。': 'Voice text parsing failed.',
    '语音文本理解失败。': 'Failed to understand the voice input.',
  };

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

const ingredientEnglishNameMap: Record<string, string> = {
  菠菜: 'Spinach',
  油菜: 'Bok choy',
  小白菜: 'Baby bok choy',
  菜心: 'Choy sum',
  芦笋: 'Asparagus',
  春笋: 'Spring bamboo shoots',
  莴笋: 'Celtuce',
  豌豆: 'Peas',
  荷兰豆: 'Snow peas',
  蚕豆: 'Broad beans',
  香椿: 'Toona sprouts',
  荠菜: 'Shepherd’s purse',
  马兰头: 'Indian aster',
  韭菜: 'Garlic chives',
  蒜苗: 'Garlic sprouts',
  茼蒿: 'Crown daisy',
  生菜: 'Lettuce',
  西洋菜: 'Watercress',
  苋菜: 'Amaranth greens',
  茭白: 'Water bamboo',
  樱桃萝卜: 'Cherry radish',
  水萝卜: 'Water radish',
  胡萝卜: 'Carrot',
  白萝卜: 'Daikon radish',
  卷心菜: 'Cabbage',
  紫甘蓝: 'Red cabbage',
  西兰花: 'Broccoli',
  花椰菜: 'Cauliflower',
  芹菜: 'Celery',
  黄瓜: 'Cucumber',
  番茄: 'Tomato',
  草莓: 'Strawberry',
  樱桃: 'Cherry',
  枇杷: 'Loquat',
  桑葚: 'Mulberry',
  青梅: 'Green plum',
  菠萝: 'Pineapple',
  木瓜: 'Papaya',
  芒果: 'Mango',
  莲雾: 'Wax apple',
  春橙: 'Spring orange',
  沃柑: 'Mandarin orange',
  丑橘: 'Dekopon',
  金桔: 'Kumquat',
  柠檬: 'Lemon',
  青苹果: 'Green apple',
  梨: 'Pear',
  香蕉: 'Banana',
  猕猴桃: 'Kiwi',
  蓝莓: 'Blueberry',
  甜豆: 'Sugar snap peas',
  豌豆苗: 'Pea shoots',
  豆苗: 'Bean sprouts',
  油麦菜: 'A choy',
  空心菜: 'Water spinach',
  丝瓜: 'Luffa',
  佛手瓜: 'Chayote',
  冬瓜: 'Winter melon',
  南瓜苗: 'Pumpkin shoots',
  土豆: 'Potato',
  山药: 'Chinese yam',
  莲藕: 'Lotus root',
  蘑菇: 'Mushroom',
  香菇: 'Shiitake mushroom',
  平菇: 'Oyster mushroom',
  金针菇: 'Enoki mushroom',
  口蘑: 'Button mushroom',
  木耳菜: 'Malabar spinach',
  苦菊: 'Bitter lettuce',
  娃娃菜: 'Baby napa cabbage',
  上海青: 'Shanghai bok choy',
  芥蓝: 'Chinese broccoli',
  青椒: 'Green pepper',
  彩椒: 'Bell pepper',
  西葫芦: 'Zucchini',
  西瓜: 'Watermelon',
  甜瓜: 'Melon',
  哈密瓜: 'Hami melon',
  香瓜: 'Muskmelon',
  苦瓜: 'Bitter melon',
  南瓜: 'Pumpkin',
  圣女果: 'Cherry tomato',
  茄子: 'Eggplant',
  玉米: 'Corn',
  毛豆: 'Edamame',
  四季豆: 'Green beans',
  豇豆: 'Yardlong beans',
  扁豆: 'Hyacinth beans',
  荸荠: 'Water chestnut',
  菱角: 'Water caltrop',
  红薯叶: 'Sweet potato leaves',
  南瓜藤: 'Pumpkin vines',
  桃子: 'Peach',
  油桃: 'Nectarine',
  蟠桃: 'Flat peach',
  李子: 'Plum',
  杏: 'Apricot',
  杏子: 'Apricot',
  杨梅: 'Waxberry',
  荔枝: 'Lychee',
  龙眼: 'Longan',
  火龙果: 'Dragon fruit',
  葡萄: 'Grapes',
  树莓: 'Raspberry',
  无花果: 'Fig',
  苹果: 'Apple',
  百香果: 'Passion fruit',
  椰子: 'Coconut',
  牛油果: 'Avocado',
  秋葵: 'Okra',
  芋头: 'Taro',
  竹荪: 'Bamboo fungus',
  银耳: 'Snow fungus',
  海带: 'Kelp',
  贝贝南瓜: 'Mini pumpkin',
  红薯: 'Sweet potato',
  紫薯: 'Purple sweet potato',
  青萝卜: 'Green radish',
  大白菜: 'Napa cabbage',
  雪梨: 'Snow pear',
  柿子: 'Persimmon',
  提子: 'Table grapes',
  石榴: 'Pomegranate',
  橙子: 'Orange',
  柚子: 'Pomelo',
  蜜柚: 'Honey pomelo',
  橘子: 'Tangerine',
  山楂: 'Hawthorn',
  枣: 'Jujube',
  冬枣: 'Winter jujube',
  杏鲍菇: 'King oyster mushroom',
  木耳: 'Wood ear mushroom',
  紫菜: 'Nori',
  洋葱: 'Onion',
  大葱: 'Scallion',
  韭黄: 'Yellow chives',
  豆芽: 'Bean sprouts',
  黄豆芽: 'Soybean sprouts',
  绿豆芽: 'Mung bean sprouts',
  豆腐: 'Tofu',
  脐橙: 'Navel orange',
  血橙: 'Blood orange',
  砂糖橘: 'Sugar mandarin',
  甘蔗: 'Sugarcane',
  百合: 'Lily bulb',
  莲子: 'Lotus seeds',
  板栗: 'Chestnut',
  甜玉米: 'Sweet corn',
  鸡蛋: 'Egg',
  面条: 'Noodles',
};

const seasonalReasonEnglishMap: Record<string, string> = {
  清新爽口: 'Fresh and crisp',
  维生素多: 'Rich in vitamins',
  适合春天: 'Great for spring',
  口感清甜: 'Sweet and mild',
  清爽补水: 'Refreshing and hydrating',
  夏天解暑: 'Cooling for summer',
  口感脆甜: 'Crisp and sweet',
  轻爽好吃: 'Light and tasty',
  润燥温和: 'Gentle and soothing',
  秋天适合: 'Great for autumn',
  香甜好做: 'Sweet and easy',
  营养丰富: 'Nutritious',
  温和易做: 'Mild and easy',
  冬天适合: 'Great for winter',
  清淡暖胃: 'Light and warming',
  营养均衡: 'Balanced nutrition',
};

function t(locale: AppLocale, zh: string, en: string) {
  return locale === 'en' ? en : zh;
}

function localizeStaticText(text: string, locale: AppLocale) {
  return locale === 'en' ? staticTextTranslations[text] ?? text : text;
}

function getIngredientDisplayName(name: string, locale: AppLocale) {
  return locale === 'en' ? ingredientEnglishNameMap[name] ?? name : name;
}

function getSeasonalReasonDisplay(reason: string, locale: AppLocale) {
  return locale === 'en' ? seasonalReasonEnglishMap[reason] ?? reason : reason;
}

function getSessionTitleDisplay(title: string, locale: AppLocale) {
  return locale === 'en' && title === '新对话' ? 'New Chat' : title;
}

function readLocale(): AppLocale {
  if (typeof window === 'undefined') {
    return 'zh';
  }

  return window.localStorage.getItem(localeStorageKey) === 'en' ? 'en' : 'zh';
}

function persistLocale(locale: AppLocale) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(localeStorageKey, locale);
}

function readPronunciationMode() {
  if (typeof window === 'undefined') {
    return true;
  }

  return window.localStorage.getItem(pronunciationModeStorageKey) !== 'off';
}

function persistPronunciationMode(enabled: boolean) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(pronunciationModeStorageKey, enabled ? 'on' : 'off');
}

function readSplashDismissed() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(splashDismissedStorageKey) === 'true';
}

function persistSplashDismissed() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(splashDismissedStorageKey, 'true');
}

const landingSceneImages = [
  new URL('../../../design-image/landing-page/storyboard_01_image.png', import.meta.url).href,
  new URL('../../../design-image/landing-page/storyboard_02_image.png', import.meta.url).href,
  new URL('../../../design-image/landing-page/storyboard_03_image.png', import.meta.url).href,
  new URL('../../../design-image/landing-page/storyboard_04_image.png', import.meta.url).href,
  new URL('../../../design-image/landing-page/storyboard_05_image.png', import.meta.url).href,
  new URL('../../../design-image/landing-page/storyboard_06_image.png', import.meta.url).href,
];

const englishLandingSceneImages = [
  landingSceneImages[0],
  new URL('../../../design-image/landing-page/storyboard_02_image_en.png', import.meta.url).href,
  new URL('../../../design-image/landing-page/storyboard_03_image_en.png', import.meta.url).href,
  new URL('../../../design-image/landing-page/storyboard_04_image_en.png', import.meta.url).href,
  new URL('../../../design-image/landing-page/storyboard_05_image_en.png', import.meta.url).href,
  landingSceneImages[5],
];

const splashStoryScenes = [
  {
    id: 'ingredient_discovery',
    scene: 1,
    zhTitle: '走进热闹菜市场',
    enTitle: 'Enter the Bustling Market',
    zhSubtitle: '发现新鲜好食材',
    enSubtitle: 'Discover fresh ingredients',
    zhNarration: '小墨菲和爸爸妈妈来到热闹的菜市场。琳琅满目的新鲜食材，让小朋友充满好奇。',
    enNarration: 'Murphy and the family arrive at a lively market. Surrounded by colorful fresh ingredients, the child becomes curious about everything they see.',
    zhImage: landingSceneImages[0],
    enImage: englishLandingSceneImages[0],
  },
  {
    id: 'ingredient_recognition',
    scene: 2,
    zhTitle: '识别食材',
    enTitle: 'Recognize Ingredients',
    zhSubtitle: '了解来源与营养',
    enSubtitle: 'Learn origins and nutrition',
    zhNarration: '小朋友看到喜欢的食材，只要用小墨菲扫一扫，就能知道它叫什么、从哪里来、现在是不是当季。',
    enNarration: 'When the child sees an interesting ingredient, Murphy can scan it and tell them its name, where it comes from, and whether it is in season.',
    zhImage: landingSceneImages[1],
    enImage: englishLandingSceneImages[1],
  },
  {
    id: 'ingredient_education',
    scene: 3,
    zhTitle: '科普食材知识',
    enTitle: 'Learn Ingredient Knowledge',
    zhSubtitle: '发现可制作的美味',
    enSubtitle: 'Discover delicious possibilities',
    zhNarration: '小墨菲把食材知识变成孩子看得懂的卡片，告诉小朋友食材的营养价值，还能推荐可以做成什么菜。',
    enNarration: 'Murphy turns ingredient knowledge into simple cards children can understand. It explains nutrition in a friendly way and shows what dishes can be made.',
    zhImage: landingSceneImages[2],
    enImage: englishLandingSceneImages[2],
  },
  {
    id: 'recipe_recommendation',
    scene: 4,
    zhTitle: '推荐菜谱',
    enTitle: 'Recommend Recipes',
    zhSubtitle: '为你量身定制',
    enSubtitle: 'Tailored to your ingredients',
    zhNarration: '根据一家人选好的食材，小墨菲会推荐适合孩子的营养菜谱，让今天买到的食材都能派上用场。',
    enNarration: 'Based on the ingredients the family has chosen, Murphy recommends nutritious recipes that are simple, fun, and suitable for kids.',
    zhImage: landingSceneImages[3],
    enImage: englishLandingSceneImages[3],
  },
  {
    id: 'guided_cooking_safety',
    scene: 5,
    zhTitle: '亲子烹饪',
    enTitle: 'Cook Together with Parents',
    zhSubtitle: '安全步骤与提醒',
    enSubtitle: 'Safe step-by-step guidance',
    zhNarration: '回到厨房后，小墨菲会一步一步告诉孩子怎么做。遇到刀具、热锅、明火和开水时，还会提醒必须由爸爸妈妈陪同完成。',
    enNarration: 'Back in the kitchen, Murphy guides the child step by step. When a step involves knives, hot pans, open flames, or boiling water, Murphy reminds the child to ask parents for help.',
    zhImage: landingSceneImages[4],
    enImage: englishLandingSceneImages[4],
  },
  {
    id: 'family_meal_sharing',
    scene: 6,
    zhTitle: '美味上桌',
    enTitle: 'Enjoy the Meal Together',
    zhSubtitle: '共享幸福时刻',
    enSubtitle: 'Share a happy family meal',
    zhNarration: '一道道菜端上餐桌，全家人一起品尝努力完成的美味。小朋友不只学会了做菜，也收获了自信和快乐。',
    enNarration: 'The dishes are served, and the whole family enjoys the meal together. The child not only learns how to cook, but also gains confidence and joy.',
    zhImage: landingSceneImages[5],
    enImage: englishLandingSceneImages[5],
  },
];

function getSplashSceneImage(scene: typeof splashStoryScenes[number], locale: AppLocale) {
  return locale === 'en' ? scene.enImage : scene.zhImage;
}

interface SplashStoryboardOpeningProps {
  locale: AppLocale;
  onEnter: () => void;
  onLocaleChange: (locale: AppLocale) => void;
  shouldReduceMotion: boolean;
}

function SplashLocaleSwitch({
  locale,
  onLocaleChange,
}: {
  locale: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
}) {
  const isEnglish = locale === 'en';
  return (
    <div className="landing-locale-switch" role="group" aria-label={isEnglish ? 'Switch opening language' : '切换开屏页语言'}>
      <button type="button" className={!isEnglish ? 'active' : undefined} onClick={() => onLocaleChange('zh')}>
        中文
      </button>
      <span aria-hidden="true">|</span>
      <button type="button" className={isEnglish ? 'active' : undefined} onClick={() => onLocaleChange('en')}>
        EN
      </button>
    </div>
  );
}

function SplashStoryboardOpening({
  locale,
  onEnter,
  onLocaleChange,
  shouldReduceMotion,
}: SplashStoryboardOpeningProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const isEnglish = locale === 'en';
  const lastIndex = splashStoryScenes.length - 1;
  const goToScene = (index: number) => {
    setActiveIndex((index + splashStoryScenes.length) % splashStoryScenes.length);
  };
  const handlePadDragEnd = (_: globalThis.MouseEvent | globalThis.TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.x < -64 || info.velocity.x < -420) {
      goToScene(activeIndex + 1);
      return;
    }
    if (info.offset.x > 64 || info.velocity.x > 420) {
      goToScene(activeIndex - 1);
    }
  };

  return (
    <section className="splash-screen landing-splash" aria-label={isEnglish ? 'Opening carousel' : '开屏轮播'}>
      <div className="landing-mobile-stack" aria-label={isEnglish ? 'Opening storyboard stack' : '手机端开屏分镜长页'}>
        <div className="landing-floating-controls">
          <div className="landing-brand">
            <span><img src={murphyAvatarImage} alt="" aria-hidden="true" /></span>
            <strong>{isEnglish ? "Murphy's Cookbook" : '小墨菲的美食宝典'}</strong>
          </div>
          <SplashLocaleSwitch locale={locale} onLocaleChange={onLocaleChange} />
        </div>

        <div className="landing-mobile-story-list">
          {splashStoryScenes.map((scene) => (
            <article key={scene.id} className="landing-mobile-story-card">
              <img src={getSplashSceneImage(scene, locale)} alt={isEnglish ? scene.enTitle : scene.zhTitle} loading="eager" decoding="sync" />
              <div className="landing-image-title">
                <span>{String(scene.scene).padStart(2, '0')}</span>
                <strong>{isEnglish ? scene.enTitle : scene.zhTitle}</strong>
              </div>
            </article>
          ))}
        </div>

        <div className="landing-bottom-actions">
          <button type="button" className="landing-primary-action" onClick={onEnter}>
            {isEnglish ? 'Start Exploring' : '开始探索'}
          </button>
          <button type="button" className="landing-secondary-action" onClick={onEnter}>
            {isEnglish ? 'Skip' : '跳过'}
          </button>
        </div>
      </div>

      <div className="landing-carousel landing-pad-carousel" aria-label={isEnglish ? 'Paginated opening carousel' : 'PAD 端分页开屏轮播'}>
        <div className="landing-floating-controls">
          <div className="landing-brand">
            <span><img src={murphyAvatarImage} alt="" aria-hidden="true" /></span>
            <div>
              <strong>{isEnglish ? "Murphy's Cookbook" : '小墨菲的美食宝典'}</strong>
              <small>{isEnglish ? 'AI Recipe Buddy for Kids' : '专为儿童设计的智能美食伙伴'}</small>
            </div>
          </div>
          <SplashLocaleSwitch locale={locale} onLocaleChange={onLocaleChange} />
        </div>

        <button
          type="button"
          className="landing-arrow landing-arrow-prev"
          onClick={() => goToScene(activeIndex - 1)}
          aria-label={isEnglish ? 'Previous scene' : '上一张分镜'}
        >
          ←
        </button>
        <button
          type="button"
          className="landing-arrow landing-arrow-next"
          onClick={() => goToScene(activeIndex + 1)}
          aria-label={isEnglish ? 'Next scene' : '下一张分镜'}
        >
          →
        </button>

        <div className="landing-pad-window">
          <motion.div
            className="landing-pad-track"
            animate={{ x: `-${activeIndex * 100}%` }}
            drag={shouldReduceMotion ? false : 'x'}
            dragElastic={0.12}
            dragMomentum={false}
            onDragEnd={handlePadDragEnd}
            transition={{ type: 'spring', stiffness: 260, damping: 32 }}
          >
            {splashStoryScenes.map((scene, index) => (
              <article key={scene.id} className="landing-pad-slide" aria-hidden={index !== activeIndex}>
                <div className="landing-pad-art">
                  <img src={getSplashSceneImage(scene, locale)} alt={isEnglish ? scene.enTitle : scene.zhTitle} loading="eager" decoding="sync" />
                  <div className="landing-image-title landing-pad-title">
                    <span>{String(scene.scene).padStart(2, '0')} / {String(lastIndex + 1).padStart(2, '0')}</span>
                    <strong>{isEnglish ? scene.enTitle : scene.zhTitle}</strong>
                  </div>
                </div>
              </article>
            ))}
          </motion.div>
        </div>

        <div className="landing-pad-pagination">
          {splashStoryScenes.map((scene, index) => (
            <button
              key={`${scene.id}_pad_dot`}
              type="button"
              className={index === activeIndex ? 'active' : undefined}
              onClick={() => goToScene(index)}
              aria-label={isEnglish ? `Go to scene ${scene.scene}` : `跳转到第 ${scene.scene} 张分镜`}
            >
              <span />
            </button>
          ))}
        </div>
        <button type="button" className="landing-primary-action landing-pad-enter" onClick={onEnter}>
          {isEnglish ? 'Enter Chatbox' : '进入应用'}
        </button>
      </div>
    </section>
  );
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  imageDataUrl?: string;
  imageAlt?: string;
  nodes?: MessageNode[];
  ingredientsKey?: string;
  ingredients?: IngredientItem[];
  recipes?: RecipeRecommendation[];
  recipeDetails?: RecipeDetail[];
}

interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  childContext: string;
  ingredients: IngredientItem[];
  messages: ChatMessage[];
}

function stripRecipeDetailsFromMessage(message: ChatMessage): ChatMessage {
  const { recipeDetails: _recipeDetails, ...rest } = message;
  return rest;
}

function stripRecipeDetailsFromMessages(messages: ChatMessage[]) {
  return messages.map(stripRecipeDetailsFromMessage);
}

function stripRecipeDetailsFromSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: stripRecipeDetailsFromMessages(session.messages),
  };
}

function createWelcomeMessage(childContext = ''): ChatMessage {
  const locale = readLocale();
  return {
    id: `chat_welcome_${crypto.randomUUID()}`,
    role: 'assistant',
    text: childContext
      ? t(
          locale,
          '我是智能儿童菜谱助手，已记录本次对话的特殊饮食信息，告诉我今天有什么食材，也可以拍照上传。',
          'I am your AI cookbook buddy. I saved the special diet notes for this chat. Tell me today’s ingredients or upload a photo.',
        )
      : t(
          locale,
          '我是智能儿童菜谱助手，请通过文字、语音或拍照上传提供喜欢的食材',
          'I am your AI cookbook buddy. Share ingredients by typing, speaking, taking a photo, or uploading an image.',
        ),
    createdAt: new Date().toISOString(),
  };
}

function createChatSession(input?: Partial<ChatSession>): ChatSession {
  const now = new Date().toISOString();
  const childContext = input?.childContext ?? '';
  return {
    id: input?.id ?? `session_${crypto.randomUUID()}`,
    title: input?.title ?? '新对话',
    createdAt: input?.createdAt ?? now,
    updatedAt: input?.updatedAt ?? now,
    childContext,
    ingredients: input?.ingredients ?? [],
    messages: input?.messages?.length ? input.messages : [createWelcomeMessage(childContext)],
  };
}

function hasMeaningfulChatMessages(messages: ChatMessage[]) {
  return messages.some((message) =>
    message.role === 'user' ||
    Boolean(message.imageDataUrl) ||
    Boolean(message.ingredients?.length) ||
    Boolean(message.recipes?.length),
  );
}

function isPersistableChatSession(session: ChatSession) {
  return Boolean(
    session.ingredients.length > 0 ||
      hasMeaningfulChatMessages(session.messages),
  );
}

function readFavoriteRecipes() {
  if (typeof window === 'undefined') {
    return {} as FavoriteRecipesByProfile;
  }

  try {
    const raw = window.localStorage.getItem(favoriteRecipesStorageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as FavoriteRecipesByProfile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistFavoriteRecipes(recipes: FavoriteRecipesByProfile) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(favoriteRecipesStorageKey, JSON.stringify(recipes));
}

function readChatMessages() {
  if (typeof window === 'undefined') {
    return [] as ChatMessage[];
  }

  try {
    const raw = window.localStorage.getItem(chatMessagesStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(parsed) ? stripRecipeDetailsFromMessages(parsed) : [];
  } catch {
    return [];
  }
}

function persistChatMessages(messages: ChatMessage[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(chatMessagesStorageKey, JSON.stringify(stripRecipeDetailsFromMessages(messages).slice(-40)));
}

function readLikedRecipeIds() {
  if (typeof window === 'undefined') {
    return [] as string[];
  }

  try {
    const raw = window.localStorage.getItem(likedRecipesStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistLikedRecipeIds(ids: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(likedRecipesStorageKey, JSON.stringify(ids));
}

function readChildContext() {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(childContextStorageKey) ?? '';
}

function persistChildContext(context: string) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(childContextStorageKey, context);
}

function readChatSessions() {
  if (typeof window === 'undefined') {
    return [] as ChatSession[];
  }

  try {
    const raw = window.localStorage.getItem(chatSessionsStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatSession[];
    return Array.isArray(parsed)
      ? parsed.map(stripRecipeDetailsFromSession).filter(isPersistableChatSession)
      : [];
  } catch {
    return [];
  }
}

function persistChatSessions(sessions: ChatSession[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(
    chatSessionsStorageKey,
    JSON.stringify(sessions.map(stripRecipeDetailsFromSession).filter(isPersistableChatSession).slice(0, 30)),
  );
}

function readActiveChatSessionId() {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(activeChatSessionStorageKey) ?? '';
}

function persistActiveChatSessionId(sessionId: string) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(activeChatSessionStorageKey, sessionId);
}

function readTimedCache<T>(storageKey: string): TimedCache<T> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TimedCache<T>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readCachedValue<T>(storageKey: string, cacheKey: string) {
  const cache = readTimedCache<T>(storageKey);
  const entry = cache[cacheKey];
  if (!entry || Date.parse(entry.expiresAt) <= Date.now()) {
    return null;
  }

  return entry.data;
}

function writeCachedValue<T>(storageKey: string, cacheKey: string, data: T) {
  if (typeof window === 'undefined') {
    return;
  }

  const cache = readTimedCache<T>(storageKey);
  const now = Date.now();
  const nextEntries = Object.entries({
    ...cache,
    [cacheKey]: {
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + webCacheTtlMs).toISOString(),
      data,
    },
  })
    .filter(([, entry]) => Date.parse(entry.expiresAt) > now)
    .slice(-80);
  window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(nextEntries)));
}

function buildSessionTitle(messages: ChatMessage[], childContext: string) {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.text ?? childContext;
  const normalized = firstUserMessage.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 24) : '新对话';
}

function buildConversationProfile(childContext: string): ChildProfile {
  const ageMatch = childContext.match(/(\d{1,2})\s*岁/);
  const age = ageMatch ? Number(ageMatch[1]) : 8;
  const context = childContext.trim();

  return {
    id: conversationProfileId,
    nickname: '小学阶段学生',
    age: Number.isFinite(age) && age > 0 ? age : 8,
    tastePreferences: context ? [`对话记录：${context}`] : ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
    allergens: context.includes('无过敏') || context.includes('没有过敏') || !context ? [] : ['见对话记录'],
    dietaryHabits: context ? [`对话记录：${context}`] : ['低油脂', '轻口味', '膳食均衡', '维生素丰富', '搭配均衡'],
  };
}

function shouldAskAllergyFollowup(text: string) {
  const normalized = text.trim();
  if (!normalized) return false;

  const allergyRiskWords = ['严重过敏', '重度过敏', '急性过敏', '过敏性休克', '喉头水肿', '呼吸困难', '诱发过敏', '强过敏'];
  const riskIngredients = ['花生', '坚果', '腰果', '核桃', '虾', '蟹', '贝类', '海鲜', '牛奶', '乳制品', '鸡蛋'];
  const mentionsRiskIngredient = riskIngredients.some((word) => normalized.includes(word));
  const mentionsSevereAllergy = allergyRiskWords.some((word) => normalized.includes(word));
  const asksAllergy = normalized.includes('过敏') && !normalized.includes('无过敏') && !normalized.includes('没有过敏');

  return mentionsSevereAllergy || (mentionsRiskIngredient && asksAllergy);
}

const highRiskAllergenIngredientKeywords = [
  '花生',
  '坚果',
  '腰果',
  '核桃',
  '杏仁',
  '榛子',
  '开心果',
  '虾',
  '蟹',
  '贝类',
  '海鲜',
  '鱼',
  '牛奶',
  '乳制品',
  '芝士',
  '奶酪',
  '鸡蛋',
  '小麦',
  '麸质',
  '大豆',
  '黄豆',
  '芝麻',
];

const highRiskAllergyAlertKeywords = [
  '高危过敏原',
  '严重过敏',
  '重度过敏',
  '急性过敏',
  '过敏性休克',
  '喉头水肿',
  '呼吸困难',
  '危及生命',
];

function hasHighRiskAllergyAlert(alertText: string, recipeIngredients: IngredientItem[]) {
  const normalized = alertText.trim();
  if (highRiskAllergyAlertKeywords.some((word) => normalized.includes(word))) {
    return true;
  }

  if (!normalized.includes('过敏')) {
    return false;
  }

  return recipeIngredients.some((ingredient) =>
    highRiskAllergenIngredientKeywords.some((keyword) => ingredient.name.includes(keyword)),
  );
}

function mergeIngredientItems(current: IngredientItem[], nextItems: IngredientItem[]) {
  const merged = [...current];

  for (const item of nextItems) {
    const exists = merged.some((currentItem) => currentItem.name === item.name);
    if (!exists) {
      merged.push(item);
    }
  }

  return merged;
}

function buildIngredientsKey(items: IngredientItem[]) {
  return items
    .map((item) => item.normalizedName || item.name)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .join('|');
}

function buildRecommendationCacheKey(
  profile: ChildProfile,
  ingredientsKey: string,
  locale: AppLocale,
  pronunciationMode: boolean,
) {
  return JSON.stringify({
    profileId: profile.id,
    age: profile.age,
    tastePreferences: profile.tastePreferences,
    allergens: profile.allergens,
    dietaryHabits: profile.dietaryHabits,
    ingredientsKey,
    locale,
    pronunciationMode,
  });
}

function normalizeRecipeCacheText(value: string) {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function buildIngredientKnowledgeKey(name: string, locale: AppLocale) {
  return `${locale}:${normalizeRecipeCacheText(name)}`;
}

function buildRecipeVideoCacheKey(recipeName: string) {
  return normalizeRecipeCacheText(recipeName);
}

function buildRecipeStepCacheKey(
  recipe: RecipeRecommendation,
  ingredients: IngredientItem[],
  locale: AppLocale,
  pronunciationMode: boolean,
) {
  return JSON.stringify({
    recipeName: normalizeRecipeCacheText(recipe.name),
    ingredientsKey: buildIngredientsKey(ingredients),
    locale,
    pronunciationMode,
  });
}

function isValidCachedRecipeDetail(
  recipe: RecipeRecommendation,
  ingredients: IngredientItem[],
  detail: RecipeDetail | null,
): detail is RecipeDetail {
  if (!detail || !Array.isArray(detail.steps) || detail.steps.length === 0 || !Array.isArray(detail.ingredients)) {
    return false;
  }

  if (normalizeRecipeCacheText(detail.name) !== normalizeRecipeCacheText(recipe.name)) {
    return false;
  }

  const requestedIngredientNames = new Set(
    ingredients
      .map((ingredient) => normalizeRecipeCacheText(ingredient.normalizedName || ingredient.name))
      .filter(Boolean),
  );
  if (requestedIngredientNames.size === 0) {
    return true;
  }

  return detail.ingredients.every((ingredient) =>
    requestedIngredientNames.has(normalizeRecipeCacheText(ingredient.name)),
  );
}

function normalizeCachedRecipeDetail(recipe: RecipeRecommendation, detail: RecipeDetail): RecipeDetail {
  return {
    ...recipe,
    ...detail,
    id: recipe.id,
    name: recipe.name,
    namePinyin: recipe.namePinyin,
    englishName: recipe.englishName,
    nameLearning: recipe.nameLearning,
    ageRange: recipe.ageRange,
    difficulty: recipe.difficulty,
    estimatedTimeMinutes: recipe.estimatedTimeMinutes,
    fitReasons: recipe.fitReasons,
    riskAlerts: recipe.riskAlerts,
    nutritionSummary: recipe.nutritionSummary,
    extraIngredients: recipe.extraIngredients,
    canCookWithCurrentIngredients: recipe.canCookWithCurrentIngredients,
  };
}

function getRecommendationDataFromStreamEvent(event: StreamEvent) {
  if (event.type !== 'card' || event.cardType !== 'recipe-card') {
    return null;
  }

  const data = event.props.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  return data as RecommendationResponse;
}

function getRecipeDetailFromStreamEvent(event: StreamEvent) {
  if (event.type !== 'card' || event.cardType !== 'recipe-detail') {
    return null;
  }

  const data = event.props.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  return data as RecipeDetail;
}

function StreamNodeRenderer({ node }: { node: MessageNode }) {
  if (node.type === 'text' || node.type === 'markdown') {
    if (!node.content.trim()) {
      return null;
    }

    return <p>{node.content}</p>;
  }

  if (node.type === 'code') {
    return (
      <pre className="stream-code-node">
        <code>{node.content}</code>
      </pre>
    );
  }

  if (node.type === 'mermaid') {
    return <pre className="stream-mermaid-node">{node.content}</pre>;
  }

  if (node.type === 'card') {
    return null;
  }

  return null;
}

function StreamNodesRenderer({ nodes }: { nodes?: MessageNode[] }) {
  if (!nodes?.length) {
    return null;
  }

  return (
    <div className="stream-node-list">
      {nodes.map((node) => (
        <StreamNodeRenderer key={node.id} node={node} />
      ))}
    </div>
  );
}

function buildRecipeDetailsMap(details: RecipeDetail[]) {
  return details.reduce<Record<string, RecipeDetail>>((map, detail) => {
    map[detail.id] = detail;
    return map;
  }, {});
}

function formatRecipeDifficulty(difficulty: RecipeRecommendation['difficulty'], locale: AppLocale) {
  const labels: Record<AppLocale, Record<RecipeRecommendation['difficulty'], string>> = {
    zh: {
      easy: '简单',
      medium: '中等',
      hard: '较难',
    },
    en: {
      easy: 'Easy',
      medium: 'Medium',
      hard: 'Hard',
    },
  };

  return labels[locale][difficulty] ?? labels[locale].medium;
}

function PlayInlineIcon() {
  return <img className="inline-play-icon" src={audioPlayIcon} alt="" aria-hidden="true" />;
}

function TrashInlineIcon() {
  return (
    <svg className="inline-trash-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 3h6l1 2h4v2H4V5h4l1-2Z" />
      <path d="M6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z" />
    </svg>
  );
}

function getKnownIngredientVisual(name: string) {
  const visual = getIngredientVisual(name);
  return visual.name === defaultIngredientVisual.name ? null : visual;
}

function readImageAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择图片。'));
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const cameraImageInputRef = useRef<HTMLInputElement>(null);
  const fileImageInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const chatThreadEndRef = useRef<HTMLDivElement>(null);
  const skipNextChatAutoScrollRef = useRef(false);
  const recipeCarouselViewportRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const ingredientBounceTimeoutsRef = useRef<number[]>([]);
  const ingredientSwipeRef = useRef({
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    isHorizontal: false,
  });
  const chatboxSwipeRef = useRef({
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    isHorizontal: false,
  });

  const [selectedProfileId] = useState(conversationProfileId);
  const [ingredients, setIngredients] = useState<IngredientItem[]>([]);
  const [favoriteRecipesByProfile, setFavoriteRecipesByProfile] = useState<FavoriteRecipesByProfile>({});
  const [favoriteRecipes, setFavoriteRecipes] = useState<RecipeRecommendation[]>([]);
  const [likedRecipeIds, setLikedRecipeIds] = useState<string[]>([]);
  const [seasonalIngredientSuggestions, setSeasonalIngredientSuggestions] = useState<SeasonalIngredientSuggestion[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState('');
  const [isConversationDrawerOpen, setIsConversationDrawerOpen] = useState(false);
  const [isFavoriteDrawerOpen, setIsFavoriteDrawerOpen] = useState(false);
  const [isSplashVisible, setIsSplashVisible] = useState(() => !readSplashDismissed());
  const [pendingScrollRecipeId, setPendingScrollRecipeId] = useState('');
  const [pendingIngredientMessageId, setPendingIngredientMessageId] = useState('');
  const [childContext, setChildContext] = useState('');
  const [recipeDetailsById, setRecipeDetailsById] = useState<Record<string, RecipeDetail>>({});
  const [recipeDetailLoadingById, setRecipeDetailLoadingById] = useState<Record<string, boolean>>({});
  const [recipeDetailErrorsById, setRecipeDetailErrorsById] = useState<Record<string, string>>({});
  const [recipeDetailStreamNodesById, setRecipeDetailStreamNodesById] = useState<Record<string, MessageNode[]>>({});
  const [recipeDetailRequestedById, setRecipeDetailRequestedById] = useState<Record<string, boolean>>({});
  const [recipeVideoLoadingById, setRecipeVideoLoadingById] = useState<Record<string, boolean>>({});
  const [recipeVideoByRecipeId, setRecipeVideoByRecipeId] = useState<Record<string, RecipeCookingVideo | null>>({});
  const [recipeVideoErrorsById, setRecipeVideoErrorsById] = useState<Record<string, string>>({});
  const [ingredientKnowledgeByName, setIngredientKnowledgeByName] = useState<Record<string, IngredientKnowledge>>({});
  const [ingredientKnowledgeLoadingByName, setIngredientKnowledgeLoadingByName] = useState<Record<string, boolean>>({});
  const [ingredientKnowledgeErrorsByName, setIngredientKnowledgeErrorsByName] = useState<Record<string, string>>({});
  const [activeIngredientKnowledgeKey, setActiveIngredientKnowledgeKey] = useState('');
  const [learningRecipe, setLearningRecipe] = useState<RecipeRecommendation | null>(null);
  const [manualIngredient, setManualIngredient] = useState('');
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isParsingText, setIsParsingText] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isListeningVoice, setIsListeningVoice] = useState(false);
  const [isFetchingRecommendations, setIsFetchingRecommendations] = useState(false);
  const [activeSpeechKey, setActiveSpeechKey] = useState('');
  const [error, setError] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const [favoriteConfettiRecipeId, setFavoriteConfettiRecipeId] = useState('');
  const [recommendConfettiMessageId, setRecommendConfettiMessageId] = useState('');
  const [locale, setLocale] = useState<AppLocale>(() => readLocale());
  const [isPronunciationModeEnabled, setIsPronunciationModeEnabled] = useState(() => readPronunciationMode());
  const [activeCarouselRecipeByMessageId, setActiveCarouselRecipeByMessageId] = useState<Record<string, string>>({});
  const [recipeCarouselMetricsByMessageId, setRecipeCarouselMetricsByMessageId] = useState<Record<string, RecipeCarouselMetrics>>({});
  const [bouncingIngredientKeys, setBouncingIngredientKeys] = useState<string[]>([]);
  const isRecognizingIngredients = isParsingText || isUploadingImage;
  const isEnglish = locale === 'en';
  const shouldReduceMotion = useReducedMotion();

  const handleLocaleChange = (nextLocale: AppLocale) => {
    setLocale(nextLocale);
    persistLocale(nextLocale);
  };

  const handlePronunciationModeChange = (enabled: boolean) => {
    setIsPronunciationModeEnabled(enabled);
    persistPronunciationMode(enabled);
  };

  const speakText = (text: string, lang = 'zh-CN', speechKey = '') => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setError(t(locale, '当前设备浏览器不支持语音朗读功能。', 'This browser does not support voice playback.'));
      return;
    }

    const content = text.trim();
    if (!content) {
      return;
    }

    if (speechKey && activeSpeechKey === speechKey && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setActiveSpeechKey('');
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = lang;
    utterance.rate = 0.95;
    utterance.pitch = 1;
    if (speechKey) {
      setActiveSpeechKey(speechKey);
      utterance.onend = () => setActiveSpeechKey((current) => (current === speechKey ? '' : current));
      utterance.onerror = () => setActiveSpeechKey((current) => (current === speechKey ? '' : current));
    } else {
      setActiveSpeechKey('');
    }
    window.speechSynthesis.speak(utterance);
  };

  const conversationProfile = buildConversationProfile(childContext);
  const selectedProfile = conversationProfile;
  const lastChatMessageId = chatMessages.at(-1)?.id ?? '';

  const closeLearningDrawer = () => {
    stopSpeaking();
    setActiveSpeechKey('');
    setLearningRecipe(null);
  };

  const handleEnterApp = () => {
    persistSplashDismissed();
    setIsSplashVisible(false);
    window.setTimeout(() => chatInputRef.current?.focus(), 80);
  };

  const handleHorizontalTouchStart = (
    event: TouchEvent<HTMLElement>,
    swipeRef: typeof ingredientSwipeRef,
  ) => {
    const touch = event.touches[0];
    if (!touch) return;

    swipeRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      isHorizontal: false,
    };
  };

  const handleHorizontalTouchMove = (
    event: TouchEvent<HTMLElement>,
    swipeRef: typeof ingredientSwipeRef,
  ) => {
    const touch = event.touches[0];
    if (!touch) return;

    const deltaX = touch.clientX - swipeRef.current.startX;
    const deltaY = touch.clientY - swipeRef.current.startY;
    const isHorizontalSwipe = Math.abs(deltaX) > 8 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15;

    if (isHorizontalSwipe || swipeRef.current.isHorizontal) {
      swipeRef.current.isHorizontal = true;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.scrollLeft = swipeRef.current.scrollLeft - deltaX;
    }
  };

  const handleHorizontalTouchEnd = (swipeRef: typeof ingredientSwipeRef) => {
    swipeRef.current.isHorizontal = false;
  };

  const handleChatboxTouchStart = (event: TouchEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, button, .ingredient-card-row, .recipe-carousel')) {
      chatboxSwipeRef.current.isHorizontal = false;
      return;
    }

    handleHorizontalTouchStart(event, chatboxSwipeRef);
  };

  const handleChatboxTouchMove = (event: TouchEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, button, .ingredient-card-row, .recipe-carousel')) {
      return;
    }

    handleHorizontalTouchMove(event, chatboxSwipeRef);
  };

  const handleChatboxTouchEnd = () => handleHorizontalTouchEnd(chatboxSwipeRef);

  const handleIngredientTouchStart = (event: TouchEvent<HTMLDivElement>) =>
    handleHorizontalTouchStart(event, ingredientSwipeRef);
  const handleIngredientTouchMove = (event: TouchEvent<HTMLDivElement>) =>
    handleHorizontalTouchMove(event, ingredientSwipeRef);
  const handleIngredientTouchEnd = () => handleHorizontalTouchEnd(ingredientSwipeRef);

  const measureRecipeCarousel = (messageId: string) => {
    const viewportElement = recipeCarouselViewportRefs.current[messageId];
    if (!viewportElement) {
      return;
    }

    const firstCard = viewportElement.querySelector<HTMLElement>('[data-carousel-recipe-id]');
    const trackElement = viewportElement.querySelector<HTMLElement>('.recipe-carousel-track');
    if (!firstCard || !trackElement) {
      return;
    }

    const trackStyles = window.getComputedStyle(trackElement);
    const viewportStyles = window.getComputedStyle(viewportElement);
    const nextMetrics: RecipeCarouselMetrics = {
      viewportWidth: Math.round(viewportElement.getBoundingClientRect().width),
      cardWidth: Math.round(firstCard.getBoundingClientRect().width),
      gap: Math.round(Number.parseFloat(trackStyles.columnGap || trackStyles.gap || '0')) || 0,
      paddingLeft: Math.round(Number.parseFloat(viewportStyles.paddingLeft || '0')) || 0,
    };

    setRecipeCarouselMetricsByMessageId((current) => {
      const previousMetrics = current[messageId];
      if (
        previousMetrics &&
        previousMetrics.viewportWidth === nextMetrics.viewportWidth &&
        previousMetrics.cardWidth === nextMetrics.cardWidth &&
        previousMetrics.gap === nextMetrics.gap &&
        previousMetrics.paddingLeft === nextMetrics.paddingLeft
      ) {
        return current;
      }

      return { ...current, [messageId]: nextMetrics };
    });
  };

  const getRecipeCarouselTrackX = (messageId: string, activeRecipeIndex: number) => {
    const metrics = recipeCarouselMetricsByMessageId[messageId];
    if (!metrics) {
      return 0;
    }

    return (
      metrics.viewportWidth / 2 -
      metrics.paddingLeft -
      metrics.cardWidth / 2 -
      activeRecipeIndex * (metrics.cardWidth + metrics.gap)
    );
  };

  const handleRecipeCarouselDragEnd = (
    messageId: string,
    recipes: RecipeRecommendation[],
    activeRecipeIndex: number,
    info: PanInfo,
  ) => {
    if (recipes.length <= 1) {
      return;
    }

    const cardWidth = recipeCarouselMetricsByMessageId[messageId]?.cardWidth ?? 320;
    const swipeThreshold = Math.max(42, cardWidth * 0.14);
    const velocityThreshold = 420;
    let nextRecipeIndex = activeRecipeIndex;

    if (info.offset.x <= -swipeThreshold || info.velocity.x <= -velocityThreshold) {
      nextRecipeIndex += 1;
    } else if (info.offset.x >= swipeThreshold || info.velocity.x >= velocityThreshold) {
      nextRecipeIndex -= 1;
    }

    nextRecipeIndex = Math.min(Math.max(nextRecipeIndex, 0), recipes.length - 1);
    setActiveCarouselRecipeByMessageId((current) => ({
      ...current,
      [messageId]: recipes[nextRecipeIndex].id,
    }));
  };

  const getCarouselCardMotionState = (recipeIndex: number, activeRecipeIndex: number) => {
    const distance = Math.min(Math.abs(recipeIndex - activeRecipeIndex), 2);
    const direction = Math.sign(recipeIndex - activeRecipeIndex);

    return {
      x: direction * distance * -12,
      rotateY: direction * -36,
      rotateZ: direction * -1.4,
      scale: 1 - distance * 0.13,
      opacity: 1 - distance * 0.22,
      zIndex: 40 - distance * 10,
    };
  };

  useEffect(() => {
    const measureAllCarousels = () => {
      chatMessages.forEach((message) => {
        if (message.recipes?.length) {
          measureRecipeCarousel(message.id);
        }
      });
    };

    const frameId = window.requestAnimationFrame(measureAllCarousels);
    window.addEventListener('resize', measureAllCarousels);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', measureAllCarousels);
    };
  }, [chatMessages]);

  useEffect(() => {
    async function bootstrap() {
      try {
        setError('');
        window.localStorage.removeItem(legacyRecipeDetailCacheStorageKey);
        const localFavoriteRecipes = readFavoriteRecipes();
        const localChatMessages = readChatMessages();
        const localLikedRecipeIds = readLikedRecipeIds();
        const localChildContext = readChildContext();
        const localChatSessions = readChatSessions();
        const localActiveChatSessionId = readActiveChatSessionId();
        setFavoriteRecipesByProfile(localFavoriteRecipes);
        setFavoriteRecipes(localFavoriteRecipes[conversationProfileId] ?? []);
        const storedSessions = localChatSessions.filter(isPersistableChatSession);
        const legacySession = localChatMessages.length > 0
          ? createChatSession({
              childContext: localChildContext,
              messages: localChatMessages,
              title: buildSessionTitle(localChatMessages, localChildContext),
            })
          : null;
        const initialSessions = storedSessions.length > 0
          ? storedSessions
          : legacySession && isPersistableChatSession(legacySession)
            ? [legacySession]
            : [];
        const activeSession =
          initialSessions.find((session) => session.id === localActiveChatSessionId) ??
          initialSessions[0] ??
          createChatSession({ childContext: localChildContext });
        setChatSessions(initialSessions);
        setActiveChatSessionId(activeSession.id);
        setChildContext(activeSession.childContext);
        setIngredients(activeSession.ingredients);
        setChatMessages(activeSession.messages);
        setRecipeDetailsById(buildRecipeDetailsMap(activeSession.messages.flatMap((message) => message.recipeDetails ?? [])));
        setLikedRecipeIds(localLikedRecipeIds);
      } catch (bootstrapError) {
        setError(bootstrapError instanceof Error ? bootstrapError.message : t(locale, '初始化失败，请稍后重试。', 'Initialization failed. Please try again later.'));
      } finally {
        setIsBootstrapping(false);
      }
    }

    void bootstrap();
  }, []);

  useEffect(() => {
    let isCancelled = false;

    async function loadSeasonalIngredientSuggestions() {
      try {
        const data = await fetchSeasonalIngredientSuggestions(
          new Date().getMonth() + 1,
          childContext.trim() || (isEnglish ? defaultChildContextEn : defaultChildContext),
        );
        if (!isCancelled) {
          setSeasonalIngredientSuggestions(data.suggestions.filter((item) => item.name).slice(0, 3));
        }
      } catch {
        if (!isCancelled) {
          setSeasonalIngredientSuggestions([]);
        }
      }
    }

    void loadSeasonalIngredientSuggestions();

    return () => {
      isCancelled = true;
    };
  }, [childContext, isEnglish]);

  useEffect(() => {
    setFavoriteRecipes(favoriteRecipesByProfile[selectedProfileId || conversationProfileId] ?? []);
  }, [favoriteRecipesByProfile, selectedProfileId]);

  useEffect(() => {
    if (chatMessages.length > 0) {
      persistChatMessages(chatMessages);
    }
  }, [chatMessages]);

  useEffect(() => {
    if (isBootstrapping) {
      return;
    }

    if (skipNextChatAutoScrollRef.current) {
      skipNextChatAutoScrollRef.current = false;
      return;
    }

    const timeoutId = window.setTimeout(() => {
      chatThreadEndRef.current?.scrollIntoView({
        block: 'end',
        behavior: 'smooth',
      });
    }, 80);

    return () => window.clearTimeout(timeoutId);
  }, [isBootstrapping, lastChatMessageId]);

  useEffect(() => {
    if (!pendingIngredientMessageId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-chat-message-id="${pendingIngredientMessageId}"]`,
      );
      target?.scrollIntoView({
        block: 'start',
        inline: 'nearest',
        behavior: 'smooth',
      });
      setPendingIngredientMessageId('');
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [pendingIngredientMessageId, lastChatMessageId]);

  useEffect(() => {
    if (isBootstrapping || !activeChatSessionId) {
      return;
    }

    setChatSessions((current) => {
      const updatedAt = new Date().toISOString();
      const nextSession = stripRecipeDetailsFromSession(createChatSession({
        id: activeChatSessionId,
        childContext,
        ingredients,
        messages: chatMessages,
        title: buildSessionTitle(chatMessages, childContext),
        createdAt: current.find((session) => session.id === activeChatSessionId)?.createdAt,
        updatedAt,
      }));
      if (!isPersistableChatSession(nextSession)) {
        const next = current.filter((session) => session.id !== activeChatSessionId);
        persistChatSessions(next);
        persistActiveChatSessionId(activeChatSessionId);
        return next;
      }
      const next = [
        nextSession,
        ...current.filter((session) => session.id !== activeChatSessionId),
      ].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      persistChatSessions(next);
      persistActiveChatSessionId(activeChatSessionId);
      return next;
    });
  }, [activeChatSessionId, chatMessages, childContext, ingredients, isBootstrapping]);

  useEffect(() => {
    persistLikedRecipeIds(likedRecipeIds);
  }, [likedRecipeIds]);

  useEffect(() => {
    persistChildContext(childContext);
  }, [childContext]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => setToastMessage(''), 3600);
    return () => window.clearTimeout(timeoutId);
  }, [toastMessage]);

  useEffect(() => {
    if (!favoriteConfettiRecipeId) {
      return;
    }

    const timeoutId = window.setTimeout(() => setFavoriteConfettiRecipeId(''), 620);
    return () => window.clearTimeout(timeoutId);
  }, [favoriteConfettiRecipeId]);

  useEffect(() => {
    if (!recommendConfettiMessageId) {
      return;
    }

    const timeoutId = window.setTimeout(() => setRecommendConfettiMessageId(''), 620);
    return () => window.clearTimeout(timeoutId);
  }, [recommendConfettiMessageId]);

  useEffect(() => {
    return () => {
      ingredientBounceTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      ingredientBounceTimeoutsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!pendingScrollRecipeId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(`[data-recipe-card-id="${pendingScrollRecipeId}"]`);
      target?.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'smooth',
      });
      target?.classList.add('recipe-card-highlight');
      window.setTimeout(() => target?.classList.remove('recipe-card-highlight'), 1400);
      setPendingScrollRecipeId('');
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [pendingScrollRecipeId, chatMessages]);

  const addChatMessage = (message: Omit<ChatMessage, 'id' | 'createdAt'>) => {
    const nextMessage: ChatMessage = {
      ...message,
      id: `chat_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    setChatMessages((current) => [...current, nextMessage].slice(-40));
    return nextMessage;
  };

  const triggerIngredientEmojiBounce = (messageId: string, ingredientIds: string[]) => {
    if (shouldReduceMotion || ingredientIds.length === 0) {
      return;
    }

    const nextKeys = ingredientIds.map((ingredientId) => `${messageId}_${ingredientId}`);
    setBouncingIngredientKeys((current) => [...new Set([...current, ...nextKeys])]);

    const timeoutId = window.setTimeout(() => {
      setBouncingIngredientKeys((current) => current.filter((key) => !nextKeys.includes(key)));
      ingredientBounceTimeoutsRef.current = ingredientBounceTimeoutsRef.current.filter((item) => item !== timeoutId);
    }, 5000);
    ingredientBounceTimeoutsRef.current.push(timeoutId);
  };

  const patchChatMessageNodes = (messageId: string, event: StreamEvent) => {
    setChatMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, nodes: applyStreamEvent(message.nodes ?? [], event) }
          : message,
      ),
    );
  };

  const patchRecipeDetailStreamNodes = (recipeId: string, event: StreamEvent) => {
    setRecipeDetailStreamNodesById((current) => ({
      ...current,
      [recipeId]: applyStreamEvent(current[recipeId] ?? [], event),
    }));
  };

  const handleNewConversation = () => {
    const session = createChatSession();
    setActiveChatSessionId(session.id);
    setChildContext('');
    setIngredients([]);
    setRecipeDetailsById({});
    setRecipeDetailLoadingById({});
    setRecipeDetailErrorsById({});
    setChatMessages(session.messages);
    setChatSessions((current) => {
      const next = current.filter((item) => item.id !== session.id);
      persistChatSessions(next);
      persistActiveChatSessionId(session.id);
      return next;
    });
    setIsConversationDrawerOpen(false);
  };

  const handleSelectConversation = (session: ChatSession) => {
    setActiveChatSessionId(session.id);
    setChildContext(session.childContext);
    setIngredients(session.ingredients);
    setChatMessages(session.messages);
    setRecipeDetailsById(buildRecipeDetailsMap(session.messages.flatMap((message) => message.recipeDetails ?? [])));
    setRecipeDetailLoadingById({});
    setRecipeDetailErrorsById({});
    persistActiveChatSessionId(session.id);
    setIsConversationDrawerOpen(false);
  };

  const handleDeleteConversation = (sessionId: string) => {
    setChatSessions((current) => {
      const remaining = current.filter((session) => session.id !== sessionId);
      persistChatSessions(remaining);

      if (sessionId === activeChatSessionId) {
        const nextActiveSession = remaining[0] ?? createChatSession();
        setActiveChatSessionId(nextActiveSession.id);
        setChildContext(nextActiveSession.childContext);
        setIngredients(nextActiveSession.ingredients);
        setChatMessages(nextActiveSession.messages);
        setRecipeDetailsById(buildRecipeDetailsMap(nextActiveSession.messages.flatMap((message) => message.recipeDetails ?? [])));
        setRecipeDetailLoadingById({});
        setRecipeDetailErrorsById({});
        persistActiveChatSessionId(nextActiveSession.id);
      }

      return remaining;
    });
  };

  const handleOpenFavoriteRecipe = (recipe: RecipeRecommendation) => {
    const matchedSession =
      chatSessions.find((session) =>
        session.messages.some((message) => message.recipes?.some((item) => item.id === recipe.id)),
      ) ?? null;

    if (matchedSession) {
      handleSelectConversation(matchedSession);
    }

    setIsFavoriteDrawerOpen(false);
    setPendingScrollRecipeId(recipe.id);
  };

  const mergeRecipeDetailIntoCurrentSession = (messageId: string, detail: RecipeDetail) => {
    setChatMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId) {
          return message;
        }

        const nextDetails = [
          ...(message.recipeDetails ?? []).filter((item) => item.id !== detail.id),
          detail,
        ];

        return {
          ...message,
          recipeDetails: nextDetails,
        };
      }),
    );
  };

  const loadRecipeDetailForCard = async (
    recipe: RecipeRecommendation,
    nextIngredients: IngredientItem[],
    profile: ChildProfile,
    messageId: string,
    showToast = false,
  ) => {
    setRecipeDetailRequestedById((current) => ({ ...current, [recipe.id]: true }));
    void loadRecipeVideoForCard(recipe, { force: true });

    const stepCacheKey = buildRecipeStepCacheKey(
      recipe,
      nextIngredients,
      locale,
      isPronunciationModeEnabled,
    );
    const cachedDetail = readCachedValue<RecipeDetail>(recipeStepCacheStorageKey, stepCacheKey);
    if (isValidCachedRecipeDetail(recipe, nextIngredients, cachedDetail)) {
      const normalizedCachedDetail = normalizeCachedRecipeDetail(recipe, cachedDetail);
      setRecipeDetailsById((current) => ({ ...current, [recipe.id]: normalizedCachedDetail }));
      mergeRecipeDetailIntoCurrentSession(messageId, normalizedCachedDetail);
      setRecipeDetailErrorsById((current) => {
        const next = { ...current };
        delete next[recipe.id];
        return next;
      });
      setRecipeDetailLoadingById((current) => ({ ...current, [recipe.id]: false }));
      return;
    }

    setRecipeDetailLoadingById((current) => ({ ...current, [recipe.id]: true }));
    setRecipeDetailErrorsById((current) => {
      const next = { ...current };
      delete next[recipe.id];
      return next;
    });

    try {
      setRecipeDetailStreamNodesById((current) => ({ ...current, [recipe.id]: [] }));
      let streamedDetail: RecipeDetail | null = null;
      let streamErrorMessage = '';
      await streamGeneratedRecipeDetail({
        profileId: profile.id,
        profile,
        ingredients: nextIngredients,
        recipe,
        locale,
        pinyinMode: isPronunciationModeEnabled,
      }, (event) => {
        const localizedEvent = event.type === 'error'
          ? { ...event, message: localizeErrorMessage(event.message, locale) }
          : event;
        patchRecipeDetailStreamNodes(recipe.id, localizedEvent);
        const detailFromEvent = getRecipeDetailFromStreamEvent(localizedEvent);
        if (detailFromEvent) {
          streamedDetail = detailFromEvent;
        }
        if (localizedEvent.type === 'error') {
          streamErrorMessage = localizedEvent.message;
        }
      });
      if (!streamedDetail && streamErrorMessage) {
        throw new Error(streamErrorMessage);
      }
      if (!streamedDetail) {
        throw new Error(streamErrorMessage || t(locale, '菜谱步骤流式响应未返回有效卡片。', 'The cooking steps stream did not return a valid card.'));
      }
      const detail = normalizeCachedRecipeDetail(recipe, streamedDetail as RecipeDetail);
      setRecipeDetailsById((current) => ({ ...current, [recipe.id]: detail }));
      mergeRecipeDetailIntoCurrentSession(messageId, detail);
      writeCachedValue(recipeStepCacheStorageKey, stepCacheKey, detail);
    } catch (detailError) {
      const message = localizeErrorMessage(
        detailError instanceof Error ? detailError.message : t(locale, '菜谱步骤获取失败。', 'Failed to get cooking steps.'),
        locale,
      );
      setRecipeDetailErrorsById((current) => ({ ...current, [recipe.id]: message }));
      if (showToast) {
        setToastMessage(
          message === '接口数据响应超时' || message === 'Request timed out.'
            ? t(locale, '接口数据响应超时', 'Request timed out')
            : t(locale, `${recipe.name} 步骤获取失败，请稍后重试。`, `Failed to get steps for ${recipe.name}. Please try again later.`),
        );
      }
    } finally {
      setRecipeDetailLoadingById((current) => ({ ...current, [recipe.id]: false }));
    }
  };

  useEffect(() => {
    const cachedDetails: Record<string, RecipeDetail> = {};

    for (const message of chatMessages) {
      if (!message.recipes?.length) {
        continue;
      }

      const messageIngredients = message.ingredients?.length ? message.ingredients : ingredients;
      for (const recipe of message.recipes) {
        if (recipeDetailsById[recipe.id] || recipeDetailLoadingById[recipe.id]) {
          continue;
        }

        const stepCacheKey = buildRecipeStepCacheKey(
          recipe,
          messageIngredients,
          locale,
          isPronunciationModeEnabled,
        );
        const cachedDetail = readCachedValue<RecipeDetail>(recipeStepCacheStorageKey, stepCacheKey);
        if (isValidCachedRecipeDetail(recipe, messageIngredients, cachedDetail)) {
          cachedDetails[recipe.id] = normalizeCachedRecipeDetail(recipe, cachedDetail);
        }
      }
    }

    const cachedRecipeIds = Object.keys(cachedDetails);
    if (cachedRecipeIds.length === 0) {
      return;
    }

    setRecipeDetailsById((current) => ({ ...current, ...cachedDetails }));
    setRecipeDetailErrorsById((current) => {
      const next = { ...current };
      for (const recipeId of cachedRecipeIds) {
        delete next[recipeId];
      }
      return next;
    });
  }, [
    chatMessages,
    ingredients,
    isPronunciationModeEnabled,
    locale,
    recipeDetailLoadingById,
    recipeDetailsById,
  ]);

  const loadRecipeVideoForCard = async (recipe: RecipeRecommendation, options: { force?: boolean } = {}) => {
    const cacheKey = buildRecipeVideoCacheKey(recipe.name);
    const forceRefresh = options.force === true;
    if (
      !cacheKey ||
      recipeVideoLoadingById[recipe.id] ||
      (!forceRefresh && Object.prototype.hasOwnProperty.call(recipeVideoByRecipeId, recipe.id))
    ) {
      return;
    }

    const cachedVideo = readCachedValue<RecipeVideoCacheValue>(recipeVideoMatchCacheStorageKey, cacheKey);
    if (!forceRefresh && cachedVideo) {
      setRecipeVideoByRecipeId((current) => ({ ...current, [recipe.id]: cachedVideo.video }));
      return;
    }

    setRecipeVideoLoadingById((current) => ({ ...current, [recipe.id]: true }));
    setRecipeVideoErrorsById((current) => {
      const next = { ...current };
      delete next[recipe.id];
      return next;
    });
    try {
      const result = await matchRecipeVideo(recipe.name);
      setRecipeVideoByRecipeId((current) => ({ ...current, [recipe.id]: result.video }));
      writeCachedValue(recipeVideoMatchCacheStorageKey, cacheKey, { video: result.video });
    } catch (videoError) {
      setRecipeVideoErrorsById((current) => ({
        ...current,
        [recipe.id]: videoError instanceof Error ? videoError.message : t(locale, '烹饪视频匹配失败。', 'Failed to match cooking video.'),
      }));
    } finally {
      setRecipeVideoLoadingById((current) => ({ ...current, [recipe.id]: false }));
    }
  };

  useEffect(() => {
    for (const message of chatMessages) {
      for (const recipe of message.recipes ?? []) {
        void loadRecipeVideoForCard(recipe);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages]);

  const handleIngredientKnowledgeClick = async (ingredient: IngredientItem) => {
    const knowledgeKey = buildIngredientKnowledgeKey(ingredient.normalizedName || ingredient.name, locale);
    if (!knowledgeKey) {
      return;
    }

    setActiveIngredientKnowledgeKey(knowledgeKey);
    if (ingredientKnowledgeByName[knowledgeKey] || ingredientKnowledgeLoadingByName[knowledgeKey]) {
      return;
    }

    const cachedKnowledge = readCachedValue<IngredientKnowledge>(ingredientKnowledgeCacheStorageKey, knowledgeKey);
    if (cachedKnowledge) {
      setIngredientKnowledgeByName((current) => ({ ...current, [knowledgeKey]: cachedKnowledge }));
      return;
    }

    setIngredientKnowledgeLoadingByName((current) => ({ ...current, [knowledgeKey]: true }));
    setIngredientKnowledgeErrorsByName((current) => {
      const next = { ...current };
      delete next[knowledgeKey];
      return next;
    });

    try {
      const knowledge = await fetchIngredientKnowledge(ingredient.normalizedName || ingredient.name, {
        locale,
        pinyinMode: isPronunciationModeEnabled,
      });
      setIngredientKnowledgeByName((current) => ({ ...current, [knowledgeKey]: knowledge }));
      writeCachedValue(ingredientKnowledgeCacheStorageKey, knowledgeKey, knowledge);
    } catch (knowledgeError) {
      const message = localizeErrorMessage(
        knowledgeError instanceof Error ? knowledgeError.message : t(locale, '食材知识获取失败。', 'Failed to get ingredient notes.'),
        locale,
      );
      setIngredientKnowledgeErrorsByName((current) => ({ ...current, [knowledgeKey]: message }));
      setToastMessage(t(locale, `${ingredient.name} 知识卡片获取失败，请稍后重试。`, `Failed to get notes for ${getIngredientDisplayName(ingredient.name, locale)}. Please try again later.`));
    } finally {
      setIngredientKnowledgeLoadingByName((current) => ({ ...current, [knowledgeKey]: false }));
    }
  };

  const requestChatRecommendations = async (
    prompt: string,
    nextIngredients: IngredientItem[],
    sourceIngredientMessageId = '',
    forceRefresh = false,
  ) => {
    if (nextIngredients.length === 0) {
      addChatMessage({
        role: 'assistant',
        text: t(
          locale,
          '我还没有识别到可用食材。你可以输入“鸡蛋、番茄、黄瓜”，或直接拍一张食材照片。',
          'I have not found any usable ingredients yet. Try typing “egg, tomato, cucumber” or take a photo of your ingredients.',
        ),
      });
      return;
    }

    const ingredientsKey = buildIngredientsKey(nextIngredients);
    const ingredientMessageId =
      sourceIngredientMessageId ||
      [...chatMessages]
        .reverse()
        .find((message) => message.ingredients?.length && buildIngredientsKey(message.ingredients) === ingredientsKey)?.id ||
      '';
    setIsFetchingRecommendations(true);
    setError('');

    const streamingRecipeMessageId = `chat_${crypto.randomUUID()}`;
    let hasCreatedStreamingRecipeMessage = false;
    const ensureStreamingRecipeMessage = () => {
      if (hasCreatedStreamingRecipeMessage) {
        return;
      }

      hasCreatedStreamingRecipeMessage = true;
      const streamingRecipeMessage: ChatMessage = {
        id: streamingRecipeMessageId,
        createdAt: new Date().toISOString(),
        role: 'assistant',
        text: t(locale, '正在生成菜谱推荐...', 'Generating recipe ideas...'),
        nodes: [],
        ingredientsKey,
        ingredients: nextIngredients,
      };
      setChatMessages((current) => [...current, streamingRecipeMessage].slice(-40));
    };

    try {
      const recommendationPrompt = [
        isEnglish
          ? `Child context: ${childContext.trim() || defaultChildContextEn}`
          : `儿童情况：${childContext.trim() || defaultChildContext}`,
        isEnglish ? `User input: ${prompt}` : `用户本轮输入：${prompt}`,
        `输出语言：${isEnglish ? 'English' : '简体中文'}`,
        isPronunciationModeEnabled
          ? `读音辅助：开启，${isEnglish ? '菜谱名称读音字段输出英文单词音节组合' : '菜谱名称读音字段输出带声调拼音'}`
          : '读音辅助：关闭，不输出菜谱名称拼音或音节辅助内容',
      ].join('\n');
      const recommendationCacheKey = buildRecommendationCacheKey(
        selectedProfile,
        ingredientsKey,
        locale,
        isPronunciationModeEnabled,
      );
      const cachedRecommendation = forceRefresh
        ? null
        : readCachedValue<RecommendationResponse>(
            recommendationCacheStorageKey,
            recommendationCacheKey,
          );
      const obsoleteRecipeIds = chatMessages
        .filter((message) => {
          if (!message.recipes?.length) {
            return false;
          }

          if (message.ingredientsKey) {
            return message.ingredientsKey === ingredientsKey;
          }

          return nextIngredients.every((item) => message.text.includes(item.name));
        })
        .flatMap((message) => message.recipes?.map((recipe) => recipe.id) ?? []);
      if (obsoleteRecipeIds.length > 0) {
        const obsoleteRecipeIdSet = new Set(obsoleteRecipeIds);
        setRecipeDetailsById((current) =>
          Object.fromEntries(Object.entries(current).filter(([recipeId]) => !obsoleteRecipeIdSet.has(recipeId))),
        );
        setRecipeDetailLoadingById((current) =>
          Object.fromEntries(Object.entries(current).filter(([recipeId]) => !obsoleteRecipeIdSet.has(recipeId))),
        );
        setRecipeDetailErrorsById((current) =>
          Object.fromEntries(Object.entries(current).filter(([recipeId]) => !obsoleteRecipeIdSet.has(recipeId))),
        );
        setRecipeDetailStreamNodesById((current) =>
          Object.fromEntries(Object.entries(current).filter(([recipeId]) => !obsoleteRecipeIdSet.has(recipeId))),
        );
        setRecipeDetailRequestedById((current) =>
          Object.fromEntries(Object.entries(current).filter(([recipeId]) => !obsoleteRecipeIdSet.has(recipeId))),
        );
      }
      setChatMessages((current) =>
        current.filter((message) => {
          if (message.ingredientsKey === ingredientsKey && !message.recipes?.length) {
            return false;
          }

          if (!message.recipes?.length) {
            return true;
          }

          if (message.ingredientsKey) {
            return message.ingredientsKey !== ingredientsKey;
          }

          return !nextIngredients.every((item) => message.text.includes(item.name));
        }),
      );
      skipNextChatAutoScrollRef.current = true;
      let data = cachedRecommendation;
      let streamErrorMessage = '';
      if (cachedRecommendation) {
        ensureStreamingRecipeMessage();
      }
      if (!data) {
        await streamRecommendations(
          selectedProfile,
          nextIngredients,
          recommendationPrompt,
          {
            locale,
            pinyinMode: isPronunciationModeEnabled,
          },
          (event) => {
            if (event.type === 'text-delta' || event.type === 'markdown-delta' || event.type === 'card') {
              ensureStreamingRecipeMessage();
              patchChatMessageNodes(streamingRecipeMessageId, event);
            }
            const streamData = getRecommendationDataFromStreamEvent(event);
            if (streamData) {
              data = streamData;
            }
            if (event.type === 'error') {
              streamErrorMessage = event.message;
            }
          },
        );
      }
      if (!data && streamErrorMessage) {
        throw new Error(streamErrorMessage);
      }
      if (!data) {
        throw new Error(streamErrorMessage || t(locale, '菜谱推荐流式响应未返回有效卡片。', 'The recipe stream did not return a valid card.'));
      }
      if (!cachedRecommendation) {
        writeCachedValue(recommendationCacheStorageKey, recommendationCacheKey, data);
      }
      const recipes = data.recipes;
      const recipeDetails = data.recipeDetails ?? [];
      setRecipeDetailsById((current) => ({ ...current, ...buildRecipeDetailsMap(recipeDetails) }));
      setRecipeDetailLoadingById({});
      setRecipeDetailErrorsById({});
      setChatMessages((current) =>
        current.map((message) =>
          message.id === streamingRecipeMessageId
            ? {
                ...message,
                text: t(
                  locale,
                  `根据${nextIngredients.map((item) => item.name).join('、')}，按小学阶段健康饮食原则推荐了 ${recipes.length} 道菜。`,
                  `Based on ${nextIngredients.map((item) => getIngredientDisplayName(item.name, locale)).join(', ')}, I found ${recipes.length} kid-friendly recipe ${recipes.length === 1 ? 'idea' : 'ideas'}.`,
                ),
                recipes,
                recipeDetails,
              }
            : message,
        ),
      );
      setPendingIngredientMessageId(ingredientMessageId || streamingRecipeMessageId);
      setManualIngredient('');
    } catch (recommendationError) {
      setChatMessages((current) => current.filter((message) => message.id !== streamingRecipeMessageId));
      const message = localizeErrorMessage(
        recommendationError instanceof Error ? recommendationError.message : t(locale, '推荐失败，请稍后重试。', 'Recipe recommendation failed. Please try again later.'),
        locale,
      );
      setError(message);
      addChatMessage({
        role: 'assistant',
        text: message,
      });
    } finally {
      setIsFetchingRecommendations(false);
    }
  };

  const handleSeasonalIngredientClick = (suggestion: SeasonalIngredientSuggestion) => {
    if (isRecognizingIngredients) {
      return;
    }

    const selectedIngredient: IngredientItem = {
      id: `ingredient_${crypto.randomUUID()}`,
      name: suggestion.name,
      normalizedName: suggestion.name,
      quantity: t(locale, '适量', 'as needed'),
      source: 'manual',
      confidence: 1,
    };
    const nextIngredients = [selectedIngredient];

    setError('');
    setIngredients(nextIngredients);
    setManualIngredient('');
    if (chatInputRef.current) {
      chatInputRef.current.value = '';
    }

    addChatMessage({
      role: 'user',
      text: getIngredientDisplayName(suggestion.name, locale),
    });
    const ingredientMessage = addChatMessage({
      role: 'assistant',
      text: t(
        locale,
        `已选择时令食材：${suggestion.name}。你可以继续补充食材，也可以直接搜索菜谱。`,
        `Selected seasonal ingredient: ${getIngredientDisplayName(suggestion.name, locale)}. You can add more ingredients or get recipe ideas now.`,
      ),
      ingredients: nextIngredients,
    });
    triggerIngredientEmojiBounce(ingredientMessage.id, nextIngredients.map((ingredient) => ingredient.id));
  };

  const handleChatSubmit = async (text?: string) => {
    const rawText = typeof text === 'string' ? text : chatInputRef.current?.value || manualIngredient;
    const prompt = rawText.trim();
    if (!prompt || isRecognizingIngredients) return;

    try {
      setIsParsingText(true);
      setError('');
      setManualIngredient(prompt);
      addChatMessage({ role: 'user', text: prompt });

      if (shouldAskAllergyFollowup(prompt)) {
        setChildContext(prompt);
        addChatMessage({
          role: 'assistant',
          text: t(
            locale,
            '你提到了可能引发严重急性过敏的情况。我已记录这条特殊饮食信息。为了更安全，请补充孩子是否已确诊相关食材过敏、严重程度，以及是否需要完全避开这类食材。',
            'You mentioned a possible severe allergy risk. I saved this special diet note. For safety, please add whether the child has a confirmed allergy, how severe it is, and whether the ingredient must be fully avoided.',
          ),
        });
        setManualIngredient('');
        return;
      }

      const parsed = await parseIngredientText(prompt);
      const previousIngredientNames = new Set(ingredients.map((ingredient) => ingredient.name));
      const nextIngredients = mergeIngredientItems(ingredients, parsed.ingredients);
      if (nextIngredients.length > 10) {
        setError(t(locale, '一次最多支持 10 个食材，请减少食材后再继续添加。', 'Up to 10 ingredients are supported at once. Please remove some before adding more.'));
        addChatMessage({
          role: 'assistant',
          text: t(
            locale,
            '一次最多支持 10 个食材。当前识别后会超过上限，请减少食材或换一组食材。',
            'Up to 10 ingredients are supported at once. This result would exceed the limit, so please remove some ingredients or try another set.',
          ),
        });
        return;
      }
      setIngredients(nextIngredients);
      setManualIngredient('');
      if (chatInputRef.current) {
        chatInputRef.current.value = '';
      }
      const ingredientMessage = addChatMessage({
        role: 'assistant',
        text: parsed.ingredients.length > 0
          ? t(locale, '我识别到了这些食材。你可以继续补充食材，也可以直接搜索菜谱。', 'I found these ingredients. You can add more or get recipe ideas now.')
          : t(locale, '我暂时没有识别到明确食材，可以换一种说法再试。', 'I could not find a clear ingredient yet. Try saying it another way.'),
        ingredients: nextIngredients,
      });
      triggerIngredientEmojiBounce(
        ingredientMessage.id,
        nextIngredients
          .filter((ingredient) => !previousIngredientNames.has(ingredient.name))
          .map((ingredient) => ingredient.id),
      );
    } catch (chatError) {
      const message = localizeErrorMessage(
        chatError instanceof Error ? chatError.message : t(locale, '食材识别失败。', 'Ingredient recognition failed.'),
        locale,
      );
      setError(message);
      addChatMessage({
        role: 'assistant',
        text: message,
      });
    } finally {
      setIsParsingText(false);
    }
  };

  const handleImageFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsUploadingImage(true);
      setError('');
      const imageDataUrl = await readImageAsDataUrl(file);
      addChatMessage({
        role: 'user',
        text: t(locale, '我上传了一张食材图片', 'I uploaded an ingredient photo.'),
        imageDataUrl,
        imageAlt: file.name
          ? t(locale, `用户上传的食材图片：${file.name}`, `Ingredient photo uploaded by user: ${file.name}`)
          : t(locale, '用户上传的食材图片', 'Ingredient photo uploaded by user'),
      });

      const data = await uploadIngredientImage(file);
      const previousIngredientNames = new Set(ingredients.map((ingredient) => ingredient.name));
      const nextIngredients = mergeIngredientItems(ingredients, data.ingredients);
      if (nextIngredients.length > 10) {
        setError(t(locale, '一次最多支持 10 个食材，请减少食材后再继续添加。', 'Up to 10 ingredients are supported at once. Please remove some before adding more.'));
        addChatMessage({
          role: 'assistant',
          text: t(locale, '图片识别出的食材加入后会超过 10 个上限，请减少食材后再继续。', 'The photo result would exceed the 10 ingredient limit. Please remove some ingredients first.'),
        });
        return;
      }
      setIngredients(nextIngredients);
      const ingredientMessage = addChatMessage({
        role: 'assistant',
        text: data.ingredients.length > 0
          ? t(locale, '我从图片里识别到了这些食材。', 'I found these ingredients in the photo.')
          : t(locale, '我暂时没有从图片里识别到明确食材。', 'I could not find clear ingredients in the photo yet.'),
        ingredients: nextIngredients,
      });
      triggerIngredientEmojiBounce(
        ingredientMessage.id,
        nextIngredients
          .filter((ingredient) => !previousIngredientNames.has(ingredient.name))
          .map((ingredient) => ingredient.id),
      );
    } catch (uploadError) {
      setError(localizeErrorMessage(
        uploadError instanceof Error ? uploadError.message : t(locale, '图片上传失败。', 'Image upload failed.'),
        locale,
      ));
    } finally {
      setIsUploadingImage(false);
      event.target.value = '';
    }
  };

  const handleStartVoiceInput = async () => {
    if (typeof window === 'undefined') {
      setError(t(locale, '当前环境不支持语音输入。', 'Voice input is not supported in this environment.'));
      return;
    }

    if (!window.isSecureContext) {
      setError(t(locale, '当前页面不是安全连接，浏览器会拦截麦克风。请改用 HTTPS 地址访问，或直接在本机 localhost 打开。局域网 HTTP 开发地址通常无法语音输入。', 'This page is not using a secure connection, so the browser may block the microphone. Use HTTPS or local localhost.'));
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t(locale, '当前浏览器不支持麦克风访问接口，请改用 Safari/Chrome 新版本，或使用文本输入。', 'This browser does not support microphone access. Try a newer Safari/Chrome or use text input.'));
      return;
    }

    const SpeechRecognitionCtor =
      (
        window as Window & {
          SpeechRecognition?: new () => {
            continuous: boolean;
            interimResults: boolean;
            lang: string;
            maxAlternatives: number;
            onstart: (() => void) | null;
            onresult:
              | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
              | null;
            onerror: ((event: { error?: string }) => void) | null;
            onend: (() => void) | null;
            start: () => void;
          };
          webkitSpeechRecognition?: new () => {
            continuous: boolean;
            interimResults: boolean;
            lang: string;
            maxAlternatives: number;
            onstart: (() => void) | null;
            onresult:
              | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
              | null;
            onerror: ((event: { error?: string }) => void) | null;
            onend: (() => void) | null;
            start: () => void;
          };
        }
      ).SpeechRecognition ??
      (window as Window & { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setError(t(locale, '当前设备浏览器没有开放系统语音转文字能力。请改用 Safari/Chrome 新版本，或先使用系统键盘麦克风转文字再粘贴。', 'This browser does not provide speech-to-text. Try a newer Safari/Chrome, or use the keyboard microphone and paste the text.'));
      return;
    }

    try {
      setError('');
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStream.getTracks().forEach((track) => track.stop());

      const recognition = new SpeechRecognitionCtor() as {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        maxAlternatives: number;
        onstart: (() => void) | null;
        onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onerror: ((event: { error?: string }) => void) | null;
        onend: (() => void) | null;
        start: () => void;
      };

      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = isEnglish ? 'en-US' : 'zh-CN';
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListeningVoice(true);
      };

      recognition.onresult = async (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? '')
          .join(' ')
          .trim();

        if (!transcript) {
          setError(t(locale, '没有识别到有效语音内容，请再试一次。', 'No clear voice input was recognized. Please try again.'));
          return;
        }

        try {
          await handleChatSubmit(transcript);
        } catch (parseError) {
          setError(localizeErrorMessage(
            parseError instanceof Error ? parseError.message : t(locale, '语音文本解析失败。', 'Voice text parsing failed.'),
            locale,
          ));
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setError(t(locale, '当前浏览器未获得麦克风或语音识别权限，请先允许系统麦克风访问；如果你是通过局域网 HTTP 访问开发环境，也可能被浏览器直接拦截。', 'The browser does not have microphone or speech permission. Allow microphone access first. Local network HTTP pages may also be blocked.'));
          return;
        }

        if (event.error === 'no-speech') {
          setError(t(locale, '没有听到清晰语音，请靠近设备并再试一次。', 'No clear speech was heard. Move closer to the device and try again.'));
          return;
        }

        if (event.error === 'audio-capture') {
          setError(t(locale, '浏览器没有成功连接系统麦克风。请检查系统麦克风权限、浏览器权限，或改用 HTTPS 地址重新打开。', 'The browser could not connect to the microphone. Check system and browser permissions, or reopen with HTTPS.'));
          return;
        }

        setError(t(locale, '当前设备暂时无法完成系统语音输入，请改用文本输入。', 'Voice input is temporarily unavailable on this device. Please use text input.'));
      };

      recognition.onend = () => {
        setIsListeningVoice(false);
      };

      recognition.start();
    } catch (voiceError) {
      setIsListeningVoice(false);
      setError(
        voiceError instanceof Error
          ? t(locale, `无法启动系统语音输入：${voiceError.message}`, `Could not start voice input: ${voiceError.message}`)
          : t(locale, '无法启动系统语音输入。请检查 HTTPS、安全权限和浏览器麦克风授权。', 'Could not start voice input. Check HTTPS, security permissions, and browser microphone access.'),
      );
    }
  };

  const removeChatIngredient = (id: string) => {
    stopSpeaking();
    setActiveSpeechKey('');
    setIngredients((current) => current.filter((item) => item.id !== id));
    setChatMessages((current) =>
      current.map((message) =>
        message.ingredients
          ? {
              ...message,
              ingredients: message.ingredients.filter((item) => item.id !== id),
            }
          : message,
      ),
    );
  };

  const handleSearchWithCurrentIngredients = async (sourceIngredients?: IngredientItem[], sourceMessageId = '') => {
    const nextIngredients = sourceIngredients?.length ? sourceIngredients : ingredients;
    if (nextIngredients.length > 10) {
      setError(t(locale, '一次最多支持 10 个食材，请减少食材后再获取推荐菜谱。', 'Up to 10 ingredients are supported at once. Please remove some before getting recipes.'));
      addChatMessage({
        role: 'assistant',
        text: t(locale, '一次最多支持 10 个食材。请先减少食材数量，再获取推荐菜谱。', 'Up to 10 ingredients are supported at once. Please remove some ingredients before getting recipe ideas.'),
      });
      return;
    }

    setIngredients((current) => mergeIngredientItems(current, sourceIngredients ?? []));
    if (sourceMessageId) {
      setRecommendConfettiMessageId(sourceMessageId);
    }
    await requestChatRecommendations(
      t(locale, '请根据当前已识别食材推荐菜谱', 'Please recommend recipes from the currently recognized ingredients.'),
      nextIngredients,
      sourceMessageId,
      true,
    );
  };

  const toggleFavoriteRecipe = (recipe: RecipeRecommendation) => {
    if (!selectedProfileId) {
      setError(t(locale, '请先选择儿童档案后再收藏菜谱。', 'Please start a chat before saving recipes.'));
      return;
    }

    setFavoriteRecipesByProfile((current) => {
      const currentRecipes = current[selectedProfileId] ?? [];
      const exists = currentRecipes.some((item) => item.id === recipe.id);
      const nextGroup = exists
        ? currentRecipes.filter((item) => item.id !== recipe.id)
        : [recipe, ...currentRecipes.filter((item) => item.id !== recipe.id)].slice(0, 20);
      const next = {
        ...current,
        [selectedProfileId]: nextGroup,
      };
      persistFavoriteRecipes(next);
      if (!exists) {
        setFavoriteConfettiRecipeId(recipe.id);
        setToastMessage(t(locale, `已收藏 ${recipe.name}`, `Saved ${recipe.name}`));
      }
      return next;
    });
  };

  if (isBootstrapping) {
    return (
      <AppShell
        onOpenConversations={() => setIsConversationDrawerOpen(true)}
        onOpenFavorites={() => setIsFavoriteDrawerOpen(true)}
        locale={locale}
        onLocaleChange={handleLocaleChange}
      >
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">{isEnglish ? 'Loading' : '初始化中'}</p>
            <h2>{isEnglish ? 'Loading chats and saved recipes...' : '正在加载对话和收藏菜谱…'}</h2>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell
      onOpenConversations={() => setIsConversationDrawerOpen(true)}
      onOpenFavorites={() => setIsFavoriteDrawerOpen(true)}
      locale={locale}
      onLocaleChange={handleLocaleChange}
    >
      <input
        ref={cameraImageInputRef}
        className="sr-only-input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void handleImageFileChange(event)}
      />
      <input
        ref={fileImageInputRef}
        className="sr-only-input"
        type="file"
        accept="image/*"
        onChange={(event) => void handleImageFileChange(event)}
      />

      {isSplashVisible ? (
        <SplashStoryboardOpening
          locale={locale}
          onEnter={handleEnterApp}
          onLocaleChange={handleLocaleChange}
          shouldReduceMotion={Boolean(shouldReduceMotion)}
        />
      ) : null}

      {isConversationDrawerOpen ? (
        <div className="conversation-layer" role="presentation">
          <button
            type="button"
            className="conversation-backdrop"
            aria-label={isEnglish ? 'Close chat history' : '关闭历史对话'}
            onClick={() => setIsConversationDrawerOpen(false)}
          />
          <aside className="conversation-drawer" aria-label={isEnglish ? 'Chat History' : '历史对话'}>
            <div className="conversation-drawer-header">
              <div>
                <p className="eyebrow">{isEnglish ? 'Chat History' : '历史对话'}</p>
              </div>
              <button type="button" className="ghost-button" onClick={() => setIsConversationDrawerOpen(false)}>
                {isEnglish ? 'Close' : '关闭'}
              </button>
            </div>
            <button type="button" className="new-chat-button" onClick={handleNewConversation}>
              <img src={newChatIcon} alt="" aria-hidden="true" />
              {isEnglish ? 'New Chat' : '新建对话'}
            </button>
            <div className="conversation-drawer-tools">
              <span>{isEnglish ? 'Pronunciation guide' : '开启拼音'}</span>
              <button
                type="button"
                className={isPronunciationModeEnabled ? 'drawer-pronunciation-toggle active' : 'drawer-pronunciation-toggle'}
                onClick={() => handlePronunciationModeChange(!isPronunciationModeEnabled)}
                aria-pressed={isPronunciationModeEnabled}
                aria-label={isEnglish ? 'Toggle pronunciation guide' : '切换拼音模式'}
              >
                {isPronunciationModeEnabled ? (isEnglish ? 'On' : '开启') : (isEnglish ? 'Off' : '关闭')}
              </button>
            </div>
            <div className="conversation-list">
              <p className="conversation-group-title">{isEnglish ? 'Recent' : '最近'}</p>
              {chatSessions.length > 0 ? (
                chatSessions.map((session) => (
                  <div
                    key={session.id}
                    className={session.id === activeChatSessionId ? 'conversation-item active' : 'conversation-item'}
                  >
                    <button
                      type="button"
                      className="conversation-select-button"
                      onClick={() => handleSelectConversation(session)}
                    >
                      <strong>{getSessionTitleDisplay(session.title, locale)}</strong>
                      <span>{session.childContext || (isEnglish ? 'Default healthy student profile' : '默认小学阶段健康饮食原则')}</span>
                    </button>
                    <button
                      type="button"
                      className="conversation-delete-button"
                      onClick={() => handleDeleteConversation(session.id)}
                      aria-label={isEnglish ? `Delete chat: ${getSessionTitleDisplay(session.title, locale)}` : `删除历史对话：${session.title}`}
                    >
                      <TrashInlineIcon />
                    </button>
                  </div>
                ))
              ) : (
                <p className="conversation-empty">{isEnglish ? 'No chat history yet' : '暂无历史对话'}</p>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {isFavoriteDrawerOpen ? (
        <div className="settings-layer" role="presentation">
          <button
            type="button"
            className="settings-backdrop"
            aria-label={isEnglish ? 'Close recipe collection' : '关闭菜谱收藏'}
            onClick={() => setIsFavoriteDrawerOpen(false)}
          />
          <aside className="settings-drawer favorite-drawer" aria-label={isEnglish ? 'Recipe Collection' : '菜谱收藏'}>
            <div className="drawer-header">
              <div>
                <p className="eyebrow">{isEnglish ? 'Recipe Collection' : '菜谱收藏'}</p>
                <h2>{isEnglish ? 'Saved Recipes' : '已收藏菜谱'}</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => setIsFavoriteDrawerOpen(false)}>
                {isEnglish ? 'Close' : '关闭'}
              </button>
            </div>
            <div className="settings-menu favorite-drawer-list">
              {favoriteRecipes.length > 0 ? (
                favoriteRecipes.map((recipe) => (
                  <button
                    key={recipe.id}
                    type="button"
                    className="settings-menu-item favorite-drawer-item"
                    onClick={() => handleOpenFavoriteRecipe(recipe)}
                  >
                    <RecipeName as="strong" name={recipe.name} pinyin={recipe.namePinyin} showPronunciation={isPronunciationModeEnabled} />
                    <span>{recipe.englishName} · {recipe.estimatedTimeMinutes} {isEnglish ? 'min' : '分钟'}</span>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>{isEnglish ? 'No saved recipes yet' : '还没有收藏菜谱'}</strong>
                  <p>{isEnglish ? 'Tap favorite on a recipe card to save it here.' : '在推荐卡片中点击收藏后，会出现在这里。'}</p>
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {error ? (
        <div className="alert-box error-banner">
          <strong>{isEnglish ? 'Notice' : '当前提示'}</strong>
          <p>{localizeStaticText(error, locale)}</p>
        </div>
      ) : null}

      {toastMessage ? (
        <div className="toast-banner" role="status" aria-live="polite">
          {localizeStaticText(toastMessage, locale)}
        </div>
      ) : null}

      <aside className="tablet-landscape-panel tablet-history-panel" aria-label={isEnglish ? 'Chat History' : '历史对话'}>
        <div className="tablet-panel-header">
          <strong>{isEnglish ? 'Chat History' : '历史记录'}</strong>
          <button type="button" onClick={handleNewConversation} aria-label={isEnglish ? 'New chat' : '新建对话'}>
            +
          </button>
        </div>
        <div className="tablet-panel-list">
          {chatSessions.length > 0 ? (
            chatSessions.slice(0, 8).map((session) => (
              <div
                key={`tablet_${session.id}`}
                className={session.id === activeChatSessionId ? 'tablet-panel-row active' : 'tablet-panel-row'}
              >
                <button
                  type="button"
                  className="tablet-panel-item"
                  onClick={() => handleSelectConversation(session)}
                >
                  <strong>{getSessionTitleDisplay(session.title, locale)}</strong>
                  <span>{session.childContext || (isEnglish ? 'Default healthy student profile' : '默认小学阶段健康饮食原则')}</span>
                </button>
                <button
                  type="button"
                  className="tablet-panel-delete"
                  onClick={() => handleDeleteConversation(session.id)}
                  aria-label={isEnglish ? `Delete chat: ${getSessionTitleDisplay(session.title, locale)}` : `删除历史对话：${session.title}`}
                >
                  <TrashInlineIcon />
                </button>
              </div>
            ))
          ) : (
            <p className="tablet-panel-empty">{isEnglish ? 'No chats' : '暂无历史对话'}</p>
          )}
        </div>
      </aside>

      <aside className="tablet-landscape-panel tablet-favorite-panel" aria-label={isEnglish ? 'Recipe Collection' : '菜谱收藏'}>
        <div className="tablet-panel-header">
          <strong>{isEnglish ? 'Recipe Collection' : '我的收藏'}</strong>
          <button type="button" onClick={() => setIsFavoriteDrawerOpen(true)} aria-label={isEnglish ? 'Open collection' : '打开收藏'}>
            ×
          </button>
        </div>
        <div className="tablet-panel-list">
          {favoriteRecipes.length > 0 ? (
            favoriteRecipes.slice(0, 8).map((recipe) => (
              <div
                key={`tablet_favorite_${recipe.id}`}
                className="tablet-panel-row"
              >
                <button
                  type="button"
                  className="tablet-panel-item favorite"
                  onClick={() => handleOpenFavoriteRecipe(recipe)}
                >
                  <RecipeName as="strong" name={recipe.name} pinyin={recipe.namePinyin} showPronunciation={isPronunciationModeEnabled} />
                  <span>{recipe.englishName} · {recipe.estimatedTimeMinutes} {isEnglish ? 'min' : '分钟'}</span>
                </button>
                <button
                  type="button"
                  className="tablet-panel-delete"
                  onClick={() => toggleFavoriteRecipe(recipe)}
                  aria-label={isEnglish ? `Remove saved recipe: ${recipe.name}` : `删除已收藏菜谱：${recipe.name}`}
                >
                  <TrashInlineIcon />
                </button>
              </div>
            ))
          ) : (
            <p className="tablet-panel-empty">{isEnglish ? 'No saved recipes' : '暂无收藏菜谱'}</p>
          )}
        </div>
      </aside>

      <section
        className="chatbox-page"
        onTouchStart={handleChatboxTouchStart}
        onTouchMove={handleChatboxTouchMove}
        onTouchEnd={handleChatboxTouchEnd}
        onTouchCancel={handleChatboxTouchEnd}
      >
          <div className="kids-chat-hero" aria-label={isEnglish ? 'Kids cooking assistant' : '儿童烹饪助手'}>
            <div className="mascot-badge" aria-hidden="true">
              <img src={murphyAvatarImage} alt="" aria-hidden="true" />
            </div>
            <div>
              <h3>{isEnglish ? 'What ingredients should we turn into something delicious?' : '今天想把哪些食材变成好吃的？'}</h3>
              <p>{isEnglish ? 'Speak, take a photo, upload a picture, or type your ingredients.' : '可以说出来、拍下来，或直接打字告诉我。'}</p>
            </div>
          </div>
          <div className="chat-thread" aria-live="polite">
            {chatMessages.map((message) => {
              const messageIngredientsKey = message.ingredients?.length ? buildIngredientsKey(message.ingredients) : '';
              const hasRecommendedForMessageIngredients = Boolean(
                messageIngredientsKey &&
                  chatMessages.some((item) => item.recipes?.length && item.ingredientsKey === messageIngredientsKey),
              );
              const activeKnowledgeIngredient = message.ingredients?.find(
                (ingredient) => buildIngredientKnowledgeKey(ingredient.normalizedName || ingredient.name, locale) === activeIngredientKnowledgeKey,
              );
              const activeIngredientKnowledge = activeKnowledgeIngredient
                ? ingredientKnowledgeByName[activeIngredientKnowledgeKey]
                : null;
              const isActiveIngredientKnowledgeLoading = Boolean(
                activeKnowledgeIngredient && ingredientKnowledgeLoadingByName[activeIngredientKnowledgeKey],
              );
              const activeIngredientKnowledgeError = activeKnowledgeIngredient
                ? ingredientKnowledgeErrorsByName[activeIngredientKnowledgeKey]
                : '';
              const displayMessageText = localizeStaticText(message.text, locale);
              const activeCarouselRecipeId = message.recipes?.length
                ? activeCarouselRecipeByMessageId[message.id] || message.recipes[0].id
                : '';
              const activeCarouselRecipeIndex = message.recipes?.length
                ? Math.max(0, message.recipes.findIndex((recipe) => recipe.id === activeCarouselRecipeId))
                : 0;

              return (
              <article
                key={message.id}
                className={message.role === 'user' ? 'chat-message user' : 'chat-message assistant'}
                data-chat-message-id={message.id}
              >
                {message.role === 'assistant' ? (
                  <img className="assistant-message-avatar" src={murphyAvatarImage} alt="" aria-hidden="true" />
                ) : null}
                <div className="chat-bubble">
                  <div className="chat-bubble-content">
                    {message.nodes?.length ? <StreamNodesRenderer nodes={message.nodes} /> : <p>{displayMessageText}</p>}
                    {message.imageDataUrl ? (
                      <img
                        className="chat-image-preview"
                        src={message.imageDataUrl}
                        alt={message.imageAlt || t(locale, '用户上传的食材图片', 'Ingredient photo uploaded by user')}
                      />
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="assistant-speech-button"
                    onClick={() => speak(displayMessageText, isEnglish ? 'en-US' : 'zh-CN')}
                    aria-label={message.role === 'user' ? t(locale, '朗读用户消息', 'Read user message') : t(locale, '朗读助手消息', 'Read assistant message')}
                  >
                    <PlayInlineIcon />
                  </button>
                </div>
                {message.ingredients?.length && !message.recipes?.length && !message.nodes?.length ? (
                  <section className="ingredient-list-card" aria-label={isEnglish ? 'Available ingredients' : '当前食材清单'}>
                    <div className="ingredient-list-card-header">
                      <div>
                        <p>{isEnglish ? 'Available Ingredients' : '当前食材清单'}</p>
                        <strong>{isEnglish ? 'Confirm these ingredients before recipe ideas' : '确认后我将为你推荐合适的菜谱'}</strong>
                      </div>
                      <span>{isEnglish ? `${message.ingredients.length} items` : `共 ${message.ingredients.length} 项`}</span>
                    </div>
                    <div
                      className="ingredient-card-row"
                      onTouchStart={handleIngredientTouchStart}
                      onTouchMove={handleIngredientTouchMove}
                      onTouchEnd={handleIngredientTouchEnd}
                      onTouchCancel={handleIngredientTouchEnd}
                    >
                    {message.ingredients.map((ingredient) => {
                      const visual = getIngredientVisual(ingredient.name);
                      const isFallback = visual.name === defaultIngredientVisual.name;
                      const ingredientDisplayName = getIngredientDisplayName(ingredient.name, locale);
                      const ingredientPronunciation = isEnglish ? ingredientDisplayName : visual.pinyin;
                      const bounceKey = `${message.id}_${ingredient.id}`;
                      const shouldBounceIngredientEmoji = bouncingIngredientKeys.includes(bounceKey);

	                      return (
	                        <article
	                          key={`${message.id}_${ingredient.id}`}
	                          className={
	                            [
	                              isFallback ? 'chat-ingredient-card fallback' : 'chat-ingredient-card',
	                              buildIngredientKnowledgeKey(ingredient.normalizedName || ingredient.name, locale) === activeIngredientKnowledgeKey
	                                ? 'active'
	                                : '',
	                            ].filter(Boolean).join(' ')
	                          }
	                          role="button"
	                          tabIndex={0}
	                          onClick={() => void handleIngredientKnowledgeClick(ingredient)}
	                          onKeyDown={(event) => {
	                            if (event.key === 'Enter' || event.key === ' ') {
	                              event.preventDefault();
	                              void handleIngredientKnowledgeClick(ingredient);
	                            }
	                          }}
	                        >
                          <span className="ingredient-pinyin">{ingredientPronunciation}</span>
                          <strong>{ingredientDisplayName}</strong>
                          <motion.div
                            className={shouldBounceIngredientEmoji ? 'ingredient-emoji bouncing' : 'ingredient-emoji'}
                            role="img"
                            aria-label={isFallback ? t(locale, '默认食材占位', 'Default ingredient placeholder') : ingredientDisplayName}
                            animate={
                              shouldBounceIngredientEmoji
                                ? { y: [0, -9, 0, -5, 0], scale: [1, 1.05, 1, 1.03, 1] }
                                : { y: 0, scale: 1 }
                            }
                            transition={{
                              duration: 0.8,
                              repeat: shouldBounceIngredientEmoji ? 5 : 0,
                              ease: 'easeInOut',
                            }}
                          >
                            {visual.emoji}
                          </motion.div>
                          <div className="ingredient-card-toolbar">
	                            <button
	                              type="button"
	                              className="ingredient-icon-button speech"
	                              onClick={(event) => {
	                                event.stopPropagation();
	                                speak(`${ingredientDisplayName}，${ingredientPronunciation}`, isEnglish ? 'en-US' : 'zh-CN');
	                              }}
	                              aria-label={t(locale, `朗读食材：${ingredient.name}`, `Read ingredient: ${ingredientDisplayName}`)}
	                            >
                              <PlayInlineIcon />
                            </button>
	                            <button
	                              type="button"
	                              className="ingredient-icon-button delete"
	                              onClick={(event) => {
	                                event.stopPropagation();
	                                removeChatIngredient(ingredient.id);
	                              }}
	                              aria-label={t(locale, `删除食材：${ingredient.name}`, `Remove ingredient: ${ingredientDisplayName}`)}
                            >
                              <TrashInlineIcon />
                            </button>
                          </div>
                        </article>
                      );
                    })}
                      <button
                        type="button"
                        className="ingredient-add-card"
                        onClick={() => fileImageInputRef.current?.click()}
                        disabled={isRecognizingIngredients}
                        aria-label={isEnglish ? 'Add more ingredients from a local photo' : '从本地照片继续新增食材'}
                      >
                        <span>+</span>
	                        <strong>{isEnglish ? 'Add more' : '添加食材'}</strong>
	                      </button>
	                    </div>
	                    {activeKnowledgeIngredient ? (
	                      <section className="ingredient-knowledge-card" aria-label={t(locale, `${activeKnowledgeIngredient.name} 食材知识卡片`, `${getIngredientDisplayName(activeKnowledgeIngredient.name, locale)} ingredient notes`)}>
	                        <div className="ingredient-knowledge-heading">
	                          <div>
	                            <p>{isEnglish ? 'Ingredient Notes' : '食材小百科'}</p>
	                            <strong>
	                              {getIngredientDisplayName(activeKnowledgeIngredient.name, locale)}
	                              <span aria-hidden="true"> · {getIngredientVisual(activeKnowledgeIngredient.name).emoji}</span>
	                            </strong>
	                          </div>
	                          <button
	                            type="button"
	                            className="mini-speech-button"
	                            onClick={() => {
	                              const knowledgeText = activeIngredientKnowledge
	                                ? [
	                                    isEnglish
	                                      ? `${getIngredientDisplayName(activeIngredientKnowledge.name, locale)} nutrition: ${activeIngredientKnowledge.nutritionValues.join(', ')}`
	                                      : `${activeIngredientKnowledge.name}的营养价值：${activeIngredientKnowledge.nutritionValues.join('，')}`,
	                                    isEnglish ? `Origin: ${activeIngredientKnowledge.origin}` : `产地：${activeIngredientKnowledge.origin}`,
	                                    isEnglish ? `Climate: ${activeIngredientKnowledge.growingClimate}` : `适宜气候：${activeIngredientKnowledge.growingClimate}`,
	                                    isEnglish ? `Good pairings: ${activeIngredientKnowledge.bestPairings.join(', ')}` : `最佳搭配：${activeIngredientKnowledge.bestPairings.join('、')}`,
	                                    activeIngredientKnowledge.kidFact,
	                                  ].join(isEnglish ? '. ' : '。')
	                                : t(locale, `${activeKnowledgeIngredient.name} 食材知识正在获取中`, `${getIngredientDisplayName(activeKnowledgeIngredient.name, locale)} notes are loading`);
	                              speak(knowledgeText, isEnglish ? 'en-US' : 'zh-CN');
	                            }}
	                            aria-label={t(locale, `朗读${activeKnowledgeIngredient.name}食材知识`, `Read ${getIngredientDisplayName(activeKnowledgeIngredient.name, locale)} notes`)}
	                          >
	                            <PlayInlineIcon />
	                          </button>
	                        </div>
	                        {isActiveIngredientKnowledgeLoading ? (
	                          <p className="ingredient-knowledge-loading">
	                            <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
	                            {isEnglish ? 'Learning about this ingredient...' : '正在查询食材知识...'}
	                          </p>
	                        ) : activeIngredientKnowledgeError ? (
	                          <div className="ingredient-knowledge-error">
	                            <p>{activeIngredientKnowledgeError}</p>
	                            <button
	                              type="button"
	                              className="secondary-button"
	                              onClick={() => void handleIngredientKnowledgeClick(activeKnowledgeIngredient)}
	                            >
	                              {isEnglish ? 'Try again' : '重新获取'}
	                            </button>
	                          </div>
	                        ) : activeIngredientKnowledge ? (
	                          <div className="ingredient-knowledge-grid">
	                            <div>
	                              <span>{isEnglish ? 'Nutrition' : '营养价值'}</span>
	                              <ul>
	                                {activeIngredientKnowledge.nutritionValues.map((item) => (
	                                  <li key={`${activeIngredientKnowledge.name}_nutrition_${item}`}>{item}</li>
	                                ))}
	                              </ul>
	                            </div>
	                            <div>
	                              <span>{isEnglish ? 'Origin' : '常见产地'}</span>
	                              <p>{activeIngredientKnowledge.origin}</p>
	                            </div>
	                            <div>
	                              <span>{isEnglish ? 'Climate' : '生长气候'}</span>
	                              <p>{activeIngredientKnowledge.growingClimate}</p>
	                            </div>
	                            <div>
	                              <span>{isEnglish ? 'Good Pairings' : '最佳搭配'}</span>
	                              <p>{activeIngredientKnowledge.bestPairings.join('、')}</p>
	                            </div>
	                            <div className="ingredient-knowledge-wide">
	                              <span>{isEnglish ? 'Fun Fact' : '小朋友知识点'}</span>
	                              <p>{activeIngredientKnowledge.kidFact}</p>
	                            </div>
	                            <div className="ingredient-knowledge-wide safety">
	                              <span>{isEnglish ? 'Safety' : '安全提醒'}</span>
	                              <p>{activeIngredientKnowledge.safetyNote}</p>
	                            </div>
	                          </div>
	                        ) : null}
	                      </section>
	                    ) : null}
	                    <div className="ingredient-card-actions">
                      <button
                        type="button"
                        className={
                          hasRecommendedForMessageIngredients
                            ? 'ingredient-recommend-button recommended'
                            : 'ingredient-recommend-button attention'
                        }
                        onClick={() => void handleSearchWithCurrentIngredients(message.ingredients, message.id)}
                        disabled={isRecognizingIngredients || isFetchingRecommendations}
                      >
                        {recommendConfettiMessageId === message.id ? (
                          <span className="button-confetti recommend-button-confetti" aria-hidden="true">
                            {Array.from({ length: 20 }).map((_, index) => (
                              <span
                                key={`${message.id}_recommend_confetti_${index}`}
                                className="button-confetti-piece"
                                style={{
                                  '--x': `${((index % 7) - 3) * 14}px`,
                                  '--y': `${-22 - (index % 5) * 7}px`,
                                  '--r': `${index * 29}deg`,
                                  '--delay': `${(index % 5) * 14}ms`,
                                  '--color': ['#f71972', '#efd4d4', '#f3c9b6', '#dceeb1', '#c5b0f4'][index % 5],
                                } as CSSProperties}
                              />
                            ))}
                          </span>
                        ) : null}
                        {isFetchingRecommendations ? (
                          <span className="recommend-loading-inline">
                            <img className="loading-icon recommend-loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                            <span>{isEnglish ? 'Thinking...' : '推荐中...'}</span>
                          </span>
                        ) : (
                          <>
                            <span>{isEnglish ? 'Surprise Me' : '推荐菜谱'}</span>
                            <small>
                              {hasRecommendedForMessageIngredients
                                ? (isEnglish ? 'Generate a fresh set and replace old recipes' : '可再次生成，并替换历史推荐')
                                : (isEnglish ? 'Get kid-friendly recipes from these ingredients' : '根据当前食材，AI 为你推荐合适的菜谱')}
                            </small>
                          </>
                        )}
                      </button>
                    </div>
                  </section>
                ) : null}
                {message.recipes?.length ? (
                  <section
                    className="recipe-carousel-shell"
                    aria-label={isEnglish ? 'Recommended recipe carousel' : '推荐菜谱走马灯'}
                    aria-roledescription="carousel"
                  >
                    <div className="recipe-carousel-header">
                      <span>{isEnglish ? 'Recommended Recipes' : '推荐菜谱'}</span>
                      <b>{isEnglish ? `Swipe for ${message.recipes.length}` : `左右滑动查看 ${message.recipes.length} 道`}</b>
                    </div>
                    <div
                      className="recipe-carousel"
                      aria-label={isEnglish ? 'Recommended recipes' : '推荐菜谱'}
                      ref={(node) => {
                        recipeCarouselViewportRefs.current[message.id] = node;
                      }}
	                    >
                      <motion.div
                        className="recipe-carousel-track"
                        drag={message.recipes.length > 1 ? 'x' : false}
                        dragDirectionLock
                        dragElastic={0.18}
                        dragMomentum={false}
                        animate={{ x: getRecipeCarouselTrackX(message.id, activeCarouselRecipeIndex) }}
                        transition={
                          shouldReduceMotion
                            ? { duration: 0 }
                            : { type: 'spring', stiffness: 280, damping: 34, mass: 0.85 }
                        }
                        onDragEnd={(_, info) =>
                          handleRecipeCarouselDragEnd(message.id, message.recipes ?? [], activeCarouselRecipeIndex, info)
                        }
                      >
	                    {message.recipes.map((recipe, recipeIndex) => {
	                      const recipeDetail = recipeDetailsById[recipe.id];
	                      const riskAlertText = recipe.riskAlerts.slice(0, 2).join('；');
	                      const hasHighRiskAllergy = hasHighRiskAllergyAlert(riskAlertText, message.ingredients ?? ingredients);
	                      const cookingVideo = recipeVideoByRecipeId[recipe.id] ?? null;
	                      const isLoadingCookingVideo = Boolean(recipeVideoLoadingById[recipe.id]);
	                      const cookingVideoError = recipeVideoErrorsById[recipe.id] ?? '';
	                      const isRecipeDetailRequested = Boolean(recipeDetailRequestedById[recipe.id]);
	                      const shouldShowRecipeMedia = Boolean(recipeDetail || (isRecipeDetailRequested && cookingVideo));
	                      const mediaIngredients = recipeDetail?.ingredients ?? (
	                        shouldShowRecipeMedia && cookingVideo
	                          ? (cookingVideo.ingredients.length ? cookingVideo.ingredients : (message.ingredients ?? ingredients).map((ingredient) => ingredient.name))
	                              .map((name) => ({
	                                name,
	                                quantity: isEnglish ? 'Configured' : '视频配置',
	                              }))
	                          : []
	                      );
	                      const isActiveCarouselRecipe = recipe.id === activeCarouselRecipeId || (!activeCarouselRecipeId && recipeIndex === 0);

	                      return (
                        <motion.article
                          key={`${message.id}_${recipe.id}`}
                          className={isActiveCarouselRecipe ? 'carousel-recipe-card coverflow-card active' : 'carousel-recipe-card coverflow-card'}
                          data-recipe-card-id={recipe.id}
                          data-carousel-recipe-id={recipe.id}
                          style={{ zIndex: getCarouselCardMotionState(recipeIndex, activeCarouselRecipeIndex).zIndex }}
                          animate={shouldReduceMotion ? { x: 0, rotateY: 0, rotateZ: 0, scale: 1, opacity: 1 } : getCarouselCardMotionState(recipeIndex, activeCarouselRecipeIndex)}
                          transition={{ type: 'spring', stiffness: 260, damping: 30, mass: 0.8 }}
                        >
                        <div className="recipe-card-kicker">
                          <span>{isEnglish ? 'Kid-friendly' : '儿童友好食谱'}</span>
                          {recipe.canCookWithCurrentIngredients ? <span className="fit-chip">{isEnglish ? 'Ready to cook' : '现有食材可做'}</span> : null}
                        </div>
                        <div className="recipe-card-name-stack">
                          <button
                            type="button"
                            className="name-audio-button carousel-recipe-name"
                            onClick={() => speak(recipe.name, isEnglish ? 'en-US' : 'zh-CN')}
                            aria-label={t(locale, `朗读菜名：${recipe.name}`, `Read recipe name: ${recipe.name}`)}
                          >
                            <RecipeName as="span" name={recipe.name} pinyin={recipe.namePinyin} showPronunciation={isPronunciationModeEnabled} />
                            <PlayInlineIcon />
                          </button>
                          <button
                            type="button"
                            className="name-audio-button carousel-english-name"
                            onClick={() => speak(recipe.englishName, 'en-US')}
                            aria-label={`Read recipe name: ${recipe.englishName}`}
                          >
                            <span>{recipe.englishName}</span>
                            <PlayInlineIcon />
                          </button>
                        </div>
                        <div className="recipe-summary-row">
                          <p className="compact-copy recipe-summary">{recipe.nutritionSummary}</p>
                          <button
                            type="button"
                            className="mini-speech-button"
                            onClick={() => speak(recipe.nutritionSummary, isEnglish ? 'en-US' : 'zh-CN')}
                            aria-label={isEnglish ? 'Read nutrition summary' : '朗读营养摘要'}
                          >
                            <PlayInlineIcon />
                          </button>
                        </div>
                        <div className="recipe-card-meta-grid">
                          <span>
                            <b>{recipe.estimatedTimeMinutes}</b>
                            <small>{isEnglish ? 'min' : '分钟'}</small>
                          </span>
                          <span>
                            <b>{formatRecipeDifficulty(recipe.difficulty, locale)}</b>
                            <small>{isEnglish ? 'Level' : '难度'}</small>
                          </span>
                          <span>
                            <b>{recipe.ageRange}</b>
                            <small>{isEnglish ? 'Age' : '适合年龄'}</small>
                          </span>
                        </div>
                        <div className="recipe-note-grid">
                          {recipe.riskAlerts.length > 0 ? (
                            <section className={hasHighRiskAllergy ? 'recipe-note-panel warning allergy-warning' : 'recipe-note-panel warning'}>
                              <div className="note-panel-heading">
                                <strong>{isEnglish ? 'Safety Notes' : '烹饪注意'}</strong>
                                <button
                                  type="button"
                                  className="mini-speech-button"
                                  onClick={() => speak(`${isEnglish ? 'Safety notes: ' : '烹饪注意：'}${riskAlertText}`, isEnglish ? 'en-US' : 'zh-CN')}
                                  aria-label={isEnglish ? 'Read safety notes' : '朗读烹饪注意'}
                                >
                                  <PlayInlineIcon />
                                </button>
                              </div>
                              <p>{riskAlertText}</p>
                            </section>
                          ) : null}
                        </div>
                        <div className="inline-recipe-detail recipe-dossier">
                          {shouldShowRecipeMedia ? (
                            <>
                              <div className="inline-detail-block">
                                <div className="detail-block-heading">
                                  <strong>{isEnglish ? 'Ingredients' : '食材配料清单'}</strong>
                                  <span>{isEnglish ? 'Name / Amount' : '名称 / 用量'}</span>
                                </div>
                                <div className="ingredient-table" role="list">
                                  {mediaIngredients.map((ingredient) => {
                                    const ingredientDisplayName = getIngredientDisplayName(ingredient.name, locale);
                                    const visual = getKnownIngredientVisual(ingredient.name);

                                    return (
                                      <div className="ingredient-row" key={`${recipe.id}_${ingredient.name}`} role="listitem">
                                        <span className="ingredient-name">
                                          {ingredientDisplayName}
                                          {visual ? (
                                            <span className="ingredient-inline-emoji" aria-hidden="true">
                                              {visual.emoji}
                                            </span>
                                          ) : null}
                                        </span>
                                        <span className="ingredient-quantity">{ingredient.quantity}</span>
                                        <button
                                          type="button"
                                          className="mini-speech-button ingredient-row-speech"
                                          onClick={() => speak(`${ingredientDisplayName}，${isEnglish ? 'amount ' : '用量 '}${ingredient.quantity}`, isEnglish ? 'en-US' : 'zh-CN')}
                                          aria-label={t(locale, `朗读食材用量：${ingredient.name}`, `Read ingredient amount: ${ingredientDisplayName}`)}
                                        >
                                          <PlayInlineIcon />
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
	                              <div className="inline-detail-block">
	                                <div className="detail-block-heading">
	                                  <strong>{isEnglish ? 'Cartoon Cooking Video' : '卡通烹饪步骤视频'}</strong>
	                                  <span>{isEnglish ? 'Manual generation' : '手动生成'}</span>
	                                </div>
	                                <section className={cookingVideo ? 'recipe-video-panel generated playable' : 'recipe-video-panel'} aria-label={t(locale, `${recipe.name} 烹饪视频`, `${recipe.name} cooking video`)}>
	                                  {cookingVideo ? (
                                      <>
                                        <RecipeVideoPlayer
                                          video={cookingVideo}
                                          title={t(locale, `${recipe.name} 烹饪视频播放器`, `${recipe.name} cooking video player`)}
                                          locale={locale}
                                        />
                                        <div className="recipe-video-copy">
                                          <p>{t(locale, `已匹配 ${cookingVideo.recipeName} 烹饪视频，${cookingVideo.resolution}，${cookingVideo.durationSeconds} 秒。`, `Matched ${cookingVideo.recipeName} cooking video, ${cookingVideo.resolution}, ${cookingVideo.durationSeconds}s.`)}</p>
                                          <a className="secondary-button" href={cookingVideo.videoUrl} target="_blank" rel="noreferrer">
                                            {isEnglish ? 'Open video' : '打开视频'}
                                          </a>
                                        </div>
                                      </>
                                    ) : (
                                      <>
                                        <div className="recipe-video-placeholder" role="img" aria-label={t(locale, `${recipe.name} 默认菜谱封面图`, `${recipe.name} default recipe cover`)}>
                                          <div className="video-sun" aria-hidden="true" />
                                          <div className="video-family" aria-hidden="true">
                                            <span>👩‍🍳</span>
                                            <span>🧒</span>
                                            <span>👨‍🍳</span>
                                          </div>
                                          <div className="video-ingredients" aria-hidden="true">
                                            {mediaIngredients.slice(0, 4).map((ingredient) => {
                                              const visual = getKnownIngredientVisual(ingredient.name);
                                              return visual ? <span key={`${recipe.id}_video_${ingredient.name}`}>{visual.emoji}</span> : null;
                                            })}
                                          </div>
                                          <p>{isLoadingCookingVideo ? (isEnglish ? 'Matching cooking video...' : '正在匹配烹饪视频...') : (isEnglish ? 'No cooking video found' : '未查询到菜谱烹饪视频')}</p>
                                          <strong>{recipe.name}</strong>
                                        </div>
                                        <div className="recipe-video-copy">
                                          <p>{cookingVideoError || (isLoadingCookingVideo ? (isEnglish ? 'Checking the cooking video library.' : '正在查询菜谱烹饪视频库。') : (isEnglish ? 'No cooking video was found for this recipe.' : '未查询到菜谱烹饪视频'))}</p>
                                        </div>
                                      </>
                                    )}
	                                </section>
	                              </div>
	                              {recipeDetail ? (
	                              <div className="inline-detail-block">
	                                <div className="detail-block-heading">
	                                  <strong>{isEnglish ? 'Cooking Steps' : '烹饪步骤'}</strong>
	                                  <span>{isEnglish ? 'Ordered details' : '按序号执行'}</span>
	                                </div>
	                                <ol className="recipe-step-timeline">
	                                  {recipeDetail.steps.map((step, stepIndex) => {
	                                    const speechKey = `step_${recipe.id}_${step.id}`;
	                                    const speechText = isEnglish
	                                      ? `Step ${stepIndex + 1}. ${step.title}. ${step.description}. Tip: ${step.tip}. ${step.childAction ? `Kids can: ${step.childAction}.` : ''}${step.requiresParentAssist ? `Parent help: ${step.parentAction}.` : ''}`
	                                      : `第${stepIndex + 1}步，${step.title}。${step.description}。${step.tip}。${step.childAction ? `小朋友可以：${step.childAction}。` : ''}${step.requiresParentAssist ? `这一步需要家长协助：${step.parentAction}。` : ''}`;
	                                    return (
	                                      <li key={step.id} className={step.requiresParentAssist ? 'recipe-step-item needs-assist' : 'recipe-step-item'}>
	                                        <span className="step-index">{stepIndex + 1}</span>
	                                        <div className="step-body">
	                                          <div className="inline-step-heading">
	                                            <strong>{step.title}</strong>
	                                            <button
	                                              type="button"
	                                              className="step-speech-button"
	                                              onClick={() => speakText(speechText, isEnglish ? 'en-US' : 'zh-CN', speechKey)}
	                                              aria-label={
	                                                isEnglish
	                                                  ? `${activeSpeechKey === speechKey ? 'Stop' : 'Read'} step ${stepIndex + 1}`
	                                                  : `${activeSpeechKey === speechKey ? '停止朗读' : '朗读'}第${stepIndex + 1}步`
	                                              }
	                                            >
	                                              <PlayInlineIcon />
	                                              {activeSpeechKey === speechKey ? (isEnglish ? 'Stop' : '停止') : (isEnglish ? 'Play' : '朗读')}
	                                            </button>
	                                          </div>
	                                          <p>{step.description}</p>
	                                          <p className="step-note"><b>{isEnglish ? 'Tip' : '要点'}</b>{step.tip}</p>
	                                          {step.childAction ? <p className="step-result"><b>{isEnglish ? 'Kid' : '小朋友'}</b>{step.childAction}</p> : null}
	                                          {step.requiresParentAssist ? <p className="step-safety"><b>{isEnglish ? 'Parent' : '家长协助'}</b>{step.parentAction}</p> : null}
	                                        </div>
	                                      </li>
	                                    );
	                                  })}
	                                </ol>
	                              </div>
	                              ) : null}
	                              {!recipeDetail && recipeDetailLoadingById[recipe.id] ? (
	                                <div className="muted compact-copy inline-loading-copy">
	                                  <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
	                                  <StreamNodesRenderer nodes={recipeDetailStreamNodesById[recipe.id]} />
	                                  {recipeDetailStreamNodesById[recipe.id]?.length ? null : <span>{isEnglish ? 'Generating cooking steps...' : '正在生成烹饪步骤...'}</span>}
	                                </div>
	                              ) : null}
	                              {!recipeDetail && !recipeDetailLoadingById[recipe.id] && recipeDetailErrorsById[recipe.id] ? (
	                                <div className="detail-error-block">
	                                  <strong>{isEnglish ? 'Steps failed' : '步骤获取失败'}</strong>
	                                  <p>{recipeDetailErrorsById[recipe.id]}</p>
	                                  <button
	                                    type="button"
	                                    className="secondary-button"
	                                    onClick={() => void loadRecipeDetailForCard(recipe, message.ingredients ?? ingredients, selectedProfile, message.id, true)}
	                                    disabled={recipeDetailLoadingById[recipe.id]}
	                                  >
	                                    {isEnglish ? 'Try again' : '再次获取'}
	                                  </button>
	                                </div>
	                              ) : null}
                            </>
                          ) : recipeDetailLoadingById[recipe.id] ? (
                            <div className="muted compact-copy inline-loading-copy">
                              <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                              <StreamNodesRenderer nodes={recipeDetailStreamNodesById[recipe.id]} />
                              {recipeDetailStreamNodesById[recipe.id]?.length ? null : <span>{isEnglish ? 'Generating cooking steps...' : '正在生成烹饪步骤...'}</span>}
                            </div>
                          ) : recipeDetailErrorsById[recipe.id] ? (
                            <div className="detail-error-block">
                              <strong>{isEnglish ? 'Steps failed' : '步骤获取失败'}</strong>
                              <p>{recipeDetailErrorsById[recipe.id]}</p>
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => void loadRecipeDetailForCard(recipe, message.ingredients ?? ingredients, selectedProfile, message.id, true)}
                                disabled={recipeDetailLoadingById[recipe.id]}
                              >
                                {recipeDetailLoadingById[recipe.id] ? (
                                  <>
                                    <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                                    {isEnglish ? 'Retrying...' : '正在重新获取...'}
                                  </>
                                ) : (
                                  (isEnglish ? 'Try again' : '再次获取')
                                )}
                              </button>
                            </div>
	                          ) : (
	                            <div className="detail-error-block">
	                              <strong>{isEnglish ? 'Cooking steps are ready to generate' : '烹饪步骤待获取'}</strong>
	                              <p>{isEnglish ? 'Tap the button when you want the detailed comic-style cooking steps.' : '需要查看详细图解步骤时，请点击按钮手动获取。'}</p>
	                              <button
	                                type="button"
	                                className="secondary-button"
	                                onClick={() => void loadRecipeDetailForCard(recipe, message.ingredients ?? ingredients, selectedProfile, message.id, true)}
	                                disabled={recipeDetailLoadingById[recipe.id]}
	                              >
	                                {isEnglish ? 'Get Cooking Steps' : '获取烹饪步骤'}
	                              </button>
	                            </div>
	                          )}
                        </div>
                        <div className="carousel-actions single-action">
                          <button
                            type="button"
                            className="ghost-button favorite-card-button"
                            onClick={() => toggleFavoriteRecipe(recipe)}
                          >
                            {favoriteConfettiRecipeId === recipe.id ? (
                              <span className="button-confetti" aria-hidden="true">
                                {Array.from({ length: 18 }).map((_, index) => (
                                  <span
                                    key={`${recipe.id}_confetti_${index}`}
                                    className="button-confetti-piece"
                                    style={{
                                      '--x': `${((index % 6) - 2.5) * 13}px`,
                                      '--y': `${-24 - (index % 4) * 8}px`,
                                      '--r': `${index * 31}deg`,
                                      '--delay': `${(index % 4) * 18}ms`,
                                      '--color': ['#8cff00', '#ff7a1a', '#ffe066', '#4dd8ff', '#ff4fb8'][index % 5],
                                    } as CSSProperties}
                                  />
                                ))}
                              </span>
                            ) : null}
                            {favoriteRecipes.some((item) => item.id === recipe.id) ? (isEnglish ? 'Saved' : '已收藏') : (isEnglish ? 'Save' : '收藏')}
                          </button>
                        </div>
                      </motion.article>
                      );
                    })}
                      </motion.div>
                    </div>
                  </section>
                ) : null}
              </article>
              );
            })}
            <div ref={chatThreadEndRef} className="chat-thread-end" aria-hidden="true" />
          </div>

          {seasonalIngredientSuggestions.length > 0 ? (
            <div className="chat-suggestions" aria-label={isEnglish ? 'Seasonal ingredient suggestions' : '季节食材推荐'}>
              {seasonalIngredientSuggestions.map((item) => {
                const visual = getIngredientVisual(item.name);
                const shouldShowEmoji = visual.name !== defaultIngredientVisual.name;
                const displayName = getIngredientDisplayName(item.name, locale);
                const displayReason = getSeasonalReasonDisplay(item.reason, locale);

                return (
                  <button
                    key={`${item.name}_${item.reason}`}
                    type="button"
                    onClick={() => handleSeasonalIngredientClick(item)}
                    disabled={isRecognizingIngredients}
                    title={displayReason}
                  >
                    {shouldShowEmoji ? (
                      <span className="suggestion-emoji" role="img" aria-label={displayName}>
                        {visual.emoji}
                      </span>
                    ) : null}
                    <span>{displayName}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="chat-composer">
            <button
              type="button"
              className="composer-icon-button"
              onClick={() => void handleStartVoiceInput()}
              disabled={isListeningVoice || isRecognizingIngredients}
              aria-label={isEnglish ? 'Voice input' : '语音输入'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5Zm-1.7-8.5a1.7 1.7 0 1 1 3.4 0v5a1.7 1.7 0 1 1-3.4 0V6Z" />
                <path d="M18.4 10.7a.9.9 0 0 0-1.8 0 4.6 4.6 0 1 1-9.2 0 .9.9 0 0 0-1.8 0 6.4 6.4 0 0 0 5.5 6.33v2.17H8.8a.9.9 0 1 0 0 1.8h6.4a.9.9 0 1 0 0-1.8h-2.3v-2.17a6.4 6.4 0 0 0 5.5-6.33Z" />
              </svg>
            </button>
            <input
              ref={chatInputRef}
              value={manualIngredient}
              onChange={(event) => setManualIngredient(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void handleChatSubmit();
                }
              }}
              placeholder={isEnglish ? 'Type ingredients or use voice/photo...' : '输入食材或用语音、拍照取材'}
              disabled={isRecognizingIngredients}
            />
            <button
              type="button"
              className="composer-icon-button"
              onClick={() => cameraImageInputRef.current?.click()}
              disabled={isUploadingImage || isRecognizingIngredients}
              aria-label={isEnglish ? 'Take ingredient photo' : '拍摄食材'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M8.4 5.1 9.7 3.6c.24-.28.59-.44.96-.44h2.68c.37 0 .72.16.96.44l1.3 1.5h2.8A2.6 2.6 0 0 1 21 7.7v9.5a2.6 2.6 0 0 1-2.6 2.6H5.6A2.6 2.6 0 0 1 3 17.2V7.7a2.6 2.6 0 0 1 2.6-2.6h2.8Zm3.6 12a4.3 4.3 0 1 0 0-8.6 4.3 4.3 0 0 0 0 8.6Zm0-1.8a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z" />
              </svg>
            </button>
            <button
              type="button"
              className="composer-icon-button"
              onClick={() => fileImageInputRef.current?.click()}
              disabled={isUploadingImage || isRecognizingIngredients}
              aria-label={isEnglish ? 'Upload image' : '上传图片'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M11.1 12.9H6.9a.9.9 0 1 1 0-1.8h4.2V6.9a.9.9 0 1 1 1.8 0v4.2h4.2a.9.9 0 1 1 0 1.8h-4.2v4.2a.9.9 0 1 1-1.8 0v-4.2Z" />
              </svg>
            </button>
            <button
              type="button"
              className="primary-button composer-send-button"
              onClick={() => void handleChatSubmit()}
              disabled={!manualIngredient.trim() || isRecognizingIngredients}
              aria-label={isEnglish ? 'Send message' : '发送信息'}
            >
              {isRecognizingIngredients ? (
                <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
              ) : (
                <img src={sendMessageIcon} alt="" aria-hidden="true" />
              )}
            </button>
          </div>
      </section>

      {learningRecipe ? (
        <div className="drawer-layer" role="presentation">
          <button
            type="button"
            className="drawer-backdrop"
            aria-label={isEnglish ? 'Close recipe name learning drawer' : '关闭菜名识字抽屉'}
            onClick={closeLearningDrawer}
          />
          <aside className="learning-drawer" aria-label={t(locale, `${learningRecipe.name} 菜名识字`, `${learningRecipe.name} name learning`)}>
            <div className="drawer-header">
              <div>
                <p className="eyebrow">{isEnglish ? 'Name Learning' : '菜名识字'}</p>
                <h2>{learningRecipe.name}</h2>
                <p className="english-title">{learningRecipe.englishName}</p>
              </div>
              <button type="button" className="ghost-button" onClick={closeLearningDrawer}>
                {isEnglish ? 'Close' : '关闭'}
              </button>
            </div>
            <div className="literacy-grid">
              {learningRecipe.nameLearning.characters.map((item) => (
                <button
                  key={`${learningRecipe.id}-${item.character}`}
                  type="button"
                  className="literacy-token"
                  onClick={() => speak(buildCharacterSpeech(item), 'zh-CN')}
                  aria-label={t(locale, `播报汉字 ${item.character}`, `Read name token ${item.character}`)}
                >
                  <ruby className="literacy-ruby">
                    <span className="literacy-character">{item.character}</span>
                    <rp>(</rp>
                    <rt>{formatPinyin(item.pinyin)}</rt>
                    <rp>)</rp>
                  </ruby>
                  <span>{isEnglish ? `${item.strokes} strokes · ${item.structure}` : `${item.strokes} 画 · ${item.structure}`}</span>
                  <small>{item.hint}</small>
                </button>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </AppShell>
  );
}
