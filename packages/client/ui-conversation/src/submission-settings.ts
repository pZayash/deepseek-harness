/** Composer send gesture and busy-Enter preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for the primary send gesture while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/** Busy-Enter behaviors accepted at settings and input boundaries. */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of the primary send gesture while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/** Default preserves Queue delivery for running conversations. */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/** Field carrying the keyboard gesture that sends a message. */
export const SEND_GESTURE_FIELD = 'sendGesture'

/** Send gestures accepted at settings and input boundaries. */
export const SEND_GESTURES = ['enter', 'chord'] as const

/**
 * Keyboard gesture that sends the draft. `enter` sends on plain Enter, with
 * Shift+Enter as the only line break; `chord` sends on the platform chord
 * (Cmd+Alt+Enter on macOS, Ctrl+Alt+Enter elsewhere) and leaves Enter itself
 * to the editor's line break.
 */
export type SendGesture = typeof SEND_GESTURES[number]

/** Enter inserts a new line by default; the explicit chord sends. */
export const DEFAULT_SEND_GESTURE: SendGesture = 'chord'

/** Durable conversation section shared by the Host schema and the browser scope. */
export interface ConversationSettings {
  /** Delivery mode for the primary send gesture while the addressed agent is busy. */
  busyEnter: BusyEnterBehavior
  /** Gesture that sends a message instead of breaking the line. */
  sendGesture: SendGesture
}

/** Durable conversation schema; also the wire envelope the browser scope validates against. */
export const ConversationSettingsFields = {
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
  [SEND_GESTURE_FIELD]: z.union([...SEND_GESTURES]).default(DEFAULT_SEND_GESTURE),
}

/** Schema for shared configuration values. */
export const ConversationSettingsSchema = z.object(ConversationSettingsFields)
