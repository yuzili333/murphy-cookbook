import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MongoClient, type Collection, type ObjectId } from 'mongodb';

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

export interface RecipeVideoListResult {
  items: RecipeVideoConfig[];
  page: number;
  pageSize: number;
  total: number;
}

export interface RecipeVideoStore {
  list(options?: RecipeVideoListOptions): Promise<RecipeVideoListResult>;
  create(input: RecipeVideoInput): Promise<RecipeVideoConfig>;
  update(id: string, input: RecipeVideoInput): Promise<RecipeVideoConfig>;
  delete(id: string): Promise<void>;
  match(recipeName: string): Promise<RecipeVideoConfig | null>;
}

interface RecipeVideoDocument extends RecipeVideoConfig {
  _id?: ObjectId;
  normalizedRecipeName: string;
  normalizedRecipeAliases: string[];
  searchableText: string;
}

const defaultDataFilePath = resolve(process.cwd(), '.local', 'recipe-videos.json');
let mongoClientPromise: Promise<MongoClient> | null = null;
let mongoIndexesReadyPromise: Promise<void> | null = null;
let recipeVideoStoreForTest: RecipeVideoStore | null = null;

export function normalizeRecipeVideoName(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，、]/g, ',')
    .normalize('NFKC');
}

function getLocalDataFilePath() {
  return process.env.RECIPE_VIDEO_LOCAL_FILE
    ? resolve(process.env.RECIPE_VIDEO_LOCAL_FILE)
    : defaultDataFilePath;
}

function getMongoUri() {
  return (process.env.RECIPE_VIDEO_MONGODB_URI || process.env.MONGODB_URI || '').trim();
}

function getMongoDatabaseName() {
  return (process.env.RECIPE_VIDEO_MONGODB_DB || process.env.MONGODB_DB_NAME || 'murphy_cookbook').trim();
}

function getMongoCollectionName() {
  return (process.env.RECIPE_VIDEO_MONGODB_COLLECTION || 'recipe_videos').trim();
}

function getMongoServerSelectionTimeoutMs() {
  const value = Number(process.env.RECIPE_VIDEO_MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000);
  return Number.isFinite(value) && value > 0 ? value : 5000;
}

function ensureDataFile() {
  const dataFilePath = getLocalDataFilePath();
  if (existsSync(dataFilePath)) {
    return;
  }

  mkdirSync(dirname(dataFilePath), { recursive: true });
  writeFileSync(dataFilePath, '[]\n', 'utf8');
}

function readAllRecipeVideos() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(readFileSync(getLocalDataFilePath(), 'utf8')) as RecipeVideoConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAllRecipeVideos(items: RecipeVideoConfig[]) {
  ensureDataFile();
  writeFileSync(getLocalDataFilePath(), `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function toPositiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : 0;
}

function validateUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRecipeVideoId() {
  return `recipe_video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toSearchableText(input: Pick<RecipeVideoConfig, 'recipeName' | 'recipeAliases' | 'ingredients'>) {
  return normalizeRecipeVideoName([input.recipeName, ...input.recipeAliases, ...input.ingredients].join(','));
}

function toDocument(item: RecipeVideoConfig): RecipeVideoDocument {
  return {
    ...item,
    normalizedRecipeName: normalizeRecipeVideoName(item.recipeName),
    normalizedRecipeAliases: item.recipeAliases.map(normalizeRecipeVideoName).filter(Boolean),
    searchableText: toSearchableText(item),
  };
}

function fromDocument(document: RecipeVideoDocument): RecipeVideoConfig {
  const item = { ...document } as Partial<RecipeVideoDocument>;
  delete item._id;
  delete item.normalizedRecipeName;
  delete item.normalizedRecipeAliases;
  delete item.searchableText;

  return item as RecipeVideoConfig;
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000);
}

async function getMongoClient() {
  const uri = getMongoUri();
  if (!uri) {
    return null;
  }

  if (!mongoClientPromise) {
    mongoClientPromise = new MongoClient(uri, {
      serverSelectionTimeoutMS: getMongoServerSelectionTimeoutMs(),
    }).connect();
  }

  return mongoClientPromise;
}

async function getMongoRecipeVideoCollection(): Promise<Collection<RecipeVideoDocument> | null> {
  const client = await getMongoClient();
  if (!client) {
    return null;
  }

  const collection = client.db(getMongoDatabaseName()).collection<RecipeVideoDocument>(getMongoCollectionName());
  if (!mongoIndexesReadyPromise) {
    mongoIndexesReadyPromise = Promise.all([
      collection.createIndex({ normalizedRecipeName: 1 }, { unique: true }),
      collection.createIndex({ normalizedRecipeAliases: 1 }),
      collection.createIndex({ searchableText: 1 }),
      collection.createIndex({ updatedAt: -1 }),
    ]).then(() => undefined);
  }
  await mongoIndexesReadyPromise;

  return collection;
}

function sortRecipeVideos(items: RecipeVideoConfig[], sortBy: NonNullable<RecipeVideoListOptions['sortBy']>, sortOrder: 'asc' | 'desc') {
  return [...items].sort((left, right) => {
    const leftValue = left[sortBy];
    const rightValue = right[sortBy];
    const result = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), 'zh-Hans-CN');
    return sortOrder === 'asc' ? result : -result;
  });
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

