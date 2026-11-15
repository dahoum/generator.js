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
| `templatesDir` | `<rootDir>/templates` | `index.html`, `article.html`, `style.css` (required), `footer.html`, `images/`, `icons/` |
| `buildDir` | `<rootDir>/public` | **Deleted and rebuilt on every run.** Must not contain the sources. |
| `siteUrl` | – | Base URL. Without it, social-media tags get relative URLs and a warning is printed. |
| `stripImageMetadata` | `true` | Removes EXIF (incl. GPS), XMP, IPTC, comments and PNG text chunks from published images. Pixels, ICC colour profiles and the photo's orientation are kept. Source files are not modified. |
| `defaultLang` | `en` | Value of `{{lang}}` when an article has no `lang:`. |

It can also be run directly: `SITE_URL=https://example.com node node_modules/generator.js/generator.js`.

## Content

`content/<section>/<slug>/<anything>.md` is published as `public/<section>/<slug>.html`.
Images go in `content/<section>/<slug>/images/`, PDFs in `.../pdfs/`.

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

## Tests

```
npm test
```
