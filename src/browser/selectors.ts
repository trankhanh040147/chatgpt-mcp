/**
 * Centralized ChatGPT UI selectors.
 * Update these when ChatGPT UI changes — never scatter selectors elsewhere.
 */

export const selectors = {
  /**
   * Main message composer. Prefer the visible ProseMirror `#prompt-textarea`
   * div — ChatGPT also mounts a hidden fallback `<textarea name="prompt-textarea">`
   * that must not win `.first()`.
   */
  composer:
    '#prompt-textarea[contenteditable="true"], div#prompt-textarea[role="textbox"], [contenteditable="true"].ProseMirror',
  /** Send / submit button */
  sendButton:
    'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]',
  /** Streaming / thinking — composer will drop typed text while this is visible. */
  stopButton:
    'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="Stop"]',
  /** New chat button */
  newChatButton:
    'a[href="/"], button:has-text("New chat"), [data-testid="create-new-chat-button"]',
  /**
   * Anonymous-session marker. ChatGPT's logged-out "Try it first" landing
   * page renders a fully functional demo composer with the SAME
   * `#prompt-textarea` id as the authenticated chat UI, so composer
   * presence alone cannot distinguish logged-in from anonymous. The "Log
   * in" / "Sign up for free" buttons only ever appear when logged out, so
   * their ABSENCE is the reliable signal — check this first.
   */
  loggedOutIndicator:
    'button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign up for free")',
  /** Login indicator — presence means session is likely active (only trust after loggedOutIndicator is absent). */
  loggedInIndicator:
    '#prompt-textarea, [contenteditable="true"][data-placeholder], [data-testid="profile-button"], button[aria-label="User menu"]',
  /** Rate limit banner (best-effort detection) */
  rateLimitBanner: ':text("rate limit"), :text("Rate limit"), :text("too many requests")',
  /** Worker URL not accessible to logged-in account */
  chatAccessDenied: ':text("don\'t have access to this conversation")',
  /** Hidden file input for composer attachments */
  fileInput: 'input[type="file"]',
  /** Open attach menu when file input is not directly visible */
  attachMenuButton:
    'button[data-testid="composer-plus-btn"], button[aria-label="Attach files"], button[aria-label="Add photos & files"]',
  /** Attachment chips in composer staging area */
  attachmentRemoveButton:
    'button[aria-label^="Remove "], button[aria-label*="Remove file"]',
} as const;

/** One line only — long dispatch text is truncated by ChatGPT's composer. */
export const DISPATCH_MESSAGE = (taskId: string): string => `TASK_ID=${taskId}`;
