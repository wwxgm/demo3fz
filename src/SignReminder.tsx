import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import VideoFlip from '../modules/video-flip';

export function SignReminder() {
  const [days, setDays] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      setDays(VideoFlip.installDaysLeft());
    } catch {
      setDays(null);
    }
  }, []);

  if (hidden || days == null || days <= -900 || days >= 2) {
    return null;
  }

  const remain = days < 0 ? '' : days < 1 ? `还剩 ${Math.max(1, Math.ceil(days * 24))} 小时` : `还剩 ${Math.ceil(days)} 天`;
  const message =
    days < 0
      ? '签名已经到期。请打开 SideStore，连上 Wi-Fi 和 LocalDevVPN，给这个应用续签。'
      : `签名${remain}，已不足 2 天。请打开 SideStore，连上 Wi-Fi 和 LocalDevVPN，点这个应用旁边的天数续签。到期后将无法打开。`;

  return (
    <View style={styles.signBar}>
      <Text style={styles.signText}>{message}</Text>
      <Pressable onPress={() => setHidden(true)} hitSlop={8}>
        <Text style={styles.signClose}>关闭</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  signBar: {
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#FEF3C7',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  signText: {
    flex: 1,
    color: '#92400E',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  signClose: {
    color: '#92400E',
    fontSize: 13,
    fontWeight: '700',
  },
});
