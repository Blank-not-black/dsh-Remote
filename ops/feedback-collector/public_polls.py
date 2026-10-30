"""Read-only public choice tallies. Never return feedback records or free text."""
import datetime
import json
from pathlib import Path
import threading
import time

_lock = threading.Lock()
_cache = None
_cache_until = 0


def _date(value):
    try:
        return datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, OverflowError):
        return None


def _definition(item, now):
    poll = item.get('poll')
    if not isinstance(poll, dict) or not item.get('id') or not poll.get('id'):
        return None
    if item.get('disabled') or item.get('enabled') is False:
        return None
    published = _date(item.get('publishedAt'))
    if published is not None and published > now:
        return None
    rows = poll.get('questions')
    legacy = not isinstance(rows, list)
    if legacy:
        rows = [dict(poll, id='choice', type=poll.get('type', 'single'))]
    if not 1 <= len(rows) <= 8:
        return None
    questions, rules, ids, private = [], [], set(), 0
    for row in rows:
        qid, kind = row.get('id'), row.get('type', 'single')
        if not isinstance(qid, str) or not qid or qid in ids or kind not in ('single', 'multiple', 'text'):
            return None
        ids.add(qid)
        required = row.get('required') is not False
        rule = {'id': qid, 'type': kind, 'min': 1 if required else 0}
        if kind == 'text':
            rule['max'] = row.get('maxLength', 600)
            private += 1
        else:
            opts = row.get('options', [])
            if not isinstance(opts, list) or not 2 <= len(opts) <= 12:
                return None
            option_ids = [o.get('id') for o in opts if isinstance(o, dict)]
            if len(option_ids) != len(opts) or any(not isinstance(o, str) or not o for o in option_ids) or len(set(option_ids)) != len(opts):
                return None
            rule['options'] = set(option_ids)
            rule['max'] = 1 if kind == 'single' else row.get('maxSelections', len(opts))
            if kind == 'multiple' and required:
                rule['min'] = row.get('minSelections', 1)
            questions.append({'id': qid, 'type': kind, 'question': row.get('question') or poll.get('question') or item.get('title'), 'total': 0,
                              'options': [{'id': o['id'], 'label': str(o.get('label', o['id'])), 'count': 0} for o in opts]})
        rules.append(rule)
    expires = _date(item.get('expiresAt'))
    view = {'announcementId': item['id'], 'pollId': poll['id'], 'title': str(item.get('title', poll.get('question', '投票'))),
            'question': str(poll.get('question', '')), 'publishedAt': item.get('publishedAt'), 'expiresAt': item.get('expiresAt'),
            'status': 'closed' if expires is not None and expires <= now else 'open',
            'submissions': 0, 'privateQuestionCount': private, 'questions': questions}
    return view, rules, legacy


def _ballot(record, rules, legacy):
    try:
        encoded = json.loads(record.get('message', '')[5:]) if record.get('message', '').startswith('POLL ') else {}
        if not isinstance(encoded, dict):
            return None
        for key in ('announcementId', 'pollId', 'optionId'):
            if record.get(key) and encoded.get(key) and record[key] != encoded[key]:
                return None
        value = dict(encoded, **{k: v for k, v in record.items() if k != 'message'})
        if legacy and rules[0]['type'] == 'single' and value.get('optionId'):
            answers = [{'questionId': 'choice', 'optionIds': [value['optionId']]}]
        else:
            answers = value.get('answers')
        if not isinstance(answers, list) or not 1 <= len(answers) <= 8:
            return None
        by_id = {}
        for answer in answers:
            if not isinstance(answer, dict) or not isinstance(answer.get('questionId'), str) or answer['questionId'] in by_id:
                return None
            by_id[answer['questionId']] = answer
        if set(by_id) - {q['id'] for q in rules}:
            return None
        selections = {}
        for rule in rules:
            answer = by_id.get(rule['id'], {})
            if rule['type'] == 'text':
                text = answer.get('text', '')
                if not isinstance(text, str) or not rule['min'] <= len(text.strip()) <= rule['max']:
                    return None
            else:
                opts = answer.get('optionIds', [])
                if not isinstance(opts, list) or any(not isinstance(o, str) for o in opts) or len(set(opts)) != len(opts):
                    return None
                if not rule['min'] <= len(opts) <= rule['max'] or set(opts) - rule['options']:
                    return None
                selections[rule['id']] = opts
        return selections
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def summarize(announcements, lines, now=None):
    now = time.time() if now is None else now
    items = announcements if isinstance(announcements, list) else announcements.get('items')
    if not isinstance(items, list) or len(items) > 200:
        raise ValueError('invalid public announcements')
    definitions = {}
    for item in items:
        definition = _definition(item, now) if isinstance(item, dict) else None
        if definition:
            view = definition[0]
            definitions[(view['announcementId'], view['pollId'])] = definition
    # The public display follows only the newest published poll, including when closed.
    if definitions:
        latest = max(definitions, key=lambda k: _date(definitions[k][0].get('publishedAt')) or 0)
        definitions = {latest: definitions[latest]}
    for line in lines:
        if len(line) > 65536:
            continue
        try:
            record = json.loads(line)
            if not isinstance(record, dict) or record.get('type') != 'poll':
                continue
            encoded = json.loads(record['message'][5:]) if str(record.get('message', '')).startswith('POLL ') else {}
            key = (record.get('announcementId') or encoded.get('announcementId'), record.get('pollId') or encoded.get('pollId'))
            definition = definitions.get(key)
            if not definition:
                continue
            view, rules, legacy = definition
            selections = _ballot(record, rules, legacy)
            if selections is None:
                continue
            view['submissions'] += 1
            for question in view['questions']:
                chosen = selections.get(question['id'], [])
                if chosen:
                    question['total'] += 1
                    for option in question['options']:
                        option['count'] += option['id'] in chosen
        except (ValueError, TypeError, KeyError, AttributeError):
            continue
    polls = [d[0] for d in definitions.values()]
    polls.sort(key=lambda p: _date(p.get('publishedAt')) or 0, reverse=True)
    return {'ok': True, 'generatedAt': datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(), 'polls': polls}


def public_polls(data_dir):
    global _cache, _cache_until
    root = Path(data_dir)
    with _lock:
        now = time.time()
        if _cache is not None and now < _cache_until:
            return _cache
        announcements, feedback = root / 'announcements.json', root / 'feedback.jsonl'
        a_stat = announcements.stat()
        f_stat = feedback.stat() if feedback.exists() else None
        if a_stat.st_size > 512 * 1024 or (f_stat and f_stat.st_size > 32 * 1024 * 1024):
            raise ValueError('public summary source exceeds limit')
        # Recompute status as time passes even if no new vote was written.
        data = json.loads(announcements.read_text(encoding='utf-8'))
        if f_stat:
            with feedback.open(encoding='utf-8') as handle:
                result = summarize(data, handle, now)
        else:
            result = summarize(data, [], now)
        _cache, _cache_until = result, now + 5
        return result
