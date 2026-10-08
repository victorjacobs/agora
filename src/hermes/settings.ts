export interface ModelProvider {
  slug: string
  name: string
  models: string[]
  authenticated?: boolean
  unavailable_models?: string[]
  capabilities?: Record<string, { reasoning: boolean; can_disable_reasoning?: boolean }>
}

export interface ModelInventory {
  model?: string
  provider?: string
  providers: ModelProvider[]
}

export interface ModelChoice { model: string; provider: string }

export interface ModelChangeResult {
  value?: string
  warning?: string
  confirm_required?: boolean
  confirm_message?: string
  deferred?: boolean
  info?: SessionModelInfo
}

export interface SessionModelInfo {
  model?: string
  provider?: string
  reasoning_effort?: string
  reasoning_effort_wire?: string
}

export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export function modelSwitchValue(choice: ModelChoice) {
  if ([choice.model, choice.provider].some(value => !value || /\s/u.test(value) || value.startsWith('--'))) {
    throw new Error('Model and provider IDs must be nonempty single tokens without flag prefixes.')
  }
  return `${choice.model} --provider ${choice.provider} --session`
}
