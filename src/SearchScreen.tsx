import { useMemo, useRef, useState } from 'react';
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
import { useTheme, type Palette } from './theme';

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

type Engine = 'baidu' | 'google' | 'bing' | 'sogou';

const ENGINES: Array<{ id: Engine; label: string }> = [
  { id: 'baidu', label: '百度图片' },
  { id: 'google', label: '谷歌图片' },
  { id: 'bing', label: '必应图片' },
  { id: 'sogou', label: '搜狗图片' },
];

const BROWSER_HEADERS = {
  Accept: 'application/json,text/plain,text/html,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

function decodeText(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');
}

function httpsUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice('http://'.length)}`;
  return '';
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

async function readSite(url: string, referer: string) {
  let response: Response;
  try {
    response = await fetch(url, { headers: { ...BROWSER_HEADERS, Referer: referer } });
  } catch (error) {
    throw new Error(`没有连上接口\n${url}\n${errorText(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`接口返回 HTTP ${response.status}\n${url}\n${text.slice(0, 500)}`);
  }
  return text;
}

function pageCountFor(count: number, page: number, reported?: number) {
  if (reported && reported > 0) return Math.min(20, Math.max(page, Math.ceil(reported / 30)));
  return count >= 30 ? page + 1 : page;
}

function pushImage(images: WorkImage[], item: Omit<WorkImage, 'origin'>) {
  if (!item.uri.startsWith('https://') && !item.previewUri.startsWith('https://')) return;
  images.push({ ...item, origin: '搜索', uri: item.uri || item.previewUri, previewUri: item.previewUri || item.uri });
}

async function searchBaidu(query: string, page: number) {
  const word = encodeURIComponent(query);
  const offset = (page - 1) * 30;
  const url =
    `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&fp=result` +
    `&queryWord=${word}&word=${word}&cl=2&lm=-1&ie=utf-8&oe=utf-8&pn=${offset}&rn=30`;
  const text = await readSite(url, 'https://image.baidu.com/');
  let data: { displayNum?: number; listNum?: number; data?: unknown };
  try {
    data = JSON.parse(text) as { displayNum?: number; listNum?: number; data?: unknown };
  } catch {
    throw new Error(`百度没有返回图片数据\n${url}\n${text.slice(0, 500)}`);
  }
  const rows = Array.isArray(data.data) ? data.data : [];
  const images: WorkImage[] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const item = row as Record<string, unknown>;
    const preview = httpsUrl(item.thumbURL) || httpsUrl(item.middleURL) || httpsUrl(item.hoverURL);
    const full = httpsUrl(item.objURL) || httpsUrl(item.middleURL) || preview;
    const title = typeof item.fromPageTitleEnc === 'string' ? decodeText(item.fromPageTitleEnc) : '百度图片';
    pushImage(images, {
      id: `baidu-${page}-${index}`,
      uri: full,
      previewUri: preview || full,
      name: title || '百度图片',
      width: asNumber(item.width),
      height: asNumber(item.height),
    });
  });
  if (images.length === 0) {
    throw new Error(`百度这次没有解析出图片\n${url}\n${text.slice(0, 500)}`);
  }
  return { images, pageCount: pageCountFor(images.length, page, Number(data.displayNum || data.listNum || 0)) };
}

