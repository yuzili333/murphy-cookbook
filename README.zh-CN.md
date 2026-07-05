# Murphy's Cookbook

Murphy's Cookbook 是面向小学 1-6 年级儿童及家庭的儿童菜谱智能体。用户可以通过文字、语音、拍照或上传图片提供食材，系统先识别并展示可确认的食材清单，再由大模型流式推荐适合儿童的菜谱，并按需生成详细烹饪步骤。

项目重点不是简单生成菜谱，而是把多模态食材识别、AI 推荐、步骤生成、食材科普、语音朗读、双语学习、菜名识字、收藏复访和 Seedance 2.0 烹饪视频播放整合成一个儿童友好的 chatbox 智能体。

## 核心能力

- **儿童友好 Chatbox**：开屏故事板、固定顶部导航和底部输入栏，移动端优先。
- **多模态食材输入**：支持文字、浏览器语音、拍照、上传图片。
- **食材清单确认**：识别后不自动推荐，先展示横向食材卡，支持 emoji、拼音、朗读、删除和继续添加。
- **食材小百科**：点击食材生成营养价值、产地、适宜气候、最佳搭配、儿童趣味说明和安全提示。
- **流式菜谱推荐**：用户点击“推荐菜谱”后，通过 SSE 返回文本增量和菜谱卡片。
- **按需烹饪步骤**：用户在菜谱卡片内手动获取步骤，步骤包含描述、小贴士、儿童动作、家长动作、风险等级和完成状态。
- **中英文与拼音模式**：支持中文/英文界面切换，拼音或英文读音提示可按需开启。
- **语音朗读**：食材、菜名、摘要、注意事项、用量、步骤、助手消息等均可朗读，再次点击可中断。
- **菜名识字**：点击中文菜名后展示单字、带调号拼音、笔画数、结构说明和儿童化解释。
- **收藏与历史对话**：本地保存最近对话、收藏菜谱、推荐结果和步骤缓存。
- **Seedance 2.0 视频能力**：烹饪视频不实时生成，采用 AI 辅助离线生成、人工审核、服务端登记、前端确定性匹配播放。
- **视频配置管理**：`/cookbook-video-config` 提供已审核菜谱视频的新增、编辑、删除、筛选和分页管理。

## 产品流程

```text
开屏页
-> Chatbox 首页
-> 输入文字/语音/图片食材
-> AI 识别食材
-> 用户确认食材清单
-> 查看食材小百科或继续添加
-> 手动触发菜谱推荐
-> 浏览菜谱走马灯卡片
-> 按需生成烹饪步骤
-> 朗读、收藏、查看视频、恢复历史对话
```

默认服务对象为小学阶段学生。菜谱推荐倾向低油脂、轻口味、膳食均衡、维生素丰富和搭配均衡。只有当用户明确提及重度急性过敏、过敏性休克、呼吸困难等高风险场景时，系统才主动提示补充过敏信息。

## 技术架构

```text
React Chatbox 前端
  -> Node.js / Express / Netlify Functions Agent 编排层
  -> ModelRouter 按任务选择模型
  -> 文本食材解析 / 图片识别 / 菜谱推荐 / 步骤生成 / 食材知识
  -> SSE 流式返回
  -> localStorage 缓存历史、收藏、步骤、知识和视频匹配
  -> Seedance 2.0 离线视频资源匹配播放
```

关键设计：

- **ModelRouter**：按任务选择文本模型、多模态模型、轻量模型、平衡模型或兜底模型，避免所有任务都使用重模型。
- **流式输出**：推荐菜谱和烹饪步骤优先走 SSE，降低等待焦虑。
- **按需生成**：推荐和步骤拆分，首屏只返回菜谱卡片，步骤由用户手动触发。
- **本地缓存**：步骤详情、食材知识、视频匹配、历史对话和收藏均保存在浏览器本地。
- **视频可控**：视频由 Seedance 2.0 离线生成并人工审核，前端只播放已登记的审核资源。
- **异常恢复**：模型异常、超时、详情失败、知识获取失败和视频未命中均有明确状态与重试入口。

更完整的图形化技术报告见：

- [智能体技术架构报告 HTML](competition/agent-technical-architecture-report.html)
- [智能体技术架构报告 PPT](competition/agent-technical-architecture-report.pptx)
- [产品演示报告 HTML](competition/product-demo-report.html)
- [产品演示报告 PDF](competition/product-demo-report.pdf)
- [产品演示报告 PPT](competition/product-demo-report.pptx)

## 项目结构

