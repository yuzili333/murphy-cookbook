import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent, type TouchEvent } from 'react';
import { AppShell } from './components/AppShell';
import { RecipeName } from './components/RecipeName';
import audioPlayIcon from './assets/audio-play.svg';
import loadingIcon from './assets/loading.svg';
import newChatIcon from './assets/new-chat.svg';
import sendMessageIcon from './assets/send-message.svg';
import { defaultIngredientVisual, getIngredientVisual } from './data/ingredientVisuals';
import {
  fetchGeneratedRecipeDetail,
  fetchRecommendations,
  fetchSeasonalIngredientSuggestions,
  parseIngredientText,
  uploadIngredientImage,
} from './lib/api';
import { buildCharacterSpeech, formatPinyin, speak, stopSpeaking } from './lib/speech';
import type {
  ChildProfile,
  IngredientItem,
  RecipeDetail,
  RecipeRecommendation,
  RecommendationResponse,
  SeasonalIngredientSuggestion,
} from './types';

const favoriteRecipesStorageKey = 'murphy-cookbook.favorite-recipes.v1';
const chatMessagesStorageKey = 'murphy-cookbook.chat-messages.v1';
const likedRecipesStorageKey = 'murphy-cookbook.liked-recipes.v1';
const childContextStorageKey = 'murphy-cookbook.child-context.v1';
const chatSessionsStorageKey = 'murphy-cookbook.chat-sessions.v1';
const activeChatSessionStorageKey = 'murphy-cookbook.active-chat-session.v1';
const recommendationCacheStorageKey = 'murphy-cookbook.recommendation-cache.v1';
const recipeStepCacheStorageKey = 'murphy-cookbook.recipe-step-cache.v1';
const legacyRecipeDetailCacheStorageKey = 'murphy-cookbook.recipe-detail-cache.v1';
const webCacheTtlMs = 3 * 24 * 60 * 60 * 1000;
const conversationProfileId = 'chat_context_profile';
const defaultChildContext =
  '默认服务对象为小学 1-6 年级学生。推荐原则：低油脂、轻口味、膳食均衡、维生素丰富、主食蛋白质蔬菜搭配均衡，避免高糖、高盐、油炸和过度辛辣。未明确提及重度急性过敏风险时，不主动要求补充儿童年龄、饮食偏好或过敏原。';
