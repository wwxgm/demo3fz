import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from '../modules/video-flip';
import { errorText } from './runtime';
import { useTheme } from './theme';

type Kind = 'all' | 'photo' | 'video';

type AlbumItem = {
  id: string;
  title: string;
  count: number;
};

const COLS = 3;
const GAP = 4;
const PAGE = 48;

const KINDS: { id: Kind; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'photo', label: '图片' },
  { id: 'video', label: '视频' },
];

export function AlbumShareScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const { color, palette } = useTheme();
  const [phase, setPhase] = useState<'checking' | 'denied' | 'ready'>('checking');
  const [limited, setLimited] = useState(false);
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareLabel, setShareLabel] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tile, setTile] = useState(108);
  const frame = useRef({ x: 0, y: 0 });
  const scrollY = useRef(0);
  const scrollRef = useRef<ScrollView>(null);
  const measureFrame = () => {
    scrollRef.current?.measureInWindow((x, y) => {
      frame.current = { x, y };
    });
  };
  const assetsRef = useRef(assets);
  const selectedRef = useRef(selected);
  const tileRef = useRef(tile);
  const ignorePress = useRef(false);
  const adding = useRef(true);
  const lastIndex = useRef(-1);
  const ticket = useRef(0);
  const pageRef = useRef({ cursor: null as string | null, hasNext: false, loading: false });
  assetsRef.current = assets;
  selectedRef.current = selected;
  tileRef.current = tile;

  const indexAt = useCallback((pageX: number, pageY: number) => {
    const size = tileRef.current;
    const localX = pageX - frame.current.x;
    const localY = pageY - frame.current.y + scrollY.current;
    if (localX < 0 || localY < 0) return -1;
    const stride = size + GAP;
    const col = Math.floor(localX / stride);
    const row = Math.floor(localY / stride);
    if (col < 0 || col >= COLS) return -1;
    if (localX - col * stride > size + 0.5) return -1;
    if (localY - row * stride > size + 0.5) return -1;
    const index = row * COLS + col;
    if (index < 0 || index >= assetsRef.current.length) return -1;
    return index;
  }, []);

  const paint = useCallback((index: number, select: boolean) => {
    const asset = assetsRef.current[index];
    if (!asset) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (select) next.add(asset.id);
      else next.delete(asset.id);
      return next;
    });
  }, []);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        Math.abs(gesture.dx) > 16 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.05,
      onPanResponderGrant: (_, gesture) => {
        const index = indexAt(gesture.x0, gesture.y0);
        if (index < 0) return;
        const asset = assetsRef.current[index];
        ignorePress.current = true;
        adding.current = asset ? !selectedRef.current.has(asset.id) : true;
        lastIndex.current = index;
        paint(index, adding.current);
      },
      onPanResponderMove: (_, gesture) => {
        const index = indexAt(gesture.moveX, gesture.moveY);
        if (index < 0 || index === lastIndex.current) return;
        const steps = indexesBetween(lastIndex.current, index, COLS);
        lastIndex.current = index;
        steps.forEach((step) => paint(step, adding.current));
      },
      onPanResponderRelease: () => {
        setTimeout(() => {
          ignorePress.current = false;
        }, 80);
      },
      onPanResponderTerminate: () => {
        ignorePress.current = false;
      },
    }),
  ).current;

  const loadAssets = useCallback(async (after: string | null, replace: boolean) => {
    const current = ticket.current + 1;
    ticket.current = current;
    pageRef.current.loading = true;
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        first: PAGE,
        ...(after ? { after } : {}),
        ...(albumId ? { album: albumId } : {}),
        mediaType: kind === 'all' ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video] : kind,
        sortBy: [MediaLibrary.SortBy.creationTime],
      });
      if (current !== ticket.current) return;
      setAssets((prev) => (replace ? page.assets : [...prev, ...page.assets]));
      pageRef.current = { cursor: page.endCursor ?? null, hasNext: page.hasNextPage, loading: false };
      if (replace) setSelected(new Set());
    } catch (error) {
      if (current !== ticket.current) return;
      Alert.alert('无法读取相册', errorText(error));
    } finally {
      if (current === ticket.current) {
        pageRef.current.loading = false;
        setLoading(false);
      }
    }
  }, [albumId, kind]);

  useEffect(() => {
    let alive = true;
    const open = async () => {
      try {
        const current = await MediaLibrary.getPermissionsAsync();
        const permission = current.granted ? current : await MediaLibrary.requestPermissionsAsync();
        if (!alive) return;
        if (!permission.granted) {
          setPhase('denied');
          return;
        }
        setLimited(permission.accessPrivileges === 'limited');
        setPhase('ready');
        try {
          const rows = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
          if (!alive) return;
          setAlbums(
            rows
              .map((item) => ({ id: item.id, title: item.title || '未命名相册', count: item.assetCount ?? 0 }))
              .filter((item) => item.count > 0)
              .sort((a, b) => b.count - a.count),
          );
        } catch {
          if (alive) setAlbums([]);
        }
      } catch (error) {
        if (!alive) return;
        setPhase('denied');
        Alert.alert('无法读取相册', errorText(error));
      }
    };
    void open();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    void loadAssets(null, true);
  }, [phase, loadAssets]);

  const toggle = (id: string) => {
    if (ignorePress.current) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const share = async () => {
    const chosen = assets.filter((item) => selected.has(item.id));
    if (chosen.length === 0 || sharing) {
      Alert.alert('还没有选择', '点一下选中，或按住横向滑动连续多选。');
      return;
    }
    if (chosen.length > 40) {
      Alert.alert('一次选太多了', '一次最多分享 40 个，请少选一些再分享。');
      return;
    }
    setSharing(true);
    try {
      const urls: string[] = [];
      for (let index = 0; index < chosen.length; index += 1) {
        setShareLabel(`正在准备 ${index + 1}/${chosen.length}`);
        const info = await withTimeout(
          MediaLibrary.getAssetInfoAsync(chosen[index], { shouldDownloadFromNetwork: true }),
          40000,
          `「${chosen[index].filename || '这个文件'}」读取超时`,
        );
        const uri = info.localUri && info.localUri.startsWith('file') ? info.localUri : '';
        if (!uri) throw new Error(`读不到「${chosen[index].filename || '这个文件'}」`);
        urls.push(uri);
      }
      setShareLabel('正在打开分享');
      await VideoFlip.shareFiles(urls);
    } catch (error) {
      Alert.alert('无法分享', errorText(error));
    } finally {
      setSharing(false);
      setShareLabel('');
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8, backgroundColor: palette.background }]}>
      <Pressable onPress={onBack} hitSlop={8}>
        <Text style={[styles.back, { color }]}>返回</Text>
      </Pressable>
      <Text style={[styles.title, { color: palette.text }]}>相册分享</Text>
      <Text style={[styles.subtitle, { color: palette.muted }]}>
        点一下选中，按住横向滑动可以连续多选。分享里点夸克，再选要保存的目录。只有当前登录的夸克账号能看到。
      </Text>
      {phase === 'checking' ? <ActivityIndicator color={color} style={styles.spinner} /> : null}
      {phase === 'denied' ? (
        <View style={styles.denied}>
          <Text style={[styles.empty, { color: palette.muted }]}>需要允许读取照片，才能列出相册里的图片和视频。</Text>
          <Pressable style={[styles.share, { backgroundColor: color }]} onPress={() => void Linking.openSettings()}>
            <Text style={styles.shareText}>去设置打开权限</Text>
          </Pressable>
        </View>
      ) : null}
      {phase === 'ready' ? (
        <>
          <View style={styles.kinds}>
            {KINDS.map((item) => {
              const on = kind === item.id;
              return (
                <Pressable
                  key={item.id}
                  style={[styles.chip, { backgroundColor: on ? color : palette.field }]}
                  onPress={() => setKind(item.id)}
                >
                  <Text style={[styles.chipText, { color: on ? '#FFFFFF' : palette.text }]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.albums}>
            <AlbumChip label="全部相册" count={null} active={albumId === null} color={color} text={palette.text} field={palette.field} onPress={() => setAlbumId(null)} />
            {albums.map((item) => (
              <AlbumChip
                key={item.id}
                label={item.title}
                count={item.count}
                active={albumId === item.id}
                color={color}
                text={palette.text}
                field={palette.field}
                onPress={() => setAlbumId(item.id)}
              />
            ))}
          </ScrollView>
          {limited ? (
            <Pressable
              onPress={() => {
                void MediaLibrary.presentPermissionsPickerAsync()
                  .then(() => loadAssets(null, true))
                  .catch((error) => Alert.alert('无法选择更多照片', errorText(error)));
              }}
              hitSlop={6}
            >
              <Text style={[styles.limited, { color }]}>当前只能看部分照片，点这里选择更多</Text>
            </Pressable>
          ) : null}
          <View style={styles.meta}>
            <Text style={[styles.metaText, { color: palette.muted }]}>已选 {selected.size} 个</Text>
            {selected.size > 0 ? (
              <Pressable onPress={() => setSelected(new Set())} hitSlop={8}>
                <Text style={[styles.metaText, { color }]}>清空</Text>
              </Pressable>
            ) : null}
          </View>
          <ScrollView
            ref={scrollRef}
            style={styles.gridScroll}
            contentContainerStyle={styles.gridContent}
            scrollEventThrottle={16}
            directionalLockEnabled
            onLayout={() => measureFrame()}
            onScroll={(event) => {
              scrollY.current = event.nativeEvent.contentOffset.y;
              const left = event.nativeEvent.contentSize.height - event.nativeEvent.layoutMeasurement.height - scrollY.current;
              const page = pageRef.current;
              if (left < 280 && page.hasNext && !page.loading && page.cursor) void loadAssets(page.cursor, false);
            }}
          >
            <View
              style={styles.grid}
              onLayout={(event) => {
                const width = event.nativeEvent.layout.width;
                setTile(Math.floor((width - GAP * (COLS - 1)) / COLS));
              }}
              {...pan.panHandlers}
            >
              {assets.map((asset) => {
                const on = selected.has(asset.id);
                return (
                  <Pressable key={asset.id} style={{ width: tile, height: tile }} onPress={() => toggle(asset.id)}>
                    <Thumb localId={asset.id} side={tile} color={palette.field} />
                    {asset.mediaType === MediaLibrary.MediaType.video ? (
                      <Text style={styles.videoTag}>视频</Text>
                    ) : null}
                    <View style={[styles.mark, on && { backgroundColor: color, borderColor: color }]}>
                      {on ? <Text style={styles.markText}>✓</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {loading ? <ActivityIndicator color={color} style={styles.spinner} /> : null}
            {!loading && assets.length === 0 ? (
              <Text style={[styles.empty, { color: palette.muted }]}>这个范围里没有内容。</Text>
            ) : null}
          </ScrollView>
          <Pressable
            style={[styles.share, { backgroundColor: color }, (sharing || selected.size === 0) && styles.shareOff]}
            disabled={sharing || selected.size === 0}
            onPress={() => void share()}
          >
            {sharing ? (
              <Text style={styles.shareText}>{shareLabel || '正在准备…'}</Text>
            ) : (
              <Text style={styles.shareText}>{selected.size > 0 ? `分享 ${selected.size} 个` : '分享'}</Text>
            )}
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

function AlbumChip({
  label,
  count,
  active,
  color,
  text,
  field,
  onPress,
}: {
  label: string;
  count: number | null;
  active: boolean;
  color: string;
  text: string;
  field: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.album, { backgroundColor: active ? color : field }]} onPress={onPress}>
      <Text style={[styles.albumText, { color: active ? '#FFFFFF' : text }]} numberOfLines={1}>
        {count === null ? label : `${label} ${count}`}
      </Text>
    </Pressable>
  );
}

function Thumb({ localId, side, color }: { localId: string; side: number; color: string }) {
  const [uri, setUri] = useState('');
  useEffect(() => {
    let alive = true;
    VideoFlip.photoThumbnail(localId, Math.max(side * 2, 160))
      .then((path) => {
        if (alive) setUri(path);
      })
      .catch(() => {
        if (alive) setUri('');
      });
    return () => {
      alive = false;
    };
  }, [localId, side]);
  if (!uri) return <View style={[styles.thumb, { backgroundColor: color }]} />;
  return <Image source={{ uri }} style={styles.thumb} />;
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function indexesBetween(from: number, to: number, cols: number) {
  if (from < 0) return [to];
  const fromRow = Math.floor(from / cols);
  const fromCol = from % cols;
  const toRow = Math.floor(to / cols);
  const toCol = to % cols;
  const steps = Math.max(Math.abs(toRow - fromRow), Math.abs(toCol - fromCol), 1);
  const indexes: number[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const row = Math.round(fromRow + ((toRow - fromRow) * step) / steps);
    const col = Math.round(fromCol + ((toCol - fromCol) * step) / steps);
    const index = row * cols + col;
    if (indexes[indexes.length - 1] !== index) indexes.push(index);
  }
  return indexes;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
  },
  back: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
  },
  kinds: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  chip: {
    minHeight: 32,
    paddingHorizontal: 14,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 14,
    fontWeight: '700',
  },
  albums: {
    gap: 8,
    paddingVertical: 10,
  },
  album: {
    maxWidth: 180,
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  albumText: {
    fontSize: 13,
    fontWeight: '700',
  },
  limited: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  meta: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaText: {
    fontSize: 13,
    fontWeight: '700',
  },
  gridScroll: {
    flex: 1,
  },
  gridContent: {
    paddingBottom: 12,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
  },
  thumb: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
  },
  videoTag: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },
  mark: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  markText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  spinner: {
    marginTop: 24,
  },
  empty: {
    marginTop: 16,
    fontSize: 14,
    lineHeight: 20,
  },
  denied: {
    marginTop: 20,
    gap: 16,
  },
  share: {
    minHeight: 48,
    borderRadius: 12,
    marginTop: 8,
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareOff: {
    opacity: 0.45,
  },
  shareText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
