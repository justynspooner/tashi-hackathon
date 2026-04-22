// Thin wrappers around sonner's `toast.*` API so the rest of the codebase
// doesn't have to import sonner directly, and we get a consistent message
// shape across user-initiated error paths.

import { toast } from 'sonner'

export function errorToast(title: string, description?: unknown): void {
  const desc = description == null
    ? undefined
    : description instanceof Error
      ? description.message
      : String(description)
  toast.error(title, desc ? { description: desc } : undefined)
}

export function warningToast(title: string, description?: unknown): void {
  const desc = description == null
    ? undefined
    : description instanceof Error
      ? description.message
      : String(description)
  toast.warning(title, desc ? { description: desc } : undefined)
}

export function infoToast(title: string, description?: string): void {
  toast.info(title, description ? { description } : undefined)
}

export function successToast(title: string, description?: string): void {
  toast.success(title, description ? { description } : undefined)
}

/**
 * Wrap a user-initiated async action so its rejection surfaces as a toast
 * instead of being silently swallowed by the legacy `.catch(() => {})` sites.
 */
export async function runWithToast<T>(
  title: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    errorToast(title, err)
    return undefined
  }
}