export function createLocalRecipeVideoStore(): RecipeVideoStore {
  return {
    async list(options: RecipeVideoListOptions = {}) {
      const page = Math.max(1, Number(options.page) || 1);
      const pageSize = Math.min(50, Math.max(1, Number(options.pageSize) || 10));
      const keyword = normalizeRecipeVideoName(options.keyword ?? '');
      const resolution = options.resolution === '720p' || options.resolution === '1080p' ? options.resolution : '';
      const sortBy = options.sortBy ?? 'updatedAt';
      const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
      let items = readAllRecipeVideos();

      if (keyword) {
        items = items.filter((item) => toSearchableText(item).includes(keyword));
      }

      if (resolution) {
        items = items.filter((item) => item.resolution === resolution);
      }

      items = sortRecipeVideos(items, sortBy, sortOrder);

      const total = items.length;
      return {
        items: items.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total,
      };
    },

    async create(input: RecipeVideoInput) {
      const items = readAllRecipeVideos();
      const normalized = normalizeRecipeVideoName(input.recipeName);
      if (items.some((item) => normalizeRecipeVideoName(item.recipeName) === normalized)) {
        throw new Error('菜谱名称不能重复。');
      }

      const now = new Date().toISOString();
      const item: RecipeVideoConfig = {
        ...input,
        id: buildRecipeVideoId(),
        status: 'approved',
        createdAt: now,
        updatedAt: now,
      };
      writeAllRecipeVideos([item, ...items]);
      return item;
    },

    async update(id: string, input: RecipeVideoInput) {
      const items = readAllRecipeVideos();
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) {
        throw new Error('未找到对应的视频配置。');
      }

      const normalized = normalizeRecipeVideoName(input.recipeName);
      if (items.some((item) => item.id !== id && normalizeRecipeVideoName(item.recipeName) === normalized)) {
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
    },

    async delete(id: string) {
      const items = readAllRecipeVideos();
      const nextItems = items.filter((item) => item.id !== id);
      if (nextItems.length === items.length) {
        throw new Error('未找到对应的视频配置。');
      }
      writeAllRecipeVideos(nextItems);
    },

    async match(recipeName: string) {
      const normalized = normalizeRecipeVideoName(recipeName);
      if (!normalized) {
        return null;
      }

      return readAllRecipeVideos().find((item) => {
        if (item.status !== 'approved') return false;
        return [item.recipeName, ...item.recipeAliases].some((name) => normalizeRecipeVideoName(name) === normalized);
      }) ?? null;
    },
  };
}

