// Layout choices a viewer makes for a demo or a small screen: the Members panel folds away to
// its header, and the Team map and Agents row is dragged (or keyed) to a height. Both are
// remembered in this browser and work without storage.

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RosterMember } from '@/api/types'
import { Members, MEMBERS_STORAGE_KEY } from '@/components/console/members'
import { ResizableRow, ROW_HEIGHT_STORAGE_KEY, ROW_MAX, ROW_MIN } from '@/components/console/resizable-row'
import { renderWithClient } from './render'

const ROSTER: RosterMember[] = [
  { member: 'alice', emails: ['alice@example.com'], role: 'owner' },
  { member: 'bob', emails: ['bob@example.com'], role: 'member' },
]

function members() {
  return renderWithClient(<Members roster={{ members: ROSTER }} loading={false} failed={false} me="alice" owner />)
}

function row() {
  return render(
    <ResizableRow className="grid">
      {(sized) => <div data-sized={sized ? 'yes' : 'no'}>map and agents</div>}
    </ResizableRow>,
  )
}

const rowEl = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-row-height]')!

beforeEach(() => {
  window.localStorage.clear()
})

describe('members panel: fold away', () => {
  it('starts open, closes to its header with the counts still showing, and remembers it', async () => {
    const user = userEvent.setup()
    members()
    const toggle = screen.getByRole('button', { name: 'Members' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: 'Team members' })).toBeInTheDocument()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Team members' })).toBeNull()
    expect(screen.queryByRole('form', { name: 'Invite a member' })).toBeNull()
    expect(screen.getByText('2 members, 1 owner')).toBeInTheDocument()
    expect(window.localStorage.getItem(MEMBERS_STORAGE_KEY)).toBe('closed')

    await user.click(toggle)
    expect(screen.getByRole('list', { name: 'Team members' })).toBeInTheDocument()
    expect(window.localStorage.getItem(MEMBERS_STORAGE_KEY)).toBe('open')
  })

  it('starts closed when the viewer left it closed, and toggles from the keyboard', async () => {
    window.localStorage.setItem(MEMBERS_STORAGE_KEY, 'closed')
    const user = userEvent.setup()
    members()
    expect(screen.queryByRole('list', { name: 'Team members' })).toBeNull()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Members' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('list', { name: 'Team members' })).toBeInTheDocument()
  })

  it('still folds when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const user = userEvent.setup()
    members()
    await user.click(screen.getByRole('button', { name: 'Members' }))
    expect(screen.queryByRole('list', { name: 'Team members' })).toBeNull()
  })
})

describe('team map and agents row: resize', () => {
  it('keeps its natural height until resized', () => {
    const { container } = row()
    expect(rowEl(container).dataset.rowHeight).toBe('auto')
    expect(screen.getByText('map and agents')).toHaveAttribute('data-sized', 'no')
  })

  it('steps with the arrow keys from its measured height, within bounds, and remembers it', () => {
    const { container } = row()
    vi.spyOn(rowEl(container), 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect)
    const handle = screen.getByRole('separator', { name: 'Resize the team map and agents' })

    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(rowEl(container).dataset.rowHeight).toBe('424')
    expect(rowEl(container).style.getPropertyValue('--row-h')).toBe('424px')
    expect(screen.getByText('map and agents')).toHaveAttribute('data-sized', 'yes')
    expect(window.localStorage.getItem(ROW_HEIGHT_STORAGE_KEY)).toBe('424')

    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(rowEl(container).dataset.rowHeight).toBe('376')
    expect(handle).toHaveAttribute('aria-valuenow', '376')
  })

  it('follows a drag of the handle and stores where it was let go', () => {
    const { container } = row()
    vi.spyOn(rowEl(container), 'getBoundingClientRect').mockReturnValue({ height: 300 } as DOMRect)
    const handle = screen.getByRole('separator')
    handle.setPointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)
    handle.releasePointerCapture = vi.fn()

    fireEvent.pointerDown(handle, { button: 0, clientY: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 620, pointerId: 1 })
    expect(rowEl(container).dataset.rowHeight).toBe('420')
    fireEvent.pointerMove(handle, { clientY: 5000, pointerId: 1 })
    expect(rowEl(container).dataset.rowHeight).toBe(String(ROW_MAX))
    fireEvent.pointerMove(handle, { clientY: 0, pointerId: 1 })
    expect(rowEl(container).dataset.rowHeight).toBe(String(ROW_MIN))
    fireEvent.pointerUp(handle, { clientY: 0, pointerId: 1 })
    expect(window.localStorage.getItem(ROW_HEIGHT_STORAGE_KEY)).toBe(String(ROW_MIN))
  })

  it('comes back at the stored height, and a double-click or Escape returns it to natural', () => {
    window.localStorage.setItem(ROW_HEIGHT_STORAGE_KEY, '512')
    const { container } = row()
    const handle = screen.getByRole('separator')
    expect(rowEl(container).dataset.rowHeight).toBe('512')

    fireEvent.doubleClick(handle)
    expect(rowEl(container).dataset.rowHeight).toBe('auto')
    expect(window.localStorage.getItem(ROW_HEIGHT_STORAGE_KEY)).toBeNull()

    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    fireEvent.keyDown(handle, { key: 'Escape' })
    expect(rowEl(container).dataset.rowHeight).toBe('auto')
  })

  it('ignores a stored height that is not a number', () => {
    window.localStorage.setItem(ROW_HEIGHT_STORAGE_KEY, 'tall')
    const { container } = row()
    expect(rowEl(container).dataset.rowHeight).toBe('auto')
  })
})
