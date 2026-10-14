# Automatic proxy and dashboard deployment

GitHub Actions validates the application, deploys the existing aione-team-proxy Vercel project, and then publishes the dashboard to GitHub Pages. Keeping this order prevents a new dashboard from calling endpoints absent from the running proxy.

## One-time setup

A Vercel project owner must add three repository Actions secrets at:

https://github.com/youssef-sahlieh/aione-team-control/settings/secrets/actions

- VERCEL_TOKEN: create a token at https://vercel.com/account/tokens with access to the existing Aione team/project. Store the value directly in GitHub; do not put it in repository files, issue comments, screenshots or chat.
- VERCEL_ORG_ID: the team/organization ID for the existing Vercel project.
- VERCEL_PROJECT_ID: the existing aione-team-proxy project ID.

The project ID is available in Vercel project settings. The organization and project IDs are also in .vercel/project.json after linking that existing project. IDs are configuration, not passwords. The workflow validates that the project's Root Directory is proxy. It deploys from the repository root, using the existing Vercel project settings and production environment variables.

No credentials for Jira, Redis, Gmail or AI need to move into GitHub. Existing runtime environment variables remain in Vercel. The workflow pulls the Vercel production configuration into the temporary runner workspace for its build; these values are never published as artifacts or printed by the workflow. The application repository .vercel directory remains ignored.

## Deployment behavior

The workflow is .github/workflows/deploy.yml. Pull requests run validation only and do not receive production secrets or deploy. Pushes to main validate, deploy the proxy, and then publish GitHub Pages. Production proxy deployments are serialized. A missing secret or failed proxy build/deployment blocks dashboard publishing and reports an explicit Actions error.

Vercel CLI is pinned to 64.0.2. The workflow uses vercel pull, vercel build --prod, and vercel deploy --prebuilt --prod. There is no interactive login during deployments once secrets are configured.

## Deploy the fix

1. Add the three secrets above.
2. Merge the deployment workflow into main.
3. Open https://github.com/youssef-sahlieh/aione-team-control/actions and follow Deploy to GitHub Pages. Both deploy-proxy and deploy must succeed.
4. Refresh Date requests while signed in. It should show requests or an empty-state message instead of Not found.

For a manual rerun, choose Run workflow on main. Do not run a production deployment from an unreviewed feature branch. GitHub Pages was previously deployed separately; this workflow now depends on a successful proxy deployment.

This automation cannot deploy without the one-time Vercel credentials. Signing into GitHub alone does not grant access to Vercel. Deployment remains blocked until the repository owner adds the secrets.

Reference: [Vercel's GitHub Actions deployment guide](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel).
