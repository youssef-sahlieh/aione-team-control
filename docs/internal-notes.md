# Internal ticket notes

Users have the same **Internal note** buttons and ticket column as admins. Click one to open a composer with recipient chips, Subject, Note and an optional ticket-details link. User recipients are approved admin contacts; the user action saves a private note and emails its selected recipients. Admins keep their existing developer email composer. The **Internal notes** tab also provides saved notes and a form to send to admins.

Notes are stored in the account database separately from Jira and internal ticket comments. Admins can view all notes on an accessible ticket. Users can submit notes only on tickets assigned to their developer name, and can view only their own notes while they retain access to the ticket. The server enforces these permissions.

Every note records its sender, developer name, selected recipients and creation time. Users can choose Ellen (ellen@aione.biz), Youssef (youssef@aione.biz), Karim (karim@aione.biz), or other existing account admins. The fixed contacts are defined in proxy/settings.js; recipient selection never grants admin privileges. Reading all ticket notes still requires an admin account. Selected recipients receive an email with a dashboard link when mail delivery is configured. If email fails, the note remains saved and the UI reports that delivery was not confirmed. Retrying the same submission does not create another note or email. Notes are limited to 5000 characters, 20 submissions per author per ticket per hour, and 500 notes per ticket.

No Jira comment is created and no due date is changed. The existing admin email-to-developer action remains available as **Email developer**. The new `/ticket-notes` endpoint requires deployment of the updated proxy before publishing the frontend.
