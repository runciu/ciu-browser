CIU Browser is a Chromium extension that lets the model already running in CIU read the page you're on: summarise it, ask about it, explain a selection, and turn page data into a CSV. Page content never leaves your machine.

**Download:** `ciu-browser.zip` below. Unzip it, open `chrome://extensions`, switch on Developer mode, click **Load unpacked** and choose the `ciu-browser` folder. You need [CIU](https://github.com/runciu/ciu) running with a model loaded.

What's in this first beta:

- Summarise a page, with a line under every answer saying how much of the page was read
- Ask questions about the page, with follow-ups; answers stay on the page, and a separate button answers from general knowledge
- Explain, summarise, translate or rewrite selected text from the right-click menu
- Extract data: page tables are copied exactly and instantly (merged cells, multi-row headers and footnote markers handled); other repeated content is extracted by the model against a strict schema
- Export to CSV (opens correctly in Excel), JSON or Markdown
- Stop any answer partway through; local per-page history you can delete
- Reads a page only when you press a button, and only after you give it access to that page or site

Known limits: PDFs, iframes and canvas text aren't read yet. Long pages are read in sections, which takes longer on small machines. Chromium browsers only for now.

For a CIU instance that websites can't control, update CIU to a version with the request guard (see the README).
