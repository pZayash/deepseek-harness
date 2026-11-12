// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SendGestureRow } from '../src/client/settings/SendGestureRow.tsx'
import type { SendGestureRowProps } from '../src/client/settings/SendGestureRow.tsx'
import { ComposerSubmissionPolicy } from '../src/client/input/submission-policy.ts'
import { en } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
}

function mount() {
  const policy = new ComposerSubmissionPolicy()
  const setSendGesture = vi.fn((gesture: 'enter' | 'chord') => { policy.setSendGesture(gesture) })
  const props: SendGestureRowProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionStatus: noPendingInteraction(),
    useSessionRetainInfo: () => undefined,
    useResource,
    useWorkspaces: emptyWorkspaces(),
    ...allowAllAccess,
    useContextMenu: contextMenuHook(),
    useSendGesture: bindSnapshotSelector(policy.sendGesture),
    setSendGesture,
    t: makeTranslate(en),
  }
  render(<SendGestureRow {...props} />)
  return { policy, setSendGesture }
}

describe('SendGestureRow', () => {
  it('shows the chord send gesture by default and explains the line break twin', () => {
    mount()
    expect(screen.getByText('Send gesture')).toBeDefined()
    expect(screen.getByText('Which keys send a message; the other keys insert a line break')).toBeDefined()
    expect(screen.getByRole('button', { name: /Cmd\/Ctrl\+Alt\+Enter sends/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menuitem', { name: 'Enter sends' })).toBeNull()
  })

  it('selects Enter, follows later preference changes, and closes outside', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: /Cmd\/Ctrl\+Alt\+Enter sends/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enter sends' }))
    expect(b.setSendGesture).toHaveBeenCalledWith('enter')
    expect(screen.getByRole('button', { name: 'Enter sends' })).toBeDefined()

    act(() => { b.policy.setSendGesture('chord') })
    const trigger = screen.getByRole('button', { name: /Cmd\/Ctrl\+Alt\+Enter sends/ })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Enter sends' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Enter sends' })).toBeNull()
  })
})
