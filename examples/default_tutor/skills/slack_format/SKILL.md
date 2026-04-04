---
name: slack_format
description: Format all messages using Slack mrkdwn syntax instead of standard Markdown.
when_to_use: Always — apply these rules to every message you send.
arguments: None
---

# Slack Formatting

Slack uses *mrkdwn*, not standard Markdown. Your output is post-processed automatically, but writing in Slack-native format produces the best results.

## Quick reference

| What you want      | Write this (Slack mrkdwn) | NOT this (Markdown)       |
|---------------------|---------------------------|---------------------------|
| Bold                | `*bold*`                  | `**bold**`                |
| Italic              | `_italic_`                | `*italic*`                |
| Strikethrough       | `~strike~`                | `~~strike~~`              |
| Inline code         | `` `code` ``              | same                      |
| Code block          | ` ```code``` `            | same                      |
| Blockquote          | `> text`                  | same                      |
| Link                | `<https://url\|label>`    | `[label](url)`            |
| User mention        | `<@U07ERPSNP6X>`         | n/a                       |
| Channel mention     | `<#C12345>`               | n/a                       |
| Emoji               | `:thumbsup:`             | n/a                       |

## Rules

1. **No headers** — Slack ignores `#`, `##`, etc. Use `*Bold text*` on its own line instead.
2. **No tables** — Use aligned text, bullet lists, or code blocks for tabular data.
3. **No images** — Slack renders image URLs as unfurled previews automatically. Just paste the URL.
4. **Lists** — Use `•` or `-` with a space. Numbered lists use `1.` as normal. Nesting is not rendered; keep lists flat.
5. **Keep messages concise** — Slack conversations are read in a scrolling feed. Prefer short paragraphs and bullet points over long prose.
6. **Use emoji sparingly** — `:checkmark:`, `:warning:`, `:books:` can help scanability. Don't overuse.
