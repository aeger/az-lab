import { readFileSync } from 'fs'
// ssh2 has bundled types but TypeScript can't resolve them in this build context
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ssh2: any = require('ssh2')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Client: new () => any = ssh2.Client

const SSH_KEY_PATH = process.env.TERMINAL_SSH_KEY || '/run/secrets/terminal_ssh_key'
const SSH_HOST = process.env.TERMINAL_SSH_HOST || '192.168.1.181'
const SSH_USER = process.env.TERMINAL_SSH_USER || 'almty1'

export function sshExec(command: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let output = ''
    let errOutput = ''
    const timer = setTimeout(() => {
      conn.destroy()
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    conn.on('ready', () => {
      conn.exec(command, (err: Error | null, stream: any) => {
        if (err) {
          clearTimeout(timer)
          conn.end()
          return reject(err)
        }
        stream.on('data', (d: Buffer) => { output += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { errOutput += d.toString() })
        stream.on('close', (code: number) => {
          clearTimeout(timer)
          conn.end()
          if (code === 0) {
            resolve(output)
          } else {
            reject(new Error(`Exit ${code}: ${errOutput || output}`))
          }
        })
      })
    })

    conn.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })

    let privateKey: Buffer
    try {
      privateKey = readFileSync(SSH_KEY_PATH)
    } catch (e) {
      clearTimeout(timer)
      return reject(new Error(`Cannot read SSH key: ${SSH_KEY_PATH}`))
    }

    conn.connect({
      host: SSH_HOST,
      port: 22,
      username: SSH_USER,
      privateKey,
      readyTimeout: 10_000,
    })
  })
}
