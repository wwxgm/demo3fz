import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
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
import { errorText } from './runtime';
import { useTheme, type Palette } from './theme';

const SAMPLE_SCRIPT = `全网汉堡前五排行榜！看看有没有你的本命🍔
第5名 华莱士｜汉堡界性价比卷王！十几块直接吃到撑，香辣鸡腿堡经典，学生党夜宵首选，缺点品控看运气
第4名 肯德基香辣鸡腿堡｜炸鸡底子是真稳，肉嫩入味，沙拉酱调得很舒服，几十年不出错，闭眼冲不踩雷
第3名 麦当劳板烧鸡腿堡｜麦门本命！鸡腿肉嫩到爆汁，不腻不辣，清淡党无限回购，稳定到离谱
第2名 汉堡王皇堡｜炭烤牛肉香直接拉满！厚牛肉饼，烟熏风味，爱吃牛肉堡的很难拒绝
第1名 塔斯汀香辣鸡腿堡｜国产汉堡黑马！现烤中国饼皮，有嚼劲，刚出炉香到上头！`;

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mpeg|mpg)$/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|heic|heif|webp|gif|bmp)$/i;

type BackgroundKind = 'image' | 'video';

type PosterBackground = {
  id: string;
  uri: string;
  name: string;
  kind: BackgroundKind;
};

function isVideo(name: string, mimeType?: string | null) {
  if (mimeType?.startsWith('video/')) return true;
  return VIDEO_EXT.test(name);
}

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

