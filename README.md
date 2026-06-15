# t-scriber

Локальный (privacy-first) транскрибатор встреч Google Meet для macOS. Всё считается на устройстве: аудио и активный спикер берутся из браузера, речь распознаётся `whisper.cpp` (large-v3-turbo, Metal), анализ — Gemma 4 E4B через `llama.cpp`. Данные никуда не уходят за пределы устройства.

Целевое железо: **Mac на Apple Silicon**, ≥16 GB RAM

## Установка (DMG)

**1. Скачай и установи приложение:**
Открой `.dmg`, перетащи T-Scriber в Applications. При первом запуске macOS покажет предупреждение — правый клик → Открыть.

**2. Скачай AI-модели** (один раз, ~5.8 ГБ суммарно):

| Модель | Для чего | Размер | Ссылка |
|--------|----------|--------|--------|
| `ggml-large-v3-turbo-q5_0.bin` | Распознавание речи (Whisper) | ~547 MB | [HuggingFace](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin) |
| `gemma-4-E4B-it-Q4_K_M.gguf` | Генерация резюме (Gemma 4) | ~5.3 GB | [HuggingFace](https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf) |

**3. Укажи пути к моделям в настройках:**
Открой T-Scriber → **⌘,** (или меню T-Scriber → Настройки…) → укажи пути к скачанным файлам → Сохранить.

**4. Установи расширение Chrome:**
При первом запуске приложение покажет подсказку. Или вручную:
- `chrome://extensions` → **Режим разработчика** → **Загрузить распакованное** → выбери папку `T-Scriber.app/Contents/Resources/extension/`.

**5. Запиши встречу:**
- Зайди в звонок на `meet.google.com`.
- Кликни иконку T-Scriber → **Start recording**.
- При первом запуске появится вкладка с запросом микрофона — разреши и нажми Start ещё раз.
- Держи окно Meet видимым, говорите.
- По окончании — выйди из встречи или нажми **Stop recording**.

---

## Разработка (из исходников)

**1. Собери движки и скачай модели** (~7.5 ГБ, ~10–15 мин, один раз):
```bash
xcode-select --install   # если нет clang
./scripts/setup-models.sh
```

**2. Установи расширение в Chrome:**
- `chrome://extensions` → **Developer mode** → **Load unpacked** → выбери папку `extension/`.

**3. Установи зависимости и запусти:**
```bash
cd electron && npm install && npm start
```
При первом `npm install` нативные модули компилируются под Electron (~30с). После этого — просто `npm start`.

**4. Собери DMG:**
```bash
just package   # или just build — полная сборка движков + DMG
```

## Диаризация

Спикер берётся из DOM-эквалайзера Meet, который замирает, когда вкладка скрыта (например, ты шаришь экран). Диаризация — это фолбэк: после распознавания она сравнивает «осиротевшие» реплики с голосами тех, кто уже был атрибутирован при видимой вкладке, и доназначает имена по голосу. Кто говорил **только** при скрытой вкладке (голосового образца нет) — останется `unknown_speaker_N`.