async function searchBing(query: string, page: number) {
  const first = (page - 1) * 30 + 1;
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(query)}&first=${first}&count=30&mmasync=1`;
  const text = await readSite(url, 'https://www.bing.com/images/');
  const images: WorkImage[] = [];
  const matches = text.matchAll(/m="([^"]+)"/g);
  let index = 0;
  for (const match of matches) {
    try {
      const item = JSON.parse(decodeText(match[1])) as { murl?: string; turl?: string; t?: string };
      const full = httpsUrl(item.murl);
      const preview = httpsUrl(item.turl) || full;
      if (!full && !preview) continue;
      pushImage(images, {
        id: `bing-${page}-${index}`,
        uri: full || preview,
        previewUri: preview || full,
        name: item.t || '必应图片',
      });
      index += 1;
    } catch {
      continue;
    }
  }
  if (images.length === 0) {
    throw new Error(`必应没有解析出图片\n${url}\n${text.slice(0, 500)}`);
  }
  return { images, pageCount: pageCountFor(images.length, page) };
}

async function searchSogou(query: string, page: number) {
  const start = (page - 1) * 30;
  const url = `https://pic.sogou.com/napi/pc/searchList?mode=1&start=${start}&xml_len=30&query=${encodeURIComponent(query)}`;
  const text = await readSite(url, 'https://pic.sogou.com/');
  let data: { data?: { items?: unknown; totalNum?: number } };
  try {
    data = JSON.parse(text) as { data?: { items?: unknown; totalNum?: number } };
  } catch {
    throw new Error(`搜狗没有返回图片数据\n${url}\n${text.slice(0, 500)}`);
  }
  const rows = Array.isArray(data.data?.items) ? data.data?.items : [];
  const images: WorkImage[] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const item = row as Record<string, unknown>;
    const full = httpsUrl(item.picUrl) || httpsUrl(item.locImageLink);
    const preview = httpsUrl(item.thumbUrl) || full;
    const title = typeof item.title === 'string' ? decodeText(item.title) : '搜狗图片';
    pushImage(images, {
      id: `sogou-${page}-${index}`,
      uri: full || preview,
      previewUri: preview || full,
      name: title || '搜狗图片',
      width: asNumber(item.width),
      height: asNumber(item.height),
    });
  });
  if (images.length === 0) {
    throw new Error(`搜狗这次没有解析出图片\n${url}\n${text.slice(0, 500)}`);
  }
  return { images, pageCount: pageCountFor(images.length, page, Number(data.data?.totalNum || 0)) };
}

async function searchGoogle(query: string, page: number) {
  const start = (page - 1) * 30;
  const url = `https://www.google.com/search?tbm=isch&hl=zh-CN&q=${encodeURIComponent(query)}&ijn=${page - 1}&start=${start}`;
  const text = await readSite(url, 'https://www.google.com/');
  const originals = [...text.matchAll(/"ou":"(https?:[^"]+)"/g)].map((item) => httpsUrl(decodeText(item[1])));
  const thumbs = [...text.matchAll(/"(https:\/\/encrypted-tbn0\.gstatic\.com\/images\?[^"]+)"/g)].map((item) =>
    httpsUrl(decodeText(item[1])),
  );
  const images: WorkImage[] = [];
  const count = Math.max(originals.length, thumbs.length);
  for (let index = 0; index < count && images.length < 30; index += 1) {
    const full = originals[index] || thumbs[index] || '';
    const preview = thumbs[index] || full;
    pushImage(images, {
      id: `google-${page}-${index}`,
      uri: full || preview,
      previewUri: preview || full,
      name: '谷歌图片',
    });
  }
  if (images.length === 0) {
    throw new Error(`谷歌没有返回图片。手机直接请求经常会被谷歌拦住。\n${url}\n${text.slice(0, 500)}`);
  }
  return { images, pageCount: pageCountFor(images.length, page) };
}

async function searchImages(engine: Engine, query: string, page: number) {
  if (engine === 'baidu') return searchBaidu(query, page);
  if (engine === 'bing') return searchBing(query, page);
  if (engine === 'sogou') return searchSogou(query, page);
  return searchGoogle(query, page);
}

