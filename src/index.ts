import { config } from './config.js'
import { migrate } from './db/migrate.js'
import { pool } from './db/index.js'
import { buildServer } from './api/server.js'
import { initTelemetry } from './telemetry.js'

async function main(): Promise<void> {
  initTelemetry()
  await migrate()
  const app = await buildServer()
  await app.listen({ port: config.http.port, host: config.http.host })

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`)
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[api] failed to start:', err)
  process.exit(1)
})
