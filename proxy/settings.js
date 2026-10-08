// Public proxy settings. Secrets (password, tokens, team details) are Vercel environment variables.
export default {
  // The dashboard's address. Browsers on any other site can't call the proxy.
  ALLOWED_ORIGIN: "https://youssef-sahlieh.github.io",
  // Before the user database is added: who may sign in, with the team password. When the database is
  // added, the first sign-in creates administrator accounts for these people.
  TEAM_EMAILS: "youssef@aione.biz,ellen@aione.biz",
  // The only Jira project the proxy reads or changes.
  JIRA_PROJECT: "AION",
  // Emails from the dashboard can only go to addresses at this domain.
  MAIL_DOMAIN: "aione.biz",
  // Where password links in emails point (the dashboard on GitHub Pages).
  APP_URL: "https://youssef-sahlieh.github.io/aione-team-control"
};
