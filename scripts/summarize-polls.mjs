#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function usage() {
  console.error('Usage: node scripts/summarize-polls.mjs <feedback.jsonl> [--json]')
  process.exitCode = 2
}

function voteOf(record) {
  if (!record || record.type !== 'poll') return null
  let encoded = {}
  if (String(record.message || '').startsWith('POLL ')) try { encoded = JSON.parse(record.message.slice(5)) } catch {}
  const announcementId = String(record.announcementId || encoded.announcementId || '').trim()
  const pollId = String(record.pollId || encoded.pollId || '').trim()
  const optionId = String(record.optionId || encoded.optionId || '').trim()
  if (!announcementId || !pollId) return null
  if (optionId) return { announcementId, pollId, optionId }
  const answers = record.answers ?? encoded.answers
  if (!Array.isArray(answers) || !answers.length || answers.length > 8) return null
  const ids = new Set()
  for (const answer of answers) {
    if (!answer || typeof answer.questionId !== 'string' || !answer.questionId || ids.has(answer.questionId)) return null
    ids.add(answer.questionId)
    if (typeof answer.text === 'string' && answer.text.length <= 1200) continue
    if (!Array.isArray(answer.optionIds) || !answer.optionIds.length || answer.optionIds.length > 12 || new Set(answer.optionIds).size !== answer.optionIds.length || answer.optionIds.some(id => typeof id !== 'string' || !id)) return null
  }
  return { announcementId, pollId, answers }
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
        poll = { announcementId: vote.announcementId, pollId: vote.pollId, total: 0, options: Object.create(null) }
        polls.set(key, poll)
      }
      poll.total++
      if (vote.optionId) poll.options[vote.optionId] = (poll.options[vote.optionId] || 0) + 1
      else {
        poll.questions ||= Object.create(null)
        for (const answer of vote.answers) {
          const question = poll.questions[answer.questionId] ||= { total: 0, options: Object.create(null), texts: [] }
          question.total++
          if (typeof answer.text === 'string') question.texts.push(answer.text)
          else for (const id of answer.optionIds) question.options[id] = (question.options[id] || 0) + 1
        }
      }
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
        for (const [id, question] of Object.entries(poll.questions || {})) {
          console.log(`  ${id}: ${question.total} responses`)
          for (const [option, count] of Object.entries(question.options)) console.log(`    ${option}: ${count}`)
          for (const value of question.texts) console.log('    ' + JSON.stringify(value))
        }
        for (const [optionId, count] of Object.entries(poll.options).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
          const percent = poll.total ? ((count / poll.total) * 100).toFixed(1) : '0.0'
          console.log(`  ${optionId}: ${count} (${percent}%)`)
        }
      }
      if (invalid) console.log(`Ignored invalid poll records: ${invalid}`)
    }
  }
}

