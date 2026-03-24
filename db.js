const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'exam.db');
const db = new sqlite3.Database(DB_PATH);

function init() {
  db.serialize(() => {
    db.run(`PRAGMA journal_mode=WAL`);

    db.run(`CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      seat_number INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS exam_sessions (
      id TEXT PRIMARY KEY,
      participant_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      time_remaining_seconds INTEGER,
      status TEXT DEFAULT 'active',
      score_ukrainian INTEGER,
      score_math INTEGER,
      FOREIGN KEY(participant_id) REFERENCES participants(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      order_num INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      options TEXT,
      match_left TEXT,
      match_right TEXT,
      correct_answer TEXT NOT NULL,
      image_path TEXT,
      points INTEGER DEFAULT 1,
      instruction TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS question_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      image_path TEXT NOT NULL,
      order_num INTEGER DEFAULT 0,
      FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reference_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      title TEXT,
      image_path TEXT,
      order_num INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      question_id INTEGER NOT NULL,
      answer TEXT,
      saved_at TEXT,
      time_spent_seconds INTEGER DEFAULT 0,
      UNIQUE(session_id, question_id),
      FOREIGN KEY(session_id) REFERENCES exam_sessions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      participant_id INTEGER,
      event_type TEXT,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // ─── Indexes ──────────────────────────────────────────────────────────────
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_participant ON exam_sessions(participant_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON exam_sessions(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON exam_sessions(started_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_participants_login ON participants(login)`);

    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('test_access_enabled', '0')`, () => {
      seedIfEmpty();
      seedParticipantsIfEmpty();
    });
  });
}

const PREFERRED_JSON = path.join(__dirname, 'kse_questions_merged(2).json');

function seedIfEmpty() {
  db.get('SELECT COUNT(*) as cnt FROM questions', (err, row) => {
    if (err) return;
    if (row.cnt === 0) {
      if (fs.existsSync(PREFERRED_JSON)) {
        console.log('Seeding from preferred JSON:', PREFERRED_JSON);
        seedFromJson(PREFERRED_JSON);
      } else {
        console.log('Seeding from hardcoded questions...');
        seedQuestions();
      }
    }
  });
}

function seedFromJson(jsonPath) {
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const questions = data.questions || [];
    const images = data.images || [];

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      
      const qStmt = db.prepare(`
        INSERT INTO questions (id, subject, order_num, type, text, options, match_left, match_right, correct_answer, image_path, points, instruction)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const q of questions) {
        // Ensure all arrays/objects are stringified for SQLite
        const options = typeof q.options === 'string' ? q.options : JSON.stringify(q.options || []);
        const match_left = typeof q.match_left === 'string' ? q.match_left : JSON.stringify(q.match_left || []);
        const match_right = typeof q.match_right === 'string' ? q.match_right : JSON.stringify(q.match_right || []);
        const correct_answer = typeof q.correct_answer === 'string' ? q.correct_answer : JSON.stringify(q.correct_answer);

        qStmt.run(
          q.id, q.subject, q.order_num, q.type, q.text,
          options, match_left, match_right, correct_answer,
          q.image_path || null, q.points || 1, q.instruction || null
        );
      }
      qStmt.finalize();

      const iStmt = db.prepare(`INSERT INTO question_images (id, question_id, image_path, order_num) VALUES (?, ?, ?, ?)`);
      for (const img of images) {
        iStmt.run(img.id, img.question_id, img.image_path, img.order_num);
      }
      iStmt.finalize();

      db.run('COMMIT', (err) => {
        if (err) console.error('Error seeding from JSON:', err);
        else console.log(`Seeded ${questions.length} questions and ${images.length} images from JSON.`);
      });
    });
  } catch (e) {
    console.error('Failed to seed from JSON:', e);
    seedQuestions();
  }
}

