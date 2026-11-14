import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import VideoFlip from '../modules/video-flip';
import { errorText } from './runtime';
import { useTheme, type Palette } from './theme';

type HotItem = {
  id: string;
  title: string;
  url: string;
  appUrl?: string;
  hot?: string;
};

type Source = {
  id: string;
  name: string;
};

const SOURCES: Source[] = [
  { id: 'baidu', name: '百度' },
  { id: 'weibo', name: '微博' },
  { id: 'douyin', name: '抖音' },
  { id: 'toutiao', name: '头条' },
  { id: 'bilibili', name: 'B站' },
  { id: 'xai', name: 'X · AI' },
];

const X_FEEDS = [
  'https://rss.xcancel.com/search/rss?f=tweets&q=AI',
  'https://xcancel.com/search/rss?f=tweets&q=AI',
  'https://nitter.poast.org/search/rss?f=tweets&q=AI',
  'https://nitter.privacydev.net/search/rss?f=tweets&q=AI',
];

export function HotScreen({ onBack }: { onBack?: () => void }) {
  const insets = useSafeAreaInsets();
  const { color, palette } = useTheme();
  const styles = useMemo(() => createHotStyles(palette), [palette]);
  const [sourceId, setSourceId] = useState(SOURCES[0].id);
  const [items, setItems] = useState<HotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const requestId = useRef(0);

  const load = useCallback(async (pull: boolean) => {
    const ticket = requestId.current + 1;
    requestId.current = ticket;
    if (pull) setRefreshing(true);
    else setLoading(true);
    setMessage('');
    try {
      const next = await loadSource(sourceId);
      if (ticket !== requestId.current) return;
      setItems(next);
      if (next.length === 0) setMessage('这次没有读到热点');
    } catch (error) {
      if (ticket !== requestId.current) return;
      setItems([]);
      setMessage(errorText(error));
    } finally {
      if (ticket === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [sourceId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const openItem = async (item: HotItem) => {
    if (item.appUrl) {
      try {
        await Linking.openURL(item.appUrl);
        return;
      } catch {
        // 没安装对应应用时，改开网页。
      }
    }
    try {
      await Linking.openURL(item.url);
    } catch {
      Alert.alert('无法打开', '这条热点没有打开，可以稍后再试。');
    }
  };

  const source = SOURCES.find((item) => item.id === sourceId);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={[styles.back, { color }]}>返回</Text>
        </Pressable>
      ) : null}
      <Text style={styles.title}>热点</Text>
      <Text style={styles.subtitle}>
        读取各平台最新热点。点一条会打开对应应用，没安装就用浏览器打开。X 上的 AI 需要能连上 X，开了 VPN 后再刷新。
      </Text>
      <View style={styles.chips}>
        {SOURCES.map((item) => {
          const selected = item.id === sourceId;
          return (
            <Pressable
              key={item.id}
              disabled={loading && !refreshing}
              style={[styles.chip, selected && { backgroundColor: color }]}
              onPress={() => setSourceId(item.id)}
            >
              <Text style={[styles.chipText, selected && styles.chipTextOn]}>{item.name}</Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={color} />}
      >
        <View style={styles.statusRow}>
          <Text style={styles.hint}>{source ? source.name : '热点'} · 下拉重新读取</Text>
          <Pressable onPress={() => void load(true)} hitSlop={8} disabled={loading || refreshing}>
            <Text style={[styles.refresh, { color }]}>刷新</Text>
          </Pressable>
        </View>
        {loading && !refreshing ? (
          <ActivityIndicator color={color} style={styles.spinner} />
        ) : message && items.length === 0 ? (
          <Text style={styles.empty}>{message}</Text>
        ) : (
          items.map((item, index) => (
            <Pressable key={item.id} style={styles.row} onPress={() => void openItem(item)}>
              <Text style={[styles.rank, index < 3 && { color }]}>{index + 1}</Text>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>{item.title}</Text>
                {item.hot ? <Text style={styles.rowHot}>热度 {item.hot}</Text> : null}
              </View>
              <Text style={[styles.open, { color }]}>打开</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

async function loadSource(id: string) {
  switch (id) {
    case 'baidu':
      return loadBaidu();
    case 'weibo':
      return loadWeibo();
    case 'douyin':
      return loadDouyin();
    case 'toutiao':
      return loadToutiao();
    case 'bilibili':
      return loadBilibili();
    case 'xai':
      return loadXai();
    default:
      return [];
  }
}

async function readText(url: string, referer: string) {
  try {
    return await VideoFlip.loadPage(url, referer);
  } catch (error) {
    throw new Error(errorText(error));
  }
}

async function readJson(url: string, referer: string) {
  const text = await readText(url, referer);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('榜单内容无法识别');
  }
}

async function loadBaidu() {
  const data = await readJson('https://top.baidu.com/api/board?platform=wise&tab=realtime', 'https://top.baidu.com/');
  const found: { title: string; url: string }[] = [];
  walkWords(data, found);
  return unique(found).slice(0, 30).map((item, index) => ({
    id: `baidu-${index}-${item.title}`,
    title: item.title,
    url: item.url,
    appUrl: `baiduboxapp://v1/browser/open?url=${encodeURIComponent(item.url)}`,
  }));
}

async function loadWeibo() {
  const data = await readJson('https://weibo.com/ajax/side/hotSearch', 'https://weibo.com/');
  const realtime = asRecord(asRecord(data).data).realtime;
  if (!Array.isArray(realtime)) throw new Error('微博没有返回热点');
  const items: HotItem[] = [];
  realtime.forEach((row, index) => {
    const item = asRecord(row);
    if (item.is_ad === 1 || item.is_ad === true) return;
    const title = textOf(item.word || item.note);
    if (!title) return;
    const web = `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`;
    items.push({
      id: `weibo-${index}-${title}`,
      title,
      url: web,
      appUrl: `sinaweibo://searchall?q=${encodeURIComponent(title)}`,
      hot: hotText(item.num),
    });
  });
  return items.slice(0, 30);
}

async function loadDouyin() {
  const data = await readJson('https://www.douyin.com/aweme/v1/web/hot/search/list/', 'https://www.douyin.com/');
  const words = asRecord(asRecord(data).data).word_list;
  if (!Array.isArray(words)) throw new Error('抖音没有返回热点');
  return words.slice(0, 30).flatMap((row, index) => {
    const item = asRecord(row);
    const title = textOf(item.word);
    if (!title) return [];
    const web = `https://www.douyin.com/search/${encodeURIComponent(title)}`;
    return [{
      id: `douyin-${index}-${title}`,
      title,
      url: web,
      appUrl: `snssdk1128://search/tabs?keyword=${encodeURIComponent(title)}`,
      hot: hotText(item.hot_value),
    }];
  });
}

async function loadToutiao() {
  const data = await readJson('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', 'https://www.toutiao.com/');
  const rows = asRecord(data).data;
  if (!Array.isArray(rows)) throw new Error('头条没有返回热点');
  return rows.slice(0, 30).flatMap((row, index) => {
    const item = asRecord(row);
    const title = textOf(item.Title);
    const url = textOf(item.Url);
    if (!title || !url.startsWith('http')) return [];
    const group = url.match(/trending\/(\d+)/)?.[1] ?? '';
    return [{
      id: `toutiao-${index}-${title}`,
      title,
      url,
      appUrl: group ? `snssdk141://detail?groupid=${encodeURIComponent(group)}` : undefined,
      hot: hotText(item.HotValue),
    }];
  });
}

async function loadBilibili() {
  const data = await readJson('https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1', 'https://www.bilibili.com/');
  const rows = asRecord(asRecord(data).data).list;
  if (!Array.isArray(rows)) throw new Error('B站没有返回热点');
  return rows.slice(0, 30).flatMap((row, index) => {
    const item = asRecord(row);
    const title = textOf(item.title);
    const bvid = textOf(item.bvid);
    if (!title || !bvid) return [];
    const stat = asRecord(item.stat);
    return [{
      id: `bili-${bvid}`,
      title,
      url: `https://www.bilibili.com/video/${bvid}`,
      appUrl: `bilibili://video/${bvid}`,
      hot: hotText(stat.view),
    }];
  });
}

async function loadXai() {
  let last = '没有连上 X。打开 VPN 后再点刷新。';
  for (const feed of X_FEEDS) {
    try {
      const xml = await withTimeout(readText(feed, 'https://x.com/'), 12000);
      const items = parseXFeed(xml.slice(0, 500_000));
      if (items.length > 0) return items.slice(0, 30);
    } catch (error) {
      last = errorText(error);
    }
  }
  throw new Error(last.includes('没有连上') || last.includes('超时') ? '没有连上 X。打开 VPN 后再点刷新。' : last);
}

function withTimeout<T>(work: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读取超时')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('读取超时'));
      },
    );
  });
}

function parseXFeed(xml: string) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const items: HotItem[] = [];
  blocks.forEach((block, index) => {
    const title = decodeXml(tagText(block, 'title'));
    const link = decodeXml(tagText(block, 'link') || tagText(block, 'guid'));
    const status = link.match(/status\/(\d+)/);
    if (!title || !status) return;
    const id = status[1];
    items.push({
      id: `x-${id}-${index}`,
      title,
      url: `https://x.com/i/status/${id}`,
      appUrl: `twitter://status?id=${id}`,
    });
  });
  return items;
}

function tagText(block: string, tag: string) {
  const matched = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!matched) return '';
  const raw = matched[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : raw).trim();
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function walkWords(node: unknown, out: { title: string; url: string }[]) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => walkWords(item, out));
    return;
  }
  const record = node as Record<string, unknown>;
  const title = textOf(record.word);
  const url = textOf(record.url);
  if (title && url.startsWith('http')) out.push({ title, url });
  Object.values(record).forEach((value) => walkWords(value, out));
}

function unique(items: { title: string; url: string }[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function hotText(value: unknown) {
  const raw = textOf(value).replace(/,/g, '');
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return '';
  if (number >= 10000) {
    const wan = number / 10000;
    return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)}万`;
  }
  return String(Math.round(number));
}

function createHotStyles(palette: Palette) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      paddingHorizontal: 20,
    },
    back: {
      fontSize: 16,
      fontWeight: '600',
      marginBottom: 8,
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
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 14,
    },
    chip: {
      minHeight: 32,
      paddingHorizontal: 12,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.field,
    },
    chipText: {
      color: palette.text,
      fontSize: 14,
      fontWeight: '700',
    },
    chipTextOn: {
      color: '#FFFFFF',
    },
    list: {
      flex: 1,
      marginTop: 12,
    },
    listContent: {
      gap: 10,
      paddingBottom: 16,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    hint: {
      flex: 1,
      color: palette.muted,
      fontSize: 13,
    },
    refresh: {
      fontSize: 14,
      fontWeight: '700',
    },
    spinner: {
      marginTop: 28,
    },
    empty: {
      marginTop: 18,
      color: palette.muted,
      fontSize: 14,
      lineHeight: 20,
    },
    row: {
      minHeight: 64,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: palette.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.line,
    },
    rank: {
      width: 24,
      color: palette.muted,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
    },
    rowBody: {
      flex: 1,
      gap: 4,
    },
    rowTitle: {
      color: palette.text,
      fontSize: 15,
      fontWeight: '700',
      lineHeight: 21,
    },
    rowHot: {
      color: palette.muted,
      fontSize: 12,
    },
    open: {
      fontSize: 14,
      fontWeight: '700',
    },
  });
}
