/**
 * @notrealstudio/nr-chat-client — клиент nr-ui-protocol без зависимостей:
 * `createClient` (тонкий, для страниц и виджета) и `createHttpBackend`
 * (`ProtocolBackend` поверх HTTP-биндинга §9). Типы — из nr-ui-protocol
 * (только `import type`: в рантайм протокол не едет).
 */

export { clientOf, createClient, toRunInput, type ChatClient, type ClientOpts, type RunInput, type RunOpts } from './client.js'
export { createHttpBackend, type HttpBackendOpts } from './http-backend.js'
export {
  BackendError,
  CODE_CONNECTION_LOST,
  CODE_NOT_SUPPORTED,
  CODE_UNAUTHORIZED,
  NotSupportedError,
  parseRunEvent,
  parseSSEStream,
  type WireEnvelope,
} from './wire.js'
export { joinStart, stripName } from './text.js'
