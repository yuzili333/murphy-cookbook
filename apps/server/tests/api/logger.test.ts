import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLocalLlmLogFilePath, readLocalLlmLogs } from '../../logger.js';

const logFile = getLocalLlmLogFilePath();
const logDir = dirname(logFile);
const originalLogExists = existsSync(logFile);
const originalLogContent = originalLogExists ? readFileSync(logFile, 'utf8') : null;

function formatLocalTimestamp(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function getField(entry: Record<string, unknown> | undefined, key: string) {
  return entry?.[key];
}

before(() => {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    logFile,
    [
      JSON.stringify({
        operation: 'recipe_recommendation',
        status: 'success',
        timestamp: '2026-04-24T08:15:00.000Z',
        requestSummary: { keyword: '番茄' },
      }),
      JSON.stringify({
        operation: 'image_understanding',
        status: 'success',
        timestamp: '2026-04-24T09:30:00.000Z',
        requestSummary: { keyword: '黄瓜' },
      }),
      JSON.stringify({
        operation: 'cooking_feedback',
        status: 'error',
        timestamp: '2026-04-24T10:45:00.000Z',
        requestSummary: { keyword: '鸡蛋' },
      }),
    ].join('\n') + '\n',
    'utf8',
  );
});

after(() => {
  if (originalLogExists && originalLogContent !== null) {
    writeFileSync(logFile, originalLogContent, 'utf8');
    return;
  }

  rmSync(logFile, { force: true });
});

test('readLocalLlmLogs returns logs sorted by timestamp descending and formatted for display', () => {
  const logs = readLocalLlmLogs({ limit: 3 });

  assert.equal(logs.length, 3);
  assert.equal(getField(logs[0], 'operation'), 'cooking_feedback');
  assert.equal(logs[0]?.timestamp, formatLocalTimestamp('2026-04-24T10:45:00.000Z'));
  assert.equal(getField(logs[1], 'operation'), 'image_understanding');
  assert.equal(logs[1]?.timestamp, formatLocalTimestamp('2026-04-24T09:30:00.000Z'));
  assert.equal(getField(logs[2], 'operation'), 'recipe_recommendation');
  assert.equal(logs[2]?.timestamp, formatLocalTimestamp('2026-04-24T08:15:00.000Z'));
});

test('readLocalLlmLogs filters by time range before sorting', () => {
  const logs = readLocalLlmLogs({
    start: '2026-04-24T09:00:00.000Z',
    end: '2026-04-24T09:59:59.000Z',
  });

  assert.equal(logs.length, 1);
  assert.equal(getField(logs[0], 'operation'), 'image_understanding');
  assert.equal(logs[0]?.timestamp, formatLocalTimestamp('2026-04-24T09:30:00.000Z'));
});

test('readLocalLlmLogs supports keyword filtering together with time range', () => {
  const logs = readLocalLlmLogs({
    start: '2026-04-24T08:00:00.000Z',
    end: '2026-04-24T11:00:00.000Z',
    keyword: '黄瓜',
  });

  assert.equal(logs.length, 1);
  assert.equal(getField(logs[0], 'operation'), 'image_understanding');
});
