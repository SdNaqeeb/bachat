/**
 * Notification delivery health (spec §10).
 *
 * Firebase will happily report a push as delivered while an OEM battery manager
 * quietly drops the wake broadcast, so "we sent it" is not evidence the user
 * ever saw it. The only honest instrument is the gap between two timestamps:
 * the last push the server sent, and the last push this device actually
 * received. This card puts them side by side and draws a conclusion in words,
 * because two timestamps without a verdict is a diagnostic, not an answer.
 *
 * The failure case is stated as a fact about the phone rather than an apology
 * from the app. That is not defensiveness — it is the only framing that leads
 * the user to the fix, which is in Android's settings and not in Bachat.
 */

import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Button } from '@/components/ui/button';
import { ageLabel } from '@/lib/format';
import type { NotificationPermission } from '@/hooks/use-notifications';
import { layout, palette, radius, spacing, type } from '@/theme';

/** A push in flight is not yet a lost push. Below this, say nothing. */
const GRACE_MS = 15 * 60_000;

export type DeliveryHealthProps = {
  permission: NotificationPermission;
  /** From `health().lastPushSentAt`. Null when the server has sent none. */
  lastSentAt: number | null;
  /** From `useNotifications().lastReceivedAt`. */
  lastReceivedAt: number | null;
  busy: boolean;
  onEnable: () => void;
  onOpenBatteryGuide: () => void;
};

type Verdict = {
  tone: 'ok' | 'warn' | 'bad';
  headline: string;
  detail: string;
};

function verdictOf(
  permission: NotificationPermission,
  sent: number | null,
  received: number | null
): Verdict {
  if (permission === 'denied') {
    return {
      tone: 'bad',
      headline: 'Alerts are switched off',
      detail:
        'Android is blocking notifications for Bachat. Turn them back on in Settings > Apps > Bachat > Notifications.',
    };
  }
  if (permission !== 'granted') {
    return {
      tone: 'warn',
      headline: 'Alerts are not set up yet',
      detail: 'Bachat needs permission before it can tell you about a price drop.',
    };
  }
  if (sent === null) {
    return {
      tone: 'ok',
      headline: 'Nothing to deliver yet',
      detail:
        'The server has not sent a price alert since this device registered. Nothing is wrong — there has been nothing worth sending.',
    };
  }
  if (received === null) {
    return {
      tone: 'bad',
      headline: 'Sent, but never received here',
      detail:
        'The server has pushed an alert and this phone has not registered a single one. That is the signature of a battery manager dropping the wake broadcast.',
    };
  }
  if (sent - received > GRACE_MS) {
    return {
      tone: 'warn',
      headline: 'The last alert did not arrive',
      detail:
        'Earlier pushes got through, so notifications work — but the most recent one was dropped. Battery optimisation is the usual cause.',
    };
  }
  return {
    tone: 'ok',
    headline: 'Alerts are arriving',
    detail: 'The last push the server sent reached this phone.',
  };
}

const TONE_COLOR: Record<Verdict['tone'], { fg: string; bg: string; icon: 'checkmark-circle' | 'alert-circle' | 'close-circle' }> = {
  ok: { fg: palette.save, bg: palette.saveWash, icon: 'checkmark-circle' },
  warn: { fg: palette.stale, bg: palette.staleWash, icon: 'alert-circle' },
  bad: { fg: palette.danger, bg: palette.dangerWash, icon: 'close-circle' },
};

export function DeliveryHealth({
  permission,
  lastSentAt,
  lastReceivedAt,
  busy,
  onEnable,
  onOpenBatteryGuide,
}: DeliveryHealthProps) {
  const verdict = verdictOf(permission, lastSentAt, lastReceivedAt);
  const tone = TONE_COLOR[verdict.tone];

  return (
    <View style={styles.root}>
      <View style={[styles.verdict, { backgroundColor: tone.bg }]}>
        <Ionicons name={tone.icon} size={20} color={tone.fg} />
        <View style={styles.verdictBody}>
          <Text maxFontSizeMultiplier={1.3} style={[styles.verdictTitle, { color: tone.fg }]}>
            {verdict.headline}
          </Text>
          <Text maxFontSizeMultiplier={1.4} style={styles.verdictDetail}>
            {verdict.detail}
          </Text>
        </View>
      </View>

      <View style={styles.timestamps}>
        <Timestamp label="Server last sent" at={lastSentAt} empty="Never" />
        <View style={styles.timestampRule} />
        <Timestamp label="This phone last got" at={lastReceivedAt} empty="Never" />
      </View>

      <View style={styles.actions}>
        {permission === 'granted' ? null : (
          <Button
            label="Turn on alerts"
            icon="notifications-outline"
            size="sm"
            loading={busy}
            onPress={onEnable}
          />
        )}
        {verdict.tone === 'ok' ? null : (
          <Button
            label="Fix battery settings"
            tone="quiet"
            size="sm"
            icon="battery-half-outline"
            onPress={onOpenBatteryGuide}
          />
        )}
      </View>
    </View>
  );
}

function Timestamp({ label, at, empty }: { label: string; at: number | null; empty: string }) {
  return (
    <View style={styles.timestamp}>
      <Text maxFontSizeMultiplier={1.3} style={styles.timestampLabel}>
        {label}
      </Text>
      <Text maxFontSizeMultiplier={1.2} style={styles.timestampValue}>
        {at === null ? empty : ageLabel(at)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.md,
  },
  verdict: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  verdictBody: {
    flex: 1,
    gap: spacing.xxs,
  },
  verdictTitle: {
    ...type.label,
  },
  verdictDetail: {
    ...type.caption,
    color: palette.textSecondary,
  },
  timestamps: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.md,
    borderWidth: layout.hairline,
    borderColor: palette.line,
    backgroundColor: palette.surfaceRaised,
  },
  timestamp: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.xxs,
  },
  timestampRule: {
    width: layout.hairline,
    backgroundColor: palette.line,
  },
  timestampLabel: {
    ...type.caption,
    color: palette.textSecondary,
  },
  timestampValue: {
    ...type.priceSmall,
    color: palette.textPrimary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
