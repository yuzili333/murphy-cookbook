import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { AppShell } from './components/AppShell';
import { IngredientThumb } from './components/IngredientThumb';
import { RecipeCard } from './components/RecipeCard';
import { RecipeName } from './components/RecipeName';
import { StepCard } from './components/StepCard';
import { ZoomableImage } from './components/ZoomableImage';
import { quickIngredients } from './data/constants';
import {
  createChildProfile,
  fetchChildProfiles,
  fetchGeneratedRecipeDetail,
  fetchLlmLogs,
  fetchRecipeDetail,
  fetchRecommendations,
  parseIngredientText,
  submitCookingFeedback,
  uploadIngredientImage,
} from './lib/api';
import type {
  ChildProfile,
  CreateChildProfileInput,
  FeedbackResponse,
  IngredientItem,
  LlmLogEntry,
  PageId,
  RecipeDetail,
  RecipeRecommendation,
} from './types';

const defaultTasteFeedback = '很好吃，番茄酸酸甜甜的。';
const defaultDifficultyFeedback = '煮面的时候有点难。';
const localProfilesStorageKey = 'murphy-cookbook.local-profiles.v1';
const recentCookedStorageKey = 'murphy-cookbook.recent-cooked.v1';
const favoriteRecipesStorageKey = 'murphy-cookbook.favorite-recipes.v1';
type RecentCookedByProfile = Record<string, RecipeDetail[]>;
type FavoriteRecipesByProfile = Record<string, RecipeRecommendation[]>;

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

