import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type RecipeVideoResolution = '720p' | '1080p';
export type RecipeVideoStatus = 'approved';

export interface RecipeVideoConfig {
  id: string;
  recipeName: string;
  recipeAliases: string[];
  ingredients: string[];
  videoUrl: string;
  coverUrl: string;
  durationSeconds: number;
  resolution: RecipeVideoResolution;
  status: RecipeVideoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RecipeVideoInput {
  recipeName: string;
  recipeAliases: string[];
  ingredients: string[];
  videoUrl: string;
  coverUrl: string;
  durationSeconds: number;
  resolution: RecipeVideoResolution;
}

export interface RecipeVideoListOptions {
  keyword?: string;
  resolution?: RecipeVideoResolution | '';
  sortBy?: 'recipeName' | 'durationSeconds' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

const dataFilePath = resolve(process.cwd(), '.local', 'recipe-videos.json');

function normalizeName(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，、]/g, ',')
    .normalize('NFKC');
}

function ensureDataFile() {
  if (existsSync(dataFilePath)) {
    return;
  }

  mkdirSync(dirname(dataFilePath), { recursive: true });
  writeFileSync(dataFilePath, '[]\n', 'utf8');
}

function readAllRecipeVideos() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(readFileSync(dataFilePath, 'utf8')) as RecipeVideoConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAllRecipeVideos(items: RecipeVideoConfig[]) {
  ensureDataFile();
  writeFileSync(dataFilePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function toPositiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : 0;
}

function validateUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

export function parseRecipeVideoInput(value: unknown): RecipeVideoInput {
  const payload = (value ?? {}) as Record<string, unknown>;
  const recipeName = String(payload.recipeName ?? '').trim();
  const recipeAliases = Array.isArray(payload.recipeAliases)
    ? payload.recipeAliases.map((item) => String(item).trim()).filter(Boolean)
    : String(payload.recipeAliases ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const ingredients = Array.isArray(payload.ingredients)
    ? payload.ingredients.map((item) => String(item).trim()).filter(Boolean)
    : String(payload.ingredients ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const videoUrl = String(payload.videoUrl ?? '').trim();
  const coverUrl = String(payload.coverUrl ?? '').trim();
  const durationSeconds = toPositiveInteger(payload.durationSeconds);
  const resolution = payload.resolution === '720p' || payload.resolution === '1080p' ? payload.resolution : '';

  if (!recipeName) throw new Error('菜谱名称不能为空。');
  if (Array.from(recipeName).length > 100) throw new Error('菜谱名称不能超过100字。');
  if (!recipeAliases.length) throw new Error('菜谱昵称不能为空。');
  if (recipeAliases.some((alias) => Array.from(alias).length > 200)) throw new Error('菜谱昵称每个昵称不能超过200字。');
  if (!videoUrl) throw new Error('视频地址不能为空。');
  if (Array.from(videoUrl).length > 200) throw new Error('视频地址不能超过200字。');
  if (!validateUrl(videoUrl)) throw new Error('视频地址必须以 http:// 或 https:// 开头。');
  if (!coverUrl) throw new Error('视频封面地址不能为空。');
  if (Array.from(coverUrl).length > 200) throw new Error('视频封面地址不能超过200字。');
  if (!validateUrl(coverUrl)) throw new Error('视频封面地址必须以 http:// 或 https:// 开头。');
  if (!durationSeconds) throw new Error('视频时长必须为正整数。');
  if (!resolution) throw new Error('视频分辨率必须选择 720p 或 1080p。');

  return { recipeName, recipeAliases, ingredients, videoUrl, coverUrl, durationSeconds, resolution };
}

export function listRecipeVideos(options: RecipeVideoListOptions = {}) {
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(options.pageSize) || 10));
  const keyword = normalizeName(options.keyword ?? '');
  const resolution = options.resolution === '720p' || options.resolution === '1080p' ? options.resolution : '';
  const sortBy = options.sortBy ?? 'updatedAt';
  const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
  let items = readAllRecipeVideos();

  if (keyword) {
    items = items.filter((item) => {
      const text = normalizeName([item.recipeName, ...item.recipeAliases, ...item.ingredients].join(','));
      return text.includes(keyword);
    });
  }

  if (resolution) {
    items = items.filter((item) => item.resolution === resolution);
  }

  items = [...items].sort((left, right) => {
    const leftValue = left[sortBy];
    const rightValue = right[sortBy];
    const result = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), 'zh-Hans-CN');
    return sortOrder === 'asc' ? result : -result;
  });

  const total = items.length;
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total,
  };
}

export function createRecipeVideo(input: RecipeVideoInput) {
  const items = readAllRecipeVideos();
  const normalized = normalizeName(input.recipeName);
  if (items.some((item) => normalizeName(item.recipeName) === normalized)) {
    throw new Error('菜谱名称不能重复。');
  }

  const now = new Date().toISOString();
  const item: RecipeVideoConfig = {
    ...input,
    id: `recipe_video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'approved',
    createdAt: now,
    updatedAt: now,
  };
  writeAllRecipeVideos([item, ...items]);
  return item;
}

export function updateRecipeVideo(id: string, input: RecipeVideoInput) {
  const items = readAllRecipeVideos();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new Error('未找到对应的视频配置。');
  }

  const normalized = normalizeName(input.recipeName);
  if (items.some((item) => item.id !== id && normalizeName(item.recipeName) === normalized)) {
    throw new Error('菜谱名称不能重复。');
  }

  const updated: RecipeVideoConfig = {
    ...items[index],
    ...input,
    status: 'approved',
    updatedAt: new Date().toISOString(),
  };
  items[index] = updated;
  writeAllRecipeVideos(items);
  return updated;
}

export function deleteRecipeVideo(id: string) {
  const items = readAllRecipeVideos();
  const nextItems = items.filter((item) => item.id !== id);
  if (nextItems.length === items.length) {
    throw new Error('未找到对应的视频配置。');
  }
  writeAllRecipeVideos(nextItems);
}

export function matchRecipeVideo(recipeName: string) {
  const normalized = normalizeName(recipeName);
  if (!normalized) {
    return null;
  }

  return readAllRecipeVideos().find((item) => {
    if (item.status !== 'approved') return false;
    return [item.recipeName, ...item.recipeAliases].some((name) => normalizeName(name) === normalized);
  }) ?? null;
}
