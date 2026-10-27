// Демо-учебник: показывается, пока в assets/config.js не указан Supabase.
// Все типы блоков из docs/lesson-format.md, кроме видео и аудио, которым нужны реальные файлы.
window.DEMO_DATA = {
  courses: [
    {
      id: 'demo-course',
      title: 'Everyday English (демо)',
      description: 'Пример учебника, чтобы проверить, как выглядят упражнения.',
      level: 'A2–B1',
      source: 'personal',
      sort: 0
    }
  ],
  lessons: [
    {
      id: 'demo-lesson-1',
      course_id: 'demo-course',
      title: 'At the café',
      section: 'Unit 1',
      sort: 1,
      content: {
        blocks: [
          {
            id: 'intro',
            type: 'text',
            title: 'Warm-up',
            html: '<p>Think about the last time you ordered something in a café. What did you say? What did the barista ask you?</p><p>In this lesson we practise <b>polite requests</b>: <i>Could I have…?</i>, <i>I’d like…</i>, <i>Can I get…?</i></p>'
          },
          {
            id: 'pic',
            type: 'image',
            src: 'demo/cafe.svg',
            alt: 'A café counter with a menu board',
            caption: 'Look at the menu. What would you order?'
          },
          {
            id: 'dialogue-gaps',
            type: 'gaps',
            title: 'Complete the dialogue',
            instruction: 'Type the missing words.',
            text: '<p><b>Barista:</b> Hi! What can I {{get}} you?</p><p><b>Anna:</b> {{Could|Can}} I have a large latte, please?</p><p><b>Barista:</b> Sure. Would you like anything {{else}}?</p><p><b>Anna:</b> No, thanks. That’s {{all}}. How much {{is}} it?</p>'
          },
          {
            id: 'bank',
            type: 'gaps_bank',
            title: 'Choose the right word',
            instruction: 'Drag a word into each gap, or tap a word and then a gap.',
            text: '<p>I’d like a cup of tea {{with}} milk, please. Could I pay {{by}} card? I’ll have it {{to}} go, thanks.</p>',
            distractors: ['at', 'for']
          },
          {
            id: 'quiz',
            type: 'test',
            title: 'Quick check',
            questions: [
              { q: 'Which request is the most polite?', options: ['Give me a coffee.', 'Could I have a coffee, please?', 'I want coffee.'], answer: [1] },
              { q: 'The barista says “For here or to go?”. She is asking…', options: ['where you will drink it', 'how you will pay', 'what size you want'], answer: [0] },
              { q: 'Choose all correct endings: “Can I get…”', options: ['a muffin, please?', 'to pay by cash?', 'a glass of water?'], answer: [0, 2] }
            ]
          },
          {
            id: 'essay',
            type: 'essay',
            title: 'Your turn',
            prompt: 'Write a short dialogue (6–8 lines) between you and a barista in your favourite café. Use at least two polite requests.',
            min_words: 50
          }
        ]
      }
    },
    {
      id: 'demo-lesson-2',
      course_id: 'demo-course',
      title: 'Daily routines',
      section: 'Unit 1',
      sort: 2,
      content: {
        blocks: [
          {
            id: 'read',
            type: 'text',
            title: 'Read',
            html: '<p>Tom gets up at seven o’clock. He has breakfast, checks his messages and leaves home at eight. He usually takes the bus, but on Fridays he cycles to work.</p>'
          },
          {
            id: 'ps-gaps',
            type: 'gaps',
            title: 'Present Simple',
            instruction: 'Put the verbs in brackets in the correct form.',
            text: '<p>Tom {{gets}} (get) up at seven. He {{doesn’t|does not}} (not / drive) to work. {{Does}} he (do) sport? Yes, he {{cycles}} (cycle) on Fridays.</p>'
          },
          {
            id: 'ps-test',
            type: 'test',
            title: 'Check yourself',
            questions: [
              { q: 'How does Tom usually get to work?', options: ['By car', 'By bus', 'On foot'], answer: [1] },
              { q: 'When does Tom cycle?', options: ['Every day', 'On Mondays', 'On Fridays'], answer: [2] }
            ]
          }
        ]
      }
    }
  ]
};
