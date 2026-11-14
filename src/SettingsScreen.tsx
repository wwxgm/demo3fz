import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlbumShareScreen } from './AlbumShareScreen';
import { HotScreen } from './HotScreen';
import VideoFlip from '../modules/video-flip';
import { themeColors, useTheme, type Appearance } from './theme';

type Page = 'menu' | 'music' | 'footage' | 'look' | 'urls' | 'library' | 'hot';

type Material = {
  title: string;
  search: string;
  detail: string;
  url: string;
};

const MUSIC: Material[] = [
  {
    title: '轻快卡点',
    search: '轻快卡点',
    detail: '适合排行榜一条条翻页。鼓点短，节奏清楚，字出来的时候正好踩拍。',
    url: 'https://mixkit.co/free-stock-music/tag/upbeat/',
  },
  {
    title: '悬疑推进',
    search: '悬疑鼓点',
    detail: '适合从第 5 名推到第 1 名。低音往前走，名字出现时有一点紧张感。',
    url: 'https://mixkit.co/free-stock-music/tag/cinematic/',
  },
  {
    title: '温暖钢琴',
    search: '温暖钢琴',
    detail: '适合慢一点的介绍。钢琴为主，不抢旁白。',
    url: 'https://mixkit.co/free-stock-music/mood/inspiring/',
  },
  {
    title: '热血电子',
    search: '热血电子',
    detail: '适合快节奏榜单。电子鼓和合成器，画面可以配慢慢放大的背景。',
    url: 'https://mixkit.co/free-stock-music/tag/hip-hop/',
  },
  {
    title: '口播底乐',
    search: '口播清新',
    detail: '适合有字幕解说的视频。音量低，说话时还能听清人声。',
    url: 'https://mixkit.co/free-stock-music/tag/ambient/',
  },
];

const FOOTAGE: Material[] = [
  {
    title: '城市夜景',
    search: '城市夜景',
    detail: '竖屏街灯和车流，适合深色大字。下载后到大字报里选为背景。',
    url: 'https://mixkit.co/free-stock-video/city/',
  },
  {
    title: '美食特写',
    search: '美食特写',
    detail: '汉堡、炸鸡、饮品的近景，适合吃播排行榜。',
    url: 'https://mixkit.co/free-stock-video/food/',
  },
  {
    title: '光斑粒子',
    search: '粒子光斑',
    detail: '暗底上的光点，字不容易和画面抢。适合标题和名次。',
    url: 'https://mixkit.co/free-stock-video/light/',
  },
  {
    title: '自然空镜',
    search: '自然空镜',
    detail: '天、水、树的慢镜头。文案长的时候适合放慢并铺满。',
    url: 'https://mixkit.co/free-stock-video/nature/',
  },
  {
    title: '抽象渐变',
    search: '抽象渐变',
    detail: '颜色慢慢流动的底。没有具体物体，字最清楚。',
    url: 'https://mixkit.co/free-stock-video/abstract/',
  },
];

const URL_KEY = 'batchUrls';

function storageGet() {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      return localStorage.getItem(URL_KEY) ?? '';
    }
    const raw = Settings.get(URL_KEY);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

function storageSet(value: string) {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    localStorage.setItem(URL_KEY, value);
    return;
  }
  Settings.set({ [URL_KEY]: value });
}

function readUrls() {
  try {
    const raw = storageGet();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 200);
  } catch {
    return [];
  }
}

function writeUrls(urls: string[]) {
  storageSet(JSON.stringify(urls));
}

