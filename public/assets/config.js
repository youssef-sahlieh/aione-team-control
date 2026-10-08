// AION Team Control settings. None of these are secrets: they identify the app to Microsoft.
// Fill in the two IDs from Microsoft Entra (see SETUP.md, step 1).
window.AIONE_CONFIG = {
  // Microsoft Entra > App registrations > AION Team Control > Overview > "Application (client) ID"
  clientId: "REPLACE_WITH_CLIENT_ID",
  // Same page > "Directory (tenant) ID"
  tenantId: "REPLACE_WITH_TENANT_ID",
  // Who may use the app. Must match the users assigned to the app in Entra (SETUP.md, step 2).
  allowedEmails: ["youssef@aione.biz", "ellen@aione.biz"]
};
