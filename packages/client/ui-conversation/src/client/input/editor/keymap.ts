/**
 * Composer keymap over the Lexical command layer: menu arbitration
 * (arrows/escape/enter), space adjudication, the send gesture, and paste
 * routing. Registered at CRITICAL priority so it decides before
 * @lexical/plain-text's own Enter/paste defaults; a handler returning false
 * falls through to those defaults (the line break, ordinary spaces, text
 * paste the bar routes itself).
 *
 * The live send gesture decides which Enter commits the draft: `enter`
 * submits on the unmodified key with Shift+Enter as the line break, while
 * `chord` sends on Cmd+Alt+Enter on macOS and Ctrl+Alt+Enter elsewhere and
 * leaves Enter itself to the editor's line break. Cmd/Ctrl+Enter keeps its
 * fixed complementary-delivery meaning in both gestures.
 *
 * IME guard: a composition-closing Enter/Space must not submit or adjudicate.
 * KeyboardEvent.isComposing covers most engines; Safari delivers the closing
 * keydown AFTER compositionend, so a root-element composition watch holds the
 * guard for 10ms more (the old textarea's proven window); keyCode
 * 229 is the legacy signal engines emit without isComposing.
 * The root's composition attribute suppresses placeholders until both the
 * native composition and the editor's final text reconciliation finish.
 */
import type { LexicalEditor } from 'lexical'
import {
  $getAdjacentNode, $getSelection, $isElementNode, $isLineBreakNode, $isRangeSelection, $isTextNode,
  KEY_DOWN_COMMAND, MOVE_TO_END,
  COMMAND_PRIORITY_CRITICAL, KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND, KEY_SPACE_COMMAND, KEY_TAB_COMMAND, PASTE_COMMAND,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'
import type { ArbitrateKey, ArbitrateOutcome } from '../../contract/draft-editor.ts'
import type { SendGesture } from '../../contract/composer-submission.ts'
import { clipboardFiles } from '../file-intake.ts'
import { $isQuoteNode } from './QuoteNode.tsx'

/** The bar-supplied behavior behind each intercepted gesture. */
export interface ComposerKeymapHandlers {
  /** Keyboard arbitration while the menu is open ('pass' when no pipeline). */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome
  /** Space adjudication; true = a claim was applied — the keystroke is consumed. */
  space(): boolean
  /** Dismiss the popupSelect shell (Escape layering: an open overlay closes first). */
  dismissPopup(): void
  /** Whether a send may run right now (locked/busy states refuse). */
  canSubmit(): boolean
  /** Commit the draft; `accelerated` selects the complementary delivery mode. */
  submit(accelerated: boolean): void
  /** The live gesture that sends the draft instead of breaking the line. */
  sendGesture(): SendGesture
  /**
   * Pasted files with directory metadata supplied by the clipboard entry API.
   * @param files - browser files in clipboard order.
   * @param directories - known directory members; absent when no entry identifies a directory.
   */
  intakeFiles(files: readonly File[], directories?: ReadonlySet<File>): void
  /** Pasted plain text (sanitized insertion through the shell). */
  pasteText(text: string): void
}

/** Composition state a keydown can trust (see the module doc's Safari note). */
function isComposingEvent(event: KeyboardEvent, recentlyComposing: () => boolean): boolean {
  // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
  // oxlint-disable-next-line typescript/no-deprecated
  return event.isComposing || event.keyCode === 229 || recentlyComposing()
}

function isApplePlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
}

/**
 * The delivery role an Enter keydown carries under the explicit send chord.
 * `primary` is the platform send chord (Cmd+Alt on macOS, Ctrl+Alt elsewhere),
 * `complementary` the fixed Cmd/Ctrl+Enter complement, and `other` every
 * remaining combination (including any Shift form), which the keymap leaves to
 * application shortcuts.
 * @param event - the keydown that reached the Enter command.
 * @returns the modifier role, before any menu arbitration.
 */
function enterChord(event: KeyboardEvent): 'primary' | 'complementary' | 'other' {
  if (event.shiftKey) return 'other'
  const apple = isApplePlatform()
  const primary = apple ? event.metaKey : event.ctrlKey
  const other = apple ? event.ctrlKey : event.metaKey
  if (event.altKey) return primary && !other ? 'primary' : 'other'
  return primary !== other ? 'complementary' : 'other'
}

