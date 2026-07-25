#!/usr/bin/env node

require('dotenv').config()

const postgres = require('../src/models/postgres')
const requestDetailPostgresStore = require('../src/services/requestDetailStores/postgresRequestDetailStore')
const requestFailurePostgresStore = require('../src/services/requestFailureStores/postgresRequestFailureStore')

async function main() {
  try {
    const reset = process.argv.includes('--reset')
    if (reset) {
      await requestDetailPostgresStore.resetSchema()
      await requestFailurePostgresStore.ensureSchema()
      console.log('✅ request detail PostgreSQL split schema was reset and recreated')
    } else {
      await Promise.all([
        requestDetailPostgresStore.ensureSchema(),
        requestFailurePostgresStore.ensureSchema()
      ])
      console.log('✅ request detail and independent failure PostgreSQL schemas are ready')
    }
  } finally {
    await postgres.close()
  }
}

main().catch((error) => {
  console.error(`❌ Failed to initialize request_details PostgreSQL schema: ${error.message}`)
  process.exit(1)
})
