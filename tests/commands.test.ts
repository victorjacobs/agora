import { describe, expect, it, vi } from 'vitest'
import { commandCatalog, executeCommand, slashCommand } from '../src/hermes/commands'
import { ConnectionLost, Gateway, RpcError } from '../src/hermes/gateway'

describe('slash command protocol', () => {
  it('preserves multiline arguments and distinguishes file paths from commands', () => {
    expect(slashCommand('/Goal Fix this\n  keep indentation\n\nand blank lines')).toEqual({ name: 'goal', arg: 'Fix this\n  keep indentation\n\nand blank lines' })
    expect(slashCommand('/')).toEqual({ name: '', arg: '' })
    expect(slashCommand('/usr/local')).toBeUndefined()
    expect(slashCommand('Please /help')).toBeUndefined()
  })

  it('reads the profile-scoped server catalog instead of inventing command names', async () => {
    const gateway = new Gateway()
    const request = vi.spyOn(gateway, 'request').mockResolvedValue({ pairs: [['/help', 'Help'], ['/my-skill', 'Custom skill'], ['invalid'], null] })
    expect(await commandCatalog(gateway, 'runtime', 'work')).toEqual([{ name: '/help', description: 'Help' }, { name: '/my-skill', description: 'Custom skill' }])
    expect(request).toHaveBeenCalledExactlyOnceWith('commands.catalog', { session_id: 'runtime', profile: 'work' })
  })

  it('falls back only on an explicit routing refusal, preserving arguments and profile', async () => {
    const gateway = new Gateway()
    const request = vi.spyOn(gateway, 'request').mockRejectedValueOnce(new RpcError(4018, 'skill command: use command.dispatch for /review'))
      .mockResolvedValueOnce({ type: 'skill', name: 'review', message: 'Expanded prompt', display: '/review changes' })
    expect(await executeCommand(gateway, '/review changes\n  details', 'runtime', 'work')).toMatchObject({ type: 'skill', message: 'Expanded prompt', display: '/review changes' })
    expect(request).toHaveBeenNthCalledWith(2, 'command.dispatch', { session_id: 'runtime', profile: 'work', name: 'review', arg: 'changes\n  details' }, 300_000)
    request.mockClear().mockRejectedValue(new ConnectionLost())
    await expect(executeCommand(gateway, '/review', 'runtime')).rejects.toThrow(ConnectionLost)
    expect(request).toHaveBeenCalledTimes(1)
    request.mockClear().mockRejectedValue(new RpcError(5030, 'worker timed out'))
    await expect(executeCommand(gateway, '/review', 'runtime')).rejects.toThrow('worker timed out')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not follow aliases or routing directives after the session changes', async () => {
    const gateway = new Gateway()
    let current = true
    const request = vi.spyOn(gateway, 'request').mockImplementation(async () => {
      current = false
      return { type: 'alias', target: 'plan' }
    })
    await expect(executeCommand(gateway, '/shortcut', 'runtime', 'work', () => current)).rejects.toThrow('changed')
    expect(request).toHaveBeenCalledTimes(1)
    current = true
    request.mockClear().mockImplementation(async () => {
      current = false
      throw new RpcError(4018, 'use command.dispatch')
    })
    await expect(executeCommand(gateway, '/skill', 'runtime', 'work', () => current)).rejects.toThrow('changed')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('renders worker output and warnings, resolves aliases, and rejects malformed responses', async () => {
    const gateway = new Gateway()
    const request = vi.spyOn(gateway, 'request').mockResolvedValueOnce({ type: 'alias', target: 'help' }).mockResolvedValueOnce({ output: 'Help output', warning: 'Some commands unavailable' })
    expect(await executeCommand(gateway, '/h tools', 'runtime')).toEqual({ type: 'exec', output: 'Some commands unavailable\nHelp output' })
    expect(request).toHaveBeenNthCalledWith(2, 'slash.exec', { session_id: 'runtime', profile: undefined, command: 'help tools' }, 300_000)
    request.mockResolvedValue({ type: 'alias', target: 'h' })
    await expect(executeCommand(gateway, '/h', 'runtime')).rejects.toThrow('circular')
    request.mockResolvedValue({ status: 'streaming' })
    await expect(executeCommand(gateway, '/h', 'runtime')).rejects.toThrow('unsupported')
  })
})
