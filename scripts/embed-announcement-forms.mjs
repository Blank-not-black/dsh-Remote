/* Keep the schema shared while retaining a standalone single-file gateway. */
import { writeFileSync } from 'node:fs'
import { readEmbeddedSource } from './read-embedded-source.mjs'
const source = readEmbeddedSource(new URL('../public/announcement-forms.js', import.meta.url))
const factory = source.slice(source.indexOf('function createAnnouncementForms()'), source.indexOf('\n;(function(root)'))
const url = new URL('../gateway.js', import.meta.url), current = readEmbeddedSource(url)
const begin = '// BEGIN EMBEDDED ANNOUNCEMENT FORMS', end = '// END EMBEDDED ANNOUNCEMENT FORMS'
const block = `${begin}\n${factory}\nconst announcementForms = createAnnouncementForms()\n${end}`
const next = current.includes(begin) ? current.slice(0, current.indexOf(begin)) + block + current.slice(current.indexOf(end) + end.length)
  : current.replace('function findPollVote(', block + '\n\nfunction findPollVote(')
if (process.argv.includes('--check')) {
  if (next !== current) { console.error('Announcement schema is not synchronized'); process.exitCode = 1 }
} else if (next !== current) writeFileSync(url, next)
