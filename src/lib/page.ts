// Reading the current tab. The extension reads a page only when the user
// presses a button in the panel, and only if Chrome has given it access to
// that tab. Access comes from one of:
//   - clicking the CIU toolbar icon (or its shortcut, or the right-click
//     menu) on the page: Chrome's temporary activeTab grant for that page,
//     which ends when the tab navigates elsewhere;
//   - a site the user allowed from the panel ("Allow on this site");
//   - "Allow on all sites", one optional grant, revocable in Settings.
//
// Without access Chrome hides the tab's URL and title. A missing URL
// therefore means "no access yet", never "this page cannot be read".

import type { PageSnapshot } from "../content/extract";

export type { PageSnapshot, PageTable } from "../content/extract";

/** Optional host permissions requested by "Allow on all sites". */
export const ALL_SITES = ["https://*/*", "http://*/*"];

export class PageAccessError extends Error {
  constructor(
    message: string,
    public kind: "restricted" | "needs-permission" | "no-tab" | "failed",
    public origin?: string,
  ) {
    super(message);
  }
}

const RESTRICTED = [
  /^chrome:/, /^chrome-extension:/, /^edge:/, /^brave:/, /^about:/, /^devtools:/, /^view-source:/,
  /^https:\/\/chromewebstore\.google\.com\//, /^https:\/\/chrome\.google\.com\/webstore/,
];

/** Why a page cannot be read even with access. Null for readable or unknown URLs. */
export function restrictionReason(url: string | undefined): string | null {
  if (!url) return null;
  if (RESTRICTED.some((r) => r.test(url))) return "Browsers do not let extensions read this kind of page (settings, extension and store pages).";
  if (url.startsWith("file:")) return 'To read local files, enable "Allow access to file URLs" for CIU Browser in chrome://extensions.';
  if (/\.pdf($|[?#])/i.test(url)) return "PDF reading is not supported yet. It is planned for a later version.";
  return null;
}

export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export async function activeTab(): Promise<chrome.tabs.Tab> {
  // Test hook: the end-to-end suite opens the panel as a normal tab and points
  // it at a fixture tab. Only extension pages can set this URL.
  const target = new URLSearchParams(globalThis.location?.search ?? "").get("targetTab");
  if (target) return chrome.tabs.get(Number(target));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new PageAccessError("No active tab.", "no-tab");
  return tab;
}

async function inject(tabId: number, maxChars: number): Promise<PageSnapshot> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (n: number) => (globalThis as any).__ciuExtract(n),
    args: [maxChars],
  });
  if (!res || res.result == null) throw new PageAccessError("The page returned nothing CIU could read.", "failed");
  return res.result as PageSnapshot;
}

/**
 * Snapshot the active tab. If access is missing, throws needs-permission;
 * the caller shows an "Allow on this site" button whose click handler calls
 * requestSiteAccess (permission prompts need a fresh user gesture).
 */
export async function readActiveTab(maxChars = 400_000): Promise<PageSnapshot> {
  const tab = await activeTab();
  const why = restrictionReason(tab.url);
  if (why) throw new PageAccessError(why, "restricted");
  if (!tab.url) throw needsAccess(undefined);
  try {
    return await inject(tab.id!, maxChars);
  } catch (e) {
    if (e instanceof PageAccessError) throw e;
    const msg = String((e as Error)?.message ?? e);
    if (/cannot access|cannot be scripted|permission|host/i.test(msg)) throw needsAccess(tab.url);
    throw new PageAccessError(`Could not read the page: ${msg}`, "failed");
  }
}

function needsAccess(url: string | undefined): PageAccessError {
  return new PageAccessError(
    "CIU does not have access to this page yet.",
    "needs-permission",
    url ? (originPattern(url) ?? undefined) : undefined,
  );
}

/** True when "Allow on all sites" is granted. */
export function hasAllSites(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ALL_SITES });
}

/** Must be called directly from a click handler. Null pattern means all sites. */
export function requestSiteAccess(pattern: string | null): Promise<boolean> {
  return chrome.permissions.request({ origins: pattern ? [pattern] : ALL_SITES });
}

export async function grantedSites(): Promise<string[]> {
  const p = await chrome.permissions.getAll();
  const fixed = new Set(chrome.runtime.getManifest().host_permissions ?? []);
  return (p.origins ?? []).filter((o) => !fixed.has(o));
}

export function revokeSite(pattern: string): Promise<boolean> {
  return chrome.permissions.remove({ origins: [pattern] });
}
