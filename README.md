# markdown-render-speed

A fast, dependency-free Markdown parser for the [make.fun](https://make.fun) competition **markdown-render-speed-02** — byte-identical HTML to [marked](https://github.com/markedjs/marked) 18.1.3 (default options, GFM on), but faster.

[![make.fun competition](https://img.shields.io/badge/make.fun-markdown--render--speed--02-8A2BE2)](https://make.fun/competitions/markdown-render-speed-02)
[![leaderboard rank](https://img.shields.io/badge/leaderboard-markdown--render--speed--02-blue)](https://make.fun/competitions/markdown-render-speed-02)
[![prize](https://img.shields.io/badge/prize-%24250-success)](https://make.fun/competitions/markdown-render-speed-02)

## What it is

`parse.js` exports a single function, `parse(markdown)`, which returns the same HTML string that marked 18.1.3 produces for the same input — on all 720 of the 720 practice cases, including CommonMark spec cases, GFM extensions (tables, strikethrough, autolinks, task lists), and long generated documents.

It is a single-file, dependency-free, pure-JavaScript implementation (Node 22, no WASM, no native code, no prebuilt assets). The driver `main.ts` is the kit's stock driver: it reads every case from `cases.json`, renders each one alone with `parse()`, and writes the HTML strings to `html.json`.

## How it's fast

- Single-pass block lexer and inline scanner; no token-tree build and no second render pass.
- Plain-text runs are consumed in bulk (one scan to the next special character) instead of per-character dispatch.
- The emphasis/delimiter masking pass (`maskSrc`) is skipped entirely when a run holds no code span, link, tag or escape that could hide a delimiter.
- HTML-escaping helpers return early when the chunk holds no escapable character.
- Sticky (`y`) regexes with `lastIndex` instead of `slice()` + anchored regexes, so no substrings are allocated while masking.

## Benchmark

Local benchmark over the 720 practice cases (5 rounds, median):

| parser | median |
|---|---|
| marked 18.1.3 (baseline) | ~668 ms |
| this `parse.js` | ~454 ms |
| **speedup** | **~1.47x** |

Practice score: **720/720** cases byte-identical to marked. Run it yourself with `node probe/bench.mjs` (from the workspace root; the probe scripts live outside the repo).

## Layout

- `parse.js` — the parser (the whole entry).
- `main.ts` — the stock kit driver (reads `cases.json`, writes `html.json`).
- `LICENSE` — MIT.

## Verify

```sh
# correctness: 720 practice cases vs marked's reference output
node probe/diff.mjs
# speed: this parse.js vs marked
node probe/bench.mjs
```
