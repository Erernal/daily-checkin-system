/**
 * 不拖延 · 防拖延强制打卡系统 —— 移动端 v2.0（赛博朋克版）
 * ---------------------------------------------------------------------------
 *  Expo SDK 58 / React Native 0.88
 *
 *  本文件包含：
 *   · 赛博科技风主题（深色底 + 霓虹发光边框 + 等宽数字）
 *   · 强制北京时间：所有“今天”都通过 Intl.DateTimeFormat 按 Asia/Shanghai 生成
 *   · 二次确认弹窗（自定义 Modal）+ 顶部滑入 Toast + 随机励志语录
 *   · 底部三 Tab：打卡 / 排行榜 / 个人主页
 *   · 排行榜 总榜/周榜/月榜，前三名奖牌，自己高亮，加好友 / 催一下
 *   · 个人主页 30 天热力图 + 好友列表 + 好友申请
 *   · 每日系统强通知 + 超时全屏阻断（必须填借口）
 *
 *  运行前：在 app/.env 里配置 EXPO_PUBLIC_API_BASE=http://<你的服务器>:3000
 * ---------------------------------------------------------------------------
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
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

/* ==========================================================================
 * 0. 配置与主题
 * ======================================================================== */

const FALLBACK_API_BASE = 'http://localhost:3000';

const API_BASE = (
  process.env.EXPO_PUBLIC_API_BASE ||
  (Constants.expoConfig && Constants.expoConfig.extra && Constants.expoConfig.extra.apiBase) ||
  FALLBACK_API_BASE
).replace(/\/+$/, '');

const TOKEN_KEY = 'qiangzhi.token';
const CHANNEL_ID = 'checkin-reminder';
const PRE_REMINDER_MINUTES = 15;

const DAILY_TRIGGER =
  (Notifications.SchedulableTriggerInputTypes && Notifications.SchedulableTriggerInputTypes.DAILY) ||
  'daily';
const TIME_INTERVAL_TRIGGER =
  (Notifications.SchedulableTriggerInputTypes &&
    Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL) ||
  'timeInterval';

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
  '你不是没时间，你只是不想开始。',
  '完成比完美更重要。',
  '每一次按时打卡，都是给未来的自己投票。',
  '别等状态好，先开始，状态就会好。',
  '今天的一小步，是连胜的一大步。',
  '你比自己想象的更能坚持。',
  '把“等会儿”换成“现在”。',
  '打卡不是形式，是对自己的承诺。',
  '连赢不是运气，是每天的选择。',
  '拖延的代价，永远比行动更高。',
];

const STATUS_TEXT = {
  pending: '等待打卡',
  done: '今日已打卡',
  late: '迟到打卡',
  excused: '已请假',
  missed: '已漏签',
  holiday: '免打卡日',
};

const STATUS_COLOR = {
  pending: C.cyan,
  done: C.green,
  late: C.yellow,
  excused: C.purple,
  missed: C.red,
  holiday: C.cyan,
};

const STATUS_BADGE = {
  done: '已打卡',
  late: '迟到',
  excused: '已请假',
  missed: '漏签',
  pending: '待打卡',
  holiday: '免打卡',
};

/* ==========================================================================
 * 1. 工具函数
 * ======================================================================== */

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 强制北京时间 YYYY-MM-DD
 * 用 Intl.DateTimeFormat 指定 timeZone，绝不依赖手机本地时区；
 * 极端情况下（老引擎缺少 tz 数据）退回 UTC+8 手算，保证不出现“本地日期”。
 */
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
    const text = fmt.format(now);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  } catch (err) {
    // 忽略，走兜底
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
  if (h > 0) return `${h}h ${pad2(m)}m`;
  return `${pad2(m)}m ${pad2(sec)}s`;
}

function shortDate(isoText) {
  if (!isoText) return '—';
  return String(isoText).slice(0, 10);
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
    const error = new Error(data.message || '登录已过期，请重新登录');
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
 * 2. 通知（系统级强提醒）
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

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: '打卡强提醒',
    description: '每天到点提醒你完成打卡',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 300, 200, 300],
    lightColor: C.cyan,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
    enableVibrate: true,
    sound: 'default',
  });
}

async function ensureNotificationPermission() {
  try {
    await ensureAndroidChannel();
    const current = await Notifications.getPermissionsAsync();
    const provisional =
      current.ios && current.ios.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (current.granted || provisional) return true;

    const requested = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    return Boolean(
      requested.granted ||
        (requested.ios && requested.ios.status === Notifications.IosAuthorizationStatus.PROVISIONAL)
    );
  } catch (err) {
    console.warn('[notifications] 权限申请失败', err);
    return false;
  }
}

