/**
 * Centralized ChatGPT UI selectors.
 * Update these when ChatGPT UI changes — never scatter selectors elsewhere.
 */
export const selectors = {
  /** Main message composer (contenteditable or textarea) */
  composer:
    '[contenteditable="true"][data-placeholder], #prompt-textarea, textarea[placeholder]',
  /** Send / submit button */
  sendButton:
    'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]',
  /** Sidebar conversation links */
  conversationLink: (title: string) =>
    `a[href*="/c/"]:has-text("${title}"), nav a:has-text("${title}")`,
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
} as const;

export const DISPATCH_MESSAGE = (taskId: string): string =>
  `Process Cursor handoff TASK_ID=${taskId}.\n\nUse the Handoff MCP tools and follow the worker instructions.`;
