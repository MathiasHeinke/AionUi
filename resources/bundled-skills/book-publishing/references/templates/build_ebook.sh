#!/usr/bin/env bash
# Copy this template beside body.md, ebook_front.md, ebook_cta.md and epub.css.
set -euo pipefail
cd "$(dirname "$0")"

out="${1:-book.epub}"
title="${BOOK_TITLE:-Buchtitel}"
author="${BOOK_AUTHOR:-Autorin oder Autor}"
language="${BOOK_LANGUAGE:-de-DE}"
cover="${BOOK_COVER:-cover.jpg}"

for required in body.md ebook_front.md ebook_cta.md epub.css "$cover"; do
  if [[ ! -f "$required" ]]; then
    echo "Fehlende Eingabe: $required" >&2
    exit 2
  fi
done

pandoc ebook_front.md body.md ebook_cta.md \
  -o "$out" \
  --metadata title="$title" \
  --metadata author="$author" \
  --metadata lang="$language" \
  --epub-cover-image="$cover" \
  --css=epub.css \
  --toc --toc-depth=1 \
  --top-level-division=chapter \
  --syntax-highlighting=none \
  -f markdown+autolink_bare_uris

echo "EPUB gebaut: $out"
