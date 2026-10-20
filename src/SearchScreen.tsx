import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from '../modules/video-flip';
import { CropEditor } from './CropEditor';
import { WatermarkForm } from './WatermarkForm';
import {
  CropNorm,
  WatermarkSettings,
  createSaveQueue,
  defaultWatermark,
  errorText,
  runWithLimit,
  watermarkPayload,
} from './runtime';

type Origin = '搜索' | '相册' | '文件';

type WorkImage = {
  id: string;
  uri: string;
  previewUri: string;
  name: string;
  width?: number;
  height?: number;
  origin: Origin;
};

const IMAGE_EXT = /\.(jpg|jpeg|png|heic|heif|gif|webp|bmp|tif|tiff)$/i;

function isImage(name: string, mimeType?: string | null) {
  if (mimeType?.startsWith('image/')) return true;
  return IMAGE_EXT.test(name);
}

function baseName(uri: string, fallback: string) {
  const clean = uri.split('?')[0];
  try {
    return decodeURIComponent(clean.split('/').pop() || '') || fallback;
  } catch {
    return fallback;
  }
}

async function searchImages(query: string, page: number) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page=${page}&page_size=30&mature=false`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'VideoFlip/1.2',
    },
  });
  if (!response.ok) {
    throw new Error('搜索失败，请检查网络');
  }
  const data = (await response.json()) as {
    page_count?: number;
    results?: Array<{
      id?: string;
      title?: string;
      url?: string;
      thumbnail?: string | null;
      width?: number;
      height?: number;
    }>;
  };
  const images: WorkImage[] = [];
  for (const item of data.results ?? []) {
    if (!item.url || !item.id) continue;
    const thumb = item.thumbnail && item.thumbnail.startsWith('http') ? item.thumbnail : item.url;
    images.push({
      id: item.id,
      uri: item.url,
      previewUri: thumb,
      name: item.title || '图片',
      width: item.width,
      height: item.height,
      origin: '搜索',
    });
  }
  const pageCount = data.page_count && data.page_count > 0 ? data.page_count : images.length >= 30 ? page + 1 : page;
  return { images, pageCount };
}

export function SearchScreen() {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [results, setResults] = useState<WorkImage[]>([]);
  const [chosen, setChosen] = useState<WorkImage[]>([]);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  const [flip, setFlip] = useState(false);
  const [watermark, setWatermark] = useState<WatermarkSettings>(defaultWatermark);
  const [crop, setCrop] = useState<CropNorm | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [preview, setPreview] = useState<WorkImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState('');
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  const busy = loading || running || picking;
  const sample =
    chosen.find((item) => item.id === sampleId) ??
    results.find((item) => item.id === sampleId) ??
    chosen[0] ??
    null;

  const runSearch = async (nextPage: number) => {
    const keyword = query.trim();
    if (!keyword) {
      Alert.alert('请输入关键词');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const found = await searchImages(keyword, nextPage);
      setResults(found.images);
      setPage(nextPage);
      setPageCount(found.pageCount);
      if (nextPage === 1) {
        setChosen((prev) => prev.filter((item) => item.origin !== '搜索'));
      }
      if (found.images.length === 0) setMessage('没有找到图片');
    } catch (error) {
      Alert.alert('搜索失败', errorText(error));
    } finally {
      setLoading(false);
    }
  };

  const toggle = (item: WorkImage) => {
    setSampleId(item.id);
    setChosen((prev) => {
      const exists = prev.some((it) => it.id === item.id);
      return exists ? prev.filter((it) => it.id !== item.id) : [...prev, item];
    });
  };

  const onPressItem = (item: WorkImage) => {
    const now = Date.now();
    if (lastTap.current?.id === item.id && now - lastTap.current.at < 280) {
      setPreview(item);
      setSampleId(item.id);
      setChosen((prev) => (prev.some((it) => it.id === item.id) ? prev : [...prev, item]));
      lastTap.current = null;
      return;
    }
    lastTap.current = { id: item.id, at: now };
    toggle(item);
  };

  const addLocal = async (origin: '相册' | '文件') => {
    if (!batch) {
      Alert.alert('请先勾选批量', '批量时才能从相册或文件加入，并和已选图片一起处理。');
      return;
    }
    setPicking(true);
    try {
      const next: WorkImage[] = [];
      if (origin === '相册') {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          selectionLimit: 0,
        });
        if (result.canceled) return;
        result.assets.forEach((asset, index) => {
          const name = asset.fileName || baseName(asset.uri, `相册图片 ${index + 1}.jpg`);
          if (asset.type && asset.type !== 'image' && !isImage(name, asset.mimeType)) return;
          next.push({
            id: `${Date.now()}-lib-${index}-${name}`,
            uri: asset.uri,
            previewUri: asset.uri,
            name,
            width: asset.width,
            height: asset.height,
            origin,
          });
        });
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: ['image/*', 'public.image'],
          multiple: true,
          copyToCacheDirectory: true,
        });
        if (result.canceled) return;
        result.assets.forEach((asset, index) => {
          if (!isImage(asset.name, asset.mimeType)) return;
          next.push({
            id: `${Date.now()}-file-${index}-${asset.name}`,
            uri: asset.uri,
            previewUri: asset.uri,
            name: asset.name,
            origin,
          });
        });
      }
      if (next.length === 0) {
        Alert.alert('没有图片', '请重新选择。');
        return;
      }
      setChosen((prev) => {
        const seen = new Set(prev.map((item) => item.uri));
        return [...prev, ...next.filter((item) => !seen.has(item.uri))];
      });
      setSampleId((current) => current ?? next[0].id);
    } catch (error) {
      Alert.alert('无法选择图片', errorText(error));
    } finally {
      setPicking(false);
    }
  };

  const targets = () => {
    if (chosen.length === 0) return [];
    if (!batch) {
      const one = chosen.find((item) => item.id === sampleId) ?? chosen[0];
      return one ? [one] : [];
    }
    return chosen;
  };

  const ensurePermission = async () => {
    const current = await MediaLibrary.getPermissionsAsync(true);
    const permission = current.granted ? current : await MediaLibrary.requestPermissionsAsync(true);
    if (permission.granted) return true;
    Alert.alert('需要相册权限', '图片要保存到手机相册，请允许添加照片。', [
      { text: '取消', style: 'cancel' },
      { text: '去设置', onPress: () => void Linking.openSettings() },
    ]);
    return false;
  };

  const saveAll = async (mode: 'original' | 'process') => {
    if (busy) return;
    const queue = targets();
    if (queue.length === 0) {
      Alert.alert('还没有图片', '请先点选图片。双击可以预览。');
      return;
    }
    if (mode === 'process' && !flip && !watermark.enabled && !crop) {
      Alert.alert('还没有处理项', '请勾选水平翻转、水印，或先设置裁剪。');
      return;
    }
    if (watermark.enabled && !watermark.placeLeft && !watermark.placeCenter) {
      Alert.alert('请选择水印位置', '左边或中央至少打开一个。');
      return;
    }
    if (Platform.OS !== 'ios') {
      Alert.alert('仅支持 iPhone', '保存到相册目前只在 iPhone 安装包里可用。');
      return;
    }
    const allowed = await ensurePermission();
    if (!allowed) return;

    setRunning(true);
    setStatuses({});
    let saved = 0;
    let failed = 0;
    const saveNext = createSaveQueue();
    const mark = watermarkPayload(watermark);

    await runWithLimit(queue, 2, async (item) => {
      setStatuses((prev) => ({ ...prev, [item.id]: '正在处理…' }));
      let outputUri = '';
      try {
        outputUri = await VideoFlip.processImage(
          item.uri,
          mode === 'original'
            ? {}
            : {
                flip,
                crop: crop ?? undefined,
                watermark: mark,
              },
        );
        setStatuses((prev) => ({ ...prev, [item.id]: '正在保存到相册…' }));
        await saveNext(() => MediaLibrary.createAssetAsync(outputUri));
        saved += 1;
        setStatuses((prev) => ({ ...prev, [item.id]: '已保存到相册' }));
      } catch (error) {
        failed += 1;
        setStatuses((prev) => ({ ...prev, [item.id]: errorText(error) }));
      } finally {
        if (outputUri) VideoFlip.removeTempFile(outputUri);
      }
    });

    setRunning(false);
    const text =
      failed === 0 ? `已把 ${saved} 张图片保存到相册` : `成功 ${saved} 张，失败 ${failed} 张`;
    setMessage(text);
    Alert.alert(failed === 0 ? '已保存' : '处理结束', text);
  };

  const localChosen = chosen.filter((item) => item.origin !== '搜索');

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <Text style={styles.title}>搜索</Text>
      <Text style={styles.subtitle}>输入关键词，每页 30 张。单击选择，双击预览。</Text>
      <View style={styles.searchRow}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="关键词"
          placeholderTextColor="#6E8498"
          style={styles.input}
          returnKeyType="search"
          onSubmitEditing={() => void runSearch(1)}
        />
        <Pressable style={styles.searchButton} disabled={busy} onPress={() => void runSearch(1)}>
          {loading ? <ActivityIndicator color="#F4F7FB" /> : <Text style={styles.searchText}>搜索</Text>}
        </Pressable>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.optionCard}>
          <View style={styles.optionRow}>
            <Text style={styles.optionLabel}>批量</Text>
            <Switch
              value={batch}
              onValueChange={setBatch}
              trackColor={{ false: 'rgba(255,255,255,0.15)', true: '#1F6FEB' }}
            />
          </View>
          <View style={styles.optionRow}>
            <Text style={styles.optionLabel}>水平翻转</Text>
            <Switch
              value={flip}
              onValueChange={setFlip}
              trackColor={{ false: 'rgba(255,255,255,0.15)', true: '#1F6FEB' }}
            />
          </View>
          <Text style={styles.optionHint}>
            {batch
              ? '批量时只需要裁剪其中一张，其他已选图片按同样比例一起修改，并保存到相册。'
              : '未勾选批量时，只处理当前这一张。'}
          </Text>
        </View>
        {batch ? (
          <View style={styles.actions}>
            <Pressable style={styles.secondary} disabled={busy} onPress={() => void addLocal('相册')}>
              <Text style={styles.secondaryText}>从相册选择</Text>
            </Pressable>
            <Pressable style={styles.secondary} disabled={busy} onPress={() => void addLocal('文件')}>
              <Text style={styles.secondaryText}>从文件选择</Text>
            </Pressable>
          </View>
        ) : null}
        <WatermarkForm value={watermark} onChange={setWatermark} />
        <View style={styles.optionRow}>
          <Text style={styles.optionLabel}>{crop ? '已设置裁剪' : '未设置裁剪'}</Text>
          <View style={styles.inlineLinks}>
            <Pressable
              onPress={() => {
                if (!sample) {
                  Alert.alert('请先选择一张图片');
                  return;
                }
                setCropOpen(true);
              }}
            >
              <Text style={styles.link}>设置裁剪</Text>
            </Pressable>
            {crop ? (
              <Pressable onPress={() => setCrop(null)}>
                <Text style={styles.link}>清除</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <View style={styles.pageRow}>
          <Pressable disabled={busy || page <= 1} onPress={() => void runSearch(page - 1)}>
            <Text style={[styles.link, page <= 1 && styles.disabled]}>上一页</Text>
          </Pressable>
          <Text style={styles.pageText}>
            第 {page} 页{pageCount > 1 ? ` / ${pageCount}` : ''} · 已选 {chosen.length}
          </Text>
          <Pressable disabled={busy || page >= pageCount} onPress={() => void runSearch(page + 1)}>
            <Text style={[styles.link, page >= pageCount && styles.disabled]}>下一页</Text>
          </Pressable>
        </View>
        {results.length === 0 ? (
          <Text style={styles.empty}>{message || '搜索后会在这里显示图片。'}</Text>
        ) : (
          <View style={styles.grid}>
            {results.map((item) => {
              const selected = chosen.some((it) => it.id === item.id);
              return (
                <Pressable
                  key={item.id}
                  style={[styles.cell, selected && styles.cellOn]}
                  onPress={() => onPressItem(item)}
                >
                  <Image source={{ uri: item.previewUri }} style={styles.thumb} />
                  {selected ? <Text style={styles.badge}>已选</Text> : null}
                </Pressable>
              );
            })}
          </View>
        )}
        {localChosen.length > 0 ? (
          <View style={styles.localBox}>
            <Text style={styles.optionLabel}>从相册或文件加入</Text>
            {localChosen.map((item) => (
              <View key={item.id} style={styles.localRow}>
                <Text style={styles.localName} numberOfLines={1}>
                  {item.origin} · {item.name}
                </Text>
                <Pressable onPress={() => setChosen((prev) => prev.filter((it) => it.id !== item.id))}>
                  <Text style={styles.remove}>移除</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {Object.keys(statuses).length > 0 ? (
          <View style={styles.localBox}>
            {chosen
              .filter((item) => statuses[item.id])
              .map((item) => (
                <Text key={item.id} style={styles.statusLine} numberOfLines={2}>
                  {item.name}：{statuses[item.id]}
                </Text>
              ))}
          </View>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        <Pressable style={styles.secondaryWide} disabled={busy || chosen.length === 0} onPress={() => void saveAll('original')}>
          <Text style={styles.secondaryText}>保存原图到相册</Text>
        </Pressable>
        <Pressable style={styles.primary} disabled={busy || chosen.length === 0} onPress={() => void saveAll('process')}>
          {running ? <ActivityIndicator color="#F4F7FB" /> : <Text style={styles.primaryText}>处理并保存</Text>}
        </Pressable>
      </View>
      <Modal visible={preview !== null} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <Pressable style={styles.previewBackdrop} onPress={() => setPreview(null)}>
          {preview ? <Image source={{ uri: preview.uri }} style={styles.previewImage} resizeMode="contain" /> : null}
          <Text style={styles.previewHint}>点空白处关闭</Text>
        </Pressable>
      </Modal>
      {cropOpen && sample ? (
        <CropEditor
          uri={sample.uri}
          initial={crop}
          onCancel={() => setCropOpen(false)}
          onConfirm={(next) => {
            setCrop(next);
            setCropOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 16,
  },
  title: {
    color: '#F4F7FB',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 6,
    color: '#9BB0C5',
    fontSize: 14,
    lineHeight: 20,
  },
  searchRow: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 12,
    color: '#F4F7FB',
    backgroundColor: 'rgba(255,255,255,0.08)',
    fontSize: 16,
  },
  searchButton: {
    minWidth: 72,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F6FEB',
  },
  searchText: {
    color: '#F4F7FB',
    fontSize: 16,
    fontWeight: '700',
  },
  scroll: {
    flex: 1,
    marginTop: 8,
  },
  scrollContent: {
    paddingBottom: 12,
    gap: 10,
  },
  optionCard: {
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionLabel: {
    color: '#F4F7FB',
    fontSize: 15,
  },
  optionHint: {
    color: '#9BB0C5',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  secondary: {
    flex: 1,
    minHeight: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  secondaryWide: {
    minHeight: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  secondaryText: {
    color: '#F4F7FB',
    fontSize: 15,
    fontWeight: '600',
  },
  inlineLinks: {
    flexDirection: 'row',
    gap: 12,
  },
  link: {
    color: '#8EB6FF',
    fontSize: 14,
  },
  disabled: {
    opacity: 0.35,
  },
  pageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pageText: {
    color: '#9BB0C5',
    fontSize: 13,
  },
  empty: {
    color: '#9BB0C5',
    fontSize: 14,
    lineHeight: 20,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  cell: {
    width: '33.33%',
    padding: 4,
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  cellOn: {
    borderColor: '#8EB6FF',
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  badge: {
    position: 'absolute',
    left: 6,
    top: 6,
    color: '#F4F7FB',
    backgroundColor: 'rgba(31,111,235,0.9)',
    overflow: 'hidden',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 11,
  },
  localBox: {
    gap: 6,
  },
  localRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  localName: {
    flex: 1,
    color: '#F4F7FB',
    fontSize: 13,
  },
  remove: {
    color: '#FF8B8B',
    fontSize: 13,
  },
  statusLine: {
    color: '#9BB0C5',
    fontSize: 12,
    lineHeight: 18,
  },
  footer: {
    gap: 8,
    paddingTop: 8,
    paddingBottom: 8,
  },
  primary: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F6FEB',
  },
  primaryText: {
    color: '#F4F7FB',
    fontSize: 16,
    fontWeight: '700',
  },
  previewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  previewImage: {
    width: '100%',
    height: '80%',
  },
  previewHint: {
    marginTop: 12,
    color: '#F4F7FB',
    fontSize: 14,
  },
});
