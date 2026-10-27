-- =====================================================================
--  English Learning Platform — схема базы, версия 1 (переезд с Edvibe)
--  Запускать целиком в Supabase → SQL Editor → New query → Run.
--  Скрипт можно запускать повторно: он ничего не удаляет.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Профили и роли
--    Профиль создаётся автоматически при первом входе пользователя.
--    Роль преподавателя назначается вручную (см. README, шаг 4).
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'student' check (role in ('student', 'teacher')),
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Проверка роли без рекурсии в политиках
create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'teacher');
$$;

-- ---------------------------------------------------------------------
-- 2. Учебники и уроки
--    Урок хранится один раз; ученикам он назначается через assignments.
--    content = {"blocks": [...]} — формат описан в docs/lesson-format.md
-- ---------------------------------------------------------------------
create table if not exists public.courses (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  cover_url    text,
  level        text,                       -- A1…C2, TOEFL, Business и т.п.
  source       text not null default 'personal'
               check (source in ('personal', 'purchased', 'other')),
  source_ref   text,                       -- id учебника в Edvibe (для повторного импорта)
  sort         int not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists public.lessons (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references public.courses(id) on delete cascade,
  title        text not null,
  section      text,                       -- раздел учебника, если есть
  sort         int not null default 0,
  content      jsonb not null default '{"blocks": []}'::jsonb,
  source_ref   text,                       -- id урока на старой платформе (pm-lesson-… для ProgressMe)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists lessons_course_idx on public.lessons(course_id, sort);
create unique index if not exists lessons_source_ref_uq on public.lessons(source_ref) where source_ref is not null;
create unique index if not exists courses_source_ref_uq on public.courses(source_ref) where source_ref is not null;

-- Число упражнений с проверкой (для прогресса в библиотеке), считается само.
-- Пересоздаётся при каждом запуске схемы, чтобы список типов был актуальным.
alter table public.lessons drop column if exists exercise_count;
alter table public.lessons add column exercise_count int generated always as (
  jsonb_array_length(jsonb_path_query_array(content,
    '$.blocks[*] ? (@.type == "gaps" || @.type == "gaps_bank" || @.type == "gaps_choice" || @.type == "test" || @.type == "essay")'))
) stored;

-- Заметки для преподавателя (ответы, подсказки «TO START» и т.п.).
-- Хранятся отдельно от урока: ученик их не получает вообще, даже через инструменты разработчика.
create table if not exists public.lesson_notes (
  id         uuid primary key default gen_random_uuid(),
  lesson_id  uuid not null references public.lessons(id) on delete cascade,
  block_id   text not null,
  html       text not null,
  unique (lesson_id, block_id)
);

-- ---------------------------------------------------------------------
-- 3. Назначения: какой урок какому ученику
-- ---------------------------------------------------------------------
create table if not exists public.assignments (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  lesson_id    uuid not null references public.lessons(id) on delete cascade,
  kind         text not null default 'class' check (kind in ('class', 'homework')),
  assigned_at  timestamptz not null default now(),
  due_at       timestamptz,
  unique (student_id, lesson_id, kind)
);
create index if not exists assignments_student_idx on public.assignments(student_id);

-- ---------------------------------------------------------------------
-- 4. Результаты: одна строка = один ученик × одно упражнение урока
--    source = 'edvibe' — перенесённая история, 'platform' — новая работа
-- ---------------------------------------------------------------------
create table if not exists public.results (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references public.profiles(id) on delete cascade,
  lesson_id        uuid not null references public.lessons(id) on delete cascade,
  block_id         text not null,
  answer           jsonb,
  score            numeric,
  max_score        numeric,
  attempts         int not null default 0,
  status           text not null default 'in_progress'
                   check (status in ('in_progress', 'done', 'needs_review', 'reviewed')),
  teacher_comment  text,
  source           text not null default 'platform' check (source in ('platform', 'edvibe')),
  updated_at       timestamptz not null default now(),
  unique (student_id, lesson_id, block_id)
);
create index if not exists results_lesson_idx on public.results(lesson_id);
create index if not exists results_review_idx on public.results(status) where status = 'needs_review';

-- ---------------------------------------------------------------------
-- 5. Личный словарь ученика
-- ---------------------------------------------------------------------
create table if not exists public.vocabulary (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.profiles(id) on delete cascade,
  word            text not null,
  translation     text,
  context         text,                    -- предложение, где встретилось слово
  lesson_id       uuid references public.lessons(id) on delete set null,
  box             int not null default 0,  -- ступень интервального повторения
  next_review_at  timestamptz not null default now(),
  source          text not null default 'platform' check (source in ('platform', 'edvibe')),
  added_at        timestamptz not null default now()
);
create unique index if not exists vocabulary_word_uq on public.vocabulary(student_id, lower(word));

-- ---------------------------------------------------------------------
-- 6. updated_at автоматически
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists lessons_touch on public.lessons;
create trigger lessons_touch before update on public.lessons
  for each row execute function public.touch_updated_at();

drop trigger if exists results_touch on public.results;
create trigger results_touch before update on public.results
  for each row execute function public.touch_updated_at();

-- Комментарий преподавателя может писать только преподаватель
create or replace function public.protect_teacher_comment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_teacher() then
    if tg_op = 'UPDATE' then new.teacher_comment := old.teacher_comment;
    else new.teacher_comment := null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists results_protect_comment on public.results;
create trigger results_protect_comment before insert or update on public.results
  for each row execute function public.protect_teacher_comment();

-- =====================================================================
-- 7. Доступы (Row Level Security)
--    Преподаватель видит и меняет всё.
--    Ученик видит только назначенные ему уроки и только свои данные.
-- =====================================================================
alter table public.profiles    enable row level security;
alter table public.courses     enable row level security;
alter table public.lessons     enable row level security;
alter table public.assignments enable row level security;
alter table public.results     enable row level security;
alter table public.vocabulary  enable row level security;
alter table public.lesson_notes enable row level security;

-- lesson_notes: только преподаватель
drop policy if exists lesson_notes_teacher on public.lesson_notes;
create policy lesson_notes_teacher on public.lesson_notes for all
  using (public.is_teacher()) with check (public.is_teacher());

-- profiles: свой профиль или преподаватель; менять роли может только преподаватель
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_teacher());
drop policy if exists profiles_teacher_write on public.profiles;
create policy profiles_teacher_write on public.profiles for update
  using (public.is_teacher()) with check (public.is_teacher());

-- courses: преподаватель — всё; ученик — учебники, где у него есть назначенный урок
drop policy if exists courses_teacher on public.courses;
create policy courses_teacher on public.courses for all
  using (public.is_teacher()) with check (public.is_teacher());
drop policy if exists courses_student on public.courses;
create policy courses_student on public.courses for select
  using (exists (
    select 1 from public.assignments a
    join public.lessons l on l.id = a.lesson_id
    where l.course_id = courses.id and a.student_id = auth.uid()
  ));

-- lessons: преподаватель — всё; ученик — только назначенные
drop policy if exists lessons_teacher on public.lessons;
create policy lessons_teacher on public.lessons for all
  using (public.is_teacher()) with check (public.is_teacher());
drop policy if exists lessons_student on public.lessons;
create policy lessons_student on public.lessons for select
  using (exists (
    select 1 from public.assignments a
    where a.lesson_id = lessons.id and a.student_id = auth.uid()
  ));

-- assignments: преподаватель — всё; ученик — читать свои
drop policy if exists assignments_teacher on public.assignments;
create policy assignments_teacher on public.assignments for all
  using (public.is_teacher()) with check (public.is_teacher());
drop policy if exists assignments_student on public.assignments;
create policy assignments_student on public.assignments for select
  using (student_id = auth.uid());

-- results: преподаватель — всё; ученик — свои и только по назначенным урокам
drop policy if exists results_teacher on public.results;
create policy results_teacher on public.results for all
  using (public.is_teacher()) with check (public.is_teacher());
drop policy if exists results_student_select on public.results;
create policy results_student_select on public.results for select
  using (student_id = auth.uid());
drop policy if exists results_student_insert on public.results;
create policy results_student_insert on public.results for insert
  with check (
    student_id = auth.uid()
    and source = 'platform'
    and status in ('in_progress', 'done', 'needs_review')
    and exists (select 1 from public.assignments a where a.lesson_id = results.lesson_id and a.student_id = auth.uid())
  );
drop policy if exists results_student_update on public.results;
create policy results_student_update on public.results for update
  using (student_id = auth.uid() and source = 'platform' and status <> 'reviewed')
  with check (student_id = auth.uid() and source = 'platform' and status in ('in_progress', 'done', 'needs_review'));

-- vocabulary: преподаватель — всё; ученик — свой словарь
drop policy if exists vocabulary_teacher on public.vocabulary;
create policy vocabulary_teacher on public.vocabulary for all
  using (public.is_teacher()) with check (public.is_teacher());
drop policy if exists vocabulary_student on public.vocabulary;
create policy vocabulary_student on public.vocabulary for all
  using (student_id = auth.uid()) with check (student_id = auth.uid());

-- =====================================================================
-- 8. Хранилище для картинок и аудио уроков
--    Публичный бакет на чтение; загружать может только преподаватель.
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('lesson-media', 'lesson-media', true)
on conflict (id) do nothing;

drop policy if exists lesson_media_teacher_write on storage.objects;
create policy lesson_media_teacher_write on storage.objects for insert
  with check (bucket_id = 'lesson-media' and public.is_teacher());
drop policy if exists lesson_media_teacher_update on storage.objects;
create policy lesson_media_teacher_update on storage.objects for update
  using (bucket_id = 'lesson-media' and public.is_teacher());
drop policy if exists lesson_media_teacher_delete on storage.objects;
create policy lesson_media_teacher_delete on storage.objects for delete
  using (bucket_id = 'lesson-media' and public.is_teacher());
