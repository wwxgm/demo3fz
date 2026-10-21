import { createContext, useContext, useState, type ReactNode } from 'react';

export const themeColors = [
  { id: 'blue', name: '蓝色', color: '#1F6FEB' },
  { id: 'red', name: '红色', color: '#FE2C55' },
  { id: 'orange', name: '橙色', color: '#FF7A18' },
  { id: 'green', name: '绿色', color: '#1F9D55' },
  { id: 'purple', name: '紫色', color: '#7C5CFF' },
  { id: 'gold', name: '金色', color: '#E6B325' },
];

type ThemeValue = {
  color: string;
  setColor: (color: string) => void;
};

const ThemeContext = createContext<ThemeValue>({
  color: themeColors[0].color,
  setColor: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [color, setColor] = useState(themeColors[0].color);
  return <ThemeContext.Provider value={{ color, setColor }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
