/* Shared bounded announcement schema. Embedded into the single-file gateway. */
'use strict';
function createAnnouncementForms() {
  const string = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : ''
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  function normalize(value, announcementId) {
    if (!value || typeof value !== 'object') return null
    const id = string(value.id || announcementId, 120)
    const legacy = !Array.isArray(value.questions) && !value.type || value.legacy === true
    const rows = Array.isArray(value.questions) ? value.questions : [{ ...value, id: 'answer' }]
    if (!id || !rows.length || rows.length > 8) return null
    const ids = new Set(), questions = []
    for (const row of rows) {
      const questionId = string(row?.id, 120), question = string(row?.question || row?.label, 300), type = row?.type || 'single'
      if (!questionId || ids.has(questionId) || !question || !['single','multiple','text'].includes(type)) return null
      ids.add(questionId)
      const required = row.required !== false, options = [], seen = new Set()
      if (type !== 'text') {
        if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 12) return null
        for (const option of row.options) {
          const optionId = string(option?.id, 120), label = string(option?.label, 200)
          if (!optionId || !label || seen.has(optionId)) return null
          seen.add(optionId); options.push({ id: optionId, label, description: string(option.description || '', 500) })
        }
      }
      const min = type === 'text' ? (required ? 1 : 0) : row.minSelections ?? row.min ?? (required ? 1 : 0)
      const max = type === 'text' ? row.maxLength ?? row.max ?? 600 : type === 'single' ? 1 : row.maxSelections ?? row.max ?? options.length
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < Math.max(1, min) || max > (type === 'text' ? 1200 : options.length)) return null
      questions.push({ id: questionId, question, type, required, options, min, max, placeholder: string(row.placeholder || '', 200) })
    }
    return { id, legacy: !!legacy, question: string(value.question || value.title, 300) || questions[0].question,
      options: questions.length === 1 ? questions[0].options : [], questions }
  }
  function validate(poll, payload) {
    if (!poll) return { error: 'poll not found' }
    const rows = poll.legacy && typeof payload.optionId === 'string' ? [{ questionId: poll.questions[0].id, optionIds: [payload.optionId] }] : payload.answers
    if (!Array.isArray(rows) || rows.length > poll.questions.length) return { error: 'invalid answers' }
    const byId = new Map()
    for (const row of rows) {
      if (!row || typeof row.questionId !== 'string' || byId.has(row.questionId) || !poll.questions.some(q => q.id === row.questionId)) return { error: 'invalid question' }
      byId.set(row.questionId, row)
    }
    const answers = []
    for (const q of poll.questions) {
      const row = byId.get(q.id)
      if (q.type === 'text') {
        const value = row?.text ?? ''
        if (typeof value !== 'string' || value.trim().length < q.min || value.trim().length > q.max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return { error: 'invalid text', questionId: q.id }
        if (value.trim()) answers.push({ questionId: q.id, text: value.trim() })
      } else {
        const values = row?.optionIds ?? []
        if (!Array.isArray(values) || values.length < q.min || values.length > q.max || new Set(values).size !== values.length) return { error: 'invalid selection count', questionId: q.id }
        if (values.some(id => typeof id !== 'string' || !q.options.some(option => option.id === id))) return { error: 'poll option not found', questionId: q.id }
        if (values.length) answers.push({ questionId: q.id, optionIds: q.options.filter(option => values.includes(option.id)).map(option => option.id) })
      }
    }
    if (!answers.length) return { error: 'answer required' }
    return poll.legacy ? { optionId: answers[0].optionIds[0] } : { answers }
  }
  function encode(announcementId, pollId, answer) {
    const message = 'POLL ' + JSON.stringify({ announcementId, pollId, ...answer })
    return message.length <= 2000 ? message : null
  }
  function render(poll, answers = [], disabled = false, english = false) {
    return poll.questions.map((q, index) => {
      const answer = answers.find(row => row.questionId === q.id), off = disabled ? ' disabled' : ''
      const label = q.question + (q.required ? ' *' : '')
      const body = q.type === 'text'
        ? `<textarea aria-label="${esc(label)}" id="announcement-field-${index}" maxlength="${q.max}" rows="2" placeholder="${esc(q.placeholder)}"${q.required ? ' required' : ''}${off}>${esc(answer?.text || '')}</textarea>`
        : q.options.map(option => `<label class="announcement-poll-option"><input type="${q.type === 'multiple' ? 'checkbox' : 'radio'}" name="announcement-q-${index}" value="${esc(option.id)}"${answer?.optionIds?.includes(option.id) ? ' checked' : ''}${off}><span><strong>${esc(option.label)}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span></label>`).join('')
      const hint = q.type === 'multiple' ? (english ? `Choose ${q.min}–${q.max}` : `选择 ${q.min}–${q.max} 项`) : q.type === 'text' ? (english ? `Up to ${q.max} characters` : `最多 ${q.max} 字`) : ''
      return `<fieldset class="announcement-form-field" data-form-question="${esc(q.id)}"><legend>${esc(label)}</legend>${hint ? `<p class="announcement-form-hint">${esc(hint)}</p>` : ''}${body}</fieldset>`
    }).join('')
  }
  function read(panel, poll) {
    const fields = [...panel.querySelectorAll('[data-form-question]')]
    return poll.questions.map(q => {
      const field = fields.find(el => el.dataset.formQuestion === q.id)
      return q.type === 'text' ? { questionId: q.id, text: field?.querySelector('textarea')?.value || '' }
        : { questionId: q.id, optionIds: [...(field?.querySelectorAll('input:checked') || [])].map(el => el.value) }
    })
  }
  return { normalize, validate, encode, render, read }
}
;(function(root) {
  const api = createAnnouncementForms()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshAnnouncementForms = api
})(typeof window === 'undefined' ? globalThis : window)
