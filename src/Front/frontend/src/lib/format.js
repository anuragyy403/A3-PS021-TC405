/** Presentation helpers. */

export const pad = (value, size = 2) => String(value).padStart(size, '0');

/** Wall-clock stamp used on every log line and scenario step. */
export function clockStamp(at = Date.now()) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
