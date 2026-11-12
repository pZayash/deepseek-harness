// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ComposerSubmissionPolicy, DEFAULT_BUSY_ENTER_BEHAVIOR, DEFAULT_SEND_GESTURE, resolveSubmitMode,
} from '../src/client/input/submission-policy.ts'
import type { ConversationSettings } from '../src/submission-settings.ts'
import type { SendGesture } from '../src/submission-settings.ts'

describe('resolveSubmitMode', () => {
  it('queues outside steer-capable busy state and applies the preference to the primary gesture', () => {
    expect(resolveSubmitMode('queue', false, 'enter', true)).toBe('queue')
    expect(resolveSubmitMode('queue', false, 'accelerated', true)).toBe('queue')
    expect(resolveSubmitMode('queue', true, 'enter', true)).toBe('queue')
    expect(resolveSubmitMode('queue', true, 'accelerated', true)).toBe('steer')
    expect(resolveSubmitMode('queue', true, 'enter', false)).toBe('queue')
    expect(resolveSubmitMode('queue', true, 'accelerated', false)).toBe('queue')

    expect(resolveSubmitMode('steer', true, 'enter', true)).toBe('steer')
    expect(resolveSubmitMode('steer', true, 'accelerated', true)).toBe('queue')
    expect(resolveSubmitMode('steer', false, 'enter', true)).toBe('queue')
    expect(resolveSubmitMode('steer', false, 'accelerated', true)).toBe('queue')
    expect(resolveSubmitMode('steer', true, 'enter', false)).toBe('queue')
  })
})

describe('ComposerSubmissionPolicy', () => {
  it('defaults to Queue delivery and the chord send gesture, and publishes changes', () => {
    const policy = new ComposerSubmissionPolicy()
    expect(policy.busyEnter.getSnapshot()).toBe(DEFAULT_BUSY_ENTER_BEHAVIOR)
    expect(policy.sendGesture.getSnapshot()).toBe(DEFAULT_SEND_GESTURE)

    const changedEnter = vi.fn()
    policy.busyEnter.subscribe(changedEnter)
    policy.setBusyEnter('steer')
    expect(changedEnter).toHaveBeenCalledTimes(1)
    expect(policy.busyEnter.getSnapshot()).toBe('steer')

    const changedGesture = vi.fn()
    policy.sendGesture.subscribe(changedGesture)
    policy.setSendGesture('enter')
    expect(changedGesture).toHaveBeenCalledTimes(1)
    expect(policy.sendGesture.getSnapshot()).toBe('enter')
  })

  it('writes an explicit change through the scope after publishing it locally', () => {
    const host = stubConfigForm<ConversationSettings>()
    const observed: string[] = []
    let liveBehavior = (): string => 'unconstructed'
    let liveGesture = (): string => 'unconstructed'
    const scope: typeof host.scope = {
      ...host.scope,
      set: (field, value) => {
        observed.push(`${field}=${String(value)}:${liveBehavior()}/${liveGesture()}`)
        return host.scope.set(field, value)
      },
    }
    const policy = new ComposerSubmissionPolicy(scope)
    liveBehavior = () => policy.busyEnter.getSnapshot()
    liveGesture = () => policy.sendGesture.getSnapshot()
    policy.setBusyEnter('steer')
    policy.setSendGesture('enter')
    expect(observed).toEqual(['busyEnter=steer:steer/chord', 'sendGesture=enter:steer/enter'])
    expect(host.set).toHaveBeenCalledWith('busyEnter', 'steer')
    expect(host.set).toHaveBeenCalledWith('sendGesture', 'enter')
  })

  it('adopts Host preferences without writing them back and leaves an identical write untouched', () => {
    const host = stubConfigForm<ConversationSettings>()
    const policy = new ComposerSubmissionPolicy(host.scope)
    host.publish({ status: 'ready', value: { busyEnter: 'steer', sendGesture: 'enter' }, revision: 1, writable: true })
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
    expect(policy.sendGesture.getSnapshot()).toBe('enter')
    policy.setBusyEnter('steer')
    policy.setSendGesture('enter')
    expect(host.set).not.toHaveBeenCalled()
    host.publish({ value: { busyEnter: 'steer', sendGesture: 'enter' }, revision: 2 })
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
    expect(policy.sendGesture.getSnapshot()).toBe('enter')
  })

  it('adopts a section already standing at construction', () => {
    const host = stubConfigForm<ConversationSettings>()
    host.publish({ status: 'ready', value: { busyEnter: 'steer', sendGesture: 'enter' }, revision: 1, writable: true })
    const policy = new ComposerSubmissionPolicy(host.scope)
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
    expect(policy.sendGesture.getSnapshot()).toBe('enter')
  })

  it('keeps the local send gesture when the Host publishes no supported value', () => {
    const host = stubConfigForm<ConversationSettings>()
    const policy = new ComposerSubmissionPolicy(host.scope)
    // A Host process built before the gesture setting publishes only busyEnter.
    host.publish({
      status: 'ready', value: { busyEnter: 'steer' } as ConversationSettings, revision: 1, writable: true,
    })
    expect(policy.busyEnter.getSnapshot()).toBe('steer')
    expect(policy.sendGesture.getSnapshot()).toBe(DEFAULT_SEND_GESTURE)
    host.publish({
      status: 'ready', value: { busyEnter: 'queue', sendGesture: 'bogus' as SendGesture }, revision: 2, writable: true,
    })
    expect(policy.sendGesture.getSnapshot()).toBe(DEFAULT_SEND_GESTURE)
  })
})