/** Whether the browser caret touches one side of an atomic quote element. */
function domCaretTouches(element: HTMLElement, backward: boolean): boolean {
  const selection = element.ownerDocument.defaultView?.getSelection()
  if (selection === null || selection === undefined || !selection.isCollapsed) return false
  const focus = selection.focusNode
  if (focus === null) return false
  const parent = element.parentNode
  if (parent === null) return false
  const offset = selection.focusOffset
  if (focus === parent) {
    return focus.childNodes.item(backward ? offset - 1 : offset) === element
  }
  if (focus.nodeType === Node.TEXT_NODE) {
    const size = focus.textContent?.length ?? 0
    if (backward ? offset !== 0 : offset !== size) return false
  } else if (backward ? offset !== 0 : offset !== focus.childNodes.length) {
    return false
  }
  let boundary = focus
  while (boundary.parentNode !== null && boundary.parentNode !== parent) {
    if ((backward ? boundary.previousSibling : boundary.nextSibling) !== null) return false
    boundary = boundary.parentNode
  }
  return boundary.parentNode === parent
    && (backward ? boundary.previousSibling : boundary.nextSibling) === element
}

/** Find an atomic quote immediately beside both editor and browser carets. */
function adjacentQuote(editor: LexicalEditor, backward: boolean) {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
  const adjacent = $getAdjacentNode(selection.focus, backward)
  if (!$isQuoteNode(adjacent)) return null
  const element = editor.getElementByKey(adjacent.getKey())
  return element !== null && domCaretTouches(element, backward) ? adjacent : null
}

function lineLeadingQuoteBeforeSelection(editor: LexicalEditor) {
  let quote = adjacentQuote(editor, true)
  if (quote === null) return null
  let previous = quote.getPreviousSibling()
  while (previous !== null) {
    if ($isLineBreakNode(previous)) return quote
    if ($isQuoteNode(previous)) {
      quote = previous
      previous = previous.getPreviousSibling()
      continue
    }
    if (!$isTextNode(previous)) return null
    const text = previous.getTextContent()
    const lastBreak = text.lastIndexOf('\n')
    if (lastBreak >= 0) return text.slice(lastBreak + 1) === '' ? quote : null
    if (text.trim() !== '') return null
    const precedingQuote = previous.getPreviousSibling()
    if (!$isQuoteNode(precedingQuote)) return null
    quote = precedingQuote
    previous = quote.getPreviousSibling()
  }
  return quote
}

/** Put the browser caret before an adjacent line-leading quote. */
function moveBeforeQuote(editor: LexicalEditor, event: KeyboardEvent): boolean {
  if (event.shiftKey) return false
  const quote = lineLeadingQuoteBeforeSelection(editor)
  if (quote === null) return false
  const element = editor.getElementByKey(quote.getKey())
  if (element === null) return false
  const view = element.ownerDocument.defaultView
  if (view === null) return false
  const domSelection = view.getSelection()
  if (domSelection === null) return false
  const range = element.ownerDocument.createRange()
  range.setStartBefore(element)
  range.collapse(true)
  domSelection.removeAllRanges()
  domSelection.addRange(range)
  event.preventDefault()
  return true
}

/** Move from immediately before a quote to the end of its hard line. */
function movePastQuote(editor: LexicalEditor, event: KeyboardEvent): boolean {
  if (!isApplePlatform() || event.key !== 'ArrowRight' || !event.metaKey
    || event.ctrlKey || event.altKey || event.shiftKey) return false
  const quote = adjacentQuote(editor, false)
  if (quote === null) return false
  const block = quote.getParent()
  if (!$isElementNode(block)) return false
  let lineEnd = quote.getIndexWithinParent() + 1
  while (lineEnd < block.getChildrenSize()) {
    const child = block.getChildAtIndex(lineEnd)
    if ($isLineBreakNode(child)) break
    if ($isTextNode(child)) {
      const hardBreak = child.getTextContent().indexOf('\n')
      if (hardBreak >= 0) {
        event.preventDefault()
        child.select(hardBreak, hardBreak)
        return true
      }
    }
    lineEnd += 1
  }
  event.preventDefault()
  block.select(lineEnd, lineEnd)
  return true
}

/**
 * Register the composer keymap on one editor.
 * @param editor - the shell-owned editor.
 * @param handlers - bar-supplied behavior.
 * @returns the unregister disposer.
 */
