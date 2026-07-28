#!/usr/bin/env node

const config = require('../config/config')
const postgres = require('../src/models/postgres')
const dimensionalStore = require('../src/services/usageStores/postgresDimensionalUsageStore')

function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    start: null,
    end: null,
    granularities: ['day'],
    validate: false,
    dryRun: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--start') {
      options.start = argv[++index]
    } else if (argument === '--end') {
      options.end = argv[++index]
    } else if (argument === '--granularity') {
      options.granularities = String(argv[++index] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    } else if (argument === '--validate') {
      options.validate = true
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
  node scripts/backfill-dimensional-usage.js [options]

Options:
  --start <ISO date>                 Start time (defaults to first usage event)
  --end <ISO date>                   End time (defaults to now)
  --granularity <day,hour,minute>    Comma-separated granularities (default: day)
  --validate                         Validate every completed business day
  --dry-run                          Print the resolved work without writing`)
}

function normalizeDate(value, fallback) {
  const date = value ? new Date(value) : fallback
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`)
  }
  return date
}

async function resolveSourceRange(options) {
  const result = await postgres.query(
    'SELECT MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM usage_events'
  )
  const earliest = result.rows[0]?.earliest ? new Date(result.rows[0].earliest) : null
  const latest = result.rows[0]?.latest ? new Date(result.rows[0].latest) : null
  if (!earliest || !latest) {
    return null
  }
  const start = normalizeDate(options.start, earliest)
  const end = normalizeDate(options.end, new Date())
  if (start >= end) {
    throw new Error('Backfill start must be earlier than end')
  }
  return { start, end }
}

async function materializeInChunks(granularity, range, businessTimezone, dryRun) {
  dimensionalStore.normalizeGranularity(granularity)
  const chunkMs = 24 * 60 * 60 * 1000
  let cursor
  let end
  if (granularity === 'day') {
    const startRange = await dimensionalStore.resolveBusinessDayRange(
      dateTextInTimezone(range.start, businessTimezone),
      businessTimezone
    )
    const endRange = await dimensionalStore.resolveBusinessDayRange(
      dateTextInTimezone(range.end, businessTimezone),
      businessTimezone
    )
    cursor = startRange.startDate
    end = endRange.endDate
  } else {
    const intervalMs = granularity === 'minute' ? 60000 : 3600000
    cursor = new Date(Math.floor(range.start.getTime() / intervalMs) * intervalMs)
    end = new Date(Math.ceil(range.end.getTime() / intervalMs) * intervalMs)
  }
  let rows = 0
  let replacedRows = 0
  let chunks = 0

  while (cursor < end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + chunkMs, end.getTime()))
    if (!dryRun) {
      const result = await dimensionalStore.materializeRange({
        granularity,
        startDate: cursor,
        endDate: chunkEnd,
        businessTimezone
      })
      rows += result.rows || 0
      replacedRows += result.replacedRows || 0
    }
    chunks += 1
    cursor = chunkEnd
  }

  return { granularity, chunks, rows, replacedRows, dryRun }
}

function dateTextInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function shiftDateText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function validateCompletedDays(range, businessTimezone, dryRun) {
  const today = dateTextInTimezone(new Date(), businessTimezone)
  let dateText = dateTextInTimezone(range.start, businessTimezone)
  const endText = dateTextInTimezone(range.end, businessTimezone)
  const validations = []

  while (dateText <= endText && dateText < today) {
    if (!dryRun) {
      validations.push(await dimensionalStore.validateDay(dateText, businessTimezone))
    }
    dateText = shiftDateText(dateText, 1)
  }
  return validations
}

async function main() {
  const options = parseArguments()
  if (options.help) {
    printHelp()
    return
  }

  const businessTimezone = config.usageAggregation?.businessTimezone || 'Asia/Shanghai'
  const range = await resolveSourceRange(options)
  if (!range) {
    console.log('No usage_events rows found; nothing to backfill.')
    return
  }

  console.log(
    JSON.stringify(
      {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        granularities: options.granularities,
        businessTimezone,
        validate: options.validate,
        dryRun: options.dryRun
      },
      null,
      2
    )
  )

  if (!options.dryRun) {
    await dimensionalStore.ensureSchema()
  }
  const results = []
  for (const granularity of options.granularities) {
    results.push(await materializeInChunks(granularity, range, businessTimezone, options.dryRun))
  }
  const validations = options.validate
    ? await validateCompletedDays(range, businessTimezone, options.dryRun)
    : []
  const mismatches = validations.filter((validation) => !validation.verified)
  console.log(
    JSON.stringify(
      {
        results,
        validationDays: validations.length,
        mismatches: mismatches.map((validation) => validation.usageDate)
      },
      null,
      2
    )
  )
  if (mismatches.length > 0) {
    process.exitCode = 2
  }
}

main()
  .catch((error) => {
    console.error(`Dimensional usage backfill failed: ${error.stack || error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await postgres.close().catch(() => {})
  })
