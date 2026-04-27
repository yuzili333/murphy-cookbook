import type { RecipeRecommendation } from '../types';

const toneMarks: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  v: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

function applyToneMark(syllable: string, tone: number) {
  if (tone < 1 || tone > 4) {
    return syllable.replace('v', 'ü');
  }

  const normalized = syllable.replace('u:', 'ü');
  const lower = normalized.toLowerCase();
  const priorityIndex =
    lower.indexOf('a') >= 0
      ? lower.indexOf('a')
      : lower.indexOf('e') >= 0
        ? lower.indexOf('e')
        : lower.includes('ou')
          ? lower.indexOf('o')
          : Math.max(lower.lastIndexOf('i'), lower.lastIndexOf('o'), lower.lastIndexOf('u'), lower.lastIndexOf('v'), lower.lastIndexOf('ü'));

  if (priorityIndex < 0) {
    return normalized;
  }

  const vowel = lower[priorityIndex];
  const marked = toneMarks[vowel]?.[tone - 1];
  if (!marked) {
    return normalized;
  }

  return `${normalized.slice(0, priorityIndex)}${marked}${normalized.slice(priorityIndex + 1)}`;
}

export function formatPinyin(pinyin: string) {
  return pinyin
    .split(/\s+/)
    .filter(Boolean)
    .map((syllable) => {
      const match = syllable.match(/^([a-züv:]+)([1-5])$/i);
      if (!match) {
        return syllable;
      }

      return applyToneMark(match[1], Number(match[2]));
    })
    .join(' ');
}

export function speak(text: string, lang: string) {
  if (!('speechSynthesis' in window)) {
    return;
  }

  stopSpeaking();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.85;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (!('speechSynthesis' in window)) {
    return;
  }

  window.speechSynthesis.cancel();
}

export function buildCharacterSpeech(character: RecipeRecommendation['nameLearning']['characters'][number]) {
  return `${character.character}，拼音 ${formatPinyin(character.pinyin)}，${character.strokes} 画，${character.structure}。${character.hint}`;
}
