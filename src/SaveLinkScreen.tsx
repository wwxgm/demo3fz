import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
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
import VideoFlip, { LinkPasteButton } from '../modules/video-flip';
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
  duration?: number;
  phase: RowPhase;
  preview: string;
};

const MAX_LINKS = 20;
const CONCURRENCY = 3;

export function SaveLinkScreen({ onBack }: { onBack?: () => void }) {
  const insets = useSafeAreaInsets();
  const { color, palette } = useTheme();
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [flipOn, setFlipOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState('');
  const seen = useRef(new Set<string>());
  const flipOnRef = useRef(flipOn);
  const runningRef = useRef(false);
  const heldRef = useRef(false);
  const savingLock = useRef(false);
  const queueRef = useRef<Row[]>([]);
  const queuedIds = useRef(new Set<string>());
  const workersRef = useRef(0);
  const okRef = useRef(0);
  const failedRef = useRef(0);
  const flipChain = useRef(Promise.resolve());
  const rowsRef = useRef(rows);
  const dropped = useRef(new Set<string>());
  const previewRef = useRef(new Map<string, string>());
  const resumeOnActive = useRef(false);
  const interruptedRef = useRef(new Set<string>());
  const startRowsRef = useRef<(ids: string[]) => Promise<void>>(async () => {});
  const pumpRef = useRef<() => void>(() => {});
  flipOnRef.current = flipOn;
  rowsRef.current = rows;

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
    const link = findLink(raw);
    if (!link) {
      Alert.alert(
        fromClipboard ? '没有读到链接' : '没有链接',
        fromClipboard
          ? '先复制公开视频链接。多条时一行一条。'
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
        preview: '',
      },
    ]);
    if (!fromClipboard) setDraft('');
  };

  const addFromClipboard = (raw: string, multiple: boolean) => {
    const links = findLinks(raw);
    const picked = multiple ? links : links.slice(0, 1);
    if (!multiple) {
      addLink(picked[0] || '', true);
      return;
    }
    if (picked.length === 0) {
      Alert.alert('没有读到链接', '先复制公开视频链接。多条时一行一条。');
      return;
    }
    const accepted: Row[] = [];
    let duplicate = 0;
    let unsupported = 0;
    let overflow = 0;
    for (const link of picked) {
      if (!platformOf(link)) {
        unsupported += 1;
        continue;
      }
      if (seen.current.has(link)) {
        duplicate += 1;
        continue;
      }
      if (seen.current.size >= MAX_LINKS) {
        overflow += 1;
        continue;
      }
      seen.current.add(link);
      accepted.push({
        id: `${Date.now()}-${accepted.length}-${Math.random().toString(16).slice(2)}`,
        link,
        progress: 0,
        message: '等待保存',
        phase: 'ready',
        preview: '',
      });
    }
    if (accepted.length > 0) {
      setRows((prev) => [...prev, ...accepted]);
    }
    if (accepted.length === 0 && duplicate > 0 && unsupported === 0 && overflow === 0) {
      Alert.alert('已经在列表里', '这些链接和已有的完全一样，没有重复加入。');
      return;
    }
    if (accepted.length === 0 && overflow > 0) {
      Alert.alert('已经满了', `一次最多 ${MAX_LINKS} 条。先保存或删掉几条再加。`);
      return;
    }
    if (accepted.length === 0) {
      Alert.alert('没有读到链接', '没有找到可以加入的公开视频链接。多条时一行一条。');
      return;
    }
    if (duplicate > 0 || unsupported > 0 || overflow > 0) {
      const notes = [
        duplicate > 0 ? `重复 ${duplicate} 条` : '',
        unsupported > 0 ? `不支持 ${unsupported} 条` : '',
        overflow > 0 ? `超出 ${overflow} 条` : '',
      ].filter(Boolean);
      Alert.alert('已加入一部分', `加入 ${accepted.length} 条。${notes.join('，')}。`);
    }
  };

  const pasteText = (event: { nativeEvent?: { text?: string }; text?: string }, multiple: boolean) => {
    addFromClipboard(event.nativeEvent?.text ?? event.text ?? '', multiple);
  };

  const rememberPreview = (id: string, uri: string) => {
    const previous = previewRef.current.get(id) || '';
    if (previous.startsWith('file:') && previous !== uri) VideoFlip.removeTempFile(previous);
    previewRef.current.set(id, uri);
    patch(id, { preview: uri });
  };

  const dropPreview = (id: string) => {
    const preview = previewRef.current.get(id) || '';
    if (preview.startsWith('file:')) VideoFlip.removeTempFile(preview);
    previewRef.current.delete(id);
  };

  const clearList = () => {
    if (rowsRef.current.length === 0) {
      Alert.alert('列表是空的', '还没有链接可以清空。');
      return;
    }
    const runningNow = () => {
      const running = new Set(queuedIds.current);
      queueRef.current.forEach((item) => running.delete(item.id));
      return running;
    };
    const drop = () => {
      const running = runningNow();
      queueRef.current = [];
      const next = rowsRef.current.filter((row) => running.has(row.id));
      rowsRef.current.forEach((row) => {
        if (running.has(row.id)) return;
        queuedIds.current.delete(row.id);
        dropped.current.add(row.id);
        dropPreview(row.id);
        VideoFlip.cancelDownload(row.id);
        VideoFlip.cancelFlip(row.id);
      });
      seen.current.clear();
      next.forEach((row) => seen.current.add(row.link));
      setRows(next);
    };
    const kept = rowsRef.current.filter((row) => runningNow().has(row.id)).length;
    Alert.alert(
      '清空列表',
      kept > 0 ? `正在处理的 ${kept} 条会留着，其余都会去掉。去掉之后可以重新粘贴。` : '列表里的链接都会去掉，之后可以重新粘贴。',
      [
        { text: '取消', style: 'cancel' },
        { text: '清空', style: 'destructive', onPress: drop },
      ],
    );
  };

  const removeRow = (row: Row) => {
    dropped.current.add(row.id);
    queuedIds.current.delete(row.id);
    queueRef.current = queueRef.current.filter((item) => item.id !== row.id);
    seen.current.delete(row.link);
    dropPreview(row.id);
    VideoFlip.cancelDownload(row.id);
    VideoFlip.cancelFlip(row.id);
    setRows((prev) => prev.filter((item) => item.id !== row.id));
  };

  const copyRow = (row: Row) => {
    VideoFlip.copyText(row.link);
    setCopiedId(row.id);
    setTimeout(() => {
      setCopiedId((current) => (current === row.id ? '' : current));
    }, 1200);
  };

  const finishIfIdle = () => {
    if (workersRef.current > 0 || queueRef.current.length > 0 || !runningRef.current) return;
    const ok = okRef.current;
    const failed = failedRef.current;
    if (resumeOnActive.current && failed > 0) {
      failedRef.current = 0;
      return;
    }
    runningRef.current = false;
    if (heldRef.current) {
      heldRef.current = false;
      VideoFlip.releaseBackground();
    }
    setBusy(false);
    okRef.current = 0;
    failedRef.current = 0;
    if (ok === 0 && failed === 0) return;
    if (failed === 0) {
      Alert.alert('已保存', ok > 1 ? `已保存 ${ok} 条到 iPhone 相册。` : '已保存到 iPhone 相册。');
    } else if (ok === 0) {
      Alert.alert('没有保存', '这几条都没有保存成功，看每条下面的说明。');
    } else {
      Alert.alert('保存了一部分', `成功 ${ok} 条，失败 ${failed} 条。失败的可以单独点重试。`);
    }
  };

  const runRow = async (row: Row) => {
    const locals: string[] = [];
    let usedFlip = false;
    try {
      const kind = platformOf(row.link);
      if (!kind) throw new Error('请粘贴公开的视频链接');
      patch(row.id, { phase: 'parse', message: '正在解析', progress: 0.04 });
      const parsed = await parseLink(kind, row.link);
      if (dropped.current.has(row.id)) return;
      if (parsed.cover) rememberPreview(row.id, parsed.cover);
      const files = parsed.jobs;
      if (files.length === 0) throw new Error('没有解析到可以保存的视频');
      for (let index = 0; index < files.length; index += 1) {
        if (dropped.current.has(row.id)) return;
        const job = files[index];
        const referer = refererFor(kind, row.link);
        patch(row.id, {
          phase: 'download',
          message: files.length > 1 ? `正在下载 ${index + 1}/${files.length}` : '正在下载',
          progress: 0,
        });
        const local = await fetchSavedFile(job, referer, row.id);
        if (dropped.current.has(row.id)) {
          VideoFlip.removeTempFile(local);
          return;
        }
        locals.push(local);
        if (isStillImage(local)) {
          rememberPreview(row.id, local);
        } else {
          try {
            const frame = await VideoFlip.frameAt(local, 0.15);
            if (dropped.current.has(row.id)) {
              VideoFlip.removeTempFile(frame);
              return;
            }
            rememberPreview(row.id, frame);
          } catch {
            // 抽不到画面时继续用封面。
          }
          try {
            const seconds = await VideoFlip.mediaDuration(local);
            if (!dropped.current.has(row.id) && seconds > 0) patch(row.id, { duration: seconds });
          } catch {
            // 读不到时长时卡片上就不显示这一项。
          }
        }
        let output = local;
        if (flipOnRef.current && !isStillImage(local)) {
          patch(row.id, { phase: 'flip', message: '等待翻转', progress: 0 });
          const task = flipChain.current.then(async () => {
            if (dropped.current.has(row.id)) throw new Error('已删除');
            patch(row.id, { phase: 'flip', message: '正在翻转', progress: 0 });
            return VideoFlip.flipHorizontal(local, { jobId: row.id });
          });
          flipChain.current = task.then(
            () => undefined,
            () => undefined,
          );
          output = await task;
          if (dropped.current.has(row.id)) return;
          usedFlip = true;
          if (output !== local) locals.push(output);
          try {
            const frame = await VideoFlip.frameAt(output, 0.15);
            if (!dropped.current.has(row.id)) rememberPreview(row.id, frame);
            else VideoFlip.removeTempFile(frame);
          } catch {
            // 翻转后的画面抽不出来时，保留下载时的画面。
          }
        }
        if (dropped.current.has(row.id)) return;
        patch(row.id, {
          phase: 'save',
          message: files.length > 1 ? `正在保存 ${index + 1}/${files.length}` : '正在保存到相册',
          progress: 0.98,
        });
        await MediaLibrary.createAssetAsync(output);
      }
      okRef.current += 1;
      patch(row.id, {
        phase: 'done',
        message: usedFlip ? '已翻转并保存到相册' : '已保存到相册',
        progress: 1,
      });
    } catch (error) {
      if (dropped.current.has(row.id)) return;
      failedRef.current += 1;
      if (resumeOnActive.current) interruptedRef.current.add(row.id);
      patch(row.id, {
        phase: 'error',
        message: resumeOnActive.current ? '切走后中断了，回到后会继续' : friendly(errorText(error)),
        progress: 0,
      });
    } finally {
      queuedIds.current.delete(row.id);
      const keep = previewRef.current.get(row.id) || '';
      locals.forEach((uri) => {
        if (uri !== keep) VideoFlip.removeTempFile(uri);
      });
    }
  };

  const pump = () => {
    while (workersRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const row = queueRef.current.shift();
      if (!row) break;
      workersRef.current += 1;
      void runRow(row).finally(() => {
        workersRef.current -= 1;
        pump();
        finishIfIdle();
      });
    }
  };

  const startRows = async (ids: string[]) => {
    while (savingLock.current) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const pending = rowsRef.current.filter(
      (row) => ids.includes(row.id) && (row.phase === 'ready' || row.phase === 'error' || interruptedRef.current.has(row.id)) && !queuedIds.current.has(row.id),
    );
    if (pending.length === 0) return;
    pending.forEach((row) => {
      dropped.current.delete(row.id);
      queuedIds.current.add(row.id);
    });
    savingLock.current = true;
    try {
      const allowed = await ensureAlbumPermission();
      if (!allowed) {
        pending.forEach((row) => queuedIds.current.delete(row.id));
        return;
      }
      const still = pending.filter((row) => queuedIds.current.has(row.id));
      if (still.length === 0) return;
      still.forEach((row) => interruptedRef.current.delete(row.id));
      if (!runningRef.current) {
        VideoFlip.holdBackground();
        heldRef.current = true;
        try {
          VideoFlip.prepareFlipBatch();
        } catch (error) {
          still.forEach((row) => queuedIds.current.delete(row.id));
          heldRef.current = false;
          VideoFlip.releaseBackground();
          const message = friendly(errorText(error));
          const ids = new Set(still.map((row) => row.id));
          setRows((prev) => prev.map((row) => (ids.has(row.id) ? { ...row, phase: 'error', message, progress: 0 } : row)));
          return;
        }
      }
      const ids = new Set(still.map((row) => row.id));
      setRows((prev) =>
        prev.map((row) => (ids.has(row.id) ? { ...row, phase: 'parse', message: '等待下载', progress: 0.02 } : row)),
      );
      queueRef.current.push(...still);
      runningRef.current = true;
      setBusy(true);
      pump();
    } finally {
      savingLock.current = false;
    }
  };

  const save = () => {
    const pending = rows.filter((row) => (row.phase === 'ready' || row.phase === 'error') && !queuedIds.current.has(row.id));
    if (pending.length === 0) {
      Alert.alert('没有要保存的链接', runningRef.current ? '新链接点粘贴或 + 加到列表后，再点保存。失败的可以点这一条上的重试。' : '先点粘贴或 + 把链接加到列表里，再点保存。');
      return;
    }
    void startRows(pending.map((row) => row.id));
  };

  const retry = (row: Row) => {
    void startRows([row.id]);
  };

  startRowsRef.current = startRows;
  pumpRef.current = pump;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'inactive' || next === 'background') {
        if (runningRef.current || workersRef.current > 0 || queueRef.current.length > 0) {
          resumeOnActive.current = true;
        }
        return;
      }
      if (next !== 'active' || !resumeOnActive.current) return;
      if (timer) clearTimeout(timer);
      tries = 0;
      const tick = () => {
        tries += 1;
        if (queueRef.current.length > 0 && workersRef.current < CONCURRENCY) {
          runningRef.current = true;
          pumpRef.current();
        }
        const busy = workersRef.current > 0 || queueRef.current.length > 0;
        const failedIds = rowsRef.current
          .filter((row) => (row.phase === 'error' || interruptedRef.current.has(row.id)) && row.phase !== 'done' && !queuedIds.current.has(row.id))
          .map((row) => row.id);
        if (failedIds.length > 0 && !busy) {
          resumeOnActive.current = false;
          void startRowsRef.current(failedIds);
          return;
        }
        if (!busy && failedIds.length === 0) {
          if (tries < 3) {
            timer = setTimeout(tick, 400);
            return;
          }
          resumeOnActive.current = false;
          return;
        }
        if (tries < 8) {
          timer = setTimeout(tick, 400);
          return;
        }
        resumeOnActive.current = false;
        if (failedIds.length > 0) void startRowsRef.current(failedIds);
      };
      timer = setTimeout(tick, 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, []);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8, backgroundColor: palette.background }]}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={8} disabled={busy}>
          <Text style={[styles.back, { color }]}>返回</Text>
        </Pressable>
      ) : null}
      <Text style={[styles.title, { color: palette.text }]}>video</Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="也可以在这里输入一条链接"
        placeholderTextColor={palette.muted}
        style={[styles.input, { color: palette.text, backgroundColor: palette.card, borderColor: palette.line }]}
      />
      <View style={styles.actions}>
        <LinkPasteButton icon={false} background={color} foreground="#FFFFFF" onPaste={(event) => pasteText(event, true)} style={styles.pasteWide} />
        <LinkPasteButton icon background={color} foreground="#FFFFFF" onPaste={(event) => pasteText(event, true)} style={styles.pastePlus} />
        <Pressable style={[styles.small, styles.plain, { borderColor: palette.line }]} onPress={() => addLink(draft, false)}>
          <Text style={[styles.plainText, { color: palette.text }]}>加入</Text>
        </Pressable>
      </View>
      <Pressable style={styles.checkRow} onPress={() => setFlipOn((value) => !value)}>
        <View style={[styles.box, { borderColor: color }, flipOn && { backgroundColor: color }]}>
          {flipOn ? <Text style={styles.tick}>✓</Text> : null}
        </View>
        <Text style={[styles.checkText, { color: palette.text }]}>批量翻转</Text>
        <Text style={[styles.checkHint, { color: palette.muted }]}>保存时自动翻转后再进相册</Text>
      </Pressable>
      <View style={styles.listHead}>
        <Text style={[styles.listCount, { color: palette.muted }]}>
          {rows.length === 0 ? '链接列表' : `链接列表 ${rows.length}`}
        </Text>
        <Pressable onPress={clearList} hitSlop={8}>
          <Text style={[styles.clearText, { color: rows.length === 0 ? palette.line : '#C2410C' }]}>清空列表</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
        {rows.length === 0 ? (
          <Text style={[styles.empty, { color: palette.muted }]}>还没有链接。点「粘贴」或 + 可一次加入多行，一行一条。</Text>
        ) : (
          rows.map((row, index) => (
            <View key={row.id} style={[styles.card, { backgroundColor: palette.card, borderColor: palette.line }]}>
              <Pressable style={styles.cardHit} onPress={() => removeRow(row)}>
                <RowPreview row={row} line={palette.line} muted={palette.muted} />
                <View style={styles.cardBody}>
                  <View style={styles.cardTop}>
                    <Text style={[styles.index, { color }]}>{index + 1}</Text>
                    <Pressable style={styles.linkHit} onPress={() => void openInApp(row.link)}>
                      <Text style={[styles.link, styles.linkOpen, { color: palette.text }]} numberOfLines={2}>
                        {row.link}
                      </Text>
                    </Pressable>
                  </View>
                  <View style={[styles.track, { backgroundColor: palette.line }]}>
                    <View style={[styles.fill, { width: `${Math.round(row.progress * 100)}%`, backgroundColor: color }]} />
                  </View>
                  {row.duration ? (
                    <Text style={[styles.status, { color: palette.text }]}>时长 {formatClock(row.duration)}</Text>
                  ) : null}
                  <Text style={[styles.status, { color: row.phase === 'error' ? '#C2410C' : palette.muted }]} numberOfLines={2}>
                    {row.message}
                  </Text>
                </View>
              </Pressable>
              <View style={styles.rowActions}>
                <Pressable hitSlop={8} onPress={() => copyRow(row)}>
                  <Text style={[styles.remove, { color }]}>{copiedId === row.id ? '已复制' : '复制'}</Text>
                </Pressable>
                {row.phase === 'error' ? (
                  <Pressable hitSlop={8} onPress={() => retry(row)}>
                    <Text style={[styles.remove, { color }]}>重试</Text>
                  </Pressable>
                ) : null}
                <Pressable hitSlop={8} onPress={() => removeRow(row)}>
                  <Text style={[styles.remove, { color: palette.muted }]}>删除</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </ScrollView>
      <Pressable style={[styles.button, { backgroundColor: color }]} onPress={() => void save()}>
        <Text style={styles.buttonText}>保存</Text>
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

function formatClock(seconds?: number) {
  if (!seconds || seconds <= 0) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function findLinks(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const found: string[] = [];
  for (const line of lines.length > 0 ? lines : [text]) {
    const link = findLink(line);
    if (link && !found.includes(link)) found.push(link);
  }
  return found;
}

function findLink(text: string) {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return '';
  return match[0]
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef].*$/g, '')
    .replace(/[，。；;、,）)\]】》>"']+$/g, '');
}

async function openInApp(link: string) {
  const native = nativePlayUrl(link);
  if (native) {
    try {
      if (await Linking.canOpenURL(native)) {
        await Linking.openURL(native);
        return;
      }
    } catch {
      // 没有装对应 App 时，改开原来的链接。
    }
  }
  try {
    await Linking.openURL(link);
  } catch {
    Alert.alert('没有打开', '这条链接没能打开对应的 App。');
  }
}

function nativePlayUrl(link: string) {
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    if (host.includes('douyin.com') || host.includes('iesdouyin.com')) {
      const id = /\/(?:video|note)\/(\d+)/.exec(path)?.[1] || '';
      return id ? `snssdk1128://aweme/detail/${id}` : '';
    }
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
      const id = /\/video\/(\d+)/.exec(path)?.[1] || '';
      return id ? `snssdk1233://aweme/detail/${id}` : '';
    }
    if (host.includes('kuaishou.com') || host.includes('chenzhongtech.com') || host.includes('gifshow.com')) {
      const id = /\/(?:short-video|fw\/photo|photo)\/([A-Za-z0-9_-]+)/.exec(path)?.[1] || '';
      return id ? `kwai://work/${id}` : '';
    }
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
      const id = /\/status\/(\d+)/.exec(path)?.[1] || '';
      return id ? `twitter://status?id=${id}` : '';
    }
    if (host.includes('threads.net') || host.includes('threads.com')) {
      const code = /\/post\/([A-Za-z0-9_-]+)/.exec(path)?.[1] || '';
      return code ? `barcelona://www.threads.net${path}` : '';
    }
    return '';
  } catch {
    return '';
  }
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
  const data = parsed.data as KukuData;
  const jobs = chooseKuku(data);
  if (jobs.length === 0) throw new Error(parsed.message || '没有解析到可以保存的视频');
  const cover = data.cover && data.cover.startsWith('http') ? data.cover : '';
  return { jobs, cover };
}

