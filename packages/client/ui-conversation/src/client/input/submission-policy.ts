/**
 * Composer submission policy. It owns the live busy-Enter preference, the
 * send gesture, and their resolution into queue/steer delivery modes; Host and
 * Agent keep the actual delivery-window authority.
 */
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  BusyEnterBehavior, ComposerSubmitGesture, InputSubmitMode, SendGesture,
} from '../contract/composer-submission.ts'
import {
  BUSY_ENTER_FIELD, DEFAULT_BUSY_ENTER_BEHAVIOR, DEFAULT_SEND_GESTURE, SEND_GESTURES, SEND_GESTURE_FIELD,
} from '../../submission-settings.ts'
import type { ConversationSettings } from '../../submission-settings.ts'

export { DEFAULT_BUSY_ENTER_BEHAVIOR, DEFAULT_SEND_GESTURE } from '../../submission-settings.ts'

/**
 * Whether a durable settings value names a supported send gesture. A Host
 * process older than the gesture setting publishes no value, and the browser
 * keeps its local default rather than publishing `undefined`.
 * @param value - the settings document field.
 * @returns whether this is one of the accepted gestures.
 */
function isSendGesture(value: unknown): value is SendGesture {
  return typeof value === 'string' && (SEND_GESTURES as readonly string[]).includes(value)
}

/**
 * Resolve one submission gesture against the busy-Enter preference. The
 * primary gesture and the primary Send button share the `enter` gesture, so
 * the button delivers exactly what that gesture would. Direct `steer` is
 * intentionally best-effort: AgentLoop turns a closed-window submission into
 * the next waking Queue item.
 * @param preferred - the live busy-Enter preference.
 * @param running - whether the addressed agent currently reports busy.
 * @param gesture - the primary send gesture (or the Send button) or the Cmd/Ctrl-complementary chord.
 * @param steeringAvailable - whether this session transport supports steering.
 * @returns Queue outside steer-capable busy state; otherwise the preferred mode or its opposite.
 */
export function resolveSubmitMode(
  preferred: BusyEnterBehavior,
  running: boolean,
  gesture: ComposerSubmitGesture,
  steeringAvailable: boolean,
): InputSubmitMode {
  if (!running || !steeringAvailable) return 'queue'
  if (gesture === 'enter') return preferred
  return preferred === 'queue' ? 'steer' : 'queue'
}

/**
 * Composer preferences shared by the composer bar inject face and their
 * Settings rows: one live store each for the bar's submission gestures and
 * Send label, backed by the Host user-settings document when one is composed.
 */
export class ComposerSubmissionPolicy {
  /** Reactive preference source for the composer bar and the Settings row. */
  readonly busyEnter: SnapshotStore<BusyEnterBehavior> = createSnapshotStore(DEFAULT_BUSY_ENTER_BEHAVIOR)
  /** Reactive send gesture for the composer keymap, hint copy, and the Settings row. */
  readonly sendGesture: SnapshotStore<SendGesture> = createSnapshotStore(DEFAULT_SEND_GESTURE)
  private readonly unsubscribe: (() => void) | undefined
  private readonly host: ConfigForm<ConversationSettings> | undefined

  /**
   * @param host Shared configuration form; omitted keeps the browser-local default.
   */
  constructor(host?: ConfigForm<ConversationSettings>) {
    this.host = host
    if (host !== undefined) {
      this.unsubscribe = host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /** Release the preference subscription. */
  dispose(): void { this.unsubscribe?.() }

  /**
   * Change the busy-state submission behavior; the live value publishes
   * before the durable write starts.
   * @param behavior - Queue or Steer.
   */
  setBusyEnter(behavior: BusyEnterBehavior): void {
    if (this.busyEnter.getSnapshot() === behavior) return
    this.busyEnter.set(behavior)
    void this.host?.set(BUSY_ENTER_FIELD, behavior)
  }

  /**
   * Change which gesture sends a message; the live value publishes before the
   * durable write starts, so the keymap follows the next keystroke.
   * @param gesture - Enter or the explicit chord.
   */
  setSendGesture(gesture: SendGesture): void {
    if (this.sendGesture.getSnapshot() === gesture) return
    this.sendGesture.set(gesture)
    void this.host?.set(SEND_GESTURE_FIELD, gesture)
  }

  /**
   * Adopt the scope's accepted durable preferences without writing them back.
   * @param host - the constructor-narrowed scope driving this adoption.
   */
  private adopt(host: ConfigForm<ConversationSettings>): void {
    const section = host.getSnapshot().value
    if (section === undefined) return
    if (this.busyEnter.getSnapshot() !== section.busyEnter) this.busyEnter.set(section.busyEnter)
    if (isSendGesture(section.sendGesture) && this.sendGesture.getSnapshot() !== section.sendGesture) {
      this.sendGesture.set(section.sendGesture)
    }
  }
}
