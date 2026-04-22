// Wraps next-themes so the rest of the app can import theming from a single
// stable module. next-themes is already pulled in via shadcn's sonner
// component; we centralise the config (storage key, class attribute, default
// theme) here so ModeToggle and any later consumers agree on behaviour.

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ComponentProps } from 'react'

type ProviderProps = ComponentProps<typeof NextThemesProvider>

export function ThemeProvider({ children, ...rest }: ProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="tashi-theme"
      {...rest}
    >
      {children}
    </NextThemesProvider>
  )
}
