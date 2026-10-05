# @notrealstudio/nr-chat-client

Тонкий клиент бэкенда nrchat (nr-ui-protocol, HTTP-биндинг §9) без зависимостей: сессии, ран со стримом по SSE, ответы на вопросы и апрувы, отмена, профили, модели, ключ доступа. Работает в браузере и в Node (`fetch` + чтение потока, не `EventSource` — ран стартует POST'ом с телом и несёт заголовок ключа). Типы — из `@notrealstudio/nr-ui-protocol` (только `import type`, в рантайм протокол не едет).

## Встраивание

```js
import { createClient } from '@notrealstudio/nr-chat-client'

const chat = createClient('http://127.0.0.1:7800', { auth: 'ключ стенда' })
const s = await chat.sessions.create({ profile: 'agent' })
const end = await chat.run(s.id, 'привет', { onEvent: (ev) => ev.type === 'part_delta' && print(ev.delta) })
```

## API

`createClient(baseUrl, { auth?, fetch?, headers?, capabilitiesTtl? })`:

| метод | что |
|---|---|
| `capabilities()` | что умеет бэкенд (кэш до `close`) |
| `sessions.list/create/get/history` | сессии; `create({profile, model, cwd, title…})` — `SessionCreateOpts` протокола |
| `sessions.meta.get/patch` | мета сессии: промпт, `tools` (тулы страницы), `workspace.cwd` (v1.20) |
| `run(sid, input, {target, onEvent, signal})` | ран целиком → `run_end`. `input` — текст, части или `RunStartInput`. `signal` → `cancel` на сервере, результат — `run_end` `cancelled`. Отказ до стрима (`not_supported`, `busy`, 401) — reject; ошибка рана — `run_end` `error` |
| `stream(sid, input, {target, signal})` | тот же ран итератором (`for await`) |
| `respond(sid, askId, answer)` | ответ на `ask`: `tool_approval` (`allow` / `allow_session` / `deny`), `select`, `text`, `tool` (результат тула страницы) |
| `cancel(sid, runId)`, `profiles()`, `models()`, `close()` | |
| `backend` | `ProtocolBackend` целиком (правки, свайпы, вложения, файлы, сервисы) |

`clientOf(backend, baseUrl = 'local')` — тот же клиент поверх любого `ProtocolBackend`
(бэкенд в процессе страницы — `createLocalBackend` из `backend-nr/browser`, виджет
`backend="local"`).

`createHttpBackend(url, opts)` — полный `ProtocolBackend` поверх HTTP (тот же, что был в `backend-http/client`; backend-http реэкспортирует его отсюда). Ошибки: `BackendError {code, status}`, `NotSupportedError` (`err instanceof NotSupportedError` протокола ≥0.27 верно и для него).

## Ключ доступа

Стенд с `$auth_key` требует `Authorization: Bearer <ключ>` на каждом запросе, включая SSE. `auth` клиента ставит заголовок сам; без ключа — `BackendError` со `status: 401`, `code: 'unauthorized'`.

## Разработка

```sh
npm install && npm run build
npm test          # юниты на mock-сервере HTTP-биндинга
npm run typecheck
```
