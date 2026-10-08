// Public proxy settings. Secrets (password, tokens, team details) are Vercel environment variables.
export default {
  // The dashboard's address. Browsers on any other site can't call the proxy.
  ALLOWED_ORIGIN: "https://youssef-sahlieh.github.io",
  // Who may sign in (comma separated). They all use the team password.
  TEAM_EMAILS: "youssef@aione.biz,ellen@aione.biz",
  // The only Jira project the proxy reads or changes.
  JIRA_PROJECT: "AION",
  // Emails from the dashboard can only go to addresses at this domain.
  MAIL_DOMAIN: "aione.biz"
};
