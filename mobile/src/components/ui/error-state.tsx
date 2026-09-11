/**
 * Something failed, said in the interface's voice.
 *
 * `ApiError.message` is already finished prose written for the user, so this
 * component renders it verbatim rather than wrapping it in an apology. Pass the
 * thrown value straight in — `messageForError` handles anything that isn't an
 * `ApiError`, and `isRetryable` decides whether a retry button would do any
 * good (a parse failure will fail identically on retry, so it gets none).
 *
 * `StaleBanner` is the inline sibling: when a sweep has failed but cached
 * prices are still on screen, an empty error page would throw away data the
 * user can still use. It states the age at the top of the list instead.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from '@/components/ui/pressable-scale';
import { isRetryable, messageForError } from '@/lib/api';
import { ageLabel } from '@/lib/format';
import { layout, palette, radius, spacing, type } from '@/theme';

const ICON_SIZE = 28;

export type ErrorStateProps = {
  /** Whatever was thrown. Usually an `ApiError`. */
  error: unknown;
  /** Overrides the headline. Default names the failure without drama. */
  headline?: string;
  onRetry?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function ErrorState({ error, headline, onRetry, style }: ErrorStateProps) {
  const canRetry = onRetry !== undefined && isRetryable(error);

  return (
    <View style={[styles.root, style]}>
      <View style={styles.iconWrap}>
        <Ionicons name="cloud-offline-outline" size={ICON_SIZE} color={palette.danger} />
      </View>

      <Text accessibilityRole="header" maxFontSizeMultiplier={1.3} style={styles.headline}>
        {headline ?? "Prices didn't load"}
      </Text>

      <Text maxFontSizeMultiplier={1.4} style={styles.message}>
        {messageForError(error)}
      </Text>

      {canRetry ? (
        <PressableScale haptic="selection" onPress={onRetry} style={styles.action}>
          <Text maxFontSizeMultiplier={1.2} style={styles.actionLabel}>
            Try again
          </Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

export type StaleBannerProps = {
  /** Epoch ms of the sweep whose prices are on screen. */
  sweptAt: number;
  /** Shown under the headline, e.g. why the sweep failed. */
  detail?: string;
  onRetry?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * "Prices are 31 hours old" — the sentence spec §9 says the app is useless
 * without. Sits above a list that is still showing its last good data.
 */
export function StaleBanner({ sweptAt, detail, onRetry, style }: StaleBannerProps) {
  return (
    <View
      accessible
      accessibilityRole="alert"
      style={[styles.banner, style]}
    >
      <Ionicons name="time-outline" size={18} color={palette.stale} />
      <View style={styles.bannerBody}>
        <Text maxFontSizeMultiplier={1.3} style={styles.bannerTitle}>
          Last swept {ageLabel(sweptAt)}
        </Text>
        {detail ? (
          <Text maxFontSizeMultiplier={1.3} style={styles.bannerDetail}>
            {detail}
          </Text>
        ) : null}
      </View>
      {onRetry ? (
        <PressableScale haptic="selection" onPress={onRetry} style={styles.bannerAction}>
          <Text maxFontSizeMultiplier={1.2} style={styles.bannerActionLabel}>
            Refresh
          </Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: layout.screenPadding,
    gap: spacing.md,
  },
  iconWrap: {
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: palette.dangerWash,
    marginBottom: spacing.xs,
  },
  headline: {
    ...type.title,
    color: palette.textPrimary,
    textAlign: 'center',
  },
  message: {
    ...type.body,
    color: palette.textSecondary,
    textAlign: 'center',
    maxWidth: layout.proseMaxWidth,
  },
  action: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.pill,
    backgroundColor: palette.ink,
  },
  actionLabel: {
    ...type.label,
    color: palette.textInverse,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: palette.staleWash,
  },
  bannerBody: {
    flex: 1,
  },
  bannerTitle: {
    ...type.label,
    color: palette.stale,
  },
  bannerDetail: {
    ...type.caption,
    color: palette.textSecondary,
    marginTop: spacing.xxs,
  },
  bannerAction: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: layout.hairline,
    borderColor: palette.stale,
  },
  bannerActionLabel: {
    ...type.tag,
    color: palette.stale,
  },
});
