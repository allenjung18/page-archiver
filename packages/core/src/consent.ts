// Cookie and consent walls cover the page until a button is clicked, and in an archive no button
// works. Before the page is frozen, the first visible button of a list of common consent managers
// is clicked, in every frame (several managers draw their banner in an iframe). Refusing is tried
// before accepting wherever a manager offers both, so a capture never agrees to more than it must.
import type { Page } from "playwright";

/** Common consent-manager buttons, reject and close before accept. */
export const DEFAULT_DISMISS_SELECTORS: readonly string[] = [
  // OneTrust
  "#onetrust-reject-all-handler",
  "#onetrust-accept-btn-handler",
  // Cookiebot
  "#CybotCookiebotDialogBodyButtonDecline",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  // Didomi
  "#didomi-notice-disagree-button",
  "#didomi-notice-agree-button",
  // Usercentrics
  "[data-testid='uc-deny-all-button']",
  "[data-testid='uc-accept-all-button']",
  // Quantcast Choice
  ".qc-cmp2-summary-buttons button[mode='secondary']",
  ".qc-cmp2-summary-buttons button[mode='primary']",
  // TrustArc
  "#truste-consent-required",
  "#truste-consent-button",
  // Funding Choices (Google)
  ".fc-cta-do-not-consent",
  ".fc-cta-consent",
  // Osano, Cookie Consent (Insites), Complianz, Termly
  ".osano-cm-denyAll",
  ".osano-cm-accept-all",
  ".cc-window .cc-deny",
  ".cc-window .cc-dismiss",
  ".cc-window .cc-allow",
  ".cmplz-deny",
  ".cmplz-accept",
  "[data-tid='banner-decline']",
  "[data-tid='banner-accept']",
  // Sourcepoint (inside its own iframe)
  "button[title='Reject all']",
  "button[title='Accept all']",
];

/** How long a banner may take to go away after a click. */
const AFTER_CLICK_MS = 400;

/**
 * Clicks the first visible default consent button in each frame. Returns the selectors clicked.
 * A frame whose banner is gone after one click is not clicked again.
 */
export async function dismissConsent(page: Page, selectors: readonly string[] = DEFAULT_DISMISS_SELECTORS): Promise<string[]> {
  const clicked: string[] = [];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      try {
        const target = frame.locator(selector).first();
        if (!(await target.isVisible())) continue;
        await target.click({ timeout: 2_000 });
        clicked.push(selector);
        await page.waitForTimeout(AFTER_CLICK_MS);
        break;
      } catch {
        // a default that is not there, or went away while clicked, is not a problem
      }
    }
  }
  return clicked;
}
