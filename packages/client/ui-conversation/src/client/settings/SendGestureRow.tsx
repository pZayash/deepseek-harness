/** General Settings row for the Composer's send gesture. */
import { useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SendGesture } from '../contract/composer-submission.ts'
import type { ConversationKey } from '../locales.ts'
import css from './EnterBehaviorRow.module.css'

/** Registration-side gesture preference face. */
export interface SendGestureRowInjected {
  hooks: {
    /** Persisted send gesture bound as useSendGesture. */
    sendGesture: SnapshotStore<SendGesture>
  }
  /** Change the gesture that sends a message. */
  setSendGesture: (gesture: SendGesture) => void
}

/** Full Settings-row props. */
export type SendGestureRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<SendGestureRowInjected>

const OPTIONS: readonly {
  id: SendGesture
  label: ConversationKey
}[] = [
  { id: 'chord', label: 'settings.sendGesture.chord' },
  { id: 'enter', label: 'settings.sendGesture.enter' },
]

/**
 * Render the send-gesture selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function SendGestureRow({ useSendGesture, setSendGesture, t }: SendGestureRowProps) {
  const gesture = useSendGesture(value => value)
  const [open, setOpen] = useState(false)
  const selectedLabel = gesture === 'chord' ? 'settings.sendGesture.chord' : 'settings.sendGesture.enter'

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.sendGesture.title')}</div>
        <div className={css.desc}>{t('settings.sendGesture.description')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={gesture}
        onSelect={(id) => {
          setOpen(false)
          setSendGesture(id as SendGesture)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {t(selectedLabel)}
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
