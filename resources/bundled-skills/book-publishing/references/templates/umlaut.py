#!/usr/bin/env python3
"""Percent-encode non-ASCII characters in HTTP(S) URLs found in text files.

Dry-run is the default. Pass --apply to write changes in place.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
from urllib.parse import quote, urlsplit, urlunsplit


URL_RE = re.compile(r"https?://[^\s<>\"'`]+", re.IGNORECASE)
TRAILING_PUNCTUATION = ".,;:!?)]}"


def encode_host(netloc: str) -> str:
    """Encode an internationalized hostname while preserving auth and port."""
    userinfo, hostport = (netloc.rsplit("@", 1) if "@" in netloc else ("", netloc))
    if hostport.startswith("["):
        host, suffix = hostport, ""
    elif ":" in hostport:
        host, port = hostport.rsplit(":", 1)
        suffix = f":{port}" if port.isdigit() else ""
        if not suffix:
            host = hostport
    else:
        host, suffix = hostport, ""
    encoded_host = host.encode("idna").decode("ascii")
    return f"{userinfo}@{encoded_host}{suffix}" if userinfo else f"{encoded_host}{suffix}"


def encode_url(raw_url: str) -> str:
    """Return an ASCII-safe URL without double-encoding existing escapes."""
    trailing = ""
    while raw_url and raw_url[-1] in TRAILING_PUNCTUATION:
        trailing = raw_url[-1] + trailing
        raw_url = raw_url[:-1]
    parts = urlsplit(raw_url)
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return raw_url + trailing
    encoded = urlunsplit(
        (
            parts.scheme,
            encode_host(parts.netloc),
            quote(parts.path, safe="/%:@!$&'()*+,;=-._~"),
            quote(parts.query, safe="%=&?/:@!$'()*+,;-._~"),
            quote(parts.fragment, safe="%=&?/:@!$'()*+,;-._~"),
        )
    )
    return encoded + trailing


def transform(text: str) -> tuple[str, int]:
    changes = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal changes
        before = match.group(0)
        after = encode_url(before)
        changes += before != after
        return after

    return URL_RE.sub(replace, text), changes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--apply", action="store_true", help="write changes in place")
    args = parser.parse_args()

    total = 0
    for path in args.files:
        original = path.read_text(encoding="utf-8")
        updated, changes = transform(original)
        total += changes
        if args.apply and changes:
            path.write_text(updated, encoding="utf-8")
        print(f"{path}: {changes} URL(s) {'updated' if args.apply else 'would change'}")
    print(f"total: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