export function createMongoRecipeVideoStore(): RecipeVideoStore {
  return {
    async list(options: RecipeVideoListOptions = {}) {
      const collection = await getMongoRecipeVideoCollection();
      if (!collection) {
        return createLocalRecipeVideoStore().list(options);
      }

      const page = Math.max(1, Number(options.page) || 1);
      const pageSize = Math.min(50, Math.max(1, Number(options.pageSize) || 10));
      const keyword = normalizeRecipeVideoName(options.keyword ?? '');
      const resolution = options.resolution === '720p' || options.resolution === '1080p' ? options.resolution : '';
      const sortBy = options.sortBy ?? 'updatedAt';
      const sortOrder = options.sortOrder === 'asc' ? 1 : -1;
      const filter: Record<string, unknown> = {};

      if (keyword) {
        filter.searchableText = { $regex: escapeRegExp(keyword) };
      }
      if (resolution) {
        filter.resolution = resolution;
      }

      const [total, documents] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter)
          .sort({ [sortBy]: sortOrder })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray(),
      ]);

      return {
        items: documents.map(fromDocument),
        page,
        pageSize,
        total,
      };
    },

    async create(input: RecipeVideoInput) {
      const collection = await getMongoRecipeVideoCollection();
      if (!collection) {
        return createLocalRecipeVideoStore().create(input);
      }

      const now = new Date().toISOString();
      const item: RecipeVideoConfig = {
        ...input,
        id: buildRecipeVideoId(),
        status: 'approved',
        createdAt: now,
        updatedAt: now,
      };

      try {
        await collection.insertOne(toDocument(item));
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new Error('菜谱名称不能重复。');
        }
        throw error;
      }

      return item;
    },

    async update(id: string, input: RecipeVideoInput) {
      const collection = await getMongoRecipeVideoCollection();
      if (!collection) {
        return createLocalRecipeVideoStore().update(id, input);
      }

      const existing = await collection.findOne({ id });
      if (!existing) {
        throw new Error('未找到对应的视频配置。');
      }

      const updated: RecipeVideoConfig = {
        ...fromDocument(existing),
        ...input,
        status: 'approved',
        updatedAt: new Date().toISOString(),
      };

      try {
        const result = await collection.updateOne({ id }, { $set: toDocument(updated) });
        if (!result.matchedCount) {
          throw new Error('未找到对应的视频配置。');
        }
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new Error('菜谱名称不能重复。');
        }
        throw error;
      }

      return updated;
    },

    async delete(id: string) {
      const collection = await getMongoRecipeVideoCollection();
      if (!collection) {
        return createLocalRecipeVideoStore().delete(id);
      }

      const result = await collection.deleteOne({ id });
      if (!result.deletedCount) {
        throw new Error('未找到对应的视频配置。');
      }
    },

    async match(recipeName: string) {
      const collection = await getMongoRecipeVideoCollection();
      if (!collection) {
        return createLocalRecipeVideoStore().match(recipeName);
      }

      const normalized = normalizeRecipeVideoName(recipeName);
      if (!normalized) {
        return null;
      }

      const document = await collection.findOne({
        status: 'approved',
        $or: [
          { normalizedRecipeName: normalized },
          { normalizedRecipeAliases: normalized },
        ],
      });

      return document ? fromDocument(document) : null;
    },
  };
}

function getRecipeVideoStore() {
  if (recipeVideoStoreForTest) {
    return recipeVideoStoreForTest;
  }

  return createMongoRecipeVideoStore();
}

export function setRecipeVideoStoreForTest(store: RecipeVideoStore | null) {
  recipeVideoStoreForTest = store;
}

export async function closeRecipeVideoMongoConnectionForTest() {
  if (mongoClientPromise) {
    const client = await mongoClientPromise;
    await client.close();
  }
  mongoClientPromise = null;
  mongoIndexesReadyPromise = null;
}

export function listRecipeVideos(options: RecipeVideoListOptions = {}) {
  return getRecipeVideoStore().list(options);
}

export function createRecipeVideo(input: RecipeVideoInput) {
  return getRecipeVideoStore().create(input);
}

export function updateRecipeVideo(id: string, input: RecipeVideoInput) {
  return getRecipeVideoStore().update(id, input);
}

export function deleteRecipeVideo(id: string) {
  return getRecipeVideoStore().delete(id);
}

export function matchRecipeVideo(recipeName: string) {
  return getRecipeVideoStore().match(recipeName);
}
