import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
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

type SaveJob = {
  url: string;
  body?: string;
};

type KukuMedia = {
  url?: string;
  size?: number;
  video_fullinfo?: { url?: string; size?: number }[];
};

type KukuData = {
  url?: string;
  cover?: string;
  videos?: KukuMedia[] | string[];
  pics?: string[];
};

type RowPhase = 'ready' | 'parse' | 'download' | 'flip' | 'save' | 'done' | 'error';

type Row = {
  id: string;
  link: string;
  progress: number;
  message: string;
  phase: RowPhase;
};

const MAX_LINKS = 20;

export function SaveLinkScreen({ onBack }: { onBack?: () => void }) {
  const insets = useSafeAreaInsets();
  const { color, palette } = useTheme();
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [flipOn, setFlipOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const timer = setInterval(() => {
      setRows((prev) => {
        let changed = false;
        const next = prev.map((row) => {
          if (row.phase !== 'download' && row.phase !== 'flip') return row;
          let value = row.progress;
          try {
            value = row.phase === 'download' ? VideoFlip.downloadProgress(row.id) : VideoFlip.flipProgress(row.id);
          } catch {
            return row;
          }
          if (!Number.isFinite(value)) return row;
          const progress = Math.min(Math.max(value, 0), 0.99);
          if (Math.abs(progress - row.progress) < 0.01) return row;
          changed = true;
          return { ...row, progress };
        });
        return changed ? next : prev;
      });
    }, 400);
    return () => clearInterval(timer);
  }, []);

  const patch = (id: string, next: Partial<Row>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...next } : row)));
  };

  const addLink = (raw: string, fromClipboard: boolean) => {
    if (busy) return;
    const link = findLink(raw);
    if (!link) {
      Alert.alert(
        fromClipboard ? '没有读到链接' : '没有链接',
        fromClipboard
          ? '先复制一条公开视频链接。如果手机问是否允许粘贴，点允许后再点一次。'
          : '在输入框里输入或贴上一条公开视频链接，再点加入。',
      );
      return;
    }
    if (!platformOf(link)) {
        Alert.alert('暂不支持这个链接', '请粘贴公开的视频链接。');
      return;
    }
    if (seen.current.has(link)) {
      Alert.alert('已经在列表里', '这条链接和已有的完全一样，没有重复加入。');
      return;
    }
    if (seen.current.size >= MAX_LINKS) {
      Alert.alert('已经满了', `一次最多 ${MAX_LINKS} 条。先保存或删掉几条再加。`);
      return;
    }
    seen.current.add(link);
    setRows((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${prev.length}-${Math.random().toString(16).slice(2)}`,
        link,
        progress: 0,
        message: '等待保存',
        phase: 'ready',
      },
    ]);
    if (!fromClipboard) setDraft('');
  };

  const paste = () => addLink(VideoFlip.clipboardText(), true);

  const removeRow = (row: Row) => {
    if (busy) return;
    seen.current.delete(row.link);
    setRows((prev) => prev.filter((item) => item.id !== row.id));
  };

  const save = async () => {
    if (busy) return;
    const pending = rows.filter((row) => row.phase === 'ready' || row.phase === 'error');
    if (pending.length === 0) {
      Alert.alert('没有要保存的链接', '先点粘贴或 + 把链接加到列表里，再点保存。');
      return;
    }
    const allowed = await ensureAlbumPermission();
    if (!allowed) return;
    setBusy(true);
    const ids = new Set(pending.map((row) => row.id));
    setRows((prev) =>
      prev.map((row) => (ids.has(row.id) ? { ...row, phase: 'parse', message: '等待下载', progress: 0.02 } : row)),
    );
    let chain = Promise.resolve();
    const flipOne = (local: string, id: string) => {
      const task = chain.then(async () => {
        patch(id, { phase: 'flip', message: '正在翻转', progress: 0 });
        return VideoFlip.flipHorizontal(local, { jobId: id });
      });
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };
    const queue = [...pending];
    let ok = 0;
    let failed = 0;
    const worker = async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) return;
        const locals: string[] = [];
        let usedFlip = false;
        try {
          const kind = platformOf(row.link);
          if (!kind) throw new Error('请粘贴公开的视频链接');
          patch(row.id, { phase: 'parse', message: '正在解析', progress: 0.04 });
          const files = await parseLink(kind, row.link);
          if (files.length === 0) throw new Error('没有解析到可以保存的视频');
          for (let index = 0; index < files.length; index += 1) {
            const job = files[index];
            const referer = refererFor(kind, row.link);
            patch(row.id, {
              phase: 'download',
              message: files.length > 1 ? `正在下载 ${index + 1}/${files.length}` : '正在下载',
              progress: 0,
            });
            const local = job.body
              ? await VideoFlip.downloadPosted(job.url, job.body, 'application/x-www-form-urlencoded', referer, row.id)
              : await VideoFlip.downloadFile(job.url, referer, row.id);
            locals.push(local);
            let output = local;
            if (flipOn && !isStillImage(local)) {
              patch(row.id, { phase: 'flip', message: '等待翻转', progress: 0 });
              output = await flipOne(local, row.id);
              usedFlip = true;
              if (output !== local) locals.push(output);
            }
            patch(row.id, {
              phase: 'save',
              message: files.length > 1 ? `正在保存 ${index + 1}/${files.length}` : '正在保存到相册',
              progress: 0.98,
            });
            await MediaLibrary.createAssetAsync(output);
          }
          ok += 1;
          patch(row.id, {
            phase: 'done',
            message: usedFlip ? '已翻转并保存到相册' : '已保存到相册',
            progress: 1,
          });
        } catch (error) {
          failed += 1;
          patch(row.id, { phase: 'error', message: friendly(errorText(error)), progress: 0 });
        } finally {
          locals.forEach((uri) => VideoFlip.removeTempFile(uri));
        }
      }
    };
    try {
      if (flipOn) VideoFlip.prepareFlipBatch();
      const width = Math.min(3, queue.length);
      await Promise.all(Array.from({ length: width }, () => worker()));
      if (failed === 0) {
        Alert.alert('已保存', ok > 1 ? `已保存 ${ok} 条到 iPhone 相册。` : '已保存到 iPhone 相册。');
      } else if (ok === 0) {
        Alert.alert('没有保存', '这几条都没有保存成功，看每条下面的说明。');
      } else {
        Alert.alert('保存了一部分', `成功 ${ok} 条，失败 ${failed} 条。失败的可以再点保存。`);
      }
    } catch (error) {
      const message = friendly(errorText(error));
      setRows((prev) =>
        prev.map((row) =>
          ids.has(row.id) && row.phase !== 'done' && row.phase !== 'error'
            ? { ...row, phase: 'error', message, progress: 0 }
            : row,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8, backgroundColor: palette.background }]}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={8} disabled={busy}>
          <Text style={[styles.back, { color }]}>返回</Text>
        </Pressable>
      ) : null}
      <Text style={[styles.title, { color: palette.text }]}>解析短视频</Text>
      <Text style={[styles.subtitle, { color: palette.muted }]}>
        支持抖音、快手、视频号、Threads、X，以及 Instagram、TikTok 的公开视频。复制一条后点「粘贴」，再加下一条就点「+」。相同链接会自动去掉。点「保存」才会下载到相册。
      </Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="也可以在这里输入一条链接"
        placeholderTextColor={palette.muted}
        style={[styles.input, { color: palette.text, backgroundColor: palette.card, borderColor: palette.line }]}
      />
      <View style={styles.actions}>
        <Pressable style={[styles.small, { backgroundColor: color, opacity: busy ? 0.6 : 1 }]} disabled={busy} onPress={paste}>
          <Text style={styles.buttonText}>粘贴</Text>
        </Pressable>
        <Pressable
          style={[styles.plus, { borderColor: color, opacity: busy ? 0.6 : 1 }]}
          disabled={busy}
          onPress={paste}
        >
          <Text style={[styles.plusText, { color }]}>+</Text>
        </Pressable>
        <Pressable
          style={[styles.small, styles.plain, { borderColor: palette.line, opacity: busy ? 0.6 : 1 }]}
          disabled={busy}
          onPress={() => addLink(draft, false)}
        >
          <Text style={[styles.plainText, { color: palette.text }]}>加入</Text>
        </Pressable>
      </View>
      <Pressable style={styles.checkRow} disabled={busy} onPress={() => setFlipOn((value) => !value)}>
        <View style={[styles.box, { borderColor: color }, flipOn && { backgroundColor: color }]}>
          {flipOn ? <Text style={styles.tick}>✓</Text> : null}
        </View>
        <Text style={[styles.checkText, { color: palette.text }]}>批量翻转</Text>
        <Text style={[styles.checkHint, { color: palette.muted }]}>保存时自动翻转后再进相册</Text>
      </Pressable>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
        {rows.length === 0 ? (
          <Text style={[styles.empty, { color: palette.muted }]}>还没有链接。点粘贴加入一条，点 + 再加入下一条。</Text>
        ) : (
          rows.map((row, index) => (
            <View key={row.id} style={[styles.card, { backgroundColor: palette.card, borderColor: palette.line }]}>
              <View style={styles.cardTop}>
                <Text style={[styles.index, { color }]}>{index + 1}</Text>
                <Text style={[styles.link, { color: palette.text }]} numberOfLines={2}>
                  {row.link}
                </Text>
                {row.phase === 'ready' || row.phase === 'error' || row.phase === 'done' ? (
                  <Pressable hitSlop={8} disabled={busy} onPress={() => removeRow(row)}>
                    <Text style={[styles.remove, { color: palette.muted }]}>删除</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={[styles.track, { backgroundColor: palette.line }]}>
                <View style={[styles.fill, { width: `${Math.round(row.progress * 100)}%`, backgroundColor: color }]} />
              </View>
              <Text style={[styles.status, { color: row.phase === 'error' ? '#C2410C' : palette.muted }]} numberOfLines={2}>
                {row.message}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
      <Pressable
        style={[styles.button, { backgroundColor: color, opacity: busy ? 0.7 : 1 }]}
        disabled={busy}
        onPress={() => void save()}
      >
        {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>保存</Text>}
      </Pressable>
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
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
    if (host === 'threads.net' || host.endsWith('.threads.net') || host === 'threads.com' || host.endsWith('.threads.com')) return 'threads';
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com') || host === 't.co') return 'twitter';
    return 'kuku';
  } catch {
    return '';
  }
}

function refererFor(kind: string, link: string) {
  if (kind === 'tiktok') return 'https://tiktokio.com/';
  if (kind === 'instagram') return 'https://insget.net/';
  if (kind === 'threads') return 'https://threadster.app/';
  if (kind === 'twitter') return 'https://savetwitter.net/';
  return link;
}

async function parseLink(kind: string, link: string) {
  if (kind === 'tiktok') return parseTikTok(link);
  if (kind === 'instagram') return parseInstagram(link);
  if (kind === 'threads') return parseThreads(link);
  if (kind === 'twitter') return parseTwitter(link);
  return parseKuku(link);
}

async function parseKuku(link: string) {
  await VideoFlip.loadPage('https://dy.kukutool.com/', 'https://dy.kukutool.com/');
  const authText = await VideoFlip.postPage(
    'https://dy.kukutool.com/api/auth-970b03',
    JSON.stringify({ requestURL: link, pagePath: '/', mode: 'single' }),
    'application/json',
    'https://dy.kukutool.com/',
  );
  let auth: Record<string, string>;
  try {
    auth = JSON.parse(authText) as Record<string, string>;
  } catch {
    throw new Error('解析站暂时打不开');
  }
  const authKey = auth.k_970b03 || '';
  const authSeed = auth.s_970b03 || '';
  if (!authKey || !authSeed) throw new Error(auth.message || '解析站暂时打不开');
  const sealed = VideoFlip.sealKuku(JSON.stringify({
    requestURL: link,
    captchaKey: '',
    captchaInput: '',
    totalSuccessCount: '0',
    successCount: '0',
    firstSuccessDate: '',
    pagePath: '/',
    isMobile: 'true',
    confirmPurchased: false,
    qualityTier: 'hd',
    country_code: 'CN',
  }), authKey, authSeed);
  const text = await VideoFlip.postPage(
    'https://dy.kukutool.com/api/parse',
    JSON.stringify({
      version: 3,
      k_970b03: authKey,
      p_970b03: sealed.payload,
      i_970b03: sealed.iv,
      r_970b03: 1,
    }),
    'application/json',
    'https://dy.kukutool.com/',
  );
  let parsed: { status?: number; message?: string; encrypt?: boolean; iv?: string; data?: unknown };
  try {
    parsed = JSON.parse(text) as { status?: number; message?: string; encrypt?: boolean; iv?: string; data?: unknown };
  } catch {
    throw new Error('解析站没有返回结果');
  }
  if (parsed.encrypt && typeof parsed.data === 'string') {
    parsed.data = JSON.parse(VideoFlip.openKuku(parsed.data, parsed.iv || ''));
  }
  if (parsed.status !== 0 || !parsed.data || typeof parsed.data !== 'object') {
    throw new Error(parsed.message || '这条链接没有解析出来');
  }
  const jobs = chooseKuku(parsed.data as KukuData);
  if (jobs.length === 0) throw new Error(parsed.message || '没有解析到可以保存的视频');
  return jobs;
}

function chooseKuku(data: KukuData): SaveJob[] {
  const videos: string[] = [];
  for (const item of data.videos || []) {
    if (typeof item === 'string') {
      videos.push(item);
      continue;
    }
    const ranked = (item.video_fullinfo || []).filter((info) => typeof info.url === 'string' && info.url.startsWith('http'));
    ranked.sort((left, right) => Number(right.size || 0) - Number(left.size || 0));
    if (ranked[0]?.url) videos.push(ranked[0].url);
    else if (item.url && item.url.startsWith('http')) videos.push(item.url);
  }
  if (videos.length === 0 && data.url && data.url.startsWith('http')) videos.push(data.url);
  const files = unique(videos).slice(0, 3).map((url) => ({ url }));
  if (files.length > 0) return files;
  const raw = unique((data.pics || []).filter((url) => url.startsWith('http')));
  const images = raw.filter((url) => url !== data.cover);
  return (images.length > 0 ? images : raw).slice(0, 8).map((url) => ({ url }));
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
  const files = chooseTikTok(html).map((url) => ({ url }));
  if (files.length === 0) {
    const message = /class="tk-error"[^>]*>([^<]+)/.exec(html)?.[1]?.trim();
    throw new Error(message || '这条链接没有解析出来');
  }
  return files;
}

async function parseThreads(link: string) {
  await VideoFlip.loadPage('https://threadster.app/', 'https://threadster.app/');
  const html = await VideoFlip.postPage(
    'https://threadster.app/download',
    `url=${encodeURIComponent(link)}`,
    'application/x-www-form-urlencoded',
    'https://threadster.app/',
  );
  const jobs = chooseThreads(html);
  if (jobs.length === 0) {
    throw new Error(/couldn.?t find any videos|not__found/i.test(html) ? '这条帖子里没有可以保存的视频' : '这条链接没有解析出来');
  }
  return jobs;
}

function chooseThreads(html: string): SaveJob[] {
  const items = anchors(html, 'https://threadster.app/').filter((item) => /download__item__download_btn/i.test(item.label));
  const videos = items.filter((item) => /\/video(?:[/?]|$)/i.test(item.href) || /\.mp4(?:\?|$)/i.test(item.href));
  const picked = videos.length > 0 ? videos : items.filter((item) => !/mp3/i.test(`${item.href} ${item.label}`));
  return unique(picked.map((item) => item.href)).slice(0, 8).map((url) => ({ url }));
}

async function parseTwitter(link: string) {
  const text = await VideoFlip.postPage(
    'https://savetwitter.net/api/ajaxSearch',
    `q=${encodeURIComponent(link)}&lang=en&cftoken=`,
    'application/x-www-form-urlencoded',
    'https://savetwitter.net/en4',
  );
  let parsed: { status?: string; msg?: string; data?: unknown };
  try {
    parsed = JSON.parse(text) as { status?: string; msg?: string; data?: unknown };
  } catch {
    throw new Error('解析站没有返回结果');
  }
  const html = typeof parsed.data === 'string' ? parsed.data : '';
  const jobs = parsed.status === 'ok' && !parsed.msg ? chooseTwitter(html) : [];
  if (jobs.length === 0) throw new Error(twitterMessage(parsed.msg || ''));
  return jobs;
}

function chooseTwitter(html: string): SaveJob[] {
  const items = anchors(html, 'https://savetwitter.net/').filter((item) => !isSiteHome(item.href));
  const videos = items.filter((item) => /download mp4/i.test(item.label) && !/mp3/i.test(item.label));
  if (videos.length > 0) {
    const ranked = [...videos].sort((left, right) => qualityOf(right.label) - qualityOf(left.label));
    return [{ url: ranked[0].href }];
  }
  const photos = items.filter((item) => /download photo/i.test(item.label));
  return unique(photos.map((item) => item.href)).slice(0, 8).map((url) => ({ url }));
}

function qualityOf(label: string) {
  const match = /(\d+)\s*p/i.exec(label);
  return match ? Number(match[1]) : 0;
}

function twitterMessage(msg: string) {
  if (/private|blocked|not found|no data/i.test(msg)) return '这条视频是私密的，或已经删掉了';
  if (/too quickly|429/i.test(msg)) return '点得太快了，过一会儿再保存';
  if (/wrong link|invalid/i.test(msg)) return '请粘贴公开的视频链接';
  return '这条链接没有解析出来';
}

function chooseTikTok(html: string) {
  const items = anchors(html, 'https://tiktokio.com/').filter((item) => !/mp3/i.test(item.label + item.href));
  const clean = items.filter((item) => /without watermark/i.test(item.label));
  const plain = clean.find((item) => !/\bhd\b/i.test(item.label));
  const chosen = plain || clean[0];
  return chosen ? [chosen.href] : [];
}

function chooseInstagram(html: string): SaveJob[] {
  const jobs = instagramForms(html);
  if (jobs.length > 0) return jobs.slice(0, 8);
  const items = anchors(html, 'https://insget.net/').filter((item) => isFile(item.href) && !isShareLink(item.href));
  return unique(items.map((item) => item.href)).slice(0, 8).map((url) => ({ url }));
}

function instagramForms(html: string): SaveJob[] {
  const jobs: SaveJob[] = [];
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = absolute(decodeHtml(/action\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1] || ''), 'https://insget.net/');
    const inner = match[2];
    if (!/data-ftype="video"/i.test(inner)) continue;
    const token = /name="_token" value="([^"]*)"/.exec(inner)?.[1] || '';
    const username = /name="username" value="([^"]*)"/.exec(inner)?.[1] || '';
    const option = /<option value="([^"]*)"/.exec(inner)?.[1] || '';
    if (!action || !token || !option) continue;
    jobs.push({
      url: action,
      body: encodeForm({ _token: token, action_type: 'download', username, url: option }),
    });
  }
  return jobs;
}

function encodeForm(fields: Record<string, string>) {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function anchors(html: string, base: string) {
  const found: MediaLink[] = [];
  const re = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const attrs = match[1];
    const href = /(?:href|data-href|data-url|data-link)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || '';
    const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const url = absolute(decodeHtml(href), base);
    if (!keepAnchor(url)) continue;
    found.push({ href: url, label: `${label} ${attrs}` });
  }
  return found;
}

function mediaSources(html: string, base: string) {
  return [...html.matchAll(/<(?:video|source)\b[^>]*>/gi)].flatMap((tag) => {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1] || '';
    const url = absolute(decodeHtml(src), base);
    return keepAnchor(url) ? [url] : [];
  });
}

function keepAnchor(url: string) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\.(mp3|m4a)(\?|$)/i.test(url)) return false;
  return true;
}

function isSiteHome(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' || parsed.pathname === '';
  } catch {
    return false;
  }
}

function isShareLink(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('facebook.com') || host.includes('twitter.com') || host === 'x.com' || host.includes('t.me');
  } catch {
    return false;
  }
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

function isStillImage(uri: string) {
  return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(uri.split('?')[0]);
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
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 10,
  },
  small: {
    minWidth: 72,
    minHeight: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  plus: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: {
    fontSize: 26,
    fontWeight: '700',
    lineHeight: 28,
  },
  plain: {
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'transparent',
  },
  plainText: {
    fontSize: 16,
    fontWeight: '800',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    gap: 8,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tick: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  checkText: {
    fontSize: 15,
    fontWeight: '700',
  },
  checkHint: {
    flex: 1,
    fontSize: 12,
  },
  list: {
    flex: 1,
    marginTop: 12,
  },
  listContent: {
    paddingBottom: 8,
    gap: 10,
  },
  empty: {
    fontSize: 14,
    lineHeight: 20,
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  index: {
    fontSize: 15,
    fontWeight: '800',
  },
  link: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  remove: {
    fontSize: 13,
    fontWeight: '700',
  },
  track: {
    height: 6,
    borderRadius: 3,
    marginTop: 10,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
    borderRadius: 3,
  },
  button: {
    marginTop: 8,
    marginBottom: 8,
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
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
  },
});
