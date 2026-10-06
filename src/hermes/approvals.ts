import type { Approval } from './types'

export const approvalLabels: Record<string, string> = {
  once: 'Allow once', session: 'Allow for this conversation', always: 'Always allow', deny: 'Reject',
}

export function approvalChoices(approval: Approval): string[] {
  const choices = approval.choices || ['once',
    ...(approval.allow_session === true && !approval.smart_denied ? ['session'] : []),
    ...(approval.allow_permanent === true && !approval.smart_denied ? ['always'] : []), 'deny']
  return [...new Set(choices)].filter(choice => Object.hasOwn(approvalLabels, choice))
}

export function eventApproval(payload: Record<string, unknown>): Approval | undefined {
  if (typeof payload.command !== 'string' && typeof payload.description !== 'string') return undefined
  return {
    request_id: typeof payload.request_id === 'string' ? payload.request_id : undefined,
    command: typeof payload.command === 'string' ? payload.command : undefined,
    description: typeof payload.description === 'string' ? payload.description : undefined,
    tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
    choices: Array.isArray(payload.choices) ? payload.choices.filter((choice): choice is string => typeof choice === 'string') : undefined,
    allow_session: typeof payload.allow_session === 'boolean' ? payload.allow_session : undefined,
    allow_permanent: typeof payload.allow_permanent === 'boolean' ? payload.allow_permanent : undefined,
    smart_denied: payload.smart_denied === true,
  }
}
