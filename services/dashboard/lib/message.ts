import fs from 'fs'
import path from 'path'

export type MessageSeverity = 'info' | 'success' | 'warning' | 'alert'

export interface Message {
  text: string
  title: string
  severity: MessageSeverity
  enabled: boolean
  updatedAt: string
}

const MESSAGE_PATH = path.join(process.cwd(), 'data', 'message.json')

export function readMessage(): Message {
  try {
    const raw = fs.readFileSync(MESSAGE_PATH, 'utf-8')
    return JSON.parse(raw) as Message
  } catch {
    return { text: '', title: '', severity: 'info', enabled: false, updatedAt: new Date().toISOString() }
  }
}

export function writeMessage(msg: Partial<Message>): Message {
  const current = readMessage()
  const updated: Message = { ...current, ...msg, updatedAt: new Date().toISOString() }

  const dataDir = path.dirname(MESSAGE_PATH)
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

  fs.writeFileSync(MESSAGE_PATH, JSON.stringify(updated, null, 2))
  return updated
}
