import { MongoClient, ServerApiVersion, type Collection, type MongoClientOptions } from 'mongodb';
import type { ModelTask } from './modelRouter.js';

export interface LlmCallMetricInput {
  operation: string;
  task: ModelTask;
  model: string;
  promptVersion: string;
  durationMs: number;
  timeout: boolean;
  success: boolean;
  finishReason?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  recipeName?: string;
  ingredientCount?: number;
  stepCount?: number;
  parseSuccess?: boolean;
  error?: string;
}

export interface LlmMetricSummaryOptions {
  hours?: number;
  task?: ModelTask | '';
  model?: string;
  promptVersion?: string;
}

interface LlmCallMetricDocument extends LlmCallMetricInput {
  createdAt: string;
}

let mongoClientPromise: Promise<MongoClient> | null = null;
let indexesReadyPromise: Promise<void> | null = null;

function parseOptionalBoolean(value: string | undefined) {
  const normalized = value?.trim().toLocaleLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function isLlmMetricsDisabled() {
  return parseOptionalBoolean(process.env.LLM_METRICS_DISABLED) === true || process.env.NODE_ENV === 'test';
}

function getMongoUri() {
  if (isLlmMetricsDisabled()) {
    return '';
  }

  return (process.env.LLM_METRICS_MONGODB_URI || process.env.MONGODB_URI || '').trim();
}

function getMongoDatabaseName() {
  return (process.env.LLM_METRICS_MONGODB_DB || process.env.MONGODB_DB_NAME || 'murphy_cookbook').trim();
}

function getMongoCollectionName() {
  return (process.env.LLM_METRICS_MONGODB_COLLECTION || 'llm_call_metrics').trim();
}

function getMongoServerSelectionTimeoutMs() {
  const value = Number(process.env.LLM_METRICS_MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 3000);
  return Number.isFinite(value) && value > 0 ? value : 3000;
}

function resolveMongoFamily(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.LLM_METRICS_MONGODB_FAMILY ?? env.MONGODB_FAMILY ?? 4);
  return value === 6 ? 6 : 4;
}

function shouldUseMongoTls(uri: string) {
  const explicit = parseOptionalBoolean(process.env.LLM_METRICS_MONGODB_TLS ?? process.env.MONGODB_TLS);
  if (explicit !== null) {
    return explicit;
  }

  return uri.startsWith('mongodb+srv://') || uri.includes('.mongodb.net');
}

function createMongoClientOptions(uri: string): MongoClientOptions {
  const options: MongoClientOptions = {
    serverSelectionTimeoutMS: getMongoServerSelectionTimeoutMs(),
    maxPoolSize: 2,
    family: resolveMongoFamily(),
    retryReads: true,
    retryWrites: true,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: false,
    },
  };

  if (shouldUseMongoTls(uri)) {
    options.tls = true;
  }

  return options;
}

async function getMongoClient() {
  const uri = getMongoUri();
  if (!uri) {
    return null;
  }

  if (!mongoClientPromise) {
    mongoClientPromise = new MongoClient(uri, createMongoClientOptions(uri)).connect().catch((error) => {
      mongoClientPromise = null;
      indexesReadyPromise = null;
      throw error;
    });
  }

  return mongoClientPromise;
}

async function getMetricCollection(): Promise<Collection<LlmCallMetricDocument> | null> {
  const client = await getMongoClient();
  if (!client) {
    return null;
  }

  const collection = client.db(getMongoDatabaseName()).collection<LlmCallMetricDocument>(getMongoCollectionName());
  if (!indexesReadyPromise) {
    indexesReadyPromise = Promise.all([
      collection.createIndex({ createdAt: -1 }),
      collection.createIndex({ task: 1, model: 1, promptVersion: 1, createdAt: -1 }),
    ]).then(() => undefined);
  }
  await indexesReadyPromise;

  return collection;
}

function toFiniteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function resolveLlmMetricsMongoRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const uri = (env.LLM_METRICS_MONGODB_URI || env.MONGODB_URI || '').trim();
  const explicitTls = parseOptionalBoolean(env.LLM_METRICS_MONGODB_TLS ?? env.MONGODB_TLS);
  const tls = explicitTls ?? (uri ? uri.startsWith('mongodb+srv://') || uri.includes('.mongodb.net') : false);

  return {
    configured: Boolean(uri),
    scheme: uri.startsWith('mongodb+srv://') ? 'mongodb+srv' : uri.startsWith('mongodb://') ? 'mongodb' : '',
    atlasHost: uri.includes('.mongodb.net'),
    database: (env.LLM_METRICS_MONGODB_DB || env.MONGODB_DB_NAME || 'murphy_cookbook').trim(),
    collection: (env.LLM_METRICS_MONGODB_COLLECTION || 'llm_call_metrics').trim(),
    serverSelectionTimeoutMs: Number(env.LLM_METRICS_MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 3000) || 3000,
    tls,
    family: resolveMongoFamily(env),
  };
}

export async function recordLlmCallMetric(input: LlmCallMetricInput) {
  if (isLlmMetricsDisabled()) {
    return;
  }

  try {
    const collection = await getMetricCollection();
    if (!collection) {
      return;
    }

    await collection.insertOne({
      ...input,
      durationMs: Math.max(0, Number(input.durationMs) || 0),
      promptTokens: toFiniteNumber(input.promptTokens),
      completionTokens: toFiniteNumber(input.completionTokens),
      totalTokens: toFiniteNumber(input.totalTokens),
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Metrics must never fail user-facing model generation.
  }
}

export async function getLlmMetricSummary(options: LlmMetricSummaryOptions = {}) {
  const collection = await getMetricCollection();
  if (!collection) {
    return [];
  }

  const hours = Math.max(1, Math.min(Number(options.hours ?? 24), 168));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const filter: Record<string, unknown> = { createdAt: { $gte: since } };
  if (options.task) filter.task = options.task;
  if (options.model) filter.model = options.model;
  if (options.promptVersion) filter.promptVersion = options.promptVersion;

  const documents = await collection
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(5000)
    .toArray();
  const groups = new Map<string, LlmCallMetricDocument[]>();

  documents.forEach((item) => {
    const key = `${item.task}::${item.model}::${item.promptVersion}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  });

  return [...groups.entries()].map(([key, items]) => {
    const [task, model, promptVersion] = key.split('::');
    const durations = items.map((item) => item.timeout ? 30_000 : item.durationMs);
    const tokenValues = items
      .map((item) => item.totalTokens)
      .filter((value): value is number => typeof value === 'number');

    return {
      task,
      model,
      promptVersion,
      count: items.length,
      successRate: items.filter((item) => item.success).length / items.length,
      timeoutRate: items.filter((item) => item.timeout).length / items.length,
      parseSuccessRate: items.filter((item) => item.parseSuccess !== false).length / items.length,
      p50Ms: percentile(durations, 0.5),
      p90Ms: percentile(durations, 0.9),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.length ? Math.max(...durations) : null,
      avgTokens: average(tokenValues),
    };
  });
}

export async function closeLlmMetricsMongoConnectionForTest() {
  if (mongoClientPromise) {
    const client = await mongoClientPromise;
    await client.close();
  }
  mongoClientPromise = null;
  indexesReadyPromise = null;
}
