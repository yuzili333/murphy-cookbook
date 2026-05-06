import { useEffect, useRef, useState, type ChangeEvent, type TouchEvent } from 'react';
import { AppShell } from './components/AppShell';
import { IngredientThumb } from './components/IngredientThumb';
import { RecipeCard } from './components/RecipeCard';
import { RecipeName } from './components/RecipeName';
import { StepCard } from './components/StepCard';
import { ZoomableImage } from './components/ZoomableImage';
import audioPlayIcon from './assets/audio-play.svg';
import loadingIcon from './assets/loading.svg';
import newChatIcon from './assets/new-chat.svg';
import sendMessageIcon from './assets/send-message.svg';
import { quickIngredients } from './data/constants';
import { defaultIngredientVisual, getIngredientVisual } from './data/ingredientVisuals';
import {
  createChildProfile,
  fetchGeneratedRecipeDetail,
  fetchLlmLogs,
  fetchRecipeDetail,
  fetchRecommendations,
  fetchSeasonalIngredientSuggestions,
  parseIngredientText,
  submitCookingFeedback,
  uploadIngredientImage,
} from './lib/api';
import { buildCharacterSpeech, formatPinyin, speak, stopSpeaking } from './lib/speech';
import type {
  ChildProfile,
  CreateChildProfileInput,
  FeedbackResponse,
  IngredientItem,
  LlmLogEntry,
  PageId,
  RecipeDetail,
  RecipeRecommendation,
  SeasonalIngredientSuggestion,
} from './types';

const defaultTasteFeedback = '很好吃，番茄酸酸甜甜的。';
const defaultDifficultyFeedback = '煮面的时候有点难。';
const localProfilesStorageKey = 'murphy-cookbook.local-profiles.v1';
const recentCookedStorageKey = 'murphy-cookbook.recent-cooked.v1';
const favoriteRecipesStorageKey = 'murphy-cookbook.favorite-recipes.v1';
const chatMessagesStorageKey = 'murphy-cookbook.chat-messages.v1';
const likedRecipesStorageKey = 'murphy-cookbook.liked-recipes.v1';
const childContextStorageKey = 'murphy-cookbook.child-context.v1';
const chatSessionsStorageKey = 'murphy-cookbook.chat-sessions.v1';
const activeChatSessionStorageKey = 'murphy-cookbook.active-chat-session.v1';
const conversationProfileId = 'chat_context_profile';
const defaultChildContext =
  '默认服务对象为小学 1-6 年级学生。推荐原则：低油脂、轻口味、膳食均衡、维生素丰富、主食蛋白质蔬菜搭配均衡，避免高糖、高盐、油炸和过度辛辣。未明确提及重度急性过敏风险时，不主动要求补充儿童年龄、饮食偏好或过敏原。';
type RecentCookedByProfile = Record<string, RecipeDetail[]>;
type FavoriteRecipesByProfile = Record<string, RecipeRecommendation[]>;

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

