# Deployment through the existing Vercel Git connection

The existing Vercel project deploys the proxy from GitHub. GitHub Actions tests the application and publishes public/ to GitHub Pages after confirming the production proxy supports the dashboard's required API features. No Vercel token, organization ID or project ID is required in GitHub Actions.

## Existing project settings

In aione-team-proxy, verify:

- Settings → Git: repository youssef-sahlieh/aione-team-control, production branch main.
- Settings → Build and Deployment: Root Directory proxy.
- Production domain: https://aione-team-proxy.vercel.app points to this project's production deployment.
- Keep the existing Jira, account database and mail environment variables in Vercel.

Vercel must successfully deploy the updated proxy from main. A Git connection alone does not guarantee a successful deployment; check the deployment logs for failed builds, authorization errors or skipped deployments.

## Publishing behavior

The workflow is .github/workflows/deploy.yml. Pull requests run unit and browser tests without deploying. Pushes to main trigger the existing Vercel Git integration independently; after tests pass, the wait-for-proxy job polls the production /health endpoint for up to ten minutes. Pages publishes only when the backend advertises API version 1 and the date-requests-v1 and ticket-notes-v1 capabilities.

The health endpoint is public and uncached. It exposes no secrets, account information or ticket content. This check establishes API compatibility; it does not require an identical frontend/backend commit and does not verify Jira, database or mail delivery. This allows frontend-only changes to publish when Vercel skips an unchanged proxy. When adding an incompatible API requirement, update the health contract and the required capabilities in scripts/wait-for-proxy.js together.

If Vercel fails to deploy, the Pages job stays blocked with a message directing you to the existing Git deployment. Fix the deployment in Vercel and rerun the failed Actions jobs. Running the Pages workflow manually does not trigger Vercel; deploy the updated main branch through the connected project first.

## Release the fix

1. Merge the updated application and workflow into main.
2. In Vercel → aione-team-proxy → Deployments, confirm the new main deployment is Ready and assigned to production. If no deployment starts, use Vercel's Git deployment flow to deploy the current main commit; redeploying an older commit will not add the new routes.
3. Open https://aione-team-proxy.vercel.app/health. It should show ok: true, apiVersion: 1 and both required capabilities.
4. In GitHub Actions, confirm build, wait-for-proxy and deploy succeed.
5. Sign in to the dashboard and verify Date requests, initial date setting, approval decisions and Internal notes. Verify email delivery separately using the existing mail settings.

Any VERCEL_TOKEN, VERCEL_ORG_ID or VERCEL_PROJECT_ID secrets added for the previous CLI workflow are unused by this workflow. No new Vercel account or team is needed.

Reference: [Vercel's GitHub integration](https://vercel.com/docs/git/vercel-for-github).