function tidyUrl(raw: string) {
  return raw.trim().replace(/^[<【（("']+/, '').replace(/[>】）)"'，。；;、,]+$/g, '');
}

function normalizeUrl(raw: string) {
  let text = tidyUrl(raw);
  if (!text || /\s/.test(text)) return null;
  if (!/^https?:\/\//i.test(text)) {
    if (/^www\./i.test(text) || /^[a-z0-9.-]+\.[a-z]{2,}([/?#]|$)/i.test(text)) {
      text = `https://${text}`;
    } else {
      return null;
    }
  }
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function extractUrls(text: string) {
  const found: string[] = [];
  const withScheme = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const item of withScheme) {
    const url = normalizeUrl(item);
    if (url) found.push(url);
  }
  for (const line of text.split(/\s+/)) {
    if (/https?:\/\//i.test(line)) continue;
    const url = normalizeUrl(line);
    if (url) found.push(url);
  }
  return [...new Set(found)];
}

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { color, setColor, appearance, setAppearance, palette } = useTheme();
  const [clearing, setClearing] = useState(false);
  const [page, setPage] = useState<Page>('menu');
  const [opened, setOpened] = useState<Material | null>(null);
  const [urls, setUrls] = useState<string[]>(() => readUrls());
  const [draft, setDraft] = useState('');

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

  const openLink = (url: string) => {
    void Linking.openURL(url).catch(() => {
      Alert.alert('无法打开', '这个页面没有打开，可以稍后再试。');
    });
  };

  const importUrls = () => {
    const incoming = extractUrls(draft);
    if (incoming.length === 0) {
      Alert.alert('没有网址', '没有识别到网址。一行一条，或以 http://、https:// 开头。');
      return;
    }
    const existed = new Set(urls);
    const room = 200 - urls.length;
    if (room <= 0) {
      Alert.alert('已经很多了', '最多保存 200 条。可以先清空再导入。');
      return;
    }
    const fresh = incoming.filter((item) => !existed.has(item));
    const added = fresh.slice(0, room);
    const skipped = incoming.length - fresh.length;
    const overflow = fresh.length - added.length;
    if (added.length === 0) {
      Alert.alert('都已保存', '这些网址之前已经在列表里。');
      return;
    }
    const next = [...urls, ...added];
    try {
      writeUrls(next);
    } catch {
      Alert.alert('没有保存', '这次没能写进手机，请再试一次。');
      return;
    }
    setUrls(next);
    setDraft('');
    const extra = [
      skipped > 0 ? `${skipped} 条已经在列表里` : '',
      overflow > 0 ? `超出 200 条的没有加入` : '',
    ].filter(Boolean);
    Alert.alert('已保存', extra.length > 0 ? `新增 ${added.length} 条，${extra.join('，')}。下次打开还能看到。` : `新增 ${added.length} 条。下次打开还能看到。`);
  };

  const clearUrls = () => {
    if (urls.length === 0) {
      Alert.alert('没有网址', '当前没有已保存的网址。');
      return;
    }
    Alert.alert('清空网址', `要删掉已保存的 ${urls.length} 条网址吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          try {
            writeUrls([]);
          } catch {
            Alert.alert('没有清空', '这次没能改掉已保存的网址，请再试一次。');
            return;
          }
          setUrls([]);
        },
      },
    ]);
  };

  if (opened) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => setOpened(null)}
          hitSlop={8}
        >
          <Text style={[styles.back, { color }]}>返回</Text>
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{opened.title}</Text>
        <Text style={[styles.subtitle, { color: palette.muted }]}>在剪映里可以搜「{opened.search}」。</Text>
        <ScrollView contentContainerStyle={styles.list}>
          <View style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}>
            <Text style={[styles.detail, { color: palette.text }]}>{opened.detail}</Text>
          </View>
          <Pressable
            style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
            onPress={() => openLink(opened.url)}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: palette.text }]}>打开免费素材</Text>
              <Text style={[styles.rowHint, { color: palette.muted }]}>浏览器里试听或下载，再回到相册或文件里选用。</Text>
            </View>
            <Text style={[styles.chevron, { color }]}>打开</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  if (page === 'music' || page === 'footage') {
    const items = page === 'music' ? MUSIC : FOOTAGE;
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => setPage('menu')} hitSlop={8}>
          <Text style={[styles.back, { color }]}>返回</Text>
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{page === 'music' ? '剪映背景音乐' : '剪映背景素材'}</Text>
        <Text style={[styles.subtitle, { color: palette.muted }]}>
          {page === 'music'
            ? '这些是和剪映里常见风格一样、可以免费使用的音乐。点进去看说明。'
            : '这些是可以免费使用的背景画面。下载后到大字报里选为背景。'}
        </Text>
        <ScrollView contentContainerStyle={styles.list}>
          {items.map((item) => (
            <Pressable
              key={item.title}
              style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
              onPress={() => setOpened(item)}
            >
              <View style={styles.rowBody}>
                <Text style={[styles.rowTitle, { color: palette.text }]}>{item.title}</Text>
                <Text style={[styles.rowHint, { color: palette.muted }]}>剪映搜索：{item.search}</Text>
              </View>
              <Text style={[styles.chevron, { color }]}>进入</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    );
  }

  if (page === 'menu') {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.title, { color: palette.text }]}>设置</Text>
        <Text style={[styles.subtitle, { color: palette.muted }]}>点进去查看素材、网址、相册和热点。</Text>
        <ScrollView contentContainerStyle={styles.list}>
          <Pressable
            style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
            onPress={() => setPage('music')}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: palette.text }]}>剪映背景音乐</Text>
              <Text style={[styles.rowHint, { color: palette.muted }]}>卡点、钢琴、口播底乐</Text>
            </View>
            <Text style={[styles.chevron, { color }]}>进入</Text>
          </Pressable>
          <Pressable
            style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
            onPress={() => setPage('footage')}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: palette.text }]}>剪映背景素材</Text>
              <Text style={[styles.rowHint, { color: palette.muted }]}>夜景、美食、光斑、空镜</Text>
            </View>
            <Text style={[styles.chevron, { color }]}>进入</Text>
          </Pressable>
          <Pressable
            style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
            onPress={() => setPage('urls')}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: palette.text }]}>查看网址</Text>
              <Text style={[styles.rowHint, { color: palette.muted }]}>
                {urls.length > 0 ? `已保存 ${urls.length} 条，点开用 Safari 打开` : '批量粘贴网址，点开用 Safari 打开'}
              </Text>
            </View>
            <Text style={[styles.chevron, { color }]}>进入</Text>
          </Pressable>
          <Pressable
            style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
            onPress={() => setPage('hot')}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: palette.text }]}>热点</Text>
              <Text style={[styles.rowHint, { color: palette.muted }]}>百度、微博、抖音、头条、B站、X</Text>
            </View>
            <Text style={[styles.chevron, { color }]}>进入</Text>
          </Pressable>
          <Pressable
            style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
            onPress={() => setPage('library')}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: palette.text }]}>相册分享</Text>
              <Text style={[styles.rowHint, { color: palette.muted }]}>读取相册，滑动多选后分享到夸克</Text>
            </View>
            <Text style={[styles.chevron, { color }]}>进入</Text>
          </Pressable>
          <Pressable
            style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}
            onPress={() => setPage('look')}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: palette.text }]}>外观和缓存</Text>
              <Text style={[styles.rowHint, { color: palette.muted }]}>夜间、白天、主题色、清除临时文件</Text>
            </View>
            <Text style={[styles.chevron, { color }]}>进入</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  if (page === 'library') {
    return <AlbumShareScreen onBack={() => setPage('menu')} />;
  }

  if (page === 'hot') {
    return <HotScreen onBack={() => setPage('menu')} />;
  }

  if (page === 'urls') {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => setPage('menu')} hitSlop={8}>
          <Text style={[styles.back, { color }]}>返回</Text>
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>查看网址</Text>
        <Text style={[styles.subtitle, { color: palette.muted }]}>
          一次粘贴很多条，一行一条。点一条会离开应用，用 Safari 打开。清空前会一直留着，下次打开还能看到。
        </Text>
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          <View style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}>
            <View style={styles.themeBlock}>
              <Text style={[styles.rowTitle, { color: palette.text }]}>批量导入</Text>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                multiline
                placeholder={'https://example.com/a\nhttps://example.com/b'}
                placeholderTextColor={palette.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.paste, { backgroundColor: palette.field, color: palette.text }]}
              />
              <View style={styles.modes}>
                <Pressable style={[styles.mode, { backgroundColor: color }]} onPress={importUrls}>
                  <Text style={[styles.modeText, { color: '#FFFFFF' }]}>导入</Text>
                </Pressable>
                <Pressable style={[styles.mode, { backgroundColor: palette.field }]} onPress={clearUrls}>
                  <Text style={[styles.modeText, { color: palette.text }]}>清空</Text>
                </Pressable>
              </View>
            </View>
          </View>
          {urls.length === 0 ? (
            <View style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line }]}>
              <Text style={[styles.detail, { color: palette.muted }]}>还没有网址。</Text>
            </View>
          ) : (
            urls.map((item, index) => (
              <Pressable
                key={`${item}-${index}`}
                style={[styles.row, { backgroundColor: palette.card, borderColor: palette.line, alignItems: 'flex-start' }]}
                onPress={() => openLink(item)}
              >
                <View style={styles.rowBody}>
                  <Text style={[styles.rowTitle, { color: palette.text }]}>{index + 1}</Text>
                  <Text style={[styles.urlText, { color: palette.muted }]}>{item}</Text>
                </View>
                <Text style={[styles.chevron, { color }]}>打开</Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => setPage('menu')} hitSlop={8}>
        <Text style={[styles.back, { color }]}>返回</Text>
      </Pressable>
      <Text style={[styles.title, { color: palette.text }]}>外观和缓存</Text>
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
  back: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 8,
  },
  detail: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
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
  paste: {
    minHeight: 108,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: 'top',
  },
  urlText: {
    fontSize: 13,
    lineHeight: 18,
  },
});