type FavoriteRecipesByProfile = Record<string, RecipeRecommendation[]>;
type TimedCache<T> = Record<string, { createdAt: string; expiresAt: string; data: T }>;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  imageDataUrl?: string;
  imageAlt?: string;
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
  return {
    id: `chat_welcome_${crypto.randomUUID()}`,
    role: 'assistant',
    text: childContext
      ? '我是智能儿童菜谱助手，已记录本次对话的特殊饮食信息，告诉我今天有什么食材，也可以拍照上传。'
      : '我是智能儿童菜谱助手，请通过文字、语音或拍照上传提供喜欢的食材',
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

function buildRecommendationCacheKey(profile: ChildProfile, ingredientsKey: string, prompt: string) {
  return JSON.stringify({
    profileId: profile.id,
    age: profile.age,
    tastePreferences: profile.tastePreferences,
    allergens: profile.allergens,
    dietaryHabits: profile.dietaryHabits,
    ingredientsKey,
    prompt: prompt.trim(),
  });
}

function buildRecipeStepCacheKey(recipeName: string) {
  return recipeName.trim().replace(/\s+/g, '').toLowerCase();
}

function buildRecipeDetailsMap(details: RecipeDetail[]) {
  return details.reduce<Record<string, RecipeDetail>>((map, detail) => {
    map[detail.id] = detail;
    return map;
  }, {});
}

function formatRecipeDifficulty(difficulty: RecipeRecommendation['difficulty']) {
  const labels: Record<RecipeRecommendation['difficulty'], string> = {
    easy: '简单',
    medium: '中等',
    hard: '较难',
  };

  return labels[difficulty] ?? '中等';
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

function summarizeStepCaption(step: RecipeDetail['steps'][number]) {
  const source = step.childAction || step.description || step.title;
  const compact = source
    .replace(/^[请先然后接着最后再把将]+/, '')
    .replace(/[。！？!?,，；;].*$/, '')
    .trim();

  return (compact || step.title).slice(0, 18);
}

function getStoryboardPanelCount(stepCount: number) {
  if (stepCount <= 4) return 1;
  if (stepCount <= 6) return 2;
  if (stepCount <= 8) return 3;
  return 4;
}

function groupStepsForStoryboard(steps: RecipeDetail['steps']) {
  const panelCount = getStoryboardPanelCount(steps.length);
  const groupSize = Math.ceil(steps.length / panelCount);

  return Array.from({ length: panelCount }, (_, panelIndex) => {
    const startIndex = panelIndex * groupSize;
    return steps.slice(startIndex, startIndex + groupSize);
  }).filter((group) => group.length > 0);
}

const storyboardFamilyGroups = [
  ['👩‍🍳', '👧'],
  ['👨‍🍳', '👦'],
  ['👩‍🍳', '👨‍🍳', '🧒'],
  ['👩🏻‍🍳', '👧🏻'],
  ['👨🏻‍🍳', '👦🏻'],
  ['👩🏼‍🍳', '👨🏼‍🍳', '👧🏼'],
  ['👩🏽‍🍳', '👧🏽'],
  ['👨🏽‍🍳', '👦🏽'],
  ['👩🏾‍🍳', '👨🏾‍🍳', '🧒🏾'],
  ['👩🏿‍🍳', '👧🏿'],
  ['👨🏿‍🍳', '👦🏿'],
  ['👩', '🧒'],
  ['👨', '🧒'],
  ['👩', '👨', '👧'],
  ['👩‍🍳', '🧒'],
  ['👨‍🍳', '🧒'],
  ['👩‍🍳', '👨', '👦'],
  ['👨‍🍳', '👩', '👧'],
  ['👨‍👩‍👧'],
  ['👨‍👩‍👦'],
];

const storyboardKitchenSafetyEmojis = [
  { emoji: '🔪', keywords: ['刀', '切', '削', '剁', '片', '丝'] },
  { emoji: '✂️', keywords: ['剪'] },
  { emoji: '🔥', keywords: ['火', '燃气', '明火', '烧', '热锅'] },
  { emoji: '🍳', keywords: ['锅', '煎', '炒'] },
  { emoji: '🥘', keywords: ['炖', '焖', '煮'] },
  { emoji: '🍲', keywords: ['汤', '煲'] },
  { emoji: '♨️', keywords: ['烫', '热', '开水'] },
  { emoji: '💨', keywords: ['蒸'] },
  { emoji: '⚡', keywords: ['电', '插座'] },
  { emoji: '📛', keywords: ['危险', '禁止'] },
  { emoji: '⚠️', keywords: ['注意', '小心', '风险'] },
  { emoji: '🧯', keywords: ['火', '油'] },
  { emoji: '🧤', keywords: ['烤箱', '热盘', '端出'] },
  { emoji: '🥣', keywords: ['搅拌', '混合'] },
  { emoji: '🥄', keywords: ['勺', '舀'] },
  { emoji: '🍽️', keywords: ['装盘', '摆盘'] },
  { emoji: '🧊', keywords: ['冷藏', '冰', '降温'] },
  { emoji: '⏲️', keywords: ['分钟', '等待', '计时'] },
  { emoji: '🌡️', keywords: ['温度', '火候'] },
  { emoji: '🧼', keywords: ['洗', '清洁'] },
];

function getKnownIngredientVisual(name: string) {
  const visual = getIngredientVisual(name);
  return visual.name === defaultIngredientVisual.name ? null : visual;
}

function buildStepSearchText(step: RecipeDetail['steps'][number]) {
  return [step.title, step.description, step.childAction, step.parentAction, step.expectedResult, step.tip].filter(Boolean).join('');
}

function getIngredientStepKeywords(ingredientName: string, visual: NonNullable<ReturnType<typeof getKnownIngredientVisual>>) {
  const baseNames = [ingredientName, visual.name, ...(visual.aliases ?? [])].filter(Boolean);
  const derivedNames = new Set(baseNames);

  for (const name of baseNames) {
    if (name.includes('鸡蛋')) {
      derivedNames.add('蛋液');
      derivedNames.add('打蛋');
      derivedNames.add('蛋黄');
      derivedNames.add('蛋清');
    }
    if (name.includes('西红柿') || name.includes('番茄')) {
      derivedNames.add('番茄');
      derivedNames.add('西红柿');
    }
    if (name.includes('土豆')) {
      derivedNames.add('薯块');
      derivedNames.add('土豆块');
    }
    if (name.includes('胡萝卜')) {
      derivedNames.add('萝卜丁');
      derivedNames.add('胡萝卜丁');
    }
    if (name.includes('青菜') || name.includes('白菜') || name.includes('菠菜') || name.includes('生菜')) {
      derivedNames.add('菜叶');
      derivedNames.add('叶菜');
    }
  }

  return Array.from(derivedNames);
}

function getPanelIngredientVisuals(panelSteps: RecipeDetail['steps'], recipeIngredients: RecipeDetail['ingredients']) {
  const panelText = panelSteps.map(buildStepSearchText).join('');
  const normalizedPanelText = panelText.replace(/\s+/g, '').toLowerCase();
  const matched = recipeIngredients
    .map((ingredient) => {
      const visual = getKnownIngredientVisual(ingredient.name);
      if (!visual) return null;
      const names = getIngredientStepKeywords(ingredient.name, visual);
      const isMatched = names.some((name) => {
        const normalizedName = name.replace(/\s+/g, '').toLowerCase();
        return normalizedPanelText.includes(normalizedName);
      });

      return isMatched ? { name: ingredient.name, emoji: visual.emoji } : null;
    })
    .filter((item): item is { name: string; emoji: string } => Boolean(item));

  return matched.filter((item, index, items) => items.findIndex((candidate) => candidate.name === item.name) === index).slice(0, 4);
}

function getPanelSafetyEmojis(panelSteps: RecipeDetail['steps']) {
  const panelText = panelSteps.map(buildStepSearchText).join('');
  const matched = storyboardKitchenSafetyEmojis
    .filter((item) => item.keywords.some((keyword) => panelText.includes(keyword)))
    .map((item) => item.emoji);

  return Array.from(new Set(matched)).slice(0, 4);
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
  const requestedRecipeDetailKeysRef = useRef<Set<string>>(new Set());
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
  const [pendingScrollRecipeId, setPendingScrollRecipeId] = useState('');
  const [pendingIngredientMessageId, setPendingIngredientMessageId] = useState('');
  const [childContext, setChildContext] = useState('');
  const [recipeDetailsById, setRecipeDetailsById] = useState<Record<string, RecipeDetail>>({});
  const [recipeDetailLoadingById, setRecipeDetailLoadingById] = useState<Record<string, boolean>>({});
  const [recipeDetailErrorsById, setRecipeDetailErrorsById] = useState<Record<string, string>>({});
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
  const isRecognizingIngredients = isParsingText || isUploadingImage;

  const speakText = (text: string, lang = 'zh-CN', speechKey = '') => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setError('当前设备浏览器不支持语音朗读功能。');
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
        setError(bootstrapError instanceof Error ? bootstrapError.message : '初始化失败，请稍后重试。');
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
        const data = await fetchSeasonalIngredientSuggestions(new Date().getMonth() + 1, childContext.trim() || defaultChildContext);
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
  }, [childContext]);

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
    const stepCacheKey = buildRecipeStepCacheKey(recipe.name);
    const cachedDetail = readCachedValue<RecipeDetail>(recipeStepCacheStorageKey, stepCacheKey);
    if (cachedDetail) {
      setRecipeDetailsById((current) => ({ ...current, [cachedDetail.id]: cachedDetail, [recipe.id]: cachedDetail }));
      mergeRecipeDetailIntoCurrentSession(messageId, cachedDetail);
      setRecipeDetailErrorsById((current) => {
        const next = { ...current };
        delete next[recipe.id];
        return next;
      });
      return;
    }

    setRecipeDetailLoadingById((current) => ({ ...current, [recipe.id]: true }));
    setRecipeDetailErrorsById((current) => {
      const next = { ...current };
      delete next[recipe.id];
      return next;
    });

    try {
      const detail = await fetchGeneratedRecipeDetail({
        profileId: profile.id,
        profile,
        ingredients: nextIngredients,
        recipe,
      });
      setRecipeDetailsById((current) => ({ ...current, [detail.id]: detail, [recipe.id]: detail }));
      mergeRecipeDetailIntoCurrentSession(messageId, detail);
      writeCachedValue(recipeStepCacheStorageKey, stepCacheKey, detail);
    } catch (detailError) {
      const message = detailError instanceof Error ? detailError.message : '菜谱步骤获取失败。';
      setRecipeDetailErrorsById((current) => ({ ...current, [recipe.id]: message }));
      if (showToast) {
        setToastMessage(`${recipe.name} 步骤获取失败，请稍后重试。`);
      }
    } finally {
      setRecipeDetailLoadingById((current) => ({ ...current, [recipe.id]: false }));
    }
  };

  useEffect(() => {
    if (isBootstrapping || typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      return;
    }

    const recipeCards = Array.from(document.querySelectorAll<HTMLElement>('.carousel-recipe-card[data-recipe-card-id]'));
    if (recipeCards.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }

          const card = entry.target as HTMLElement;
          const recipeId = card.dataset.recipeCardId ?? '';
          const messageId = card.closest<HTMLElement>('[data-chat-message-id]')?.dataset.chatMessageId ?? '';
          const message = chatMessages.find((item) => item.id === messageId);
          const recipe = message?.recipes?.find((item) => item.id === recipeId);
          const nextIngredients = message?.ingredients?.length ? message.ingredients : ingredients;

          if (!recipe || !messageId || nextIngredients.length === 0) {
            observer.unobserve(card);
            continue;
          }

          const requestKey = `${messageId}:${recipe.id}:${buildIngredientsKey(nextIngredients)}`;
          if (
            recipeDetailsById[recipe.id] ||
            recipeDetailLoadingById[recipe.id] ||
            requestedRecipeDetailKeysRef.current.has(requestKey)
          ) {
            observer.unobserve(card);
            continue;
          }

          requestedRecipeDetailKeysRef.current.add(requestKey);
          observer.unobserve(card);
          void loadRecipeDetailForCard(recipe, nextIngredients, selectedProfile, messageId);
        }
      },
      {
        root: null,
        rootMargin: '140px 0px 180px 0px',
        threshold: 0.18,
      },
    );

    recipeCards.forEach((card) => observer.observe(card));

    return () => observer.disconnect();
  }, [chatMessages, ingredients, isBootstrapping, recipeDetailLoadingById, recipeDetailsById, selectedProfile]);

  const requestChatRecommendations = async (
    prompt: string,
    nextIngredients: IngredientItem[],
    sourceIngredientMessageId = '',
  ) => {
    if (nextIngredients.length === 0) {
      addChatMessage({
        role: 'assistant',
        text: '我还没有识别到可用食材。你可以输入“鸡蛋、番茄、黄瓜”，或直接拍一张食材照片。',
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

    try {
      const recommendationPrompt = [
        `儿童情况：${childContext.trim() || defaultChildContext}`,
        `用户本轮输入：${prompt}`,
      ].join('\n');
      const recommendationCacheKey = buildRecommendationCacheKey(selectedProfile, ingredientsKey, recommendationPrompt);
      const cachedRecommendation = readCachedValue<RecommendationResponse>(
        recommendationCacheStorageKey,
        recommendationCacheKey,
      );
      const data = cachedRecommendation ?? await fetchRecommendations(selectedProfile, nextIngredients, recommendationPrompt);
      if (!cachedRecommendation) {
        writeCachedValue(recommendationCacheStorageKey, recommendationCacheKey, data);
      }
      const recipes = data.recipes;
      const recipeDetails = data.recipeDetails ?? [];
      setChatMessages((current) =>
        current.filter((message) => {
          if (!message.recipes?.length) {
            return true;
          }

          if (message.ingredientsKey) {
            return message.ingredientsKey !== ingredientsKey;
          }

          return !nextIngredients.every((item) => message.text.includes(item.name));
        }),
      );
      setRecipeDetailsById(buildRecipeDetailsMap(recipeDetails));
      setRecipeDetailLoadingById({});
      setRecipeDetailErrorsById({});
      skipNextChatAutoScrollRef.current = true;
      const recipeMessage = addChatMessage({
        role: 'assistant',
        text: `根据${nextIngredients.map((item) => item.name).join('、')}，按小学阶段健康饮食原则推荐了 ${recipes.length} 道菜。`,
        ingredientsKey,
        ingredients: nextIngredients,
        recipes,
        recipeDetails,
      });
      setPendingIngredientMessageId(ingredientMessageId || recipeMessage.id);
      setManualIngredient('');
    } catch (recommendationError) {
      setError(recommendationError instanceof Error ? recommendationError.message : '推荐失败，请稍后重试。');
      addChatMessage({
        role: 'assistant',
        text: recommendationError instanceof Error ? recommendationError.message : '推荐失败，请稍后重试。',
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
      quantity: '适量',
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
      text: suggestion.name,
    });
    addChatMessage({
      role: 'assistant',
      text: `已选择时令食材：${suggestion.name}。你可以继续补充食材，也可以直接搜索菜谱。`,
      ingredients: nextIngredients,
    });
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
          text: '你提到了可能引发严重急性过敏的情况。我已记录这条特殊饮食信息。为了更安全，请补充孩子是否已确诊相关食材过敏、严重程度，以及是否需要完全避开这类食材。',
        });
        setManualIngredient('');
        return;
      }

      const parsed = await parseIngredientText(prompt);
      const nextIngredients = mergeIngredientItems(ingredients, parsed.ingredients);
      if (nextIngredients.length > 10) {
        setError('一次最多支持 10 个食材，请减少食材后再继续添加。');
        addChatMessage({
          role: 'assistant',
          text: '一次最多支持 10 个食材。当前识别后会超过上限，请减少食材或换一组食材。',
        });
        return;
      }
      setIngredients(nextIngredients);
      setManualIngredient('');
      if (chatInputRef.current) {
        chatInputRef.current.value = '';
      }
      addChatMessage({
        role: 'assistant',
        text: parsed.ingredients.length > 0 ? '我识别到了这些食材。你可以继续补充食材，也可以直接搜索菜谱。' : '我暂时没有识别到明确食材，可以换一种说法再试。',
        ingredients: nextIngredients,
      });
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : '食材识别失败。');
      addChatMessage({
        role: 'assistant',
        text: chatError instanceof Error ? chatError.message : '食材识别失败，请稍后再试。',
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
        text: '我上传了一张食材图片',
        imageDataUrl,
        imageAlt: file.name ? `用户上传的食材图片：${file.name}` : '用户上传的食材图片',
      });

      const data = await uploadIngredientImage(file);
      const nextIngredients = mergeIngredientItems(ingredients, data.ingredients);
      if (nextIngredients.length > 10) {
        setError('一次最多支持 10 个食材，请减少食材后再继续添加。');
        addChatMessage({
          role: 'assistant',
          text: '图片识别出的食材加入后会超过 10 个上限，请减少食材后再继续。',
        });
        return;
      }
      setIngredients(nextIngredients);
      addChatMessage({
        role: 'assistant',
        text: data.ingredients.length > 0 ? '我从图片里识别到了这些食材。' : '我暂时没有从图片里识别到明确食材。',
        ingredients: nextIngredients,
      });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '图片上传失败。');
    } finally {
      setIsUploadingImage(false);
      event.target.value = '';
    }
  };

  const handleStartVoiceInput = async () => {
    if (typeof window === 'undefined') {
      setError('当前环境不支持语音输入。');
      return;
    }

    if (!window.isSecureContext) {
      setError('当前页面不是安全连接，浏览器会拦截麦克风。请改用 HTTPS 地址访问，或直接在本机 localhost 打开。局域网 HTTP 开发地址通常无法语音输入。');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持麦克风访问接口，请改用 Safari/Chrome 新版本，或使用文本输入。');
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
      setError('当前设备浏览器没有开放系统语音转文字能力。请改用 Safari/Chrome 新版本，或先使用系统键盘麦克风转文字再粘贴。');
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
      recognition.lang = 'zh-CN';
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
          setError('没有识别到有效语音内容，请再试一次。');
          return;
        }

        try {
          await handleChatSubmit(transcript);
        } catch (parseError) {
          setError(parseError instanceof Error ? parseError.message : '语音文本解析失败。');
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setError('当前浏览器未获得麦克风或语音识别权限，请先允许系统麦克风访问；如果你是通过局域网 HTTP 访问开发环境，也可能被浏览器直接拦截。');
          return;
        }

        if (event.error === 'no-speech') {
          setError('没有听到清晰语音，请靠近设备并再试一次。');
          return;
        }

        if (event.error === 'audio-capture') {
          setError('浏览器没有成功连接系统麦克风。请检查系统麦克风权限、浏览器权限，或改用 HTTPS 地址重新打开。');
          return;
        }

        setError('当前设备暂时无法完成系统语音输入，请改用文本输入。');
      };

      recognition.onend = () => {
        setIsListeningVoice(false);
      };

      recognition.start();
    } catch (voiceError) {
      setIsListeningVoice(false);
      setError(
        voiceError instanceof Error
          ? `无法启动系统语音输入：${voiceError.message}`
          : '无法启动系统语音输入。请检查 HTTPS、安全权限和浏览器麦克风授权。',
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
      setError('一次最多支持 10 个食材，请减少食材后再获取推荐菜谱。');
      addChatMessage({
        role: 'assistant',
        text: '一次最多支持 10 个食材。请先减少食材数量，再获取推荐菜谱。',
      });
      return;
    }

    setIngredients((current) => mergeIngredientItems(current, sourceIngredients ?? []));
    await requestChatRecommendations('请根据当前已识别食材推荐菜谱', nextIngredients, sourceMessageId);
  };

  const toggleFavoriteRecipe = (recipe: RecipeRecommendation) => {
    if (!selectedProfileId) {
      setError('请先选择儿童档案后再收藏菜谱。');
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
        setToastMessage(`已收藏 ${recipe.name}`);
      }
      return next;
    });
  };

  if (isBootstrapping) {
    return (
      <AppShell
        onOpenConversations={() => setIsConversationDrawerOpen(true)}
        onOpenFavorites={() => setIsFavoriteDrawerOpen(true)}
      >
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">初始化中</p>
            <h2>正在加载对话和收藏菜谱…</h2>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell
      onOpenConversations={() => setIsConversationDrawerOpen(true)}
      onOpenFavorites={() => setIsFavoriteDrawerOpen(true)}
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

      {isConversationDrawerOpen ? (
        <div className="conversation-layer" role="presentation">
          <button
            type="button"
            className="conversation-backdrop"
            aria-label="关闭历史对话"
            onClick={() => setIsConversationDrawerOpen(false)}
          />
          <aside className="conversation-drawer" aria-label="历史对话">
            <div className="conversation-drawer-header">
              <div>
                <p className="eyebrow">历史对话</p>
              </div>
              <button type="button" className="ghost-button" onClick={() => setIsConversationDrawerOpen(false)}>
                关闭
              </button>
            </div>
            <button type="button" className="new-chat-button" onClick={handleNewConversation}>
              <img src={newChatIcon} alt="" aria-hidden="true" />
              新建对话
            </button>
            <div className="conversation-list">
              <p className="conversation-group-title">最近</p>
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
                      <strong>{session.title}</strong>
                      <span>{session.childContext || '默认小学阶段健康饮食原则'}</span>
                    </button>
                    <button
                      type="button"
                      className="conversation-delete-button"
                      onClick={() => handleDeleteConversation(session.id)}
                      aria-label={`删除历史对话：${session.title}`}
                    >
                      删除
                    </button>
                  </div>
                ))
              ) : (
                <p className="conversation-empty">暂无历史对话</p>
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
            aria-label="关闭菜谱收藏"
            onClick={() => setIsFavoriteDrawerOpen(false)}
          />
          <aside className="settings-drawer favorite-drawer" aria-label="菜谱收藏">
            <div className="drawer-header">
              <div>
                <p className="eyebrow">菜谱收藏</p>
                <h2>已收藏菜谱</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => setIsFavoriteDrawerOpen(false)}>
                关闭
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
                    <RecipeName as="strong" name={recipe.name} pinyin={recipe.namePinyin} />
                    <span>{recipe.englishName} · {recipe.estimatedTimeMinutes} 分钟</span>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>还没有收藏菜谱</strong>
                  <p>在推荐卡片中点击收藏后，会出现在这里。</p>
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {error ? (
        <div className="alert-box error-banner">
          <strong>当前提示</strong>
          <p>{error}</p>
        </div>
      ) : null}

      {toastMessage ? (
        <div className="toast-banner" role="status" aria-live="polite">
          {toastMessage}
        </div>
      ) : null}

      <section
        className="chatbox-page"
        onTouchStart={handleChatboxTouchStart}
        onTouchMove={handleChatboxTouchMove}
        onTouchEnd={handleChatboxTouchEnd}
        onTouchCancel={handleChatboxTouchEnd}
      >
          <div className="kids-chat-hero" aria-label="儿童烹饪助手">
            <div className="mascot-badge" aria-hidden="true">
              <span className="mascot-chef-hat">▴</span>
              <span className="mascot-face">😊</span>
              <span className="mascot-spoon">🥄</span>
            </div>
            <div>
              <p className="eyebrow">KIDS COOKING BOT</p>
              <h2>今天想把哪些食材变成好吃的？</h2>
              <p>可以说出来、拍下来，或直接打字告诉我。</p>
            </div>
          </div>
          <div className="chat-thread" aria-live="polite">
            {chatMessages.map((message) => {
              const messageIngredientsKey = message.ingredients?.length ? buildIngredientsKey(message.ingredients) : '';
              const hasRecommendedForMessageIngredients = Boolean(
                messageIngredientsKey &&
                  chatMessages.some((item) => item.recipes?.length && item.ingredientsKey === messageIngredientsKey),
              );

              return (
              <article
                key={message.id}
                className={message.role === 'user' ? 'chat-message user' : 'chat-message assistant'}
                data-chat-message-id={message.id}
              >
                <div className="chat-bubble">
                  <div className="chat-bubble-content">
                    <p>{message.text}</p>
                    {message.imageDataUrl ? (
                      <img
                        className="chat-image-preview"
                        src={message.imageDataUrl}
                        alt={message.imageAlt || '用户上传的食材图片'}
                      />
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="assistant-speech-button"
                    onClick={() => speak(message.text, 'zh-CN')}
                    aria-label={message.role === 'user' ? '朗读用户消息' : '朗读助手消息'}
                  >
                    <PlayInlineIcon />
                  </button>
                </div>
                {message.ingredients?.length && !message.recipes?.length ? (
                  <section className="ingredient-list-card" aria-label="当前食材清单">
                    <div className="ingredient-list-card-header">
                      <div>
                        <p>当前食材清单</p>
                        <strong>确认后我将为你推荐合适的菜谱</strong>
                      </div>
                      <span>共 {message.ingredients.length} 项</span>
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

                      return (
                        <article
                          key={`${message.id}_${ingredient.id}`}
                          className={isFallback ? 'chat-ingredient-card fallback' : 'chat-ingredient-card'}
                        >
                          <span className="ingredient-pinyin">{visual.pinyin}</span>
                          <strong>{ingredient.name}</strong>
                          <div className="ingredient-emoji" role="img" aria-label={isFallback ? '默认食材占位' : ingredient.name}>
                            {visual.emoji}
                          </div>
                          <div className="ingredient-card-toolbar">
                            <button
                              type="button"
                              className="ingredient-icon-button speech"
                              onClick={() => speak(`${ingredient.name}，${visual.pinyin}`, 'zh-CN')}
                              aria-label={`朗读食材：${ingredient.name}`}
                            >
                              <PlayInlineIcon />
                            </button>
                            <button
                              type="button"
                              className="ingredient-icon-button delete"
                              onClick={() => removeChatIngredient(ingredient.id)}
                              aria-label={`删除食材：${ingredient.name}`}
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
                        aria-label="从本地照片继续新增食材"
                      >
                        <span>+</span>
                        <strong>添加食材</strong>
                      </button>
                    </div>
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
                        {isFetchingRecommendations ? (
                          <>
                            <img className="loading-icon recommend-loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                            <span>推荐中...</span>
                            <small>AI 正在根据当前食材生成菜谱</small>
                          </>
                        ) : (
                          <>
                            <span>推荐菜谱</span>
                            <small>根据当前食材，AI 为你推荐合适的菜谱</small>
                          </>
                        )}
                      </button>
                    </div>
                  </section>
                ) : null}
                {message.recipes?.length ? (
                  <section
                    className="recipe-carousel-shell"
                    aria-label="推荐菜谱走马灯"
                    aria-roledescription="carousel"
                  >
                    <div className="recipe-carousel-header">
                      <span>推荐菜谱</span>
                      <b>左右滑动查看 {message.recipes.length} 道</b>
                    </div>
                    <div
                      className="recipe-carousel"
                      aria-label="推荐菜谱"
                    >
                    {message.recipes.map((recipe) => {
                      const recipeDetail = recipeDetailsById[recipe.id];
                      const recipeStoryboardPanels = recipeDetail ? groupStepsForStoryboard(recipeDetail.steps) : [];
                      const riskAlertText = recipe.riskAlerts.slice(0, 2).join('；');
                      const hasHighRiskAllergy = hasHighRiskAllergyAlert(riskAlertText, message.ingredients ?? ingredients);

                      return (
                        <article
                          key={`${message.id}_${recipe.id}`}
                          className="carousel-recipe-card"
                          data-recipe-card-id={recipe.id}
                        >
                        <div className="recipe-card-kicker">
                          <span>儿童友好食谱</span>
                          {recipe.canCookWithCurrentIngredients ? <span className="fit-chip">现有食材可做</span> : null}
                        </div>
                        <div className="recipe-card-name-stack">
                          <button
                            type="button"
                            className="name-audio-button carousel-recipe-name"
                            onClick={() => speak(recipe.name, 'zh-CN')}
                            aria-label={`朗读菜名：${recipe.name}`}
                          >
                            <RecipeName as="span" name={recipe.name} pinyin={recipe.namePinyin} />
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
                            onClick={() => speak(recipe.nutritionSummary, 'zh-CN')}
                            aria-label="朗读营养摘要"
                          >
                            <PlayInlineIcon />
                          </button>
                        </div>
                        <div className="recipe-card-meta-grid">
                          <span>
                            <b>{recipe.estimatedTimeMinutes}</b>
                            <small>分钟</small>
                          </span>
                          <span>
                            <b>{formatRecipeDifficulty(recipe.difficulty)}</b>
                            <small>难度</small>
                          </span>
                          <span>
                            <b>{recipe.ageRange}</b>
                            <small>适合年龄</small>
                          </span>
                        </div>
                        <div className="recipe-note-grid">
                          {recipe.riskAlerts.length > 0 ? (
                            <section className={hasHighRiskAllergy ? 'recipe-note-panel warning allergy-warning' : 'recipe-note-panel warning'}>
                              <div className="note-panel-heading">
                                <strong>烹饪注意</strong>
                                <button
                                  type="button"
                                  className="mini-speech-button"
                                  onClick={() => speak(`烹饪注意：${riskAlertText}`, 'zh-CN')}
                                  aria-label="朗读烹饪注意"
                                >
                                  <PlayInlineIcon />
                                </button>
                              </div>
                              <p>{riskAlertText}</p>
                            </section>
                          ) : null}
                        </div>
                        <div className="inline-recipe-detail recipe-dossier">
                          {recipeDetail ? (
                            <>
                              <div className="inline-detail-meta">
                                <span>
                                  <b>{recipeDetail.prepTimeMinutes}</b>
                                  备料分钟
                                </span>
                                <span>
                                  <b>{recipeDetail.cookTimeMinutes}</b>
                                  烹饪分钟
                                </span>
                              </div>
                              <div className="inline-detail-block">
                                <div className="detail-block-heading">
                                  <strong>食材配料清单</strong>
                                  <span>名称 / 用量</span>
                                </div>
                                <div className="ingredient-table" role="list">
                                  {recipeDetail.ingredients.map((ingredient) => (
                                    <div className="ingredient-row" key={`${recipe.id}_${ingredient.name}`} role="listitem">
                                      <span className="ingredient-name">
                                        {ingredient.name}
                                        {getKnownIngredientVisual(ingredient.name) ? (
                                          <span className="ingredient-inline-emoji" aria-hidden="true">
                                            {getKnownIngredientVisual(ingredient.name)?.emoji}
                                          </span>
                                        ) : null}
                                      </span>
                                      <span className="ingredient-quantity">{ingredient.quantity}</span>
                                      <button
                                        type="button"
                                        className="mini-speech-button ingredient-row-speech"
                                        onClick={() => speak(`${ingredient.name}，用量 ${ingredient.quantity}`, 'zh-CN')}
                                        aria-label={`朗读食材用量：${ingredient.name}`}
                                      >
                                        <PlayInlineIcon />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className="inline-detail-block">
                                <div className="detail-block-heading">
                                  <strong>卡通步骤图解</strong>
                                  <span>看图做菜</span>
                                </div>
                                <div className="step-storyboard" aria-label={`${recipe.name} 卡通步骤图解`}>
                                  {recipeStoryboardPanels.map((panelSteps, panelIndex) => {
                                    const hasAssistStep = panelSteps.some((step) => step.requiresParentAssist);
                                    const panelIngredients = getPanelIngredientVisuals(panelSteps, recipeDetail.ingredients);
                                    const panelSafetyEmojis = getPanelSafetyEmojis(panelSteps);
                                    const familyEmojis = storyboardFamilyGroups[panelIndex % storyboardFamilyGroups.length];
                                    const speechKey = `story_${recipe.id}_${panelIndex}`;
                                    const panelSpeechText = panelSteps
                                      .map((step) => {
                                        const stepNumber = recipeDetail.steps.findIndex((item) => item.id === step.id) + 1;
                                        return `第${stepNumber}步，${step.title}，${step.childAction || step.description}`;
                                      })
                                      .join('。');

                                    return (
                                      <article
                                        className={hasAssistStep ? 'storyboard-panel needs-assist' : 'storyboard-panel'}
                                        key={`${recipe.id}_story_${panelIndex}`}
                                      >
                                        <div className="storyboard-illustration" aria-hidden="true">
                                          <div className="storyboard-ingredient-emoji-row">
                                            {panelIngredients.map((ingredient) => (
                                              <span key={`${recipe.id}_${panelIndex}_${ingredient.name}`}>{ingredient.emoji}</span>
                                            ))}
                                          </div>
                                          <div className="storyboard-family-row">
                                            {familyEmojis.map((emoji, familyIndex) => (
                                              <span key={`${recipe.id}_${panelIndex}_family_${familyIndex}`} className="storyboard-character">
                                                {emoji}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                        <div className="storyboard-copy">
                                          <div className="storyboard-heading">
                                            <strong>图 {panelIndex + 1}</strong>
                                            <button
                                              type="button"
                                              className="step-speech-button"
                                              onClick={() => speakText(panelSpeechText, 'zh-CN', speechKey)}
                                              aria-label={`${activeSpeechKey === speechKey ? '停止朗读' : '朗读'}图解步骤 ${panelIndex + 1}`}
                                            >
                                              <PlayInlineIcon />
                                              {activeSpeechKey === speechKey ? '停止' : '朗读'}
                                            </button>
                                          </div>
                                          {panelIngredients.length > 0 ? (
                                            <div className="storyboard-ingredient-tags" aria-label="本步骤食材">
                                              {panelIngredients.map((ingredient) => (
                                                <span key={`${recipe.id}_${panelIndex}_${ingredient.name}_tag`}>
                                                  {ingredient.name}
                                                  <b aria-hidden="true">{ingredient.emoji}</b>
                                                </span>
                                              ))}
                                            </div>
                                          ) : null}
                                          <ol className="storyboard-caption-list">
                                            {panelSteps.map((step) => {
                                              const stepNumber = recipeDetail.steps.findIndex((item) => item.id === step.id) + 1;
                                              return (
                                                <li key={step.id} className={step.requiresParentAssist ? 'needs-assist' : undefined}>
                                                  <b>{stepNumber}</b>
                                                  <span>{summarizeStepCaption(step)}</span>
                                                </li>
                                              );
                                            })}
                                          </ol>
                                          {hasAssistStep ? (
                                            <p className="storyboard-safety">
                                              <span aria-hidden="true">{(panelSafetyEmojis.length ? panelSafetyEmojis : ['⚠️']).join(' ')}</span>
                                              热源、刀具或电器步骤请家长接手。
                                            </p>
                                          ) : null}
                                        </div>
                                      </article>
                                    );
                                  })}
                                </div>
                              </div>
                            </>
                          ) : recipeDetailLoadingById[recipe.id] ? (
                            <p className="muted compact-copy inline-loading-copy">
                              <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                              正在生成烹饪步骤...
                            </p>
                          ) : recipeDetailErrorsById[recipe.id] ? (
                            <div className="detail-error-block">
                              <strong>步骤获取失败</strong>
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
                                    正在重新获取...
                                  </>
                                ) : (
                                  '再次获取'
                                )}
                              </button>
                            </div>
                          ) : (
                            <div className="detail-error-block">
                              <strong>步骤准备中</strong>
                              <p>正在从缓存或大模型加载烹饪步骤，请稍候。</p>
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
                            {favoriteRecipes.some((item) => item.id === recipe.id) ? '已收藏' : '收藏'}
                          </button>
                        </div>
                      </article>
                      );
                    })}
                    </div>
                  </section>
                ) : null}
              </article>
              );
            })}
            <div ref={chatThreadEndRef} className="chat-thread-end" aria-hidden="true" />
          </div>

          {seasonalIngredientSuggestions.length > 0 ? (
            <div className="chat-suggestions" aria-label="季节食材推荐">
              {seasonalIngredientSuggestions.map((item) => {
                const visual = getIngredientVisual(item.name);
                const shouldShowEmoji = visual.name !== defaultIngredientVisual.name;

                return (
                  <button
                    key={`${item.name}_${item.reason}`}
                    type="button"
                    onClick={() => handleSeasonalIngredientClick(item)}
                    disabled={isRecognizingIngredients}
                    title={item.reason}
                  >
                    {shouldShowEmoji ? (
                      <span className="suggestion-emoji" role="img" aria-label={item.name}>
                        {visual.emoji}
                      </span>
                    ) : null}
                    <span>{item.name}</span>
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
              aria-label="语音输入"
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
              placeholder="按住说话或拍照取材"
              disabled={isRecognizingIngredients}
            />
            <button
              type="button"
              className="composer-icon-button"
              onClick={() => cameraImageInputRef.current?.click()}
              disabled={isUploadingImage || isRecognizingIngredients}
              aria-label="拍摄食材"
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
              aria-label="上传图片"
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
              aria-label="发送信息"
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
            aria-label="关闭菜名识字抽屉"
            onClick={closeLearningDrawer}
          />
          <aside className="learning-drawer" aria-label={`${learningRecipe.name} 菜名识字`}>
            <div className="drawer-header">
              <div>
                <p className="eyebrow">菜名识字</p>
                <h2>{learningRecipe.name}</h2>
                <p className="english-title">{learningRecipe.englishName}</p>
              </div>
              <button type="button" className="ghost-button" onClick={closeLearningDrawer}>
                关闭
              </button>
            </div>
            <div className="literacy-grid">
              {learningRecipe.nameLearning.characters.map((item) => (
                <button
                  key={`${learningRecipe.id}-${item.character}`}
                  type="button"
                  className="literacy-token"
                  onClick={() => speak(buildCharacterSpeech(item), 'zh-CN')}
                  aria-label={`播报汉字 ${item.character}`}
                >
                  <ruby className="literacy-ruby">
                    <span className="literacy-character">{item.character}</span>
                    <rp>(</rp>
                    <rt>{formatPinyin(item.pinyin)}</rt>
                    <rp>)</rp>
                  </ruby>
                  <span>{item.strokes} 画 · {item.structure}</span>
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
