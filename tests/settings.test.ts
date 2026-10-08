import { describe, expect, it } from 'vitest'
import { modelSwitchValue } from '../src/hermes/settings'

describe('model switch arguments', () => {
  it('sends literal model and provider tokens to the Hermes parser with session scope', () => {
    expect(modelSwitchValue({ model: 'gpt-6.1-sol', provider: 'openai-codex' })).toBe('gpt-6.1-sol --provider openai-codex --session')
  })

  it.each([
    { model: 'model --global', provider: 'openai-codex' },
    { model: 'model', provider: "provider's name" },
    { model: '--global', provider: 'openai-codex' },
    { model: 'model', provider: '--session' },
    { model: '', provider: 'openai-codex' },
    { model: 'model', provider: '' },
    { model: 'model\n--once', provider: 'openai-codex' },
  ])('rejects identifiers that cannot be represented as literal tokens: %j', choice => {
    expect(() => modelSwitchValue(choice)).toThrow('Model and provider IDs must be nonempty single tokens without flag prefixes.')
  })

  it('preserves slashes and colons in model and custom-provider identifiers', () => {
    expect(modelSwitchValue({ model: 'vendor/model:latest', provider: 'custom:local' })).toBe('vendor/model:latest --provider custom:local --session')
  })
})
