import { useEffect } from 'react';

export function useThemeProvider() {
  useEffect(() => {
    // We are forcing dark mode for this app
    document.documentElement.classList.add('dark');
  }, []);
}