async function scheduleDailyReminder(deadline) {
  if (!deadline || !/^\d{2}:\d{2}$/.test(deadline)) return [];
  const [hour, minute] = deadline.split(':').map(Number);
  const androidTrigger = Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {};

  await Notifications.cancelAllScheduledNotificationsAsync();
  const ids = [];

  if (PRE_REMINDER_MINUTES > 0) {
    const preTotal = (hour * 60 + minute - PRE_REMINDER_MINUTES + 1440) % 1440;
    ids.push(
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `还有 ${PRE_REMINDER_MINUTES} 分钟截止`,
          body: `今天还没打卡，${deadline} 前不打卡就要写借口了。`,
          sound: true,
          priority: Notifications.AndroidNotificationPriority.HIGH,
          interruptionLevel: 'timeSensitive',
          data: { screen: 'checkin' },
        },
        trigger: {
          type: DAILY_TRIGGER,
          hour: Math.floor(preTotal / 60),
          minute: preTotal % 60,
          ...androidTrigger,
        },
      })
    );
  }

  ids.push(
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '该打卡了！',
        body: `已经到 ${deadline}，再不打卡就要填借口了。点我立刻打卡。`,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        interruptionLevel: 'timeSensitive',
        data: { screen: 'checkin' },
      },
      trigger: { type: DAILY_TRIGGER, hour, minute, ...androidTrigger },
    })
  );

  return ids;
}

async function sendTestNotification() {
  const granted = await ensureNotificationPermission();
  if (!granted) return false;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '测试提醒 ✅',
      body: '通知链路正常，到点我会这样叫你。',
      sound: true,
      priority: Notifications.AndroidNotificationPriority.MAX,
    },
    trigger: {
      type: TIME_INTERVAL_TRIGGER,
      seconds: 5,
      ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
    },
  });
  return true;
}

/* ==========================================================================
 * 3. 通用 UI 组件（赛博风）
 * ======================================================================== */

function NeonCard({ children, style, glow = C.cyan }) {
  return (
    <View style={[styles.card, { shadowColor: glow }, style]}>
      {children}
    </View>
  );
}

function NeonButton({
  label,
  onPress,
  variant = 'solid',
  disabled = false,
  loading = false,
  small = false,
  style,
}) {
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
        <ActivityIndicator color={solid ? '#04070E' : C.cyan} size="small" />
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
    }, 3000);

    return () => clearTimeout(timer);
  }, [toast, translateY, opacity, onHide]);

  if (!toast) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.toastBox,
        toast.kind === 'error' && styles.toastError,
        { opacity, transform: [{ translateY }] },
      ]}
    >
      <View style={[styles.toastDot, toast.kind === 'error' && { backgroundColor: C.red }]} />
      <Text style={styles.toastText} numberOfLines={3}>
        {toast.message}
      </Text>
    </Animated.View>
  );
}

function ConfirmModal({
  visible,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  loading = false,
  onConfirm,
  onCancel,
}) {
  const scale = useRef(new Animated.Value(0.9)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    scale.setValue(0.9);
    opacity.setValue(0);
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, friction: 7, tension: 90, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start();
  }, [visible, scale, opacity]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <Animated.View style={[styles.modalCard, { opacity, transform: [{ scale }] }]}>
          <View style={styles.modalGlowLine} />
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalMessage}>{message}</Text>
          <View style={styles.modalActions}>
            <NeonButton label={cancelText} variant="outline" small onPress={onCancel} style={styles.modalBtn} />
            <NeonButton
              label={confirmText}
              small
              loading={loading}
              onPress={onConfirm}
              style={styles.modalBtn}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

/* ==========================================================================
 * 4. 强制阻断遮罩
 * ======================================================================== */

function BlockingModal({ visible, status, token, onExcused, onExpired }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const blockDate = status ? status.blockDate : null;
  const missedToday = blockDate === (status && status.today);

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
        body: { reason: reason.trim(), date: blockDate },
      });
      setReason('');
      onExcused(data.status);
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
            {missedToday ? '今天的打卡时间已经过了' : '你昨天漏签了'}
          </Text>
          <Text style={styles.blockDesc}>
            {blockDate} 没有打卡记录，也没有请假。{'\n'}
            写个借口才能继续使用 —— 这次记作请假：连胜既不加，也不清零。
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

            <NeonButton
              label="提交借口，解锁使用"
              variant="danger"
              loading={busy}
              onPress={submit}
              style={{ marginTop: 18 }}
            />
            <Text style={styles.blockFoot}>
              不想写借口？去网页端也躲不掉，下次记得按时打卡。
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/* ==========================================================================
 * 5. 登录页
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
      const path = mode === 'login' ? '/api/login' : '/api/register';
      const data = await api(path, {
        method: 'POST',
        body: { username: username.trim(), password },
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
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled">
          <View style={styles.loginHead}>
            <Text style={styles.loginLogo}>⏰</Text>
            <Text style={styles.loginTitle}>不拖延</Text>
            <Text style={styles.loginSub}>CHECK-IN OR EXCUSE</Text>
          </View>

          <NeonCard style={styles.loginCard}>
            <View style={styles.segment}>
              <Pressable
                style={[styles.segmentItem, mode === 'login' && styles.segmentItemActive]}
                onPress={() => setMode('login')}
              >
                <Text style={[styles.segmentText, mode === 'login' && styles.segmentTextActive]}>
                  登录
                </Text>
              </Pressable>
              <Pressable
                style={[styles.segmentItem, mode === 'register' && styles.segmentItemActive]}
                onPress={() => setMode('register')}
              >
                <Text style={[styles.segmentText, mode === 'register' && styles.segmentTextActive]}>
                  注册
                </Text>
              </Pressable>
            </View>

            <Text style={styles.label}>用户名</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="2-24 位字母、数字或中文"
              placeholderTextColor={C.muted}
              autoCapitalize="none"
              autoCorrect={false}
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
              style={{ marginTop: 22 }}
            />
          </NeonCard>

          <Text style={styles.serverHint}>{API_BASE}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ==========================================================================
 * 6. 打卡页
 * ======================================================================== */

