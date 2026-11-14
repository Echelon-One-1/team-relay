// @vitest-environment-options {"url": "https://console.example.com/join"}
//
// The hosted console's Setup view: the join card's steps through the Claude app (14 Nov 2026),
// ending in /team-relay:setup typed in a Code session, and it never asks for /api/local/* (those
// routes live only on the member's own Mac).

import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { setTransport } from '@/api/client'
import { isHosted } from '@/api/key'
import { App } from '@/App'
import { MockRelay } from '@/mock/relay'
import { renderWithClient } from './render'

describe('the hosted Setup view', () => {
  it('shows the join card with /team-relay:setup and never calls /api/local', async () => {
    expect(isHosted()).toBe(true)
    const relay = new MockRelay()
    relay.latency = [0, 0]
    const paths: string[] = []
    setTransport(async (path, init) => {
      paths.push(new URL(path, 'https://console.example.com/join').pathname)
      return relay.handle(path, init)
    })
    renderWithClient(<App />)
    const card = await screen.findByRole('region', { name: 'Join in 2 minutes' })
    await waitFor(() => expect(card.querySelector('[data-command="plugin source"]')).toHaveTextContent('example-org/team-relay'))
    expect(card.querySelector('[data-command="setup command"]')).toHaveTextContent('/team-relay:setup')
    const panel = await screen.findByRole('region', { name: 'Your setup' })
    expect(panel.querySelector('[data-setup-step="mac"] [data-setup-see-card]')).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/Terminal|curl|setup line/i)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.some((p) => p.startsWith('/api/local'))).toBe(false)
  })
})
