// @vitest-environment-options {"url": "https://console.example.com/join"}
//
// /team-relay:setup on the hosted console: its Setup view is the Terminal page as before, with one
// more line ("Or, in Claude Code, type /team-relay:setup"), and it never asks for /api/local/*
// (those routes live only on the member's own Mac).

import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { setTransport } from '@/api/client'
import { isHosted } from '@/api/key'
import { App } from '@/App'
import { MockRelay } from '@/mock/relay'
import { renderWithClient } from './render'

describe('the hosted Setup view', () => {
  it('adds the /team-relay:setup line to the Mac step and never calls /api/local', async () => {
    expect(isHosted()).toBe(true)
    const relay = new MockRelay()
    relay.latency = [0, 0]
    const paths: string[] = []
    setTransport(async (path, init) => {
      paths.push(new URL(path, 'https://console.example.com/join').pathname)
      return relay.handle(path, init)
    })
    renderWithClient(<App />)
    const panel = await screen.findByRole('region', { name: 'Your setup' })
    const mac = await waitFor(() => {
      const el = panel.querySelector('[data-setup-step="mac"]') as HTMLElement
      expect(el.querySelector('[data-setup-command]')).not.toBeNull()
      return el
    })
    expect(mac.querySelector('[data-setup-command]')).toHaveTextContent('Or, in Claude Code, type /team-relay:setup')
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.some((p) => p.startsWith('/api/local'))).toBe(false)
  })
})
