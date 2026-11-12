# Agent Note: The composer sends on a stored gesture

Status: implemented

English | [中文](2026-11-12-composer-send-gesture.zh.md)

## Problem

Plain Enter sent the composer draft, so a multi-line message needed Shift+Enter before every line and an accidental Enter sent an unfinished message. Sending is a per-user habit rather than a product rule: someone who writes long prompts wants Enter to break the line and an explicit chord to send. The existing `busyEnter` preference only chose queue or steer delivery, never which key sends.

## Decision

`ui-conversation` stores a `sendGesture` preference with two values, defaulting to `chord`:

- `chord` sends on Cmd+Alt+Enter on macOS and Ctrl+Alt+Enter everywhere else. Unmodified Enter and Shift+Enter insert a line break.
- `enter` keeps the previous gesture: unmodified Enter sends and Shift+Enter breaks the line.

Exactly Cmd+Enter or Ctrl+Enter keeps its meaning in both gestures: the complementary queue/steer delivery, and the empty-draft whole-queue steer. The composer keymap classifies both send chords before menu arbitration, so a send chord delivers even while the trigger menu is open; the unmodified Enter still picks a highlighted completion, and with no highlight it falls through to the editor's line break. Shift forms of the send chord, Alt combinations, AltGraph, and Ctrl with Cmd stay out of the draft and reach application shortcuts, as before.

The chord had one owner conflict: `pane.fullscreen.toggle` used Mod+Alt+Enter, and a fixed shortcut row reserves its combination against editable commands, which would have disabled the panel command. The panel fullscreen default moved to Mod+Shift+Backslash, pairing with Split on Mod+Backslash, so the composer owns the Enter chords.

The General Settings section gained a row for the gesture over the same `ComposerSubmissionPolicy` store, and the fixed send and newline rows re-register when the preference changes.

## Alternatives considered

**Keep the send chord composer-local instead of a fixed shortcut row.** Rejected: the shortcut reference would not list how to send, and the panel fullscreen row would claim the same chord.

**Move the send chord elsewhere.** Rejected: the requested gesture is the feature.

**Give the complementary delivery a new chord (Shift+Ctrl+Alt+Enter).** Rejected: Cmd/Ctrl+Enter keeps its documented meaning, and Shift then stays free for line breaks.

**Keep Enter sending by default and make the chord opt-in.** Rejected: the chord is the requested default.

## Consequences

The default changes for every profile: Enter and Shift+Enter no longer send, and the send gesture is selected in Settings. The panel fullscreen accelerator moves for every profile that had it. Browser scenarios send with the chord, while the composer component suites select the Enter gesture explicitly so both modes stay covered.

## Related decisions

[Device-local shortcut preferences](../architecture/2026-09-20-device-local-shortcut-preferences.md) owns the registry and reservation rules the fixed rows obey; [the composer command chip](../architecture/2026-10-09-composer-command-chip.md) owns the arbitration the send chords now precede.
