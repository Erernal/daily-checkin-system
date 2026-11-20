/**
 * 不拖延 · 强制打卡系统 v3（多习惯 / 休息日 / 积分 / 三榜）
 * Expo SDK 58 · React Native 0.88
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

/* ==========================================================================
 * 0. 配置 / 主题
 * ======================================================================== */

const API_BASE = 'http://39.96.213.95:3000';

const TOKEN_KEY = 'qiangzhi.token';
const DEVICE_KEY = 'qiangzhi.device';
const CHANNEL_ID = 'checkin-reminder';
const PRE_REMINDER_MINUTES = 15;

const C = {
  bg: '#0A0E17',
  bgSoft: '#0D1220',
  card: '#1E1E24',
  cardSoft: '#161A23',
  line: 'rgba(0,229,255,0.22)',
  lineSoft: 'rgba(255,255,255,0.07)',
  cyan: '#00E5FF',
  purple: '#B388FF',
  green: '#39FF88',
  yellow: '#FFD166',
  red: '#FF5C7A',
  text: '#EAF6FF',
  muted: '#8A8A8A',
  dim: '#2A2F3A',
};

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const QUOTES = [
  '今天也把拖延按在地上摩擦。',
  '自律给你自由，借口只给焦虑。',
  '完成比完美更重要。',
  '每一次按时打卡，都是给未来的自己投票。',
  '别等状态好，先开始，状态就会好。',
  '把“等会儿”换成“现在”。',
  '连赢不是运气，是每天的选择。',
];

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

const STATUS_TEXT = {
  pending: '等待打卡',
  done: '今日已打卡',
  late: '迟到打卡',
  partial: '部分完成',
  excused: '已请假',
  missed: '已漏签',
  holiday: '免打卡日',
  rest: '今日休息',
  vacation: '休假中',
};

const STATUS_COLOR = {
  pending: C.cyan,
  done: C.green,
  late: C.yellow,
  partial: C.yellow,
  excused: C.purple,
  missed: C.red,
  holiday: C.cyan,
  rest: C.muted,
  vacation: C.purple,
};

const STATUS_BADGE = {
  done: '已打卡',
  late: '迟到',
  partial: '部分',
  excused: '已请假',
  missed: '漏签',
  pending: '待打卡',
  holiday: '免打卡',
  rest: '休息',
  vacation: '休假中',
};

/* ==========================================================================
 * 1. 工具
 * ======================================================================== */

const pad2 = (n) => String(n).padStart(2, '0');

/** 强制北京时间的 YYYY-MM-DD（Intl 指定 timeZone，绝不使用手机本地时区） */
function beijingToday(now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts ? fmt.formatToParts(now) : [];
    const bag = {};
    for (const p of parts) if (p.type !== 'literal') bag[p.type] = p.value;
    if (bag.year && bag.month && bag.day) return `${bag.year}-${bag.month}-${bag.day}`;
  } catch (err) {
    // 走兜底
  }
  const utc8 = new Date(now.getTime() + 8 * 3600 * 1000);
  return `${utc8.getUTCFullYear()}-${pad2(utc8.getUTCMonth() + 1)}-${pad2(utc8.getUTCDate())}`;
}

function randomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${pad2(m)}m` : `${pad2(m)}m ${pad2(sec)}s`;
}

function shortDate(isoText) {
  return isoText ? String(isoText).slice(0, 10) : '—';
}

function weekdaysText(days) {
  if (!days || !days.length) return '不设';
  if (days.length === 7) return '每天';
  if (days.join(',') === '1,2,3,4,5') return '工作日';
  if (days.join(',') === '6,7') return '周末';
  return days.map((d) => '周' + WEEK_LABELS[d - 1]).join(' ');
}

async function getDeviceId() {
  const saved = await AsyncStorage.getItem(DEVICE_KEY);
  if (saved) return saved;

  const hardware =
    Device.osInternalBuildId ||
    Device.osBuildId ||
    Device.modelId ||
    (Device.modelName ? `${Device.modelName}-${Device.osVersion || '0'}` : '');

  const id = hardware && hardware.length >= 8
    ? hardware.slice(0, 120)
    : `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  await AsyncStorage.setItem(DEVICE_KEY, id);
  return id;
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const error = new Error(`无法连接服务器（${API_BASE}）`);
    error.code = 'NETWORK';
    throw error;
  }

  let data = {};
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = {};
  }

  if (res.status === 401) {
    const error = new Error(data.message || '登录已过期');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  if (!res.ok) {
    const error = new Error(data.message || `请求失败（${res.status}）`);
    error.code = data.error || 'ERROR';
    error.status = res.status;
    throw error;
  }
  return data;
}

/* ==========================================================================
 * 2. 通知（按习惯的生效星期 + 截止前 15 分钟）
 * ======================================================================== */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const WEEKLY_TRIGGER =
  (Notifications.SchedulableTriggerInputTypes && Notifications.SchedulableTriggerInputTypes.WEEKLY) ||
  'weekly';

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: '打卡强提醒',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 300, 200, 300],
    lightColor: C.cyan,
    bypassDnd: true,
    enableVibrate: true,
    sound: 'default',
  });
}

async function ensureNotificationPermission() {
  try {
    await ensureAndroidChannel();
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    const requested = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    return Boolean(requested.granted);
  } catch (err) {
    return false;
  }
}

/** expo 的 weekday：1=周日 … 7=周六；我们的 activeDays：1=周一 … 7=周日 */
const expoWeekday = (day) => (day === 7 ? 1 : day + 1);

/**
 * 每个习惯、每个生效星期，在截止时间前 15 分钟注册一条 weekly 通知。
 * 不生效的星期天然不会触发，等价于“休息日不注册”。
 */
async function syncHabitNotifications(habits) {
  await Notifications.cancelAllScheduledNotificationsAsync();
  if (!habits || !habits.length) return 0;

  let count = 0;
  for (const habit of habits) {
    if (!habit.deadlineTime || !habit.activeDays || !habit.activeDays.length) continue;
    const [hour, minute] = habit.deadlineTime.split(':').map(Number);
    const total = (hour * 60 + minute - PRE_REMINDER_MINUTES + 1440) % 1440;

    for (const day of habit.activeDays) {
      if (count >= 30) break;
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `${habit.emoji || '⏰'} ${habit.name} 快截止了`,
          body: `还有 ${PRE_REMINDER_MINUTES} 分钟到 ${habit.deadlineTime}，别让它断签。`,
          sound: true,
          priority: Notifications.AndroidNotificationPriority.HIGH,
          data: { habitId: habit.id, screen: 'checkin' },
        },
        trigger: {
          type: WEEKLY_TRIGGER,
          weekday: expoWeekday(day),
          hour: Math.floor(total / 60),
          minute: total % 60,
          ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
        },
      });
      count += 1;
    }
  }
  return count;
}

/* ==========================================================================
 * 3. 通用 UI
 * ======================================================================== */

function NeonCard({ children, style, glow = C.cyan }) {
  return <View style={[styles.card, { shadowColor: glow }, style]}>{children}</View>;
}

