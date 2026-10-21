# Internal ticket notes

The **Internal notes** tab on a ticket is a team thread inside AION. It is not email and not a Jira comment. Type `@` to pick someone from the dashboard people; each person you mention gets an email with a link to the ticket and an entry in their bell notifications.

Notes are stored in the account database (`notes:<JIRA_PROJECT>:<ticket>`), separately from Jira. Everyone who can open a ticket can read its notes: administrators, and developers whose developer name is on the ticket. Anyone else gets "This ticket is unavailable." People can't mention themselves.

Each note records its author, developer name, mentioned people and creation time. Mentions must be people from the dashboard list; the server rejects anyone else. Notes are limited to 5000 characters, 20 per author per ticket per hour, and 500 per ticket. Retrying the same submission does not create a second note or a second notification. Reusing a note id from someone else is refused.

No Jira comment is created and no due date is changed. The admin **Email developer** action is separate and still works as before.

If email delivery fails, the note is still saved and the bell notification is still written; the failure is logged on the server. The `/ticket-notes` endpoint needs the updated proxy deployed before the frontend is published.

## Notifications

The bell in the top bar lists, for each person: @mentions in Jira comments and internal tickets, internal notes that mention them, and tickets created since they last opened the bell that are assigned to their developer name (every new ticket for administrators). It checks every minute. Each item is marked read on its own, or all at once. Items are kept per person in the account database (`inbox:<email>`, newest 100). The `/inbox` and `/inbox/read` endpoints need the updated proxy deployed.
