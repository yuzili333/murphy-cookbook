import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIngredientTextInput } from '../../app.js';

test('resolveIngredientTextInput accepts mobile fallback fields', () => {
  assert.equal(resolveIngredientTextInput({ message: '鸡蛋 番茄' }), '鸡蛋 番茄');
  assert.equal(resolveIngredientTextInput({ prompt: ' 胡萝卜 ' }), '胡萝卜');
  assert.equal(resolveIngredientTextInput({ transcript: ['土豆', '牛肉'] }), '土豆 牛肉');
});

test('resolveIngredientTextInput returns empty string for missing text', () => {
  assert.equal(resolveIngredientTextInput({}), '');
  assert.equal(resolveIngredientTextInput(null), '');
});
