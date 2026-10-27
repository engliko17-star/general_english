// Слой данных: Supabase или демо-режим (localStorage).
// Страницы обращаются только к window.Data, поэтому замена хранилища их не затрагивает.
(function () {
  const cfg = window.APP_CONFIG || {};
  const isDemo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
  const sb = !isDemo && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  // ---------- localStorage с защитой (приватный режим, переполнение) ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }
  };

  // В демо-режиме можно посмотреть урок глазами ученика: добавьте к адресу ?as=student (или &as=student)
  const demoAsStudent = new URLSearchParams(location.search).get('as') === 'student';
  const DEMO_USER = { id: 'demo-user', email: 'demo', full_name: 'Демо', role: demoAsStudent ? 'student' : 'teacher' };
  let currentUser = null;

  // ---------- Очередь неотправленных результатов (обрыв интернета) ----------
  const QUEUE_KEY = 'pending-results';
  // Сетевая ошибка (нет интернета) — в отличие от отказа базы, её имеет смысл повторить
  function isNetworkError(error) {
    return !navigator.onLine || /fetch|network|timeout/i.test((error && error.message) || '');
  }
  let flushing = false;
  async function flushQueue() {
    if (isDemo || !currentUser || flushing) return;
    const queue = store.get(QUEUE_KEY, []);
    if (!queue.length) return;
    flushing = true;
    const rest = [];
    for (const row of queue) {
      if (row.student_id !== currentUser.id) { rest.push(row); continue; }
      const { error } = await sb.from('results').upsert(row, { onConflict: 'student_id,lesson_id,block_id' });
      if (error && isNetworkError(error)) rest.push(row);
    }
    store.set(QUEUE_KEY, rest);
    flushing = false;
  }
  window.addEventListener('online', () => { flushQueue(); });

  function demoLibrary() {
    const d = window.DEMO_DATA || { courses: [], lessons: [] };
    const results = store.get('demo-results', {});
    const done = {};
    Object.values(results).forEach(r => {
      if (['done', 'needs_review', 'reviewed'].includes(r.status)) done[r.lesson_id] = (done[r.lesson_id] || 0) + 1;
    });
    return d.courses.map(c => ({
      ...c,
      lessons: d.lessons
        .filter(l => l.course_id === c.id)
        .sort((a, b) => a.sort - b.sort)
        .map(l => ({
          id: l.id, title: l.title, section: l.section, sort: l.sort,
          exercise_count: (l.content.blocks || []).filter(b => ['gaps', 'gaps_bank', 'gaps_choice', 'test', 'essay'].includes(b.type)).length,
          done_count: done[l.id] || 0
        }))
    }));
  }

  window.Data = {
    isDemo,

    async getUser() {
      if (isDemo) { currentUser = DEMO_USER; return currentUser; }
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { currentUser = null; return null; }
      const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      currentUser = profile || { id: session.user.id, email: session.user.email, role: 'student' };
      flushQueue();
      return currentUser;
    },

    async signIn(email) {
      const redirect = location.origin + location.pathname.replace(/[^/]*$/, '') + 'index.html';
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect, shouldCreateUser: true } });
      if (error) throw error;
    },

    async signOut() {
      if (sb) await sb.auth.signOut();
      currentUser = null;
    },

    // Учебники с уроками. Для ученика база сама оставит только назначенные уроки.
    async getLibrary() {
      if (isDemo) return demoLibrary();
      const { data: courses, error } = await sb
        .from('courses')
        .select('id,title,description,level,source,sort,lessons(id,title,section,sort,exercise_count)')
        .order('sort');
      if (error) throw error;
      const { data: results } = await sb
        .from('results').select('lesson_id,status')
        .eq('student_id', currentUser.id)
        .in('status', ['done', 'needs_review', 'reviewed']);
      const done = {};
      (results || []).forEach(r => { done[r.lesson_id] = (done[r.lesson_id] || 0) + 1; });
      return (courses || []).map(c => ({
        ...c,
        lessons: (c.lessons || []).sort((a, b) => a.sort - b.sort).map(l => ({ ...l, done_count: done[l.id] || 0 }))
      }));
    },

    async getLesson(id) {
      if (isDemo) {
        const d = window.DEMO_DATA;
        const lesson = d.lessons.find(l => l.id === id);
        if (!lesson) return null;
        return { ...lesson, course: d.courses.find(c => c.id === lesson.course_id) };
      }
      const { data, error } = await sb
        .from('lessons').select('id,title,section,content,course_id,courses(id,title)')
        .eq('id', id).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { ...data, course: data.courses };
    },

    // Заметки для преподавателя: { block_id: html }. Ученику база их не отдаёт.
    async getNotes(lessonId) {
      if (!currentUser || currentUser.role !== 'teacher') return {};
      if (isDemo) return ((window.DEMO_DATA || {}).notes || {})[lessonId] || {};
      const { data, error } = await sb.from('lesson_notes').select('block_id,html').eq('lesson_id', lessonId);
      if (error) return {};
      const out = {};
      (data || []).forEach(n => { out[n.block_id] = n.html; });
      return out;
    },

    async getResults(lessonId) {
      if (isDemo) {
        const all = store.get('demo-results', {});
        return Object.values(all).filter(r => r.lesson_id === lessonId);
      }
      const { data, error } = await sb.from('results').select('*')
        .eq('lesson_id', lessonId).eq('student_id', currentUser.id);
      if (error) throw error;
      return data || [];
    },

    // Сохраняет результат. Если сеть пропала — кладёт в очередь и отправит позже.
    async saveResult(row) {
      const full = { ...row, student_id: currentUser.id };
      if (isDemo) {
        const all = store.get('demo-results', {});
        all[row.lesson_id + ':' + row.block_id] = { ...full, updated_at: new Date().toISOString() };
        store.set('demo-results', all);
        return { ok: true };
      }
      let error;
      try {
        ({ error } = await sb.from('results').upsert(full, { onConflict: 'student_id,lesson_id,block_id' }));
      } catch (e) { error = e; }
      if (error) {
        if (!isNetworkError(error)) return { ok: false, error: error.message };
        const queue = store.get(QUEUE_KEY, []).filter(q => !(q.lesson_id === row.lesson_id && q.block_id === row.block_id && q.student_id === full.student_id));
        queue.push(full);
        store.set(QUEUE_KEY, queue);
        return { ok: false, queued: true };
      }
      flushQueue();
      return { ok: true };
    },

    async resetResult(lessonId, blockId) {
      if (isDemo) {
        const all = store.get('demo-results', {});
        delete all[lessonId + ':' + blockId];
        store.set('demo-results', all);
        return;
      }
      await sb.from('results').delete()
        .eq('lesson_id', lessonId).eq('block_id', blockId).eq('student_id', currentUser.id);
    },

    // Черновики (эссе, недописанные ответы) — только в браузере
    draft: {
      get(lessonId, blockId) { return store.get('draft:' + lessonId + ':' + blockId, null); },
      set(lessonId, blockId, value) { store.set('draft:' + lessonId + ':' + blockId, value); },
      clear(lessonId, blockId) { store.remove('draft:' + lessonId + ':' + blockId); }
    }
  };

  // Общие мелочи для страниц
  window.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  };
})();
