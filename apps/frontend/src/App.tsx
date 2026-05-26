import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent, type TouchEvent } from 'react';
import { AppShell } from './components/AppShell';
import { RecipeName } from './components/RecipeName';
import audioPlayIcon from './assets/audio-play.svg';
import loadingIcon from './assets/loading.svg';
import newChatIcon from './assets/new-chat.svg';
import sendMessageIcon from './assets/send-message.svg';
import { defaultIngredientVisual, getIngredientVisual } from './data/ingredientVisuals';
import {
  fetchIngredientKnowledge,
  fetchSeasonalIngredientSuggestions,
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
const ingredientKnowledgeCacheStorageKey = 'murphy-cookbook.ingredient-knowledge-cache.v1';
const legacyRecipeDetailCacheStorageKey = 'murphy-cookbook.recipe-detail-cache.v1';
const localeStorageKey = 'murphy-cookbook.locale.v1';
const webCacheTtlMs = 3 * 24 * 60 * 60 * 1000;
const conversationProfileId = 'chat_context_profile';
const defaultChildContext =
  '默认服务对象为小学 1-6 年级学生。推荐原则：低油脂、轻口味、膳食均衡、维生素丰富、主食蛋白质蔬菜搭配均衡，避免高糖、高盐、油炸和过度辛辣。未明确提及重度急性过敏风险时，不主动要求补充儿童年龄、饮食偏好或过敏原。';
type FavoriteRecipesByProfile = Record<string, RecipeRecommendation[]>;
type TimedCache<T> = Record<string, { createdAt: string; expiresAt: string; data: T }>;
type AppLocale = 'zh' | 'en';

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

function buildRecommendationCacheKey(profile: ChildProfile, ingredientsKey: string) {
  return JSON.stringify({
    profileId: profile.id,
    age: profile.age,
    tastePreferences: profile.tastePreferences,
    allergens: profile.allergens,
    dietaryHabits: profile.dietaryHabits,
    ingredientsKey,
  });
}

function normalizeRecipeCacheText(value: string) {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function buildIngredientKnowledgeKey(name: string) {
  return normalizeRecipeCacheText(name);
}

function buildRecipeStepCacheKey(recipe: RecipeRecommendation, ingredients: IngredientItem[]) {
  return JSON.stringify({
    recipeName: normalizeRecipeCacheText(recipe.name),
    ingredientsKey: buildIngredientsKey(ingredients),
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
  const [recipeDetailStreamNodesById, setRecipeDetailStreamNodesById] = useState<Record<string, MessageNode[]>>({});
  const [recipeVideoGeneratedById, setRecipeVideoGeneratedById] = useState<Record<string, boolean>>({});
  const [recipeVideoLoadingById, setRecipeVideoLoadingById] = useState<Record<string, boolean>>({});
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
  const [locale, setLocale] = useState<AppLocale>(() => readLocale());
  const isRecognizingIngredients = isParsingText || isUploadingImage;
  const isEnglish = locale === 'en';

  const handleLocaleChange = (nextLocale: AppLocale) => {
    setLocale(nextLocale);
    persistLocale(nextLocale);
  };

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
    const stepCacheKey = buildRecipeStepCacheKey(recipe, nextIngredients);
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
      }, (event) => {
        patchRecipeDetailStreamNodes(recipe.id, event);
        const detailFromEvent = getRecipeDetailFromStreamEvent(event);
        if (detailFromEvent) {
          streamedDetail = detailFromEvent;
        }
        if (event.type === 'error') {
          streamErrorMessage = event.message;
        }
      });
      if (!streamedDetail && streamErrorMessage) {
        throw new Error(streamErrorMessage);
      }
      if (!streamedDetail) {
        throw new Error(streamErrorMessage || '菜谱步骤流式响应未返回有效卡片。');
      }
      const detail = normalizeCachedRecipeDetail(recipe, streamedDetail as RecipeDetail);
      setRecipeDetailsById((current) => ({ ...current, [recipe.id]: detail }));
      mergeRecipeDetailIntoCurrentSession(messageId, detail);
      writeCachedValue(recipeStepCacheStorageKey, stepCacheKey, detail);
    } catch (detailError) {
      const message = detailError instanceof Error ? detailError.message : '菜谱步骤获取失败。';
      setRecipeDetailErrorsById((current) => ({ ...current, [recipe.id]: message }));
      if (showToast) {
        setToastMessage(message === '接口数据响应超时' ? message : `${recipe.name} 步骤获取失败，请稍后重试。`);
      }
    } finally {
      setRecipeDetailLoadingById((current) => ({ ...current, [recipe.id]: false }));
    }
  };

  const handleIngredientKnowledgeClick = async (ingredient: IngredientItem) => {
    const knowledgeKey = buildIngredientKnowledgeKey(ingredient.normalizedName || ingredient.name);
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
      const knowledge = await fetchIngredientKnowledge(ingredient.normalizedName || ingredient.name);
      setIngredientKnowledgeByName((current) => ({ ...current, [knowledgeKey]: knowledge }));
      writeCachedValue(ingredientKnowledgeCacheStorageKey, knowledgeKey, knowledge);
    } catch (knowledgeError) {
      const message = knowledgeError instanceof Error ? knowledgeError.message : '食材知识获取失败。';
      setIngredientKnowledgeErrorsByName((current) => ({ ...current, [knowledgeKey]: message }));
      setToastMessage(`${ingredient.name} 知识卡片获取失败，请稍后重试。`);
    } finally {
      setIngredientKnowledgeLoadingByName((current) => ({ ...current, [knowledgeKey]: false }));
    }
  };

  const handleGenerateRecipeStepVideo = async (recipe: RecipeRecommendation) => {
    if (recipeVideoGeneratedById[recipe.id] || recipeVideoLoadingById[recipe.id]) {
      return;
    }

    setRecipeVideoLoadingById((current) => ({ ...current, [recipe.id]: true }));
    window.setTimeout(() => {
      setRecipeVideoGeneratedById((current) => ({ ...current, [recipe.id]: true }));
      setRecipeVideoLoadingById((current) => ({ ...current, [recipe.id]: false }));
      setToastMessage(`${recipe.name} 卡通步骤视频已生成`);
    }, 900);
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
      const recommendationCacheKey = buildRecommendationCacheKey(selectedProfile, ingredientsKey);
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
      }
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
      skipNextChatAutoScrollRef.current = true;
      const streamingRecipeMessage = addChatMessage({
        role: 'assistant',
        text: '正在生成菜谱推荐...',
        nodes: [{ id: 'recommendation_stream_intro', type: 'text', content: '' }],
        ingredientsKey,
        ingredients: nextIngredients,
      });
      let data = cachedRecommendation;
      let streamErrorMessage = '';
      if (!data) {
        await streamRecommendations(selectedProfile, nextIngredients, recommendationPrompt, (event) => {
          patchChatMessageNodes(streamingRecipeMessage.id, event);
          const streamData = getRecommendationDataFromStreamEvent(event);
          if (streamData) {
            data = streamData;
          }
          if (event.type === 'error') {
            streamErrorMessage = event.message;
          }
        });
      }
      if (!data && streamErrorMessage) {
        throw new Error(streamErrorMessage);
      }
      if (!data) {
        throw new Error(streamErrorMessage || '菜谱推荐流式响应未返回有效卡片。');
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
          message.id === streamingRecipeMessage.id
            ? {
                ...message,
                text: `根据${nextIngredients.map((item) => item.name).join('、')}，按小学阶段健康饮食原则推荐了 ${recipes.length} 道菜。`,
                recipes,
                recipeDetails,
              }
            : message,
        ),
      );
      setPendingIngredientMessageId(ingredientMessageId || streamingRecipeMessage.id);
      setManualIngredient('');
    } catch (recommendationError) {
      const message = recommendationError instanceof Error ? recommendationError.message : '推荐失败，请稍后重试。';
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
    await requestChatRecommendations('请根据当前已识别食材推荐菜谱', nextIngredients, sourceMessageId, true);
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
        locale={locale}
        onLocaleChange={handleLocaleChange}
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
                      <strong>{session.title}</strong>
                      <span>{session.childContext || '默认小学阶段健康饮食原则'}</span>
                    </button>
                    <button
                      type="button"
                      className="conversation-delete-button"
                      onClick={() => handleDeleteConversation(session.id)}
                      aria-label={`删除历史对话：${session.title}`}
                    >
                      {isEnglish ? 'Delete' : '删除'}
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
            aria-label="关闭菜谱收藏"
            onClick={() => setIsFavoriteDrawerOpen(false)}
          />
          <aside className="settings-drawer favorite-drawer" aria-label="菜谱收藏">
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
                    <RecipeName as="strong" name={recipe.name} pinyin={recipe.namePinyin} />
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
          <strong>当前提示</strong>
          <p>{error}</p>
        </div>
      ) : null}

      {toastMessage ? (
        <div className="toast-banner" role="status" aria-live="polite">
          {toastMessage}
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
              <button
                key={`tablet_${session.id}`}
                type="button"
                className={session.id === activeChatSessionId ? 'tablet-panel-item active' : 'tablet-panel-item'}
                onClick={() => handleSelectConversation(session)}
              >
                <strong>{session.title}</strong>
                <span>{session.childContext || (isEnglish ? 'Default healthy student profile' : '默认小学阶段健康饮食原则')}</span>
              </button>
            ))
          ) : (
            <p className="tablet-panel-empty">{isEnglish ? 'No chats yet' : '暂无历史对话'}</p>
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
              <button
                key={`tablet_favorite_${recipe.id}`}
                type="button"
                className="tablet-panel-item favorite"
                onClick={() => handleOpenFavoriteRecipe(recipe)}
              >
                <RecipeName as="strong" name={recipe.name} pinyin={recipe.namePinyin} />
                <span>{recipe.englishName} · {recipe.estimatedTimeMinutes} {isEnglish ? 'min' : '分钟'}</span>
              </button>
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
          <div className="kids-chat-hero" aria-label="儿童烹饪助手">
            <div className="mascot-badge" aria-hidden="true">
              <span className="mascot-chef-hat">▴</span>
              <span className="mascot-face">😊</span>
              <span className="mascot-spoon">🥄</span>
            </div>
            <div>
              <p className="eyebrow">{isEnglish ? 'KIDS COOKING BOT' : '儿童美食智能体'}</p>
              <h2>{isEnglish ? 'What ingredients should we turn into something delicious?' : '今天想把哪些食材变成好吃的？'}</h2>
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
                (ingredient) => buildIngredientKnowledgeKey(ingredient.normalizedName || ingredient.name) === activeIngredientKnowledgeKey,
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

              return (
              <article
                key={message.id}
                className={message.role === 'user' ? 'chat-message user' : 'chat-message assistant'}
                data-chat-message-id={message.id}
              >
                <div className="chat-bubble">
                  <div className="chat-bubble-content">
                    {message.nodes?.length ? <StreamNodesRenderer nodes={message.nodes} /> : <p>{message.text}</p>}
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

	                      return (
	                        <article
	                          key={`${message.id}_${ingredient.id}`}
	                          className={
	                            [
	                              isFallback ? 'chat-ingredient-card fallback' : 'chat-ingredient-card',
	                              buildIngredientKnowledgeKey(ingredient.normalizedName || ingredient.name) === activeIngredientKnowledgeKey
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
                          <span className="ingredient-pinyin">{visual.pinyin}</span>
                          <strong>{ingredient.name}</strong>
                          <div className="ingredient-emoji" role="img" aria-label={isFallback ? '默认食材占位' : ingredient.name}>
                            {visual.emoji}
                          </div>
                          <div className="ingredient-card-toolbar">
	                            <button
	                              type="button"
	                              className="ingredient-icon-button speech"
	                              onClick={(event) => {
	                                event.stopPropagation();
	                                speak(`${ingredient.name}，${visual.pinyin}`, 'zh-CN');
	                              }}
	                              aria-label={`朗读食材：${ingredient.name}`}
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
	                        <strong>{isEnglish ? 'Add more' : '添加食材'}</strong>
	                      </button>
	                    </div>
	                    {activeKnowledgeIngredient ? (
	                      <section className="ingredient-knowledge-card" aria-label={`${activeKnowledgeIngredient.name} 食材知识卡片`}>
	                        <div className="ingredient-knowledge-heading">
	                          <div>
	                            <p>{isEnglish ? 'Ingredient Notes' : '食材小百科'}</p>
	                            <strong>
	                              {activeKnowledgeIngredient.name}
	                              <span aria-hidden="true"> · {getIngredientVisual(activeKnowledgeIngredient.name).emoji}</span>
	                            </strong>
	                          </div>
	                          <button
	                            type="button"
	                            className="mini-speech-button"
	                            onClick={() => {
	                              const knowledgeText = activeIngredientKnowledge
	                                ? [
	                                    `${activeIngredientKnowledge.name}的营养价值：${activeIngredientKnowledge.nutritionValues.join('，')}`,
	                                    `产地：${activeIngredientKnowledge.origin}`,
	                                    `适宜气候：${activeIngredientKnowledge.growingClimate}`,
	                                    `最佳搭配：${activeIngredientKnowledge.bestPairings.join('、')}`,
	                                    activeIngredientKnowledge.kidFact,
	                                  ].join('。')
	                                : `${activeKnowledgeIngredient.name} 食材知识正在获取中`;
	                              speak(knowledgeText, 'zh-CN');
	                            }}
	                            aria-label={`朗读${activeKnowledgeIngredient.name}食材知识`}
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
                    aria-label="推荐菜谱走马灯"
                    aria-roledescription="carousel"
                  >
                    <div className="recipe-carousel-header">
                      <span>{isEnglish ? 'Recommended Recipes' : '推荐菜谱'}</span>
                      <b>{isEnglish ? `Swipe for ${message.recipes.length}` : `左右滑动查看 ${message.recipes.length} 道`}</b>
                    </div>
                    <div
                      className="recipe-carousel"
                      aria-label="推荐菜谱"
	                    >
	                    {message.recipes.map((recipe) => {
	                      const recipeDetail = recipeDetailsById[recipe.id];
	                      const riskAlertText = recipe.riskAlerts.slice(0, 2).join('；');
	                      const hasHighRiskAllergy = hasHighRiskAllergyAlert(riskAlertText, message.ingredients ?? ingredients);
	                      const hasGeneratedStepVideo = Boolean(recipeVideoGeneratedById[recipe.id]);
	                      const isGeneratingStepVideo = Boolean(recipeVideoLoadingById[recipe.id]);

	                      return (
                        <article
                          key={`${message.id}_${recipe.id}`}
                          className="carousel-recipe-card"
                          data-recipe-card-id={recipe.id}
                        >
                        <div className="recipe-card-kicker">
                          <span>{isEnglish ? 'Kid-friendly' : '儿童友好食谱'}</span>
                          {recipe.canCookWithCurrentIngredients ? <span className="fit-chip">{isEnglish ? 'Ready to cook' : '现有食材可做'}</span> : null}
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
                            <small>{isEnglish ? 'min' : '分钟'}</small>
                          </span>
                          <span>
                            <b>{formatRecipeDifficulty(recipe.difficulty)}</b>
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
                                  {isEnglish ? 'prep min' : '备料分钟'}
                                </span>
                                <span>
                                  <b>{recipeDetail.cookTimeMinutes}</b>
                                  {isEnglish ? 'cook min' : '烹饪分钟'}
                                </span>
                              </div>
                              <div className="inline-detail-block">
                                <div className="detail-block-heading">
                                  <strong>{isEnglish ? 'Ingredients' : '食材配料清单'}</strong>
                                  <span>{isEnglish ? 'Name / Amount' : '名称 / 用量'}</span>
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
	                                  <strong>{isEnglish ? 'Cartoon Cooking Video' : '卡通烹饪步骤视频'}</strong>
	                                  <span>{isEnglish ? 'Manual generation' : '手动生成'}</span>
	                                </div>
	                                <section className={hasGeneratedStepVideo ? 'recipe-video-panel generated' : 'recipe-video-panel'} aria-label={`${recipe.name} 卡通烹饪步骤视频`}>
	                                  <div className="recipe-video-placeholder" role="img" aria-label={`${recipe.name} 视频占位符`}>
	                                    <div className="video-sun" aria-hidden="true" />
	                                    <div className="video-family" aria-hidden="true">
	                                      <span>👩‍🍳</span>
	                                      <span>🧒</span>
	                                      <span>👨‍🍳</span>
	                                    </div>
	                                    <div className="video-ingredients" aria-hidden="true">
	                                      {recipeDetail.ingredients.slice(0, 4).map((ingredient) => {
	                                        const visual = getKnownIngredientVisual(ingredient.name);
	                                        return visual ? <span key={`${recipe.id}_video_${ingredient.name}`}>{visual.emoji}</span> : null;
	                                      })}
	                                    </div>
	                                    <p>
	                                      {hasGeneratedStepVideo
	                                        ? (isEnglish ? 'Warm cartoon cooking video preview' : '温暖卡通烹饪视频预览')
	                                        : (isEnglish ? 'Video placeholder, not generated yet' : '视频占位符，尚未生成')}
	                                    </p>
	                                    <strong>{recipeDetail.steps[0]?.title ?? recipe.name}</strong>
	                                  </div>
	                                  <div className="recipe-video-copy">
	                                    <p>{isEnglish ? 'Video length target: within 30 seconds. Captions follow the cooking steps below.' : '视频目标时长不超过 30 秒，画面字幕与下方步骤内容对应。'}</p>
	                                    <button
	                                      type="button"
	                                      className="secondary-button"
	                                      onClick={() => void handleGenerateRecipeStepVideo(recipe)}
	                                      disabled={hasGeneratedStepVideo || isGeneratingStepVideo}
	                                    >
	                                      {isGeneratingStepVideo ? (
	                                        <>
	                                          <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
	                                          {isEnglish ? 'Generating...' : '生成中...'}
	                                        </>
	                                      ) : hasGeneratedStepVideo ? (
	                                        (isEnglish ? 'Generated once' : '已生成一次')
	                                      ) : (
	                                        (isEnglish ? 'Generate Cartoon Video' : '生成卡通步骤视频')
	                                      )}
	                                    </button>
	                                  </div>
	                                </section>
	                              </div>
	                              <div className="inline-detail-block">
	                                <div className="detail-block-heading">
	                                  <strong>{isEnglish ? 'Cooking Steps' : '烹饪步骤'}</strong>
	                                  <span>{isEnglish ? 'Ordered details' : '按序号执行'}</span>
	                                </div>
	                                <ol className="recipe-step-timeline">
	                                  {recipeDetail.steps.map((step, stepIndex) => {
	                                    const speechKey = `step_${recipe.id}_${step.id}`;
	                                    const speechText = `第${stepIndex + 1}步，${step.title}。${step.description}。${step.tip}。${step.childAction ? `小朋友可以：${step.childAction}。` : ''}${step.requiresParentAssist ? `这一步需要家长协助：${step.parentAction}。` : ''}`;
	                                    return (
	                                      <li key={step.id} className={step.requiresParentAssist ? 'recipe-step-item needs-assist' : 'recipe-step-item'}>
	                                        <span className="step-index">{stepIndex + 1}</span>
	                                        <div className="step-body">
	                                          <div className="inline-step-heading">
	                                            <strong>{step.title}</strong>
	                                            <button
	                                              type="button"
	                                              className="step-speech-button"
	                                              onClick={() => speakText(speechText, 'zh-CN', speechKey)}
	                                              aria-label={`${activeSpeechKey === speechKey ? '停止朗读' : '朗读'}第${stepIndex + 1}步`}
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
                                    正在重新获取...
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
              placeholder={isEnglish ? 'Type ingredients or use voice/photo...' : '输入食材或用语音、拍照取材'}
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