function CheckinScreen({ token, status, refresh, notify, onLogout }) {
  const [left, setLeft] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [deadlineDraft, setDeadlineDraft] = useState('');
  const [savingDeadline, setSavingDeadline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const todayText = status ? status.today : beijingToday();

  useEffect(() => {
    if (status && status.deadline) setDeadlineDraft(status.deadline);
  }, [status && status.deadline]);

  useEffect(() => {
    if (!status) return undefined;
    const target = Date.now() + (status.secondsUntilDeadline || 0) * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((target - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [status]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const doCheckin = async () => {
    setCheckinBusy(true);
    try {
      const data = await api('/api/checkin', { method: 'POST', token, body: {} });
      setConfirmOpen(false);
      await refresh();
      if (data.alreadyCheckedIn) {
        notify('今天已经打过卡了，别重复刷。');
      } else {
        notify(`打卡成功！${randomQuote()}`);
      }
    } catch (err) {
      setConfirmOpen(false);
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setCheckinBusy(false);
    }
  };

  const saveDeadline = async () => {
    const value = deadlineDraft.trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
      notify('时间格式应为 HH:MM，例如 22:30', 'error');
      return;
    }
    setSavingDeadline(true);
    try {
      await api('/api/settings', { method: 'PUT', token, body: { deadline: value } });
      await refresh();
      const granted = await ensureNotificationPermission();
      if (granted) await scheduleDailyReminder(value);
      notify(`已保存，每天 ${value}（北京时间）提醒你`);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setSavingDeadline(false);
    }
  };

  const testNotify = async () => {
    const ok = await sendTestNotification();
    notify(ok ? '5 秒后你会收到测试通知，请退到桌面观察' : '没有通知权限，请到系统设置里开启', ok ? 'info' : 'error');
  };

  if (!status) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={C.cyan} />
          <Text style={styles.mutedText}>正在同步打卡状态…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const state = status.status;
  const accent = STATUS_COLOR[state] || C.cyan;
  const checkedIn = status.checkedIn;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.cyan} colors={[C.cyan]} />
        }
      >
        <View style={styles.pageHead}>
          <View>
            <Text style={styles.pageTitle}>今日打卡</Text>
            <Text style={styles.pageSub}>UTC+8 · {todayText}</Text>
          </View>
          <Tag text={status.isSkipDay ? 'HOLIDAY' : 'LIVE'} color={status.isSkipDay ? C.purple : C.cyan} />
        </View>

        {status.isSkipDay ? (
          <View style={styles.holidayBanner}>
            <Text style={styles.holidayIcon}>✦</Text>
            <Text style={styles.holidayText}>
              今天是免打卡日，不打也不会断签，连胜保持 {status.streak} 天。
            </Text>
          </View>
        ) : null}

        {status.nudges && status.nudges.length > 0 ? (
          <View style={styles.nudgeBanner}>
            <Text style={styles.nudgeText}>
              {status.nudges.map((n) => n.from).join('、')} 催你打卡了，别装没看见。
            </Text>
          </View>
        ) : null}

        <NeonCard style={styles.heroCard} glow={accent}>
          <View style={styles.heroTop}>
            <View style={styles.flex}>
              <Text style={styles.heroLabel}>DAILY STATUS</Text>
              <Text style={[styles.heroStatus, { color: accent, textShadowColor: accent }]}>
                {STATUS_TEXT[state] || state}
              </Text>
              <Text style={styles.heroLine}>
                截止 {status.deadline} · 北京时间
              </Text>
              {!checkedIn && state !== 'excused' && state !== 'holiday' ? (
                <Text style={styles.countdown}>
                  {status.deadlinePassed ? '已超过截止时间，需要写借口' : `还剩 ${formatCountdown(left)}`}
                </Text>
              ) : (
                <Text style={styles.countdown}>
                  {state === 'holiday' ? '今天可以休息' : checkedIn ? '已打卡，明天见' : '已请假'}
                </Text>
              )}
            </View>
            <View style={styles.streakBox}>
              <Text style={styles.streakNum}>{status.streak}</Text>
              <Text style={styles.streakLabel}>STREAK</Text>
            </View>
          </View>

          <View style={styles.heroStats}>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatK}>最佳</Text>
              <Text style={styles.heroStatV}>{status.bestStreak} 天</Text>
            </View>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatK}>累计</Text>
              <Text style={styles.heroStatV}>{status.totalCheckins} 次</Text>
            </View>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatK}>今日</Text>
              <Text style={styles.heroStatV}>
                {status.late ? '迟到' : checkedIn ? '准时' : '—'}
              </Text>
            </View>
          </View>
        </NeonCard>

        <NeonButton
          label={checkedIn ? '✓ 今天已打卡' : '立即打卡'}
          disabled={checkedIn}
          onPress={() => setConfirmOpen(true)}
          style={styles.bigBtn}
        />
        <Text style={styles.tip}>
          打卡会校验北京时间，确认后不可撤销。
        </Text>

        <NeonCard style={styles.settingsCard}>
          <Text style={styles.cardTitle}>每日打卡时间</Text>
          <Text style={styles.cardHint}>修改后会立刻重新注册本地每日通知。</Text>
          <View style={styles.inlineRow}>
            <TextInput
              style={[styles.input, styles.timeInput]}
              value={deadlineDraft}
              onChangeText={setDeadlineDraft}
              placeholder="22:00"
              placeholderTextColor={C.muted}
              maxLength={5}
              keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
            />
            <NeonButton
              label="保存"
              small
              loading={savingDeadline}
              onPress={saveDeadline}
              style={{ minWidth: 84 }}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.rowBetween}>
            <Text style={styles.cardHint}>没收到提醒？</Text>
            <Pressable onPress={testNotify}>
              <Text style={styles.linkText}>发一条测试通知</Text>
            </Pressable>
          </View>
        </NeonCard>

        <ConfirmModal
          visible={confirmOpen}
          title="确认打卡"
          message={`今天是 ${beijingToday()}（北京时间），确定要打卡吗？`}
          confirmText="确认打卡"
          loading={checkinBusy}
          onConfirm={doCheckin}
          onCancel={() => setConfirmOpen(false)}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ==========================================================================
 * 7. 排行榜
 * ======================================================================== */