const MAX_FILE_BYTES = 80_000_000;

function bestVideo(item: KukuMedia | string) {
  if (typeof item === 'string') return item.startsWith('http') ? item : '';
  const infos = (item.video_fullinfo || [])
    .filter((info) => typeof info.url === 'string' && info.url.startsWith('http'))
    .map((info) => ({ url: info.url as string, size: Number(info.size || 0) }));
  const fit = infos.filter((info) => info.size > 0 && info.size <= MAX_FILE_BYTES);
  if (fit.length > 0) {
    fit.sort((left, right) => right.size - left.size);
    return fit[0].url;
  }
  const unknown = infos.filter((info) => info.size <= 0);
  if (unknown.length > 0) return unknown[0].url;
  if (infos.length > 0) {
    infos.sort((left, right) => left.size - right.size);
    return infos[0].url;
  }
  return item.url && item.url.startsWith('http') ? item.url : '';
}

function chooseKuku(data: KukuData): SaveJob[] {
  const videos: string[] = [];
  for (const item of data.videos || []) {
    const url = bestVideo(item);
    if (url) videos.push(url);
  }
  if (videos.length === 0 && data.url && data.url.startsWith('http')) videos.push(data.url);
  const files = unique(videos).slice(0, 3).map((url) => ({ url }));
  if (files.length > 0) return files;
  const raw = unique((data.pics || []).filter((url) => url.startsWith('http')));
  const images = raw.filter((url) => url !== data.cover);
  return (images.length > 0 ? images : raw).slice(0, 8).map((url) => ({ url }));
}

