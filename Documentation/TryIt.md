# Trying it on your own pages

The tests prove the hard cases one fixture at a time, and the smoke run proves ten public pages.
Neither proves the pages you read. This is a walkthrough of four tries that do: twenty pages
of your own from the terminal, reading them in the browser, a save from Chrome behind your own
login, and a smoke list of your own. Each try says what to do, what a good result looks like,
and what to write down when it is not one. An hour covers all four.

## Before you start

Install as the [README](../README.md#install) says, so `pa` is on your PATH, then check it runs:

```
pa help
```

The tries below save into a library of their own, so they never mix with a library you keep:

```
export PA_LIBRARY=~/pa-try
```

Every `pa` command in this shell now uses that folder. When you are done, keep it, or delete
the folder; nothing else refers to it.

## 1. Save twenty real pages

Pick twenty pages you would actually want back in five years, not ones chosen to be easy: a
long article, a docs page, a page full of images, one with video, a thread with comments, a
page in another language, a page you had to click through a cookie banner to read. Save each
one:

```
pa save https://example.com/some-article --tag try
```

`pa save` prints the folder it wrote, the files in it with their sizes, and a `warning:` line
for anything it could not keep. A warning is not a failure: a resource the site refused is set
aside, and the warning names it. A save that fails outright exits non-zero with `pa:` and the
reason.

Then check each page the way you will use it later, with the network off:

1. Turn Wi-Fi off (or unplug).
2. `pa open <id>` opens the archive in your default browser; `pa open <id> --reader` opens
   the reader copy. The id is the one `pa save` printed; `pa list` shows them all, and any
   four or more of its first characters will do.
3. Compare it with the live page from memory, or with `shot.png` in the same folder (a
   screenshot taken at capture time): text, images, fonts, layout, the part you saved it for.

What to look for:

- **Missing images or fonts**: look in the page's `meta.json` (`pa open <id> --print` gives the
  archive's path; `meta.json` is beside it) under `warnings`. A resource listed there was
  refused by the site; one not listed is a page-archiver bug.
- **Wrong page**: a consent wall, a "verify you are human" page, a login prompt. A consent
  button `pa` does not know can be named with `--dismiss <selector>`; a site that walls off
  headless browsers is not something to work around, and the Chrome extension (try 3) saves
  what your own browser sees.
- **Empty or half-loaded content**: a page that renders its content late may need
  `--wait-for <selector>` naming an element that appears once it has.
- **A poor reader copy**: Readability guesses which part of the page is the article. A wrong
  guess is worth noting, but it is Readability's guess, and the original is always kept beside
  it.

Then search the twenty:

```
pa list --tag try
pa search <a word you remember from one page>
pa search "<a phrase from another>"
```

Search reads the reader copy's text (or the page's visible text when it has none), so a word
from the article body should find its page; the title counts most.

## 2. Read them in the browser

```
pa serve
```

opens the library at `http://127.0.0.1:47320/`. Leave the network on for this one; the server
is local, and nothing it shows is fetched from the web. Try:

- typing in the search box, then narrowing by site, tag and date;
- opening a page and switching between **Original** and **Reader**;
- adding and removing a tag;
- **Re-capture** on one page, then turning on every version to see both;
- **Delete** on a page you do not want (this removes its folder, after a confirmation).

What to look for: a page that looks different here from `pa open`. The reader app shows every
archive under a strict Content-Security-Policy, in a sandboxed frame, so anything that only
appears in one of the two is worth a note. So is anything slow, confusing or missing from the
app itself.

Leave `pa serve` running for the next try.

## 3. Save a page behind your own login from Chrome

Load the extension once, as the [README](../README.md#saving-from-chrome) says (`chrome://extensions`,
**Developer mode**, **Load unpacked**, `packages/extension/dist/unpacked`).

Then, in your everyday Chrome where you are signed in, open a page only you can see: an inbox
view you would want to keep, a paid article, a private document, an order receipt. Scroll it,
open what you want kept, then click the extension's button, add a tag, and press **Save**. The
popup says **Saved**, and **Open in library** shows it in `pa serve`'s reader.

What to look for:

- the archive shows what you saw, signed in, not a login page;
- images that need your login (avatars, attachments) are there;
- the archive contains everything on that page, including your name, account details and
  anything else on screen. It stays on your disk; the extension sends it nowhere but the
  server address in its popup. Keep that in mind before you share an archive.

Then stop `pa serve` (Ctrl-C) and save another page from Chrome. The extension downloads the
archive instead, into `page-archiver/` in your downloads folder; `pa import <file>` adds it to
the library.

From the terminal, `pa save --profile <dir>` captures with a persistent Chromium profile in
`<dir>`, so cookies one save sets are there for the next. `pa` has no sign-in step of its own
(`--headed` shows the window, but the capture does not wait for you), so the extension is the
way to save a page behind your login.

## 4. Run your own smoke list

The smoke run captures every page in `test/smoke-urls.txt` from the live web, opens each archive
offline and fails a page on any network request or CSP violation, or when text you name is
missing. Replace the ten pages there with pages from try 1, one per line:

```
label | url | text the archive must contain
```

Pick text from the article body, not the site's header, so a bot wall or error page cannot
pass. Then:

```
npm run smoke
```

and read `test-results/smoke.md`: one row per page with its result, size, live-versus-offline
pixel difference and warnings. A page that fails there and looked fine in try 1 is the most
useful finding of all, because it shows exactly what the archive asked the network for. A page
that cannot save cleanly, for a reason you have understood, gets `| miss: <reason>` on its line,
so the run records it rather than failing on it. [Testing.md](Testing.md#the-real-site-smoke-run-npm-run-smoke)
has the details.

This repository is public: if your list names pages you would rather not publish, put the
committed list back (`git checkout test/smoke-urls.txt`) when you are done.

## Writing down what broke

For each problem, one entry:

```
url:        the page
how saved:  pa save | pa save --profile | Chrome extension | pa serve re-capture
what:       what is wrong, where on the page, and what it should look like
warnings:   the page's meta.json warnings, or "none"
archive:    the archive's path (pa open <id> --print)
```

Keep the archive: it is the evidence. A problem that turns out to be page-archiver's becomes a
fixture in `fixtures/pages/` that reproduces it offline, as [Testing.md](Testing.md#adding-a-fix)
describes, and a line in [Review.md](Review.md).
