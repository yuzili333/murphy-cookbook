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

function parseLogDateInput(value?: string) {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const direct = Date.parse(normalized);
  if (Number.isFinite(direct)) {
    return direct;
  }

  const compactMatch = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::|[-])(\d{2})$/,
  );
  if (!compactMatch) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = compactMatch;
  const localDate = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  return Number.isNaN(localDate.getTime()) ? null : localDate.getTime();
}

function formatLogTimestamp(value: unknown) {
  const timestamp = typeof value === 'string' ? parseLogDateInput(value) : null;
  if (timestamp === null) {
    return typeof value === 'string' ? value : '';
  }

  const date = new Date(timestamp);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function readLocalLlmLogs(options: ReadLocalLlmLogsOptions = {}) {
  if (!existsSync(llmLogFile)) {
    return [];
  }

  const startTime = parseLogDateInput(options.start);
  const endTime = parseLogDateInput(options.end);
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
      const timestamp = typeof entry.timestamp === 'string' ? parseLogDateInput(entry.timestamp) : null;
      const raw = JSON.stringify(entry).toLowerCase();

      if (keyword && !raw.includes(keyword)) {
        return false;
      }

      if (startTime !== null && (timestamp === null || timestamp < startTime)) {
        return false;
      }

      if (endTime !== null && (timestamp === null || timestamp > endTime)) {
        return false;
      }

      return true;
    });

  return entries
    .sort((left, right) => {
      const leftTime = typeof left.timestamp === 'string' ? parseLogDateInput(left.timestamp) ?? 0 : 0;
      const rightTime = typeof right.timestamp === 'string' ? parseLogDateInput(right.timestamp) ?? 0 : 0;
      return rightTime - leftTime;
    })
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      timestamp: formatLogTimestamp(entry.timestamp),
    }));
}
