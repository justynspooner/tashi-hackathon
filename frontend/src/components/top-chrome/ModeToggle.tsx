// Theme toggle dropdown for the top chrome. Uses next-themes (already a
// dependency of shadcn's sonner component) so all three modes — Light, Dark,
// and System — share a single source of truth and persist to
// localStorage('tashi-theme') via the ThemeProvider config in
// `components/theme-provider.tsx`.

import { useTheme } from 'next-themes'
import { Moon, Sun, Monitor } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function ModeToggle() {
  const { setTheme, resolvedTheme } = useTheme()
  // `resolvedTheme` resolves `'system'` to the actual `'light'`/`'dark'` value
  // the browser ends up painting — we key the icon off it so users see the
  // current effective theme even when they've chosen "System".
  const isDark = resolvedTheme === 'dark'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="h-8 w-8 p-0" aria-label="Toggle theme">
            {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            <span className="sr-only">Toggle theme</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="h-4 w-4 mr-2" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="h-4 w-4 mr-2" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Monitor className="h-4 w-4 mr-2" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