function NeonButton({ label, onPress, variant = 'solid', disabled, loading, small, style }) {
  const solid = variant === 'solid';
  const outline = variant === 'outline';
  const danger = variant === 'danger';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        solid && styles.btnSolid,
        outline && styles.btnOutline,
        danger && styles.btnDanger,
        disabled && styles.btnDisabled,
        pressed && !disabled && styles.btnPressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={solid || danger ? '#04070E' : C.cyan} size="small" />
      ) : (
        <Text
          style={[
            styles.btnText,
            small && styles.btnTextSmall,
            solid && styles.btnTextSolid,
            outline && { color: C.cyan },
            danger && { color: '#1A0410' },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function Tag({ text, color = C.cyan }) {
  return (
    <View style={[styles.tag, { borderColor: color + '55', backgroundColor: color + '14' }]}>
      <Text style={[styles.tagText, { color }]}>{text}</Text>
    </View>
  );
}

function Toast({ toast, onHide }) {
  const translateY = useRef(new Animated.Value(-160)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!toast) return undefined;
    translateY.setValue(-160);
    opacity.setValue(0);
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, friction: 8, tension: 70, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, { toValue: -160, duration: 220, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start(() => onHide());
    }, 2800);
    return () => clearTimeout(timer);
  }, [toast, translateY, opacity, onHide]);

  if (!toast) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.toastBox, toast.kind === 'error' && styles.toastError, { opacity, transform: [{ translateY }] }]}
    >
      <View style={[styles.toastDot, toast.kind === 'error' && { backgroundColor: C.red }]} />
      <Text style={styles.toastText} numberOfLines={3}>{toast.message}</Text>
    </Animated.View>
  );
}

function ConfirmModal({ visible, title, message, confirmText = '确认', loading, onConfirm, onCancel }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalGlowLine} />
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalMessage}>{message}</Text>
          <View style={styles.modalActions}>
            <NeonButton label="取消" variant="outline" small onPress={onCancel} style={{ flex: 1 }} />
            <NeonButton label={confirmText} small loading={loading} onPress={onConfirm} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/* ==========================================================================
 * 4. 习惯表单（选星期 + 选时间）
 * ======================================================================== */

