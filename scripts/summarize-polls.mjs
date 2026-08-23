#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function usage() {
  console.error('Usage: node scripts/summarize-polls.mjs <feedback.jsonl> [--json]')
  process.exitCode = 2
}

function voteOf(record) {
  if (!record || record.type !== 'poll') return null
  let announcementId = String(record.announcementId || '').trim()
  let pollId = String(record.pollId || '').trim()
  let optionId = String(record.optionId || '').trim()
  const message = String(record.message || '').trim()
  if ((!announcementId || !pollId || !optionId) && message.startsWith('POLL ')) {
    try {
      const value = JSON.parse(message.slice(5))
      announcementId ||= String(value.announcementId || '').trim()
      pollId ||= String(value.pollId || '').trim()
      optionId ||= String(value.optionId || '').trim()
    } catch {}
  }
  return announcementId && pollId && optionId ? { announcementId, pollId, optionId } : null
}

const args = process.argv.slice(2)
const fileArg = args.find(arg => !arg.startsWith('-'))
if (!fileArg) usage()
else {
  let raw
  try { raw = readFileSync(resolve(fileArg), 'utf8') } catch (err) {
    console.error(`Unable to read ${fileArg}: ${err.message}`)
    process.exitCode = 1
  }
  if (raw != null) {
    const polls = new Map()
    let invalid = 0
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let record
      try { record = JSON.parse(line) } catch { invalid++; continue }
      if (record?.type !== 'poll') continue
      const vote = voteOf(record)
      if (!vote) { invalid++; continue }
      const key = `${vote.announcementId}\u0000${vote.pollId}`
      let poll = polls.get(key)
      if (!poll) {
        poll = { announcementId: vote.announcementId, pollId: vote.pollId, total: 0, options: {} }
        polls.set(key, poll)
      }
      poll.total++
      poll.options[vote.optionId] = (poll.options[vote.optionId] || 0) + 1
    }
    const result = [...polls.values()].sort((a, b) => a.announcementId.localeCompare(b.announcementId) || a.pollId.localeCompare(b.pollId))
    if (args.includes('--json')) {
      console.log(JSON.stringify({ polls: result, invalid }, null, 2))
    } else if (!result.length) {
      console.log('No valid poll votes found.')
      if (invalid) console.log(`Ignored invalid poll records: ${invalid}`)
    } else {
      for (const poll of result) {
        console.log(`${poll.announcementId} / ${poll.pollId} (${poll.total})`)
        for (const [optionId, count] of Object.entries(poll.options).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
          const percent = poll.total ? ((count / poll.total) * 100).toFixed(1) : '0.0'
          console.log(`  ${optionId}: ${count} (${percent}%)`)
        }
      }
      if (invalid) console.log(`Ignored invalid poll records: ${invalid}`)
    }
  }
}

