import { createServer } from './index.js'

const port = Number(process.env.PORT) || 8080
createServer()
  .start(port)
  .then((p) => console.log(`kuoluosaigai chat server listening on ws://localhost:${p}`))
