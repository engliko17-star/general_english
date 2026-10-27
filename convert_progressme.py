#!/usr/bin/env python3
"""ProgressMe → English Platform.

Читает файл выгрузки учебника (progressme-book-<id>.json, его делает pm-export-book.js)
и пишет SQL для Supabase: учебник, уроки (+ отдельные уроки с домашкой), заметки учителя.
Повторный запуск SQL обновляет уроки, а не дублирует их (сопоставление по source_ref).

    python3 convert_progressme.py progressme-book-1004574.json out_dir/

Формат блоков описан в docs/lesson-format.md.
"""
import html
import json
import re
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

# ---------------------------------------------------------------- HTML cleanup

KEEP = {'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'br', 'p', 'ul', 'ol', 'li',
        'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'h3', 'h4', 'h5', 'a', 'img', 'iframe'}
VOID = {'br', 'img'}
DROP_WITH_CONTENT = {'script', 'style', 'noscript', 'head', 'title'}
BLOCKISH = {'div', 'section', 'article', 'header', 'footer'}
IFRAME_HOSTS = ('youtube.com', 'youtube-nocookie.com', 'youtu.be', 'vimeo.com', 'drive.google.com', 'docs.google.com')
HEADINGS_MAP = {'h1': 'h3', 'h2': 'h3', 'h6': 'h5'}


def _safe_url(u):
    u = (u or '').strip()
    return u if urlparse(u).scheme in ('http', 'https') else None


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.stack = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        tag = HEADINGS_MAP.get(tag, tag)
        if tag in DROP_WITH_CONTENT:
            self.skip += 1
            return
        if self.skip:
            return
        a = dict(attrs)
        if tag == 'a':
            href = _safe_url(a.get('href'))
            if not href:
                self.stack.append(None)
                return
            self.out.append(f'<a href="{html.escape(href)}" target="_blank" rel="noopener">')
            self.stack.append('a')
        elif tag == 'img':
            src = _safe_url(a.get('src'))
            if src:
                self.out.append(f'<img src="{html.escape(src)}" alt="{html.escape(a.get("alt") or "")}" loading="lazy">')
        elif tag == 'iframe':
            src = _safe_url(a.get('src'))
            if src and any(h in urlparse(src).netloc for h in IFRAME_HOSTS):
                self.out.append(f'<iframe src="{html.escape(src)}" allowfullscreen loading="lazy"></iframe>')
            self.skip += 1  # iframe content is never meaningful
            self.stack.append('iframe-skip')
        elif tag in ('td', 'th'):
            extra = ''.join(f' {k}="{html.escape(a[k])}"' for k in ('colspan', 'rowspan') if (a.get(k) or '').isdigit())
            self.out.append(f'<{tag}{extra}>')
            self.stack.append(tag)
        elif tag in KEEP:
            self.out.append(f'<{tag}>')
            if tag not in VOID:
                self.stack.append(tag)
        elif tag in BLOCKISH:
            self.stack.append('#block')
        else:
            self.stack.append(None)  # unwrap: keep text, drop the tag

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and tag != 'iframe' and self.stack:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = HEADINGS_MAP.get(tag, tag)
        if tag in DROP_WITH_CONTENT:
            self.skip = max(0, self.skip - 1)
            return
        if tag in VOID:
            return
        if tag == 'iframe':
            if self.stack and self.stack[-1] == 'iframe-skip':
                self.stack.pop()
                self.skip = max(0, self.skip - 1)
            return
        if self.skip or not self.stack:
            return
        top = self.stack.pop()
        if top == '#block':
            self.out.append('<br>')
        elif top:
            self.out.append(f'</{top}>')

    def handle_data(self, data):
        if not self.skip:
            self.out.append(html.escape(data, quote=False))

    def result(self):
        while self.stack:
            top = self.stack.pop()
            if top and top not in ('#block', 'iframe-skip'):
                self.out.append(f'</{top}>')
        return ''.join(self.out)


LIGATURES = {'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st'}


def fix_text(s):
    """Undo PDF copy artefacts (ligatures such as 'ﬁ')."""
    for k, v in LIGATURES.items():
        s = s.replace(k, v)
    return s


def clean_html(s):
    """Whitelist-sanitize ProgressMe HTML and tidy whitespace."""
    if not s:
        return ''
    s = fix_text(s)
    p = _Sanitizer()
    p.feed(s)
    p.close()
    out = p.result().replace('\xa0', ' ')
    out = re.sub(r'[ \t]{2,}', ' ', out)
    out = re.sub(r'(<br>\s*)+(</(?:p|li|td|th)>)', r'\2', out)
    out = re.sub(r'<(b|strong|i|em|u|s|sub|sup|p|li)>\s*</\1>', '', out)
    out = re.sub(r'(<br>\s*){3,}', '<br><br>', out)
    out = re.sub(r'^(\s*<br>)+', '', out)
    out = re.sub(r'(<br>\s*)+$', '', out)
    out = re.sub(r'\s*<br>\s*', '<br>', out)
    return out.strip()


def plain(s):
    """HTML fragment → plain text (for answers inside gaps)."""
    return re.sub(r'\s+', ' ', fix_text(html.unescape(re.sub(r'<[^>]+>', '', s or ''))).replace('\xa0', ' ')).strip()


# ---------------------------------------------------------------- Gaps

GAP = re.compile(r'\[([^\[\]]*?)<em class="hide-id-exercise-item">##(\d+)##</em>\s*\]', re.S)
PH = '⁣G{}⁣'  # invisible placeholder that survives sanitizing


def gap_text(raw, make):
    """Replace ProgressMe gaps with {{...}} built by make(inner_plain_text). Returns (html, n_gaps)."""
    found = []

    def keep(m):
        found.append(plain(m.group(1)))
        return PH.format(len(found) - 1)

    body = clean_html(GAP.sub(keep, raw or ''))
    for i, inner in enumerate(found):
        body = body.replace(PH.format(i), make(inner))
    return body, len(found)


def esc_gap(s):
    return html.escape(s, quote=False).replace('{', '(').replace('}', ')').replace('|', '/')


def typed_gap(inner):
    """Type 10: a typed answer; alternatives separated by '/'. Empty = open answer (teacher checks)."""
    alts = [a.strip() for a in inner.split('/') if a.strip()] if inner else []
    return '{{' + '|'.join(esc_gap(a) for a in alts) + '}}'


def choice_gap(inner):
    """Type 13: options separated by '/', the correct one(s) marked with '*'."""
    opts = []
    for o in inner.split('/'):
        o = o.strip()
        if not o:
            continue
        ok = o.startswith('*') or o.endswith('*')
        o = o.strip('*').strip()
        opts.append(esc_gap(o) + ('*' if ok else ''))
    return '{{' + '|'.join(opts) + '}}'


def bank_gap(inner):
    return '{{' + esc_gap(inner) + '}}'


# ---------------------------------------------------------------- Exercises → blocks

def images_of(it):
    raw = it.get('ImagesJson')
    try:
        imgs = json.loads(raw).get('Images', []) if raw else []
    except (ValueError, AttributeError):
        imgs = []
    if not imgs and isinstance(it.get('Images'), list):
        imgs = [i for i in it['Images'] if isinstance(i, dict)]
    caps = it.get('Descriptions') or []
    out = []
    for n, im in enumerate(imgs):
        src = im.get('FullImageUrl') or im.get('ImageUrl') or im.get('ExternalImageUrl')
        if src:
            out.append({'src': src, 'caption': plain(caps[n]) if n < len(caps) and caps[n] else ''})
    return out


def videos_of(it):
    urls = []
    for v in (it.get('VideosUrl') or []) + (it.get('Videos') or []):
        u = v if isinstance(v, str) else (v.get('Url') or v.get('VideoUrl') or v.get('Link')) if isinstance(v, dict) else None
        if u and u not in urls:
            urls.append(u)
    return urls


def convert_item(it, notes, stats):
    """One ProgressMe exercise → list of blocks. Teacher-note text goes to `notes`."""
    t = it.get('Type')
    bid = f"pm-{it['Id']}"
    instr = clean_html(it.get('Name') or '')
    num = it.get('Number') if it.get('IsShowExerciseNumber') and it.get('Number') else None
    base = {'id': bid, 'pm': {'type': t, 'id': it['Id']}}
    if num:
        base['number'] = num
    if instr:
        base['instruction_html'] = instr

    def block(**kw):
        b = dict(base)
        b.update(kw)
        return b

    blocks = []
    stats[t] += 1

    if t == 22:  # teacher's notes: the text may sit in Note.Text, in Name, or in both
        note = it.get('Note') or {}
        body = clean_html(note.get('Text') or '')
        label = instr if plain(instr).lower() not in ('', "teacher's notes", 'teachers notes', 'teacher’s notes', 'notes') else ''
        text = '<br>'.join(x for x in (label, body) if x)
        if not text:
            return []
        if note.get('ShowToPupil'):
            return [{'id': bid, 'type': 'text', 'html': text, 'pm': base['pm']}]
        notes.append({'block_id': bid, 'html': text})
        return [{'id': bid, 'type': 'teacher_note', 'pm': base['pm']}]

    if t == 28:  # text
        body = clean_html((it.get('Text') or {}).get('Text') or '')
        blocks.append(block(type='text', html=body))

    elif t in (2, 27):  # pictures (rule, photo)
        imgs = images_of(it)
        blocks.append(block(type='image', images=imgs) if imgs else block(type='text', html=''))

    elif t == 4:  # audio with transcript
        auds = [a for a in (it.get('Audios') or []) if isinstance(a, dict) and a.get('Url')]
        for n, a in enumerate(auds):
            b = block(type='audio', src=a['Url'], transcript=clean_html(a.get('Script') or ''))
            if n:
                b['id'] = f'{bid}-a{n + 1}'
                b.pop('instruction_html', None)
                b.pop('number', None)
            blocks.append(b)
        if not auds:
            blocks.append(block(type='text', html=''))

    elif t == 10:  # type the answer into gaps
        texts = [q.get('Text') or '' for q in (it.get('QuestionWithCodingTexts') or [])]
        body, n = gap_text('<br>'.join(texts), typed_gap)
        blocks.append(block(type='gaps', text=body) if n else block(type='text', html=body))

    elif t == 13:  # choose the correct option inside the text
        texts = [q.get('Text') or '' for q in (it.get('QuestionWithCodingTexts') or [])]
        body, n = gap_text('<br>'.join(texts), choice_gap)
        blocks.append(block(type='gaps_choice', text=body) if n else block(type='text', html=body))

    elif t == 18:  # drag words into gaps
        body, n = gap_text((it.get('PasteWordByDrag') or {}).get('Text') or '', bank_gap)
        blocks.append(block(type='gaps_bank', text=body) if n else block(type='text', html=body))

    elif t == 5:  # test
        qs = []
        for q in ((it.get('Test') or {}).get('Questions') or []):
            opts = [plain(o) for o in (q.get('Answers') or [])]
            flags = q.get('QuestionAnswers') or []
            ans = [i for i, f in enumerate(flags) if str(f).lower() == 'true' and i < len(opts)]
            if opts:
                qs.append({'q': plain(q.get('Question') or ''), 'options': opts, 'answer': ans or [0]})
        blocks.append(block(type='test', questions=qs) if qs else block(type='text', html=''))

    elif t == 14:  # true / false (/ not stated)
        opts = ['True', 'False'] + (['Not stated'] if (it.get('TrueOrFalse') or {}).get('EnableNotStated') else [])
        flags = it.get('QuestionAnswers') or []
        qs = []
        for n, q in enumerate(it.get('Questions') or []):
            f = str(flags[n]).lower() if n < len(flags) else ''
            ans = 0 if f == 'true' else (2 if f in ('notstated', 'not stated', 'null', 'none') and len(opts) == 3 else 1)
            qs.append({'q': plain(q.get('Question') or ''), 'options': opts, 'answer': [ans]})
        blocks.append(block(type='test', questions=qs))

    elif t == 26:  # essay / written answer
        blocks.append(block(type='essay', prompt=''))

    elif t == 30:  # voice recording
        rec = it.get('AudioRecording') or {}
        blocks.append(block(type='voice', prompt_html=clean_html(rec.get('Text') or ''), max_seconds=rec.get('RecordingDuration')))

    else:
        stats[f'unsupported:{t}'] += 1
        jd = {}
        try:
            jd = {k: v for k, v in json.loads(it.get('JsonData') or '{}').items() if v not in (None, [], '', False, {})}
        except ValueError:
            pass
        blocks.append(block(type='unsupported', pm_type=t, raw=jd))

    for n, url in enumerate(videos_of(it)):
        blocks.append({'id': f'{bid}-v{n + 1}', 'type': 'video', 'url': url, 'pm': base['pm']})
    return blocks


def convert_section(sec, notes, stats, with_heading=True):
    data = sec.get('exercises') or {}
    items = data.get('Items') or [] if isinstance(data, dict) else []
    out = []
    if with_heading:
        out.append({'id': f"pm-sec-{sec['Id']}", 'type': 'heading', 'text': (sec.get('Name') or '').strip()})
    for it in items:
        if it.get('IsHideExercise'):
            stats['hidden_skipped'] += 1
            continue
        out.extend(convert_item(it, notes, stats))
    if sec.get('exercises') is None and not sec.get('IsEmpty'):
        stats['sections_missing'] += 1
    return out


# ---------------------------------------------------------------- SQL

def q(s):
    """Dollar-quote a string for Postgres."""
    s = '' if s is None else str(s)
    tag = '$pm$'
    while tag in s:
        tag = tag[:-1] + 'x$'
    return f'{tag}{s}{tag}'


def lesson_sql(book_ref, ref, title, section, sort, blocks, notes):
    content = json.dumps({'blocks': blocks}, ensure_ascii=False, separators=(',', ':'))
    lines = [
        'insert into public.lessons (course_id, title, section, sort, content, source_ref)',
        f"select c.id, {q(title)}, {q(section)}, {sort}, {q(content)}::jsonb, {q(ref)}",
        f"from public.courses c where c.source_ref = {q(book_ref)}",
        'on conflict (source_ref) where source_ref is not null do update',
        '  set course_id = excluded.course_id, title = excluded.title, section = excluded.section,',
        '      sort = excluded.sort, content = excluded.content;',
        f"delete from public.lesson_notes where lesson_id = (select id from public.lessons where source_ref = {q(ref)});",
    ]
    for n in notes:
        lines.append('insert into public.lesson_notes (lesson_id, block_id, html)')
        lines.append(f"select l.id, {q(n['block_id'])}, {q(n['html'])} from public.lessons l where l.source_ref = {q(ref)};")
    return '\n'.join(lines) + '\n'


def convert_book(data, out_dir, max_bytes=900_000):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    book = data.get('book') or {}
    book_id = data.get('bookId') or book.get('Id')
    book_ref = f'pm-book-{book_id}'
    title = book.get('Name') or f'ProgressMe {book_id}'
    stats = Counter()
    report = {'book': title, 'book_id': book_id, 'lessons': [], 'export_errors': data.get('errors') or []}

    header = '\n'.join([
        f'-- {title}: перенос из ProgressMe (учебник {book_id}).',
        '-- Запускать в Supabase → SQL Editor после supabase/schema.sql. Повторный запуск обновляет уроки.',
        '',
    ])
    course_sql = '\n'.join([
        'insert into public.courses (title, description, cover_url, level, source, source_ref, sort)',
        f"values ({q(title)}, {q('Перенесено из ProgressMe')}, {q(book.get('ImageUrl') or '')}, null, 'personal', {q(book_ref)}, 0)",
        'on conflict (source_ref) where source_ref is not null do update',
        '  set title = excluded.title, cover_url = excluded.cover_url;',
        '',
    ])

    chunks = []
    for c in sorted(data.get('courses') or [], key=lambda c: c.get('OrderIndex') or 0):
        unit = (c.get('Name') or '').strip()
        for l in sorted(c.get('lessons') or [], key=lambda l: l.get('Number') or 0):
            base_sort = (c.get('OrderIndex') or 0) * 1000 + (l.get('Number') or 0) * 10
            name = (l.get('Name') or '').strip()
            ltitle = f"{l.get('Number')}. {name}" if l.get('Number') else name
            notes, blocks = [], []
            sections = sorted(l.get('sections') or [], key=lambda s: s.get('SortId') or 0)
            for s in sections:
                blocks.extend(convert_section(s, notes, stats, with_heading=len(sections) > 1))
            ref = f"pm-lesson-{l['Id']}"
            chunks.append(lesson_sql(book_ref, ref, ltitle, unit, base_sort, blocks, notes))
            entry = {'unit': unit, 'lesson': ltitle, 'blocks': len(blocks), 'notes': len(notes)}
            hw = l.get('homework')
            if hw and (hw.get('exercises') or {}).get('Items'):
                hw_notes = []
                hw_blocks = convert_section(hw, hw_notes, stats, with_heading=False)
                chunks.append(lesson_sql(book_ref, ref + '-hw', ltitle + ' · Homework', unit, base_sort + 1, hw_blocks, hw_notes))
                entry['homework_blocks'] = len(hw_blocks)
            report['lessons'].append(entry)

    files, cur, size, part = [], [], 0, 1

    def flush():
        nonlocal cur, size, part
        if not cur:
            return
        name = out_dir / f'progressme-{book_id}-part{part:02d}.sql'
        body = header + (course_sql if part == 1 else '') + 'begin;\n' + '\n'.join(cur) + 'commit;\n'
        name.write_text(body, encoding='utf-8')
        files.append(name)
        cur, size, part = [], 0, part + 1

    for ch in chunks:
        b = len(ch.encode('utf-8'))
        if cur and size + b > max_bytes:
            flush()
        cur.append(ch)
        size += b
    flush()

    report['stats'] = {str(k): v for k, v in sorted(stats.items(), key=lambda kv: str(kv[0]))}
    report['files'] = [f.name for f in files]
    (out_dir / f'progressme-{book_id}-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    return files, report


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    files, report = convert_book(data, sys.argv[2])
    print(f"{report['book']}: уроков {len(report['lessons'])}, файлов SQL {len(files)}")
    print('типы упражнений:', report['stats'])
    if report['export_errors']:
        print('ошибки выгрузки:', len(report['export_errors']))


if __name__ == '__main__':
    main()