function seedQuestions() {
  const stmt = db.prepare(`INSERT INTO questions
    (subject, order_num, type, text, options, match_left, match_right, correct_answer, points, instruction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const readingText = `Упродовж століть українська мова витримувала натиск жорстоких утисків і заборон. Ще за часів Київської Русі писемність розвивалася на основі живої народної мови. У XVI столітті культурним осередком став Острозький культурно-освітній центр, де 1581 року надрукували першу повну слов'янську Біблію. Пізніше Києво-Могилянська академія стала кузнею освічених людей. Трагічного удару по мові завдав Валуєвський циркуляр 1863 року, який називав українську мову «малоросійським наріччям». Емський указ 1876 року фактично заборонив україномовні публікації. Проте навіть у найтемніші часи Іван Франко, Леся Українка та Михайло Коцюбинський продовжували творити, зберігаючи живий дух мови. У XX столітті, в добу Розстріляного відродження, письменники Микола Хвильовий, Михайль Семенко, Микола Зеров намагалися вивести українську культуру на європейський рівень. Сталінські репресії 1930-х років жорстоко обірвали цей розквіт. Та мова вижила — у піснях, у казках, у серцях простих людей.`;

  // ─── УКРАЇНСЬКА МОВА (30 питань) ─────────────────────────────────────────
  const ukrQuestions = [
    // Q1-4: Читання тексту
    {
      order: 1, type: 'single',
      instruction: 'Завдання 1–4 виконуються на основі тексту.',
      text: `Прочитайте текст і виконайте завдання 1–4.\n\n«${readingText}»\n\nЯку головну думку висловлює автор тексту?`,
      options: JSON.stringify(['А) Українська мова виникла лише у XVI столітті', 'Б) Незважаючи на утиски, українська мова зберегла свою самобутність', 'В) Тільки письменники XX ст. врятували мову від зникнення', 'Г) Сталінські репресії назавжди знищили українську літературну традицію']),
      correct: 'Б'
    },
    {
      order: 2, type: 'single',
      text: 'Хто з перелічених письменників НЕ належить до доби «Розстріляного відродження»?',
      options: JSON.stringify(['А) Микола Хвильовий', 'Б) Іван Франко', 'В) Михайль Семенко', 'Г) Микола Зеров']),
      correct: 'Б'
    },
    {
      order: 3, type: 'single',
      text: 'Що фактично заборонив Емський указ 1876 року?',
      options: JSON.stringify(['А) Викладання у школах латинською мовою', 'Б) Діяльність Острозького культурно-освітнього центру', 'В) Україномовні публікації', 'Г) Навчання у Києво-Могилянській академії']),
      correct: 'В'
    },
    {
      order: 4, type: 'single',
      text: 'Який рік пов\'язаний із виданням першої повної слов\'янської Біблії в Острозі?',
      options: JSON.stringify(['А) 1863', 'Б) 1876', 'В) 1581', 'Г) 1930']),
      correct: 'В'
    },
    // Q5-20: Одиничний вибір — мова
    {
      order: 5, type: 'single',
      text: 'У якому рядку всі слова написані правильно?',
      options: JSON.stringify(['А) беззбройний, розжарений, відділ, оббити', 'Б) безбройний, розжарений, відділ, обити', 'В) беззбройний, рожарений, відділ, оббити', 'Г) безбройний, рожарений, відділ, обити']),
      correct: 'А'
    },
    {
      order: 6, type: 'single',
      text: 'Яке слово є синонімом до слова «лаконічний»?',
      options: JSON.stringify(['А) багатослівний', 'Б) стислий', 'В) красномовний', 'Г) зрозумілий']),
      correct: 'Б'
    },
    {
      order: 7, type: 'single',
      text: 'У якому рядку всі слова пишуться з апострофом?',
      options: JSON.stringify(["А) м'яч, п'ять, з'явитися", "Б) святий, тряпка, рясний", "В) зв'язок, духм'яний, бюро", "Г) верб'я, м'який, роз'яснити"]),
      correct: 'А'
    },
    {
      order: 8, type: 'single',
      text: 'У якому реченні слово вжито в невластивому йому значенні?',
      options: JSON.stringify(['А) Стара яблуня щороку рясно вкривалася квітом.', 'Б) Студент зробив оригінальну доповідь на конференції.', 'В) Дівчина одягнула нову сукню на свято.', 'Г) Адрес виступу виявився надзвичайно цікавим.']),
      correct: 'Г'
    },
    {
      order: 9, type: 'single',
      text: 'Яке слово НЕ є запозиченим із іншої мови?',
      options: JSON.stringify(['А) комп\'ютер', 'Б) ватра', 'В) телефон', 'Г) менеджер']),
      correct: 'Б'
    },
    {
      order: 10, type: 'single',
      text: 'У якому рядку всі слова є іменниками IV відміни?',
      options: JSON.stringify(['А) плем\'я, ім\'я, теля', 'Б) піч, сіль, тінь', 'В) Дніпро, Харків, Київ', 'Г) читання, письмо, навчання']),
      correct: 'А'
    },
    {
      order: 11, type: 'single',
      text: 'Укажіть речення з правильно вжитими розділовими знаками.',
      options: JSON.stringify(['А) Навесні ліс наповнився пташиним співом і шумом листя.', 'Б) Навесні, ліс наповнився пташиним співом, і шумом листя.', 'В) Навесні ліс, наповнився пташиним співом і шумом листя.', 'Г) Навесні, ліс, наповнився пташиним співом, і шумом листя.']),
      correct: 'А'
    },
    {
      order: 12, type: 'single',
      text: 'Яке з наведених слів є дієприслівником?',
      options: JSON.stringify(['А) написаний', 'Б) написавши', 'В) написання', 'Г) ненаписаний']),
      correct: 'Б'
    },
    {
      order: 13, type: 'single',
      text: 'У якому рядку всі прикметники стоять у вищому ступені порівняння?',
      options: JSON.stringify(['А) кращий, більший, вищий', 'Б) хороший, великий, гарний', 'В) найкращий, найбільший, найвищий', 'Г) добрий, великий, дужий']),
      correct: 'А'
    },
    {
      order: 14, type: 'single',
      text: 'Укажіть речення з відокремленою обставиною.',
      options: JSON.stringify(['А) Дерево, посаджене батьком, виросло велике.', 'Б) Пробившись крізь хмари, сонце осяяло поле.', 'В) Хлопець, втомлений і змучений, ліг спати.', 'Г) Учні, що добре підготувалися, склали іспит.']),
      correct: 'Б'
    },
    {
      order: 15, type: 'single',
      text: 'У якому рядку правильно вжито форму числівника з іменником?',
      options: JSON.stringify(['А) двоє студентів', 'Б) двох студенти', 'В) двоє студенти', 'Г) два студентів']),
      correct: 'А'
    },
    {
      order: 16, type: 'single',
      text: 'У якому стилі написаний уривок: «Відповідно до статті 10 Конституції України державною мовою в Україні є українська мова»?',
      options: JSON.stringify(['А) художній', 'Б) науковий', 'В) офіційно-діловий', 'Г) розмовний']),
      correct: 'В'
    },
    {
      order: 17, type: 'single',
      text: 'Яке слово є стилістично нейтральним (міжстильовим)?',
      options: JSON.stringify(['А) базікати', 'Б) говорити', 'В) теревенити', 'Г) цокотіти']),
      correct: 'Б'
    },
    {
      order: 18, type: 'single',
      text: 'У якому реченні допущено стилістичну помилку?',
      options: JSON.stringify(['А) Він підійшов до вчителя і запитав про домашнє завдання.', 'Б) На протязі року учні вивчили багато нового матеріалу.', 'В) Студенти прийшли на лекцію вчасно.', 'Г) Директор підписав наказ про призначення нового завідувача.']),
      correct: 'Б'
    },
    {
      order: 19, type: 'single',
      text: 'Яке слово є терміном?',
      options: JSON.stringify(['А) швидкий', 'Б) фотосинтез', 'В) красивий', 'Г) говорити']),
      correct: 'Б'
    },
    {
      order: 20, type: 'single',
      text: 'Яке словосполучення містить плеоназм (зайве слово)?',
      options: JSON.stringify(['А) написати листа', 'Б) власна автобіографія', 'В) великий будинок', 'Г) читати книгу']),
      correct: 'Б'
    },
    // Q21-25: Множинний вибір
    {
      order: 21, type: 'multiple',
      text: 'Укажіть усі речення, у яких підмет виражений іменником.',
      options: JSON.stringify(['А) Учні написали контрольну роботу.', 'Б) Хтось постукав у двері.', 'В) Вітер зламав дерево.', 'Г) Йому не спалося цієї ночі.']),
      correct: JSON.stringify(['А', 'В'])
    },
    {
      order: 22, type: 'multiple',
      text: 'Позначте рядки, у яких усі прислівники пишуться разом.',
      options: JSON.stringify(['А) будь-що, казна-де, хтозна-як', 'Б) внаслідок, назустріч, вслід', 'В) повсякчас, водночас, натомість', 'Г) де-небудь, аби-куди, куди-небудь']),
      correct: JSON.stringify(['Б', 'В'])
    },
    {
      order: 23, type: 'multiple',
      text: 'Укажіть усі речення з однорідними членами речення.',
      options: JSON.stringify(['А) Мати і дочка прийшли разом.', 'Б) Він прийшов, коли ми вже пішли.', 'В) Хлопці грали, бігали і сміялися.', 'Г) Це був великий і красивий будинок.']),
      correct: JSON.stringify(['А', 'В', 'Г'])
    },
    {
      order: 24, type: 'multiple',
      text: 'Які з наведених слів є власне українськими (не запозиченими)?',
      options: JSON.stringify(['А) гай', 'Б) парламент', 'В) криниця', 'Г) комп\'ютер']),
      correct: JSON.stringify(['А', 'В'])
    },
    {
      order: 25, type: 'multiple',
      text: 'Позначте речення, у яких є відокремлені означення.',
      options: JSON.stringify(['А) Квіти, зрізані вранці, стояли у вазі.', 'Б) Дівчина в червоній сукні йшла парком.', 'В) Засмучений невдачею, він мовчав.', 'Г) Студент читав цікаву книгу.']),
      correct: JSON.stringify(['А', 'В'])
    },
    // Q26-29: Встановлення відповідності
    {
      order: 26, type: 'match',
      text: 'Установіть відповідність між реченням і видом підрядного речення.',
      match_left: JSON.stringify(['1. Він знав, що треба поспішати.', '2. Місто, де я народився, дуже красиве.', '3. Вона прийшла, коли всі вже сіли.', '4. Він навчався так, щоб отримати відзнаку.']),
      match_right: JSON.stringify(['А. підрядне означальне', 'Б. підрядне обставинне часу', 'В. підрядне з\'ясувальне', 'Г. підрядне обставинне мети']),
      correct: JSON.stringify({ '1': 'В', '2': 'А', '3': 'Б', '4': 'Г' })
    },
    {
      order: 27, type: 'match',
      text: 'Установіть відповідність між словом і частиною мови.',
      match_left: JSON.stringify(['1. читаючи', '2. прочитавши', '3. читання', '4. прочитаний']),
      match_right: JSON.stringify(['А. дієприкметник', 'Б. іменник', 'В. дієприслівник недоконаного виду', 'Г. дієприслівник доконаного виду']),
      correct: JSON.stringify({ '1': 'В', '2': 'Г', '3': 'Б', '4': 'А' })
    },
    {
      order: 28, type: 'match',
      text: 'Установіть відповідність між фразеологізмом і його значенням.',
      match_left: JSON.stringify(['1. Бити байдики', '2. Пекти раків', '3. Мотати на вус', '4. Дивитися крізь пальці']),
      match_right: JSON.stringify(['А. червоніти від сорому', 'Б. ледарювати', 'В. не звертати уваги', 'Г. запам\'ятовувати, брати до уваги']),
      correct: JSON.stringify({ '1': 'Б', '2': 'А', '3': 'Г', '4': 'В' })
    },
    {
      order: 29, type: 'match',
      text: 'Установіть відповідність між словом і способом його творення.',
      match_left: JSON.stringify(['1. безстрашний', '2. читач', '3. синьо-жовтий', '4. перечитати']),
      match_right: JSON.stringify(['А. складання основ', 'Б. суфіксальний', 'В. префіксальний', 'Г. префіксально-суфіксальний']),
      correct: JSON.stringify({ '1': 'Г', '2': 'Б', '3': 'А', '4': 'В' })
    },
    // Q30: Відкрита відповідь (одне питання)
    {
      order: 30, type: 'open',
      text: 'Поставте слово «рукопис» у форму родового відмінка однини. Запишіть відповідь.',
      correct: 'рукопису'
    }
  ];

  // ─── МАТЕМАТИКА (22 питання) ──────────────────────────────────────────────
  // Реальний формат НМТ: 15 single + 3 match + 4 open
  const mathQuestions = [
    // Q1-15: Одиничний вибір
    {
      order: 1, type: 'single',
      text: 'Розв\'яжіть рівняння: 2x + 7 = 15. Знайдіть значення x.',
      options: JSON.stringify(['А) x = 3', 'Б) x = 4', 'В) x = 11', 'Г) x = 22', 'Д) x = 1']),
      correct: 'Б'
    },
    {
      order: 2, type: 'single',
      text: 'Яке число є 30% від 150?',
      options: JSON.stringify(['А) 30', 'Б) 45', 'В) 50', 'Г) 60', 'Д) 55']),
      correct: 'Б'
    },
    {
      order: 3, type: 'single',
      text: 'Знайдіть значення виразу: 3/4 + 1/2.',
      options: JSON.stringify(['А) 1/4', 'Б) 4/6', 'В) 5/4', 'Г) 7/8', 'Д) 1']),
      correct: 'В'
    },
    {
      order: 4, type: 'single',
      text: 'Спростіть вираз: (a² − b²) / (a − b) при a ≠ b.',
      options: JSON.stringify(['А) a − b', 'Б) a + b', 'В) a² + b²', 'Г) (a + b)²', 'Д) 2a']),
      correct: 'Б'
    },
    {
      order: 5, type: 'single',
      text: 'Розв\'яжіть нерівність: 3x − 5 > 7.',
      options: JSON.stringify(['А) x > 4', 'Б) x > 2', 'В) x < 4', 'Г) x > 12', 'Д) x ≥ 4']),
      correct: 'А'
    },
    {
      order: 6, type: 'single',
      text: 'Ціна товару спочатку збільшилась на 20%, а потім зменшилась на 20%. Яка підсумкова зміна ціни?',
      options: JSON.stringify(['А) Ціна не змінилась', 'Б) Ціна зменшилась на 4%', 'В) Ціна зменшилась на 2%', 'Г) Ціна збільшилась на 4%', 'Д) Ціна зменшилась на 8%']),
      correct: 'Б'
    },
    {
      order: 7, type: 'single',
      text: 'Знайдіть суму всіх коренів рівняння: x² − 5x + 6 = 0.',
      options: JSON.stringify(['А) 3', 'Б) 5', 'В) 6', 'Г) −5', 'Д) 2']),
      correct: 'Б'
    },
    {
      order: 8, type: 'single',
      text: 'Скільки цілих чисел задовольняють нерівність: −3 < x ≤ 2?',
      options: JSON.stringify(['А) 5', 'Б) 6', 'В) 4', 'Г) 7', 'Д) 3']),
      correct: 'А'
    },
    {
      order: 9, type: 'single',
      text: 'Знайдіть значення виразу: log₂(32).',
      options: JSON.stringify(['А) 4', 'Б) 5', 'В) 6', 'Г) 16', 'Д) 3']),
      correct: 'Б'
    },
    {
      order: 10, type: 'single',
      text: '5 робітників виконують роботу за 12 днів. Скільки днів знадобиться 10 робітникам?',
      options: JSON.stringify(['А) 24', 'Б) 8', 'В) 6', 'Г) 4', 'Д) 10']),
      correct: 'В'
    },
    {
      order: 11, type: 'single',
      text: 'Площа прямокутного трикутника з катетами 6 і 8 см становить:',
      options: JSON.stringify(['А) 48 см²', 'Б) 14 см²', 'В) 24 см²', 'Г) 28 см²', 'Д) 36 см²']),
      correct: 'В'
    },
    {
      order: 12, type: 'single',
      text: 'Гіпотенуза прямокутного трикутника з катетами 5 і 12 см:',
      options: JSON.stringify(['А) 13 см', 'Б) 17 см', 'В) 11 см', 'Г) 15 см', 'Д) 7 см']),
      correct: 'А'
    },
    {
      order: 13, type: 'single',
      text: 'Знайдіть площу кола з радіусом 5 см. (Відповідь через π.)',
      options: JSON.stringify(['А) 10π см²', 'Б) 25π см²', 'В) 5π см²', 'Г) 50π см²', 'Д) 15π см²']),
      correct: 'Б'
    },
    {
      order: 14, type: 'single',
      text: 'Похідна функції f(x) = 3x² + 2x − 1 дорівнює:',
      options: JSON.stringify(['А) 6x + 2', 'Б) 3x + 2', 'В) 6x + 1', 'Г) 6x² + 2', 'Д) 3x² + 2']),
      correct: 'А'
    },
    {
      order: 15, type: 'single',
      text: 'Яке значення має вираз sin²(30°) + cos²(30°)?',
      options: JSON.stringify(['А) 0', 'Б) 0,5', 'В) √2/2', 'Г) 1', 'Д) 2']),
      correct: 'Г'
    },
    // Q16-18: Встановлення відповідності (логічні пари)
    {
      order: 16, type: 'match',
      text: 'Установіть відповідність між функцією та її похідною.',
      match_left: JSON.stringify(['1. f(x) = x³', '2. f(x) = sin(x)', '3. f(x) = eˣ', '4. f(x) = ln(x)']),
      match_right: JSON.stringify(['А. f\'(x) = 1/x', 'Б. f\'(x) = 3x²', 'В. f\'(x) = eˣ', 'Г. f\'(x) = cos(x)']),
      correct: JSON.stringify({ '1': 'Б', '2': 'Г', '3': 'В', '4': 'А' })
    },
    {
      order: 17, type: 'match',
      text: 'Установіть відповідність між фігурою та формулою її площі.',
      match_left: JSON.stringify(['1. Трикутник', '2. Коло', '3. Трапеція', '4. Ромб']),
      match_right: JSON.stringify(['А. S = πr²', 'Б. S = (a + b)·h / 2', 'В. S = a·h / 2', 'Г. S = d₁·d₂ / 2']),
      correct: JSON.stringify({ '1': 'В', '2': 'А', '3': 'Б', '4': 'Г' })
    },
    {
      order: 18, type: 'match',
      text: 'Установіть відповідність між виразом та його значенням.',
      match_left: JSON.stringify(['1. sin(90°)', '2. cos(180°)', '3. tg(60°)', '4. sin(30°)']),
      match_right: JSON.stringify(['А. −1', 'Б. 1/2', 'В. 1', 'Г. √3']),
      correct: JSON.stringify({ '1': 'В', '2': 'А', '3': 'Г', '4': 'Б' })
    },
    // Q19-22: Відкрита відповідь (коротка)
    {
      order: 19, type: 'open',
      text: 'Знайдіть площу прямокутника зі сторонами 7 і 9 см. Відповідь запишіть числом (у см²).',
      correct: '63',
      points: 2
    },
    {
      order: 20, type: 'open',
      text: 'Розв\'яжіть рівняння: 5x − 3 = 22. Запишіть значення x.',
      correct: '5',
      points: 2
    },
    {
      order: 21, type: 'open',
      text: 'Знайдіть гіпотенузу прямокутного трикутника, якщо катети дорівнюють 9 і 12 см. Відповідь запишіть числом.',
      correct: '15',
      points: 2
    },
    {
      order: 22, type: 'open',
      text: 'На скільки відсотків число 75 більше за число 60? Запишіть відповідь числом.',
      correct: '25',
      points: 2
    },
    {
      order: 23, type: 'single',
      text: '**Визначте** значення математичного виразу: $\\sqrt{144} + 2^3$.',
      options: JSON.stringify(['А) 14', 'Б) 20', 'В) 22', 'Г) 18', 'Д) 12']),
      correct: 'Б',
      instruction: 'Оберіть одну **правильну** відповідь.'
    },
    {
      order: 24, type: 'multiple',
      text: '*Обчисліть* значення інтеграла $\\int_0^2 x \\, dx$ та встановіть, яким із наведених чисел воно кратне:',
      options: JSON.stringify(['А) 1', 'Б) 2', 'В) 3', 'Г) 4', 'Д) 5']),
      correct: JSON.stringify(['А', 'Б']),
      instruction: 'Оберіть **всі** варіанти, що підходять.'
    },
    {
      order: 25, type: 'open',
      text: 'Розв\'яжіть рівняння: $\\log_2(x) = 5$. \n\n**Підказка:** скористайтеся означенням логарифма $x = 2^5$.',
      correct: '32',
      points: 2,
      instruction: 'Введіть числове значення.'
    }
  ];

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    for (const q of ukrQuestions) {
      stmt.run(
        'ukrainian', q.order, q.type, q.text,
        q.options || null,
        q.match_left || null,
        q.match_right || null,
        q.correct, q.points || 1,
        q.instruction || null
      );
    }

    for (const q of mathQuestions) {
      stmt.run(
        'math', q.order, q.type, q.text,
        q.options || null,
        q.match_left || null,
        q.match_right || null,
        q.correct, q.points || 1,
        q.instruction || null
      );
    }
    db.run('COMMIT', () => {
      stmt.finalize();
      console.log('Seeded 52 questions (30 Ukrainian + 22 Math, real NMT format).');
    });
  });
}

