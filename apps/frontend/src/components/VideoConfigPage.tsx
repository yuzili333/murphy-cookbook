import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  createRecipeVideoConfig,
  deleteRecipeVideoConfig,
  fetchRecipeVideoConfigs,
  loginVideoConfig,
  updateRecipeVideoConfig,
} from '../lib/api';
import type { RecipeCookingVideo, RecipeVideoConfigInput, RecipeVideoResolution } from '../types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel, Form } from './ui/form';
import { Input } from './ui/input';
import { RadioGroup } from './ui/radio-group';
import { Select } from './ui/select';

const tokenStorageKey = 'murphy-cookbook.video-config-token.v1';

type AuthRetryAction = (nextToken: string) => void;

interface FormState {
  recipeName: string;
  recipeAliases: string;
  ingredients: string;
  videoUrl: string;
  coverUrl: string;
  durationSeconds: string;
  resolution: RecipeVideoResolution | '';
}

const emptyForm: FormState = {
  recipeName: '',
  recipeAliases: '',
  ingredients: '',
  videoUrl: '',
  coverUrl: '',
  durationSeconds: '',
  resolution: '1080p',
};

function splitCommaText(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toFormState(item: RecipeCookingVideo): FormState {
  return {
    recipeName: item.recipeName,
    recipeAliases: item.recipeAliases.join(','),
    ingredients: item.ingredients.join(','),
    videoUrl: item.videoUrl,
    coverUrl: item.coverUrl,
    durationSeconds: String(item.durationSeconds),
    resolution: item.resolution,
  };
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return '-';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${seconds}s`;
}

function validateForm(form: FormState) {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const aliases = splitCommaText(form.recipeAliases);
  const duration = Number(form.durationSeconds);

  if (!form.recipeName.trim()) errors.recipeName = '菜谱名称不能为空。';
  else if (Array.from(form.recipeName.trim()).length > 100) errors.recipeName = '菜谱名称不能超过100字。';
  if (!aliases.length) errors.recipeAliases = '菜谱昵称不能为空。';
  else if (aliases.some((alias) => Array.from(alias).length > 200)) errors.recipeAliases = '菜谱昵称每个昵称不能超过200字。';
  if (!form.videoUrl.trim()) errors.videoUrl = '视频地址不能为空。';
  else if (!/^https?:\/\//i.test(form.videoUrl.trim())) errors.videoUrl = '视频地址必须以 http:// 或 https:// 开头。';
  else if (Array.from(form.videoUrl.trim()).length > 200) errors.videoUrl = '视频地址不能超过200字。';
  if (!form.coverUrl.trim()) errors.coverUrl = '视频封面地址不能为空。';
  else if (!/^https?:\/\//i.test(form.coverUrl.trim())) errors.coverUrl = '视频封面地址必须以 http:// 或 https:// 开头。';
  else if (Array.from(form.coverUrl.trim()).length > 200) errors.coverUrl = '视频封面地址不能超过200字。';
  if (!form.durationSeconds.trim()) errors.durationSeconds = '视频时长不能为空。';
  else if (!Number.isInteger(duration) || duration <= 0) errors.durationSeconds = '视频时长必须为正整数。';
  if (form.resolution !== '720p' && form.resolution !== '1080p') errors.resolution = '视频分辨率必须选择720p或1080p。';

  return errors;
}

function isForbiddenError(error: unknown) {
  return error instanceof ApiError && error.status === 403;
}

export function VideoConfigPage() {
  const [token, setToken] = useState(() => {
    try {
      return window.sessionStorage.getItem(tokenStorageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [items, setItems] = useState<RecipeCookingVideo[]>([]);
  const [keyword, setKeyword] = useState('');
  const [resolutionFilter, setResolutionFilter] = useState<'' | RecipeVideoResolution>('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(8);
  const [total, setTotal] = useState(0);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingItem, setEditingItem] = useState<RecipeCookingVideo | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [isFormDialogOpen, setIsFormDialogOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalMessage, setAuthModalMessage] = useState('');
  const pendingAuthActionRef = useRef<AuthRetryAction | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canManage = Boolean(token);

  const payload = useMemo<RecipeVideoConfigInput>(() => ({
    recipeName: form.recipeName.trim(),
    recipeAliases: splitCommaText(form.recipeAliases),
    ingredients: splitCommaText(form.ingredients),
    videoUrl: form.videoUrl.trim(),
    coverUrl: form.coverUrl.trim(),
    durationSeconds: Number(form.durationSeconds),
    resolution: form.resolution === '720p' ? '720p' : '1080p',
  }), [form]);

  function requestReauth(message: string, retryAction?: AuthRetryAction) {
    pendingAuthActionRef.current = retryAction ?? null;
    setAuthModalMessage(message);
    setIsAuthModalOpen(true);
    setError('');
    setNotice('');
    try {
      window.sessionStorage.removeItem(tokenStorageKey);
    } catch {
      // Keep the current page state even if sessionStorage is unavailable.
    }
  }

  async function loadConfigs(nextPage = page, authToken = token) {
    if (!authToken) return;
    setIsLoading(true);
    setError('');
    try {
      const result = await fetchRecipeVideoConfigs({
        token: authToken,
        page: nextPage,
        pageSize,
        keyword,
        resolution: resolutionFilter,
        sortBy: 'updatedAt',
        sortOrder: 'desc',
      });
      setItems(result.items);
      setTotal(result.total);
      setPage(result.page);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : '配置列表获取失败。';
      if (isForbiddenError(loadError)) {
        requestReauth('管理员认证已失效，请重新登录后继续配置管理。');
      } else {
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadConfigs(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, resolutionFilter]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError('');
    setNotice('');
    try {
      const result = await loginVideoConfig(loginForm);
      if (!result.user.permissions.includes('video_config_manage')) {
        setError('没有 video_config_manage 权限，无法访问菜谱视频配置。');
        return;
      }
      setToken(result.token);
      window.sessionStorage.setItem(tokenStorageKey, result.token);
      setNotice('身份验证成功。');
      setError('');
      setIsAuthModalOpen(false);
      setAuthModalMessage('');
      const pendingAction = pendingAuthActionRef.current;
      pendingAuthActionRef.current = null;
      if (pendingAction) {
        pendingAction(result.token);
      } else {
        void loadConfigs(1, result.token);
      }
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '身份验证失败。');
    } finally {
      setIsSubmitting(false);
    }
  }

  function openCreateDialog() {
    setEditingItem(null);
    setForm(emptyForm);
    setErrors({});
    setError('');
    setNotice('');
    setIsFormDialogOpen(true);
  }

  function openEditDialog(item: RecipeCookingVideo) {
    setEditingItem(item);
    setForm(toFormState(item));
    setErrors({});
    setError('');
    setNotice('');
    setIsFormDialogOpen(true);
  }

  function closeFormDialog() {
    setIsFormDialogOpen(false);
    setEditingItem(null);
    setForm(emptyForm);
    setErrors({});
  }

  async function submitConfig(authToken: string) {
    if (editingItem) {
      await updateRecipeVideoConfig(authToken, editingItem.id, payload);
    } else {
      await createRecipeVideoConfig(authToken, payload);
    }
    setNotice('视频配置成功提交！');
    closeFormDialog();
    await loadConfigs(1, authToken);
  }

  function retrySubmitAfterAuth(nextToken: string) {
    setIsSubmitting(true);
    void submitConfig(nextToken)
      .catch((retryError) => {
        setError(retryError instanceof Error ? retryError.message : '视频配置提交失败。');
      })
      .finally(() => setIsSubmitting(false));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validateForm(form);
    setErrors(nextErrors);
    setNotice('');
    setError('');
    if (Object.keys(nextErrors).length) return;

    setIsSubmitting(true);
    try {
      await submitConfig(token);
    } catch (submitError) {
      if (isForbiddenError(submitError)) {
        requestReauth('管理员认证已失效，请重新登录后继续提交当前视频配置。', retrySubmitAfterAuth);
      } else {
        setError(submitError instanceof Error ? submitError.message : '视频配置提交失败。');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deleteConfig(item: RecipeCookingVideo, authToken: string) {
    setError('');
    setNotice('');
    await deleteRecipeVideoConfig(authToken, item.id);
    setNotice('视频配置已删除。');
    await loadConfigs(page, authToken);
  }

  function retryDeleteAfterAuth(item: RecipeCookingVideo) {
    return (nextToken: string) => {
      void deleteConfig(item, nextToken).catch((retryError) => {
        setError(retryError instanceof Error ? retryError.message : '视频配置删除失败。');
      });
    };
  }

  async function handleDelete(item: RecipeCookingVideo) {
    if (!window.confirm(`确认删除“${item.recipeName}”的视频配置吗？`)) return;
    try {
      await deleteConfig(item, token);
    } catch (deleteError) {
      if (isForbiddenError(deleteError)) {
        requestReauth('管理员认证已失效，请重新登录后继续删除当前视频配置。', retryDeleteAfterAuth(item));
      } else {
        setError(deleteError instanceof Error ? deleteError.message : '视频配置删除失败。');
      }
    }
  }

  function updateField<Key extends keyof FormState>(key: Key, value: FormState[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: '' }));
  }

  function renderLoginForm(submitText: string) {
    return (
      <Form className="video-config-form compact" onSubmit={handleLogin}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="video-config-username">管理员账号</FieldLabel>
            <Input
              id="video-config-username"
              value={loginForm.username}
              onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))}
              autoComplete="username"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="video-config-password">管理员密码</FieldLabel>
            <Input
              id="video-config-password"
              type="password"
              value={loginForm.password}
              onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
              autoComplete="current-password"
            />
          </Field>
        </FieldGroup>
        {error ? <p className="video-config-alert error">{error}</p> : null}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? '验证中...' : submitText}
        </Button>
      </Form>
    );
  }

  function renderConfigForm() {
    return (
      <Form className="video-config-form compact" onSubmit={handleSubmit}>
        <FieldGroup>
          <Field invalid={Boolean(errors.recipeName)}>
            <FieldLabel htmlFor="recipe-video-name">菜谱名称</FieldLabel>
            <Input id="recipe-video-name" value={form.recipeName} maxLength={100} onChange={(event) => updateField('recipeName', event.target.value)} placeholder="番茄炒蛋" aria-invalid={Boolean(errors.recipeName)} />
            <FieldError>{errors.recipeName}</FieldError>
          </Field>
          <Field invalid={Boolean(errors.recipeAliases)}>
            <FieldLabel htmlFor="recipe-video-aliases">菜谱昵称</FieldLabel>
            <Input id="recipe-video-aliases" value={form.recipeAliases} maxLength={200} onChange={(event) => updateField('recipeAliases', event.target.value)} placeholder="西红柿炒鸡蛋,番茄鸡蛋" aria-invalid={Boolean(errors.recipeAliases)} />
            <FieldError>{errors.recipeAliases}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="recipe-video-ingredients">食材清单</FieldLabel>
            <Input id="recipe-video-ingredients" value={form.ingredients} onChange={(event) => updateField('ingredients', event.target.value)} placeholder="番茄,鸡蛋,小葱" />
          </Field>
          <Field invalid={Boolean(errors.videoUrl)}>
            <FieldLabel htmlFor="recipe-video-url">视频地址</FieldLabel>
            <Input id="recipe-video-url" value={form.videoUrl} maxLength={200} onChange={(event) => updateField('videoUrl', event.target.value)} placeholder="https://example.com/video.mp4" aria-invalid={Boolean(errors.videoUrl)} />
            <FieldError>{errors.videoUrl}</FieldError>
          </Field>
          <Field invalid={Boolean(errors.coverUrl)}>
            <FieldLabel htmlFor="recipe-video-cover">视频封面地址</FieldLabel>
            <Input id="recipe-video-cover" value={form.coverUrl} maxLength={200} onChange={(event) => updateField('coverUrl', event.target.value)} placeholder="https://example.com/cover.jpg" aria-invalid={Boolean(errors.coverUrl)} />
            <FieldError>{errors.coverUrl}</FieldError>
          </Field>
          <div className="video-config-two-col">
            <Field invalid={Boolean(errors.durationSeconds)}>
              <FieldLabel htmlFor="recipe-video-duration">视频时长（秒）</FieldLabel>
              <Input id="recipe-video-duration" type="number" min="1" value={form.durationSeconds} onChange={(event) => updateField('durationSeconds', event.target.value)} aria-invalid={Boolean(errors.durationSeconds)} />
              <FieldError>{errors.durationSeconds}</FieldError>
            </Field>
            <Field invalid={Boolean(errors.resolution)}>
              <FieldLabel htmlFor="recipe-video-resolution">视频分辨率</FieldLabel>
              <Select id="recipe-video-resolution" value={form.resolution} onChange={(event) => updateField('resolution', event.target.value as RecipeVideoResolution)} aria-invalid={Boolean(errors.resolution)}>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
              </Select>
              <FieldError>{errors.resolution}</FieldError>
            </Field>
          </div>
        </FieldGroup>
        {error ? <p className="video-config-alert error">{error}</p> : null}
        <div className="video-config-dialog-actions">
          <Button type="button" variant="secondary" onClick={closeFormDialog}>
            取消
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? '提交中...' : editingItem ? '保存修改' : '提交配置'}
          </Button>
        </div>
      </Form>
    );
  }

  if (!canManage) {
    return (
      <main className="video-config-page">
        <section className="video-config-login">
          <div>
            <p className="video-config-eyebrow">Murphy's Cookbook</p>
            <h1>菜谱视频配置</h1>
            <p>请输入超管账号和密码。该页面需要 `video_config_manage` 权限。</p>
          </div>
          {renderLoginForm('进入配置页')}
        </section>
      </main>
    );
  }

  return (
    <main className="video-config-page">
      {notice ? <p className="video-config-alert success">{notice}</p> : null}
      {error && !isAuthModalOpen && !isFormDialogOpen ? <p className="video-config-alert error">{error}</p> : null}

      <section className="video-config-list">
        <div className="video-config-list-head">
          <div>
            <p className="video-config-eyebrow">Recipe Video Admin</p>
            <h1>菜谱视频配置</h1>
            <p>人工审核后上传的视频资源，将按菜谱名称和昵称匹配到 chatbox 菜谱卡片。</p>
          </div>
          <div className="video-config-list-actions">
            <Button type="button" onClick={openCreateDialog}>
              新增
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setToken('');
                setIsAuthModalOpen(false);
                pendingAuthActionRef.current = null;
                window.sessionStorage.removeItem(tokenStorageKey);
              }}
            >
              退出
            </Button>
          </div>
        </div>

        <div className="video-config-toolbar">
          <Field className="video-config-query-field">
            <FieldLabel htmlFor="video-config-recipe-name">菜谱名称</FieldLabel>
            <Input
              id="video-config-recipe-name"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void loadConfigs(1);
              }}
              placeholder="输入菜谱名称"
            />
          </Field>
          <Field className="video-config-resolution-filter">
            <FieldLabel id="video-config-resolution-label">分辨率</FieldLabel>
            <RadioGroup
              value={resolutionFilter}
              ariaLabelledBy="video-config-resolution-label"
              options={[
                { label: '全部', value: '' },
                { label: '720p', value: '720p' },
                { label: '1080p', value: '1080p' },
              ]}
              onValueChange={setResolutionFilter}
            />
          </Field>
          <Button type="button" onClick={() => void loadConfigs(1)}>
            查询
          </Button>
        </div>

        <div className="video-config-table-wrap">
          <table className="video-config-table">
            <thead>
              <tr>
                <th>菜谱</th>
                <th>昵称</th>
                <th>食材</th>
                <th>视频</th>
                <th>时长</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.recipeName}</strong>
                    <span>{item.resolution}</span>
                  </td>
                  <td>{item.recipeAliases.join('，')}</td>
                  <td>{item.ingredients.join('，') || '-'}</td>
                  <td>
                    <a href={item.videoUrl} target="_blank" rel="noreferrer">视频</a>
                    <a href={item.coverUrl} target="_blank" rel="noreferrer">封面</a>
                  </td>
                  <td>{formatDuration(item.durationSeconds)}</td>
                  <td>
                    <div className="video-config-row-actions">
                      <Button type="button" variant="secondary" onClick={() => openEditDialog(item)}>
                        编辑
                      </Button>
                      <Button type="button" variant="danger" onClick={() => void handleDelete(item)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!items.length ? (
                <tr>
                  <td colSpan={6} className="video-config-empty">
                    {isLoading ? '正在加载配置...' : '暂无视频配置'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="video-config-pagination">
          <span>共 {total} 条，第 {page} / {totalPages} 页</span>
          <div>
            <Button type="button" variant="secondary" disabled={page <= 1 || isLoading} onClick={() => void loadConfigs(page - 1)}>上一页</Button>
            <Button type="button" variant="secondary" disabled={page >= totalPages || isLoading} onClick={() => void loadConfigs(page + 1)}>下一页</Button>
          </div>
        </div>
      </section>

      <Dialog open={isFormDialogOpen} title={editingItem ? '编辑视频配置' : '新增视频配置'} onOpenChange={(open) => { if (!open) closeFormDialog(); }}>
        {renderConfigForm()}
      </Dialog>

      <Dialog
        open={isAuthModalOpen}
        title="管理员重新登录"
        className="video-config-auth-dialog"
        onOpenChange={(open) => {
          setIsAuthModalOpen(open);
          if (!open) pendingAuthActionRef.current = null;
        }}
      >
        <p>{authModalMessage || '请重新输入管理员账号和密码。'}</p>
        {renderLoginForm('重新登录')}
      </Dialog>
    </main>
  );
}
