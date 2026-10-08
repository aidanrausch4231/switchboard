/** Locale-owned subscription actions, questions and credential-free errors. */
export const en = {
  title: 'Subscriptions',
  intro: 'Use your existing subscription in chat. Sign in, then choose a model in the model picker.',
  needsPiAi: 'ChatGPT needs pi-ai >= 1.0. Use the patched dsh runtime to sign in.',
  signin: 'Sign in', signedIn: 'Signed in ✓', signout: 'Sign out', cancel: 'Cancel',
  working: 'Signing in…', authorized: 'Ready to chat', cancelled: 'Sign-in cancelled',
  enabled: 'Models enabled', disabled: 'Models not enabled', enable: 'Enable models',
  loading: 'Loading subscriptions', retry: 'Retry',
  open: 'Open sign-in page', code: 'Verification code', copy: 'Copy code', copied: 'Copied',
  copyFailed: 'Could not copy. Select the code and copy it manually.',
  method: 'Choose a sign-in method', browser: 'Browser login', device_code: 'Device code', copy_code: 'Copy code',
  enterprise: 'GitHub Enterprise URL/domain (leave blank for github.com)',
  paste: 'Paste the authorization code or redirect URL', submit: 'Continue',
  browserHelp: 'If the browser callback cannot reach this Host, use the paste box or choose a headless method.',
  deviceHelp: 'Open the sign-in page and enter this code. Keep this page open until sign-in finishes.',
  unavailable: 'Subscriptions are unavailable. Check that pi-ai, authorization and settings are enabled.',
  busy: 'A sign-in is already running for this provider. Finish or cancel it first.',
  signinError: 'Sign-in failed. Try again and check that your subscription supports this provider.',
  route: 'Sign-in may be saved, but models could not be enabled. Retry Enable models.',
  apiKey: 'This route uses an API-key reference. Remove apiKeyEnv in Models settings before using the subscription.',
  signoutError: 'Could not sign out. Try again.', answer: 'This question has expired. Continue with the current question or sign in again.',
} as const
/** Subscription dictionary keys. */
export type SubscriptionKey = keyof typeof en
