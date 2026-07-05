# Murphy's Cookbook

Murphy's Cookbook is a kid-friendly cooking recipe agent for elementary-school children and families. Users can describe ingredients with text, voice, camera, or image upload. The system recognizes ingredients first, lets users confirm the ingredient list, streams child-friendly recipe recommendations, and generates detailed cooking steps on demand.

This project is not a plain recipe generator. It combines multimodal ingredient recognition, AI recipe recommendation, cooking step generation, ingredient knowledge cards, speech playback, bilingual learning, Chinese recipe-name literacy, favorites, conversation history, and Seedance 2.0 cooking video playback into one child-friendly chatbox agent.

## Core Features

- **Kid-friendly chatbox**: storyboard opening screen, fixed top navigation, fixed bottom input, and mobile-first interaction.
- **Multimodal ingredient input**: text, browser voice input, camera capture, and local image upload.
- **Ingredient confirmation**: recognized ingredients are shown before recommendation; cards support emoji, pinyin, speech playback, deletion, and adding more ingredients.
- **Ingredient knowledge cards**: nutrition values, origin, growing climate, best pairings, kid-friendly facts, and safety notes.
- **Streaming recipe recommendation**: users click the recommendation button, then receive SSE text deltas and recipe-card events.
- **On-demand cooking steps**: steps are generated from inside each recipe card and include description, tip, child action, parent action, risk level, and completion state.
- **Chinese/English UI and pinyin mode**: language and pronunciation hints can be toggled without losing the current conversation.
- **Speech playback**: ingredients, recipe names, summaries, alerts, quantities, cooking steps, and assistant messages can be read aloud; clicking again interrupts playback.
- **Chinese recipe-name literacy**: clicking a Chinese recipe name opens character-level pinyin, stroke count, structure, and kid-friendly explanations.
- **Favorites and history**: conversations, favorite recipes, recommendations, and step caches are stored locally.
- **Seedance 2.0 cooking video support**: videos are not generated in the user request path. They are generated offline with AI assistance, manually reviewed, registered on the server, and deterministically matched in the frontend.
- **Video configuration page**: `/cookbook-video-config` supports managing reviewed recipe videos with create, edit, delete, filter, and pagination.

## Product Flow

```text
Opening screen
-> Chatbox home
-> Input ingredients by text / voice / image
-> AI ingredient recognition
-> User confirms ingredient list
-> View ingredient knowledge or add more ingredients
-> Manually trigger recipe recommendation
-> Browse recipe carousel cards
-> Generate cooking steps on demand
-> Read aloud, favorite, watch video, restore history
```

The default user profile is an elementary-school student. Recommendations prefer low-oil, light-taste, balanced, vitamin-rich meals with well-balanced staples, protein, and vegetables. The system only asks for allergy details when users explicitly mention severe acute allergy risks, anaphylaxis, breathing difficulty, or similar high-risk situations.

## Technical Architecture

```text
React Chatbox frontend
  -> Node.js / Express / Netlify Functions agent orchestration layer
  -> ModelRouter selects models per task
  -> Text ingredient parsing / image recognition / recipe recommendation / step generation / ingredient knowledge
  -> SSE streaming response
  -> localStorage caches history, favorites, steps, knowledge, and video matches
  -> Seedance 2.0 offline video resource matching and playback
```

Key design choices:

- **ModelRouter**: routes each task to a text model, multimodal model, lightweight model, balanced model, or fallback model instead of sending everything to a heavy model.
- **Streaming output**: recipe recommendations and cooking steps use SSE where possible to reduce perceived latency.
- **On-demand generation**: recommendation and cooking steps are split; the first response focuses on recipe cards, and steps are generated only when requested.
- **Local caching**: step details, ingredient knowledge, video matches, conversation history, and favorites are cached in the browser.
- **Controlled video workflow**: Seedance 2.0 videos are generated offline and manually reviewed. The frontend only plays registered reviewed resources.
- **Recoverable errors**: model errors, timeouts, detail failures, knowledge failures, and video misses all have visible states and retry paths.

Architecture and demo reports:

