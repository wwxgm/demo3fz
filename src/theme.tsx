import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export const themeColors = [
  { id: 'blue', name: '蓝色', color: '#1F6FEB' },
  { id: 'red', name: '红色', color: '#FE2C55' },
  { id: 'orange', name: '橙色', color: '#FF7A18' },
  { id: 'green', name: '绿色', color: '#1F9D55' },
  { id: 'purple', name: '紫色', color: '#7C5CFF' },
  { id: 'gold', name: '金色', color: '#E6B325' },
];

export type Appearance = 'dark' | 'light';

export type Palette = {
  background: string;
  bar: string;
  card: string;
  field: string;
  text: string;
  muted: string;
  placeholder: string;
  line: string;
  switchOff: string;
  statusBar: 'light' | 'dark';
};

export const darkPalette: Palette = {
  background: '#0B1F33',
  bar: '#071521',
  card: 'rgba(255,255,255,0.06)',
  field: 'rgba(255,255,255,0.08)',
  text: '#F4F7FB',
  muted: '#9BB0C5',
  placeholder: '#6E8498',
  line: 'rgba(255,255,255,0.14)',
  switchOff: 'rgba(255,255,255,0.15)',
  statusBar: 'light',
};

export const lightPalette: Palette = {
  background: '#FFFFFF',
  bar: '#FFFFFF',
  card: '#FFFFFF',
  field: '#F4F5F7',
  text: '#1A1A1A',
  muted: '#6B7280',
  placeholder: '#9CA3AF',
  line: 'rgba(0,0,0,0.08)',
  switchOff: '#E5E7EB',
  statusBar: 'dark',
};

type ThemeValue = {
  color: string;
  setColor: (color: string) => void;
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
  palette: Palette;
};

const ThemeContext = createContext<ThemeValue>({
  color: themeColors[0].color,
  setColor: () => undefined,
  appearance: 'light',
  setAppearance: () => undefined,
  palette: lightPalette,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [color, setColor] = useState(themeColors[0].color);
  const [appearance, setAppearance] = useState<Appearance>('light');
  const palette = appearance === 'light' ? lightPalette : darkPalette;
  const value = useMemo(
    () => ({ color, setColor, appearance, setAppearance, palette }),
    [color, appearance, palette],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
