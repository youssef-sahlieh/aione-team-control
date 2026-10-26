// Public proxy settings. Secrets (password, tokens, team details) are Vercel environment variables.
export default {
  // The dashboard's addresses (comma separated). Browsers on any other site can't call the proxy.
  // Only dashboard.ai1.host: the old youssef-sahlieh.github.io address is shared by every GitHub Pages site
  // on that account, so it is no longer trusted.
  ALLOWED_ORIGIN: "https://dashboard.ai1.host",
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
  // "No developer" emails only for tickets assigned to these people.
  // Ask for Billable / Not billable before a ticket can be assigned ("true" to turn on).
  BILLING_REQUIRED: "false",
  NO_DEVELOPER_ASSIGNEES: "karim,youssef,rami,razan",
  // Instance numbers left out of the Databases report (down servers / non-customer instances).
  DB_REPORT_EXCLUDE: "119,129,531",
  // Product repositories whose pull requests are linked to tickets (needs the GITHUB_TOKEN secret).
  GITHUB_REPOS: "KAD-org/flutter_pos,KAD-org/flutter_pos_api,KAD-org/alam_portal,KAD-org/AlamPortal",
  // Other spellings people use for this project's ticket keys in PRs (AIONE-12 means AION-12).
  GITHUB_JIRA_ALIASES: "AIONE",
  // Where links in emails point (the dashboard, on GitHub Pages at its own domain).
  APP_URL: "https://dashboard.ai1.host"
};