- [Agent Technical Architecture Report HTML](competition/agent-technical-architecture-report.html)
- [Agent Technical Architecture Report PPT](competition/agent-technical-architecture-report.pptx)
- [Product Demo Report HTML](competition/product-demo-report.html)
- [Product Demo Report PDF](competition/product-demo-report.pdf)
- [Product Demo Report PPT](competition/product-demo-report.pptx)

## Repository Structure

```text
apps/frontend/              React + TypeScript frontend
apps/server/                Node.js / Express / Netlify Functions server
competition/                Competition materials and reports
docs/                       Deployment and project notes
video-design/               Seedance / Jimeng video-generation plans and role assets
frontend-prd.md             Frontend PRD and acceptance scope
stream-message-ast.md       Streaming response rendering architecture
```

## Local Development

### Requirements

- Node.js `>=20.19.0`
- pnpm `10.26.0`

### Install

```bash
pnpm install
```

### Environment Variables

```bash
cp .env.example .env
```

Important variables:

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

Optional variables for video configuration management:

```text
VIDEO_CONFIG_ADMIN_USER=
VIDEO_CONFIG_ADMIN_PASSWORD=
VIDEO_CONFIG_TOKEN_SECRET=
MONGODB_URI=
MONGODB_DB_NAME=murphy_cookbook
RECIPE_VIDEO_MONGODB_COLLECTION=recipe_videos
```

### Start Development Servers

Run frontend and server separately:

```bash
pnpm run dev:server
pnpm run dev:frontend
```

For local HTTPS:

```bash
pnpm run dev:frontend:https
```

### Build and Test

```bash
pnpm run build
pnpm run test:api
pnpm run test:e2e
pnpm run benchmark:llm-latency
```

## Main API Endpoints

### Ingredients and Knowledge

- `POST /api/v1/ingredients/parse-text`
- `POST /api/v1/ingredients/recognize-image`
- `POST /api/v1/ingredients/seasonal-suggestions`
- `POST /api/v1/ingredients/knowledge`

### Recipes

- `POST /api/v1/recommendations/recipes`
- `POST /api/v1/recommendations/recipes/stream`
- `POST /api/v1/recipes/detail`
- `POST /api/v1/recipes/detail/stream`

### Cooking Videos

- `POST /api/v1/recipe-videos/match`
- `POST /api/v1/video-config/auth`
- `GET /api/v1/video-config/recipes`
- `POST /api/v1/video-config/recipes`
- `PUT /api/v1/video-config/recipes/:id`
- `DELETE /api/v1/video-config/recipes/:id`

## Local State and Cache

The frontend stores these items in `localStorage`:

- Current conversation messages
- Latest 30 conversation histories
- Latest 40 messages per conversation
- Current ingredient list
- Favorite recipes
- Latest recommendation result
- Cooking step detail cache, default 3 days
- Ingredient knowledge cache, default 3 days
- Video match cache, default 3 days
- Language, pinyin mode, and opening-screen state

The video configuration admin token is temporarily stored in `sessionStorage`.

## Testing Focus

- Mobile Safari text and voice input submission.
- Image preview must not break the chatbox layout.
- Horizontal ingredient and recipe scrolling should not trigger browser back navigation.
- Recommendation button loading must not cause layout jitter.
- Ingredient names and quantities must not render vertically in recipe cards.
- Cooking-step failures must show toast, inline failure state, and retry action.
- English mode must affect recipe, step, and ingredient-knowledge generation.
- Seedance videos must only match reviewed resources; unmatched recipes show a placeholder.

## Reference Documents

- [Frontend PRD](frontend-prd.md)
- [Technical Architecture Report](competition/agent-technical-architecture-report.html)
- [Streaming Response Rendering Plan](stream-message-ast.md)
- [Video Generation Technical Plan](video-design/视频生成技术方案.md)
- [Seedance Prompt Skill](video-design/seedance-prompt-skill/SKILL.md)

## Safety Notes

- Do not commit real API keys, admin passwords, or production tokens.
- `.env.example` should only contain variable names and safe defaults.
- Cooking videos must be manually reviewed before being registered in the configuration page.
- Cooking steps involving open fire, high heat, hot oil, steaming, ovens, microwave ovens, or similar risks must tell children to work with parent supervision.

