#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const postgres = require('../src/models/postgres')
const dimensionalStore = require('../src/services/usageStores/postgresDimensionalUsageStore')

function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    file: null,
    batchSize: 500,
    dryRun: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--file') {
      options.file = argv[++index]
    } else if (argument === '--batch-size') {
      options.batchSize = Math.min(5000, Math.max(1, Number.parseInt(argv[++index], 10) || 500))
    } else if (argument === '--dry-run') {
      options.dryRun = true
    } else if (argument === '--help') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function printHelp() {
  console.log(`Usage:
  node scripts/import-langfuse-usage-rollups.js --file <json-or-ndjson> [options]

The input must already be aggregated to account/model/api_key/time-bucket rows.
Both camelCase and snake_case field names are accepted.

Options:
  --batch-size <number>    Rows per PostgreSQL upsert (default: 500)
  --dry-run                Parse and validate without writing`)
}

function readRows(filePath) {
  const absolutePath = path.resolve(filePath)
  const source = fs.readFileSync(absolutePath, 'utf8').trim()
  if (!source) {
    return []
  }
  if (source.startsWith('[')) {
    const parsed = JSON.parse(source)
    if (!Array.isArray(parsed)) {
      throw new Error('JSON import file must contain an array')
    }
    return parsed
  }
  return source
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`Invalid NDJSON at line ${index + 1}: ${error.message}`)
      }
    })
}

function validateRow(row, index) {
  const bucketStart = row.bucketStart || row.bucket_start
  const apiKeyId = row.apiKeyId || row.api_key_id
  const model = row.normalizedModel || row.normalized_model || row.model
  if (!bucketStart || Number.isNaN(new Date(bucketStart).getTime())) {
    throw new Error(`Row ${index + 1} has an invalid bucketStart`)
  }
  if (!apiKeyId || !model) {
    throw new Error(`Row ${index + 1} requires apiKeyId and model`)
  }
  dimensionalStore.normalizeGranularity(row.granularity || 'day')
}

async function main() {
  const options = parseArguments()
  if (options.help) {
    printHelp()
    return
  }
  if (!options.file) {
    throw new Error('--file is required')
  }

  const rows = readRows(options.file)
  rows.forEach(validateRow)
  if (options.dryRun) {
    console.log(JSON.stringify({ parsedRows: rows.length, dryRun: true }, null, 2))
    return
  }

  let upserted = 0
  for (let index = 0; index < rows.length; index += options.batchSize) {
    const result = await dimensionalStore.upsertAggregatedRows(
      rows.slice(index, index + options.batchSize),
      { sourceType: 'langfuse' }
    )
    upserted += result.upserted
  }
  console.log(JSON.stringify({ parsedRows: rows.length, upserted }, null, 2))
}

main()
  .catch((error) => {
    console.error(`Langfuse usage rollup import failed: ${error.stack || error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await postgres.close().catch(() => {})
  })
