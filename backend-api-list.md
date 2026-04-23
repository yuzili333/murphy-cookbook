# Murphy's Cookbook 后端接口清单

## 1. 文档目的
本文档定义 Murphy's Cookbook MVP 阶段所需的核心后端接口、请求响应结构和关键业务规则，供服务端开发和前后端联调使用。

## 2. 接口设计原则
1. 围绕 MVP 闭环设计，不做超前扩展。
2. 所有推荐逻辑必须包含年龄、过敏原、口味偏好、饮食习惯。
3. 所有安全提示必须结构化返回。
4. 所有异常场景必须可识别、可兜底。

## 3. 核心数据对象

### 3.1 ChildProfile
- `id`
- `nickname`
- `age`
- `tastePreferences`
- `allergens`
- `dietaryHabits`
- `updatedAt`

### 3.2 Ingredient
- `id`
- `name`
- `normalizedName`
- `quantity`
- `source`
- `confidence`

### 3.3 RecipeRecommendation
- `id`
- `name`
- `ageRange`
- `difficulty`
- `estimatedTimeMinutes`
- `fitReasons`
- `riskAlerts`
- `nutritionSummary`
- `canCookWithCurrentIngredients`

### 3.4 RecipeDetail
- `id`
- `name`
- `heroImage`
- `ageRange`
- `difficulty`
- `prepTimeMinutes`
- `cookTimeMinutes`
- `ingredients`
- `steps`
- `nutrition`
- `safetyAlerts`

## 4. 接口列表

### 4.1 创建儿童档案
- `POST /api/v1/child-profiles`

请求体：
```json
{
  "nickname": "Murphy",
  "age": 8,
  "tastePreferences": ["light", "sweet-corn-like"],
  "allergens": ["peanut"],
  "dietaryHabits": ["low-salt"]
}
```

响应体：
```json
{
  "data": {
    "id": "cp_001",
    "nickname": "Murphy",
    "age": 8,
    "tastePreferences": ["light", "sweet-corn-like"],
    "allergens": ["peanut"],
    "dietaryHabits": ["low-salt"],
    "updatedAt": "2026-04-23T09:00:00Z"
  }
}
```

### 4.2 查询儿童档案列表
- `GET /api/v1/child-profiles`

### 4.3 更新儿童档案
- `PATCH /api/v1/child-profiles/:profileId`

### 4.4 上传食材图片并识别
- `POST /api/v1/ingredients/recognize-image`

请求体：
- `multipart/form-data`
- 字段：`image`

响应体：
```json
{
  "data": {
    "ingredients": [
      {
        "id": "ing_001",
        "name": "西红柿",
        "normalizedName": "番茄",
        "quantity": null,
        "source": "image",
        "confidence": 0.93
      }
    ]
  }
}
```

### 4.5 语音食材转写与解析
- `POST /api/v1/ingredients/parse-voice`

请求体：
```json
{
  "audioUrl": "https://example.com/audio.wav"
}
```

### 4.6 文本食材解析
- `POST /api/v1/ingredients/parse-text`

请求体：
```json
{
  "text": "两个鸡蛋，一个番茄，半根黄瓜"
}
```

### 4.7 提交确认后的食材并获取推荐
- `POST /api/v1/recommendations/recipes`

请求体：
```json
{
  "profileId": "cp_001",
  "ingredients": [
    {
      "name": "番茄",
      "normalizedName": "番茄",
      "quantity": "1个",
      "source": "manual"
    },
    {
      "name": "鸡蛋",
      "normalizedName": "鸡蛋",
      "quantity": "2个",
      "source": "voice"
    }
  ],
  "sortBy": "balanced",
  "allowExtraIngredients": true
}
```

响应体：
```json
{
  "data": {
    "recipes": [
      {
        "id": "recipe_001",
        "name": "番茄鸡蛋面",
        "ageRange": "7-12",
        "difficulty": "easy",
        "estimatedTimeMinutes": 20,
        "fitReasons": ["使用现有食材", "口味清淡", "适合 8 岁儿童参与"],
        "riskAlerts": ["煮面和开火步骤需要家长陪同"],
        "nutritionSummary": "含蛋白质和碳水，适合作为一餐主食",
        "canCookWithCurrentIngredients": true
      }
    ],
    "filteredAllergens": [],
    "sortBy": "balanced"
  }
}
```

业务规则：
- `profileId` 必填
- 必须基于档案中的过敏原进行过滤
- 若无完全匹配菜谱，可返回“补充少量食材后可制作”的结果

### 4.8 查询菜谱详情
- `GET /api/v1/recipes/:recipeId`

响应体：
```json
{
  "data": {
    "id": "recipe_001",
    "name": "番茄鸡蛋面",
    "heroImage": "/mock/recipe-tomato-egg-noodle.png",
    "ageRange": "7-12",
    "difficulty": "easy",
    "prepTimeMinutes": 5,
    "cookTimeMinutes": 15,
    "ingredients": [
      {
        "name": "番茄",
        "quantity": "1个"
      }
    ],
    "steps": [
      {
        "id": "step_1",
        "title": "切番茄",
        "description": "把番茄切成小块",
        "riskLevel": "medium",
        "requiresParentAssist": true,
        "tip": "切的时候慢一点，手指要离刀远一点"
      }
    ],
    "nutrition": {
      "summary": "适合儿童的一餐主食"
    },
    "safetyAlerts": ["刀具步骤需要家长陪同"]
  }
}
```

### 4.9 提交成果并生成点评
- `POST /api/v1/cooking-feedback`

请求体：
```json
{
  "profileId": "cp_001",
  "recipeId": "recipe_001",
  "imageUrl": "https://example.com/result.jpg",
  "tasteFeedback": "很好吃",
  "difficultyFeedback": "煮面的时候有点难"
}
```

响应体：
```json
{
  "data": {
    "praise": "颜色搭配很棒，看起来很有食欲",
    "improvement": "下次可以把番茄切得更均匀一些",
    "nextSuggestion": "你可以尝试做另一道类似的鸡蛋料理"
  }
}
```

### 4.10 查询最近烹饪记录
- `GET /api/v1/history/recent-cooked`

## 5. 错误码建议
- `INVALID_ARGUMENT`
- `PROFILE_NOT_FOUND`
- `INGREDIENT_PARSE_FAILED`
- `IMAGE_RECOGNITION_FAILED`
- `NO_RECIPE_MATCHED`
- `RECIPE_NOT_FOUND`
- `FEEDBACK_GENERATION_FAILED`

## 6. 典型异常场景
1. 图片上传成功但未识别到有效食材。
2. 语音转写失败或内容不完整。
3. 用户档案缺少过敏原信息。
4. 食材与饮食限制冲突导致无推荐结果。
5. 菜谱详情存在高风险步骤，需要前端显著展示。

## 7. 联调建议
- 第一阶段以 mock API 固定返回结构联调前端。
- 第二阶段替换识别和推荐接口的内部实现，但尽量不变更外层返回结构。
