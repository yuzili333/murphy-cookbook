import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import {
  generateRecipeDetail,
  generateRecipePlan,
  isSiliconFlowConfigured,
  type SiliconFlowCallMetrics,
} from '../siliconflow.js';
import type { ChildProfile, IngredientItem, RecipeDetailRecipeInput } from '../data.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(scriptDir, '../../../.env') });
loadDotenv({ path: resolve(scriptDir, '../.env') });

type BenchmarkTask = 'recommendation' | 'steps';

interface RecommendationCase {
  id: string;
  task: 'recommendation';
  prompt: string;
  ingredients: IngredientItem[];
}

interface StepsCase {
  id: string;
  task: 'steps';
  ingredients: IngredientItem[];
  recipe: RecipeDetailRecipeInput;
}

type BenchmarkCase = RecommendationCase | StepsCase;

interface RunResult {
  model: string;
  caseId: string;
  task: BenchmarkTask;
  promptVersion: string;
  attempt: number;
  success: boolean;
  jsonParseSuccess: boolean;
  durationMs: number;
  modelDurationMs: number | null;
  timeoutMs: number;
  totalTokens: number | null;
  timeout: boolean;
  error: string | null;
}

const defaultModels = ['Qwen/Qwen3.5-9B'];
const defaultAttempts = 1;
const promptVersions: Record<BenchmarkTask, string> = {
  recommendation: 'compact-v1',
  steps: 'guided-v1',
};
const defaultProfile: ChildProfile = {
  id: 'benchmark_profile',
  nickname: '小学阶段学生',
  age: 8,
  tastePreferences: ['低油脂', '轻口味', '膳食均衡'],
  allergens: [],
  dietaryHabits: ['低油脂', '轻口味', '膳食均衡'],
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readNumberArg(name: string, fallback: number) {
  const raw = readArg(name);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseCsvArg(name: string, fallback: string[]) {
  const raw = readArg(name);
  if (!raw) {
    return fallback;
  }

  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function ingredient(name: string, quantity = '1份'): IngredientItem {
  return {
    id: `bench_ing_${name}`,
    name,
    normalizedName: name,
    quantity,
    source: 'manual',
  };
}

function recipe(name: string, ingredients: IngredientItem[]): RecipeDetailRecipeInput {
  return {
    id: `benchmark_recipe_${name}`,
    name,
    englishName: '',
    ageRange: '7-12 岁',
    difficulty: ingredients.length >= 5 ? 'medium' : 'easy',
    estimatedTimeMinutes: ingredients.length >= 5 ? 25 : 15,
    riskAlerts: [],
    nutritionSummary: '',
    canCookWithCurrentIngredients: true,
  };
}

const recommendationCases: RecommendationCase[] = [
  { id: 'rec_01_tomato_egg_exact', task: 'recommendation', prompt: '推荐简单家常菜', ingredients: [ingredient('番茄'), ingredient('鸡蛋')] },
  { id: 'rec_02_chicken_exact', task: 'recommendation', prompt: '推荐清爽一点的菜', ingredients: [ingredient('鸡肉', '150克')] },
  { id: 'rec_03_chicken_extra', task: 'recommendation', prompt: '适合孩子午餐', ingredients: [ingredient('鸡肉'), ingredient('黄瓜'), ingredient('胡萝卜')] },
  { id: 'rec_04_tomato_egg_extra', task: 'recommendation', prompt: '希望营养均衡', ingredients: [ingredient('番茄'), ingredient('鸡蛋'), ingredient('土豆')] },
  { id: 'rec_05_potato_carrot', task: 'recommendation', prompt: '低油轻口味', ingredients: [ingredient('土豆'), ingredient('胡萝卜')] },
  { id: 'rec_06_tofu_green', task: 'recommendation', prompt: '晚餐不要太油', ingredients: [ingredient('豆腐'), ingredient('青菜')] },
  { id: 'rec_07_shrimp_corn', task: 'recommendation', prompt: '适合小学生参与', ingredients: [ingredient('虾仁'), ingredient('玉米'), ingredient('豌豆')] },
  { id: 'rec_08_beef_onion', task: 'recommendation', prompt: '口味温和一点', ingredients: [ingredient('牛肉'), ingredient('洋葱'), ingredient('彩椒')] },
  { id: 'rec_09_fish_mushroom', task: 'recommendation', prompt: '少刺少油', ingredients: [ingredient('鱼片'), ingredient('香菇'), ingredient('西兰花')] },
  { id: 'rec_10_cucumber_egg', task: 'recommendation', prompt: '快手早餐', ingredients: [ingredient('黄瓜'), ingredient('鸡蛋')] },
  { id: 'rec_11_pumpkin_milk', task: 'recommendation', prompt: '软糯一点', ingredients: [ingredient('南瓜'), ingredient('牛奶')] },
  { id: 'rec_12_multi_veg', task: 'recommendation', prompt: '多蔬菜搭配', ingredients: [ingredient('西兰花'), ingredient('胡萝卜'), ingredient('玉米'), ingredient('鸡蛋')] },
  { id: 'rec_13_allergen_note', task: 'recommendation', prompt: '孩子花生过敏，不要坚果', ingredients: [ingredient('鸡蛋'), ingredient('菠菜'), ingredient('米饭')] },
  { id: 'rec_14_soup', task: 'recommendation', prompt: '想喝汤', ingredients: [ingredient('番茄'), ingredient('豆腐'), ingredient('金针菇')] },
  { id: 'rec_15_leftover_rice', task: 'recommendation', prompt: '用剩米饭做简单主食', ingredients: [ingredient('米饭'), ingredient('鸡蛋'), ingredient('青豆')] },
];

const stepsCases: StepsCase[] = [
  { id: 'step_01_hand_shredded_chicken', task: 'steps', ingredients: [ingredient('鸡肉'), ingredient('黄瓜'), ingredient('胡萝卜'), ingredient('香菜')], recipe: recipe('凉拌手撕鸡', [ingredient('鸡肉'), ingredient('黄瓜'), ingredient('胡萝卜'), ingredient('香菜')]) },
  { id: 'step_02_tomato_egg', task: 'steps', ingredients: [ingredient('番茄'), ingredient('鸡蛋')], recipe: recipe('番茄炒蛋', [ingredient('番茄'), ingredient('鸡蛋')]) },
  { id: 'step_03_potato_carrot_stew', task: 'steps', ingredients: [ingredient('土豆'), ingredient('胡萝卜')], recipe: recipe('土豆胡萝卜炖菜', [ingredient('土豆'), ingredient('胡萝卜')]) },
  { id: 'step_04_tofu_green_soup', task: 'steps', ingredients: [ingredient('豆腐'), ingredient('青菜')], recipe: recipe('青菜豆腐汤', [ingredient('豆腐'), ingredient('青菜')]) },
  { id: 'step_05_shrimp_corn', task: 'steps', ingredients: [ingredient('虾仁'), ingredient('玉米'), ingredient('豌豆')], recipe: recipe('玉米虾仁', [ingredient('虾仁'), ingredient('玉米'), ingredient('豌豆')]) },
  { id: 'step_06_beef_onion', task: 'steps', ingredients: [ingredient('牛肉'), ingredient('洋葱'), ingredient('彩椒')], recipe: recipe('洋葱彩椒牛肉', [ingredient('牛肉'), ingredient('洋葱'), ingredient('彩椒')]) },
  { id: 'step_07_fish_mushroom', task: 'steps', ingredients: [ingredient('鱼片'), ingredient('香菇'), ingredient('西兰花')], recipe: recipe('香菇西兰花鱼片', [ingredient('鱼片'), ingredient('香菇'), ingredient('西兰花')]) },
  { id: 'step_08_cucumber_egg', task: 'steps', ingredients: [ingredient('黄瓜'), ingredient('鸡蛋')], recipe: recipe('黄瓜炒鸡蛋', [ingredient('黄瓜'), ingredient('鸡蛋')]) },
  { id: 'step_09_pumpkin_milk', task: 'steps', ingredients: [ingredient('南瓜'), ingredient('牛奶')], recipe: recipe('南瓜牛奶羹', [ingredient('南瓜'), ingredient('牛奶')]) },
  { id: 'step_10_broccoli_carrot', task: 'steps', ingredients: [ingredient('西兰花'), ingredient('胡萝卜'), ingredient('玉米')], recipe: recipe('西兰花胡萝卜玉米粒', [ingredient('西兰花'), ingredient('胡萝卜'), ingredient('玉米')]) },
  { id: 'step_11_spinach_egg_rice', task: 'steps', ingredients: [ingredient('菠菜'), ingredient('鸡蛋'), ingredient('米饭')], recipe: recipe('菠菜鸡蛋拌饭', [ingredient('菠菜'), ingredient('鸡蛋'), ingredient('米饭')]) },
  { id: 'step_12_tomato_tofu_soup', task: 'steps', ingredients: [ingredient('番茄'), ingredient('豆腐'), ingredient('金针菇')], recipe: recipe('番茄豆腐金针菇汤', [ingredient('番茄'), ingredient('豆腐'), ingredient('金针菇')]) },
  { id: 'step_13_egg_fried_rice', task: 'steps', ingredients: [ingredient('米饭'), ingredient('鸡蛋'), ingredient('青豆')], recipe: recipe('青豆鸡蛋炒饭', [ingredient('米饭'), ingredient('鸡蛋'), ingredient('青豆')]) },
  { id: 'step_14_chicken_mushroom', task: 'steps', ingredients: [ingredient('鸡肉'), ingredient('香菇'), ingredient('胡萝卜')], recipe: recipe('香菇胡萝卜鸡肉丁', [ingredient('鸡肉'), ingredient('香菇'), ingredient('胡萝卜')]) },
  { id: 'step_15_egg_custard', task: 'steps', ingredients: [ingredient('鸡蛋'), ingredient('温水')], recipe: recipe('儿童蒸蛋羹', [ingredient('鸡蛋'), ingredient('温水')]) },
];

function getTotalTokens(metrics: SiliconFlowCallMetrics | null) {
  const usage = metrics?.usage ?? {};
  const value = usage.total_tokens ?? usage.totalTokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isTimeoutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /abort|timeout|timed out|超时/i.test(message);
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function average(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatNumber(value: number | null) {
  return value === null ? '-' : String(Math.round(value));
}

async function runCase(model: string, benchmarkCase: BenchmarkCase, attempt: number, timeoutMs: number): Promise<RunResult> {
  const metricsRef: { current: SiliconFlowCallMetrics | null } = { current: null };
  const startedAt = performance.now();

  try {
    if (benchmarkCase.task === 'recommendation') {
      await generateRecipePlan(defaultProfile, benchmarkCase.ingredients, benchmarkCase.prompt, {
        modelOverride: model,
        timeoutMs,
        onMetrics: (value) => {
          metricsRef.current = value;
        },
      });
    } else {
      await generateRecipeDetail(defaultProfile, benchmarkCase.ingredients, benchmarkCase.recipe, {
        modelOverride: model,
        timeoutMs,
        onMetrics: (value) => {
          metricsRef.current = value;
        },
      });
    }

    return {
      model,
      caseId: benchmarkCase.id,
      task: benchmarkCase.task,
      promptVersion: promptVersions[benchmarkCase.task],
      attempt,
      success: true,
      jsonParseSuccess: true,
      durationMs: performance.now() - startedAt,
      modelDurationMs: metricsRef.current?.durationMs ?? null,
      timeoutMs,
      totalTokens: getTotalTokens(metricsRef.current),
      timeout: false,
      error: null,
    };
  } catch (error) {
    const timeout = isTimeoutError(error);

    return {
      model,
      caseId: benchmarkCase.id,
      task: benchmarkCase.task,
      promptVersion: promptVersions[benchmarkCase.task],
      attempt,
      success: false,
      jsonParseSuccess: false,
      durationMs: performance.now() - startedAt,
      modelDurationMs: timeout ? timeoutMs : metricsRef.current?.durationMs ?? null,
      totalTokens: getTotalTokens(metricsRef.current),
      timeout,
      timeoutMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printSummary(results: RunResult[]) {
  const modelGroups = new Map<string, RunResult[]>();
  const groups = new Map<string, RunResult[]>();
  results.forEach((result) => {
    modelGroups.set(result.model, [...(modelGroups.get(result.model) ?? []), result]);
    const key = `${result.model}::${result.task}::${result.promptVersion}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  });

  const buildSummary = (model: string, items: RunResult[], task?: BenchmarkTask | 'all', version = 'mixed') => {
    const durations = items.map((item) => item.timeout ? item.timeoutMs : item.modelDurationMs ?? item.durationMs);
    const tokenValues = items
      .map((item) => item.totalTokens)
      .filter((value): value is number => typeof value === 'number');

    return {
      model,
      task: task ?? 'all',
      promptVersion: version,
      count: items.length,
      successRate: `${Math.round((items.filter((item) => item.success).length / items.length) * 100)}%`,
      timeoutRate: `${Math.round((items.filter((item) => item.timeout).length / items.length) * 100)}%`,
      jsonParseRate: `${Math.round((items.filter((item) => item.jsonParseSuccess).length / items.length) * 100)}%`,
      p50Ms: formatNumber(percentile(durations, 0.5)),
      p90Ms: formatNumber(percentile(durations, 0.9)),
      maxMs: formatNumber(Math.max(...durations)),
      avgTokens: formatNumber(average(tokenValues)),
    };
  };

  const modelSummary = [...modelGroups.entries()].map(([model, items]) => buildSummary(model, items, 'all'));
  const taskSummary = [...groups.entries()].map(([key, items]) => {
    const [model, task, version] = key.split('::') as [string, BenchmarkTask, string];
    return buildSummary(model, items, task, version);
  });

  console.log('\nModel comparison report:');
  console.table(modelSummary);
  console.log('\nTask comparison report:');
  console.table(taskSummary);

  const slowest = [...results]
    .sort((a, b) => (b.timeout ? b.timeoutMs : b.modelDurationMs ?? b.durationMs) - (a.timeout ? a.timeoutMs : a.modelDurationMs ?? a.durationMs))
    .slice(0, 10)
    .map((item) => ({
      model: item.model,
      task: item.task,
      promptVersion: item.promptVersion,
      caseId: item.caseId,
      attempt: item.attempt,
      success: item.success,
      timeout: item.timeout,
      durationMs: formatNumber(item.timeout ? item.timeoutMs : item.modelDurationMs ?? item.durationMs),
      wallClockMs: formatNumber(item.durationMs),
      tokens: item.totalTokens ?? '-',
      error: item.error ? item.error.slice(0, 100) : '',
    }));

  console.log('\nSlowest requests:');
  console.table(slowest);
}

async function main() {
  if (!isSiliconFlowConfigured()) {
    throw new Error('SILICONFLOW_API_KEY is required to run the LLM latency benchmark.');
  }

  const models = parseCsvArg('models', defaultModels);
  const attempts = readNumberArg('attempts', defaultAttempts);
  const timeoutMs = readNumberArg('timeout-ms', 30_000);
  const taskFilter = parseCsvArg('tasks', ['steps']);
  const caseLimit = readNumberArg('case-limit', Number.POSITIVE_INFINITY);
  const cases = [...recommendationCases, ...stepsCases]
    .filter((benchmarkCase) => taskFilter.includes(benchmarkCase.task))
    .slice(0, caseLimit);
  const results: RunResult[] = [];

  console.log(`Running LLM latency benchmark: promptVersions=${JSON.stringify(promptVersions)}, models=${models.join(', ')}, cases=${cases.length}, attempts=${attempts}, timeoutMs=${timeoutMs}`);

  for (const model of models) {
    for (const benchmarkCase of cases) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const result = await runCase(model, benchmarkCase, attempt, timeoutMs);
        results.push(result);
        console.log([
          result.success ? 'PASS' : 'FAIL',
          model,
          benchmarkCase.task,
          benchmarkCase.id,
          `attempt=${attempt}`,
          `durationMs=${formatNumber(result.modelDurationMs ?? result.durationMs)}`,
          `tokens=${result.totalTokens ?? '-'}`,
        ].join(' | '));
      }
    }
  }

  printSummary(results);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