export function PosterScreen() {
  const insets = useSafeAreaInsets();
  const { color, palette } = useTheme();
  const styles = useMemo(() => createPosterStyles(palette), [palette]);
  const [script, setScript] = useState(SAMPLE_SCRIPT);
  const [backgrounds, setBackgrounds] = useState<PosterBackground[]>([]);
  const [fillBackground, setFillBackground] = useState(true);
  const [removeMusic, setRemoveMusic] = useState(true);
  const [busy, setBusy] = useState(false);

  const addBackgrounds = (next: PosterBackground[]) => {
    if (next.length === 0) {
      Alert.alert('没有可用背景', '请选择图片或视频。');
      return;
    }
    setBackgrounds((prev) => {
      const seen = new Set(prev.map((item) => item.uri));
      return [...prev, ...next.filter((item) => !seen.has(item.uri))].slice(0, 12);
    });
  };

  const pickLibrary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        selectionLimit: 12,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (result.canceled) return;
      const next: PosterBackground[] = [];
      result.assets.forEach((asset, index) => {
        const fallback = asset.type === 'image' ? `背景图片 ${index + 1}.jpg` : `背景视频 ${index + 1}.mp4`;
        const name = asset.fileName || baseName(asset.uri, fallback);
        const kind: BackgroundKind | null = asset.type === 'image' || asset.type === 'livePhoto' || isImage(name, asset.mimeType)
          ? 'image'
          : asset.type === 'video' || asset.type === 'pairedVideo' || isVideo(name, asset.mimeType)
            ? 'video'
            : null;
        if (!kind) return;
        next.push({ id: `${Date.now()}-lib-${index}-${name}`, uri: asset.uri, name, kind });
      });
      addBackgrounds(next);
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
        type: ['video/*', 'public.movie', 'public.mpeg-4', 'image/*', 'public.image'],
        multiple: true,
        copyToCacheDirectory: false,
      });
      if (result.canceled) return;
      const next: PosterBackground[] = [];
      result.assets.forEach((asset, index) => {
        const kind: BackgroundKind | null = isImage(asset.name, asset.mimeType)
          ? 'image'
          : isVideo(asset.name, asset.mimeType)
            ? 'video'
            : null;
        if (!kind) return;
        next.push({ id: `${Date.now()}-file-${index}-${asset.name}`, uri: asset.uri, name: asset.name, kind });
      });
      addBackgrounds(next);
    } catch (error) {
      Alert.alert('无法打开文件', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const make = async () => {
    if (busy) return;
    const text = script.trim();
    if (!text) {
      Alert.alert('还没有文案', '先输入要做成大字的内容。');
      return;
    }
    if (Platform.OS !== 'ios') {
      Alert.alert('仅支持 iPhone', '制作并保存到相册目前只在 iPhone 安装包里可用。');
      return;
    }
    const current = await MediaLibrary.getPermissionsAsync(true);
    const permission = current.granted ? current : await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) {
      Alert.alert('需要相册权限', '做好的视频要保存到手机相册，请允许添加照片。', [
        { text: '取消', style: 'cancel' },
        { text: '去设置', onPress: () => void Linking.openSettings() },
      ]);
      return;
    }
    setBusy(true);
    let output = '';
    try {
      const onlyVideo = backgrounds.length === 1 && backgrounds[0].kind === 'video' ? backgrounds[0].uri : '';
      output = await VideoFlip.makePoster(text, onlyVideo, {
        fill: fillBackground,
        mute: removeMusic,
        backgrounds:
          backgrounds.length > 1 || backgrounds.some((item) => item.kind === 'image')
            ? backgrounds.map((item) => ({ uri: item.uri, kind: item.kind }))
            : undefined,
      });
      await MediaLibrary.createAssetAsync(output);
      Alert.alert('已保存', '大字报视频已保存到相册。');
    } catch (error) {
      Alert.alert('制作失败', errorText(error));
    } finally {
      if (output) VideoFlip.removeTempFile(output);
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <Text style={styles.title}>大字报</Text>
      <Text style={styles.subtitle}>一句一句切换。排行榜写成「第5名 名字｜一句介绍」，名次换的时候介绍也逐句出现。</Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
        <TextInput
          value={script}
          onChangeText={setScript}
          placeholder={'一句一句写\n下一句会替换上一句'}
          placeholderTextColor={palette.placeholder}
          multiline
          editable={!busy}
          style={styles.script}
        />
        <Text style={styles.hint}>不会把整段排成很多行。一句显示在画面中间，播完再换成下一句。</Text>
        <View style={styles.optionRow}>
          <Text style={styles.optionLabel}>背景铺满文案</Text>
          <Switch
            disabled={busy}
            value={fillBackground}
            onValueChange={setFillBackground}
            trackColor={{ false: palette.switchOff, true: color }}
          />
        </View>
        <Text style={styles.hint}>
          只有一段背景视频时，打开后会放慢、重复并慢慢放大，直到和文案一样长；关掉则按原速，文案会被截断。多张图片会慢慢放大再还原，并和前后背景渐变切换。视频不够长会自动延长。
        </Text>
        <View style={styles.optionRow}>
          <Text style={styles.optionLabel}>移除背景音乐</Text>
          <Switch
            disabled={busy}
            value={removeMusic}
            onValueChange={setRemoveMusic}
            trackColor={{ false: palette.switchOff, true: color }}
          />
        </View>
        <Text style={styles.hint}>默认去掉背景里的声音。关掉后保留原背景音乐。</Text>
        <View style={styles.actions}>
          <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickLibrary()}>
            <Text style={styles.secondaryText}>相册背景</Text>
          </Pressable>
          <Pressable style={styles.secondary} disabled={busy} onPress={() => void pickFiles()}>
            <Text style={styles.secondaryText}>文件背景</Text>
          </Pressable>
        </View>
        <View style={styles.backgroundRow}>
          <Text style={styles.hint} numberOfLines={2}>
            {backgrounds.length > 0 ? `已加 ${backgrounds.length} 个背景` : '当前没有背景'}
          </Text>
          {backgrounds.length > 0 && !busy ? (
            <Pressable onPress={() => setBackgrounds([])} hitSlop={8}>
              <Text style={styles.remove}>清空</Text>
            </Pressable>
          ) : null}
        </View>
        {backgrounds.map((item, index) => (
          <View key={item.id} style={styles.backgroundRow}>
            <Text style={styles.hint} numberOfLines={1}>
              {index + 1}. {item.kind === 'image' ? '图片' : '视频'} · {item.name}
            </Text>
            {!busy ? (
              <Pressable onPress={() => setBackgrounds((prev) => prev.filter((it) => it.id !== item.id))} hitSlop={8}>
                <Text style={styles.remove}>移除</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </ScrollView>
      <Pressable style={[styles.primary, { backgroundColor: color }, busy && styles.primaryDisabled]} disabled={busy} onPress={() => void make()}>
        {busy ? <ActivityIndicator color="#F4F7FB" /> : <Text style={styles.primaryText}>制作并保存</Text>}
      </Pressable>
    </View>
  );
}

function createPosterStyles(palette: Palette) {
  return StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 20,
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
  list: {
    flex: 1,
    marginTop: 16,
  },
  listContent: {
    gap: 12,
    paddingBottom: 16,
  },
  script: {
    minHeight: 260,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: palette.text,
    backgroundColor: palette.field,
    fontSize: 16,
    fontWeight: '600',
    textAlignVertical: 'top',
  },
  hint: {
    flex: 1,
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
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
  backgroundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
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
    fontWeight: '600',
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