export function SearchScreen() {
  const insets = useSafeAreaInsets();
  const { color: accent, palette } = useTheme();
  const styles = useMemo(() => createSearchStyles(palette, accent), [palette, accent]);
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState<Engine>('baidu');
  const [logs, setLogs] = useState<string[]>([]);
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

  const addLog = (line: string) => {
    const now = new Date();
    const clock = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
    setLogs((prev) => [...prev, `${clock}  ${line}`].slice(-80));
  };

  const runSearch = async (nextPage: number) => {
    const keyword = query.trim();
    const current = ENGINES.find((item) => item.id === engine);
    if (!keyword) {
      Alert.alert('请输入关键词');
      return;
    }
    setLoading(true);
    setMessage('');
    addLog(`开始用${current?.label ?? '百度图片'}搜索「${keyword}」，第 ${nextPage} 页`);
    try {
      const found = await searchImages(engine, keyword, nextPage);
      setResults(found.images);
      setPage(nextPage);
      setPageCount(found.pageCount);
      if (nextPage === 1) {
        setChosen((prev) => prev.filter((item) => item.origin !== '搜索'));
      }
      addLog(`返回 ${found.images.length} 张图片`);
      if (found.images.length === 0) setMessage('没有找到图片');
    } catch (error) {
      const detail = errorText(error);
      addLog(detail);
      setMessage('搜索失败，详情在错误日志里');
      Alert.alert('搜索失败', '接口没有返回可用图片，错误日志可以滚动查看。');
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
      <Text style={styles.subtitle}>默认搜索百度图片。单击选择，双击预览。</Text>
      <View style={styles.engineRow}>
        {ENGINES.map((item) => (
          <Pressable
            key={item.id}
            disabled={busy}
            style={[styles.engineChip, engine === item.id && styles.engineChipOn, engine === item.id && { backgroundColor: accent }]}
            onPress={() => setEngine(item.id)}
          >
            <Text style={[styles.engineText, engine === item.id && styles.onAccentText]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.searchRow}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="关键词"
          placeholderTextColor={palette.placeholder}
          style={styles.input}
          returnKeyType="search"
          onSubmitEditing={() => void runSearch(1)}
        />
        <Pressable style={[styles.searchButton, { backgroundColor: accent }]} disabled={busy} onPress={() => void runSearch(1)}>
          {loading ? <ActivityIndicator color="#F4F7FB" /> : <Text style={styles.searchText}>搜索</Text>}
        </Pressable>
      </View>
      {logs.length > 0 ? (
        <View style={styles.logBox}>
          <View style={styles.logHead}>
            <Text style={styles.optionLabel}>错误日志</Text>
            <Pressable onPress={() => setLogs([])} hitSlop={8}>
              <Text style={styles.link}>清空</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.logScroll} nestedScrollEnabled>
            {logs.map((line, index) => (
              <Text key={`${index}-${line.slice(0, 12)}`} style={styles.logLine}>
                {line}
              </Text>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.optionCard}>
          <View style={styles.optionRow}>
            <Text style={styles.optionLabel}>批量</Text>
            <Switch
              value={batch}
              onValueChange={setBatch}
              trackColor={{ false: palette.switchOff, true: accent }}
            />
          </View>
          <View style={styles.optionRow}>
            <Text style={styles.optionLabel}>水平翻转</Text>
            <Switch
              value={flip}
              onValueChange={setFlip}
              trackColor={{ false: palette.switchOff, true: accent }}
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
        <Pressable style={[styles.primary, { backgroundColor: accent }]} disabled={busy || chosen.length === 0} onPress={() => void saveAll('process')}>
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

function createSearchStyles(palette: Palette, accent: string) {
  return StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 16,
  },
  title: {
    color: palette.text,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 6,
    color: palette.muted,
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
    color: palette.text,
    backgroundColor: palette.field,
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
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  engineRow: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  engineChip: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.field,
  },
  engineChipOn: {
    backgroundColor: '#1F6FEB',
  },
  onAccentText: {
    color: '#FFFFFF',
  },
  engineText: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '700',
  },
  logBox: {
    marginTop: 10,
    borderRadius: 12,
    padding: 10,
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    gap: 8,
  },
  logHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logScroll: {
    maxHeight: 180,
  },
  logLine: {
    color: '#F0D0A8',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 8,
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
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
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
    color: palette.text,
    fontSize: 15,
  },
  optionHint: {
    color: palette.muted,
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
    backgroundColor: palette.field,
  },
  secondaryWide: {
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
  inlineLinks: {
    flexDirection: 'row',
    gap: 12,
  },
  link: {
    color: accent,
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
    color: palette.muted,
    fontSize: 13,
  },
  empty: {
    color: palette.muted,
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
    backgroundColor: palette.card,
  },
  cellOn: {
    borderColor: accent,
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  badge: {
    position: 'absolute',
    left: 6,
    top: 6,
    color: palette.text,
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
    color: palette.text,
    fontSize: 13,
  },
  remove: {
    color: '#FF8B8B',
    fontSize: 13,
  },
  statusLine: {
    color: palette.muted,
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
    color: '#FFFFFF',
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
}
