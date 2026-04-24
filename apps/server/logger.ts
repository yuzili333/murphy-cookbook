import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const localLogDir = resolve(process.cwd(), '.local', 'logs');
const llmLogFile = resolve(localLogDir, 'llm-calls.log');

export function shouldUseLocalDebugLog() {
  return !(
    process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT ||
    process.env.NODE_ENV === 'production'
  );
}

function ensureLogDir() {
  if (!existsSync(localLogDir)) {
    mkdirSync(localLogDir, { recursive: true });
  }
}

export function writeLocalJsonLog(entry: Record<string, unknown>) {
  if (!shouldUseLocalDebugLog()) {
    return;
  }

  ensureLogDir();
  appendFileSync(
    llmLogFile,
    `${JSON.stringify({
      ...entry,
      timestamp: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
}

export function getLocalLlmLogFilePath() {
  return llmLogFile;
}

export interface ReadLocalLlmLogsOptions {
  start?: string;
  end?: string;
  keyword?: string;
  limit?: number;
}

export function readLocalLlmLogs(options: ReadLocalLlmLogsOptions = {}) {
  if (!existsSync(llmLogFile)) {
    return [];
  }

  const startTime = options.start ? Date.parse(options.start) : null;
  const endTime = options.end ? Date.parse(options.end) : null;
  const keyword = options.keyword?.trim().toLowerCase() ?? '';
  const limit = Math.max(1, Math.min(Number(options.limit ?? 200), 500));

  const lines = readFileSync(llmLogFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => {
      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      const raw = JSON.stringify(entry).toLowerCase();

      if (startTime && Number.isFinite(timestamp) && timestamp < startTime) {
        return false;
      }

      if (endTime && Number.isFinite(timestamp) && timestamp > endTime) {
        return false;
      }

      if (keyword && !raw.includes(keyword)) {
        return false;
      }

      return true;
    })
    .slice(-limit)
    .reverse();

  return entries;
}