function HabitFormModal({ visible, habit, token, onClose, onSaved, onDelete, notify }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('⏰');
  const [days, setDays] = useState([1, 2, 3, 4, 5, 6, 7]);
  const [time, setTime] = useState('22:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    setName(habit ? habit.name : '');
    setEmoji(habit ? habit.emoji || '⏰' : '⏰');
    setDays(habit ? habit.activeDays : [1, 2, 3, 4, 5, 6, 7]);
    setTime(habit ? habit.deadlineTime : '22:00');
    setError('');
  }, [visible, habit]);

  const toggleDay = (day) => {
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)));
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('给习惯起个名字');
      return;
    }
    if (!days.length) {
      setError('至少选择一个生效星期');
      return;
    }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      setError('时间格式应为 HH:MM');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const body = {
        name: name.trim(),
        emoji: emoji.trim() || '⏰',
        activeDays: days,
        deadlineTime: time,
        ...(habit ? {} : { startDate: beijingToday() }),
      };
      if (habit) {
        await api(`/api/habits/${habit.id}`, { method: 'PUT', token, body });
      } else {
        await api('/api/habits', { method: 'POST', token, body });
      }
      onSaved();
      onClose();
      notify(habit ? '习惯已更新' : '习惯已创建');
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') notify('登录已过期', 'error');
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, styles.formCard]}>
          <View style={styles.modalGlowLine} />
          <Text style={styles.modalTitle}>{habit ? '编辑习惯' : '新建习惯'}</Text>

          <Text style={styles.label}>名称</Text>
          <View style={styles.inlineRow}>
            <TextInput
              style={[styles.input, styles.emojiInput]}
              value={emoji}
              onChangeText={setEmoji}
              maxLength={2}
            />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={name}
              onChangeText={setName}
              placeholder="例如：晨跑 / 背单词"
              placeholderTextColor={C.muted}
              maxLength={30}
            />
          </View>

          <Text style={styles.label}>生效星期</Text>
          <View style={styles.weekRow}>
            {WEEK_LABELS.map((label, index) => {
              const day = index + 1;
              const active = days.includes(day);
              return (
                <Pressable
                  key={day}
                  onPress={() => toggleDay(day)}
                  style={[styles.weekChip, active && styles.weekChipActive]}
                >
                  <Text style={[styles.weekChipText, active && styles.weekChipTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.formHint}>没选的星期会显示「今日休息」，不打卡也不断签。</Text>

          <Text style={styles.label}>每日截止时间</Text>
          <TextInput
            style={[styles.input, styles.timeInput]}
            value={time}
            onChangeText={setTime}
            placeholder="22:00"
            placeholderTextColor={C.muted}
            maxLength={5}
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.modalActions}>
            <NeonButton label="取消" variant="outline" small onPress={onClose} style={{ flex: 1 }} />
            <NeonButton label={habit ? '保存' : '创建'} small loading={busy} onPress={submit} style={{ flex: 1 }} />
          </View>

          {habit ? (
            <Pressable onPress={() => onDelete && onDelete(habit)} style={styles.deleteLink}>
              <Text style={styles.deleteText}>删除这个习惯</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/* ==========================================================================
 * 5. 登录
 * ======================================================================== */

function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const deviceId = await getDeviceId();
      const path = mode === 'login' ? '/api/login' : '/api/register';
      const data = await api(path, {
        method: 'POST',
        body: { username: username.trim(), password, deviceId },
      });
      await onLogin(data.token, data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled">
          <View style={styles.loginHead}>
            <Text style={styles.loginLogo}>⏰</Text>
            <Text style={styles.loginTitle}>拒绝摆烂</Text>
            <Text style={styles.loginSub}>NOSLACK · CHECK-IN OR EXCUSE</Text>
          </View>

          <NeonCard style={{ padding: 20 }}>
            <View style={styles.segment}>
              {['login', 'register'].map((key) => (
                <Pressable
                  key={key}
                  style={[styles.segmentItem, mode === key && styles.segmentItemActive]}
                  onPress={() => setMode(key)}
                >
                  <Text style={[styles.segmentText, mode === key && styles.segmentTextActive]}>
                    {key === 'login' ? '登录' : '注册'}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.label}>用户名</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="2-24 位字母、数字或中文"
              placeholderTextColor={C.muted}
              autoCapitalize="none"
            />
            <Text style={styles.label}>密码</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="至少 6 位"
              placeholderTextColor={C.muted}
              secureTextEntry
              autoCapitalize="none"
            />

            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <NeonButton
              label={mode === 'login' ? '登 录' : '注册并登录'}
              loading={busy}
              onPress={submit}
              style={{ marginTop: 20 }}
            />
          </NeonCard>

          <Text style={styles.serverHint}>设备号唯一 · 一个设备只能注册一个账号</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ==========================================================================
 * 6. 强制阻断
 * ======================================================================== */

function BlockingModal({ visible, status, token, onExcused, onExpired }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (reason.trim().length < 2) {
      setError('借口至少写 2 个字');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await api('/api/excuse', {
        method: 'POST',
        token,
        body: { reason: reason.trim(), date: status.blockDate },
      });
      setReason('');
      onExcused(data.status, data.usedLeave);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') onExpired();
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={() => {}}>
      <SafeAreaView style={styles.blockSafe}>
        <StatusBar style="light" />
        <ScrollView contentContainerStyle={styles.blockWrap} keyboardShouldPersistTaps="handled">
          <Text style={styles.blockEmoji}>⛔️</Text>
          <Text style={styles.blockTitle}>
            {status && status.blockDate === status.today ? '今天的打卡时间已经过了' : '你昨天漏签了'}
          </Text>
          <Text style={styles.blockDesc}>
            {status ? status.blockDate : ''} 还有习惯没完成，也没有请假。{'\n'}
            写个借口才能继续使用 —— 有请假额度会消耗 1 次并保住连胜。
          </Text>

          <View style={styles.blockCard}>
            <Text style={styles.label}>你的借口（2-300 字）</Text>
            <TextInput
              style={[styles.input, styles.textarea]}
              value={reason}
              onChangeText={setReason}
              placeholder="例如：加班到凌晨，实在没赶上……"
              placeholderTextColor={C.muted}
              multiline
              maxLength={300}
              editable={!busy}
            />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <NeonButton label="提交借口，解锁使用" variant="danger" loading={busy} onPress={submit} style={{ marginTop: 16 }} />
            <Text style={styles.blockFoot}>没有额度也可以提交，但这次断签不会保住连胜。</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/* ==========================================================================
 * 7. 打卡页
 * ======================================================================== */

function CheckinScreen({ token, status, refresh, notify, onLogout }) {
  const [left, setLeft] = useState(0);
  const [confirmHabit, setConfirmHabit] = useState(null);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    if (!status) return undefined;
    const target = Date.now() + (status.secondsUntilDeadline || 0) * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((target - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [status]);

  if (!status) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={C.cyan} />
        </View>
      </SafeAreaView>
    );
  }

  const doCheckin = async () => {
    if (!confirmHabit) return;
    setCheckinBusy(true);
    try {
      const data = await api(`/api/habits/${confirmHabit.id}/checkin`, { method: 'POST', token });
      setConfirmHabit(null);
      await refresh();
      notify(data.alreadyCheckedIn ? '这个习惯今天已经打过卡了' : `打卡成功！${randomQuote()}`);
    } catch (err) {
      setConfirmHabit(null);
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setCheckinBusy(false);
    }
  };

  const buyCard = async () => {
    setBuying(true);
    try {
      const data = await api('/api/shop/makeup-card', { method: 'POST', token, body: { quantity: 1 } });
      await refresh();
      notify(`兑换成功，补签卡 ${data.makeupCards} 张`);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setBuying(false);
    }
  };

  const removeHabit = (habit) => {
    setEditing(null);
    api(`/api/habits/${habit.id}`, { method: 'DELETE', token })
      .then(() => {
        notify('已删除该习惯');
        refresh();
      })
      .catch((err) => notify(err.message, 'error'));
  };

  const active = status.habits.filter((h) => h.isActiveToday);
  const rest = status.habits.filter((h) => !h.isActiveToday);
  const accent = STATUS_COLOR[status.status] || C.cyan;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
            tintColor={C.cyan}
            colors={[C.cyan]}
          />
        }
      >
        <View style={styles.pageHead}>
          <View>
            <Text style={styles.pageTitle}>今日打卡</Text>
            <Text style={styles.pageSub}>UTC+8 · {status.today}</Text>
          </View>
          <Tag text={status.isSkipDay ? 'HOLIDAY' : `${status.todayDoneCount}/${status.todayActiveCount}`} color={status.isSkipDay ? C.purple : C.cyan} />
        </View>

        <NeonCard glow={accent}>
          <View style={styles.heroTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroLabel}>DAILY STATUS</Text>
              <Text style={[styles.heroStatus, { color: accent }]}>{STATUS_TEXT[status.status] || status.status}</Text>
              <Text style={styles.heroLine}>
                {status.todayActiveCount > 0 ? `今日 ${status.todayDoneCount}/${status.todayActiveCount} 个习惯` : '今天没有生效的习惯'}
              </Text>
              {status.todayActiveCount > 0 && status.status !== 'done' && status.status !== 'late' ? (
                <Text style={styles.countdown}>
                  {status.deadlinePassed ? '已过截止时间' : `最近截止还剩 ${formatCountdown(left)}`}
                </Text>
              ) : null}
            </View>
            <View style={styles.streakBox}>
              <Text style={styles.streakNum}>{status.streak}</Text>
              <Text style={styles.streakLabel}>STREAK</Text>
            </View>
          </View>

          <View style={styles.heroStats}>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatK}>积分</Text>
              <Text style={styles.heroStatV}>{status.points}</Text>
            </View>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatK}>请假额度</Text>
              <Text style={styles.heroStatV}>{status.leaveBalance}/3</Text>
            </View>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatK}>补签卡</Text>
              <Text style={styles.heroStatV}>{status.makeupCards}</Text>
            </View>
          </View>
        </NeonCard>

        {status.nudges && status.nudges.length > 0 ? (
          <View style={styles.nudgeBanner}>
            <Text style={styles.nudgeText}>{status.nudges.map((n) => n.from).join('、')} 催你打卡了。</Text>
          </View>
        ) : null}

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>今日习惯</Text>
          <Pressable onPress={() => { setEditing(null); setFormVisible(true); }}>
            <Text style={styles.linkText}>+ 新建</Text>
          </Pressable>
        </View>

        {active.map((habit) => (
          <View key={habit.id} style={[styles.habitCard, habit.checkedIn && styles.habitCardDone]}>
            <View style={styles.habitTop}>
              <Text style={styles.habitEmoji}>{habit.emoji}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.habitName}>{habit.name}</Text>
                <Text style={styles.habitMeta}>
                  {weekdaysText(habit.activeDays)} · {habit.deadlineTime} 截止 · 连 {habit.streak} 天
                </Text>
              </View>
              <Pressable onPress={() => { setEditing(habit); setFormVisible(true); }} hitSlop={8}>
                <Text style={styles.habitEdit}>编辑</Text>
              </Pressable>
            </View>

            <View style={styles.habitBottom}>
              {habit.checkedIn ? (
                <Tag text={habit.late ? '迟到打卡' : '已打卡'} color={habit.late ? C.yellow : C.green} />
              ) : (
                <>
                  <Tag text={habit.deadlinePassed ? '已过截止' : '待打卡'} color={habit.deadlinePassed ? C.red : C.cyan} />
                  <NeonButton
                    label="打卡"
                    small
                    disabled={!habit.canCheckin}
                    onPress={() => setConfirmHabit(habit)}
                    style={{ minWidth: 88 }}
                  />
                </>
              )}
            </View>
          </View>
        ))}

        {active.length === 0 ? (
          <Text style={styles.emptyText}>今天没有生效的习惯，休息一下。</Text>
        ) : null}

        {rest.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 18 }]}>今日休息</Text>
            {rest.map((habit) => (
              <View key={habit.id} style={[styles.habitCard, styles.habitCardRest]}>
                <View style={styles.habitTop}>
                  <Text style={[styles.habitEmoji, { opacity: 0.5 }]}>{habit.emoji}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.habitName, { color: C.muted }]}>{habit.name}</Text>
                    <Text style={styles.habitMeta}>{weekdaysText(habit.activeDays)} · 连 {habit.streak} 天</Text>
                  </View>
                  <Tag text="今日休息" color={C.muted} />
                </View>
              </View>
            ))}
          </>
        ) : null}

        <NeonCard style={{ marginTop: 18 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>积分商店</Text>
            <Text style={styles.cardHint}>补签卡 100 分 / 张</Text>
          </View>
          <Text style={styles.cardHint}>断签时自动消耗一张补签卡：连胜保留、不扣分。</Text>
          <View style={[styles.rowBetween, { marginTop: 12 }]}>
            <Text style={styles.shopBalance}>{status.points} 分</Text>
            <NeonButton
              label="兑换补签卡"
              small
              loading={buying}
              disabled={status.points < 100}
              onPress={buyCard}
            />
          </View>
        </NeonCard>

        <Text style={styles.tip}>打卡 +10 分 · 断签 -20 分 · 勋章：连续 7 天 🛡️，30 天 👑</Text>

        <ConfirmModal
          visible={Boolean(confirmHabit)}
          title="确认打卡"
          message={`今天是 ${beijingToday()}（北京时间），确定完成「${confirmHabit ? confirmHabit.name : ''}」吗？`}
          confirmText="确认打卡"
          loading={checkinBusy}
          onConfirm={doCheckin}
          onCancel={() => setConfirmHabit(null)}
        />

        <HabitFormModal
          visible={formVisible}
          habit={editing}
          token={token}
          notify={notify}
          onClose={() => setFormVisible(false)}
          onSaved={() => refresh()}
          onDelete={removeHabit}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ==========================================================================
 * 8. 排行榜（连胜 / 总次数 / 积分）
 * ======================================================================== */

const BOARDS = [
  { key: 'streak', label: '连胜榜' },
  { key: 'total', label: '总次数榜' },
  { key: 'points', label: '积分榜' },
];

function LeaderboardScreen({ token, active, notify, onLogout }) {
  const [board, setBoard] = useState('streak');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState('');

  const load = useCallback(
    async (silent) => {
      if (!silent) setLoading(true);
      try {
        const res = await api(`/api/leaderboard/${board}?limit=100`, { token });
        setData(res);
      } catch (err) {
        if (err.code === 'UNAUTHORIZED') return onLogout();
        notify(err.message, 'error');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [board, token, onLogout, notify]
  );

  useEffect(() => {
    if (active) load(false);
  }, [active, load]);

  const act = async (key, fn, text) => {
    setActing(key);
    try {
      await fn();
      notify(text);
      await load(true);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setActing('');
    }
  };

  const renderAction = (row) => {
    if (row.isMe) return null;
    if (row.todayStatus === 'done' || row.todayStatus === 'late') return <Tag text="已打卡" color={C.green} />;
    if (row.todayStatus === 'excused') return <Tag text="已请假" color={C.purple} />;
    if (row.todayStatus === 'rest') return <Tag text="休息" color={C.muted} />;

    if (row.friendship === 'accepted') {
      return (
        <NeonButton
          label="催一下"
          small
          loading={acting === `nudge-${row.userId}`}
          disabled={!row.canNudge}
          onPress={() =>
            act(
              `nudge-${row.userId}`,
              () => api(`/api/nudge/${encodeURIComponent(row.username)}`, { method: 'POST', token }),
              `已催 ${row.username} 打卡`
            )
          }
        />
      );
    }
    if (row.friendship === 'pending_out') return <Tag text="已申请" color={C.muted} />;
    if (row.friendship === 'pending_in') {
      return (
        <NeonButton
          label="同意"
          small
          loading={acting === `accept-${row.userId}`}
          onPress={() =>
            act(
              `accept-${row.userId}`,
              () => api('/api/friends/accept', { method: 'POST', token, body: { userId: row.userId } }),
              `你和 ${row.username} 已经是好友了`
            )
          }
        />
      );
    }
    return (
      <NeonButton
        label="加好友"
        small
        variant="outline"
        loading={acting === `add-${row.userId}`}
        onPress={() =>
          act(
            `add-${row.userId}`,
            () => api('/api/friends/request', { method: 'POST', token, body: { userId: row.userId } }),
            `已向 ${row.username} 发送好友申请`
          )
        }
      />
    );
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.boardHead}>
        <View>
          <Text style={styles.pageTitle}>排行榜</Text>
          <Text style={styles.pageSub}>{data ? `${data.typeLabel} · ${data.total} 人 · ${data.today}` : '加载中…'}</Text>
        </View>
      </View>

      <View style={[styles.segment, { marginHorizontal: 20, marginBottom: 12 }]}>
        {BOARDS.map((item) => (
          <Pressable
            key={item.key}
            style={[styles.segmentItem, board === item.key && styles.segmentItemActive]}
            onPress={() => setBoard(item.key)}
          >
            <Text style={[styles.segmentText, board === item.key && styles.segmentTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={C.cyan} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.boardList}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load(true);
              }}
              tintColor={C.cyan}
              colors={[C.cyan]}
            />
          }
        >
          {(data ? data.rows : []).map((row) => {
            const medal = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : null;
            return (
              <View key={row.userId} style={[styles.boardRow, row.isMe && styles.boardRowMe]}>
                <View style={styles.rankBox}>
                  {medal ? <Text style={styles.medal}>{medal}</Text> : <Text style={styles.rankNum}>{row.rank}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.nameRow}>
                    <Text style={styles.boardName} numberOfLines={1}>{row.username}</Text>
                    {(row.badges || []).map((b) => (
                      <Text key={b} style={styles.badgeEmoji}>{b}</Text>
                    ))}
                    {row.isMe ? <Tag text="我" /> : null}
                  </View>
                  <Text style={styles.boardMeta}>
                    连 {row.streak} 天 · 总 {row.totalCheckins} 次 · {row.points} 分
                  </Text>
                </View>
                <View style={styles.scoreBox}>
                  <Text style={styles.scoreNum}>{row.value}</Text>
                  <Text style={styles.scoreUnit}>{data ? data.unit : ''}</Text>
                </View>
                <View style={styles.actionBox}>{renderAction(row)}</View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/* ==========================================================================
 * 9. 个人主页
 * ======================================================================== */

const HEAT_COLORS = {
  done: C.green,
  excused: C.yellow,
  missed: C.dim,
  holiday: C.cyan,
  rest: '#1B2230',
  vacation: C.purple,
  pending: 'rgba(0,229,255,0.18)',
};

function ProfileScreen({ token, status, active, notify, onLogout }) {
  const [calendar, setCalendar] = useState(null);
  const [friends, setFriends] = useState(null);
  const [vacations, setVacations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [vacStart, setVacStart] = useState(beijingToday());
  const [vacEnd, setVacEnd] = useState(beijingToday());
  const [vacReason, setVacReason] = useState('');
  const [vacBusy, setVacBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cal, fw, vac] = await Promise.all([
        api('/api/user/calendar?days=30', { token }),
        api('/api/friends/list', { token }),
        api('/api/vacation/my', { token }),
      ]);
      setCalendar(cal);
      setFriends(fw);
      setVacations(vac.requests || []);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, onLogout, notify]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  if (!status) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={C.cyan} />
        </View>
      </SafeAreaView>
    );
  }

  const nudge = async (friend) => {
    setActing(`nudge-${friend.id}`);
    try {
      await api(`/api/nudge/${encodeURIComponent(friend.username)}`, { method: 'POST', token });
      notify(`已催 ${friend.username} 打卡`);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setActing('');
    }
  };

  const accept = async (req) => {
    setActing(`accept-${req.id}`);
    try {
      await api('/api/friends/accept', { method: 'POST', token, body: { userId: req.id } });
      notify(`已添加 ${req.username} 为好友`);
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setActing('');
    }
  };

  const cancelRequest = (req) => {
    setConfirm({
      title: '撤回好友申请',
      message: `确定撤回发给「${req.username}」的申请吗？`,
      confirmText: '撤回',
      onConfirm: async () => {
        setConfirm(null);
        setActing(`cancel-${req.id}`);
        try {
          await api('/api/friends/cancel', { method: 'POST', token, body: { userId: req.id } });
          notify('申请已撤回');
          await load();
        } catch (err) {
          notify(err.message, 'error');
        } finally {
          setActing('');
        }
      },
    });
  };

  const removeFriend = (friend) => {
    setConfirm({
      title: '删除好友',
      message: `确定删除好友「${friend.username}」吗？双方都会从好友列表中移除。`,
      confirmText: '删除',
      onConfirm: async () => {
        setConfirm(null);
        setActing(`delete-${friend.id}`);
        try {
          await api('/api/friends/delete', { method: 'POST', token, body: { userId: friend.id } });
          notify('已删除好友');
          await load();
        } catch (err) {
          notify(err.message, 'error');
        } finally {
          setActing('');
        }
      },
    });
  };

  const submitVacation = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vacStart) || !/^\d{4}-\d{2}-\d{2}$/.test(vacEnd)) {
      notify('日期格式应为 YYYY-MM-DD', 'error');
      return;
    }
    setVacBusy(true);
    try {
      const data = await api('/api/vacation', {
        method: 'POST',
        token,
        body: { startDate: vacStart, endDate: vacEnd, reason: vacReason },
      });
      notify(data.message);
      setVacReason('');
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setVacBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
            }}
            tintColor={C.cyan}
            colors={[C.cyan]}
          />
        }
      >
        <View style={styles.profileHead}>
          <View style={styles.profileAvatar}>
            <Text style={styles.profileAvatarText}>{String(status.user.username).slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{status.user.username}</Text>
            <Text style={styles.pageSub}>加入于 {shortDate(status.user.createdAt)}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {(status.badges || []).map((b) => (
              <Text key={b} style={styles.badgeEmoji}>{b}</Text>
            ))}
          </View>
        </View>

        <View style={styles.profileStats}>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatNum}>{status.streak}</Text>
            <Text style={styles.profileStatLabel}>连续</Text>
          </View>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatNum}>{status.bestStreak}</Text>
            <Text style={styles.profileStatLabel}>最佳</Text>
          </View>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatNum}>{status.totalCheckins}</Text>
            <Text style={styles.profileStatLabel}>累计</Text>
          </View>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatNum}>{status.points}</Text>
            <Text style={styles.profileStatLabel}>积分</Text>
          </View>
        </View>

        <NeonCard style={{ marginTop: 16 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>近 30 天</Text>
            {calendar ? <Text style={styles.cardHint}>{calendar.summary.done} 天完成</Text> : null}
          </View>
          {loading && !calendar ? (
            <ActivityIndicator color={C.cyan} style={{ marginVertical: 20 }} />
          ) : (
            <View style={styles.heatmap}>
              {(calendar ? calendar.items : []).map((item) => (
                <View
                  key={item.date}
                  style={[
                    styles.heatCell,
                    { backgroundColor: HEAT_COLORS[item.status] || C.dim, borderColor: item.isToday ? C.cyan : 'transparent' },
                  ]}
                />
              ))}
            </View>
          )}
          <View style={styles.legendRow}>
            {[['打卡', C.green], ['请假', C.yellow], ['漏签', C.dim], ['休息', '#1B2230'], ['免打卡', C.cyan]].map(([label, color]) => (
              <View key={label} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: color }]} />
                <Text style={styles.legendText}>{label}</Text>
              </View>
            ))}
          </View>
        </NeonCard>

        <NeonCard style={{ marginTop: 16 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>申请休假</Text>
            <Text style={styles.cardHint}>一次最多 3 天</Text>
          </View>
          <Text style={styles.cardHint}>休假期间不打卡也不断签；是否自动通过由管理员开关决定。</Text>
          <View style={[styles.inlineRow, { marginTop: 10 }]}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={vacStart}
              onChangeText={setVacStart}
              placeholder="开始 YYYY-MM-DD"
              placeholderTextColor={C.muted}
              maxLength={10}
            />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={vacEnd}
              onChangeText={setVacEnd}
              placeholder="结束 YYYY-MM-DD"
              placeholderTextColor={C.muted}
              maxLength={10}
            />
          </View>
          <TextInput
            style={[styles.input, { marginTop: 10 }]}
            value={vacReason}
            onChangeText={setVacReason}
            placeholder="理由（选填）"
            placeholderTextColor={C.muted}
            maxLength={200}
          />
          <NeonButton
            label="提交申请"
            small
            loading={vacBusy}
            onPress={submitVacation}
            style={{ marginTop: 12, alignSelf: 'flex-start' }}
          />

          {vacations.length > 0 ? (
            <View style={{ marginTop: 12 }}>
              {vacations.slice(0, 5).map((v) => (
                <View key={v.id} style={styles.friendRow}>
                  <Text style={styles.friendMeta}>{v.startDate} ~ {v.endDate}</Text>
                  <View style={{ flex: 1 }} />
                  <Tag
                    text={v.status === 'approved' ? '已通过' : v.status === 'pending' ? '待审批' : '已拒绝'}
                    color={v.status === 'approved' ? C.green : v.status === 'pending' ? C.yellow : C.red}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </NeonCard>

        <NeonCard style={{ marginTop: 16 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>我的好友</Text>
            <Text style={styles.cardHint}>{friends ? friends.friends.length : 0} 人</Text>
          </View>

          {friends && friends.incoming.length > 0 ? (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.requestTitle}>待处理申请</Text>
              {friends.incoming.map((req) => (
                <View key={req.id} style={styles.friendRow}>
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>{String(req.username).slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <Text style={styles.friendName} numberOfLines={1}>{req.username}</Text>
                  <NeonButton label="同意" small loading={acting === `accept-${req.id}`} onPress={() => accept(req)} />
                </View>
              ))}
            </View>
          ) : null}

          {friends && friends.outgoing && friends.outgoing.length > 0 ? (
            <View style={{ marginTop: 10 }}>
              <Text style={[styles.requestTitle, { color: C.muted }]}>我发出的申请</Text>
              {friends.outgoing.map((req) => (
                <View key={req.id} style={styles.friendRow}>
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>{String(req.username).slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <Text style={styles.friendName} numberOfLines={1}>{req.username}</Text>
                  <NeonButton
                    label="撤回"
                    small
                    variant="outline"
                    loading={acting === `cancel-${req.id}`}
                    onPress={() => cancelRequest(req)}
                  />
                </View>
              ))}
            </View>
          ) : null}

          {friends && friends.friends.length === 0 ? (
            <Text style={styles.emptyText}>还没有好友，去排行榜加几个。</Text>
          ) : null}

          {friends
            ? friends.friends.map((friend) => (
                <View key={friend.id} style={styles.friendRow}>
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>{String(friend.username).slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.friendName} numberOfLines={1}>{friend.username}</Text>
                    <Text style={styles.friendMeta}>
                      连 {friend.streak} 天 · {STATUS_BADGE[friend.todayStatus] || friend.todayStatus}
                    </Text>
                  </View>
                  {friend.canNudge ? (
                    <NeonButton label="催一下" small loading={acting === `nudge-${friend.id}`} onPress={() => nudge(friend)} />
                  ) : null}
                  <NeonButton
                    label="删除"
                    small
                    variant="outline"
                    loading={acting === `delete-${friend.id}`}
                    onPress={() => removeFriend(friend)}
                  />
                </View>
              ))
            : null}
        </NeonCard>

        <ConfirmModal
          visible={Boolean(confirm)}
          title={confirm ? confirm.title : ''}
          message={confirm ? confirm.message : ''}
          confirmText={confirm ? confirm.confirmText : '确认'}
          onConfirm={() => confirm && confirm.onConfirm()}
          onCancel={() => setConfirm(null)}
        />

        <NeonButton label="退出登录" variant="outline" onPress={onLogout} style={{ marginTop: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ==========================================================================
 * 10. Tab / 根组件
 * ======================================================================== */

const TABS = [
  { key: 'checkin', label: '打卡', icon: '⏱' },
  { key: 'leaderboard', label: '排行榜', icon: '📊' },
  { key: 'profile', label: '我的', icon: '👤' },
];

function TabBar({ tab, onChange }) {
  return (
    <View style={styles.tabBar}>
      {TABS.map((item) => {
        const active = tab === item.key;
        return (
          <Pressable
            key={item.key}
            style={({ pressed }) => [styles.tabItem, pressed && { opacity: 0.7 }]}
            onPress={() => onChange(item.key)}
          >
            <Text style={[styles.tabIcon, active && { opacity: 1 }]}>{item.icon}</Text>
            <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.label}</Text>
            {active ? <View style={styles.tabIndicator} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(null);
  const [tab, setTab] = useState('checkin');
  const [toast, setToast] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);  const [pwdVisible, setPwdVisible] = useState(false);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);

  const notify = useCallback((message, kind = 'info') => setToast({ message, kind, id: Date.now() }), []);
  const hideToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(TOKEN_KEY);
        if (saved) {
          const me = await api('/api/me', { token: saved });
          setToken(saved);
          setUser(me.user);
          setStatus(me.status);
        }
      } catch (err) {
        await AsyncStorage.removeItem(TOKEN_KEY);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const handleLogin = useCallback(async (nextToken, nextUser) => {
    await AsyncStorage.setItem(TOKEN_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setTab('checkin');
  }, []);

  const handleLogout = useCallback(async () => {
    await AsyncStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setStatus(null);
    try {
      await Notifications.cancelAllScheduledNotificationsAsync();
    } catch (err) {
      // ignore
    }
  }, []);

  const refreshStatus = useCallback(
    async (silent = true) => {
      if (!token) return null;
      try {
        const data = await api('/api/status', { token });
        setStatus(data);
        setUser(data.user);
        return data;
      } catch (err) {
        if (err.code === 'UNAUTHORIZED') handleLogout();
        else if (!silent) notify(err.message, 'error');
        return null;
      }
    },
    [token, notify, handleLogout]
  );

  useEffect(() => {
    if (!token) return undefined;
    refreshStatus(true);
    const timer = setInterval(() => refreshStatus(true), 30 * 1000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshStatus(true);
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [token, refreshStatus]);

  /* 通知：按 habits 的生效星期 + 截止时间重排 */
  useEffect(() => {
    if (!token || !status || !status.habits) return undefined;
    let cancelled = false;
    (async () => {
      const granted = await ensureNotificationPermission();
      if (!granted || cancelled) return;
      try {
        const count = await syncHabitNotifications(status.habits);
        if (count === 0) console.log('[notifications] 今天没有生效习惯，未注册提醒');
      } catch (err) {
        console.warn('[notifications] 注册失败', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 依赖：习惯的组合键变化时才重排通知
  }, [token, status && status.habits && status.habits.map((h) => `${h.id}:${h.deadlineTime}:${h.activeDays.join('')}`).join('|')]);

  useEffect(() => {
    if (!token) return undefined;
    const responseSub = Notifications.addNotificationResponseReceivedListener(() => {
      setTab('checkin');
      refreshStatus(true);
    });
    const receivedSub = Notifications.addNotificationReceivedListener(() => refreshStatus(true));
    return () => {
      responseSub.remove();
      receivedSub.remove();
    };
  }, [token, refreshStatus]);

  if (booting) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.center}>
          <Text style={styles.loginLogo}>⏰</Text>
          <ActivityIndicator color={C.cyan} style={{ marginTop: 12 }} />
        </View>
      </SafeAreaView>
    );
  }

  if (!token || !user) return <LoginScreen onLogin={handleLogin} />;

  const submitPassword = async () => {
    if (!oldPwd || newPwd.length < 6) {
      notify('请输入旧密码，新密码至少 6 位', 'error');
      return;
    }
    setPwdBusy(true);
    try {
      const data = await api('/api/user/change-password', {
        method: 'POST',
        token,
        body: { oldPassword: oldPwd, newPassword: newPwd },
      });
      if (data.token) {
        await AsyncStorage.setItem(TOKEN_KEY, data.token);
        setToken(data.token);
      }
      setPwdVisible(false);
      setOldPwd('');
      setNewPwd('');
      notify('密码已修改');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setPwdBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      {/* 顶部栏：点击头像展开菜单 */}
      <View style={styles.topBar}>
        <Text style={styles.topBrand}>拒绝摆烂</Text>
        <Pressable style={styles.topAvatar} onPress={() => setMenuOpen(true)} hitSlop={8}>
          <Text style={styles.topAvatarText}>{String(user.username || '?').slice(0, 1).toUpperCase()}</Text>
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'checkin' ? (
          <CheckinScreen token={token} status={status} refresh={refreshStatus} notify={notify} onLogout={handleLogout} />
        ) : null}
        {tab === 'leaderboard' ? (
          <LeaderboardScreen token={token} active notify={notify} onLogout={handleLogout} />
        ) : null}
        {tab === 'profile' ? (
          <ProfileScreen token={token} status={status} active notify={notify} onLogout={handleLogout} />
        ) : null}
      </View>

      <TabBar tab={tab} onChange={setTab} />

      {/* 个人中心下拉菜单 */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuCard}>
            <Text style={styles.menuName} numberOfLines={1}>{user.username}</Text>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                setTab('profile');
              }}
            >
              <Text style={styles.menuText}>个人主页</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                setPwdVisible(true);
              }}
            >
              <Text style={styles.menuText}>修改密码</Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                handleLogout();
              }}
            >
              <Text style={[styles.menuText, { color: C.red }]}>退出登录</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* 修改密码 */}
      <Modal visible={pwdVisible} transparent animationType="fade" onRequestClose={() => setPwdVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalGlowLine} />
            <Text style={styles.modalTitle}>修改密码</Text>
            <Text style={styles.label}>旧密码</Text>
            <TextInput
              style={styles.input}
              value={oldPwd}
              onChangeText={setOldPwd}
              placeholder="当前密码"
              placeholderTextColor={C.muted}
              secureTextEntry
            />
            <Text style={styles.label}>新密码</Text>
            <TextInput
              style={styles.input}
              value={newPwd}
              onChangeText={setNewPwd}
              placeholder="至少 6 位"
              placeholderTextColor={C.muted}
              secureTextEntry
            />
            <View style={styles.modalActions}>
              <NeonButton label="取消" variant="outline" small onPress={() => setPwdVisible(false)} style={{ flex: 1 }} />
              <NeonButton label="确认修改" small loading={pwdBusy} onPress={submitPassword} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>

      <BlockingModal
        visible={Boolean(status && status.blocked)}
        status={status}
        token={token}
        onExcused={(nextStatus, usedLeave) => {
          setStatus(nextStatus);
          notify(usedLeave ? '请假成功，连胜保住了' : '借口已提交（无额度，本次不保连胜）');
        }}
        onExpired={handleLogout}
      />

      <Toast toast={toast} onHide={hideToast} />
    </View>
  );
}

/* ==========================================================================
 * 11. 样式
 * ======================================================================== */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 6 : 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.lineSoft,
    backgroundColor: C.bgSoft,
  },
  topBrand: { color: C.text, fontSize: 15, fontWeight: '900', letterSpacing: 3, textShadowColor: C.cyan, textShadowRadius: 10 },
  topAvatar: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.cyan,
    shadowColor: C.cyan,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  topAvatarText: { color: '#04070E', fontSize: 14, fontWeight: '900' },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(4,7,14,0.55)', alignItems: 'flex-end', paddingTop: 58, paddingRight: 16 },
  menuCard: {
    width: 190,
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(0,229,255,0.45)',
    paddingVertical: 8,
    shadowColor: C.cyan,
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 14,
  },
  menuName: { color: C.muted, fontSize: 11, fontFamily: MONO, paddingHorizontal: 16, paddingVertical: 8 },
  menuItem: { paddingHorizontal: 16, paddingVertical: 12 },
  menuText: { color: C.text, fontSize: 14, fontWeight: '600' },
  menuDivider: { height: 1, backgroundColor: C.lineSoft, marginVertical: 4 },
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  page: { padding: 20, paddingBottom: 34 },

  card: {
    backgroundColor: C.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.line,
    padding: 18,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },

  btn: { borderRadius: 13, paddingVertical: 13, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10 },
  btnSolid: { backgroundColor: C.cyan, shadowColor: C.cyan, shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 8 },
  btnOutline: { borderColor: C.cyan + '88', backgroundColor: 'rgba(0,229,255,0.06)' },
  btnDanger: { backgroundColor: C.red },
  btnDisabled: { opacity: 0.38, shadowOpacity: 0, elevation: 0 },
  btnPressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  btnText: { color: C.text, fontWeight: '800', fontSize: 15, letterSpacing: 1 },
  btnTextSmall: { fontSize: 12, letterSpacing: 0.6 },
  btnTextSolid: { color: '#04070E' },

  tag: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start' },
  tagText: { fontSize: 10, fontWeight: '800', letterSpacing: 1, fontFamily: MONO },

  label: { color: C.muted, fontSize: 11, letterSpacing: 1.4, marginTop: 14, marginBottom: 7, fontFamily: MONO },
  input: {
    backgroundColor: 'rgba(10,14,23,0.9)',
    borderWidth: 1,
    borderColor: C.lineSoft,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: C.text,
    fontSize: 15,
  },
  textarea: { minHeight: 92, textAlignVertical: 'top' },
  emojiInput: { width: 54, textAlign: 'center', fontSize: 20 },
  timeInput: { textAlign: 'center', fontSize: 20, letterSpacing: 4, fontFamily: MONO },
  errorText: { color: C.red, fontSize: 12, marginTop: 10, fontFamily: MONO },
  linkText: { color: C.cyan, fontSize: 13, fontWeight: '700' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '800' },
  cardHint: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  tip: { color: C.muted, fontSize: 11, textAlign: 'center', marginTop: 16, lineHeight: 17 },

  loginWrap: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  loginHead: { alignItems: 'center', marginBottom: 24 },
  loginLogo: { fontSize: 44, textShadowColor: C.cyan, textShadowRadius: 18 },
  loginTitle: { color: C.text, fontSize: 30, fontWeight: '900', letterSpacing: 10, marginTop: 10, textShadowColor: C.cyan, textShadowRadius: 16 },
  loginSub: { color: C.muted, fontSize: 10, letterSpacing: 4, marginTop: 8, fontFamily: MONO },
  serverHint: { color: C.muted, fontSize: 10, textAlign: 'center', marginTop: 18, fontFamily: MONO },

  segment: { flexDirection: 'row', backgroundColor: 'rgba(0,229,255,0.05)', borderWidth: 1, borderColor: C.lineSoft, borderRadius: 11, padding: 4 },
  segmentItem: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segmentItemActive: { backgroundColor: 'rgba(0,229,255,0.14)' },
  segmentText: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  segmentTextActive: { color: C.cyan },

  pageHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 },
  pageTitle: { color: C.text, fontSize: 22, fontWeight: '900', letterSpacing: 2 },
  pageSub: { color: C.muted, fontSize: 10, marginTop: 6, fontFamily: MONO },

  heroTop: { flexDirection: 'row', alignItems: 'flex-start' },
  heroLabel: { color: C.muted, fontSize: 10, letterSpacing: 3, fontFamily: MONO },
  heroStatus: { fontSize: 26, fontWeight: '900', marginTop: 10, textShadowRadius: 18 },
  heroLine: { color: C.muted, fontSize: 11, marginTop: 8, fontFamily: MONO },
  countdown: { color: C.text, fontSize: 13, marginTop: 10, fontWeight: '600', fontFamily: MONO },
  streakBox: { alignItems: 'center', paddingLeft: 10 },
  streakNum: { color: C.cyan, fontSize: 46, fontWeight: '900', fontFamily: MONO, lineHeight: 50, textShadowColor: C.cyan, textShadowRadius: 20 },
  streakLabel: { color: C.muted, fontSize: 9, letterSpacing: 2, marginTop: 2, fontFamily: MONO },
  heroStats: { flexDirection: 'row', marginTop: 16, borderTopWidth: 1, borderTopColor: C.lineSoft, paddingTop: 14 },
  heroStat: { flex: 1 },
  heroStatK: { color: C.muted, fontSize: 10, letterSpacing: 1.2, fontFamily: MONO },
  heroStatV: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 4, fontFamily: MONO },

  nudgeBanner: { backgroundColor: 'rgba(255,92,122,0.1)', borderWidth: 1, borderColor: 'rgba(255,92,122,0.45)', borderRadius: 12, padding: 12, marginTop: 12 },
  nudgeText: { color: '#FFC2CE', fontSize: 12 },

  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 10 },
  sectionTitle: { color: C.text, fontSize: 14, fontWeight: '800', letterSpacing: 1.5 },
  habitCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.lineSoft, borderRadius: 14, padding: 14, marginBottom: 10 },
  habitCardDone: { borderColor: 'rgba(57,255,136,0.35)', backgroundColor: 'rgba(57,255,136,0.05)' },
  habitCardRest: { backgroundColor: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.04)' },
  habitTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  habitEmoji: { fontSize: 22 },
  habitName: { color: C.text, fontSize: 15, fontWeight: '700' },
  habitMeta: { color: C.muted, fontSize: 10, marginTop: 3, fontFamily: MONO },
  habitEdit: { color: C.cyan, fontSize: 11, fontFamily: MONO },
  habitBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },

  emptyText: { color: C.muted, fontSize: 12, textAlign: 'center', paddingVertical: 20, lineHeight: 20 },
  shopBalance: { color: C.cyan, fontSize: 20, fontWeight: '900', fontFamily: MONO },

  weekRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  weekChip: { width: 40, height: 40, borderRadius: 10, borderWidth: 1, borderColor: C.lineSoft, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.03)' },
  weekChipActive: { borderColor: C.cyan, backgroundColor: 'rgba(0,229,255,0.16)', shadowColor: C.cyan, shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 0 }, elevation: 6 },
  weekChipText: { color: C.muted, fontSize: 13, fontWeight: '700' },
  weekChipTextActive: { color: C.cyan },
  formHint: { color: C.muted, fontSize: 10, marginTop: 8, lineHeight: 15 },
  formCard: { maxHeight: '86%' },

  boardHead: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  boardList: { paddingHorizontal: 20, paddingBottom: 24 },
  boardRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.lineSoft, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 12, marginBottom: 10 },
  boardRowMe: { borderColor: C.cyan, backgroundColor: 'rgba(0,229,255,0.07)', shadowColor: C.cyan, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 5 },
  rankBox: { width: 28, alignItems: 'center' },
  medal: { fontSize: 19 },
  rankNum: { color: C.muted, fontSize: 15, fontWeight: '800', fontFamily: MONO },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  boardName: { color: C.text, fontSize: 15, fontWeight: '700', maxWidth: 110 },
  badgeEmoji: { fontSize: 13 },
  boardMeta: { color: C.muted, fontSize: 10, marginTop: 3, fontFamily: MONO },
  scoreBox: { alignItems: 'center', minWidth: 40 },
  scoreNum: { color: C.cyan, fontSize: 19, fontWeight: '900', fontFamily: MONO, textShadowColor: C.cyan, textShadowRadius: 10 },
  scoreUnit: { color: C.muted, fontSize: 9, fontFamily: MONO },
  actionBox: { minWidth: 76, alignItems: 'flex-end' },

  profileHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  profileAvatar: { width: 50, height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: C.cyan, shadowColor: C.cyan, shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 8 },
  profileAvatarText: { color: '#04070E', fontSize: 21, fontWeight: '900' },
  profileName: { color: C.text, fontSize: 19, fontWeight: '800' },
  profileStats: { flexDirection: 'row', gap: 8 },
  profileStat: { flex: 1, backgroundColor: C.cardSoft, borderWidth: 1, borderColor: C.lineSoft, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  profileStatNum: { color: C.cyan, fontSize: 18, fontWeight: '900', fontFamily: MONO },
  profileStatLabel: { color: C.muted, fontSize: 9, marginTop: 4, letterSpacing: 1.2, fontFamily: MONO },

  heatmap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14, gap: 6 },
  heatCell: { width: 34, height: 34, borderRadius: 8, borderWidth: 1 },
  legendRow: { flexDirection: 'row', gap: 12, marginTop: 12, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 3 },
  legendText: { color: C.muted, fontSize: 9, fontFamily: MONO },

  requestTitle: { color: C.purple, fontSize: 11, letterSpacing: 1.2, fontFamily: MONO, marginBottom: 4 },
  friendRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  friendAvatar: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,229,255,0.14)', borderWidth: 1, borderColor: C.line },
  friendAvatarText: { color: C.cyan, fontSize: 12, fontWeight: '800' },
  friendName: { color: C.text, fontSize: 14, fontWeight: '600' },
  friendMeta: { color: C.muted, fontSize: 10, marginTop: 2, fontFamily: MONO },

  tabBar: { flexDirection: 'row', backgroundColor: C.bgSoft, borderTopWidth: 1, borderTopColor: C.lineSoft, paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 24 : 10, paddingHorizontal: 10 },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabIcon: { fontSize: 18, opacity: 0.5 },
  tabLabel: { color: C.muted, fontSize: 10, letterSpacing: 0.8, fontFamily: MONO },
  tabLabelActive: { color: C.cyan },
  tabIndicator: { position: 'absolute', top: -8, width: 22, height: 2, borderRadius: 2, backgroundColor: C.cyan, shadowColor: C.cyan, shadowOpacity: 1, shadowRadius: 8, shadowOffset: { width: 0, height: 0 }, elevation: 4 },

  toastBox: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 58 : (RNStatusBar.currentHeight || 0) + 12,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(18,22,31,0.97)',
    borderWidth: 1,
    borderColor: 'rgba(0,229,255,0.55)',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    shadowColor: C.cyan,
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
    zIndex: 80,
  },
  toastError: { borderColor: 'rgba(255,92,122,0.7)', shadowColor: C.red },
  toastDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.cyan },
  toastText: { color: C.text, fontSize: 13, flex: 1, lineHeight: 19, fontWeight: '600' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(4,7,14,0.88)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 380, backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(0,229,255,0.5)', padding: 22, shadowColor: C.cyan, shadowOpacity: 0.35, shadowRadius: 26, shadowOffset: { width: 0, height: 0 }, elevation: 14 },
  modalGlowLine: { position: 'absolute', top: 0, left: 22, right: 22, height: 2, borderRadius: 2, backgroundColor: C.cyan },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '900', letterSpacing: 1.2, marginTop: 4 },
  modalMessage: { color: C.muted, fontSize: 13, lineHeight: 21, marginTop: 10 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 20 },

  blockSafe: { flex: 1, backgroundColor: '#100812' },
  blockWrap: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  blockEmoji: { fontSize: 44, textAlign: 'center' },
  blockTitle: { color: '#fff', fontSize: 22, fontWeight: '900', textAlign: 'center', marginTop: 14 },
  blockDesc: { color: '#FFB3C1', fontSize: 12, lineHeight: 20, textAlign: 'center', marginTop: 12 },
  blockCard: { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,92,122,0.45)', padding: 18, marginTop: 20 },
  blockFoot: { color: C.muted, fontSize: 10, textAlign: 'center', marginTop: 12, lineHeight: 16 },
  deleteLink: { alignItems: 'center', marginTop: 10 },
  deleteText: { color: C.red, fontSize: 12, fontFamily: MONO },
});
