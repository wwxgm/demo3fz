import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from '../modules/video-flip';
import { errorText } from './runtime';
import { useTheme } from './theme';

type MediaLink = {
  href: string;
  label: string;
};

export function SaveLinkScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const { color, palette } = useTheme();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setLabel('正在读取链接');
    const saved: string[] = [];
    try {
      const raw = draft.trim() || VideoFlip.clipboardText();
      const link = findLink(raw);
      if (!link) {
        Alert.alert('没有链接', '先在 Instagram 或 TikTok 里复制视频链接，再点这里。也可以粘到上面的输入框。');
        return;
      }
      setDraft(link);
      const kind = platformOf(link);
      if (!kind) {
        Alert.alert('暂不支持这个链接', '现在只能保存 Instagram 和 TikTok 的公开视频。');
        return;
      }
      const allowed = await ensureAlbumPermission();
      if (!allowed) return;
      setLabel('正在解析');
      const files = kind === 'tiktok' ? await parseTikTok(link) : await parseInstagram(link);
      if (files.length === 0) {
        throw new Error('没有解析到可以保存的视频');
      }
      for (let index = 0; index < files.length; index += 1) {
        setLabel(files.length > 1 ? `正在下载 ${index + 1}/${files.length}` : '正在下载');
        const local = await VideoFlip.downloadFile(files[index], kind === 'tiktok' ? 'https://tiktokio.com/' : 'https://insget.net/');
        saved.push(local);
        setLabel(files.length > 1 ? `正在保存 ${index + 1}/${files.length}` : '正在保存到相册');
        await MediaLibrary.createAssetAsync(local);
      }
      Alert.alert('已保存', files.length > 1 ? `已保存 ${files.length} 个文件到相册。` : '已保存到 iPhone 相册。');
    } catch (error) {
      Alert.alert('没有保存', friendly(errorText(error)));
    } finally {
      saved.forEach((uri) => VideoFlip.removeTempFile(uri));
      setBusy(false);
      setLabel('');
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8, backgroundColor: palette.background }]}>
      <Pressable onPress={onBack} hitSlop={8} disabled={busy}>
        <Text style={[styles.back, { color }]}>返回</Text>
      </Pressable>
      <Text style={[styles.title, { color: palette.text }]}>解析短视频</Text>
      <Text style={[styles.subtitle, { color: palette.muted }]}>
        在 Instagram 或 TikTok 里复制视频链接，回到这里点下面的按钮。Instagram 用 insget.net 解析，TikTok 用 tiktokio.com 解析，然后直接存进相册。只支持公开视频。
      </Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="也可以在这里长按粘贴链接"
        placeholderTextColor={palette.muted}
        style={[styles.input, { color: palette.text, backgroundColor: palette.card, borderColor: palette.line }]}
      />
      <Pressable
        style={[styles.button, { backgroundColor: color, opacity: busy ? 0.7 : 1 }]}
        disabled={busy}
        onPress={() => void save()}
      >
        {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>粘贴并保存到相册</Text>}
      </Pressable>
      {label ? <Text style={[styles.status, { color: palette.muted }]}>{label}</Text> : null}
    </View>
  );
}

async function ensureAlbumPermission() {
  const current = await MediaLibrary.getPermissionsAsync(true);
  const permission = current.granted ? current : await MediaLibrary.requestPermissionsAsync(true);
  if (permission.granted) return true;
  Alert.alert('需要相册权限', '保存视频要允许添加到相册。', [
    { text: '取消', style: 'cancel' },
    { text: '去设置', onPress: () => void Linking.openSettings() },
  ]);
  return false;
}

function findLink(text: string) {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return '';
  return match[0].replace(/[，。；;、,）)]+$/g, '');
}

function platformOf(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'instagr.am' || host.endsWith('.instagr.am') || host.includes('instagram.com')) return 'instagram';
    if (host.includes('tiktok.com')) return 'tiktok';
  } catch {
    return '';
  }
  return '';
}

