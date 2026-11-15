# Administrator MFA Deployment

Team Control supports TOTP authenticator apps and one-time recovery codes for administrator accounts.

## Required Configuration

Set these values in the deployment environment, never in source control:

```dotenv
MFA_ENCRYPTION_KEY=<random secret with at least 32 characters>
TEAM_MFA_POLICY=enroll
TEAM_MFA_MAX_AGE_SECONDS=43200
```

Keep `MFA_ENCRYPTION_KEY` stable. Losing or rotating it without a credential migration makes existing TOTP enrollments unreadable.

## Rollout

1. Deploy with `TEAM_MFA_POLICY=enroll`.
2. Have every administrator enroll and store their recovery codes.
3. Confirm password, TOTP, recovery-code, and Monitor SSO paths.
4. Confirm two authorized recovery owners are available.
5. Change the policy to `enforce` only after every active administrator is ready.

Enrollment mode does not revoke existing sessions. Enforcement requires a recent MFA-authenticated session for administrative access. Signed Monitor assertions include MFA assurance only when the Team Control session actually completed MFA.
