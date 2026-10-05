import { describe, expect, it } from 'vitest'
import { modelSwitchValue } from '../src/hermes/settings'

describe('model switch arguments', () => {
  it('quotes model and provider names while explicitly restricting the change to the session', () => {
    expect(modelSwitchValue({ model: 'model --global', provider: "provider's name" })).toBe("'model --global' --provider 'provider'\\''s name' --session")
  })
})