Эмбеддинги голоса считаются на чистом JS через `onnxruntime-node` (ставится обычным `npm install`), модель `voice-encoder.onnx` (~6 МБ) лежит в `electron/src/diarize/`. Включается флагом `"diarize": true` в конфиге (по умолчанию включено). Модель портирована с [resemblyzer](https://github.com/resemble-ai/Resemblyzer); пересобрать артефакты можно через `scripts/export-voice-encoder.py` (нужен одноразовый env с torch+librosa+resemblyzer).

## Структура проекта

```
t-scriber/
├── electron/               # Electron-приложение (UI + сервер захвата)
│   ├── main.js             # Electron main: DB, WebSocket-сервер, IPC
│   ├── preload.js          # contextBridge для рендерера
│   ├── transcribe-cli.js   # CLI для ручной (пере)обработки сессий
│   ├── src/                # Бэкенд-логика
│   │   ├── capture.js      # WebSocket-сервер
│   │   ├── pipeline.js     # Оркестратор: транскрибация → мэппинг → саммари
│   │   ├── mapping.js      # Атрибуция реплик участникам
│   │   ├── analyze.js      # LLM (Gemma 4 E4B)
│   │   ├── transcribe.js   # Обёртка whisper.cpp
│   │   ├── diarize.js      # Голосовая диаризация (фолбэк для скрытой вкладки)
│   │   ├── session.js      # Управление файлами сессии
│   │   ├── config.js       # Загрузка конфига
│   │   └── wav.js          # PCM ↔ WAV
│   ├── ui/                 # Рендерер (ванильный JS, без фреймворка)
│   │   ├── index.html
│   │   ├── style.css
│   │   └── app.js
│   └── test/               # Юнит-тесты + E2E
├── extension/              # Chrome-расширение MV3 (захват аудио + спикеры)
├── models/                 # AI-модели (создаётся setup-models.sh)
├── third_party/            # whisper.cpp, llama.cpp
├── scripts/
│   ├── setup-models.sh         # Сборка движков + скачивание моделей
│   └── export-voice-encoder.py # Build-tool: регенерация voice-encoder.onnx
└── tscriber.config.example.json
```

## Конфиг

**В приложении:** ⌘, → настройки модели, языка, имени, включение резюме / диаризации.

**Вручную** (для разработки или расширенных параметров):
```bash
cp tscriber.config.example.json tscriber.config.json
```
Поиск конфига при запуске: `$TSCRIBER_CONFIG` → `./tscriber.config.json` (в корне репо) → `~/.tscriber/config.json`. Пути с `~/` разворачиваются.

Ключи: `addr`, `data_dir`, `auto`, `summarize`, `language`, `self_name` (имя для mic-дорожки), `threads`, `whisper_bin`, `model`, `vad_model`, `llama_bin`, `gemma_model`, `diarize`.

Поставь `self_name` равным своему имени в Meet — тогда атрибуция из DOM и фолбэк будут давать одну метку.

`diarize` (по умолчанию `true`) включает голосовую диаризацию — см. [раздел выше](#диаризация). Необязательный ключ `diarize_onnx_model` задаёт путь к своей модели voice-encoder (по умолчанию берётся `electron/src/diarize/voice-encoder.onnx`).

## Архитектура

```
Chrome Extension (MV3)                 Electron (main process)
┌─────────────────────────┐           ┌──────────────────────────────────────┐
│ popup → getMediaStreamId │           │ WebSocket :8080/capture              │
│ offscreen:               │  PCM 16k  │   tab.pcm  mic.pcm  events.jsonl     │
│   • tab audio  (others)  │ ───────►  │              │                       │
│   • mic        (self)    │  +events  │       pipeline.js                    │
│ content.js → speaker DOM │           │ whisper.cpp → mapping → (diarize) →  │
│                          │           │                          llama.cpp  │
└─────────────────────────┘           │              │                       │
                                       │        SQLite index                  │
                                       │      tscriber.db                     │
                                       └──────────────┬───────────────────────┘
                                                      │ IPC
                                       ┌──────────────▼───────────────────────┐
                                       │         Renderer (UI)                │
                                       │   таблица сессий / детальный вид     │
                                       │   лог-панель с событиями сервера     │
                                       └──────────────────────────────────────┘
```

Ключевые решения:
- **Offscreen document**, а не service worker: SW в MV3 умирает через ~30с, что рвёт WebSocket.
- **Два потока**: `tabCapture` даёт голоса других, `getUserMedia` — свой (помечается как `mic`).
- **Сырой 16 kHz Int16 PCM по WS**: склейка WebM-чанков даёт битый контейнер; PCM идёт прямо в whisper.
- **SQLite как кэш-индекс**: сырые файлы — источник правды, БД даёт быстрый листинг и поиск.
- **Сервер в main process**: no child process, нет парсинга stdout — события пробрасываются через `CaptureServer._emit()` напрямую в IPC.

## UI

Приложение открывается командой `npm start` из папки `electron/`. Отдельный бэкенд не нужен.

- **Таблица** — все записи: дата, участники, суть (из Ключевых решений)
- **Детальный вид** — кликни строку: краткое резюме, решения, action items
- **Транскрибация** — разворачивается по кнопке; твои реплики (mic) выделены синим
- **Лог-панель** (снизу) — события сервера в реальном времени: подключение, начало встречи, прогресс обработки
- **Удаление** — кнопка удаляет строку из БД и папку с диска (с подтверждением)

## Ручная (пере)обработка

```bash
cd electron
node transcribe-cli.js --latest                  # самая свежая сессия
node transcribe-cli.js --dir ~/.tscriber/sessions/<ts>
node transcribe-cli.js --latest --summary-only   # только пересобрать summary.md
```

## Тесты

Быстрые юнит-тесты (`node:test`, без внешних зависимостей):
```bash
cd electron && npm test
```

### E2E-тест транскрибации (без UI)

Прогоняет **весь реальный флоу** на настоящих движках: аудио → WebSocket `/capture` →
запись на диск → whisper → атрибуция спикеров → саммари Gemma. Тяжёлый и медленный (грузит
whisper + ~5 ГБ Gemma, ~1 мин), поэтому вынесен из `npm test` и включается явно:

```bash
cd electron
npm run gen-fixture   # один раз: генерит аудио-фикстуру (нужен macOS: say + afconvert)
npm run test:e2e      # сам прогон (нужны собранные движки + модели, как для приложения)
```

- **Сценарии — это JSON.** Каждый разговор описан в `test/e2e/scenarios/<name>.json`
  (реплики, заложенные факты, голосовые профили, какие факты обязательны в саммари — см.
  [scenarios/planning.json](electron/test/e2e/scenarios/planning.json)). Чтобы добавить новый
  сценарий — положи рядом ещё один `<name>.json` и перегенерируй; тест прогонит отдельный
  подтест на каждый. Два слышимо разных спикера делаются из единственного русского голоса
  Milena через разметку питча/темпа `say` (`voices`); реплика на mic-дорожке без
  speaker-события проверяет фолбэк на `self_name`.
- **Фикстуры** (`test/fixtures/e2e/<name>/`) генерируются из сценариев и коммитятся —
  `npm run test:e2e` их только воспроизводит и `say` не вызывает. `gen-fixture.js` без
  аргументов перегенерит все сценарии; `node test/e2e/gen-fixture.js scenarios/<name>.json` —
  один. Контракт ожиданий (`expected.json`, спикеры/`expectSelfFallback` выводятся из
  сценария автоматически) лежит в каждой папке фикстуры.
- **Оценка саммари** (выход LLM недетерминирован, поэтому не сравниваем с эталоном):
  проверяем структуру (три заголовка) + наличие заложенных фактов по recall'у
  ([test/e2e/match.js](electron/test/e2e/match.js), нормализация ё→е + fuzzy). LLM гоняется
  с `--temp 0` и фиксированным seed для снижения дисперсии. Те же факты сверяются и в
  `transcript.txt` — это отделяет ошибку whisper от ошибки саммари. Есть мягкий LLM-judge —
  печатается в лог, но прогон не блокирует.
- **Нюанс 1 — gapMs**: silero-vad делает pre-roll до ~1 с на треках с несколькими
  сегментами, сдвигая обнаруженное начало речи раньше. `gapMs` должен быть >
  `VAD_preroll + MATCH_TOLERANCE_MS` (≈ 1000 + 500 = 1500 мс). Используем **3000 мс** для
  надёжного запаса. Старое значение 1200 мс достаточно только для одиночного mic-сегмента.
- **Нюанс 2 — параллелизм**: запускать несколько сценариев параллельно нельзя — каждый
  грузит ~5 ГБ Gemma на GPU. Тесты обёрнуты в `describe({ concurrency: 1 })`.
- **Нюанс 3 — VAD + zero-silence**: два коротких mic-сегмента с чистой нулевой тишиной
  между ними silero-vad может объединить в один гигантский сегмент. Если сценарий тестирует
  только галлюцинации Gemma, а не self_name fallback, лучше использовать только tab-треки.

### E2E-тест диаризации

Отдельный прогон (`test/e2e/diarize.e2e.js`) проверяет восстановление спикеров по голосу.
Гоняется тем же `npm run test:e2e` (нужны whisper-бинари + модель voice-encoder.onnx, иначе
подтест аккуратно скипается). Сценарий `scenarios/diarize-hidden-tab.json` моделирует «скрытую
вкладку»: часть реплик помечена `"event": false` (speaker-события не пишутся), и тест требует,
чтобы диаризация доназначила им правильного спикера. Поскольку для разделения нужны акустически
разные голоса, а на macOS русский голос только один (Milena), этот сценарий — англоязычный
(Samantha + Daniel). Юнит-тесты самого модуля (`test/diarize.test.js`) входят в обычный
`npm test`; быстрый JS-смоук атрибуции без whisper — `npm run test:diarize-parity`.

## Известные ограничения
- **Перехлёст речи** (двое говорят одновременно) не разводится.
- **Вёрстка Meet** может меняться. Если speaker-события не идут — запусти `__tscriberDebug()` в консоли Meet и обнови `SELECTORS` в `extension/content.js`.

