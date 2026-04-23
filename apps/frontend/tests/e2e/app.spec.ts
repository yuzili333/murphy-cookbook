import { test, expect } from '@playwright/test';

test('text ingredient flow reaches recommendation list', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('开始输入食材')).toBeVisible();
  await page.getByRole('button', { name: '开始输入食材' }).click();

  await page.getByPlaceholder('例如：两个鸡蛋 一个番茄 半根黄瓜').fill('两个鸡蛋 一个番茄');
  await page.getByRole('button', { name: '解析' }).click();

  await expect(page.getByText('2 项待确认')).toBeVisible();
  await page.getByRole('button', { name: '继续确认识别结果' }).click();
  await page.getByRole('button', { name: '开始推荐菜谱' }).click();

  await expect(page.getByText('推荐给 Murphy 的儿童菜谱')).toBeVisible();
  await expect(page.getByText('番茄鸡蛋面')).toBeVisible();
});
