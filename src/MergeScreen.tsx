import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from '../modules/video-flip';
import { useTheme, type Palette } from './theme';
import { errorText } from './runtime';

type Clip = {
  id: string;
  uri: string;
  name: string;
};

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mpeg|mpg)$/i;

function isVideo(name: string, mimeType?: string | null) {
  if (mimeType?.startsWith('video/')) return true;
  return VIDEO_EXT.test(name);
}

function baseName(uri: string, fallback: string) {
  const clean = uri.split('?')[0];
  try {
    return decodeURIComponent(clean.split('/').pop() || '') || fallback;
  } catch {
    return fallback;
  }
}

export function MergeScreen({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { color: accent, palette } = useTheme();
  const styles = useMemo(() => createMergeStyles(palette, accent), [palette, accent]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [busy, setBusy] = useState(false);

  const addClips = (next: Clip[]) => {
    if (next.length === 0) {
      Alert.alert('没有视频', '请重新选择。');
      return;
    }
    setClips((prev) => {
      const seen = new Set(prev.map((item) => item.uri));
      return [...prev, ...next.filter((item) => !seen.has(item.uri))].slice(0, 30);
    });
  };

  const pickLibrary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsMultipleSelection: true,
        selectionLimit: 0,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (result.canceled) return;
      const next: Clip[] = [];
      result.assets.forEach((asset, index) => {
        const name = asset.fileName || baseName(asset.uri, `视频 ${index + 1}.mp4`);
        if (asset.type && asset.type !== 'video' && !isVideo(name, asset.mimeType)) return;
        next.push({ id: `${Date.now()}-lib-${index}-${name}`, uri: asset.uri, name });
      });
      addClips(next);
    } catch (error) {
      Alert.alert('无法打开相册', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const pickFiles = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['video/*', 'public.movie', 'public.mpeg-4'],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const next: Clip[] = [];
      result.assets.forEach((asset, index) => {
        if (!isVideo(asset.name, asset.mimeType)) return;
        next.push({ id: `${Date.now()}-file-${index}-${asset.name}`, uri: asset.uri, name: asset.name });
      });
      addClips(next);
    } catch (error) {
      Alert.alert('无法打开文件', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, direction: -1 | 1) => {
    setClips((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const merge = async () => {
    if (busy) return;
    if (clips.length < 2) {
      Alert.alert('至少两个视频', '按从上到下的顺序接成一个。');
      return;
    }
    if (Platform.OS !== 'ios') {
      Alert.alert('仅支持 iPhone', '合并并保存到相册目前只在 iPhone 安装包里可用。');
      return;
    }
    const current = await MediaLibrary.getPermissionsAsync(true);
    const permission = current.granted ? current : await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) {
      Alert.alert('需要相册权限', '合并后的视频要保存到手机相册，请允许添加照片。', [
        { text: '取消', style: 'cancel' },
        { text: '去设置', onPress: () => void Linking.openSettings() },
      ]);
      return;
    }
    setBusy(true);
    let output = '';
    try {
      output = await VideoFlip.joinVideos(clips.map((item) => item.uri));
      await MediaLibrary.createAssetAsync(output);
      Alert.alert('已保存', '合并后的视频已保存到相册。');
      setClips([]);
    } catch (error) {
      Alert.alert('合并失败', errorText(error));
    } finally {
      if (output) VideoFlip.removeTempFile(output);
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>合并视频</Text>
        <Pressable disabled={busy} onPress={onClose} hitSlop={8}>
          <Text style={styles.link}>返回</Text>
        </Pressable>
      </View>
      <Text style={styles.subtitle}>按列表顺序接成一个视频，画面大小跟第一条一致，保存到相册。</Text>
      <View style={styles.actions}>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickLibrary()}>
          <Text style={styles.secondaryText}>从相册选择</Text>
        </Pressable>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFiles()}>
          <Text style={styles.secondaryText}>从文件选择</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {clips.length === 0 ? (
          <Text style={styles.empty}>还没有视频。可以一次多选，再用上移调整顺序。</Text>
        ) : (
          clips.map((item, index) => (
            <View key={item.id} style={styles.card}>
              <Text style={styles.cardName} numberOfLines={2}>
                {index + 1}. {item.name}
              </Text>
              <View style={styles.cardActions}>
                <Pressable disabled={busy || index === 0} onPress={() => move(index, -1)} hitSlop={8}>
                  <Text style={[styles.link, (busy || index === 0) && styles.dim]}>上移</Text>
                </Pressable>
                <Pressable disabled={busy} onPress={() => setClips((prev) => prev.filter((it) => it.id !== item.id))} hitSlop={8}>
                  <Text style={styles.remove}>移除</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </ScrollView>
      <Pressable
        style={[styles.primary, { backgroundColor: accent }, (busy || clips.length < 2) && styles.primaryDisabled]}
        disabled={busy || clips.length < 2}
        onPress={() => void merge()}
      >
        {busy ? <ActivityIndicator color="#F4F7FB" /> : <Text style={styles.primaryText}>合并并保存（{clips.length}）</Text>}
      </Pressable>
    </View>
  );
}

function createMergeStyles(palette: Palette, accent: string) {
  return StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
    backgroundColor: palette.background,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: palette.text,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 8,
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 12,
  },
  secondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.field,
  },
  secondaryText: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  list: {
    flex: 1,
    marginTop: 16,
  },
  listContent: {
    gap: 10,
    paddingBottom: 16,
  },
  empty: {
    color: palette.placeholder,
    fontSize: 14,
    lineHeight: 20,
  },
  card: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    gap: 8,
  },
  cardName: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  cardActions: {
    flexDirection: 'row',
    gap: 16,
  },
  link: {
    color: accent,
    fontSize: 15,
    fontWeight: '600',
  },
  dim: {
    opacity: 0.35,
  },
  remove: {
    color: '#F0A8A8',
    fontSize: 15,
    fontWeight: '600',
  },
  primary: {
    minHeight: 52,
    borderRadius: 14,
    marginBottom: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F6FEB',
  },
  primaryDisabled: {
    opacity: 0.45,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
}