```text
apps/frontend/              React + TypeScript 前端应用
apps/server/                Node.js / Express / Netlify Functions 服务端
competition/                参赛材料、产品演示报告、技术架构报告
docs/                       部署与项目说明
video-design/               Seedance / 即梦视频生成方案与角色素材
frontend-prd.md             前端 PRD 与验收范围
stream-message-ast.md       流式输出渲染架构说明
```

## 本地开发

### 环境要求

- Node.js `>=20.19.0`
- pnpm `10.26.0`

### 安装依赖

```bash
pnpm install
```

### 配置环境变量

```bash
cp .env.example .env
```

关键变量：

```text
VITE_API_BASE_URL=/api/v1
VITE_DEV_API_PROXY_TARGET=http://localhost:3001
PORT=3001
SILICONFLOW_API_KEY=
MODEL_FAST=Qwen/Qwen3.5-9B
MODEL_BALANCED=Qwen/Qwen3.5-27B
MODEL_INGREDIENT_TEXT=Qwen/Qwen3.5-9B
MODEL_VISION=Qwen/Qwen2.5-VL-7B-Instruct
MODEL_VISION_FALLBACK=Qwen/Qwen2.5-VL-32B-Instruct
MODEL_FALLBACK=Pro/zai-org/GLM-5
RECIPE_RECOMMENDATION_MODEL_TIMEOUT_MS=120000
RECIPE_DETAIL_MODEL_TIMEOUT_MS=60000
```

视频配置管理可选变量：

```text
VIDEO_CONFIG_ADMIN_USER=
VIDEO_CONFIG_ADMIN_PASSWORD=
VIDEO_CONFIG_TOKEN_SECRET=
MONGODB_URI=
MONGODB_DB_NAME=murphy_cookbook
RECIPE_VIDEO_MONGODB_COLLECTION=recipe_videos
```

### 启动开发服务

分别启动前端和服务端：

```bash
pnpm run dev:server
pnpm run dev:frontend
```

如需本地 HTTPS：

```bash
pnpm run dev:frontend:https
```

### 构建与测试

```bash
pnpm run build
pnpm run test:api
pnpm run test:e2e
pnpm run benchmark:llm-latency
```

## 主要接口

### 食材与知识

- `POST /api/v1/ingredients/parse-text`
- `POST /api/v1/ingredients/recognize-image`
- `POST /api/v1/ingredients/seasonal-suggestions`
- `POST /api/v1/ingredients/knowledge`

### 菜谱推荐与详情

- `POST /api/v1/recommendations/recipes`
- `POST /api/v1/recommendations/recipes/stream`
- `POST /api/v1/recipes/detail`
- `POST /api/v1/recipes/detail/stream`

### 烹饪视频

- `POST /api/v1/recipe-videos/match`
- `POST /api/v1/video-config/auth`
- `GET /api/v1/video-config/recipes`
- `POST /api/v1/video-config/recipes`
- `PUT /api/v1/video-config/recipes/:id`
- `DELETE /api/v1/video-config/recipes/:id`

## 本地数据与缓存

前端使用 `localStorage` 保存：

- 当前对话消息
- 最近 30 条历史对话
- 单会话最近 40 条消息
- 当前食材清单
- 收藏菜谱
- 最近推荐结果
- 菜谱步骤详情缓存，默认 3 天
- 食材知识缓存，默认 3 天
- 视频匹配缓存，默认 3 天
- 语言选择、拼音模式和开屏状态

视频配置页管理员 token 使用 `sessionStorage` 临时保存。

## 测试重点

- 移动端 Safari 文字和语音输入提交。
- 图片输入预览不撑破 chatbox。
- 食材列表和菜谱列表横向滑动不触发浏览器后退。
- 推荐按钮 loading 不造成布局跳动。
- 菜谱卡片中食材和用量不出现竖排文字。
- 烹饪步骤失败时显示 toast、失败提示和“再次获取”。
- 英文模式下推荐、步骤和食材知识均跟随语言输出。
- Seedance 视频只匹配已审核资源，未命中时展示占位。

## 参考文档

- [前端 PRD](frontend-prd.md)
- [技术架构报告](competition/agent-technical-architecture-report.html)
- [流式输出渲染方案](stream-message-ast.md)
- [视频生成技术方案](video-design/视频生成技术方案.md)
- [Seedance Prompt Skill](video-design/seedance-prompt-skill/SKILL.md)

## 安全说明

- 不要提交真实 API Key、管理员密码或生产环境 token。
- `.env.example` 只保留变量名和默认安全值。
- 视频资源必须经过人工审核后再登记到配置页。
- 儿童烹饪步骤中涉及明火、高温、热油、蒸煮、烤箱、微波炉等高风险操作时，必须提示家长陪同。