async function fetchSavedFile(job: SaveJob, referer: string, id: string) {
  try {
    return job.body
      ? await VideoFlip.downloadPosted(job.url, job.body, 'application/x-www-form-urlencoded', referer, id)
      : await VideoFlip.downloadFile(job.url, referer, id);
  } catch (error) {
    const message = errorText(error);
    if (!referer || !/没有给出视频文件|HTTP 403|HTTP 401/.test(message)) throw error;
    return job.body
      ? await VideoFlip.downloadPosted(job.url, job.body, 'application/x-www-form-urlencoded', '', id)
      : await VideoFlip.downloadFile(job.url, '', id);
  }
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
  return { jobs: chooseInstagram(html), cover: coverIn(html, 'https://insget.net/') };
}

async function parseTikTok(link: string) {
  const body = JSON.stringify({ vid: link, prefix: 'tiktokio.com' });
  const html = await VideoFlip.postPage('https://tiktokio.com/api/v1/tk/html', body, 'application/json', 'https://tiktokio.com/');
  const files = chooseTikTok(html).map((url) => ({ url }));
  if (files.length === 0) {
    const message = /class="tk-error"[^>]*>([^<]+)/.exec(html)?.[1]?.trim();
    throw new Error(message || '这条链接没有解析出来');
  }
  return { jobs: files, cover: coverIn(html, 'https://tiktokio.com/') };
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
  return { jobs, cover: coverIn(html, 'https://threadster.app/') };
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
  return { jobs, cover: coverIn(html, 'https://savetwitter.net/') };
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

function coverIn(html: string, base: string) {
  const og = /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1]
    || /content=["']([^"']+)["'][^>]*property=["']og:image["']/i.exec(html)?.[1]
    || /poster=["']([^"']+)["']/i.exec(html)?.[1]
    || '';
  const url = absolute(decodeHtml(og), base);
  return /^https?:\/\//i.test(url) ? url : '';
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

function phaseWord(phase: RowPhase) {
  if (phase === 'parse') return '解析中';
  if (phase === 'download') return '下载中';
  if (phase === 'flip') return '翻转中';
  if (phase === 'save') return '保存中';
  return '';
}

function RowPreview({ row, line, muted }: { row: Row; line: string; muted: string }) {
  const active = row.phase === 'parse' || row.phase === 'download' || row.phase === 'flip' || row.phase === 'save';
  if (!row.preview && !active) return null;
  if (!row.preview) {
    return (
      <View style={[styles.preview, { backgroundColor: line }]}>
        <Text style={[styles.previewText, { color: muted }]}>{phaseWord(row.phase)}</Text>
      </View>
    );
  }
  return <Image source={{ uri: row.preview }} style={styles.preview} />;
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
    marginBottom: 16,
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
  pasteWide: {
    width: 88,
    height: 44,
  },
  pastePlus: {
    width: 44,
    height: 44,
    borderRadius: 12,
    overflow: 'hidden',
  },
  pastePlusFill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  plusCover: {
    alignItems: 'center',
    justifyContent: 'center',
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
  listHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  listCount: {
    fontSize: 13,
    fontWeight: '700',
  },
  clearText: {
    fontSize: 14,
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
    marginTop: 8,
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
  cardHit: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  cardBody: {
    flex: 1,
  },
  preview: {
    width: 72,
    height: 96,
    borderRadius: 8,
    overflow: 'hidden',
  },
  previewText: {
    flex: 1,
    textAlign: 'center',
    textAlignVertical: 'center',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 96,
  },
  rowActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 16,
    marginTop: 8,
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
  linkHit: {
    flex: 1,
  },
  link: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  linkOpen: {
    textDecorationLine: 'underline',
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
