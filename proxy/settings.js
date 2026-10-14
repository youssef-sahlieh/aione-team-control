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
  // Fixed note recipients authorized by the team. Selecting them never changes account roles.
  INTERNAL_NOTE_RECIPIENTS: [
    {name:"Ellen", email:"ellen@aione.biz"},
    {name:"Youssef", email:"youssef@aione.biz"},
    {name:"Karim", email:"karim@aione.biz"}
  ],
  // Jira-created notifications go to the two managers, regardless of dashboard display filters.
  NO_DEVELOPER_NOTIFY_TO: "youssef@aione.biz,ellen@aione.biz",
  // Where password links in emails point (the dashboard on GitHub Pages).
  APP_URL: "https://youssef-sahlieh.github.io/aione-team-control"
};
