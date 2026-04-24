import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { AppShell } from './components/AppShell';
import { IngredientThumb } from './components/IngredientThumb';
import { RecipeCard } from './components/RecipeCard';
import { StepCard } from './components/StepCard';
import { quickIngredients } from './data/constants';
import {
  createChildProfile,
  fetchChildProfiles,
  fetchRecentCooked,
  fetchRecipeDetail,
  fetchRecommendations,
  parseIngredientText,
  submitCookingFeedback,
  uploadIngredientImage,
  uploadVoiceAudio,
} from './lib/api';
import type {
  ChildProfile,
  CreateChildProfileInput,
  FeedbackResponse,
  IngredientItem,
  PageId,
  RecipeDetail,
  RecipeRecommendation,
} from './types';

const defaultTasteFeedback = '很好吃，番茄酸酸甜甜的。';
const defaultDifficultyFeedback = '煮面的时候有点难。';
const localProfilesStorageKey = 'murphy-cookbook.local-profiles.v1';

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
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const [page, setPage] = useState<PageId>('home');
  const [profiles, setProfiles] = useState<ChildProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [ingredients, setIngredients] = useState<IngredientItem[]>([]);
  const [recommendations, setRecommendations] = useState<RecipeRecommendation[]>([]);
  const [recentCooked, setRecentCooked] = useState<RecipeDetail[]>([]);
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeDetail | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [manualIngredient, setManualIngredient] = useState('');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [lastUploadMessage, setLastUploadMessage] = useState('');
  const [tasteFeedback, setTasteFeedback] = useState(defaultTasteFeedback);
  const [difficultyFeedback, setDifficultyFeedback] = useState(defaultDifficultyFeedback);
  const [feedback, setFeedback] = useState<FeedbackResponse | null>(null);
  const [localProfiles, setLocalProfiles] = useState<ChildProfile[]>([]);
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
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const [isFetchingRecommendations, setIsFetchingRecommendations] = useState(false);
  const [isFetchingDetail, setIsFetchingDetail] = useState(false);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [error, setError] = useState('');

  const selectedProfile = profiles.find((item) => item.id === selectedProfileId) ?? null;
  const currentStep = selectedRecipe?.steps[stepIndex] ?? null;

  useEffect(() => {
    async function bootstrap() {
      try {
        setError('');
        const localProfileData = readLocalProfiles();
        setLocalProfiles(localProfileData);
        const [profileData, recentData] = await Promise.all([
          fetchChildProfiles(),
          fetchRecentCooked(),
        ]);
        const mergedProfiles = mergeProfiles(profileData, localProfileData);
        setProfiles(mergedProfiles);
        setSelectedProfileId((current) => current || mergedProfiles[0]?.id || '');
        setRecentCooked(recentData);
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

  const handleAudioFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsUploadingAudio(true);
      setError('');
      const data = await uploadVoiceAudio(file);
      appendIngredients(data.ingredients);
      setVoiceTranscript(data.transcript);
      setLastUploadMessage(`已上传音频 ${data.upload.filename}，完成语音转写。`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '语音上传失败。');
    } finally {
      setIsUploadingAudio(false);
      event.target.value = '';
    }
  };

  const removeIngredient = (id: string) => {
    setIngredients((current) => current.filter((item) => item.id !== id));
  };

  const fetchRecipeAndOpen = async (id: string) => {
    try {
      setIsFetchingDetail(true);
      setError('');
      const recipe = await fetchRecipeDetail(id);
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
    if (!selectedProfileId || !selectedRecipe) return;

    try {
      setIsSubmittingFeedback(true);
      setError('');
      const result = await submitCookingFeedback({
        profileId: selectedProfileId,
        recipeId: selectedRecipe.id,
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
        ref={imageInputRef}
        className="sr-only-input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void handleImageFileChange(event)}
      />
      <input
        ref={audioInputRef}
        className="sr-only-input"
        type="file"
        accept="audio/*,.webm,.wav,.m4a,.mp3"
        capture
        onChange={(event) => void handleAudioFileChange(event)}
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
              图片现在走真实文件上传，语音现在走真实音频上传与后端转写接口，优先适配手机和平板浏览器。
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
            <div className="stack-list">
              {recentCooked.map((recipe) => (
                <button
                  key={recipe.id}
                  type="button"
                  className="list-button"
                  onClick={() => void fetchRecipeAndOpen(recipe.id)}
                >
                  <strong>{recipe.name}</strong>
                  <span>{recipe.difficulty} · {recipe.estimatedTimeMinutes} 分钟</span>
                </button>
              ))}
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

      {page === 'input' ? (
        <section className="page-grid">
          <div className="panel">
            <p className="eyebrow">食材输入</p>
            <h2>优先适配手机与 pad 的输入方式</h2>
            <div className="upload-panel">
              <button
                type="button"
                className="fake-upload fake-upload-button"
                onClick={() => imageInputRef.current?.click()}
                disabled={isUploadingImage}
              >
                {isUploadingImage ? '上传图片中…' : '拍照或上传食材图片'}
              </button>
              <button
                type="button"
                className="fake-upload fake-upload-button"
                onClick={() => audioInputRef.current?.click()}
                disabled={isUploadingAudio}
              >
                {isUploadingAudio ? '转写中…' : '录音或上传音频'}
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
                <RecipeCard key={recipe.id} recipe={recipe} onSelect={(id) => void fetchRecipeAndOpen(id)} />
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
                <h2>{selectedRecipe.name}</h2>
                <p className="muted">
                  {selectedRecipe.ageRange} · {selectedRecipe.difficulty} · 准备 {selectedRecipe.prepTimeMinutes} 分钟 · 制作 {selectedRecipe.cookTimeMinutes} 分钟
                </p>
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
                        <strong>{ingredient.name}</strong>
                        <span>{ingredient.quantity}</span>
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
          <StepCard step={currentStep} index={stepIndex} total={selectedRecipe.steps.length} />
          <div className="panel">
            <p className="eyebrow">烹饪进度</p>
            <div className="progress-bar" aria-hidden="true">
              <div
                className="progress-fill"
                style={{
                  width: `${((stepIndex + 1) / selectedRecipe.steps.length) * 100}%`,
                }}
              />
            </div>
            <div className="stack-list">
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
            <div className="action-row sticky-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
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
            <h2>{selectedProfile?.nickname ?? '孩子'} 完成了 {selectedRecipe.name}</h2>
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
    </AppShell>
  );
}
