// Плеер урока: рисует блоки из lesson.content.blocks, проверяет ответы, сохраняет результаты.
(function () {
  const EXERCISES = ['gaps', 'gaps_bank', 'gaps_choice', 'test', 'essay'];
  const MAX_ATTEMPTS = 3;
  const FINISHED = ['done', 'needs_review', 'reviewed'];

  let lesson = null;
  let user = null;
  let notes = {};          // block_id -> html заметки для преподавателя
  const results = {};      // block_id -> строка результата
  const statusById = {};   // block_id -> статус (для полосы прогресса)

  // ---------- Помощники ----------
  function norm(s, caseSensitive) {
    const v = String(s == null ? '' : s)
      .replace(/[’‘`´]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    return caseSensitive ? v : v.toLowerCase();
  }
  function decode(html) {
    const t = document.createElement('textarea');
    t.innerHTML = html;
    return t.value;
  }
  function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  // Перемешивание, одинаковое при каждой загрузке (порядок слов в банке не прыгает)
  function seededShuffle(list, seedText) {
    let h = 2166136261;
    for (const ch of String(seedText)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const rand = () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  // Текст с {{ответ|вариант}} → HTML с полями; возвращает список верных ответов
  function parseGaps(text, makeGap) {
    const gaps = [];
    const html = String(text || '').replace(/\{\{(.*?)\}\}/g, (m, inner) => {
      const answers = decode(inner).split('|').map(s => s.trim()).filter(Boolean);
      const i = gaps.length;
      gaps.push({ answers });
      return makeGap(i, answers);
    });
    return { html, gaps };
  }

  let toastTimer = null;
  function toast(text) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  async function save(row) {
    const res = await Data.saveResult({ lesson_id: lesson.id, ...row });
    if (res.queued) toast('Нет связи — ответ сохранён в браузере и отправится позже');
    else if (!res.ok) toast('Не удалось сохранить ответ: ' + (res.error || 'ошибка'));
    statusById[row.block_id] = row.status;
    updateProgress();
  }

  function updateProgress() {
    const ids = lesson.content.blocks.filter(b => EXERCISES.includes(b.type)).map(b => b.id);
    const done = ids.filter(id => FINISHED.includes(statusById[id])).length;
    const fill = document.getElementById('progressFill');
    const text = document.getElementById('progressText');
    if (fill) fill.style.width = ids.length ? (done / ids.length * 100) + '%' : '0';
    if (text) text.textContent = ids.length ? `${done} из ${ids.length}` : '';
  }

  // ---------- Каркас блока ----------
  function shell(block) {
    const el = document.createElement('section');
    el.className = 'block';
    el.id = 'block-' + block.id;
    el.dataset.type = block.type;
    // Номер упражнения ставится перед первой строкой заголовка/инструкции
    let num = block.number ? `<span class="ex-num">${esc(block.number)}</span>` : '';
    const take = () => { const n = num; num = ''; return n; };
    let head = '';
    if (block.title) head += `<h2>${take()}${esc(block.title)}</h2>`;
    if (block.instruction) head += `<p class="instruction">${take()}${esc(block.instruction)}</p>`;
    // instruction_html приходит из импорта уже очищенным (только безопасные теги)
    if (block.instruction_html) head += `<div class="instruction rich">${take()}${block.instruction_html}</div>`;
    if (num) head += `<div class="instruction rich">${take()}</div>`;
    el.innerHTML = head + '<div class="body"></div>';
    return el;
  }

  function footer(el, buttonText) {
    const foot = document.createElement('div');
    foot.className = 'block-foot';
    foot.innerHTML =
      '<span class="chip status"></span>' +
      '<span class="msg" aria-live="polite"></span>' +
      (user.role === 'teacher' ? '<button type="button" class="btn small ghost reset" title="Стереть ответы и начать заново">Сбросить</button>' : '') +
      `<button type="button" class="btn check">${buttonText}</button>`;
    el.appendChild(foot);
    return {
      foot,
      btn: foot.querySelector('.check'),
      msg: foot.querySelector('.msg'),
      chip: foot.querySelector('.status'),
      reset: foot.querySelector('.reset')
    };
  }

  function teacherNote(el, result) {
    if (result && result.teacher_comment) {
      const note = document.createElement('div');
      note.className = 'teacher-note';
      note.innerHTML = '<b>Комментарий преподавателя:</b> ' + esc(result.teacher_comment);
      el.appendChild(note);
    }
  }

  // ---------- Открытые ответы: без ключа, проверяет преподаватель ----------
  function attachOpen(block, el, api) {
    const prev = results[block.id];
    let status = prev ? prev.status : 'in_progress';
    const ui = footer(el, 'Отправить преподавателю');
    if (prev && prev.answer) api.setValues(prev.answer.values || []);
    if (status === 'in_progress') {
      const draft = Data.draft.get(lesson.id, block.id);
      if (draft && draft.values) api.setValues(draft.values);
    }
    statusById[block.id] = status;
    let draftTimer = null;
    api.onChange = () => {
      ui.msg.textContent = '';
      ui.msg.className = 'msg';
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => Data.draft.set(lesson.id, block.id, { values: api.getValues() }), 500);
    };
    function paint() {
      const sent = status !== 'in_progress';
      ui.btn.hidden = sent;
      if (sent) api.lockAll();
      if (status === 'reviewed') { ui.chip.className = 'chip status ok'; ui.chip.textContent = 'Проверено'; }
      else if (status === 'needs_review') { ui.chip.className = 'chip status warn'; ui.chip.textContent = 'На проверке'; }
      else { ui.chip.className = 'chip status'; ui.chip.textContent = 'Проверяет преподаватель'; }
    }
    ui.btn.addEventListener('click', async () => {
      const values = api.getValues();
      if (values.some((v, i) => api.isEmpty(i, v))) { ui.msg.className = 'msg bad'; ui.msg.textContent = api.emptyMsg; return; }
      status = 'needs_review';
      paint();
      Data.draft.clear(lesson.id, block.id);
      await save({ block_id: block.id, answer: { values }, attempts: 1, status: 'needs_review' });
      toast('Отправлено преподавателю');
    });
    if (ui.reset) ui.reset.addEventListener('click', () => resetBlock(block));
    paint();
    teacherNote(el, prev);
  }

  // ---------- Общая логика проверки (пропуски, банк слов, тест) ----------
  function attachChecker(block, el, api) {
    if (api.open) return attachOpen(block, el, api);
    const n = api.count;
    const prev = results[block.id];
    const st = {
      attempts: prev ? prev.attempts || 0 : 0,
      locked: new Array(n).fill(false),
      revealed: false,
      status: prev ? prev.status : 'in_progress',
      score: prev && prev.score != null ? Number(prev.score) : 0
    };
    const ui = footer(el, 'Проверить');

    // Восстановление: сохранённый ответ, затем незаконченный черновик поверх
    if (prev && prev.answer) {
      api.setValues(prev.answer.values || []);
      (prev.answer.locked || []).forEach((ok, i) => { if (ok) { st.locked[i] = true; api.markOk(i); } });
      if (prev.answer.revealed) {
        st.revealed = true;
        st.locked.forEach((ok, i) => { if (!ok) api.reveal(i); });
        api.lockAll();
      }
    }
    if (st.status === 'in_progress') {
      const draft = Data.draft.get(lesson.id, block.id);
      if (draft && draft.values) {
        const merged = draft.values.map((v, i) => (st.locked[i] ? null : v));
        api.setValues(merged);
      }
    }
    if (FINISHED.includes(st.status)) api.lockAll();
    statusById[block.id] = st.status;

    let draftTimer = null;
    api.onChange = () => {
      ui.msg.textContent = '';
      ui.msg.className = 'msg';
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => Data.draft.set(lesson.id, block.id, { values: api.getValues() }), 500);
    };

    function paint() {
      const done = FINISHED.includes(st.status);
      ui.btn.hidden = done;
      if (done) {
        const full = st.score === n;
        ui.chip.className = 'chip status ' + (full ? 'ok' : 'accent');
        ui.chip.textContent = `${full ? 'Выполнено' : 'Завершено'} · ${st.score}/${n}`;
      } else if (st.attempts > 0) {
        ui.chip.className = 'chip status warn';
        ui.chip.textContent = `Попытка ${st.attempts + 1} из ${MAX_ATTEMPTS}`;
      } else {
        ui.chip.className = 'chip status';
        ui.chip.textContent = `${MAX_ATTEMPTS} ${plural(MAX_ATTEMPTS, 'попытка', 'попытки', 'попыток')}`;
      }
    }
    function say(text, kind) {
      ui.msg.textContent = text;
      ui.msg.className = 'msg' + (kind ? ' ' + kind : '');
    }

    ui.btn.addEventListener('click', async () => {
      const values = api.getValues();
      if (values.some((v, i) => !st.locked[i] && api.isEmpty(i, v))) {
        say(api.emptyMsg, 'bad');
        return;
      }
      st.attempts += 1;
      let allOk = true;
      values.forEach((v, i) => {
        if (st.locked[i]) return;
        if (api.isCorrect(i, v)) { st.locked[i] = true; api.markOk(i); }
        else { allOk = false; api.markBad(i); }
      });
      st.score = st.locked.filter(Boolean).length;

      if (allOk) {
        st.status = 'done';
        say('Всё верно!', 'ok');
      } else if (st.attempts >= MAX_ATTEMPTS) {
        st.status = 'done';
        st.revealed = true;
        st.locked.forEach((ok, i) => { if (!ok) api.reveal(i); });
        api.lockAll();
        say(`Верно ${st.score} из ${n}. Правильные ответы показаны зелёным.`);
      } else {
        const left = MAX_ATTEMPTS - st.attempts;
        say(`Верно ${st.score} из ${n}. Исправьте подсвеченное — ${plural(left, 'осталась', 'осталось', 'осталось')} ${left} ${plural(left, 'попытка', 'попытки', 'попыток')}.`, 'bad');
      }
      paint();
      if (st.status === 'done') Data.draft.clear(lesson.id, block.id);
      await save({
        block_id: block.id,
        answer: { values: api.getValues(), locked: st.locked, revealed: st.revealed },
        score: st.score,
        max_score: n,
        attempts: st.attempts,
        status: st.status
      });
    });

    if (ui.reset) ui.reset.addEventListener('click', () => resetBlock(block));
    paint();
    teacherNote(el, prev);
  }

  // ---------- Типы блоков ----------
  const renderers = {
    text(block, el) {
      el.querySelector('.body').innerHTML = block.html ? `<div class="reading">${block.html}</div>` : '';
    },

    image(block, el) {
      // одна картинка (src) или несколько (images: [{src, caption}])
      const list = Array.isArray(block.images) && block.images.length
        ? block.images
        : [{ src: block.src, caption: block.caption, alt: block.alt }];
      el.querySelector('.body').innerHTML = list.map(im =>
        `<figure><a href="${esc(im.src)}" target="_blank" rel="noopener"><img src="${esc(im.src)}" alt="${esc(im.alt || im.caption || '')}" loading="lazy"></a>` +
        (im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : '') + '</figure>').join('');
    },

    video(block, el) {
      const url = String(block.url || '');
      let html;
      const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
      const vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      const gd = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{10,})/);
      if (gd) html = `<iframe src="https://drive.google.com/file/d/${esc(gd[1])}/preview" title="${esc(block.title || 'Видео')}" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>`;
      else if (yt) html = `<iframe src="https://www.youtube-nocookie.com/embed/${esc(yt[1])}" title="${esc(block.title || 'Видео')}" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
      else if (vm) html = `<iframe src="https://player.vimeo.com/video/${esc(vm[1])}" title="${esc(block.title || 'Видео')}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
      else html = `<video controls preload="metadata" src="${esc(url)}"></video>`;
      el.querySelector('.body').innerHTML = `<div class="media-frame">${html}</div>`;
    },

    audio(block, el) {
      el.querySelector('.body').innerHTML =
        `<audio controls preload="metadata" src="${esc(block.src)}"></audio>` +
        (block.transcript ? `<details class="transcript"><summary>Текст аудио</summary><div class="reading">${block.transcript}</div></details>` : '');
    },

    gaps(block, el) {
      const body = el.querySelector('.body');
      const cs = !!block.case_sensitive;
      const { html, gaps } = parseGaps(block.text, (i, answers) => {
        // пропуск без ключа ({{}}) — свободный ответ, поле пошире
        const w = answers.length ? Math.max(4, ...answers.map(a => a.length)) + 2 : 14;
        return `<input class="gap-input" data-i="${i}" style="width:${w}ch" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Пропуск ${i + 1}">`;
      });
      body.innerHTML = `<div class="reading">${html}</div>`;
      const inputs = [...body.querySelectorAll('.gap-input')];
      const api = {
        count: gaps.length,
        open: gaps.length > 0 && gaps.every(g => !g.answers.length),
        emptyMsg: 'Заполните все пропуски',
        getValues: () => inputs.map(x => x.value),
        setValues: vals => inputs.forEach((x, i) => { if (vals[i] != null) x.value = vals[i]; }),
        isEmpty: (i, v) => !String(v).trim(),
        // если у отдельного пропуска нет ключа, засчитывается любой непустой ответ
        isCorrect: (i, v) => !gaps[i].answers.length ? !!String(v).trim() : gaps[i].answers.some(a => norm(a, cs) === norm(v, cs)),
        markOk: i => { inputs[i].classList.remove('bad'); inputs[i].classList.add('ok'); inputs[i].readOnly = true; },
        markBad: i => inputs[i].classList.add('bad'),
        reveal: i => {
          inputs[i].readOnly = true;
          if (gaps[i].answers.length) inputs[i].insertAdjacentHTML('afterend', `<span class="reveal">→ ${esc(gaps[i].answers[0])}</span>`);
        },
        lockAll: () => inputs.forEach(x => { x.readOnly = true; }),
        onChange: null
      };
      inputs.forEach((inp, idx) => {
        inp.addEventListener('input', () => { inp.classList.remove('bad'); api.onChange && api.onChange(); });
        inp.addEventListener('keydown', e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const next = inputs.slice(idx + 1).find(x => !x.readOnly);
          if (next) next.focus();
          else { const btn = el.querySelector('.check'); if (btn && !btn.hidden) btn.click(); }
        });
      });
      attachChecker(block, el, api);
    },

    gaps_bank(block, el) {
      const body = el.querySelector('.body');
      const { html, gaps } = parseGaps(block.text, i =>
        `<button type="button" class="gap-slot" data-i="${i}" aria-label="Пропуск ${i + 1}">&nbsp;</button>`);
      const words = seededShuffle(gaps.map(g => g.answers[0]).concat(block.distractors || []), block.id);
      body.innerHTML =
        `<div class="word-bank">${words.map((w, k) => `<button type="button" class="word" draggable="true" data-k="${k}">${esc(w)}</button>`).join('')}</div>` +
        `<div class="reading">${html}</div>`;
      const slots = [...body.querySelectorAll('.gap-slot')];
      const chips = [...body.querySelectorAll('.word')];
      const placed = new Array(gaps.length).fill(null);
      const locked = new Array(gaps.length).fill(false);
      let selected = null;

      function select(i) {
        selected = i;
        slots.forEach((s, j) => s.classList.toggle('selected', j === i));
      }
      function place(i, k, silent) {
        if (locked[i] || k == null || !chips[k] || chips[k].classList.contains('used')) return;
        if (placed[i] != null) chips[placed[i]].classList.remove('used');
        placed[i] = k;
        chips[k].classList.add('used');
        slots[i].textContent = words[k];
        slots[i].classList.add('filled');
        slots[i].classList.remove('bad');
        select(null);
        if (!silent && api.onChange) api.onChange();
      }
      function unplace(i) {
        if (locked[i] || placed[i] == null) return;
        chips[placed[i]].classList.remove('used');
        placed[i] = null;
        slots[i].innerHTML = '&nbsp;';
        slots[i].classList.remove('filled', 'bad');
        if (api.onChange) api.onChange();
      }

      chips.forEach((chip, k) => {
        chip.addEventListener('click', () => {
          const target = selected != null && !locked[selected] ? selected : placed.findIndex((p, i) => p == null && !locked[i]);
          if (target == null || target < 0) return;
          place(target, k);
        });
        chip.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', String(k));
          e.dataTransfer.effectAllowed = 'move';
        });
      });
      slots.forEach((slot, i) => {
        slot.addEventListener('click', () => {
          if (locked[i]) return;
          if (placed[i] != null) { unplace(i); select(i); }
          else select(selected === i ? null : i);
        });
        slot.addEventListener('dragover', e => { if (!locked[i]) { e.preventDefault(); slot.classList.add('over'); } });
        slot.addEventListener('dragleave', () => slot.classList.remove('over'));
        slot.addEventListener('drop', e => {
          e.preventDefault();
          slot.classList.remove('over');
          const k = Number(e.dataTransfer.getData('text/plain'));
          if (!Number.isNaN(k)) place(i, k);
        });
      });

      const api = {
        count: gaps.length,
        emptyMsg: 'Расставьте слова во все пропуски',
        getValues: () => placed.map(k => (k == null ? '' : words[k])),
        setValues: vals => vals.forEach((v, i) => {
          if (!v || placed[i] != null) return;
          const k = chips.findIndex((c, kk) => words[kk] === v && !c.classList.contains('used'));
          if (k >= 0) place(i, k, true);
        }),
        isEmpty: (i, v) => !v,
        isCorrect: (i, v) => gaps[i].answers.some(a => norm(a) === norm(v)),
        markOk: i => { locked[i] = true; slots[i].classList.remove('bad', 'selected'); slots[i].classList.add('ok', 'locked'); },
        markBad: i => slots[i].classList.add('bad'),
        reveal: i => {
          locked[i] = true;
          slots[i].classList.add('locked');
          slots[i].insertAdjacentHTML('afterend', `<span class="reveal">→ ${esc(gaps[i].answers[0])}</span>`);
        },
        lockAll: () => {
          locked.fill(true);
          slots.forEach(s => s.classList.add('locked'));
          chips.forEach(c => { c.disabled = true; c.draggable = false; });
          select(null);
        },
        onChange: null
      };
      attachChecker(block, el, api);
    },

    // Выбор варианта прямо в тексте: {{some*|any}} — звёздочкой отмечен верный
    gaps_choice(block, el) {
      const body = el.querySelector('.body');
      const { html, gaps } = parseGaps(block.text, (i, answers) => {
        const opts = answers.map(a => a.replace(/^\*+|\*+$/g, '').trim());
        const w = Math.max(...opts.map(o => o.length), 4) + 4;
        return `<select class="gap-select" data-i="${i}" style="min-width:${w}ch" aria-label="Пропуск ${i + 1}">` +
          '<option value="">…</option>' + opts.map(o => `<option>${esc(o)}</option>`).join('') + '</select>';
      });
      gaps.forEach(g => {
        g.options = g.answers.map(a => a.replace(/^\*+|\*+$/g, '').trim());
        g.correct = g.answers.filter(a => /^\*|\*$/.test(a)).map(a => a.replace(/^\*+|\*+$/g, '').trim());
      });
      body.innerHTML = `<div class="reading">${html}</div>`;
      const sels = [...body.querySelectorAll('.gap-select')];
      const api = {
        count: gaps.length,
        emptyMsg: 'Выберите вариант в каждом пропуске',
        getValues: () => sels.map(s => s.value),
        setValues: vals => sels.forEach((s, i) => { if (vals[i] != null && g_has(i, vals[i])) s.value = vals[i]; }),
        isEmpty: (i, v) => !v,
        isCorrect: (i, v) => gaps[i].correct.some(c => norm(c) === norm(v)),
        markOk: i => { sels[i].classList.remove('bad'); sels[i].classList.add('ok'); sels[i].disabled = true; },
        markBad: i => sels[i].classList.add('bad'),
        reveal: i => {
          sels[i].disabled = true;
          if (gaps[i].correct.length) sels[i].insertAdjacentHTML('afterend', `<span class="reveal">→ ${esc(gaps[i].correct[0])}</span>`);
        },
        lockAll: () => sels.forEach(s => { s.disabled = true; }),
        onChange: null
      };
      function g_has(i, v) { return gaps[i].options.includes(v); }
      sels.forEach(s => s.addEventListener('change', () => { s.classList.remove('bad'); api.onChange && api.onChange(); }));
      attachChecker(block, el, api);
    },

    // Устный ответ: пока без записи на платформе
    voice(block, el) {
      el.querySelector('.body').innerHTML =
        (block.prompt_html ? `<div class="reading">${block.prompt_html}</div>` : '') +
        '<p class="muted small voice-note">🎙 Устный ответ. Запись голоса прямо на платформе появится в следующей версии — пока ответьте преподавателю голосовым сообщением.</p>';
    },

    // Тип, который не удалось перенести автоматически: ученик видит задание, преподаватель — пометку
    unsupported(block, el) {
      el.querySelector('.body').innerHTML = user.role === 'teacher'
        ? `<p class="muted small">Это упражнение (тип ProgressMe ${esc(block.pm_type)}) не перенеслось автоматически — исходные данные сохранены.</p>`
        : '<p class="muted small">Это задание выполняется вместе с преподавателем.</p>';
    },

    test(block, el) {
      const body = el.querySelector('.body');
      const qs = block.questions || [];
      body.innerHTML = qs.map((q, qi) => {
        const multi = (q.answer || []).length > 1;
        const name = `${block.id}-q${qi}`;
        const qText = String(q.q || '').trim();
        const numbered = qs.length > 1 ? `${qi + 1}. ` : '';
        return `<div class="question" data-q="${qi}">` +
          (qText || numbered ? `<div class="q">${numbered}${esc(qText)}</div>` : '') +
          (multi ? '<div class="hint">Выберите все верные варианты</div>' : '') +
          (q.options || []).map((o, oi) =>
            `<label class="option"><input type="${multi ? 'checkbox' : 'radio'}" name="${esc(name)}" value="${oi}"><span>${esc(o)}</span></label>`
          ).join('') +
          '</div>';
      }).join('');
      const qEls = [...body.querySelectorAll('.question')];
      const inputsOf = qi => [...qEls[qi].querySelectorAll('input')];
      const paintPicked = qi => inputsOf(qi).forEach(inp => inp.closest('.option').classList.toggle('picked', inp.checked));

      qEls.forEach((qEl, qi) => {
        qEl.addEventListener('change', () => {
          qEl.classList.remove('bad');
          paintPicked(qi);
          if (api.onChange) api.onChange();
        });
      });

      const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
      const api = {
        count: qs.length,
        emptyMsg: 'Ответьте на все вопросы',
        getValues: () => qs.map((q, qi) => inputsOf(qi).filter(x => x.checked).map(x => Number(x.value))),
        setValues: vals => vals.forEach((v, qi) => {
          if (!Array.isArray(v) || !qEls[qi]) return;
          inputsOf(qi).forEach(inp => { inp.checked = v.includes(Number(inp.value)); });
          paintPicked(qi);
        }),
        isEmpty: (i, v) => !v || v.length === 0,
        isCorrect: (i, v) => sameSet(v, qs[i].answer || []),
        markOk: i => { qEls[i].classList.remove('bad'); qEls[i].classList.add('ok', 'locked'); inputsOf(i).forEach(x => { x.disabled = true; }); },
        markBad: i => qEls[i].classList.add('bad'),
        reveal: i => {
          qEls[i].classList.add('locked');
          inputsOf(i).forEach(inp => {
            inp.disabled = true;
            if ((qs[i].answer || []).includes(Number(inp.value))) inp.closest('.option').classList.add('correct');
          });
        },
        lockAll: () => qEls.forEach((qEl, i) => { qEl.classList.add('locked'); inputsOf(i).forEach(x => { x.disabled = true; }); }),
        onChange: null
      };
      attachChecker(block, el, api);
    },

    essay(block, el) {
      const body = el.querySelector('.body');
      const prev = results[block.id];
      const min = Number(block.min_words) || 0;
      body.innerHTML =
        `<p class="essay-prompt">${esc(block.prompt || '')}</p>` +
        '<textarea class="essay-box" placeholder="Пишите здесь…" aria-label="Ваш ответ"></textarea>';
      const box = body.querySelector('.essay-box');
      const ui = footer(el, 'Отправить на проверку');
      let status = prev ? prev.status : 'in_progress';
      let savedText = prev && prev.answer ? prev.answer.text || '' : '';
      const draft = Data.draft.get(lesson.id, block.id);
      box.value = status === 'in_progress' && draft && typeof draft.text === 'string' ? draft.text : savedText;
      statusById[block.id] = status;

      function paint() {
        const words = wordCount(box.value);
        const submitted = status !== 'in_progress';
        box.readOnly = submitted;
        ui.btn.hidden = submitted;
        if (status === 'reviewed') { ui.chip.className = 'chip status ok'; ui.chip.textContent = 'Проверено'; }
        else if (status === 'needs_review') { ui.chip.className = 'chip status warn'; ui.chip.textContent = 'На проверке'; }
        else { ui.chip.className = 'chip status'; ui.chip.textContent = 'Черновик'; }
        ui.msg.className = 'msg';
        ui.msg.textContent = `${words} ${plural(words, 'слово', 'слова', 'слов')}` + (min && !submitted ? ` · минимум ${min}` : '');
      }

      async function saveDraftToServer() {
        if (status !== 'in_progress' || box.value === savedText || !box.value.trim()) return;
        savedText = box.value;
        await save({ block_id: block.id, answer: { text: box.value }, attempts: 0, status: 'in_progress' });
      }

      let draftTimer = null;
      box.addEventListener('input', () => {
        paint();
        clearTimeout(draftTimer);
        draftTimer = setTimeout(() => Data.draft.set(lesson.id, block.id, { text: box.value }), 400);
      });
      box.addEventListener('blur', saveDraftToServer);
      const autosave = setInterval(saveDraftToServer, 60000);
      window.addEventListener('pagehide', () => clearInterval(autosave), { once: true });

      ui.btn.addEventListener('click', async () => {
        const words = wordCount(box.value);
        if (!words) { ui.msg.className = 'msg bad'; ui.msg.textContent = 'Сначала напишите ответ'; return; }
        if (min && words < min) { ui.msg.className = 'msg bad'; ui.msg.textContent = `Нужно минимум ${min} ${plural(min, 'слово', 'слова', 'слов')} — сейчас ${words}`; return; }
        status = 'needs_review';
        savedText = box.value;
        paint();
        Data.draft.clear(lesson.id, block.id);
        await save({ block_id: block.id, answer: { text: box.value }, attempts: 1, status: 'needs_review' });
        toast('Отправлено преподавателю');
      });
      if (ui.reset) ui.reset.addEventListener('click', () => { clearInterval(autosave); resetBlock(block); });
      paint();
      teacherNote(el, prev);
    }
  };

  function renderBlock(block) {
    // Заголовок раздела урока (READING, VOCABULARY…) — не карточка, а разделитель
    if (block.type === 'heading') {
      const h = document.createElement('h2');
      h.className = 'lesson-section';
      h.id = 'block-' + block.id;
      h.textContent = block.text || '';
      return h;
    }
    // Заметка для преподавателя: ученик её не получает и не видит
    if (block.type === 'teacher_note') {
      if (user.role !== 'teacher' || !notes[block.id]) return null;
      const n = document.createElement('aside');
      n.className = 'block teacher-only';
      n.id = 'block-' + block.id;
      n.innerHTML = '<div class="teacher-only-label">Только для преподавателя</div>' + `<div class="reading">${notes[block.id]}</div>`;
      return n;
    }
    const el = shell(block);
    const fn = renderers[block.type];
    if (fn) fn(block, el);
    else el.querySelector('.body').innerHTML = `<p class="muted small">Этот тип упражнения пока не поддерживается: <code>${esc(block.type)}</code></p>`;
    return el;
  }

  async function resetBlock(block) {
    if (!confirm('Стереть ответы в этом упражнении?')) return;
    await Data.resetResult(lesson.id, block.id);
    Data.draft.clear(lesson.id, block.id);
    delete results[block.id];
    statusById[block.id] = 'in_progress';
    const old = document.getElementById('block-' + block.id);
    old.replaceWith(renderBlock(block));
    updateProgress();
  }

  // ---------- Запуск ----------
  async function main() {
    const app = document.getElementById('app');
    const brand = document.querySelector('.brand');
    if (brand && window.APP_CONFIG && APP_CONFIG.SITE_NAME) brand.textContent = APP_CONFIG.SITE_NAME;
    try {
      user = await Data.getUser();
      if (!user) { location.href = 'index.html'; return; }
      const id = new URLSearchParams(location.search).get('id') || window.PREVIEW_LESSON_ID;
      lesson = id ? await Data.getLesson(id) : null;
      if (!lesson) {
        app.innerHTML = '<div class="empty"><p>Урок не найден или ещё не назначен вам.</p><a class="btn ghost" href="index.html">К учебникам</a></div>';
        return;
      }
      lesson.content = lesson.content || { blocks: [] };
      lesson.content.blocks = lesson.content.blocks || [];
      (await Data.getResults(lesson.id)).forEach(r => { results[r.block_id] = r; });
      notes = await Data.getNotes(lesson.id);
      document.title = lesson.title;

      app.innerHTML =
        '<div class="lesson-head">' +
        `<a class="crumb" href="index.html">← ${esc(lesson.course ? lesson.course.title : 'Учебники')}${lesson.section ? ' · ' + esc(lesson.section) : ''}</a>` +
        `<h1>${esc(lesson.title)}</h1>` +
        (Data.isDemo ? '<p class="muted small">Демо-режим: ответы сохраняются только в этом браузере.</p>' : '') +
        '</div>';
      const list = document.createElement('div');
      lesson.content.blocks.forEach(b => { const el = renderBlock(b); if (el) list.appendChild(el); });
      app.appendChild(list);
      app.insertAdjacentHTML('beforeend', '<p style="padding:8px 0 48px"><a class="btn ghost" href="index.html">← К учебникам</a></p>');
      updateProgress();
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="empty"><p>Не удалось загрузить урок.</p><p class="small muted">${esc(e.message || e)}</p></div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', main);
})();
