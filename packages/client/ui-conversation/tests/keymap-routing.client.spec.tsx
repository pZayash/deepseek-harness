// @vitest-environment jsdom
/**
 * Keymap routing at the DOM boundary: synthetic keydowns on the
 * contenteditable reach the registered composer commands (the jsdom lane's
 * gesture entry, below the full component bench).
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { registerComposerKeymap } from '../src/client/input/editor/keymap.ts'

describe('keymap keydown routing', () => {
  it('clears composition presentation on root swaps and unregisters pending callbacks', async () => {
    const editor = createEditor({ namespace: 'composition-root', onError: (e) => { throw e } })
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(first, second)
    onTestFinished(() => {
      editor.setRootElement(null)
      first.remove()
      second.remove()
    })
    editor.setRootElement(first)
    const unregister = registerComposerKeymap(editor, {
      arbitrate: () => 'pass', space: () => false, dismissPopup: () => {},
      canSubmit: () => false, submit: () => {}, sendGesture: () => 'enter', intakeFiles: () => {}, pasteText: () => {},
    })
    onTestFinished(unregister)
    fireEvent.compositionStart(first)
    expect(first.hasAttribute('data-composer-composing')).toBe(true)
    editor.setRootElement(second)
    expect(first.hasAttribute('data-composer-composing')).toBe(false)
    expect(second.hasAttribute('data-composer-composing')).toBe(false)
    fireEvent.compositionStart(first)
    expect(first.hasAttribute('data-composer-composing')).toBe(false)
    fireEvent.compositionStart(second)
    expect(second.hasAttribute('data-composer-composing')).toBe(true)
    fireEvent.compositionEnd(second, { data: '' })
    unregister()
    await Promise.resolve()
    expect(second.hasAttribute('data-composer-composing')).toBe(false)
    fireEvent.compositionStart(second)
    expect(second.hasAttribute('data-composer-composing')).toBe(false)
  })

  it('routes the Enter send gesture to the keymap submit handler', () => {
    const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)
    registerPlainText(editor)
    const submit = vi.fn()
    registerComposerKeymap(editor, {
      arbitrate: () => 'pass',
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit,
      sendGesture: () => 'enter',
      intakeFiles: () => {},
      pasteText: () => {},
    })
    fireEvent.keyDown(root, { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith(false)
    fireEvent.keyDown(root, { key: 'Enter', metaKey: true })
    expect(submit).toHaveBeenCalledWith(true)
  })

  it('sends with the chord gesture and leaves bare Enter to the line break', async () => {
    const editor = createEditor({ namespace: 'chord-send', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    onTestFinished(() => { editor.setRootElement(null); root.remove() })
    editor.setRootElement(root)
    onTestFinished(registerPlainText(editor))
    const submit = vi.fn()
    onTestFinished(registerComposerKeymap(editor, {
      arbitrate: () => 'pass', space: () => false, dismissPopup: () => {}, canSubmit: () => true,
      submit, sendGesture: () => 'chord', intakeFiles: () => {}, pasteText: () => {},
    }))
    editor.update(() => {
      const paragraph = $createParagraphNode().append($createTextNode('unsent draft'))
      $getRoot().append(paragraph)
      paragraph.selectEnd()
    }, { discrete: true })

    // The unmodified key is not consumed by the keymap: the editor's own
    // Enter handling inserts the line break.
    const bare = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    root.dispatchEvent(bare)
    await Promise.resolve()
    expect(submit).not.toHaveBeenCalled()
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('unsent draft\n')

    // The platform chord sends, and its Shift-free complementary twin keeps
    // its fixed delivery meaning.
    expect(fireEvent.keyDown(root, { key: 'Enter', ctrlKey: true, altKey: true })).toBe(false)
    expect(submit).toHaveBeenLastCalledWith(false)
    expect(fireEvent.keyDown(root, { key: 'Enter', ctrlKey: true })).toBe(false)
    expect(submit).toHaveBeenLastCalledWith(true)
    // Off-platform, doubly-modified, and Shift combinations stay with the
    // application: only the exact send chords deliver.
    for (const modifiers of [
      { altKey: true }, { altKey: true, metaKey: true }, { altKey: true, shiftKey: true },
      { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true, shiftKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers })
      root.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('uses Cmd+Alt+Enter as the send chord on macOS', () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
    onTestFinished(() => {
      if (descriptor === undefined) Reflect.deleteProperty(navigator, 'platform')
      else Object.defineProperty(navigator, 'platform', descriptor)
    })
    const editor = createEditor({ namespace: 'chord-macos', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    onTestFinished(() => { editor.setRootElement(null); root.remove() })
    editor.setRootElement(root)
    onTestFinished(registerPlainText(editor))
    const submit = vi.fn()
    onTestFinished(registerComposerKeymap(editor, {
      arbitrate: () => 'pass', space: () => false, dismissPopup: () => {}, canSubmit: () => true,
      submit, sendGesture: () => 'chord', intakeFiles: () => {}, pasteText: () => {},
    }))
    expect(fireEvent.keyDown(root, { key: 'Enter', ctrlKey: true, altKey: true })).toBe(true)
    expect(submit).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(root, { key: 'Enter', metaKey: true, altKey: true })).toBe(false)
    expect(submit).toHaveBeenLastCalledWith(false)
    expect(fireEvent.keyDown(root, { key: 'Enter', metaKey: true })).toBe(false)
    expect(submit).toHaveBeenLastCalledWith(true)
    const shifted = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, metaKey: true, altKey: true, shiftKey: true,
    })
    root.dispatchEvent(shifted)
    expect(shifted.defaultPrevented).toBe(false)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('picks an open menu highlight with the unmodified key under the chord gesture', () => {
    const editor = createEditor({ namespace: 'chord-menu', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    onTestFinished(() => { editor.setRootElement(null); root.remove() })
    editor.setRootElement(root)
    onTestFinished(registerPlainText(editor))
    const submit = vi.fn()
    const arbitrate = vi.fn<(key: string, composing: boolean) => 'consumed' | 'pick-highlighted' | 'pass'>()
      .mockReturnValueOnce('consumed')
      .mockReturnValue('pass')
    onTestFinished(registerComposerKeymap(editor, {
      arbitrate, space: () => false, dismissPopup: () => {}, canSubmit: () => true,
      submit, sendGesture: () => 'chord', intakeFiles: () => {}, pasteText: () => {},
    }))
    expect(fireEvent.keyDown(root, { key: 'Enter' })).toBe(false)
    expect(arbitrate).toHaveBeenCalledWith('enter', false)
    const passed = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    root.dispatchEvent(passed)
    expect(passed.defaultPrevented).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })

  it.each([
    { altKey: true },
    { altKey: true, metaKey: true },
    { altKey: true, ctrlKey: true },
    { ctrlKey: true, metaKey: true },
    { shiftKey: true, metaKey: true },
    { shiftKey: true, ctrlKey: true },
    { shiftKey: true, altKey: true },
  ])('leaves modified Enter %j available to application commands', async (modifiers) => {
    const editor = createEditor({ namespace: 'modified-enter', onError: (error) => { throw error } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    onTestFinished(() => { editor.setRootElement(null); root.remove() })
    editor.setRootElement(root)
    onTestFinished(registerPlainText(editor))
    const submit = vi.fn()
    const arbitrate = vi.fn(() => 'pass' as const)
    onTestFinished(registerComposerKeymap(editor, {
      arbitrate, space: () => false, dismissPopup: () => {}, canSubmit: () => true,
      submit, sendGesture: () => 'enter', intakeFiles: () => {}, pasteText: () => {},
    }))
    editor.update(() => {
      const paragraph = $createParagraphNode().append($createTextNode('unsent draft'))
      $getRoot().append(paragraph)
      paragraph.selectEnd()
    }, { discrete: true })
    const applicationKeydown = vi.fn()
    document.addEventListener('keydown', applicationKeydown)
    onTestFinished(() => { document.removeEventListener('keydown', applicationKeydown) })

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers })
    root.dispatchEvent(event)
    await Promise.resolve()

    expect(submit).not.toHaveBeenCalled()
    expect(arbitrate).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(applicationKeydown).toHaveBeenCalledOnce()
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('unsent draft')
  })

  it('routes Tab through arbitration and passes when unconsumed', () => {
    const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)
    registerPlainText(editor)
    const arbitrate = vi.fn<(key: string, composing: boolean) => 'consumed' | 'pick-highlighted' | 'pass'>()
      .mockReturnValueOnce('consumed')
      .mockReturnValueOnce('pick-highlighted')
      .mockReturnValue('pass')
    registerComposerKeymap(editor, {
      arbitrate,
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit: () => {},
      sendGesture: () => 'enter',
      intakeFiles: () => {},
      pasteText: () => {},
    })
    const consumed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(arbitrate).toHaveBeenCalledWith('tab', false)
    expect(consumed).toBe(false) // consumed: preventDefault fired
    const picked = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(picked).toBe(false) // picked: the completion replaces native traversal
    const passed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(passed).toBe(true) // pass: the browser keeps native focus traversal

    // Shift+Tab is the menu's exit key, never its settle key.
    fireEvent.keyDown(root, { key: 'Tab', keyCode: 9, shiftKey: true })
    expect(arbitrate).toHaveBeenLastCalledWith('tabBack', false)
  })
})