const PREFERRED_PARTICIPANTS_CSV = path.join(__dirname, 'participants_kse.csv');

function seedParticipantsIfEmpty() {
  db.get('SELECT COUNT(*) as cnt FROM participants', (err, row) => {
    if (err) return;
    if (row.cnt === 0 && fs.existsSync(PREFERRED_PARTICIPANTS_CSV)) {
      console.log('Seeding participants from CSV...');
      const content = fs.readFileSync(PREFERRED_PARTICIPANTS_CSV, 'utf-8');
      const lines = content.split('\\n').map(l => l.trim()).filter(Boolean);
      const dataLines = lines[0].toLowerCase().includes('login') ? lines.slice(1) : lines;
      
      const stmt = db.prepare(`INSERT OR IGNORE INTO participants (login, password, full_name, seat_number) VALUES (?, ?, ?, ?)`);
      let count = 0;
      for (const line of dataLines) {
        const delim = line.includes(';') ? ';' : ',';
        const arr = [];
        let quote = false;
        for (let col = 0, c = 0; c < line.length; c++) {
          let cc = line[c], nc = line[c+1];
          arr[col] = arr[col] || '';
          if (cc === '"' && quote && nc === '"') { arr[col] += cc; ++c; continue; }
          if (cc === '"') { quote = !quote; continue; }
          if (cc === delim && !quote) { ++col; continue; }
          arr[col] += cc;
        }
        const parts = arr.map(s => s.trim());
        if (parts.length < 3) continue;
        const [login, password, full_name, seat_number] = parts;
        if (!login) continue;
        stmt.run(login, password, full_name, seat_number || null);
        count++;
      }
      stmt.finalize(() => console.log('Seeded ' + count + ' participants from CSV.'));
    }
  });
}

module.exports = { db, init };
