---
kind: upgrade-guide
description: "The composer sends on Cmd/Ctrl+Alt+Enter by default and the panel fullscreen shortcut moves to Cmd/Ctrl+Shift+Backslash."
---

# The composer sends on Cmd/Ctrl+Alt+Enter by default

English | [中文](guide.zh.md)

## Change

The Web and Desktop composer sent on plain Enter, with Shift+Enter breaking the line. It now follows the `sendGesture` field of the `ui-conversation` settings document, which defaults to `chord`: Cmd+Alt+Enter on macOS and Ctrl+Alt+Enter elsewhere send the draft, while Enter and Shift+Enter insert a line break. The `enter` value restores the previous gesture. Cmd/Ctrl+Enter keeps its complementary queue/steer delivery in both modes, and the empty-draft whole-queue steer is unchanged.

The same chord used to toggle the right panel fullscreen. Since the composer now owns it, `pane.fullscreen.toggle` defaults to Cmd/Ctrl+Shift+Backslash, pairing with `pane.split` on Cmd/Ctrl+Backslash.

Anyone typing in the composer, using the panel fullscreen shortcut, or driving the composer from automation observes these changes.

## Migration

1. Keep sending with Enter by selecting **Enter sends** in **Settings → General → Send gesture**, or by setting `sendGesture: enter` in the `ui-conversation` entry's `config` in your profile patch file.
2. Send with Cmd/Ctrl+Alt+Enter, or press Enter twice for a paragraph break; no draft content is affected.
3. Replace the panel fullscreen shortcut in any documentation or automation with Cmd/Ctrl+Shift+Backslash, or rebind `pane.fullscreen.toggle` in **Settings → Keyboard shortcuts**.
4. Confirm that a typed draft survives Enter, that Cmd/Ctrl+Alt+Enter sends it, and that the panel fullscreen control shows the new keys.
