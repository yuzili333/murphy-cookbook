import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecipeVideo,
  deleteRecipeVideo,
  listRecipeVideos,
  matchRecipeVideo,
  setRecipeVideoStoreForTest,
  updateRecipeVideo,
  type RecipeVideoConfig,
  type RecipeVideoInput,
  type RecipeVideoListOptions,
  type RecipeVideoStore,
} from '../../recipeVideos.js';

function normalizeName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, '').replace(/[，、]/g, ',').normalize('NFKC');
}

function createMemoryRecipeVideoStore(): RecipeVideoStore {
  const items: RecipeVideoConfig[] = [];

  return {
    async list(options: RecipeVideoListOptions = {}) {
      const page = Math.max(1, Number(options.page) || 1);
      const pageSize = Math.min(50, Math.max(1, Number(options.pageSize) || 10));
      const keyword = normalizeName(options.keyword ?? '');
      const resolution = options.resolution === '720p' || options.resolution === '1080p' ? options.resolution : '';
      const sortBy = options.sortBy ?? 'updatedAt';
      const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
      let filteredItems = [...items];

      if (keyword) {
        filteredItems = filteredItems.filter((item) =>
          normalizeName([item.recipeName, ...item.recipeAliases, ...item.ingredients].join(',')).includes(keyword),
        );
      }

      if (resolution) {
        filteredItems = filteredItems.filter((item) => item.resolution === resolution);
      }

      filteredItems.sort((left, right) => {
        const leftValue = left[sortBy];
        const rightValue = right[sortBy];
        const result = typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue), 'zh-Hans-CN');
        return sortOrder === 'asc' ? result : -result;
      });

      return {
        items: filteredItems.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total: filteredItems.length,
      };
    },

    async create(input: RecipeVideoInput) {
      const normalized = normalizeName(input.recipeName);
      if (items.some((item) => normalizeName(item.recipeName) === normalized)) {
        throw new Error('菜谱名称不能重复。');
      }

      const now = new Date().toISOString();
      const item: RecipeVideoConfig = {
        ...input,
        id: `recipe_video_test_${items.length + 1}`,
        status: 'approved',
        createdAt: now,
        updatedAt: now,
      };
      items.unshift(item);
      return item;
    },

    async update(id: string, input: RecipeVideoInput) {
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
      return updated;
    },

    async delete(id: string) {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) {
        throw new Error('未找到对应的视频配置。');
      }
      items.splice(index, 1);
    },

    async match(recipeName: string) {
      const normalized = normalizeName(recipeName);
      if (!normalized) {
        return null;
      }

      return items.find((item) =>
        item.status === 'approved' &&
        [item.recipeName, ...item.recipeAliases].some((name) => normalizeName(name) === normalized),
      ) ?? null;
    },
  };
}

test('recipe video store supports create, shared lookup, update, and delete', async () => {
  setRecipeVideoStoreForTest(createMemoryRecipeVideoStore());
  const payload: RecipeVideoInput = {
    recipeName: '番茄鸡蛋面',
    recipeAliases: ['番茄鸡蛋面', '番茄蛋面'],
    ingredients: ['番茄', '鸡蛋', '面条'],
    videoUrl: 'https://example.com/tomato-egg-noodle.mp4',
    coverUrl: 'https://example.com/tomato-egg-noodle.jpg',
    durationSeconds: 128,
    resolution: '720p',
  };

  try {
    const created = await createRecipeVideo(payload);
    assert.match(created.id, /^recipe_video_test_/);
    assert.equal(created.recipeName, '番茄鸡蛋面');

    const listResult = await listRecipeVideos({ keyword: '鸡蛋面' });
    assert.equal(listResult.total, 1);
    assert.equal(listResult.items[0].id, created.id);

    const matchedByAlias = await matchRecipeVideo('番茄蛋面');
    assert.equal(matchedByAlias?.id, created.id);

    const updated = await updateRecipeVideo(created.id, {
      ...payload,
      recipeName: '番茄鸡蛋汤面',
      recipeAliases: ['番茄鸡蛋汤面'],
      resolution: '1080p',
    });
    assert.equal(updated.recipeName, '番茄鸡蛋汤面');
    assert.equal(updated.resolution, '1080p');

    await deleteRecipeVideo(created.id);
    assert.equal(await matchRecipeVideo('番茄鸡蛋汤面'), null);
  } finally {
    setRecipeVideoStoreForTest(null);
  }
});
