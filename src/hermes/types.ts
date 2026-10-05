export interface SessionRow {
  id: string
  title?: string | null
  preview?: string | null
  last_active?: number
  profile?: string
}

export interface Message {
  key: string
  role: string
  text: string
  rowId?: number
  kind?: string
}

export interface HistoryPage {
  session_id: string
  profile?: string
  messages: Array<{
    id?: number; row_id?: number; role: string; content?: unknown; text?: string
    display_content?: string; display_kind?: string; name?: string
  }>
  pagination: { returned: number; offset: number; limit: number }
}

export interface Approval {
  request_id?: string | null
  command?: string | null
  description?: string | null
  choices?: string[] | null
  allow_session?: boolean | null
  allow_permanent?: boolean | null
}

export interface Question {
  qid: string
  question: string
  choices?: string[] | null
  multi_select?: boolean
}

export interface ServerRequest {
  id: string
  method: string
  params: {
    session_id?: string
    gateway_session_id?: string
    questions?: Question[]
    answers?: Record<string, string | null> | null
    [key: string]: unknown
  }
}

export interface Snapshot {
  session_id: string
  message_count?: number
  stored_session_id?: string | null
  info: { stored_session_id?: string; running?: boolean; title?: string; profile_name?: string | null; lazy?: boolean }
  running?: boolean | null
  inflight?: { user?: string; assistant?: string; streaming?: boolean; error?: string | null } | null
  pending_approval?: Approval | null
  open_requests?: ServerRequest[] | null
}

export interface GatewayEvent {
  type: string
  session_id?: string
  seq?: number
  payload?: Record<string, unknown>
}

export type Connection = 'connecting' | 'recovering' | 'ready' | 'reconnecting' | 'expired' | 'failed' | 'closed'
