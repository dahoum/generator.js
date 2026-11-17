# Static Site Generator

This is my static site generator: plain Node.js, no dependencies.

## Usage

```js
const { generateSite } = require('generator.js');

generateSite({
  rootDir: __dirname,
  siteUrl: 'https://example.com', // needed for absolute og:image / og:url
});
```

Options (all optional):

| Option | Default | |
|---|---|---|
| `rootDir` | current directory | |
| `contentDir` | `<rootDir>/content` | Markdown articles |
| `templatesDir` | `<rootDir>/templates` | `index.html`, `article.html`, `style.css` (required), `footer.html`; the folders `images/`, `icons/` and `fonts/` are copied to the build directory |
| `buildDir` | `<rootDir>/public` | **Deleted and rebuilt on every run.** Must not contain the sources. |
| `siteUrl` | – | Base URL. Without it, social-media tags get relative URLs and a warning is printed. |
| `stripImageMetadata` | `true` | Removes EXIF (incl. GPS), XMP, IPTC, comments and PNG text chunks from published images. Pixels, ICC colour profiles and the photo's orientation are kept. Source files are not modified. |
| `defaultLang` | `en` | Value of `{{lang}}` when an article has no `lang:`. |
| `logger` | `console` | Object with `log`, `warn` and `error` functions that receives all messages. |
| `homeDir` | your home directory | Never accepted as build directory (exists so tests can check this safely). |

It can also be run directly: `SITE_URL=https://example.com node node_modules/generator.js/generator.js`.

## Content

`content/<section>/<slug>/<anything>.md` is published as `public/<section>/<slug>.html`.
Images go in `content/<section>/<slug>/images/`, PDFs in `.../pdfs/`; both folders are published, and images in them are stripped of metadata.

Frontmatter:

```
---
category: Renewable Energy   # required
title: The Grid              # required
authors: Jane Doe
image: images/1.jpeg         # hero image and og:image
explanation: Caption and og:description
lang: de                     # default: defaultLang
order: 1                     # position in the table of contents (lowest first); otherwise sorted by folder name
toc: false                   # hide from the table of contents
draft: true                  # do not publish
---
```

An article with `category: Home` fills `{{homeTitle}}`, `{{homeImage}}` and
`{{homeParagraph1}}` … `{{homeParagraph4}}` in `index.html`.

## Templates

| Placeholder | |
|---|---|
| `{{title}}`, `{{authors}}`, `{{explanation}}`, `{{image}}`, `{{content}}` | article fields (template lines for empty optional fields are removed) |
| `{{ogImage}}`, `{{ogImageWidth}}`, `{{ogImageHeight}}`, `{{ogUrl}}` | social-media tags |
| `{{lang}}` | article language |
| `{{logoHref}}` | link to the home page |
| `{{categories}}` | table of contents (index only) |
| `{{footer}}` | contents of `templates/footer.html` |
| `{{root}}` | relative path from the page to the site root (`""`, `"../"`, …), usable in templates and the footer |

Placeholders left unfilled in the output are reported as warnings.

## Markdown

Supported: `#`–`######` headings, `-`/`*` and `1.` lists, `_em_`/`*em*`,
`__strong__`/`**strong**`, `` `code` ``, `[links](url)` (`pdfs/…` links are
resolved), bare `https://` URLs, `![caption](images/…)` on its own line, and
inline HTML. Every non-empty line is its own paragraph.

## Multilingual sites

Pass two or more `languages` to switch to the multilingual layout. The first
language is published at the top level, every other one in its own folder:

```js
generateSite({
  rootDir: __dirname,
  siteUrl: 'https://example.com',
  languages: [
    { code: 'de', path: '' },          // German at /
    { code: 'en', path: 'english' },   // English at /english/
  ],
});
```

Content: a section folder holds one small file per language with the
section's name; every article folder holds one file per language. The file
name gives the language and the address; the folder pairs the translations.

```
content/
  renewable-energy/
    de-erneuerbare-energie.md     ---  title: Erneuerbare Energie  ---
    en-renewable-energy.md        ---  title: Renewable Energy  ---
    the-grid/
      de-das-netz.md              → /erneuerbare-energie/das-netz.html
      en-the-grid.md              → /english/renewable-energy/the-grid.html
      images/  pdfs/              → /media/renewable-energy/the-grid/… (shared)
  home/start/
    de-start.md  en-start.md      home: true → fills the home page of that language
```

- Article frontmatter: `title` (required), `authors`, `image`, `explanation`,
  `order`, `toc`, `draft`, and `home: true` for the home page article. No `category`.
- Section files: `title` (required) and `order`.
- Markdown files without a language prefix (for example notes) are skipped with a warning.
- An article that exists in only one language simply has no page in the other.
- `404.html` forwards unknown addresses to the home page of their language.

Additional placeholders:

| Placeholder | |
|---|---|
| `{{languageSwitch}}` | `<nav class="language-switch">` with links to the other translations of the page, labelled with `languageName` from the texts file (or the code), no separators (empty without translation) |
| `{{alternateLinks}}` | `<link rel="alternate" hreflang>` tags for search engines (put it in `<head>`) |
| `{{languageRedirect}}` | on the first language's home page: a script that sends visitors arriving from elsewhere to their language (put it in `<head>` of `index.html`) |
| `{{text.key}}` | text from `templates/texts/<code>.json`, for example `{"imprint": "Impressum"}` |
| `{{link:section/article}}` | link to that article (content folders) in the page's language |

## Quality assurance

Everything lives in `qa/` and is plain JavaScript on Node's built-in test
runner. There are no dependencies. Node 22 or newer is needed for the QA
scripts; the generator itself runs on Node 18+.

| Command | What it checks |
|---|---|
| `npm test` | All tests: unit tests (`qa/unit/`), tests of the QA tools (`qa/tools/`) and the style check (`qa/style.test.js`). |
| `npm run coverage` | Unit tests with coverage; fails below 100 % of lines, branches and functions of `generator.js`. |
| `npm run mutation` | Mutation testing: makes about a thousand small changes to `generator.js` (one at a time) and checks that the unit tests fail for every one. Survivors that cannot be detected by any test are listed with a reason in `qa/equivalent-mutants.js`. `--rerun` repeats only the last survivors, `--lines 100-200` limits the run. |
| `npm run qa` | All of the above. |

Layout:

```
qa/
  unit/                 unit tests of generator.js, one file per area
  helpers/              test data (hand-built JPEG/PNG files, example site) and the module loader
  tools/                tokenizer, style checker, mutation operators and runner, with their own tests
  style.test.js         runs the style checker on every .js file
  equivalent-mutants.js documented mutants that no test can detect
```

### Code style

All JavaScript (generator, tests and tools) is written in long form, and
`qa/style.test.js` enforces it:

- no `a ? b : c`, `?.`, `??`: use `if`/`else`,
- no arrow functions, no `++`/`--`, no spread, destructuring or default parameters,
- `===`/`!==` only, braces on every `if`/`else`/`for`/`while` body,
- `&&`/`||` only inside conditions or `return` statements, never to pick defaults,
- object literals spell out `key: value`,
- every function has a JSDoc comment with a description, `@param {type} name - description`
  for every parameter and `@returns {type}`.

Regular expressions still contain `?` where it is part of the pattern syntax.