const PERIODS = [
  { key: 'all', label: '总榜' },
  { key: 'week', label: '周榜' },
  { key: 'month', label: '月榜' },
];

function LeaderboardScreen({ token, active, notify, onLogout }) {
  const [period, setPeriod] = useState('all');
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(
    async (silent) => {
      if (!silent) setLoading(true);
      try {
        const data = await api(`/api/leaderboard?period=${period}&limit=100`, { token });
        setBoard(data);
        setError('');
      } catch (err) {
        if (err.code === 'UNAUTHORIZED') return onLogout();
        setError(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [period, token, onLogout]
  );

  useEffect(() => {
    if (active) load(false);
  }, [active, load]);

  const act = async (key, fn, successText) => {
    setActing(key);
    try {
      await fn();
      notify(successText);
      await load(true);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setActing('');
    }
  };

  const addFriend = (row) =>
    act(
      `add-${row.userId}`,
      () => api('/api/friends/request', { method: 'POST', token, body: { userId: row.userId } }),
      `已向 ${row.username} 发送好友申请`
    );

  const acceptFriend = (row) =>
    act(
      `accept-${row.userId}`,
      () => api('/api/friends/accept', { method: 'POST', token, body: { userId: row.userId } }),
      `你和 ${row.username} 已经是好友了`
    );

  const nudge = (row) =>
    act(
      `nudge-${row.userId}`,
      () => api(`/api/nudge/${encodeURIComponent(row.username)}`, { method: 'POST', token }),
      `已催 ${row.username} 打卡`
    );

  const renderAction = (row) => {
    if (row.isMe) return null;
    if (row.todayStatus === 'done' || row.todayStatus === 'late') {
      return <Tag text="已打卡" color={C.green} />;
    }
    if (row.todayStatus === 'excused') return <Tag text="已请假" color={C.purple} />;

    if (row.friendship === 'accepted') {
      return (
        <NeonButton
          label="催一下"
          small
          loading={acting === `nudge-${row.userId}`}
          disabled={!row.canNudge}
          onPress={() => nudge(row)}
        />
      );
    }
    if (row.friendship === 'pending_out') {
      return <Tag text="已申请" color={C.muted} />;
    }
    if (row.friendship === 'pending_in') {
      return (
        <NeonButton
          label="同意"
          small
          loading={acting === `accept-${row.userId}`}
          onPress={() => acceptFriend(row)}
        />
      );
    }
    return (
      <NeonButton
        label="加好友"
        small
        variant="outline"
        loading={acting === `add-${row.userId}`}
        onPress={() => addFriend(row)}
      />
    );
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.boardHead}>
        <View>
          <Text style={styles.pageTitle}>排行榜</Text>
          <Text style={styles.pageSub}>
            {board ? `${board.periodLabel} · ${board.total} 人 · ${board.today}` : '加载中…'}
          </Text>
        </View>
        <View style={styles.segment}>
          {PERIODS.map((item) => (
            <Pressable
              key={item.key}
              style={[styles.segmentItem, period === item.key && styles.segmentItemActive]}
              onPress={() => setPeriod(item.key)}
            >
              <Text style={[styles.segmentText, period === item.key && styles.segmentTextActive]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => load(false)}>
            <Text style={styles.linkText}>重试</Text>
          </Pressable>
        </View>
      ) : null}

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
          {(board ? board.rows : []).map((row) => {
            const medal = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : null;
            const unit = period === 'all' ? '天' : '次';
            return (
              <View
                key={row.userId}
                style={[styles.boardRow, row.isMe && styles.boardRowMe]}
              >
                <View style={styles.rankBox}>
                  {medal ? (
                    <Text style={styles.medal}>{medal}</Text>
                  ) : (
                    <Text style={styles.rankNum}>{row.rank}</Text>
                  )}
                </View>

                <View style={styles.flex}>
                  <View style={styles.nameRow}>
                    <Text style={styles.boardName} numberOfLines={1}>
                      {row.username}
                    </Text>
                    {row.isMe ? <Tag text="我" /> : null}
                    {row.isAdmin ? <Tag text="ADMIN" color={C.purple} /> : null}
                  </View>
                  <View style={styles.boardMetaRow}>
                    <Text style={styles.boardMeta}>
                      连 {row.streak} 天 · 最佳 {row.bestStreak}
                    </Text>
                    <Text style={[styles.boardMeta, { color: STATUS_COLOR[row.todayStatus] }]}>
                      {STATUS_BADGE[row.todayStatus] || row.todayStatus}
                    </Text>
                  </View>
                </View>

                <View style={styles.scoreBox}>
                  <Text style={styles.scoreNum}>{row.score}</Text>
                  <Text style={styles.scoreUnit}>{unit}</Text>
                </View>

                <View style={styles.actionBox}>{renderAction(row)}</View>
              </View>
            );
          })}

          {board && board.rows.length === 0 ? (
            <Text style={styles.emptyText}>还没有人上榜，快去打卡当第一名。</Text>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/* ==========================================================================
 * 8. 个人主页（热力图 + 好友）
 * ======================================================================== */

const HEAT_COLORS = {
  done: C.green,
  excused: C.yellow,
  missed: C.dim,
  holiday: C.cyan,
  pending: 'rgba(0,229,255,0.18)',
};

function ProfileScreen({ token, user, status, active, notify, onLogout }) {
  const [calendar, setCalendar] = useState(null);
  const [friends, setFriends] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState('');

  const load = useCallback(async () => {
    try {
      const [cal, fw] = await Promise.all([
        api('/api/user/calendar?days=30', { token }),
        api('/api/friends/list', { token }),
      ]);
      setCalendar(cal);
      setFriends(fw);
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

  const reload = async () => {
    setRefreshing(true);
    await load();
  };

  const nudge = async (friend) => {
    setActing(`nudge-${friend.id}`);
    try {
      await api(`/api/nudge/${encodeURIComponent(friend.username)}`, { method: 'POST', token });
      notify(`已催 ${friend.username} 打卡`);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setActing('');
    }
  };

  const accept = async (request) => {
    setActing(`accept-${request.id}`);
    try {
      await api('/api/friends/accept', {
        method: 'POST',
        token,
        body: { userId: request.id },
      });
      notify(`已添加 ${request.username} 为好友`);
      await load();
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') onLogout();
      else notify(err.message, 'error');
    } finally {
      setActing('');
    }
  };

  if (!status) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={C.cyan} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={C.cyan} colors={[C.cyan]} />
        }
      >
        <View style={styles.profileHead}>
          <View style={styles.profileAvatar}>
            <Text style={styles.profileAvatarText}>
              {String(status.user.username).slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.profileName}>{status.user.username}</Text>
            <Text style={styles.pageSub}>
              加入于 {shortDate(status.user.createdAt || user.createdAt)} · 北京时间
            </Text>
          </View>
          <Tag text={status.user.isAdmin ? 'ADMIN' : 'USER'} color={status.user.isAdmin ? C.purple : C.cyan} />
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
        </View>

        <NeonCard style={{ marginTop: 16 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>近 30 天打卡热力图</Text>
            {calendar ? <Text style={styles.cardHint}>{calendar.summary.done} / 30</Text> : null}
          </View>

          {loading && !calendar ? (
            <ActivityIndicator color={C.cyan} style={{ marginVertical: 24 }} />
          ) : (
            <View style={styles.heatmap}>
              {(calendar ? calendar.items : []).map((item) => (
                <View
                  key={item.date}
                  style={[
                    styles.heatCell,
                    {
                      backgroundColor: HEAT_COLORS[item.status] || C.dim,
                      borderColor: item.isToday ? C.cyan : 'transparent',
                    },
                  ]}
                />
              ))}
            </View>
          )}

          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: C.green }]} />
              <Text style={styles.legendText}>打卡</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: C.yellow }]} />
              <Text style={styles.legendText}>请假</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: C.dim }]} />
              <Text style={styles.legendText}>漏签</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: C.cyan }]} />
              <Text style={styles.legendText}>免打卡</Text>
            </View>
          </View>
        </NeonCard>

        <NeonCard style={{ marginTop: 16 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>我的好友</Text>
            <Text style={styles.cardHint}>{friends ? friends.friends.length : 0} 人</Text>
          </View>

          {friends && friends.incoming.length > 0 ? (
            <View style={styles.requestBlock}>
              <Text style={styles.requestTitle}>待处理的好友申请</Text>
              {friends.incoming.map((req) => (
                <View key={req.id} style={styles.friendRow}>
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>
                      {String(req.username).slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.friendName} numberOfLines={1}>
                    {req.username}
                  </Text>
                  <NeonButton
                    label="同意"
                    small
                    loading={acting === `accept-${req.id}`}
                    onPress={() => accept(req)}
                  />
                </View>
              ))}
            </View>
          ) : null}

          {friends && friends.friends.length === 0 ? (
            <Text style={styles.emptyText}>还没有好友，去排行榜加几个一起卷。</Text>
          ) : null}

          {friends
            ? friends.friends.map((friend) => (
                <View key={friend.id} style={styles.friendRow}>
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>
                      {String(friend.username).slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.flex}>
                    <Text style={styles.friendName} numberOfLines={1}>
                      {friend.username}
                    </Text>
                    <Text style={styles.friendMeta}>
                      连 {friend.streak} 天 · {STATUS_BADGE[friend.todayStatus] || friend.todayStatus}
                    </Text>
                  </View>
                  {friend.canNudge ? (
                    <NeonButton
                      label="催一下"
                      small
                      loading={acting === `nudge-${friend.id}`}
                      onPress={() => nudge(friend)}
                    />
                  ) : (
                    <Tag
                      text={STATUS_BADGE[friend.todayStatus] || '已打卡'}
                      color={STATUS_COLOR[friend.todayStatus] || C.muted}
                    />
                  )}
                </View>
              ))
            : null}
        </NeonCard>

        <NeonButton
          label="退出登录"
          variant="outline"
          onPress={onLogout}
          style={{ marginTop: 24 }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ==========================================================================
 * 9. 底部 Tab
 * ======================================================================== */

const TABS = [
  { key: 'checkin', label: '打卡', icon: '⏱' },
  { key: 'leaderboard', label: '排行榜', icon: '📊' },
  { key: 'profile', label: '个人主页', icon: '👤' },
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
            <Text style={[styles.tabIcon, active && styles.tabIconActive]}>{item.icon}</Text>
            <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.label}</Text>
            {active ? <View style={styles.tabIndicator} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/* ==========================================================================
 * 10. 根组件
 * ======================================================================== */

export default function App() {
  const [booting, setBooting] = useState(true);
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(null);
  const [tab, setTab] = useState('checkin');
  const [toast, setToast] = useState(null);

  const notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind, id: Date.now() });
  }, []);

  const hideToast = useCallback(() => setToast(null), []);

  /* ---------------- 登录态恢复 ---------------- */

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

  /* ---------------- 状态轮询 ---------------- */

  const refreshStatus = useCallback(
    async (silent = true) => {
      if (!token) return null;
      try {
        const data = await api('/api/status', { token });
        setStatus(data);
        setUser(data.user);
        return data;
      } catch (err) {
        if (err.code === 'UNAUTHORIZED') {
          handleLogout();
        } else if (!silent) {
          notify(err.message, 'error');
        }
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

  /* ---------------- 每日通知 ---------------- */

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    (async () => {
      const granted = await ensureNotificationPermission();
      if (cancelled || !granted) return;
      const deadline = status && status.deadline;
      if (!deadline || status.isSkipDay) return;
      try {
        await scheduleDailyReminder(deadline);
      } catch (err) {
        console.warn('[notifications] 注册失败', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status && status.deadline]);

  /* ---------------- 点通知回打卡页 ---------------- */

  useEffect(() => {
    if (!token) return undefined;
    const responseSub = Notifications.addNotificationResponseReceivedListener(() => {
      setTab('checkin');
      refreshStatus(true);
    });
    const receivedSub = Notifications.addNotificationReceivedListener(() => {
      refreshStatus(true);
    });
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) setTab('checkin');
      })
      .catch(() => {});
    return () => {
      responseSub.remove();
      receivedSub.remove();
    };
  }, [token, refreshStatus]);

  /* ---------------- 渲染 ---------------- */

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

  if (!token || !user) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <View style={styles.root}>
      <View style={styles.flex}>
        {tab === 'checkin' ? (
          <CheckinScreen
            token={token}
            status={status}
            refresh={refreshStatus}
            notify={notify}
            onLogout={handleLogout}
          />
        ) : null}
        {tab === 'leaderboard' ? (
          <LeaderboardScreen
            token={token}
            active
            notify={notify}
            onLogout={handleLogout}
          />
        ) : null}
        {tab === 'profile' ? (
          <ProfileScreen
            token={token}
            user={user}
            status={status}
            active
            notify={notify}
            onLogout={handleLogout}
          />
        ) : null}
      </View>

      <TabBar tab={tab} onChange={setTab} />

      <BlockingModal
        visible={Boolean(status && status.blocked)}
        status={status}
        token={token}
        onExcused={(nextStatus) => {
          setStatus(nextStatus);
          notify('借口已提交，今天记为请假');
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
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mutedText: { color: C.muted, marginTop: 10, fontSize: 13 },
  page: { padding: 20, paddingBottom: 34 },

  /* ---------- 通用 ---------- */
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
  btn: {
    borderRadius: 13,
    paddingVertical: 13,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10 },
  btnSolid: {
    backgroundColor: C.cyan,
    shadowColor: C.cyan,
    shadowOpacity: 0.55,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  btnOutline: { borderColor: C.cyan + '88', backgroundColor: 'rgba(0,229,255,0.06)' },
  btnDanger: {
    backgroundColor: C.red,
    shadowColor: C.red,
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  btnDisabled: { opacity: 0.38, shadowOpacity: 0, elevation: 0 },
  btnPressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  btnText: { color: C.text, fontWeight: '800', fontSize: 15, letterSpacing: 1 },
  btnTextSmall: { fontSize: 12, letterSpacing: 0.6 },
  btnTextSolid: { color: '#04070E' },

  tag: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start' },
  tagText: { fontSize: 10, fontWeight: '800', letterSpacing: 1, fontFamily: MONO },

  label: { color: C.muted, fontSize: 11, letterSpacing: 1.4, marginTop: 16, marginBottom: 7, fontFamily: MONO },
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
  textarea: { minHeight: 96, textAlignVertical: 'top' },
  errorText: { color: C.red, fontSize: 12, marginTop: 12, fontFamily: MONO },
  linkText: { color: C.cyan, fontSize: 12, fontWeight: '700' },
  divider: { height: 1, backgroundColor: C.lineSoft, marginVertical: 16 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  timeInput: { flex: 1, textAlign: 'center', fontSize: 20, letterSpacing: 4, fontFamily: MONO },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '800', letterSpacing: 0.6 },
  cardHint: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },

  /* ---------- 登录 ---------- */
  loginWrap: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  loginHead: { alignItems: 'center', marginBottom: 26 },
  loginLogo: { fontSize: 44, textShadowColor: C.cyan, textShadowRadius: 18 },
  loginTitle: {
    color: C.text, fontSize: 30, fontWeight: '900', letterSpacing: 10, marginTop: 10,
    textShadowColor: C.cyan, textShadowRadius: 16,
  },
  loginSub: { color: C.muted, fontSize: 10, letterSpacing: 4, marginTop: 8, fontFamily: MONO },
  loginCard: { padding: 20 },
  serverHint: { color: C.muted, fontSize: 10, textAlign: 'center', marginTop: 18, fontFamily: MONO },

  segment: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,229,255,0.05)',
    borderWidth: 1,
    borderColor: C.lineSoft,
    borderRadius: 11,
    padding: 4,
  },
  segmentItem: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segmentItemActive: { backgroundColor: 'rgba(0,229,255,0.14)' },
  segmentText: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  segmentTextActive: { color: C.cyan },

  /* ---------- 页面头 ---------- */
  pageHead: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18,
  },
  pageTitle: { color: C.text, fontSize: 22, fontWeight: '900', letterSpacing: 2 },
  pageSub: { color: C.muted, fontSize: 10, marginTop: 6, fontFamily: MONO, letterSpacing: 0.6 },

  /* ---------- 打卡 ---------- */
  holidayBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(179,136,255,0.1)', borderWidth: 1, borderColor: 'rgba(179,136,255,0.45)',
    borderRadius: 12, padding: 12, marginBottom: 14,
  },
  holidayIcon: { color: C.purple, fontSize: 14 },
  holidayText: { color: '#D9C9FF', fontSize: 12, flex: 1, lineHeight: 18 },
  nudgeBanner: {
    backgroundColor: 'rgba(255,92,122,0.1)', borderWidth: 1, borderColor: 'rgba(255,92,122,0.45)',
    borderRadius: 12, padding: 12, marginBottom: 14,
  },
  nudgeText: { color: '#FFC2CE', fontSize: 12, lineHeight: 18 },

  heroCard: { padding: 20 },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start' },
  heroLabel: { color: C.muted, fontSize: 10, letterSpacing: 3, fontFamily: MONO },
  heroStatus: { fontSize: 28, fontWeight: '900', marginTop: 10, letterSpacing: 1, textShadowRadius: 18 },
  heroLine: { color: C.muted, fontSize: 11, marginTop: 8, fontFamily: MONO },
  countdown: { color: C.text, fontSize: 13, marginTop: 10, fontWeight: '600', fontFamily: MONO },
  streakBox: { alignItems: 'center', paddingLeft: 10 },
  streakNum: {
    color: C.cyan, fontSize: 48, fontWeight: '900', lineHeight: 52, fontFamily: MONO,
    textShadowColor: C.cyan, textShadowRadius: 22,
  },
  streakLabel: { color: C.muted, fontSize: 9, letterSpacing: 2, marginTop: 2, fontFamily: MONO },
  heroStats: {
    flexDirection: 'row', marginTop: 18, borderTopWidth: 1, borderTopColor: C.lineSoft, paddingTop: 14,
  },
  heroStat: { flex: 1 },
  heroStatK: { color: C.muted, fontSize: 10, letterSpacing: 1.4, fontFamily: MONO },
  heroStatV: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 4, fontFamily: MONO },

  bigBtn: { marginTop: 18, paddingVertical: 18, borderRadius: 16 },
  tip: { color: C.muted, fontSize: 11, textAlign: 'center', marginTop: 12, lineHeight: 17 },

  settingsCard: { marginTop: 22 },

  /* ---------- 排行榜 ---------- */
  boardHead: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 14 },
  boardList: { paddingHorizontal: 20, paddingBottom: 28 },
  boardRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card,
    borderWidth: 1, borderColor: C.lineSoft, borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 12, marginBottom: 10,
  },
  boardRowMe: {
    borderColor: C.cyan,
    backgroundColor: 'rgba(0,229,255,0.07)',
    shadowColor: C.cyan, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 5,
  },
  rankBox: { width: 30, alignItems: 'center' },
  medal: { fontSize: 20 },
  rankNum: { color: C.muted, fontSize: 15, fontWeight: '800', fontFamily: MONO },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  boardName: { color: C.text, fontSize: 15, fontWeight: '700', maxWidth: 130 },
  boardMetaRow: { flexDirection: 'row', gap: 10, marginTop: 4, flexWrap: 'wrap' },
  boardMeta: { color: C.muted, fontSize: 10, fontFamily: MONO },
  scoreBox: { alignItems: 'center', minWidth: 44 },
  scoreNum: {
    color: C.cyan, fontSize: 20, fontWeight: '900', fontFamily: MONO,
    textShadowColor: C.cyan, textShadowRadius: 12,
  },
  scoreUnit: { color: C.muted, fontSize: 9, fontFamily: MONO },
  actionBox: { minWidth: 76, alignItems: 'flex-end' },
  emptyText: { color: C.muted, fontSize: 12, textAlign: 'center', paddingVertical: 26, lineHeight: 20 },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: 'rgba(255,92,122,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,92,122,0.4)',
    borderRadius: 12,
    padding: 12,
  },

  /* ---------- 个人主页 ---------- */
  profileHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  profileAvatar: {
    width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.cyan, shadowColor: C.cyan, shadowOpacity: 0.5, shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 }, elevation: 8,
  },
  profileAvatarText: { color: '#04070E', fontSize: 22, fontWeight: '900' },
  profileName: { color: C.text, fontSize: 19, fontWeight: '800', letterSpacing: 1 },
  profileStats: { flexDirection: 'row', gap: 10 },
  profileStat: {
    flex: 1, backgroundColor: C.cardSoft, borderWidth: 1, borderColor: C.lineSoft,
    borderRadius: 14, paddingVertical: 14, alignItems: 'center',
  },
  profileStatNum: { color: C.cyan, fontSize: 22, fontWeight: '900', fontFamily: MONO },
  profileStatLabel: { color: C.muted, fontSize: 10, marginTop: 4, letterSpacing: 1.6, fontFamily: MONO },

  heatmap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14, gap: 6 },
  heatCell: { width: 34, height: 34, borderRadius: 8, borderWidth: 1 },
  legendRow: { flexDirection: 'row', gap: 16, marginTop: 14, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 9, height: 9, borderRadius: 3 },
  legendText: { color: C.muted, fontSize: 10, fontFamily: MONO },

  requestBlock: { marginTop: 12, borderTopWidth: 1, borderTopColor: C.lineSoft, paddingTop: 12 },
  requestTitle: { color: C.purple, fontSize: 11, letterSpacing: 1.4, fontFamily: MONO, marginBottom: 6 },
  friendRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  friendAvatar: {
    width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,229,255,0.14)', borderWidth: 1, borderColor: C.line,
  },
  friendAvatarText: { color: C.cyan, fontSize: 13, fontWeight: '800' },
  friendName: { color: C.text, fontSize: 14, fontWeight: '600' },
  friendMeta: { color: C.muted, fontSize: 10, marginTop: 2, fontFamily: MONO },

  /* ---------- Tab ---------- */
  tabBar: {
    flexDirection: 'row',
    backgroundColor: C.bgSoft,
    borderTopWidth: 1,
    borderTopColor: C.lineSoft,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 24 : 10,
    paddingHorizontal: 10,
  },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabIcon: { fontSize: 18, opacity: 0.5 },
  tabIconActive: { opacity: 1 },
  tabLabel: { color: C.muted, fontSize: 10, letterSpacing: 0.8, fontFamily: MONO },
  tabLabelActive: { color: C.cyan },
  tabIndicator: {
    position: 'absolute', top: -8, width: 22, height: 2, borderRadius: 2,
    backgroundColor: C.cyan, shadowColor: C.cyan, shadowOpacity: 1, shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 }, elevation: 4,
  },

  /* ---------- Toast ---------- */
  toastBox: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 58 : (RNStatusBar.currentHeight || 0) + 12,
    left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(18,22,31,0.97)',
    borderWidth: 1, borderColor: 'rgba(0,229,255,0.55)',
    borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
    shadowColor: C.cyan, shadowOpacity: 0.4, shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 }, elevation: 12,
    zIndex: 80,
  },
  toastError: { borderColor: 'rgba(255,92,122,0.7)', shadowColor: C.red },
  toastDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.cyan },
  toastText: { color: C.text, fontSize: 13, flex: 1, lineHeight: 19, fontWeight: '600' },

  /* ---------- 确认弹窗 ---------- */
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(4,7,14,0.86)', alignItems: 'center', justifyContent: 'center', padding: 28,
  },
  modalCard: {
    width: '100%', maxWidth: 360,
    backgroundColor: C.card,
    borderRadius: 18, borderWidth: 1, borderColor: 'rgba(0,229,255,0.5)',
    padding: 22,
    shadowColor: C.cyan, shadowOpacity: 0.35, shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 }, elevation: 14,
  },
  modalGlowLine: {
    position: 'absolute', top: 0, left: 22, right: 22, height: 2, borderRadius: 2,
    backgroundColor: C.cyan, shadowColor: C.cyan, shadowOpacity: 1, shadowRadius: 10,
  },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '900', letterSpacing: 1.5, marginTop: 6 },
  modalMessage: { color: C.muted, fontSize: 13, lineHeight: 21, marginTop: 10 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 22 },
  modalBtn: { flex: 1 },

  /* ---------- 阻断 ---------- */
  blockSafe: { flex: 1, backgroundColor: '#100812' },
  blockWrap: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  blockEmoji: { fontSize: 44, textAlign: 'center' },
  blockTitle: { color: '#fff', fontSize: 23, fontWeight: '900', textAlign: 'center', marginTop: 14 },
  blockDesc: { color: '#FFB3C1', fontSize: 12, lineHeight: 20, textAlign: 'center', marginTop: 12 },
  blockCard: {
    backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 18, borderWidth: 1,
    borderColor: 'rgba(255,92,122,0.45)', padding: 18, marginTop: 22,
  },
  blockFoot: { color: C.muted, fontSize: 10, textAlign: 'center', marginTop: 14, lineHeight: 16 },
});
