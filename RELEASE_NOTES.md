CIU Browser is a Chromium extension that lets the model already running in CIU read the page you're on: summarise it, ask about it, explain a selection, and turn page data into a CSV. Page content never leaves your machine.

**Download:** `ciu-browser.zip` below. Unzip it, open `chrome://extensions`, switch on Developer mode, click **Load unpacked** and choose the `ciu-browser` folder. You need [CIU](https://github.com/runciu/ciu) running with a model loaded.

What's in this beta:

- Summarise a page, with a line under every answer saying how much of the page was read
- Ask questions about the page, with follow-ups; answers stay on the page, and a separate button answers from general knowledge
- Explain, summarise, translate or rewrite selected text from the right-click menu
- Extract data: page tables are copied exactly and instantly (merged cells, multi-row headers and footnote markers handled); plain text is turned into a table by the model, with rows appearing as they are found. Dense pages no longer get stuck: an answer cut off at the length limit keeps its finished rows and reading carries on after them, and Stop keeps everything found so far
- Export to CSV (opens correctly in Excel), JSON or Markdown
- Stop any answer partway through; local per-page history you can delete
- Reads a page only when you press a button, and only after you give it access to that page or site
- Works with CIU's extension allowlist: if CIU is refusing this extension, the panel says so and gives the exact command to allow it

Known limits: PDFs, iframes and canvas text aren't read yet. Long pages are read in sections, which takes longer on small machines. Chromium browsers only for now.

Needs a current CIU, which refuses requests from websites and unlisted extensions. Until the extension is published with a fixed ID, start CIU with this extension's ID allowed; the panel shows the command.
