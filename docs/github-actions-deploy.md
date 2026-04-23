# GitHub Actions CI/CD

## Required GitHub Secrets

Configure these secrets in GitHub repository settings:

- `NETLIFY_AUTH_TOKEN`: Netlify personal access token.
- `NETLIFY_SITE_ID`: Target Netlify site ID.
- `SILICONFLOW_API_KEY`: SiliconFlow private API token.

## Netlify Runtime Environment

Do not manually configure SiliconFlow variables in Netlify. The `CD Netlify` GitHub Actions workflow syncs them before deployment:

- `SILICONFLOW_API_KEY` is read from GitHub Secrets.
- `SILICONFLOW_QWEN_MODEL=Qwen/Qwen3.5-35B-A3B` is written as a non-secret production runtime variable.

Do not commit real API keys to `.env`, workflow files, or documentation.

## Workflows

- `.github/workflows/ci.yml`: runs API tests and full workspace build on pull requests and pushes.
- `.github/workflows/cd-netlify.yml`: deploys to Netlify on `main`/`master` push or manual dispatch.

The Netlify CLI commands include `--filter @murphy-cookbook/frontend` because Netlify detects multiple workspace projects in this monorepo.
