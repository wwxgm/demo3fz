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
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import VideoFlip from '../modules/video-flip';
import { errorText } from './runtime';
import { useTheme } from './theme';

const SAMPLE_SCRIPT = `全网汉堡前五排行榜！看看有没有你的本命🍔
第5名 华莱士｜汉堡界性价比卷王！十几块直接吃到撑，香辣鸡腿堡经典，学生党夜宵首选，缺点品控看运气
第4名 肯德基香辣鸡腿堡｜炸鸡底子是真稳，肉嫩入味，沙拉酱调得很舒服，几十年不出错，闭眼冲不踩雷
第3名 麦当劳板烧鸡腿堡｜麦门本命！鸡腿肉嫩到爆汁，不腻不辣，清淡党无限回购，稳定到离谱
第2名 汉堡王皇堡｜炭烤牛肉香直接拉满！厚牛肉饼，烟熏风味，爱吃牛肉堡的很难拒绝
第1名 塔斯汀香辣鸡腿堡｜国产汉堡黑马！现烤中国饼皮，有嚼劲，刚出炉香到上头！`;

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

export function PosterScreen() {
  const insets = useSafeAreaInsets();
  const { color } = useTheme();
  const [script, setScript] = useState(SAMPLE_SCRIPT);
  const [background, setBackground] = useState<{ uri: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const pickLibrary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsMultipleSelection: false,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      setBackground({ uri: asset.uri, name: asset.fileName || baseName(asset.uri, '背景视频.mp4') });
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
        type: ['video/*', 'public.movie', 'public.mpeg-4'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (!isVideo(asset.name, asset.mimeType)) {
        Alert.alert('不是视频', '请选择一个背景视频。');
        return;
      }
      setBackground({ uri: asset.uri, name: asset.name });
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
      output = await VideoFlip.makePoster(text, background?.uri ?? '');
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
      <Text style={styles.subtitle}>第一行是标题。后面每行写成「第5名 名字｜一句介绍」，会按抖音排行榜一条条翻出来。</Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
        <TextInput
          value={script}
          onChangeText={setScript}
          placeholder={'一行一句\n第二行接着翻'}
          placeholderTextColor="#6E8498"
          multiline
          editable={!busy}
          style={styles.script}
        />
        <Text style={styles.hint}>标题先出现，然后从第 5 名播到第 1 名。竖线后面是介绍。有背景视频时按原速播放。</Text>
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
            {background ? `背景：${background.name}` : '当前没有背景视频'}
          </Text>
          {background && !busy ? (
            <Pressable onPress={() => setBackground(null)} hitSlop={8}>
              <Text style={styles.remove}>清除</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
      <Pressable style={[styles.primary, { backgroundColor: color }, busy && styles.primaryDisabled]} disabled={busy} onPress={() => void make()}>
        {busy ? <ActivityIndicator color="#F4F7FB" /> : <Text style={styles.primaryText}>制作并保存</Text>}
      </Pressable>
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
    color: '#9BB0C5',
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
    color: '#F4F7FB',
    backgroundColor: 'rgba(255,255,255,0.08)',
    fontSize: 16,
    fontWeight: '600',
    textAlignVertical: 'top',
  },
  hint: {
    flex: 1,
    color: '#9BB0C5',
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
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  secondaryText: {
    color: '#F4F7FB',
    fontSize: 15,
    fontWeight: '600',
  },
  backgroundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
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
    color: '#F4F7FB',
    fontSize: 16,
    fontWeight: '700',
  },
});