async function parseInstagram(link: string) {
  const home = await VideoFlip.loadPage('https://insget.net/', 'https://insget.net/');
  const token = /name="_token" value="([^"]+)"/.exec(home)?.[1] || '';
  if (!token) throw new Error('解析站暂时打不开');
  const body = `url=${encodeURIComponent(link)}&_token=${encodeURIComponent(token)}`;
  const text = await VideoFlip.postPage('https://insget.net/fetch', body, 'application/x-www-form-urlencoded', 'https://insget.net/');
  let parsed: { status?: boolean; message?: string; data?: unknown };
  try {
    parsed = JSON.parse(text) as { status?: boolean; message?: string; data?: unknown };
  } catch {
    throw new Error('解析站没有返回结果');
  }
  if (!parsed.status) {
    throw new Error(parsed.message || '这条链接没有解析出来');
  }
  const html = typeof parsed.data === 'string' ? parsed.data : '';
  return chooseInstagram(html);
}

async function parseTikTok(link: string) {
  const body = JSON.stringify({ vid: link, prefix: 'tiktokio.com' });
  const html = await VideoFlip.postPage('https://tiktokio.com/api/v1/tk/html', body, 'application/json', 'https://tiktokio.com/');
  const files = chooseTikTok(html);
  if (files.length === 0) {
    const message = /class="tk-error"[^>]*>([^<]+)/.exec(html)?.[1]?.trim();
    throw new Error(message || '这条链接没有解析出来');
  }
  return files;
}

function chooseTikTok(html: string) {
  const items = anchors(html, 'https://tiktokio.com/').filter((item) => !/mp3/i.test(item.label + item.href));
  const clean = items.filter((item) => /without watermark/i.test(item.label));
  const plain = clean.find((item) => !/\bhd\b/i.test(item.label));
  const chosen = plain || clean[0];
  return chosen ? [chosen.href] : [];
}

function chooseInstagram(html: string) {
  const items = anchors(html, 'https://insget.net/');
  const downloads = items.filter((item) => /download|下载/i.test(`${item.label} ${item.href}`) && !/mp3/i.test(item.label + item.href));
  const picked = (downloads.length > 0 ? downloads : items.filter((item) => isFile(item.href))).slice(0, 8);
  if (picked.length > 0) return unique(picked.map((item) => item.href));
  const sources = [...html.matchAll(/<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
    .map((item) => absolute(decodeHtml(item[1]), 'https://insget.net/'))
    .filter(isFile);
  return unique(sources).slice(0, 8);
}

function anchors(html: string, base: string) {
  const found: MediaLink[] = [];
  const re = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1] || '';
    const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const url = absolute(decodeHtml(href), base);
    if (!keepAnchor(url, label)) continue;
    found.push({ href: url, label });
  }
  return found;
}

function keepAnchor(url: string, label: string) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\.(mp3|m4a)(\?|$)/i.test(url)) return false;
  if (isFile(url)) return true;
  return /^(download|下载)\b/i.test(label) && /download/i.test(url);
}

function isFile(url: string) {
  return /\.(mp4|mov|m4v|jpg|jpeg|png|webp)(\?|$)/i.test(url) || /\/download(\?|$)/i.test(url);
}

function absolute(href: string, base: string) {
  if (!href || href.startsWith('javascript:') || href.startsWith('#')) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function unique(items: string[]) {
  return [...new Set(items)];
}

function friendly(message: string) {
  if (/unable to fetch|paste correct link|0x02/i.test(message)) {
    return '这条链接没有解析出来。请确认复制的是公开视频链接，然后再试一次。';
  }
  if (/没有连上搜索接口/.test(message)) return '没有连上解析站';
  return message;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 16,
  },
  back: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
  },
  subtitle: {
    marginTop: 8,
    marginBottom: 16,
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  button: {
    marginTop: 14,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  status: {
    marginTop: 12,
    fontSize: 14,
  },
});
