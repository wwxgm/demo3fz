import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import VideoFlip from '../modules/video-flip';
import { themeColors, useTheme, type Appearance } from './theme';

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { color, setColor, appearance, setAppearance, palette } = useTheme();
  const [clearing, setClearing] = useState(false);

  const clearCache = () => {
    if (clearing) return;
    setClearing(true);
    try {
      const bytes = VideoFlip.clearProcessingCache();
      const mb = bytes / (1024 * 1024);
      Alert.alert(
        '缓存已清除',
        mb >= 0.1 ? `已清除 ${mb.toFixed(1)} MB 用不到的临时文件。相册里的内容还在。` : '没有可清除的缓存。相册里的内容还在。',
      );
    } finally {
      setClearing(false);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <Text style={[styles.title, { color: palette.text }]}>设置</Text>
      <Text style={[styles.subtitle, { color: palette.muted }]}>夜间是深色，白天是白底。主题色只改按钮和开关。</Text>
      <ScrollView contentContainerStyle={styles.list}>
        <View style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}>
          <View style={styles.themeBlock}>
            <Text style={[styles.rowTitle, { color: palette.text }]}>外观</Text>
            <Text style={[styles.rowHint, { color: palette.muted }]}>夜间适合晚上，白天是白色页面</Text>
            <View style={styles.modes}>
              {(
                [
                  ['dark', '夜间'],
                  ['light', '白天'],
                ] as const
              ).map(([id, label]) => {
                const selected = appearance === id;
                return (
                  <Pressable
                    key={id}
                    style={[styles.mode, { backgroundColor: selected ? color : palette.field }]}
                    onPress={() => setAppearance(id as Appearance)}
                  >
                    <Text style={[styles.modeText, { color: selected ? '#FFFFFF' : palette.text }]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
        <Pressable
          style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
          disabled={clearing}
          onPress={clearCache}
        >
          <View style={styles.rowBody}>
            <Text style={[styles.rowTitle, { color: palette.text }]}>清除缓存</Text>
            <Text style={[styles.rowHint, { color: palette.muted }]}>删掉用不到的临时视频、图片和副本</Text>
          </View>
          {clearing ? <ActivityIndicator color={color} /> : <Text style={[styles.chevron, { color }]}>清除</Text>}
        </Pressable>
        <View style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}>
          <View style={styles.themeBlock}>
            <Text style={[styles.rowTitle, { color: palette.text }]}>更换主题色</Text>
            <Text style={[styles.rowHint, { color: palette.muted }]}>按钮、开关和底部菜单会跟着变</Text>
            <View style={styles.swatches}>
              {themeColors.map((item) => {
                const selected = item.color === color;
                return (
                  <Pressable key={item.id} style={styles.swatchItem} onPress={() => setColor(item.color)}>
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: item.color },
                        selected && { borderWidth: 2, borderColor: palette.text },
                      ]}
                    />
                    <Text style={[styles.swatchName, { color: palette.muted }, selected && { color: item.color }]}>{item.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
  },
  title: {
    color: '#F4F7FB',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 8,
    marginBottom: 18,
    color: '#9BB0C5',
    fontSize: 14,
    lineHeight: 20,
  },
  list: {
    gap: 12,
    paddingBottom: 24,
  },
  row: {
    minHeight: 64,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modes: {
    flexDirection: 'row',
    gap: 8,
  },
  mode: {
    flex: 1,
    minHeight: 36,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeText: {
    fontSize: 14,
    fontWeight: '700',
  },
  rowBody: {
    flex: 1,
    gap: 4,
  },
  rowTitle: {
    color: '#F4F7FB',
    fontSize: 16,
    fontWeight: '700',
  },
  rowHint: {
    color: '#9BB0C5',
    fontSize: 13,
    lineHeight: 18,
  },
  chevron: {
    color: '#8EBEFF',
    fontSize: 15,
    fontWeight: '700',
  },
  themeBlock: {
    flex: 1,
    gap: 8,
  },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  swatchItem: {
    width: 52,
    alignItems: 'center',
    gap: 6,
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  swatchOn: {
    borderWidth: 2,
    borderColor: '#F4F7FB',
  },
  swatchName: {
    color: '#9BB0C5',
    fontSize: 12,
  },
});
