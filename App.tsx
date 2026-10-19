import { useState } from 'react';
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
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from './modules/video-flip';

type ItemStatus = 'pending' | 'processing' | 'saving' | 'saved' | 'failed';

type VideoItem = {
  id: string;
  uri: string;
  name: string;
  size?: number;
  durationMs?: number;
  source: '相册' | '文件';
  status: ItemStatus;
  message?: string;
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

function formatSize(size?: number) {
  if (!size || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs?: number) {
  if (!durationMs || durationMs <= 0) return '';
  const total = Math.round(durationMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function errorText(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return '处理失败';
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Screen />
    </SafeAreaProvider>
  );
}

function Screen() {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<VideoItem[]>([]);
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [summary, setSummary] = useState('');
  const busy = running || picking;

  const addItems = (next: VideoItem[]) => {
    if (next.length === 0) {
      Alert.alert('没有视频', '请选择视频文件。');
      return;
    }
    setSummary('');
    setItems((prev) => {
      const seen = new Set(prev.map((item) => item.uri));
      return [...prev, ...next.filter((item) => !seen.has(item.uri))];
    });
  };

  const pickFromLibrary = async () => {
    if (busy) return;
    setPicking(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsMultipleSelection: true,
        selectionLimit: 0,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (result.canceled) return;

      const next: VideoItem[] = [];
      result.assets.forEach((asset, index) => {
        const name = asset.fileName || baseName(asset.uri, `相册视频 ${index + 1}.mp4`);
        if (asset.type && asset.type !== 'video' && !isVideo(name, asset.mimeType)) return;
        next.push({
          id: `${Date.now()}-lib-${index}-${name}`,
          uri: asset.uri,
          name,
          size: asset.fileSize,
          durationMs: asset.duration ?? undefined,
          source: '相册',
          status: 'pending',
        });
      });
      addItems(next);
    } catch (error) {
      Alert.alert('无法打开相册', errorText(error));
    } finally {
      setPicking(false);
    }
  };

  const pickFromFiles = async () => {
    if (busy) return;
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['video/*', 'public.movie', 'public.mpeg-4'],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      const next: VideoItem[] = [];
      result.assets.forEach((asset, index) => {
        if (!isVideo(asset.name, asset.mimeType)) return;
        next.push({
          id: `${Date.now()}-file-${index}-${asset.name}`,
          uri: asset.uri,
          name: asset.name,
          size: asset.size,
          source: '文件',
          status: 'pending',
        });
      });
      addItems(next);
    } catch (error) {
      Alert.alert('无法打开文件', errorText(error));
    } finally {
      setPicking(false);
    }
  };

  const ensureSavePermission = async () => {
    const current = await MediaLibrary.getPermissionsAsync(true);
    const permission = current.granted
      ? current
      : await MediaLibrary.requestPermissionsAsync(true);
    if (permission.granted) return true;

    Alert.alert('需要相册权限', '翻转后的视频要保存到手机相册，请允许添加照片。', [
      { text: '取消', style: 'cancel' },
      { text: '去设置', onPress: () => void Linking.openSettings() },
    ]);
    return false;
  };

  const flipAll = async () => {
    if (busy) return;
    const queue = items.filter((item) => item.status !== 'saved');
    if (items.length === 0) {
      Alert.alert('还没有视频', '请先从相册或文件里选择视频。');
      return;
    }
    if (queue.length === 0) {
      Alert.alert('已经保存', '当前这些视频都已经保存到相册。');
      return;
    }
    if (Platform.OS !== 'ios') {
      Alert.alert('仅支持 iPhone', '水平翻转并保存到相册目前只在 iPhone 安装包里可用。');
      return;
    }

    const allowed = await ensureSavePermission();
    if (!allowed) return;

    setRunning(true);
    setSummary('');
    let saved = 0;
    let failed = 0;

    for (const item of queue) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id ? { ...it, status: 'processing', message: '正在左右镜像…' } : it,
        ),
      );
      let outputUri = '';
      try {
        outputUri = await VideoFlip.flipHorizontal(item.uri);
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, status: 'saving', message: '正在保存到相册…' } : it,
          ),
        );
        await MediaLibrary.createAssetAsync(outputUri);
        saved += 1;
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, status: 'saved', message: '已保存到相册' } : it,
          ),
        );
      } catch (error) {
        failed += 1;
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, status: 'failed', message: errorText(error) } : it,
          ),
        );
      } finally {
        if (outputUri) VideoFlip.removeTempFile(outputUri);
      }
    }

    const text =
      failed === 0
        ? `已把 ${saved} 个视频保存到相册`
        : `成功 ${saved} 个，失败 ${failed} 个。失败的可以再点一次重试`;
    setSummary(text);
    setRunning(false);
    Alert.alert(failed === 0 ? '已保存' : '处理结束', text);
  };

  const pendingCount = items.filter((item) => item.status !== 'saved').length;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>视频水平翻转</Text>
        <Text style={styles.subtitle}>
          从相册或文件多选视频，一键左右镜像，并保存到手机相册。
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFromLibrary()}>
          <Text style={styles.secondaryText}>从相册选择</Text>
        </Pressable>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFromFiles()}>
          <Text style={styles.secondaryText}>从文件选择</Text>
        </Pressable>
      </View>

      <View style={styles.listHead}>
        <Text style={styles.listTitle}>已选 {items.length} 个</Text>
        {items.length > 0 && !busy ? (
          <Pressable onPress={() => setItems([])}>
            <Text style={styles.clear}>清空</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {items.length === 0 ? (
          <Text style={styles.empty}>还没有视频。可以一次多选。</Text>
        ) : (
          items.map((item, index) => {
            const meta = [item.source, formatDuration(item.durationMs), formatSize(item.size)]
              .filter(Boolean)
              .join(' · ');
            return (
              <View key={item.id} style={styles.card}>
                <View style={styles.cardBody}>
                  <Text style={styles.cardName} numberOfLines={2}>
                    {index + 1}. {item.name}
                  </Text>
                  {meta ? <Text style={styles.cardMeta}>{meta}</Text> : null}
                  {item.message ? (
                    <Text
                      style={[
                        styles.cardStatus,
                        item.status === 'saved' && styles.ok,
                        item.status === 'failed' && styles.bad,
                      ]}
                    >
                      {item.message}
                    </Text>
                  ) : null}
                </View>
                {!busy ? (
                  <Pressable onPress={() => setItems((prev) => prev.filter((it) => it.id !== item.id))} hitSlop={10}>
                    <Text style={styles.remove}>移除</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>

      {summary ? <Text style={styles.summary}>{summary}</Text> : null}

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Pressable
          style={[styles.primary, (busy || pendingCount === 0) && styles.primaryDisabled]}
          disabled={busy || pendingCount === 0}
          onPress={() => void flipAll()}
        >
          {busy ? (
            <ActivityIndicator color="#F4F7FB" />
          ) : (
            <Text style={styles.primaryText}>
              {pendingCount > 0 ? `一键水平翻转并保存（${pendingCount}）` : '一键水平翻转并保存'}
            </Text>
          )}
        </Pressable>
        <Text style={styles.hint}>
          {picking
            ? '正在读取所选视频…'
            : '处理时请留在这个页面。画面左右对调，画面里的文字也会镜像。'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0B1F33',
    paddingHorizontal: 20,
  },
  header: {
    paddingTop: 8,
    paddingBottom: 16,
  },
  title: {
    color: '#F4F7FB',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 8,
    color: '#9BB0C5',
    fontSize: 15,
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  secondary: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  secondaryText: {
    color: '#F4F7FB',
    fontSize: 16,
    fontWeight: '600',
  },
  listHead: {
    marginTop: 18,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listTitle: {
    color: '#F4F7FB',
    fontSize: 15,
    fontWeight: '600',
  },
  clear: {
    color: '#8EB6FF',
    fontSize: 15,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 12,
    gap: 10,
  },
  empty: {
    color: '#9BB0C5',
    fontSize: 15,
    lineHeight: 22,
    paddingVertical: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  cardBody: {
    flex: 1,
  },
  cardName: {
    color: '#F4F7FB',
    fontSize: 15,
    fontWeight: '600',
  },
  cardMeta: {
    marginTop: 4,
    color: '#9BB0C5',
    fontSize: 13,
  },
  cardStatus: {
    marginTop: 4,
    color: '#8EB6FF',
    fontSize: 13,
  },
  ok: {
    color: '#3DDC97',
  },
  bad: {
    color: '#FF8B8B',
  },
  remove: {
    color: '#FF8B8B',
    fontSize: 14,
  },
  summary: {
    color: '#F4F7FB',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  footer: {
    paddingTop: 8,
  },
  primary: {
    minHeight: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F6FEB',
  },
  primaryDisabled: {
    opacity: 0.45,
  },
  primaryText: {
    color: '#F4F7FB',
    fontSize: 17,
    fontWeight: '700',
  },
  hint: {
    marginTop: 10,
    color: '#9BB0C5',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});
