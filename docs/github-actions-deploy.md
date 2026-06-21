# GitHub Actions CI/CD

## Required GitHub Secrets

Configure these secrets in GitHub repository settings:

- `NETLIFY_AUTH_TOKEN`: Netlify personal access token.
- `NETLIFY_SITE_ID`: Target Netlify site ID.
- `SILICONFLOW_API_KEY`: SiliconFlow private API token.
- `MONGODB_URI`: MongoDB connection string for shared recipe video configuration storage.
- Optional `VIDEO_CONFIG_ADMIN_USER`: recipe video admin username. Defaults to `yuzili`.
- Optional `VIDEO_CONFIG_ADMIN_PASSWORD`: recipe video admin password. Defaults to `yuzili333`.
- Optional `VIDEO_CONFIG_TOKEN_SECRET`: signing secret for recipe video admin sessions. Defaults to `NETLIFY_AUTH_TOKEN` in the deployment workflow.
- Optional `RECIPE_VIDEO_MONGODB_TLS`: explicit MongoDB TLS switch. Leave empty for automatic Atlas/SRV detection.
- Optional `RECIPE_VIDEO_MONGODB_FAMILY`: MongoDB socket IP family. Defaults to `4`.

## Netlify Runtime Environment

Do not manually configure API runtime variables in Netlify. The `CD Netlify` GitHub Actions workflow syncs them before deployment:

- `SILICONFLOW_API_KEY` is read from GitHub Secrets.
- `SILICONFLOW_QWEN_MODEL=Qwen/Qwen3.5-35B-A3B` is written as a non-secret production runtime variable.
- `VIDEO_CONFIG_ADMIN_USER`, `VIDEO_CONFIG_ADMIN_PASSWORD`, and `VIDEO_CONFIG_TOKEN_SECRET` are synced for `/cookbook-video-config` authentication.
- `MONGODB_URI`, `MONGODB_DB_NAME`, and `RECIPE_VIDEO_MONGODB_COLLECTION` are synced for shared recipe video configuration persistence.
- `RECIPE_VIDEO_MONGODB_TLS` is optional. If unset, `mongodb+srv://` and `.mongodb.net` addresses use TLS automatically.
- `RECIPE_VIDEO_MONGODB_FAMILY=4` is synced by default to avoid IPv6/SRV resolution issues in serverless runtimes.

Do not commit real API keys to `.env`, workflow files, or documentation.

## Workflows

- `.github/workflows/ci.yml`: runs API tests and full workspace build on pull requests and pushes.
- `.github/workflows/cd-netlify.yml`: deploys to Netlify on `main`/`master` push or manual dispatch.

The CD workflow passes both `--filter @murphy-cookbook/frontend` and `NETLIFY_SITE_ID` to Netlify CLI commands. The filter satisfies Netlify's monorepo project selection requirement, while the site ID pins the target Netlify site. Deployment uploads `apps/frontend/dist` as the static frontend and `apps/server/dist/netlify/functions` as the compiled Netlify Functions for `@murphy-cookbook/server`.

If the `Sync Netlify runtime env` step reports `Unauthorized: could not retrieve project`, verify that `NETLIFY_AUTH_TOKEN` was created by a Netlify user or team member with access to the site identified by `NETLIFY_SITE_ID`.