export function registerComposerKeymap(editor: LexicalEditor, handlers: ComposerKeymapHandlers): () => void {
  // Composition watch: true through composition and for one tick after
  // compositionend (Safari's late closing keydown). The listener rides the
  // root element and re-arms on root swaps.
  let composing = false
  let composingUntil = 0
  let rootElement: HTMLElement | null = null
  const syncComposition = (): void => {
    rootElement?.toggleAttribute('data-composer-composing', composing || editor.isComposing())
  }
  const onCompositionStart = (): void => {
    composing = true
    syncComposition()
  }
  const onCompositionEnd = (): void => {
    composing = false
    composingUntil = Date.now() + 10
    // The native event can precede the committed draft, including an empty
    // cancellation. The callback also runs when no document text changed.
    editor.update(() => {}, { onUpdate: syncComposition })
  }
  const recentlyComposing = (): boolean => composing || Date.now() < composingUntil

  const arrow = (key: ArbitrateKey) => (event: KeyboardEvent | null): boolean => {
    const inComposition = event !== null && isComposingEvent(event, recentlyComposing)
    if (handlers.arbitrate(key, inComposition) !== 'pass') {
      event?.preventDefault()
      return true
    }
    return false
  }

  return mergeRegister(
    editor.registerRootListener((root, prevRoot) => {
      prevRoot?.removeEventListener('compositionstart', onCompositionStart)
      prevRoot?.removeEventListener('compositionend', onCompositionEnd)
      prevRoot?.removeAttribute('data-composer-composing')
      composing = false
      composingUntil = 0
      rootElement = root
      root?.addEventListener('compositionstart', onCompositionStart)
      root?.addEventListener('compositionend', onCompositionEnd)
      syncComposition()
    }),
    editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
      if (!isApplePlatform() || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
      const key = event.key.toLowerCase()
      if (key === 'a') return moveBeforeQuote(editor, event)
      return false
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(MOVE_TO_END, event => movePastQuote(editor, event), COMMAND_PRIORITY_CRITICAL),
    editor.registerUpdateListener(syncComposition),
    editor.registerCommand(KEY_ARROW_UP_COMMAND, arrow('up'), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ARROW_DOWN_COMMAND, arrow('down'), COMMAND_PRIORITY_CRITICAL),
    // Tab settles the highlighted completion and passes without one, keeping
    // native focus traversal; Shift+Tab leaves the menu like Escape whenever it
    // is open, highlight or not, so the two Tab gestures never disagree about
    // consuming the draft.
    editor.registerCommand(
      KEY_TAB_COMMAND,
      event => arrow(event.shiftKey ? 'tabBack' : 'tab')(event),
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(KEY_ESCAPE_COMMAND, (event) => {
      // Escape layering: an open overlay closes; claimed without an overlay
      // does NOT release (deleting the command chip is the only exit gesture).
      handlers.dismissPopup()
      if (handlers.arbitrate('escape', isComposingEvent(event, recentlyComposing)) === 'consumed') {
        event.preventDefault()
        return true
      }
      return false
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_SPACE_COMMAND, (event) => {
      if (isComposingEvent(event, recentlyComposing)) return false
      const consumed = handlers.space()
      if (consumed) {
        event.preventDefault() // the command chip insertion already carries its separator
        return true
      }
      return false
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
      const send = (accelerated: boolean): boolean => {
        // Returning true stops Lexical's fallback line break without consuming
        // the DOM event that application shortcuts need.
        event?.preventDefault()
        if (event?.repeat === true) return true // held-down Enter must not machine-gun sends
        if (!handlers.canSubmit()) return true
        handlers.submit(accelerated)
        return true
      }
      // AltGraph composes a character on Windows layouts; no gesture owns it.
      if (event !== null && event.getModifierState('AltGraph')) return true
      const gesture = handlers.sendGesture()
      // An explicit send chord delivers directly, before an open menu can claim
      // the key; a menu's highlight stays reachable through Enter and Tab.
      const chord = event === null || gesture === 'enter' ? 'other' : enterChord(event)
      if (chord !== 'other') return send(chord === 'complementary')
      // Alt combinations, both Ctrl and Cmd, and Shift plus Ctrl/Cmd leave the
      // draft and the menu unchanged, keeping the DOM event for application
      // shortcuts.
      if (event !== null && (event.altKey || (event.ctrlKey && event.metaKey)
        || (event.shiftKey && (event.ctrlKey || event.metaKey)))) return true
      // Plain Shift+Enter keeps its native line break in both gestures,
      // including during composition.
      if (event?.shiftKey === true) return false
      if (event !== null && isComposingEvent(event, recentlyComposing)) {
        // The IME consumes this Enter (candidate pick); neither submit nor
        // break the line. No preventDefault: the browser owns the gesture.
        return true
      }
      // Menu-open Enter picks the highlight through arbitration; a
      // no-highlight menu passes down to the gesture this mode owns.
      if (handlers.arbitrate('enter', false) !== 'pass') {
        event?.preventDefault()
        return true
      }
      // Under the chord gesture the unmodified key falls through to the
      // editor's native line break.
      if (gesture === 'chord') return false
      return send(event?.ctrlKey === true || event?.metaKey === true)
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(PASTE_COMMAND, (event) => {
      // Duck-typed: the payload union includes InputEvent, and test engines
      // deliver clipboardData on plain events.
      const clipboardData = (event as ClipboardEvent).clipboardData ?? null
      if (clipboardData === null) return false
      const { files, directories } = clipboardFiles(clipboardData)
      if (files.length > 0) handlers.intakeFiles(files, directories.size === 0 ? undefined : directories)
      const text = clipboardData.getData('text/plain')
      if (text === '') {
        if (files.length === 0) return false
        event.preventDefault()
        return true
      }
      event.preventDefault()
      handlers.pasteText(text)
      return true
    }, COMMAND_PRIORITY_CRITICAL),
  )
}
