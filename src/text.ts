/**
 * Текст реплики impersonate на стороне вида (плагин `rp` фронта, виджет):
 * склейка начала из композера с продолжением модели и срез подписи `Имя:`.
 * Источник правила — сборка `nr-chat-store/assembly` (`rp.ts`); клиент без
 * зависимостей держит ту же пару для фронтов, тест nrchat сверяет их.
 */

/**
 * Склейка начала из композера с продолжением модели: модель часто повторяет
 * процитированное начало — повтор срезается, на шве — пробел.
 */
export function joinStart(start: string, continuation: string): string {
  if (start === '') return continuation
  const head = start.trimEnd()
  let rest = continuation
  if (rest.trimStart().startsWith(head)) rest = rest.trimStart().slice(head.length)
  if (rest === '') return start
  // Пробел не нужен только перед закрывающей пунктуацией; открывающая кавычка — новое слово.
  const needsSpace = !/\s$/.test(start) && !/^[\s.,!?;:…)»]/.test(rest)
  return start + (needsSpace ? ' ' : '') + rest
}

/** Срезать `Имя:` в начале, если модель всё-таки подписалась. */
export function stripName(text: string, user: string): string {
  const prefix = `${user}:`
  const t = text.trimStart()
  return t.startsWith(prefix) ? t.slice(prefix.length).trimStart() : text
}