function readLocalProfiles() {
  if (typeof window === 'undefined') {
    return [] as ChildProfile[];
  }

  try {
    const raw = window.localStorage.getItem(localProfilesStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as ChildProfile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistLocalProfiles(profiles: ChildProfile[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(localProfilesStorageKey, JSON.stringify(profiles));
}

function readRecentCookedRecipes() {
  if (typeof window === 'undefined') {
    return {} as RecentCookedByProfile;
  }

  try {
    const raw = window.localStorage.getItem(recentCookedStorageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as RecentCookedByProfile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistRecentCookedRecipes(recipes: RecentCookedByProfile) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(recentCookedStorageKey, JSON.stringify(recipes));
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistChatMessages(messages: ChatMessage[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(chatMessagesStorageKey, JSON.stringify(messages.slice(-40)));
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistChatSessions(sessions: ChatSession[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(chatSessionsStorageKey, JSON.stringify(sessions.slice(0, 30)));
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

function mergeRecentCookedRecipes(nextRecipe: RecipeDetail, currentRecipes: RecipeDetail[]) {
  const deduped = [nextRecipe, ...currentRecipes.filter((recipe) => recipe.id !== nextRecipe.id)];
  return deduped.slice(0, 8);
}

function mergeProfiles(remoteProfiles: ChildProfile[], localProfiles: ChildProfile[]) {
  const merged = new Map<string, ChildProfile>();

  for (const profile of [...remoteProfiles, ...localProfiles]) {
    merged.set(profile.id, profile);
  }

  return Array.from(merged.values());
}

function parseTagInput(value: string) {
  return value
    .split(/[，,、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  const ingredientSwipeRef = useRef({
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    isHorizontal: false,
  });
  const recipeSwipeRef = useRef({
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    isHorizontal: false,
  });

  const [page, setPage] = useState<PageId>('home');
  const [profiles, setProfiles] = useState<ChildProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [ingredients, setIngredients] = useState<IngredientItem[]>([]);
  const [recommendations, setRecommendations] = useState<RecipeRecommendation[]>([]);
  const [recentCookedByProfile, setRecentCookedByProfile] = useState<RecentCookedByProfile>({});
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
  const [childContext, setChildContext] = useState('');
  const [recipeDetailsById, setRecipeDetailsById] = useState<Record<string, RecipeDetail>>({});
  const [recipeDetailLoadingById, setRecipeDetailLoadingById] = useState<Record<string, boolean>>({});
  const [recipeDetailErrorsById, setRecipeDetailErrorsById] = useState<Record<string, string>>({});
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeDetail | null>(null);
  const [learningRecipe, setLearningRecipe] = useState<RecipeRecommendation | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [manualIngredient, setManualIngredient] = useState('');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [lastUploadMessage, setLastUploadMessage] = useState('');
  const [tasteFeedback, setTasteFeedback] = useState(defaultTasteFeedback);
  const [difficultyFeedback, setDifficultyFeedback] = useState(defaultDifficultyFeedback);
  const [feedback, setFeedback] = useState<FeedbackResponse | null>(null);
  const [localProfiles, setLocalProfiles] = useState<ChildProfile[]>([]);
  const [llmLogs, setLlmLogs] = useState<LlmLogEntry[]>([]);
  const [llmLogFile, setLlmLogFile] = useState('');
  const [logFilters, setLogFilters] = useState({
    start: '',
    end: '',
    keyword: '',
  });
  const [newProfileForm, setNewProfileForm] = useState({
    nickname: '',
    age: '8',
    tastePreferences: '',
    allergens: '',
    dietaryHabits: '',
  });
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isParsingText, setIsParsingText] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isListeningVoice, setIsListeningVoice] = useState(false);
  const [isFetchingRecommendations, setIsFetchingRecommendations] = useState(false);
  const [isFetchingDetail, setIsFetchingDetail] = useState(false);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [isFetchingLogs, setIsFetchingLogs] = useState(false);
  const [activeSpeechKey, setActiveSpeechKey] = useState('');
  const [error, setError] = useState('');
  const [toastMessage, setToastMessage] = useState('');
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

  const speakStep = (step: RecipeDetail['steps'][number]) => {
    speakText([
      step.title,
      step.childAction || step.description,
      step.tip ? `小贴士：${step.tip}` : '',
      step.requiresParentAssist
        ? step.parentAction || '这一步需要家长陪同完成。'
        : '这一步可以由孩子独立完成。',
      step.expectedResult ? `完成后应该看到：${step.expectedResult}` : '',
    ].filter(Boolean).join('。'), 'zh-CN', `step_${step.id}`);
  };

  const speakRecipeOverview = (recipe: RecipeDetail) => {
    const stepTitles = recipe.steps.map((step, index) => `第${index + 1}步，${step.title}`).join('；');
    speakText(`${recipe.name}。一共${recipe.steps.length}步。${stepTitles}。点击每一步的朗读按钮，可以继续听详细讲解。`);
  };

  const conversationProfile = buildConversationProfile(childContext);
  const selectedProfile = profiles.find((item) => item.id === selectedProfileId) ?? conversationProfile;
  const currentStep = selectedRecipe?.steps[stepIndex] ?? null;
  const lastChatMessageId = chatMessages.at(-1)?.id ?? '';

  const closeLearningDrawer = () => {
    stopSpeaking();
    setActiveSpeechKey('');
    setLearningRecipe(null);
  };

  const handleHorizontalTouchStart = (
    event: TouchEvent<HTMLDivElement>,
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
    event: TouchEvent<HTMLDivElement>,
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

  const handleIngredientTouchStart = (event: TouchEvent<HTMLDivElement>) =>
    handleHorizontalTouchStart(event, ingredientSwipeRef);
  const handleIngredientTouchMove = (event: TouchEvent<HTMLDivElement>) =>
    handleHorizontalTouchMove(event, ingredientSwipeRef);
  const handleIngredientTouchEnd = () => handleHorizontalTouchEnd(ingredientSwipeRef);
  const handleRecipeTouchStart = (event: TouchEvent<HTMLDivElement>) =>
    handleHorizontalTouchStart(event, recipeSwipeRef);
  const handleRecipeTouchMove = (event: TouchEvent<HTMLDivElement>) =>
    handleHorizontalTouchMove(event, recipeSwipeRef);
  const handleRecipeTouchEnd = () => handleHorizontalTouchEnd(recipeSwipeRef);

  useEffect(() => {
    async function bootstrap() {
      try {
        setError('');
        const localProfileData = readLocalProfiles();
        const localRecentCooked = readRecentCookedRecipes();
        const localFavoriteRecipes = readFavoriteRecipes();
        const localChatMessages = readChatMessages();
        const localLikedRecipeIds = readLikedRecipeIds();
        const localChildContext = readChildContext();
        const localChatSessions = readChatSessions();
        const localActiveChatSessionId = readActiveChatSessionId();
        setLocalProfiles(localProfileData);
        const mergedProfiles = mergeProfiles([], localProfileData);
        setProfiles(mergedProfiles);
        setSelectedProfileId((current) => current || conversationProfileId);
        setRecentCookedByProfile(localRecentCooked);
        setFavoriteRecipesByProfile(localFavoriteRecipes);
        setFavoriteRecipes(localFavoriteRecipes[conversationProfileId] ?? []);
        const initialSessions = localChatSessions.length > 0
          ? localChatSessions
          : [createChatSession({
              childContext: localChildContext,
              messages: localChatMessages.length > 0 ? localChatMessages : undefined,
              title: buildSessionTitle(localChatMessages, localChildContext),
            })];
        const activeSession =
          initialSessions.find((session) => session.id === localActiveChatSessionId) ?? initialSessions[0];
        setChatSessions(initialSessions);
        setActiveChatSessionId(activeSession.id);
        setChildContext(activeSession.childContext);
        setIngredients(activeSession.ingredients);
        setChatMessages(activeSession.messages);
        const activeRecipes = activeSession.messages.flatMap((message) => message.recipes ?? []).slice(-5);
        setRecommendations(activeRecipes);
        void fetchDetailsForRecipeCards(activeRecipes, activeSession.ingredients, buildConversationProfile(activeSession.childContext));
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
    if (selectedProfileId === conversationProfileId || profiles.some((profile) => profile.id === selectedProfileId)) {
      return;
    }

    setSelectedProfileId(conversationProfileId);
  }, [profiles, selectedProfileId]);

  useEffect(() => {
    let isCancelled = false;

    async function loadSeasonalIngredientSuggestions() {
      try {
        const data = await fetchSeasonalIngredientSuggestions(new Date().getMonth() + 1, childContext.trim() || defaultChildContext);
        if (!isCancelled) {
          setSeasonalIngredientSuggestions(data.suggestions.filter((item) => item.name).slice(0, 8));
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
    if (page !== 'home' || isBootstrapping) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      chatThreadEndRef.current?.scrollIntoView({
        block: 'end',
        behavior: 'smooth',
      });
    }, 80);

    return () => window.clearTimeout(timeoutId);
  }, [page, isBootstrapping, lastChatMessageId]);

  useEffect(() => {
    if (isBootstrapping || !activeChatSessionId) {
      return;
    }

    setChatSessions((current) => {
      const updatedAt = new Date().toISOString();
      const nextSession = createChatSession({
        id: activeChatSessionId,
        childContext,
        ingredients,
        messages: chatMessages,
        title: buildSessionTitle(chatMessages, childContext),
        createdAt: current.find((session) => session.id === activeChatSessionId)?.createdAt,
        updatedAt,
      });
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
    if (!pendingScrollRecipeId || page !== 'home') {
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
  }, [pendingScrollRecipeId, page, chatMessages]);

  const appendIngredients = (items: IngredientItem[]) => {
    setIngredients((current) => {
      return mergeIngredientItems(current, items);
    });
  };

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
    setRecommendations([]);
    setRecipeDetailsById({});
    setRecipeDetailLoadingById({});
    setRecipeDetailErrorsById({});
    setSelectedRecipe(null);
    setChatMessages(session.messages);
    setChatSessions((current) => {
      const next = [session, ...current.filter((item) => item.id !== session.id)];
      persistChatSessions(next);
      persistActiveChatSessionId(session.id);
      return next;
    });
    setIsConversationDrawerOpen(false);
    setPage('home');
  };

  const handleSelectConversation = (session: ChatSession) => {
    const sessionRecipes = session.messages.flatMap((message) => message.recipes ?? []).slice(-5);
    setActiveChatSessionId(session.id);
    setChildContext(session.childContext);
    setIngredients(session.ingredients);
    setChatMessages(session.messages);
    setRecommendations(sessionRecipes);
    setRecipeDetailsById({});
    setRecipeDetailLoadingById({});
    setRecipeDetailErrorsById({});
    setSelectedRecipe(null);
    void fetchDetailsForRecipeCards(sessionRecipes, session.ingredients, buildConversationProfile(session.childContext));
    persistActiveChatSessionId(session.id);
    setIsConversationDrawerOpen(false);
    setPage('home');
  };

  const handleOpenFavoriteRecipe = (recipe: RecipeRecommendation) => {
    const matchedSession =
      chatSessions.find((session) =>
        session.messages.some((message) => message.recipes?.some((item) => item.id === recipe.id)),
      ) ?? null;

    if (matchedSession) {
      handleSelectConversation(matchedSession);
    } else {
      setPage('home');
    }

    setIsFavoriteDrawerOpen(false);
    setPendingScrollRecipeId(recipe.id);
  };

  const fetchDetailsForRecipeCards = async (
    recipes: RecipeRecommendation[],
    nextIngredients: IngredientItem[],
    profile: ChildProfile = selectedProfile,
  ) => {
    if (!profile) {
      return;
    }

    setIsFetchingDetail(true);
    try {
      await Promise.all(recipes.map((recipe) => fetchRecipeDetailForCard(recipe, nextIngredients, profile, true)));
    } finally {
      setIsFetchingDetail(false);
    }
  };

  const fetchRecipeDetailForCard = async (
    recipe: RecipeRecommendation,
    nextIngredients: IngredientItem[] = ingredients,
    profile: ChildProfile = selectedProfile,
    showToast = true,
  ) => {
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
      setRecipeDetailsById((current) => ({
        ...current,
        [recipe.id]: detail,
        [detail.id]: detail,
      }));
    } catch (detailError) {
      const message = detailError instanceof Error ? detailError.message : '菜谱详情获取失败。';
      setRecipeDetailErrorsById((current) => ({ ...current, [recipe.id]: message }));
      if (showToast) {
        setToastMessage(`${recipe.name} 详情获取失败，请稍后重试。`);
      }
    } finally {
      setRecipeDetailLoadingById((current) => ({ ...current, [recipe.id]: false }));
    }
  };

  const requestChatRecommendations = async (prompt: string, nextIngredients: IngredientItem[]) => {
    if (nextIngredients.length === 0) {
      addChatMessage({
        role: 'assistant',
        text: '我还没有识别到可用食材。你可以输入“鸡蛋、番茄、黄瓜”，或直接拍一张食材照片。',
      });
      return;
    }

    const ingredientsKey = buildIngredientsKey(nextIngredients);
    setIsFetchingRecommendations(true);
    setError('');

    try {
      const recommendationPrompt = [
        `儿童情况：${childContext.trim() || defaultChildContext}`,
        `用户本轮输入：${prompt}`,
      ].join('\n');
      const data = await fetchRecommendations(selectedProfile, nextIngredients, recommendationPrompt);
      const recipes = data.recipes;
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
      setRecommendations(recipes);
      setRecipeDetailsById({});
      setRecipeDetailLoadingById({});
      setRecipeDetailErrorsById({});
      void fetchDetailsForRecipeCards(recipes, nextIngredients);
      addChatMessage({
        role: 'assistant',
        text: `根据${nextIngredients.map((item) => item.name).join('、')}，按小学阶段健康饮食原则推荐了 ${recipes.length} 道菜。`,
        ingredientsKey,
        recipes,
      });
      setManualIngredient('');
      setVoiceTranscript(prompt);
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

  const handleManualParse = async () => {
    if (!manualIngredient.trim()) return;

    try {
      setIsParsingText(true);
      setError('');
      const data = await parseIngredientText(manualIngredient);
      appendIngredients(data.ingredients);
      setManualIngredient('');
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : '食材解析失败。');
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
      setLastUploadMessage(`已上传图片 ${data.upload.filename}，识别到 ${data.ingredients.length} 项食材。`);
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
        setLastUploadMessage('正在调用系统麦克风，请开始说出食材名称。');
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

        setVoiceTranscript(transcript);
        setLastUploadMessage('语音识别完成，正在解析食材。');

        try {
          await handleChatSubmit(transcript);
          setLastUploadMessage(`语音识别成功：${transcript}`);
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

  const removeIngredient = (id: string) => {
    setIngredients((current) => current.filter((item) => item.id !== id));
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

  const handleSearchWithCurrentIngredients = async (sourceIngredients?: IngredientItem[]) => {
    const nextIngredients = ingredients.length > 0 ? ingredients : sourceIngredients ?? [];
    if (nextIngredients.length > 10) {
      setError('一次最多支持 10 个食材，请减少食材后再获取推荐菜谱。');
      addChatMessage({
        role: 'assistant',
        text: '一次最多支持 10 个食材。请先减少食材数量，再获取推荐菜谱。',
      });
      return;
    }

    setIngredients((current) => mergeIngredientItems(current, sourceIngredients ?? []));
    await requestChatRecommendations('请根据当前已识别食材推荐菜谱', nextIngredients);
  };

  const fetchRecipeAndOpen = async (recipeOrId: string | RecipeRecommendation) => {
    const id = typeof recipeOrId === 'string' ? recipeOrId : recipeOrId.id;
    const cachedRecipe =
      recipeDetailsById[id] ??
      Object.values(recentCookedByProfile)
        .flat()
        .find((recipe) => recipe.id === id);

    if (cachedRecipe) {
      setSelectedRecipe(cachedRecipe);
      setStepIndex(0);
      setPage('detail');
      return;
    }

    try {
      setIsFetchingDetail(true);
      setError('');
      const recommendedRecipe =
        typeof recipeOrId === 'string'
          ? recommendations.find((item) => item.id === id) ?? null
          : recipeOrId;
      const recipe =
        recommendedRecipe && selectedProfile
          ? await fetchGeneratedRecipeDetail({
              profileId: selectedProfile.id,
              profile: selectedProfile,
              ingredients,
              recipe: recommendedRecipe,
            })
          : await fetchRecipeDetail(id);

      setRecipeDetailsById((current) => ({
        ...current,
        [recipe.id]: recipe,
      }));
      setSelectedRecipe(recipe);
      setStepIndex(0);
      setPage('detail');
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : '菜谱详情加载失败。');
    } finally {
      setIsFetchingDetail(false);
    }
  };

  const handleGetRecommendations = async () => {
    try {
      setIsFetchingRecommendations(true);
      setError('');
      const data = await fetchRecommendations(selectedProfile, ingredients);
      setRecommendations(data.recipes);
      setPage('recipes');
    } catch (recommendationError) {
      setError(recommendationError instanceof Error ? recommendationError.message : '推荐失败，请稍后重试。');
    } finally {
      setIsFetchingRecommendations(false);
    }
  };

  const handleCreateProfile = async () => {
    const nickname = newProfileForm.nickname.trim();
    const age = Number(newProfileForm.age);

    if (!nickname || !Number.isFinite(age) || age <= 0) {
      setError('请填写正确的儿童昵称和年龄。');
      return;
    }

    const payload: CreateChildProfileInput = {
      nickname,
      age,
      tastePreferences: parseTagInput(newProfileForm.tastePreferences),
      allergens: parseTagInput(newProfileForm.allergens),
      dietaryHabits: parseTagInput(newProfileForm.dietaryHabits),
    };

    const localProfile: ChildProfile = {
      id: `local_profile_${crypto.randomUUID()}`,
      ...payload,
    };

    try {
      setIsCreatingProfile(true);
      setError('');

      let createdProfile = localProfile;

      try {
        createdProfile = await createChildProfile(payload);
      } catch {
        // Netlify Functions is stateless for in-memory profiles. Keep a local profile fallback.
      }

      const nextLocalProfiles = createdProfile.id.startsWith('local_profile_')
        ? [...localProfiles, createdProfile]
        : localProfiles;

      if (createdProfile.id.startsWith('local_profile_')) {
        setLocalProfiles(nextLocalProfiles);
        persistLocalProfiles(nextLocalProfiles);
      }

      const mergedProfiles = mergeProfiles(
        profiles.filter((profile) => !profile.id.startsWith('local_profile_')),
        nextLocalProfiles.length > 0 ? nextLocalProfiles : localProfiles,
      );

      if (!mergedProfiles.some((profile) => profile.id === createdProfile.id)) {
        mergedProfiles.push(createdProfile);
      }

      setProfiles(mergedProfiles);
      setSelectedProfileId(createdProfile.id);
      setNewProfileForm({
        nickname: '',
        age: '8',
        tastePreferences: '',
        allergens: '',
        dietaryHabits: '',
      });
      setPage('input');
    } finally {
      setIsCreatingProfile(false);
    }
  };

  const handleSubmitFeedback = async () => {
    if (!selectedProfileId || !selectedProfile || !selectedRecipe) return;

    try {
      setIsSubmittingFeedback(true);
      setError('');
      const result = await submitCookingFeedback({
        profileId: selectedProfileId,
        profile: selectedProfile,
        recipeId: selectedRecipe.id,
        recipe: selectedRecipe,
        tasteFeedback,
        difficultyFeedback,
      });
      setFeedback(result);
    } catch (feedbackError) {
      setError(feedbackError instanceof Error ? feedbackError.message : '点评生成失败。');
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  const saveRecentCookedRecipe = (recipe: RecipeDetail) => {
    if (!selectedProfileId) {
      return;
    }

    setRecentCookedByProfile((current) => {
      const nextGroup = mergeRecentCookedRecipes(recipe, current[selectedProfileId] ?? []);
      const next = {
        ...current,
        [selectedProfileId]: nextGroup,
      };
      persistRecentCookedRecipes(next);
      return next;
    });
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
      return next;
    });
  };

  const removeFavoriteRecipe = (recipeId: string) => {
    if (!selectedProfileId) {
      return;
    }

    setFavoriteRecipesByProfile((current) => {
      const next = {
        ...current,
        [selectedProfileId]: (current[selectedProfileId] ?? []).filter((item) => item.id !== recipeId),
      };
      persistFavoriteRecipes(next);
      return next;
    });
  };

  const clearFavoriteRecipes = () => {
    if (!selectedProfileId) {
      return;
    }

    setFavoriteRecipesByProfile((current) => {
      const next = {
        ...current,
        [selectedProfileId]: [],
      };
      persistFavoriteRecipes(next);
      return next;
    });
  };

  const handleFetchLogs = async () => {
    try {
      setIsFetchingLogs(true);
      setError('');
      const data = await fetchLlmLogs({
        start: logFilters.start ? new Date(logFilters.start).toISOString() : undefined,
        end: logFilters.end ? new Date(logFilters.end).toISOString() : undefined,
        keyword: logFilters.keyword.trim() || undefined,
        limit: 200,
      });
      setLlmLogs(data.items);
      setLlmLogFile(data.logFile);
    } catch (logError) {
      setError(logError instanceof Error ? logError.message : '日志读取失败。');
    } finally {
      setIsFetchingLogs(false);
    }
  };

  if (isBootstrapping) {
    return (
      <AppShell
        currentPage="home"
        onNavigate={setPage}
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
      currentPage={page}
      onNavigate={setPage}
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
              {chatSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={session.id === activeChatSessionId ? 'conversation-item active' : 'conversation-item'}
                  onClick={() => handleSelectConversation(session)}
                >
                  <strong>{session.title}</strong>
                  <span>{session.childContext || '默认小学阶段健康饮食原则'}</span>
                </button>
              ))}
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

      {page === 'home' ? (
        <section className="chatbox-page">
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
              <article key={message.id} className={message.role === 'user' ? 'chat-message user' : 'chat-message assistant'}>
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
                {message.ingredients?.length ? (
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
                        onClick={() => void handleSearchWithCurrentIngredients(message.ingredients)}
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
                  <div
                    className="recipe-carousel"
                    aria-label="推荐菜谱"
                    onTouchStart={handleRecipeTouchStart}
                    onTouchMove={handleRecipeTouchMove}
                    onTouchEnd={handleRecipeTouchEnd}
                    onTouchCancel={handleRecipeTouchEnd}
                  >
                    {message.recipes.map((recipe) => {
                      const recipeDetail = recipeDetailsById[recipe.id];
                      const fitReasonText = recipe.fitReasons.slice(0, 2).join('；');
                      const extraIngredientText = recipe.extraIngredients.slice(0, 4).join('、');
                      const riskAlertText = recipe.riskAlerts.slice(0, 2).join('；');

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
                            <b>{recipe.difficulty}</b>
                            <small>难度</small>
                          </span>
                          <span>
                            <b>{recipe.ageRange}</b>
                            <small>适合年龄</small>
                          </span>
                        </div>
                        <div className="recipe-note-grid">
                          <section className="recipe-note-panel">
                            <div className="note-panel-heading">
                              <strong>适配原因</strong>
                              <button
                                type="button"
                                className="mini-speech-button"
                                onClick={() => speak(`适配原因：${fitReasonText}`, 'zh-CN')}
                                aria-label="朗读适配原因"
                              >
                                <PlayInlineIcon />
                              </button>
                            </div>
                            <p>{fitReasonText}</p>
                          </section>
                          {recipe.extraIngredients.length > 0 ? (
                            <section className="recipe-note-panel">
                              <div className="note-panel-heading">
                                <strong>补充食材</strong>
                                <button
                                  type="button"
                                  className="mini-speech-button"
                                  onClick={() => speak(`补充食材：${extraIngredientText}`, 'zh-CN')}
                                  aria-label="朗读补充食材"
                                >
                                  <PlayInlineIcon />
                                </button>
                              </div>
                              <p>{extraIngredientText}</p>
                            </section>
                          ) : null}
                          {recipe.riskAlerts.length > 0 ? (
                            <section className="recipe-note-panel warning">
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
                                      <span className="ingredient-name">{ingredient.name}</span>
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
                                  <strong>详尽烹饪步骤</strong>
                                  <span>逐步执行</span>
                                </div>
                                <ol className="recipe-step-timeline">
                                  {recipeDetail.steps.map((step, index) => (
                                    <li
                                      key={step.id}
                                      className={step.requiresParentAssist ? 'recipe-step-item needs-assist' : 'recipe-step-item'}
                                    >
                                      <span className="step-index">{index + 1}</span>
                                      <div className="step-body">
                                        <div className="inline-step-heading">
                                          <b>{step.title}</b>
                                          <button
                                            type="button"
                                            className="step-speech-button"
                                            onClick={() => speakStep(step)}
                                            aria-label={`${activeSpeechKey === `step_${step.id}` ? '停止朗读' : '朗读'}步骤：${step.title}`}
                                          >
                                            <PlayInlineIcon />
                                            {activeSpeechKey === `step_${step.id}` ? '停止' : '朗读'}
                                          </button>
                                        </div>
                                        <p>{step.childAction || step.description}</p>
                                        {step.expectedResult ? (
                                          <p className="step-result">
                                            <b>完成状态</b>
                                            {step.expectedResult}
                                          </p>
                                        ) : null}
                                        {step.tip ? (
                                          <p className="step-note">
                                            <b>小贴士</b>
                                            {step.tip}
                                          </p>
                                        ) : null}
                                        {step.requiresParentAssist ? (
                                          <p className="step-safety">
                                            <b>注意事项</b>
                                            {step.parentAction || '这一步需要家长陪同完成。'}
                                          </p>
                                        ) : null}
                                      </div>
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            </>
                          ) : recipeDetailErrorsById[recipe.id] ? (
                            <div className="detail-error-block">
                              <strong>详情获取失败</strong>
                              <p>{recipeDetailErrorsById[recipe.id]}</p>
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => void fetchRecipeDetailForCard(recipe)}
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
                            <p className="muted compact-copy inline-loading-copy">
                              {recipeDetailLoadingById[recipe.id] || isFetchingDetail ? <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" /> : null}
                              {recipeDetailLoadingById[recipe.id] || isFetchingDetail ? '正在生成内容...' : '内容加载中...'}
                            </p>
                          )}
                        </div>
                        <div className="carousel-actions single-action">
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => toggleFavoriteRecipe(recipe)}
                          >
                            {favoriteRecipes.some((item) => item.id === recipe.id) ? '已收藏' : '收藏'}
                          </button>
                        </div>
                      </article>
                      );
                    })}
                  </div>
                ) : null}
              </article>
              );
            })}
            <div ref={chatThreadEndRef} className="chat-thread-end" aria-hidden="true" />
          </div>

          {seasonalIngredientSuggestions.length > 0 ? (
            <div className="chat-suggestions" aria-label="季节食材推荐">
              {seasonalIngredientSuggestions.map((item) => (
                <button
                  key={`${item.name}_${item.reason}`}
                  type="button"
                  onClick={() => void handleChatSubmit(item.name)}
                  disabled={isRecognizingIngredients}
                  title={item.reason}
                >
                  {item.name}
                </button>
              ))}
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
      ) : null}

      {page === 'profile' ? (
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">儿童档案</p>
            <h2>选择当前要推荐的孩子</h2>
            <div className="stack-list">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={profile.id === selectedProfileId ? 'list-button active-step' : 'list-button'}
                  onClick={() => setSelectedProfileId(profile.id)}
                >
                  <strong>{profile.nickname} · {profile.age} 岁</strong>
                  <span>过敏原：{profile.allergens.join('、')} | 饮食习惯：{profile.dietaryHabits.join('、')}</span>
                </button>
              ))}
            </div>
            <div className="panel-subsection">
              <h3>新增儿童档案</h3>
              <div className="field-grid">
                <div className="field">
                  <label>昵称</label>
                  <input
                    placeholder="例如：小米"
                    value={newProfileForm.nickname}
                    onChange={(event) => setNewProfileForm((current) => ({ ...current, nickname: event.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>年龄</label>
                  <input
                    inputMode="numeric"
                    placeholder="例如：8"
                    value={newProfileForm.age}
                    onChange={(event) => setNewProfileForm((current) => ({ ...current, age: event.target.value }))}
                  />
                </div>
              </div>
              <div className="field">
                <label>口味偏好</label>
                <input
                  placeholder="例如：清淡、喜欢鸡蛋、喜欢面食"
                  value={newProfileForm.tastePreferences}
                  onChange={(event) =>
                    setNewProfileForm((current) => ({ ...current, tastePreferences: event.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>过敏原</label>
                <input
                  placeholder="例如：花生、牛奶"
                  value={newProfileForm.allergens}
                  onChange={(event) => setNewProfileForm((current) => ({ ...current, allergens: event.target.value }))}
                />
              </div>
              <div className="field">
                <label>饮食习惯</label>
                <input
                  placeholder="例如：低盐、不吃辣"
                  value={newProfileForm.dietaryHabits}
                  onChange={(event) =>
                    setNewProfileForm((current) => ({ ...current, dietaryHabits: event.target.value }))
                  }
                />
              </div>
            </div>
            <div className="action-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleCreateProfile()}
                disabled={isCreatingProfile}
              >
                {isCreatingProfile ? (
                  <>
                    <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                    保存中...
                  </>
                ) : (
                  '新增并使用这个档案'
                )}
              </button>
              <button type="button" className="primary-button" onClick={() => setPage('input')}>
                确认并继续
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {page === 'favorites' ? (
        <section className="page-grid">
          <div className="panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">菜谱收藏</p>
                <h2>{selectedProfile?.nickname ?? '当前孩子'} 的收藏菜谱</h2>
                <p className="muted">收藏保存在当前设备本地缓存，可反复打开和复用。</p>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={clearFavoriteRecipes}
                disabled={favoriteRecipes.length === 0}
              >
                清空收藏
              </button>
            </div>

            <div className="stack-list">
              {favoriteRecipes.length > 0 ? (
                favoriteRecipes.map((recipe) => (
                  <div key={recipe.id} className="list-item static">
                    <div>
                      <RecipeName as="strong" name={recipe.name} pinyin={recipe.namePinyin} />
                      <span>{recipe.difficulty} · {recipe.estimatedTimeMinutes} 分钟 · {recipe.ageRange}</span>
                    </div>
                    <div className="action-row">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => void fetchRecipeAndOpen(recipe)}
                      >
                        查看详情
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => removeFavoriteRecipe(recipe.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <strong>当前档案还没有收藏菜谱</strong>
                  <p>先去推荐页收藏喜欢的菜谱，这里会保留本地收藏记录。</p>
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {page === 'input' ? (
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">食材输入</p>
            <h2>优先适配手机与 pad 的输入方式</h2>
            <div className="upload-panel">
              <button
                type="button"
                className="fake-upload fake-upload-button"
                onClick={() => cameraImageInputRef.current?.click()}
                disabled={isUploadingImage}
              >
                {isUploadingImage ? (
                  <>
                    <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                    上传图片中...
                  </>
                ) : (
                  '拍摄食材图片'
                )}
              </button>
              <button
                type="button"
                className="fake-upload fake-upload-button"
                onClick={() => fileImageInputRef.current?.click()}
                disabled={isUploadingImage}
              >
                {isUploadingImage ? (
                  <>
                    <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                    上传图片中...
                  </>
                ) : (
                  '选择本地图片'
                )}
              </button>
              <button
                type="button"
                className="fake-upload fake-upload-button"
                onClick={() => void handleStartVoiceInput()}
                disabled={isListeningVoice}
              >
                {isListeningVoice ? '正在语音识别…' : '开始语音输入'}
              </button>
            </div>

            {lastUploadMessage ? (
              <div className="tip-card compact-card">
                <strong>最近一次上传</strong>
                <p>{lastUploadMessage}</p>
              </div>
            ) : null}

            {voiceTranscript ? (
              <div className="tip-card compact-card">
                <strong>语音转写结果</strong>
                <p>{voiceTranscript}</p>
              </div>
            ) : null}

            <div className="field">
              <label>文本输入</label>
              <div className="inline-input">
                <input
                  placeholder="例如：两个鸡蛋 一个番茄 半根黄瓜"
                  value={manualIngredient}
                  onChange={(event) => setManualIngredient(event.target.value)}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleManualParse()}
                  disabled={isParsingText}
                >
                  {isParsingText ? (
                    <>
                      <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                      解析中...
                    </>
                  ) : (
                    '解析'
                  )}
                </button>
              </div>
            </div>

            <div className="chip-row">
              {quickIngredients.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="chip-button"
                  onClick={() =>
                    appendIngredients([
                      {
                        id: `ing_quick_${item}_${crypto.randomUUID()}`,
                        name: item,
                        normalizedName: item,
                        quantity: '1份',
                        source: 'manual',
                      },
                    ])
                  }
                >
                  + {item}
                </button>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">当前食材清单</p>
                <h3>{ingredients.length} 项待确认</h3>
              </div>
              <span className="chip">档案：{selectedProfile?.nickname ?? '未选择'}</span>
            </div>
            <div className="stack-list">
              {ingredients.length > 0 ? (
                ingredients.map((ingredient) => (
                  <div key={ingredient.id} className="list-item">
                    <div className="ingredient-listing">
                      <IngredientThumb name={ingredient.name} />
                      <div>
                        <strong>{ingredient.name}</strong>
                        <span>{ingredient.quantity} · 来源 {ingredient.source}</span>
                      </div>
                    </div>
                    <button type="button" className="ghost-button" onClick={() => removeIngredient(ingredient.id)}>
                      删除
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <strong>还没有食材</strong>
                  <p>先从图片、录音或文本输入一种食材，才能进入下一步。</p>
                </div>
              )}
            </div>
            <div className="action-row sticky-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => setPage('confirm')}
                disabled={ingredients.length === 0}
              >
                继续确认识别结果
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {page === 'confirm' ? (
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">识别确认</p>
            <h2>确认这些食材后再开始推荐</h2>
            <div className="stack-list">
              {ingredients.map((ingredient) => (
                <div key={ingredient.id} className="list-item">
                  <div className="ingredient-listing">
                    <IngredientThumb name={ingredient.name} />
                    <div>
                      <strong>{ingredient.name}</strong>
                      <span>{ingredient.quantity}</span>
                    </div>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => removeIngredient(ingredient.id)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
            <div className="alert-box soft">
              <strong>提示</strong>
              <p>这一步会把最终确认后的食材发送到真实后端推荐接口。文本与视觉理解使用 SiliconFlow 的 Qwen 模型。</p>
            </div>
            <div className="action-row sticky-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleGetRecommendations()}
                disabled={ingredients.length === 0 || isFetchingRecommendations}
              >
                {isFetchingRecommendations ? (
                  <>
                    <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                    推荐中...
                  </>
                ) : (
                  '开始推荐菜谱'
                )}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {page === 'recipes' ? (
        <section className="page-grid">
          <div className="panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">推荐结果</p>
                <h2>推荐给 {selectedProfile?.nickname ?? '孩子'} 的儿童菜谱</h2>
              </div>
              <span className="chip">真实接口返回</span>
            </div>
            <div className="alert-box soft">
              <strong>过敏原过滤已生效</strong>
              <p>已自动排除包含 {selectedProfile?.allergens.join('、') ?? '过敏原'} 的菜谱。</p>
            </div>
            <div className="recipe-list">
              {recommendations.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
                  recipe={recipe}
                  onSelect={(id) => void fetchRecipeAndOpen(id)}
                  onOpenLearning={setLearningRecipe}
                  onToggleFavorite={toggleFavoriteRecipe}
                  isFavorite={favoriteRecipes.some((item) => item.id === recipe.id)}
                />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {page === 'detail' ? (
        <section className="page-grid">
          <div className="panel hero-detail">
            <p className="eyebrow">菜谱详情</p>
            {isFetchingDetail || !selectedRecipe ? (
              <h2 className="loading-heading">
                <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                正在加载菜谱详情...
              </h2>
            ) : (
              <>
                <ZoomableImage className="detail-hero-image" src={selectedRecipe.imageUrl} alt={selectedRecipe.name} />
                <div className="detail-name-group">
                  <button
                    type="button"
                    className="name-audio-button detail-chinese-name"
                    onClick={() => setLearningRecipe(selectedRecipe)}
                    aria-label={`打开菜名识字抽屉：${selectedRecipe.name}`}
                  >
                    <RecipeName as="span" name={selectedRecipe.name} pinyin={selectedRecipe.namePinyin} />
                  </button>
                  <button
                    type="button"
                    className="name-audio-button english-name"
                    onClick={() => speak(selectedRecipe.englishName, 'en-US')}
                    aria-label={`Read English recipe name: ${selectedRecipe.englishName}`}
                  >
                    {selectedRecipe.englishName}
                  </button>
                </div>
                <p className="muted">
                  {selectedRecipe.ageRange} · {selectedRecipe.difficulty} · 准备 {selectedRecipe.prepTimeMinutes} 分钟 · 制作 {selectedRecipe.cookTimeMinutes} 分钟
                </p>
                <div className="action-row">
                  <button type="button" className="secondary-button" onClick={() => speakRecipeOverview(selectedRecipe)}>
                    语音介绍整道菜
                  </button>
                </div>
                <div className="chip-row">
                  {selectedRecipe.fitReasons.map((reason) => (
                    <span key={reason} className="chip fit-chip">
                      {reason}
                    </span>
                  ))}
                </div>
                <div className="info-block">
                  <h3>营养摘要</h3>
                  <p>{selectedRecipe.nutritionSummary}</p>
                </div>
                <div className="alert-box">
                  <strong>安全提醒</strong>
                  <ul>
                    {selectedRecipe.riskAlerts.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="panel-subsection">
                  <h3>食材与用量</h3>
                  <div className="stack-list compact-list">
                    {selectedRecipe.ingredients.map((ingredient) => (
                      <div key={`${selectedRecipe.id}-${ingredient.name}`} className="list-item static">
                        <div className="ingredient-listing">
                          <ZoomableImage className="ingredient-thumb" src={ingredient.imageUrl} alt={ingredient.name} />
                          <div>
                            <strong>{ingredient.name}</strong>
                            <span>{ingredient.quantity}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="panel-subsection">
                  <h3>步骤预览</h3>
                  <ol className="step-preview">
                    {selectedRecipe.steps.map((step) => (
                      <li key={step.id}>
                        <strong>{step.title}</strong>
                        <p>{step.description}</p>
                        <p className="muted">{step.childAction || '按提示一步一步做，先慢一点再继续。'}</p>
                        <p className="muted">{step.expectedResult || '完成后看一看食材颜色和状态有没有变化。'}</p>
                        <div className="action-row compact-list">
                          <button type="button" className="ghost-button" onClick={() => speakStep(step)}>
                            {activeSpeechKey === `step_${step.id}` ? '停止朗读' : '朗读这一步'}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setStepIndex(0);
                    setPage('cooking');
                  }}
                >
                  开始制作
                </button>
              </>
            )}
          </div>
        </section>
      ) : null}

      {page === 'cooking' && selectedRecipe && currentStep ? (
        <section className="page-grid">
          <div className="panel cooking-panel">
            <StepCard
              step={currentStep}
              index={stepIndex}
              total={selectedRecipe.steps.length}
              onSpeak={speakStep}
              activeSpeechKey={activeSpeechKey}
              embedded
            />
            <p className="eyebrow">烹饪进度</p>
            <div className="progress-bar" aria-hidden="true">
              <div
                className="progress-fill"
                style={{
                  width: `${((stepIndex + 1) / selectedRecipe.steps.length) * 100}%`,
                }}
              />
            </div>
            <div className="stack-list compact-step-list">
              {selectedRecipe.steps.map((step, index) => (
                <div
                  key={step.id}
                  className={index === stepIndex ? 'list-item active-step' : 'list-item static'}
                >
                  <strong>{step.title}</strong>
                  <span>{step.requiresParentAssist ? '需家长陪同' : '可独立完成'}</span>
                </div>
              ))}
            </div>
            <div className="action-row sticky-actions cooking-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
                disabled={stepIndex === 0}
              >
                上一步
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  if (stepIndex < selectedRecipe.steps.length - 1) {
                    setStepIndex((current) => current + 1);
                    return;
                  }

                  saveRecentCookedRecipe(selectedRecipe);
                  setFeedback(null);
                  setPage('feedback');
                }}
              >
                {stepIndex === selectedRecipe.steps.length - 1 ? '完成并点评' : '下一步'}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {page === 'feedback' && selectedRecipe ? (
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">成果点评</p>
            <h2>
              {selectedProfile?.nickname ?? '孩子'} 完成了 <RecipeName as="span" name={selectedRecipe.name} pinyin={selectedRecipe.namePinyin} />
            </h2>
            <div className="fake-upload large">上传成品图片（MVP 占位）</div>
            <div className="field">
              <label>今天味道怎么样？</label>
              <textarea rows={3} value={tasteFeedback} onChange={(event) => setTasteFeedback(event.target.value)} />
            </div>
            <div className="field">
              <label>哪里觉得有点难？</label>
              <textarea rows={3} value={difficultyFeedback} onChange={(event) => setDifficultyFeedback(event.target.value)} />
            </div>
            <div className="action-row sticky-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleSubmitFeedback()}
                disabled={isSubmittingFeedback}
              >
                {isSubmittingFeedback ? (
                  <>
                    <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                    生成点评中...
                  </>
                ) : (
                  '生成 AI 点评'
                )}
              </button>
            </div>
          </div>

          <div className="panel">
            <div className="tip-card warm">
              <strong>AI 点评</strong>
              {feedback ? (
                <>
                  <p>{feedback.praise}</p>
                  <p>{feedback.improvement}</p>
                  <p>{feedback.nextSuggestion}</p>
                </>
              ) : (
                <p>提交后端点评接口后，这里会展示鼓励式反馈和下一步建议。</p>
              )}
            </div>
            <div className="action-row">
              <button type="button" className="secondary-button" onClick={() => setPage('recipes')}>
                再试一道类似菜谱
              </button>
              <button type="button" className="primary-button" onClick={() => setPage('home')}>
                返回首页
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {page === 'logs' ? (
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">本地调试日志</p>
            <h2>查看大模型接口调用记录</h2>
            <p className="muted">
              仅用于本地开发调试。支持按时间范围和关键字检索请求摘要、响应摘要和错误信息。
            </p>
            <div className="field-grid">
              <div className="field">
                <label>开始时间</label>
                <input
                  type="datetime-local"
                  value={logFilters.start}
                  onChange={(event) => setLogFilters((current) => ({ ...current, start: event.target.value }))}
                />
              </div>
              <div className="field">
                <label>结束时间</label>
                <input
                  type="datetime-local"
                  value={logFilters.end}
                  onChange={(event) => setLogFilters((current) => ({ ...current, end: event.target.value }))}
                />
              </div>
            </div>
            <div className="field">
              <label>关键字</label>
              <input
                placeholder="例如：generate_recipe_plan / error / 番茄"
                value={logFilters.keyword}
                onChange={(event) => setLogFilters((current) => ({ ...current, keyword: event.target.value }))}
              />
            </div>
            <div className="action-row">
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleFetchLogs()}
                disabled={isFetchingLogs}
              >
                {isFetchingLogs ? (
                  <>
                    <img className="loading-icon" src={loadingIcon} alt="" aria-hidden="true" />
                    检索中...
                  </>
                ) : (
                  '检索日志'
                )}
              </button>
            </div>
            {llmLogFile ? (
              <div className="tip-card compact-card">
                <strong>日志文件</strong>
                <p>{llmLogFile}</p>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <div className="section-header">
              <div>
                <p className="eyebrow">结果</p>
                <h3>{llmLogs.length} 条记录</h3>
              </div>
            </div>
            <div className="stack-list">
              {llmLogs.length > 0 ? (
                llmLogs.map((entry, index) => (
                  <article key={`${entry.timestamp ?? 'log'}_${index}`} className="log-entry">
                    <div className="chip-row">
                      <span className="chip">{entry.operation ?? 'unknown'}</span>
                      <span className="chip">{entry.success ? 'success' : 'error'}</span>
                      <span className="chip">{entry.durationMs ?? 0} ms</span>
                    </div>
                    <strong>{entry.timestamp ?? '无时间戳'}</strong>
                    <p className="muted">模型：{entry.model ?? 'unknown'}</p>
                    {entry.error ? <p className="log-error">{entry.error}</p> : null}
                    {entry.responsePreview ? (
                      <pre className="log-pre">{entry.responsePreview}</pre>
                    ) : null}
                    {entry.requestSummary ? (
                      <pre className="log-pre">{JSON.stringify(entry.requestSummary, null, 2)}</pre>
                    ) : null}
                    {entry.metadata ? (
                      <pre className="log-pre">{JSON.stringify(entry.metadata, null, 2)}</pre>
                    ) : null}
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <strong>还没有日志结果</strong>
                  <p>先在本地触发一次食材识别、菜谱推荐或点评，再回来检索。</p>
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

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
