#!/usr/bin/env bash
# Copy this template beside body.md, header.tex, frontmatter.tex and backmatter_cta.tex.
set -euo pipefail
cd "$(dirname "$0")"

out="${1:-interior.pdf}"
for required in body.md book-metadata.tex header.tex frontmatter.tex backmatter_cta.tex; do
  if [[ ! -f "$required" ]]; then
    echo "Fehlende Eingabe: $required" >&2
    exit 2
  fi
done

pandoc body.md -o "$out" \
  --pdf-engine=tectonic \
  --top-level-division=chapter \
  -V documentclass=book -V fontsize=11pt -V lang=de-DE \
  -f markdown+autolink_bare_uris \
  -H header.tex -B frontmatter.tex -A backmatter_cta.tex

echo "Print-PDF gebaut: $out"
