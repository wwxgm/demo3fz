import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MediaScreen } from './src/MediaScreen';
import { PosterScreen } from './src/PosterScreen';
import { SearchScreen } from './src/SearchScreen';
import { SettingsScreen } from './src/SettingsScreen';
import { ThemeProvider, useTheme } from './src/theme';

type Tab = 'media' | 'search' | 'poster' | 'settings';

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Shell />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const insets = useSafeAreaInsets();
  const { palette } = useTheme();
  const [tab, setTab] = useState<Tab>('media');

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <StatusBar style={palette.statusBar} />
      <View style={styles.body}>
        {tab === 'media' ? (
          <MediaScreen />
        ) : tab === 'search' ? (
          <SearchScreen />
        ) : tab === 'poster' ? (
          <PosterScreen />
        ) : (
          <SettingsScreen />
        )}
      </View>
      <View
        style={[
          styles.tabBar,
          { paddingBottom: Math.max(insets.bottom, 8), backgroundColor: palette.bar, borderTopColor: palette.line },
        ]}
      >
        <TabButton label="视频图片" active={tab === 'media'} onPress={() => setTab('media')} />
        <TabButton label="搜索" active={tab === 'search'} onPress={() => setTab('search')} />
        <TabButton label="大字报" active={tab === 'poster'} onPress={() => setTab('poster')} />
        <TabButton label="设置" active={tab === 'settings'} onPress={() => setTab('settings')} />
      </View>
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { color, palette } = useTheme();
  return (
    <Pressable style={styles.tab} onPress={onPress}>
      <Text style={[styles.tabText, { color: active ? color : palette.muted }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  body: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
    backgroundColor: '#FFFFFF',
  },
  tab: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabText: {
    color: '#6B7280',
    fontSize: 13,
    fontWeight: '600',
  },
  tabTextOn: {
    color: '#F4F7FB',
  },
});