export default function App() {
  const cameraImageInputRef = useRef<HTMLInputElement>(null);
  const fileImageInputRef = useRef<HTMLInputElement>(null);

  const [page, setPage] = useState<PageId>('home');
  const [profiles, setProfiles] = useState<ChildProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [ingredients, setIngredients] = useState<IngredientItem[]>([]);
  const [recommendations, setRecommendations] = useState<RecipeRecommendation[]>([]);
  const [recentCooked, setRecentCooked] = useState<RecipeDetail[]>([]);
  const [recentCookedByProfile, setRecentCookedByProfile] = useState<RecentCookedByProfile>({});
  const [favoriteRecipesByProfile, setFavoriteRecipesByProfile] = useState<FavoriteRecipesByProfile>({});
  const [favoriteRecipes, setFavoriteRecipes] = useState<RecipeRecommendation[]>([]);
  const [recipeDetailsById, setRecipeDetailsById] = useState<Record<string, RecipeDetail>>({});
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeDetail | null>(null);
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
  const [error, setError] = useState('');

  const speakText = (text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setError('当前设备浏览器不支持语音朗读功能。');
      return;
    }

    const content = text.trim();
    if (!content) {
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.95;
    utterance.pitch = 1;
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
    ].filter(Boolean).join('。'));
  };

  const speakRecipeOverview = (recipe: RecipeDetail) => {
    const stepTitles = recipe.steps.map((step, index) => `第${index + 1}步，${step.title}`).join('；');
    speakText(`${recipe.name}。一共${recipe.steps.length}步。${stepTitles}。点击每一步的朗读按钮，可以继续听详细讲解。`);
  };

  const selectedProfile = profiles.find((item) => item.id === selectedProfileId) ?? null;
  const currentStep = selectedRecipe?.steps[stepIndex] ?? null;

  useEffect(() => {
    async function bootstrap() {
      try {
        setError('');
        const localProfileData = readLocalProfiles();
        const localRecentCooked = readRecentCookedRecipes();
        const localFavoriteRecipes = readFavoriteRecipes();
        setLocalProfiles(localProfileData);
        const profileData = await fetchChildProfiles();
        const mergedProfiles = mergeProfiles(profileData, localProfileData);
        setProfiles(mergedProfiles);
        setSelectedProfileId((current) => current || mergedProfiles[0]?.id || '');
        setRecentCookedByProfile(localRecentCooked);
        setRecentCooked(localRecentCooked[mergedProfiles[0]?.id ?? ''] ?? []);
        setFavoriteRecipesByProfile(localFavoriteRecipes);
        setFavoriteRecipes(localFavoriteRecipes[mergedProfiles[0]?.id ?? ''] ?? []);
      } catch (bootstrapError) {
        setError(bootstrapError instanceof Error ? bootstrapError.message : '初始化失败，请稍后重试。');
      } finally {
        setIsBootstrapping(false);
      }
    }

    void bootstrap();
  }, []);

  useEffect(() => {
    if (selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)) {
      return;
    }

    setSelectedProfileId(profiles[0]?.id ?? '');
  }, [profiles, selectedProfileId]);

  useEffect(() => {
    setRecentCooked(recentCookedByProfile[selectedProfileId] ?? []);
  }, [recentCookedByProfile, selectedProfileId]);

  useEffect(() => {
    setFavoriteRecipes(favoriteRecipesByProfile[selectedProfileId] ?? []);
  }, [favoriteRecipesByProfile, selectedProfileId]);

  const appendIngredients = (items: IngredientItem[]) => {
    setIngredients((current) => {
      const merged = [...current];

      for (const item of items) {
        const exists = merged.some((currentItem) => currentItem.name === item.name);
        if (!exists) {
          merged.push(item);
        }
      }

      return merged;
    });
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
      const data = await uploadIngredientImage(file);
      appendIngredients(data.ingredients);
      setLastUploadMessage(`已上传图片 ${data.upload.filename}，识别到 ${data.ingredients.length} 项食材。`);
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
          const data = await parseIngredientText(transcript);
          appendIngredients(data.ingredients);
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
    if (!selectedProfileId) {
      setError('请先选择儿童档案。');
      return;
    }

    try {
      setIsFetchingRecommendations(true);
      setError('');
      if (!selectedProfile) {
        setError('请先选择有效的儿童档案。');
        return;
      }

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

  const clearRecentCookedRecipes = () => {
    if (!selectedProfileId) {
      return;
    }

    setRecentCookedByProfile((current) => {
      const next = {
        ...current,
        [selectedProfileId]: [],
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
      <AppShell currentPage="home" onNavigate={setPage}>
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">初始化中</p>
            <h2>正在加载儿童档案和最近做过的菜谱…</h2>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell currentPage={page} onNavigate={setPage}>
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

      {error ? (
        <div className="alert-box error-banner">
          <strong>当前提示</strong>
          <p>{error}</p>
        </div>
      ) : null}

      {page === 'home' ? (
        <section className="page-grid">
          <div className="hero-card">
            <p className="eyebrow">今日任务</p>
            <h2>用家里现有食材，给 {selectedProfile?.nickname ?? '孩子'} 做一份安全又好吃的儿童餐。</h2>
            <p className="muted">
              图片支持分开拍摄与本地上传，语音优先调用当前设备系统麦克风与语音转文字能力，优先适配手机和平板浏览器。
            </p>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={() => setPage('input')}>
                开始输入食材
              </button>
              <button type="button" className="secondary-button" onClick={() => setPage('profile')}>
                查看档案
              </button>
            </div>
          </div>

          <div className="info-card">
            <p className="eyebrow">当前儿童档案</p>
            {selectedProfile ? (
              <>
                <h3>{selectedProfile.nickname} · {selectedProfile.age} 岁</h3>
                <p>口味偏好：{selectedProfile.tastePreferences.join('、')}</p>
                <p>过敏原：{selectedProfile.allergens.join('、')}</p>
                <p>饮食习惯：{selectedProfile.dietaryHabits.join('、')}</p>
              </>
            ) : (
              <p>暂未加载档案。</p>
            )}
          </div>

          <div className="info-card">
            <p className="eyebrow">最近做过</p>
            <div className="section-header">
              <div>
                <h3>{recentCooked.length} 条记录</h3>
                <p className="muted">当前档案：{selectedProfile?.nickname ?? '未选择'}</p>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={clearRecentCookedRecipes}
                disabled={recentCooked.length === 0}
              >
                清空最近记录
              </button>
            </div>
            <div className="stack-list">
              {recentCooked.length > 0 ? (
                recentCooked.map((recipe) => (
                  <button
                    key={recipe.id}
                    type="button"
                    className="list-button"
                    onClick={() => void fetchRecipeAndOpen(recipe.id)}
                  >
                    <RecipeName as="strong" name={recipe.name} pinyin={recipe.namePinyin} />
                    <span>{recipe.difficulty} · {recipe.estimatedTimeMinutes} 分钟</span>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>当前档案还没有最近记录</strong>
                  <p>完成一道菜后，这里会只展示当前孩子做过的菜谱。</p>
                </div>
              )}
            </div>
          </div>

          <div className="info-card">
            <p className="eyebrow">我的收藏</p>
            <div className="section-header">
              <div>
                <h3>{favoriteRecipes.length} 条收藏</h3>
                <p className="muted">当前档案：{selectedProfile?.nickname ?? '未选择'}</p>
              </div>
            </div>
            <div className="stack-list">
              {favoriteRecipes.length > 0 ? (
                favoriteRecipes.map((recipe) => (
                  <button
                    key={recipe.id}
                    type="button"
                    className="list-button"
                    onClick={() => void fetchRecipeAndOpen(recipe)}
                  >
                    <RecipeName as="strong" name={recipe.name} pinyin={recipe.namePinyin} />
                    <span>{recipe.difficulty} · {recipe.estimatedTimeMinutes} 分钟</span>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>当前档案还没有收藏菜谱</strong>
                  <p>在推荐页点击“收藏”，以后就能快速复用。</p>
                </div>
              )}
            </div>
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
                {isCreatingProfile ? '保存中…' : '新增并使用这个档案'}
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
                {isUploadingImage ? '上传图片中…' : '拍摄食材图片'}
              </button>
              <button
                type="button"
                className="fake-upload fake-upload-button"
                onClick={() => fileImageInputRef.current?.click()}
                disabled={isUploadingImage}
              >
                {isUploadingImage ? '上传图片中…' : '选择本地图片'}
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
                  {isParsingText ? '解析中…' : '解析'}
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
                {isFetchingRecommendations ? '推荐中…' : '开始推荐菜谱'}
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
                  onSelect={() => void fetchRecipeAndOpen(recipe)}
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
              <h2>正在加载菜谱详情…</h2>
            ) : (
              <>
                <ZoomableImage className="detail-hero-image" src={selectedRecipe.imageUrl} alt={selectedRecipe.name} />
                <RecipeName as="h2" name={selectedRecipe.name} pinyin={selectedRecipe.namePinyin} />
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
                            朗读这一步
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
                {isSubmittingFeedback ? '生成点评中…' : '生成 AI 点评'}
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
                {isFetchingLogs ? '检索中…' : '检索日志'}
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
    </AppShell>
  );
}
