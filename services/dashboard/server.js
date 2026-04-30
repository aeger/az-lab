'use strict'

const { createServer } = require('http')
const { parse } = require('url')
const fs = require('fs')
const next = require('next')
const { WebSocketServer } = require('ws')
const { Client } = require('ssh2')

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = parseInt(process.env.PORT || '3000', 10)

const SSH_HOST = process.env.TERMINAL_SSH_HOST || '192.168.1.181'
const SSH_PORT = parseInt(process.env.TERMINAL_SSH_PORT || '22', 10)
const SSH_USER = process.env.TERMINAL_SSH_USER || 'almty1'
const SSH_KEY_PATH = process.env.TERMINAL_SSH_KEY || '/run/secrets/terminal_ssh_key'

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

async function checkAuth(req) {
  const cookie = req.headers['cookie'] || ''
  try {
    const res = await fetch('https://auth.az-lab.dev/api/state', {
      headers: { cookie },
    })
    const data = await res.json()
    return data?.data?.authentication_level > 0
  } catch {
    return false
  }
}

function handleTerminal(ws, req) {
  checkAuth(req).then((authed) => {
    if (!authed) {
      ws.send(Buffer.from('\r\n\x1b[31mUnauthorized — sign in via auth.az-lab.dev\x1b[0m\r\n'))
      ws.close(1008, 'Unauthorized')
      return
    }

    let privateKey
    try {
      privateKey = fs.readFileSync(SSH_KEY_PATH)
    } catch (e) {
      ws.send(Buffer.from(`\r\n\x1b[31mCannot read SSH key: ${e.message}\x1b[0m\r\n`))
      ws.close()
      return
    }

    const conn = new Client()

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          ws.send(Buffer.from(`\r\n\x1b[31mSSH shell error: ${err.message}\x1b[0m\r\n`))
          ws.close()
          return
        }

        stream.on('data', (data) => {
          if (ws.readyState === ws.OPEN) ws.send(data)
        })

        stream.stderr.on('data', (data) => {
          if (ws.readyState === ws.OPEN) ws.send(data)
        })

        ws.on('message', (msg) => {
          try {
            const parsed = JSON.parse(msg.toString())
            if (parsed.type === 'resize') {
              stream.setWindow(parsed.rows, parsed.cols, 0, 0)
            } else if (parsed.type === 'data') {
              stream.write(parsed.data)
            }
          } catch {
            stream.write(msg)
          }
        })

        ws.on('close', () => {
          stream.end()
          conn.end()
        })

        stream.on('close', () => {
          if (ws.readyState === ws.OPEN) ws.close()
        })
      })
    })

    conn.on('error', (err) => {
      ws.send(Buffer.from(`\r\n\x1b[31mSSH error: ${err.message}\x1b[0m\r\n`))
      if (ws.readyState === ws.OPEN) ws.close()
    })

    conn.connect({
      host: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      privateKey,
    })
  })
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url, true))
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url)
    if (pathname === '/api/terminal') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminal(ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`)
  })
})
