// Service worker. Deliberately thin: it owns the context menu and opens the
// side panel. All CIU traffic happens in the side panel, whose lifetime
// matches the user's interaction; an MV3 worker can be suspended mid-stream.

export type PendingAction =
  | "explain"
  | "summarise-selection"
  | "extract-selection"
  | "translate"
  | "rewrite-simpler"
  | "rewrite-shorter"
  | "summarise-page";

export interface PendingJob {
  action: PendingAction;
  selectionText: string;
  tabId: number;
  url: string;
  title: string;
  at: number;
}

const MENU: { id: PendingAction; title: string; contexts: ["selection"] | ["page"] }[] = [
  { id: "explain", title: "Explain with CIU", contexts: ["selection"] as ["selection"] },
  { id: "summarise-selection", title: "Summarise selection", contexts: ["selection"] as ["selection"] },
  { id: "extract-selection", title: "Extract information", contexts: ["selection"] as ["selection"] },
  { id: "translate", title: "Translate selection", contexts: ["selection"] as ["selection"] },
  { id: "rewrite-simpler", title: "Rewrite: simpler", contexts: ["selection"] as ["selection"] },
  { id: "rewrite-shorter", title: "Rewrite: shorter", contexts: ["selection"] as ["selection"] },
  { id: "summarise-page", title: "Summarise this page with CIU", contexts: ["page"] as ["page"] },
];

// The toolbar icon (and its Alt+Shift+C shortcut) is handled here rather
// than by openPanelOnActionClick. Letting Chrome open the panel directly
// swallows the click, so the extension never receives the activeTab grant for
// the page and cannot read it. Handling the click keeps the grant, then opens
// the panel within the same user gesture.
function useOwnClickHandler() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}
useOwnClickHandler();
chrome.runtime.onStartup.addListener(useOwnClickHandler);

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  // The panel may already be open; tell it this tab is now readable.
  chrome.runtime.sendMessage({ type: "ciu-access-granted", tabId: tab.id }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  useOwnClickHandler();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "ciu", title: "CIU", contexts: ["selection", "page"] });
    for (const m of MENU) chrome.contextMenus.create({ id: m.id, title: m.title, contexts: m.contexts, parentId: "ciu" });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !MENU.some((m) => m.id === info.menuItemId)) return;
  // open() must run inside the user gesture, so before any await.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const job: PendingJob = {
    action: info.menuItemId as PendingAction,
    // Chrome hands over the selection directly, so selection actions need no
    // page access at all.
    selectionText: (info.selectionText ?? "").slice(0, 20_000),
    tabId: tab.id,
    url: tab.url ?? info.pageUrl ?? "",
    title: tab.title ?? "",
    at: Date.now(),
  };
  chrome.storage.session.set({ pending: job });
});
